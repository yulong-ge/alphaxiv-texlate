// ==UserScript==
// @name         alphaXiv × TeXlate 中文 PDF
// @namespace    local.texlate.alphaxiv
// @version      0.5.0
// @description  在 alphaXiv 阅读器工具栏一键调用本地 TeXlate 翻译，PDF 原地热切换为中文版或中英对照版
// @match        https://www.alphaxiv.org/*
// @match        https://alphaxiv.org/*
// @run-at       document-start
// @sandbox      JavaScript
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @homepageURL  https://github.com/yulong-ge/alphaxiv-texlate
// @updateURL    https://raw.githubusercontent.com/yulong-ge/alphaxiv-texlate/main/userscript/alphaxiv-texlate.user.js
// @downloadURL  https://raw.githubusercontent.com/yulong-ge/alphaxiv-texlate/main/userscript/alphaxiv-texlate.user.js
// ==/UserScript==

/*
 * 工作原理（依据 alphaXiv 2026-10 线上代码）：
 * - 阅读器是 pdf.js PDFViewer；PDF 字节来自 https://pdfs.assets.alphaxiv.org/{id}.pdf，
 *   经全局 fetch 拉取，并缓存在 CacheStorage "alphaxiv-pdfs-v1"。
 * - 打印与下载复用阅读器已加载的字节，因此替换字节后打印/下载也是中文。
 * 中文/对照模式下本脚本：fetch 该 URL 时返回 TeXlate 的 zh.pdf / bi.pdf；缓存对该 URL
 * 读取视为未命中、写入忽略，避免译文字节污染 alphaXiv 的英文缓存。
 * 模式：en（原文）| zh（中文）| bi（中英对照，原文灰字 + 译文，按需由 TeXlate 编译）。
 */

