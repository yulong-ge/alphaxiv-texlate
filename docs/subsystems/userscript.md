# userscript

源文件：[`userscript/alphaxiv-texlate.user.js`](../../userscript/alphaxiv-texlate.user.js)

## 职责与边界

在 `alphaxiv.org` 页面内完成四件事：替换阅读器拿到的 PDF 字节；不刷新页面地触发阅读器重新加载；提供工具栏切换钮；中文模式下接管 AI 侧边栏的引用跳转。翻译和编译都交给 TeXlate，脚本自身不处理 PDF 内容。

## 真源

- 每篇论文的模式：GM 存储键 `mode:<去版本号的 arXiv id>`，取值 `en | zh | bi`，默认 `en`。
- 当前论文：阅读器最近一次请求的 PDF URL 中的带版本 id（`currentId`）；还没有请求时，取地址栏中的 id。

## 运行路径

1. `document-start`：替换 `window.fetch`，并改写 `Cache.prototype.match/put`。
   - 对 `https://pdfs.assets.alphaxiv.org/{id}.pdf`，非 en 模式下 `match` 返回未命中、`put` 忽略，`fetch` 改为返回 TeXlate 的 `zh.pdf` 或 `bi.pdf`。
   - 每次 `match` 计一次 PDF 载入（`pdfLoads`）。英文模式命中缓存时不经过 `fetch`，所以载入次数在这里计。
2. 选择模式（`switchTo`）：
   - 选 zh 或 bi 时，先确保已翻译（`ensureTranslated`：提交翻译并轮询 `arxivStatus`）。
   - 选 bi 时，再确保有对照版（`ensureBilingual`：`POST bilingual`，轮询 `arxivFiles.bi`；新增的 `[bilingual]` warning 即视为失败）。
   - 写入模式，然后调用 `reloadViewer`。
3. `reloadViewer`：
   - 记录滚动比例，并给旧页节点打 `data-texlate-stale` 标记。
   - 调用注入页面的 `__texlateReloadPdf`：经 jotai store 先把 `pdfError` 置为错误，等两帧再清空。
   - 等待 `pdfLoads` 增加，且出现未标记的页文字层。
   - 等页面布局稳定后，恢复滚动比例。
4. 引用跳转（仅 zh 模式）：
   - alphaXiv 引用按钮带 `data-citation=[paper, page, startText, endText]`，原生逻辑在已载入 PDF 的文字里匹配英文引文。英文版和对照版含原文，能命中；中文版不含，只能跳到英文页码。
   - 脚本在 `document` 捕获阶段拦截点击（先于 React 根节点监听）。引用别的论文、或不在 zh 模式时不拦截。
   - 英文引文 → 段落 seq：读取 TeXlate `/api/task/{tid}/chunks`（各段英文源码）与 `/reader`（`seqpos`，各段在原文与译文 PDF 中的页和位置）。引文与段落源码都化为「NFKC + 小写 + 只留字母数字」的骨架，按 12 字符片段命中比例选段，同分时优先英文页码接近的段。
   - seq → 中文位置：TeXlate 编译时给每段写入标记内容 `MCID = 50000 + seq`。脚本用 `getTextContent({includeMarkedContent:true})` 从 `seqpos` 给出的译文页开始找该标记，取其中文字的逐行矩形。
   - 按页面百分比画高亮（缩放后仍对齐），并滚到段首上方约 1/6 页处。
   - 找不到对应段时跳到换算后的中文页，并在按钮下方提示「未能定位」；找到段却找不到标记时报错。

## alphaXiv 内部依赖点（改版风险）

| 依赖 | 查找方式 |
| --- | --- |
| PDF 地址前缀 `pdfs.assets.alphaxiv.org` | 常量 `PDF_PREFIX` |
| 缓存名 `alphaxiv-pdfs-v1` | 不按名字识别，改写 `Cache.prototype` 时按 URL 判断 |
| jotai store 与阅读器 atom 组 | `PAGE_HELPER`：按 `/assets/api-typed-*` 和 `/assets/pdfjs-enums-*` 前缀定位模块；store 取同时有 `get/set/sub` 的导出，atom 组取同时有 `pdfError/pdfViewer/loadedCanonicalId` 键的导出 |
| 阅读器加载 effect 的依赖为 `[canonicalId, pdfError]` | 只能通过行为验证（端到端测试） |
| 工具栏锚点 | `button[aria-label="Share paper"]` 或 `button[aria-label="分享论文"]` |
| 滚动容器与页节点 | `.paperBody`、`.page`、`.textLayer` |
| 引用按钮属性 `data-citation`（JSON 数组 `[paper, page, startText, endText]`） | `closest('[data-citation]')` |
| 阅读器 `pdfViewer`（`getPageView`、`scrollPageIntoView`、`pdfDocument`） | `PAGE_HELPER` 的 `__texlateViewer`，取自同一 atom 组的 `pdfViewer` |

## 约束

- 内联 module 只在首次热切换时注入，因为 `document-start` 时 `<head>` 可能还不存在。注入必须在页面 realm 中执行 `import()`，才能拿到同一个 store 实例。
- 挂载与定位约束见 [LESSONS.md](../../LESSONS.md)：等 hydrate 完成后再挂载；用 `fixed` 定位，不插入工具栏；处理 `[hidden]` 样式。

## 验证

- 热切换：`uv run --with playwright python -I tests/e2e/run_modes.py <id>`。
- 引用跳转：`uv run --with playwright --with pypdf python -I tests/e2e/run_citation.py <id> [n]`。引文取自英文 PDF 的抽取文字（保留断词连字符），注入真实格式的 `data-citation` 按钮后点击；判据是高亮区汉字与期望段译文的重合率 ≥ 0.6。没有走真实 AI 对话。

见 [代码规范与验收](../code-standards.md)。

## 失败行为

所有失败都在按钮下方用红色浮层显示原因，不自动刷新页面，也不回退到其他模式。热切换的每个等待步骤都有超时（默认 60 s），超时信息会说明卡在哪一步。
