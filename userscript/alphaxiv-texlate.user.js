// ==UserScript==
// @name         alphaXiv × TeXlate 中文 PDF
// @namespace    local.texlate.alphaxiv
// @version      0.6.0
// @description  在 alphaXiv 阅读器内切换译文、全文重译、管理翻译任务和下载 PDF，划线翻译默认中文
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
  // alphaXiv currently has two reader shells in production. Newer pages use
  // #PDFPane/#viewer; the older shell used .paperBody. Keep the selectors
  // centralized because mount, reload, and the E2E harness all depend on them.
  const PDF_PAGE = '#viewer .page, .paperBody .page';
  const PDF_TEXT_FRESH =
    '#viewer .page:not([data-texlate-stale]) .textLayer span, .paperBody .page:not([data-texlate-stale]) .textLayer span';
  const PDF_SCROLL = '[data-scroll-restoration-id="paper-pdf-viewer"], .paperBody';
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
  const pendingModes = new Map();
  const modeOf = (id) => pendingModes.get(baseOf(id)) || GM_getValue('mode:' + baseOf(id), 'en');
  const setMode = (id, mode) => GM_setValue('mode:' + baseOf(id), mode);

  // 阅读器实际加载的带版本 ID；未见 PDF 请求前回退到地址栏 ID
  let currentId = null;
  // 论文（去版本号）→ 阅读器当前所载译文 PDF 的 TeXlate 任务 ID
  const shownTask = new Map();
  const paperId = () => {
    const route = idFromLocation();
    return route && currentId && baseOf(route) === baseOf(currentId) &&
      (!/v\d+$/.test(route) || route === currentId) ? currentId : route;
  };

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

  const ACTIVE_TASKS = new Set(['queued', 'fetching', 'parsing', 'translating', 'compiling']);
  const RETRY_TASKS = new Set(['partial', 'fault', 'cancelled', 'interrupted', 'needs_auth']);
  const taskSnapshots = new Map();
  const taskWatches = new Map();
  let actionPending = false;

  function samePaper(id) {
    const routeId = idFromLocation();
    return !!routeId && baseOf(routeId) === baseOf(id) && (!/v\d+$/.test(routeId) || routeId === id);
  }

  async function taskSnapshot(taskId) {
    const { status, body } = await gmJson('GET', `/api/task/${encodeURIComponent(taskId)}`);
    if (status !== 200) throw new TexlateError(`查询任务失败（HTTP ${status}）：${JSON.stringify(body)}`);
    return body;
  }

  async function latestTask(id) {
    const { status, body } = await gmJson('GET', '/api/arxivStatus/' + encodeURIComponent(id));
    if (status === 404 && body.error === 'not_found') return null;
    if (status !== 200 || !body.task_id) {
      throw new TexlateError(`查询进度失败（HTTP ${status}）：${body.detail || JSON.stringify(body)}`);
    }
    return taskSnapshot(body.task_id);
  }

  function rememberTask(id, snapshot) {
    const previous = taskSnapshots.get(id);
    if (previous && snapshot && (previous.created_at > snapshot.created_at ||
        (previous.task_id === snapshot.task_id && previous.updated_at > snapshot.updated_at))) return;
    taskSnapshots.set(id, snapshot);
    if (samePaper(id)) ui.refresh();
  }

  function taskDescription(snapshot) {
    if (!snapshot) return '尚未翻译';
    const names = {
      queued: '排队中', fetching: '获取源码', parsing: '解析中', translating: '翻译中',
      compiling: '编译中', done: '已完成', partial: '部分完成', fault: '失败',
      cancelled: '已取消', interrupted: '已中断', needs_auth: '需要认证',
    };
    const c = snapshot.counters;
    const detail = c && c.total ? ` · ${c.done}/${c.total} 段${c.failed ? `，${c.failed} 段失败` : ''}` : '';
    return `${names[snapshot.status] || snapshot.status} · ${snapshot.progress || 0}%${detail}`;
  }

  async function refreshTask(id) {
    const snapshot = await latestTask(id);
    rememberTask(id, snapshot);
    return snapshot;
  }

  // 按 task_id 跟踪，避免其他标签页新建任务后把进度和产物串到另一轮。
  function watchTask(id, taskId) {
    if (taskWatches.has(taskId)) return taskWatches.get(taskId);
    const promise = (async () => {
      const deadline = Date.now() + 2 * 60 * 60 * 1000;
      for (;;) {
        const snapshot = await taskSnapshot(taskId);
        rememberTask(id, snapshot);
        if (!ACTIVE_TASKS.has(snapshot.status)) {
          if (snapshot.status === 'cancelled') {
            if (samePaper(id)) ui.done('翻译任务已取消，原来显示的 PDF 保留');
            return snapshot;
          }
          if (!['done', 'partial'].includes(snapshot.status) || !snapshot.artifacts?.zh_pdf) {
            throw new TexlateError(`翻译未完成：${snapshot.error?.message || snapshot.message || taskDescription(snapshot)}（任务 ${taskId}）`);
          }
          if (samePaper(id)) {
            ui.done(snapshot.status === 'partial' ? '译文已生成，但有部分内容失败；请查看任务详情' : '全文翻译完成，译文已更新');
            // 英文阅读保持原样；中文版/对照版在任务完成后原地换入新产物。
            const mode = modeOf(id);
            const latest = await latestTask(id);
            if (samePaper(id) && latest?.task_id === taskId && mode !== 'en' && !busy) {
              busy = true;
              ui.refresh();
              try { await switchTo(mode); }
              finally { busy = false; ui.refresh(); }
            }
          }
          return snapshot;
        }
        if (Date.now() >= deadline) throw new TexlateError(`等待任务超时（${taskId}）；请打开 TeXlate 查看进度`);
        await sleep(POLL_MS);
      }
    })().finally(() => { taskWatches.delete(taskId); ui.refresh(); });
    taskWatches.set(taskId, promise);
    return promise;
  }

  function followTask(id, taskId) {
    watchTask(id, taskId).catch((err) => {
      if (samePaper(id)) ui.error(err);
      else console.error('[alphaxiv-texlate]', err);
    });
  }

  async function taskAction(action, id) {
    if (actionPending) return;
    actionPending = true;
    ui.refresh();
    try {
      // 操作绑定用户当前看到的任务，不能在点击后悄悄换成其他标签页的新任务。
      const snapshot = action === 'refresh' ? await refreshTask(id) : taskSnapshots.get(id);
      if (action === 'refresh') {
        if (snapshot && ACTIVE_TASKS.has(snapshot.status)) followTask(id, snapshot.task_id);
        if (samePaper(id)) ui.done(taskDescription(snapshot));
        return;
      }
      if (!snapshot) throw new TexlateError('尚无翻译任务，请先选择中文版或中英对照版');
      const taskId = snapshot.task_id;
      if (action === 'cancel' || action === 'retry' || action === 'retranslate') {
        if (action === 'retranslate' && ACTIVE_TASKS.has(snapshot.status)) {
          throw new TexlateError('已有翻译任务正在运行，请等待完成或先取消任务');
        }
        if (action === 'cancel' && !ACTIVE_TASKS.has(snapshot.status)) throw new TexlateError('当前任务已结束，无需取消');
        if (action === 'retry' && !RETRY_TASKS.has(snapshot.status)) throw new TexlateError('当前任务不需要重试');
        const { status, body } = await gmJson('POST', `/api/task/${encodeURIComponent(taskId)}/${action}`, { json: {} });
        if (status !== 202 && status !== 200) {
          const hint = action === 'retranslate' && [404, 405].includes(status) ? '请升级 TeXlate，当前服务不支持绕过旧译文缓存的全文重译' : body.detail || JSON.stringify(body);
          throw new TexlateError(`操作失败（HTTP ${status}）：${hint}`);
        }
        if (!body.task_id) throw new TexlateError('TeXlate 未返回任务 ID，无法跟踪操作结果');
        const next = await taskSnapshot(body.task_id);
        rememberTask(id, next);
        if (samePaper(id)) ui.done(action === 'cancel' ? '已取消翻译任务，原来显示的 PDF 保留' : '已提交到 TeXlate，可在菜单查看进度或取消');
        if (action !== 'cancel') followTask(id, body.task_id);
        return;
      }
      if (action === 'download-zh' || action === 'download-bi') {
        const mode = action === 'download-bi' ? 'bi' : 'zh';
        const url = snapshot.artifacts?.[mode === 'bi' ? 'bi_pdf' : 'zh_pdf'];
        if (!url) throw new TexlateError(`尚无${MODES[mode].name} PDF；请先选择对应模式生成`);
        const response = await gm('GET', url, { responseType: 'arraybuffer' });
        if (response.status !== 200) throw new TexlateError(`下载失败（HTTP ${response.status}）`);
        const blobUrl = URL.createObjectURL(new Blob([response.response], { type: 'application/pdf' }));
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `${baseOf(id).replaceAll('/', '-')}-${mode}.pdf`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return;
      }
      throw new TexlateError(`未知 TeXlate 操作：${action}`);
    } finally {
      actionPending = false;
      ui.refresh();
    }
  }

  // 对照版按需生成：入队后轮询 bi 地址出现；新增的 [bilingual] warning 即失败原因
  async function ensureBilingual(id) {
    const initial = await latestTask(id);
    if (!initial) throw new TexlateError('尚无翻译任务，无法生成对照版');
    const taskId = initial.task_id;
    const before = (initial.warnings || []).filter((w) => w.startsWith('[bilingual]')).length;
    const { status, body } = await gmJson('POST', `/api/task/${encodeURIComponent(taskId)}/bilingual`);
    if (status !== 202) throw new TexlateError(`提交对照版生成失败（HTTP ${status}）：${body.detail || JSON.stringify(body)}`);
    const t0 = Date.now();
    for (;;) {
      if (samePaper(id)) ui.status(`正在生成中英对照版…（${Math.round((Date.now() - t0) / 1000)} s）`);
      await sleep(POLL_MS);
      const snapshot = await taskSnapshot(taskId);
      rememberTask(id, snapshot);
      if (snapshot.artifacts?.bi_pdf) return;
      const warns = (snapshot.warnings || []).filter((w) => w.startsWith('[bilingual]'));
      if (warns.length > before) throw new TexlateError(warns[warns.length - 1].replace('[bilingual] ', ''));
      if (Date.now() - t0 >= 30 * 60 * 1000) throw new TexlateError(`生成对照版超时（任务 ${taskId}）；请打开 TeXlate 查看详情`);
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
    // 先验证页面桥接和目标产物，再改变供给 PDF 的模式。
    await (await pageHelper()).viewer();
    if (mode !== 'en') {
      await ensureTranslated(id);
      if (mode === 'bi' && !(await arxivFiles(id)).biUrl) await ensureBilingual(id);
    }
    if (!samePaper(id)) throw new TexlateError('论文已切换，已停止更换上一页的 PDF；翻译任务仍可在 TeXlate 查看');
    pendingModes.set(baseOf(id), mode);
    try {
      await reloadViewer();
      setMode(id, mode);
      ui.done(`当前显示：${MODES[mode].name}${mode === 'en' ? '' : '（TeXlate）'}`);
    } finally {
      pendingModes.delete(baseOf(id));
    }
  }

  // 新任务与已有任务都按固定 task_id 等待，菜单始终可以打开并取消。
  async function ensureTranslated(id) {
    let snapshot = await refreshTask(id);
    if (snapshot?.artifacts?.zh_pdf) return;
    let taskId = snapshot?.task_id;
    if (!snapshot || !ACTIVE_TASKS.has(snapshot.status)) {
      taskId = await startTranslate(id);
      ui.status('已提交到 TeXlate，后台翻译中；可在菜单查看进度或取消');
    }
    snapshot = await watchTask(id, taskId);
    if (!snapshot.artifacts?.zh_pdf) throw new TexlateError(`任务未生成中文 PDF：${taskDescription(snapshot)}`);
  }

  // ------------------------------------------------------------ 阅读器热重载

  async function waitFor(cond, what, timeoutMs = 60000) {
    const t0 = Date.now();
    while (!(await cond())) {
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
    const pick = (prefix, required = true) => {
      const urls = [
        ...performance.getEntriesByType('resource').map((e) => e.name),
        ...[...document.querySelectorAll('link[rel=modulepreload], script[src]')].map((l) => l.href || l.src),
      ];
      const u = urls.find((x) => new URL(x, location.href).pathname.startsWith('/assets/' + prefix));
      if (!u && required) throw new Error('找不到 alphaXiv 模块 ' + prefix + '（站点改版？）');
      return u || null;
    };
    const isStore = (v) =>
      v && typeof v.get === 'function' && typeof v.set === 'function' && typeof v.sub === 'function';
    const isAtoms = (v) =>
      v && typeof v === 'object' && 'pdfError' in v && 'pdfViewer' in v && 'loadedCanonicalId' in v;
    const viewerState = async () => {
      // 2026-11 新壳不再加载 api-typed；共享 store 在 bind-mutations，PDF
      // atoms 在 pdf.atoms。api-typed 只作为旧壳的可选 query-client 来源。
      const apiUrl = pick('api-typed-', false);
      const api = apiUrl ? await import(apiUrl) : null;
      const atomUrl = pick('pdf.atoms-', false) || pick('pdfjs-enums-', false);
      const atomMod = atomUrl ? await import(atomUrl) : null;
      const storeUrl = pick('bind-mutations-', false);
      const storeMod = storeUrl ? await import(storeUrl) : null;
      const modules = [storeMod, api].filter(Boolean);
      const store = modules.flatMap((m) => Object.values(m)).find(isStore);
      const atoms = atomMod && Object.values(atomMod).find(isAtoms);
      if (!store || !atoms) throw new Error('找不到阅读器状态 store/atom（站点改版？）');
      // 只调用形如 ()=>client??=make() 的单例 getter。不能试调用所有零参
      // 导出：其中包含 React hooks 和修改登录状态的动作。
      const userUrl = pick('user-', false);
      const userMod = userUrl ? await import(userUrl) : null;
      const queryClient = [userMod, api].filter(Boolean)
        .flatMap((m) => Object.values(m))
        .filter((v) => typeof v === 'function' && v.length === 0 && /^\\(\\)=>[\\w$]+\\?\\?=[\\w$]+\\(\\)$/.test(String(v)))
        .map((f) => f())
        .find((c) => c && typeof c.removeQueries === 'function' && typeof c.getQueryCache?.().findAll === 'function');
      if (!queryClient) throw new Error('找不到 react-query 客户端（站点改版？）');
      return { store, atoms, queryClient };
    };
    // 引用预览键不含 PDF 版本，缓存的匹配页码与坐标来自缓存时的 PDF，点击跳转也直接复用。
    // 换 PDF 后必须清掉，否则预览和跳转都按上一个模式的 PDF 定位。
    window.__texlateClearCitationCache = async () => {
      const { store, atoms, queryClient } = await viewerState();
      queryClient.removeQueries({
        predicate: ({ queryKey }) => Array.isArray(queryKey) && queryKey[0] === 'overview-citation-preview',
      });
      // 新版把原生引用状态放在 pdf.atoms；旧版还会把坐标放在 paper-citation.atoms。
      for (const key of ['citationPreview', 'currentSelection', 'activeAnchor', 'activeFocus']) {
        if (key in atoms) store.set(atoms[key], null);
      }
      const citationUrl = pick('paper-citation.atoms-', false);
      if (citationUrl) {
        const citationMod = await import(citationUrl);
        for (const a of Object.values(citationMod)) {
          const v = store.get(a);
          if (v && typeof v === 'object' && 'rects' in v && 'pageIndex' in v) store.set(a, null);
        }
      }
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
    return { reload: W.__texlateReloadPdf, viewer: W.__texlateViewer, clearCitations: W.__texlateClearCitationCache };
  }

  // 完成后按滚动比例恢复阅读位置（中英页数不同，只能近似对齐）
  async function reloadViewer() {
    const scroller = document.querySelector(PDF_SCROLL);
    if (!scroller) throw new TexlateError('找不到阅读器区域，无法热切换');
    const helper = await pageHelper();
    const previousDocument = (await helper.viewer())?.pdfDocument;
    const targetId = paperId();
    const ratio = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    const before = pdfLoads;
    // 标记旧页节点：新 PDFViewer 复用容器但重建页节点，未带标记的页出现文字层即新文档已渲染
    // （首页未必在视口内，故不限定页码）
    document.querySelectorAll(PDF_PAGE).forEach((pg) => (pg.dataset.texlateStale = '1'));
    clearCiteMarks();
    await helper.reload();
    await waitFor(async () => {
      const viewer = await helper.viewer();
      return pdfLoads > before && currentId === targetId && viewer?.pdfDocument && viewer.pdfDocument !== previousDocument;
    }, '阅读器载入新的 PDF 文档');
    await waitFor(
      () => document.querySelector(PDF_TEXT_FRESH),
      '新 PDF 渲染',
    );
    let last = -1;
    await waitFor(() => {
      const h = scroller.scrollHeight;
      const stable = h === last;
      last = h;
      return stable;
    }, '页面布局稳定');
    scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
    // 新 PDF 已渲染后再清：此前发起的预览计算仍可能基于旧 PDF
    await (await pageHelper()).clearCitations();
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
      if (!el || !id || modeOf(id) !== 'zh' || !document.querySelector(PDF_PAGE)) return;
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

  // ------------------------------------------------------------ 划线翻译默认中文

  // 保留“向 AI 提问”和“笔记”的原始卡片。只在用户打开翻译语言菜单后，
  // 看到“中文”选项时自动选择中文；单纯划线不会触发翻译。
  function installChineseTranslationDefault() {
    const GROUP = '[role="group"][aria-label="选中内容草稿"]';
    const TRANSLATE_BUTTON = 'button[aria-label="翻译选中文字"]';

    function consumeMenu() {
      const group = document.querySelector(GROUP);
      if (!group || !group.querySelector(TRANSLATE_BUTTON)) return;
      const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(
        (node) => node.textContent.trim() === '中文' && node.getClientRects().length,
      );
      if (item) item.click();
    }

    const start = () => {
      if (!document.body) throw new TexlateError('无法安装划线翻译默认中文：页面 body 尚未创建');
      const observer = new MutationObserver(consumeMenu);
      observer.observe(document.body, { childList: true, subtree: true });
      setInterval(consumeMenu, 40);
      consumeMenu();
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

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
        .menu{position:fixed;z-index:2147483647;display:flex;flex-direction:column;padding:6px;border-radius:10px;
              width:260px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;
              background:#fff;border:1px solid #ddd;box-shadow:0 6px 18px rgba(0,0,0,.15);
              font:13px/1.4 -apple-system,system-ui,sans-serif;color:#222}
        [hidden]{display:none!important}
        .menu button,.menu a{border:0;background:transparent;text-align:left;padding:7px 10px;border-radius:6px;
                     cursor:pointer;color:inherit;font:inherit;text-decoration:none}
        .menu button:hover:enabled,.menu a:hover{background:#f3e8ea}
        .menu button:disabled,.menu a[aria-disabled=true]{opacity:.45;cursor:default;pointer-events:none}
        .menu button.on{color:#9a2036;font-weight:600}
        .menu hr{border:0;border-top:1px solid #eee;margin:5px 0}
        .task-status,.task-note,.task-error{padding:5px 10px;overflow-wrap:anywhere}
        .task-status{font-weight:600}
        .task-note{font-size:12px;color:#666}
        .task-error{color:#b00020;font-size:12px}
        .menu .danger{color:#a22437}
        @media(prefers-color-scheme:dark){
          .menu{background:#242424;color:#eee;border-color:#555}
          .menu hr{border-color:#444}.task-note{color:#bbb}
          .menu button:hover:enabled,.menu a:hover{background:#493038}
          .menu button.on,.menu .danger{color:#ff9aac}.task-error{color:#ffb4bf}
        }
        .tip{position:fixed;z-index:2147483647;max-width:300px;padding:6px 9px;border-radius:8px;
             background:#222;color:#fff;font:12px/1.4 -apple-system,system-ui,sans-serif;
             box-shadow:0 4px 14px rgba(0,0,0,.18);word-break:break-word}
        .tip.err{background:#b00020}
      </style>
      <button type="button" class="main" aria-expanded="false" aria-controls="texlate-menu"></button>
      <div class="menu" id="texlate-menu" aria-label="TeXlate 阅读与翻译" hidden>
        <button type="button" data-m="en">英文原版</button>
        <button type="button" data-m="zh">中文版</button>
        <button type="button" data-m="bi">中英对照版</button>
        <hr>
        <div class="task-status" role="status" aria-live="polite">正在查询翻译状态…</div>
        <div class="task-note" hidden></div>
        <div class="task-error" role="alert" hidden></div>
        <button type="button" data-a="refresh">刷新任务状态</button>
        <button type="button" data-a="retranslate">重新翻译全文</button>
        <div class="task-note">重译将创建新任务，重新调用模型，保留旧 PDF。</div>
        <button type="button" data-a="cancel" class="danger" hidden>取消当前翻译</button>
        <button type="button" data-a="retry" hidden>继续 / 重试失败任务</button>
        <hr>
        <button type="button" data-a="download-zh">下载中文 PDF</button>
        <button type="button" data-a="download-bi">下载中英对照 PDF</button>
        <a data-a="details" target="_blank" rel="noopener noreferrer" aria-disabled="true">打开任务详情</a>
        <a href="${TEXLATE}/" target="_blank" rel="noopener noreferrer">打开 TeXlate</a>
      </div>
      <div class="tip" hidden></div>`;
    const tip = shadow.querySelector('.tip');
    let tipTimer = null;

    const btn = shadow.querySelector('.main');
    const menu = shadow.querySelector('.menu');
    let panelPaper = null;
    let panelError = '';
    let pollInFlight = false;
    let lastPoll = 0;

    async function pollTask() {
      const id = paperId();
      if (!id || pollInFlight) return;
      pollInFlight = true;
      lastPoll = Date.now();
      try {
        await refreshTask(id);
        if (samePaper(id)) panelError = '';
      } catch (err) {
        if (samePaper(id)) panelError = err.message || String(err);
        console.error('[alphaxiv-texlate]', err);
      } finally {
        pollInFlight = false;
        lastPoll = Date.now();
        refresh();
      }
    }

    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!paperId()) return;
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) {
        tip.hidden = true;
        pollTask();
      }
      placeMenu();
    });
    menu.querySelectorAll('button[data-m]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = paperId();
        if (busy || !id) return;
        menu.hidden = true;
        busy = true;
        refresh();
        switchTo(b.dataset.m).catch(error).finally(() => {
          busy = false;
          refresh();
        });
      }),
    );
    menu.querySelectorAll('button[data-a]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = paperId();
        if (!id || b.disabled) return;
        panelError = '';
        taskAction(b.dataset.a, id).catch((err) => {
          if (samePaper(id)) error(err);
          else console.error('[alphaxiv-texlate]', err);
        });
      }),
    );
    document.addEventListener('click', () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
    shadow.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); }
    });

    // 菜单定位在按钮正下方左对齐（fixed：工具栏可能 overflow 裁剪）
    function placeMenu() {
      if (menu.hidden) return;
      const r = host.getBoundingClientRect();
      const width = menu.getBoundingClientRect().width;
      const height = menu.getBoundingClientRect().height;
      menu.style.left = `${Math.max(16, Math.min(r.left, innerWidth - width - 16))}px`;
      menu.style.top = `${Math.max(16, Math.min(r.bottom + 6, innerHeight - height - 16))}px`;
    }

    function visibleAnchor() {
      return [...document.querySelectorAll(ANCHOR)].find((b) => b.getClientRects().length > 0) || null;
    }

    function ensureMounted() {
      // 页面 hydrate 完成前不挂任何节点（避免 React #418）；阅读器页节点只在客户端渲染，
      // 出现即说明 hydrate 已完成。alphaXiv 新版使用 #viewer，旧版使用 .paperBody。
      // SPA 切回摘要时仍保留有尺寸的 PDF 页；路由与页节点必须同时属于阅读器。
      const readerVisible = /^\/pdf\//.test(location.pathname) &&
        [...document.querySelectorAll(PDF_PAGE)].some((pg) => pg.getClientRects().length > 0);
      const anchor = readerVisible ? visibleAnchor() : null;
      if (!anchor) {
        // Remove the populated shadow host while alphaXiv hydrates the abstract shell.
        if (host.isConnected) host.remove();
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        return;
      }
      if (!host.isConnected) document.body.appendChild(host);
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
      tip.hidden = !menu.hidden;
      place();
      if (!sticky) tipTimer = setTimeout(() => (tip.hidden = true), 3000);
    }

    function refresh() {
      ensureMounted();
      place();
      const id = paperId();
      if (!id) return;
      if (panelPaper !== id) {
        panelPaper = id;
        panelError = '';
        tip.hidden = true;
        menu.hidden = true;
        lastPoll = 0;
      }
      const snapshot = taskSnapshots.get(id);
      const active = !!snapshot && ACTIVE_TASKS.has(snapshot.status);
      const mode = modeOf(id);
      btn.textContent = MODES[mode].label + (active ? '·' : '');
      btn.title = `当前：${MODES[mode].name} · TeXlate${snapshot ? ' · ' + taskDescription(snapshot) : ''}`;
      btn.setAttribute('aria-label', btn.title);
      // 保持菜单可打开：耗时翻译期间仍可取消任务或打开详情。
      btn.setAttribute('aria-busy', String(busy));
      btn.setAttribute('aria-expanded', String(!menu.hidden));
      menu.querySelectorAll('button[data-m]').forEach((b) => {
        b.classList.toggle('on', b.dataset.m === mode);
        b.disabled = busy;
      });
      shadow.querySelector('.task-status').textContent = taskSnapshots.has(id) ? taskDescription(snapshot) : '正在查询翻译状态…';
      const note = shadow.querySelector('.task-note');
      const warnings = snapshot?.warnings || [];
      note.hidden = !warnings.length;
      note.textContent = warnings.length ? `有 ${warnings.length} 条提示，请打开任务详情查看` : '';
      const taskError = shadow.querySelector('.task-error');
      const errorText = panelError || snapshot?.error?.message || '';
      taskError.hidden = !errorText;
      taskError.textContent = errorText;
      menu.querySelectorAll('button[data-a]').forEach((b) => {
        const action = b.dataset.a;
        b.disabled = actionPending || pollInFlight;
        if (action !== 'refresh' && !snapshot) b.disabled = true;
        if (action === 'retranslate' && (active || busy)) b.disabled = true;
        if (action === 'cancel') b.hidden = !active;
        if (action === 'retry') b.hidden = !snapshot || !RETRY_TASKS.has(snapshot.status);
        if (action === 'download-zh' && !snapshot?.artifacts?.zh_pdf) b.disabled = true;
        if (action === 'download-bi' && !snapshot?.artifacts?.bi_pdf) b.disabled = true;
      });
      const details = menu.querySelector('[data-a=details]');
      details.setAttribute('aria-disabled', String(!snapshot));
      if (snapshot) details.href = `${TEXLATE}/#/reader/${encodeURIComponent(snapshot.task_id)}`;
      else details.removeAttribute('href');
      placeMenu();
      if (!menu.hidden && !panelError && Date.now() - lastPoll >= POLL_MS) pollTask();
    }

    function error(err) {
      console.error('[alphaxiv-texlate]', err);
      panelError = err.message || String(err);
      setStatus(panelError, true, true);
      refresh();
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

  installChineseTranslationDefault();
})();