(function () {
  'use strict';

  const TEXLATE = 'http://127.0.0.1:8765';
  const PDF_PREFIX = 'https://pdfs.assets.alphaxiv.org/';
  const POLL_MS = 3000;
  const MODES = {
    en: { label: 'EN', name: '英文原版' },
    zh: { label: '中', name: '中文版' },
    bi: { label: '双', name: '中英对照版' },
  };
  const ARXIV_ID = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;
  const W = unsafeWindow;

  // ------------------------------------------------------------ 论文 ID 与模式

  function pdfIdFromUrl(url) {
    if (typeof url !== 'string' || !url.startsWith(PDF_PREFIX)) return null;
    const path = new URL(url).pathname.replace(/^\//, '').replace(/\.pdf$/, '');
    const id = path.split('/').map(decodeURIComponent).join('/');
    return ARXIV_ID.test(id) ? id : null;
  }

  function idFromLocation() {
    const m = location.pathname.match(/^\/(?:abs|overview|pdf)\/(.+?)\/?$/);
    if (!m) return null;
    const id = decodeURIComponent(m[1]).replace(/\.pdf$/, '');
    return ARXIV_ID.test(id) ? id : null;
  }

  const baseOf = (id) => id.replace(/v\d+$/, '');
  const modeOf = (id) => GM_getValue('mode:' + baseOf(id), 'en');
  const setMode = (id, mode) => GM_setValue('mode:' + baseOf(id), mode);

  // 阅读器实际加载的带版本 ID；未见 PDF 请求前回退到地址栏 ID
  let currentId = null;
  // 论文（去版本号）→ 阅读器当前所载译文 PDF 的 TeXlate 任务 ID
  const shownTask = new Map();
  const paperId = () => currentId || idFromLocation();

  // ------------------------------------------------------------ TeXlate 调用

  class TexlateError extends Error {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gm(method, path, { json, responseType } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: TEXLATE + path,
        headers: json === undefined ? {} : { 'content-type': 'application/json' },
        data: json === undefined ? undefined : JSON.stringify(json),
        responseType: responseType || 'text',
        timeout: 60000,
        onload: (r) => resolve(r),
        onerror: () => reject(new TexlateError(`无法连接 TeXlate（${TEXLATE}）：请先运行 texlate service start --no-open`)),
        ontimeout: () => reject(new TexlateError(`TeXlate 请求超时：${method} ${path}`)),
      });
    });
  }

  async function gmJson(method, path, opts) {
    const r = await gm(method, path, opts);
    let body;
    try {
      body = JSON.parse(r.responseText);
    } catch (e) {
      throw new TexlateError(`TeXlate ${method} ${path} 返回非 JSON（HTTP ${r.status}）`, { cause: e });
    }
    return { status: r.status, body };
  }

  // 返回 {zhUrl, msg} 或 null（TeXlate 中没有该论文的任务）
  async function arxivFiles(id) {
    const { status, body } = await gmJson('GET', '/api/arxivFiles/' + encodeURIComponent(id));
    if (status === 404 && body.error === 'not_found') return null;
    if (status !== 200) throw new TexlateError(`查询译文失败（HTTP ${status}）：${JSON.stringify(body)}`);
    if (body.status === 101) throw new TexlateError('TeXlate 要求认证：' + body.msg);
    return { zhUrl: body.data.zhCN, biUrl: body.data.bi || '', msg: body.msg };
  }

  async function arxivStatus(id) {
    const { status, body } = await gmJson('GET', '/api/arxivStatus/' + encodeURIComponent(id));
    if (status !== 200) throw new TexlateError(`查询进度失败（HTTP ${status}）：${JSON.stringify(body)}`);
    return body; // {status: start|finished|failed|error|fault, info, progress, task_id}
  }

  async function startTranslate(id) {
    const { status, body } = await gmJson('POST', `/api/arxiv/${encodeURIComponent(id)}/translate`, { json: {} });
    if (status !== 200 && status !== 202) {
      throw new TexlateError(`提交翻译失败（HTTP ${status}）：${body.detail || JSON.stringify(body)}`);
    }
    return body.task_id;
  }

  async function fetchModePdf(id, mode) {
    const files = await arxivFiles(id);
    const url = files && (mode === 'bi' ? files.biUrl : files.zhUrl);
    if (!url) {
      throw new TexlateError(`TeXlate 中没有 ${id} 的${MODES[mode].name} PDF${files && files.msg ? '：' + files.msg : ''}`);
    }
    const r = await gm('GET', url, { responseType: 'arraybuffer' });
    if (r.status !== 200) throw new TexlateError(`下载${MODES[mode].name}失败（HTTP ${r.status}）：${url}`);
    const tid = url.match(/\/api\/files\/([^/]+)\//);
    if (!tid) throw new TexlateError(`无法从译文地址解析任务 ID：${url}`);
    shownTask.set(baseOf(id), tid[1]);
    return r.response;
  }

  async function taskWarnings(taskId) {
    const { status, body } = await gmJson('GET', `/api/task/${taskId}`);
    if (status !== 200) throw new TexlateError(`查询任务失败（HTTP ${status}）：${JSON.stringify(body)}`);
    return (body.warnings || []).filter((w) => w.startsWith('[bilingual]'));
  }

  // 对照版按需生成：入队后轮询 bi 地址出现；新增的 [bilingual] warning 即失败原因
  async function ensureBilingual(id) {
    const st = await arxivStatus(id);
    const before = (await taskWarnings(st.task_id)).length;
    const { status, body } = await gmJson('POST', `/api/task/${st.task_id}/bilingual`);
    if (status !== 202) throw new TexlateError(`提交对照版生成失败（HTTP ${status}）：${body.detail || JSON.stringify(body)}`);
    const t0 = Date.now();
    for (;;) {
      ui.status(`正在生成中英对照版…（${Math.round((Date.now() - t0) / 1000)} s）`);
      await sleep(POLL_MS);
      const files = await arxivFiles(id);
      if (files && files.biUrl) return;
      const warns = await taskWarnings(st.task_id);
      if (warns.length > before) throw new TexlateError(warns[warns.length - 1].replace('[bilingual] ', ''));
    }
  }

  // ------------------------------------------------------------ 页面钩子

  const origFetch = W.fetch;
  W.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof W.URL ? input.href : input && input.url;
    const id = pdfIdFromUrl(url);
    if (id) {
      notePdfLoad(id);
      const mode = modeOf(id);
      if (mode !== 'en') {
        ui.status(`正在载入${MODES[mode].name}…`);
        return fetchModePdf(id, mode).then(
          (buf) => {
            ui.done(`当前显示：${MODES[mode].name}（TeXlate）`);
            return new W.Response(buf, { status: 200, headers: { 'content-type': 'application/pdf' } });
          },
          (err) => {
            ui.error(err);
            throw err;
          },
        );
      }
    }
    return origFetch.apply(this, arguments);
  };

  function cacheKeyUrl(req) {
    return typeof req === 'string' ? req : req && req.url;
  }

  function translatedModeFor(req) {
    const id = pdfIdFromUrl(cacheKeyUrl(req));
    return id !== null && modeOf(id) !== 'en';
  }

  // 每次阅读器（重新）载入 PDF 都先查 CacheStorage——英文态缓存命中时不经 fetch，
  // 因此「当前论文」与「载入次数」在这里记，热重载据载入次数判断新 PDF 已开始载入
  let pdfLoads = 0;
  function notePdfLoad(id) {
    currentId = id;
    ui.refresh();
  }

  const CacheProto = W.Cache.prototype;
  const origMatch = CacheProto.match;
  const origPut = CacheProto.put;
  CacheProto.match = function (req, opts) {
    const id = pdfIdFromUrl(cacheKeyUrl(req));
    if (id !== null) {
      pdfLoads += 1;
      notePdfLoad(id);
    }
    return translatedModeFor(req) ? Promise.resolve(undefined) : origMatch.call(this, req, opts);
  };
  CacheProto.put = function (req, res) {
    return translatedModeFor(req) ? Promise.resolve() : origPut.call(this, req, res);
  };

  // ------------------------------------------------------------ 翻译流程

  let busy = false;

  async function switchTo(mode) {
    const id = paperId();
    if (!id) throw new TexlateError('当前页面不是 arXiv 论文，无法翻译');
    if (mode === 'en') {
      setMode(id, 'en');
      await reloadViewer();
      ui.done(`当前显示：${MODES.en.name}`);
      return;
    }
    await ensureTranslated(id);
    if (mode === 'bi' && !(await arxivFiles(id)).biUrl) await ensureBilingual(id);
    setMode(id, mode);
    await reloadViewer();
  }

  // 未翻译则提交并轮询到出中文 PDF
  async function ensureTranslated(id) {
    const files = await arxivFiles(id);
    if (files && files.zhUrl) return;
    let st = files ? await arxivStatus(id) : null;
    if (!st || st.status !== 'start') {
      ui.status('已提交到 TeXlate，后台翻译中…');
      await startTranslate(id);
    }
    for (;;) {
      st = await arxivStatus(id);
      if (st.status === 'start') {
        ui.status(`翻译中 ${st.progress}%${st.info ? ' · ' + st.info : ''}`);
        await sleep(POLL_MS);
        continue;
      }
      if (st.status === 'finished') {
        const done = await arxivFiles(id);
        if (!done || !done.zhUrl) {
          throw new TexlateError(`翻译结束但没有中文 PDF：${(done && done.msg) || st.info}（任务 ${st.task_id}）`);
        }
        return;
      }
      throw new TexlateError(`翻译失败（${st.status}）：${st.info}。在 ${TEXLATE}/#/reader/${st.task_id} 查看详情`);
    }
  }

  // ------------------------------------------------------------ 阅读器热重载

  async function waitFor(cond, what, timeoutMs = 60000) {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > timeoutMs) throw new TexlateError(`切换超时：${what}`);
      await sleep(100);
    }
  }

  // 阅读器（alphaXiv 组件内 effect，依赖 [canonicalId, pdfError]）只在依赖变化时
  // 重新取 PDF 并 setDocument。页面内辅助函数经 jotai store 把 pdfError 置错再清空，
  // 触发该 effect 重跑；fetch/缓存钩子按新模式供字节。模块 hash 与压缩导出名随部署变，
  // 故按文件名前缀找模块、按形状找 store（get/set/sub）与阅读器 atom 组。
  // 以内联 module 注入页面：import() 必须在页面 realm 里解析，才拿得到同一 store 实例。
  const PAGE_HELPER = `
    const viewerState = async () => {
      const urls = [
        ...performance.getEntriesByType('resource').map((e) => e.name),
        ...[...document.querySelectorAll('link[rel=modulepreload], script[src]')].map((l) => l.href || l.src),
      ];
      const pick = (prefix) => {
        const u = urls.find((x) => new URL(x, location.href).pathname.startsWith('/assets/' + prefix));
        if (!u) throw new Error('找不到 alphaXiv 模块 ' + prefix + '（站点改版？）');
        return u;
      };
      const api = await import(pick('api-typed-'));
      const enums = await import(pick('pdfjs-enums-'));
      const store = Object.values(api).find(
        (v) => v && typeof v.get === 'function' && typeof v.set === 'function' && typeof v.sub === 'function',
      );
      const atoms = Object.values(enums).find(
        (v) => v && typeof v === 'object' && 'pdfError' in v && 'pdfViewer' in v && 'loadedCanonicalId' in v,
      );
      if (!store || !atoms) throw new Error('找不到阅读器状态 store/atom（站点改版？）');
      return { store, atoms };
    };
    window.__texlateViewer = async () => {
      const { store, atoms } = await viewerState();
      return store.get(atoms.pdfViewer);
    };
    window.__texlateReloadPdf = async () => {
      const { store, atoms } = await viewerState();
      store.set(atoms.pdfError, new Error('texlate: reload'));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      store.set(atoms.pdfError, null);
    };`;
  // 首次使用时才注入：document-start 时 <html> 可能尚不存在
  async function pageHelper() {
    if (typeof W.__texlateReloadPdf !== 'function') {
      const el = document.createElement('script');
      el.type = 'module';
      el.textContent = PAGE_HELPER;
      document.head.appendChild(el);
      el.remove();
      await waitFor(() => typeof W.__texlateReloadPdf === 'function', '注入页面辅助脚本', 5000);
    }
    return { reload: W.__texlateReloadPdf, viewer: W.__texlateViewer };
  }

  // 完成后按滚动比例恢复阅读位置（中英页数不同，只能近似对齐）
  async function reloadViewer() {
    const body = document.querySelector('.paperBody');
    if (!body) throw new TexlateError('找不到阅读器区域，无法热切换');
    const ratio = body.scrollTop / Math.max(1, body.scrollHeight - body.clientHeight);
    const before = pdfLoads;
    // 标记旧页节点：新 PDFViewer 复用容器但重建页节点，未带标记的页出现文字层即新文档已渲染
    // （首页未必在视口内，故不限定页码）
    document.querySelectorAll('.paperBody .page').forEach((pg) => (pg.dataset.texlateStale = '1'));
    clearCiteMarks();
    await (await pageHelper()).reload();
    await waitFor(() => pdfLoads > before, '阅读器重新载入 PDF');
    await waitFor(
      () => document.querySelector('.paperBody .page:not([data-texlate-stale]) .textLayer span'),
      '新 PDF 渲染',
    );
    const nb = document.querySelector('.paperBody');
    let last = -1;
    await waitFor(() => {
      const h = nb.scrollHeight;
      const stable = h === last;
      last = h;
      return stable;
    }, '页面布局稳定');
    nb.scrollTop = ratio * (nb.scrollHeight - nb.clientHeight);
  }

  // ------------------------------------------------------------ AI 侧边栏引用跳转（中文版）

  // alphaXiv 的引用按钮带 data-citation=[paper, page, startText, endText]。点击后，阅读器在已
  // 载入 PDF 的文字里匹配英文 startText…endText，命中则高亮并滚动；英文版、对照版含英文原文，
  // 能命中，中文版匹配不上，只能跳到页码。中文模式下本脚本在捕获阶段接管点击：
  // 英文引文 → TeXlate 段落 seq（与各段英文源码比对）→ 中文 PDF 里该段的标记内容
  // （TeXlate 编译时写入，MCID = 50000 + seq）→ 滚动并高亮。
  const MCID_BASE = 50000;
  const MAX_CITE_SEQS = 8; // 引文跨段时最多高亮的段数
  const alignCache = new Map(); // 任务 ID → Promise<{chunks, seqpos}>

  const skeleton = (s) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // LaTeX 源码 → 近似排版文字：去注释、引用类命令连同参数、其余命令名（保留参数里的文字）
  function latexText(src) {
    return src
      .replace(/(^|[^\\])%.*$/gm, '$1')
      .replace(/\\(?:cite[a-zA-Z]*|[a-zA-Z]*ref|label|url|href)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, ' ')
      .replace(/\\[a-zA-Z@]+\*?/g, ' ');
  }

  async function loadAlignment(tid) {
    const chunks = [];
    for (let offset = 0; ; offset += 500) {
      const { status, body } = await gmJson('GET', `/api/task/${tid}/chunks?offset=${offset}&limit=500`);
      if (status !== 200) throw new TexlateError(`读取段落原文失败（HTTP ${status}）：${JSON.stringify(body)}`);
      for (const c of body.chunks) chunks.push({ seq: c.seq, skel: skeleton(latexText(c.en)) });
      if (offset + 500 >= body.total) break;
    }
    const { status, body } = await gmJson('GET', `/api/task/${tid}/reader`);
    if (status !== 200) throw new TexlateError(`读取段落位置失败（HTTP ${status}）：${JSON.stringify(body)}`);
    return { chunks, seqpos: body.seqpos || {} };
  }

  function alignmentFor(tid) {
    if (!alignCache.has(tid)) {
      // 失败不缓存，下次点击重新读取
      alignCache.set(tid, loadAlignment(tid).catch((e) => (alignCache.delete(tid), Promise.reject(e))));
    }
    return alignCache.get(tid);
  }

  function lexGreater(a, b) {
    const i = a.findIndex((v, j) => v !== b[j]);
    return i >= 0 && a[i] > b[i];
  }

  // 按 12 字符片段（步长 3）的命中比例选段；PDF 断词连字符、空格与连字在骨架里都已抹平。
  // 同分时优先 seq ≥ minSeq（引文结尾不早于开头），再优先英文页码接近 pageHint 的段
  function locate(al, text, pageHint, minSeq = -1) {
    const q = skeleton(text || '');
    if (q.length < 6) return null;
    const k = Math.min(12, q.length);
    const grams = [];
    for (let i = 0; i + k <= q.length; i += 3) grams.push(q.slice(i, i + k));
    let best = null;
    for (const c of al.chunks) {
      const hits = c.skel.includes(q) ? grams.length : grams.filter((g) => c.skel.includes(g)).length;
      if (!hits) continue;
      const o = al.seqpos[c.seq] && al.seqpos[c.seq].o;
      const key = [hits, c.seq >= minSeq ? 1 : 0, o ? -Math.abs(o.page - pageHint) : -1e9];
      if (!best || lexGreater(key, best.key)) best = { seq: c.seq, key };
    }
    return best && best.key[0] / grams.length >= 0.5 ? best.seq : null;
  }

  // 英文页 → 中文页：取英文页内（或之前最近）首段在中文 PDF 里的页
  function zhPageFor(al, enPage, numPages) {
    let pick = null;
    for (const p of Object.values(al.seqpos)) {
      if (!p.o || !p.t || p.o.page > enPage) continue;
      if (!pick || p.o.page > pick.o.page || (p.o.page === pick.o.page && p.o.fraction < pick.o.fraction)) pick = p;
    }
    return Math.min(numPages, Math.max(1, pick ? pick.t.page : enPage));
  }

  function pageOrder(first, n) {
    const out = [first];
    for (let d = 1; out.length < n; d++) {
      if (first - d >= 1) out.push(first - d);
      if (first + d <= n) out.push(first + d);
    }
    return out;
  }

  // 在中文 PDF 里找这些段的标记内容，返回首个命中页的逐行矩形（PDF 坐标）
  async function findMarked(pdf, seqs, pages) {
    const want = seqs.map((s) => `_mc${MCID_BASE + s}`);
    for (const p of pages) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent({ includeMarkedContent: true });
      const stack = [];
      const lines = new Map();
      for (const it of tc.items) {
        if (it.type === 'beginMarkedContent' || it.type === 'beginMarkedContentProps') {
          stack.push(!!it.id && want.some((w) => it.id.endsWith(w)));
          continue;
        }
        if (it.type === 'endMarkedContent') {
          stack.pop();
          continue;
        }
        if (!it.str || !it.str.trim() || !stack.includes(true)) continue;
        const [, , , , x, y] = it.transform;
        const st = tc.styles[it.fontName] || {};
        const top = y + it.height * (st.ascent || 0.85);
        const bottom = y + it.height * (st.descent || -0.2);
        const key = Math.round(y);
        const ln = lines.get(key);
        if (ln) {
          ln.x1 = Math.min(ln.x1, x);
          ln.x2 = Math.max(ln.x2, x + it.width);
          ln.y1 = Math.min(ln.y1, bottom);
          ln.y2 = Math.max(ln.y2, top);
        } else lines.set(key, { x1: x, x2: x + it.width, y1: bottom, y2: top });
      }
      if (lines.size) return { pageNum: p, rects: [...lines.values()], view: page.view };
    }
    return null;
  }

  function clearCiteMarks() {
    document.querySelectorAll('[data-texlate-cite]').forEach((el) => el.remove());
  }

  // 高亮按页面百分比定位，缩放后仍对齐（pdf.js 重绘该页时会清掉，与原生高亮的持续时长不同）
  function showMarked(viewer, hit) {
    clearCiteMarks();
    const pv = viewer.getPageView(hit.pageNum - 1);
    const [vx0, vy0, vx1, vy1] = hit.view;
    const w = vx1 - vx0;
    const h = vy1 - vy0;
    for (const r of hit.rects) {
      const el = document.createElement('div');
      el.dataset.texlateCite = '1';
      el.style.cssText =
        'position:absolute;pointer-events:none;z-index:3;border-radius:2px;background:rgba(255,200,0,.38);mix-blend-mode:multiply;' +
        `left:${((r.x1 - vx0) / w) * 100}%;top:${((vy1 - r.y2) / h) * 100}%;` +
        `width:${((r.x2 - r.x1) / w) * 100}%;height:${((r.y2 - r.y1) / h) * 100}%`;
      pv.div.appendChild(el);
    }
    const top = Math.max(...hit.rects.map((r) => r.y2));
    // 段首上方留出约 1/6 页，免得高亮贴在工具栏下沿
    viewer.scrollPageIntoView({ pageNumber: hit.pageNum, destArray: [null, { name: 'XYZ' }, null, Math.min(vy1, top + h / 6), null] });
  }

  async function jumpToCitation(id, page, startText, endText) {
    const tid = shownTask.get(baseOf(id));
    if (!tid) throw new TexlateError('中文版尚未载入，无法定位引用');
    const al = await alignmentFor(tid);
    const viewer = await (await pageHelper()).viewer();
    if (!viewer || !viewer.pdfDocument) throw new TexlateError('阅读器尚未就绪，无法定位引用');
    const pdf = viewer.pdfDocument;
    const s0 = locate(al, startText, page);
    const near = zhPageFor(al, page, pdf.numPages);
    if (s0 === null) {
      clearCiteMarks();
      viewer.scrollPageIntoView({ pageNumber: near });
      ui.done(`未能在中文版中定位这段引文，已跳到对应页（第 ${near} 页）`);
      return;
    }
    const s1 = locate(al, endText, page, s0);
    const last = s1 !== null && s1 >= s0 && s1 - s0 < MAX_CITE_SEQS ? s1 : s0;
    const seqs = Array.from({ length: last - s0 + 1 }, (_, i) => s0 + i);
    const t = al.seqpos[s0] && al.seqpos[s0].t;
    const hit = await findMarked(pdf, seqs, pageOrder(t ? t.page : near, pdf.numPages));
    if (!hit) throw new TexlateError(`中文 PDF 中找不到第 ${s0} 段的位置标记（任务 ${tid}）`);
    showMarked(viewer, hit);
  }

  // 捕获阶段先于 React 的根节点监听执行；不属于中文模式当前论文的引用照常交给 alphaXiv
  document.addEventListener(
    'click',
    (ev) => {
      const el = ev.target instanceof Element ? ev.target.closest('[data-citation]') : null;
      const id = paperId();
      if (!el || !id || modeOf(id) !== 'zh' || !document.querySelector('.paperBody .page')) return;
      const cite = JSON.parse(el.getAttribute('data-citation'));
      if (!Array.isArray(cite)) throw new TexlateError(`无法识别的引用数据：${el.getAttribute('data-citation')}`);
      const [paper, page, startText, endText] = cite;
      if (paper && baseOf(String(paper)) !== baseOf(id)) return;
      ev.stopPropagation();
      ev.preventDefault();
      jumpToCitation(id, Number(page) || 1, startText, endText).catch(ui.error);
    },
    true,
  );

  // ------------------------------------------------------------ 工具栏切换钮

  // 浮在阅读器工具栏「分享」按钮右侧的空白处：挂 <body> + position:fixed，按锚点位置定位，
  // 不进工具栏排版流——插进去会挤宽工具栏、把右端打印按钮挤出可视区
  const ANCHOR = 'button[aria-label="Share paper"], button[aria-label="分享论文"]';

  const ui = (() => {
    const host = document.createElement('span');
    host.style.cssText = 'position:fixed;z-index:2147483646;display:none;align-items:center';
    host.dataset.texlate = 'toggle';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .main{min-width:28px;height:32px;padding:0 3px;border:0;border-radius:999px;background:transparent;
              color:#9a2036;cursor:pointer;font:600 12px/1 -apple-system,system-ui,sans-serif}
        .main:hover{background:rgba(0,0,0,.06)}
        .main:disabled{opacity:.5;cursor:default}
        .menu{position:fixed;z-index:2147483647;display:flex;flex-direction:column;padding:4px;border-radius:10px;
              background:#fff;border:1px solid #ddd;box-shadow:0 6px 18px rgba(0,0,0,.15);
              font:13px/1.2 -apple-system,system-ui,sans-serif}
        .menu[hidden],.tip[hidden]{display:none}
        .menu button{border:0;background:transparent;text-align:left;padding:7px 12px;border-radius:6px;
                     cursor:pointer;color:#222;font:inherit;white-space:nowrap}
        .menu button:hover{background:#f3e8ea}
        .menu button.on{color:#9a2036;font-weight:600}
        .tip{position:fixed;z-index:2147483647;max-width:300px;padding:6px 9px;border-radius:8px;
             background:#222;color:#fff;font:12px/1.4 -apple-system,system-ui,sans-serif;
             box-shadow:0 4px 14px rgba(0,0,0,.18);word-break:break-word}
        .tip.err{background:#b00020}
      </style>
      <button type="button" class="main"></button>
      <div class="menu" hidden>
        <button type="button" data-m="en">英文原版</button>
        <button type="button" data-m="zh">中文版</button>
        <button type="button" data-m="bi">中英对照版</button>
      </div>
      <div class="tip" hidden></div>`;
    const tip = shadow.querySelector('.tip');
    let tipTimer = null;

    const btn = shadow.querySelector('.main');
    const menu = shadow.querySelector('.menu');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (busy || !paperId()) return;
      menu.hidden = !menu.hidden;
      placeMenu();
    });
    menu.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.hidden = true;
        const id = paperId();
        if (busy || !id || b.dataset.m === modeOf(id)) return;
        busy = true;
        refresh();
        switchTo(b.dataset.m).catch(error).finally(() => {
          busy = false;
          refresh();
        });
      }),
    );
    document.addEventListener('click', () => (menu.hidden = true));

    // 菜单定位在按钮正下方左对齐（fixed：工具栏可能 overflow 裁剪）
    function placeMenu() {
      if (menu.hidden) return;
      const r = host.getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.left = `${r.left}px`;
    }

    function visibleAnchor() {
      return [...document.querySelectorAll(ANCHOR)].find((b) => b.getClientRects().length > 0) || null;
    }

    function ensureMounted() {
      // 页面 hydrate 完成前不挂任何节点（避免 React #418）；阅读器页节点只在客户端渲染，
      // 出现即说明 hydrate 已完成
      if (!host.isConnected) {
        if (!document.querySelector('.paperBody .page')) return;
        document.body.appendChild(host);
      }
      const anchor = visibleAnchor();
      if (!anchor) {
        host.style.display = 'none';
        return;
      }
      const r = anchor.getBoundingClientRect();
      host.style.display = 'inline-flex';
      host.style.left = `${r.right + 4}px`;
      host.style.top = `${r.top + (r.height - 32) / 2}px`;
    }

    // 浮层按按钮位置定位在其正下方右对齐；按钮不在页面上时不显示
    function place() {
      if (tip.hidden) return;
      const r = host.getBoundingClientRect();
      if (!host.isConnected || r.width === 0) {
        tip.style.visibility = 'hidden';
        return;
      }
      tip.style.visibility = '';
      tip.style.top = `${r.bottom + 6}px`;
      tip.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    }

    // sticky=false 的提示 3 s 后自动收起；进度与错误常驻到下一条提示
    function setStatus(text, isErr, sticky) {
      clearTimeout(tipTimer);
      tip.textContent = text;
      tip.classList.toggle('err', !!isErr);
      tip.hidden = false;
      place();
      if (!sticky) tipTimer = setTimeout(() => (tip.hidden = true), 3000);
    }

    function refresh() {
      ensureMounted();
      place();
      const id = paperId();
      if (!id) return;
      // 按钮显示当前模式，点开菜单选目标模式（未翻译/无对照版时后台生成）
      const mode = modeOf(id);
      btn.textContent = MODES[mode].label;
      btn.title = `当前：${MODES[mode].name}（TeXlate 切换）`;
      btn.setAttribute('aria-label', btn.title);
      btn.disabled = busy;
      menu.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    }

    function error(err) {
      console.error('[alphaxiv-texlate]', err);
      setStatus(err.message || String(err), true, true);
    }

    setInterval(refresh, 500);
    W.addEventListener('resize', place);

    return {
      status: (t) => setStatus(t, false, true),
      done: (t) => setStatus(t, false, false),
      error,
      refresh,
    };
  })();
})();
