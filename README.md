# alphaXiv × TeXlate

在 [alphaXiv](https://www.alphaxiv.org) 的论文阅读器里，一键把 PDF 换成本地 [TeXlate](https://github.com/WncFht/texlate) 翻译的中文版或中英对照版。切换在阅读器内原地完成，不刷新页面，alphaXiv 的 AI 侧边栏、引用弹窗和页内跳转照常可用。

## 组成

| 部分 | 作用 |
| --- | --- |
| `userscript/alphaxiv-texlate.user.js` | Tampermonkey 脚本：工具栏切换钮（EN / 中 / 双）、划线自动中文翻译、PDF 字节替换、阅读器热重载 |
| TeXlate（本地服务） | arXiv LaTeX 源码 → 段落翻译 → 重新编译中文 PDF。中英对照版需要 `POST /api/task/{id}/bilingual`，目前在 fork 分支 [yulong-ge/texlate@local/alphaxiv](https://github.com/yulong-ge/texlate/tree/local/alphaxiv)，正与上游讨论合并 |
| `tools/` | 模型评测、批量翻译、对照版批量生成等脚本 |
| `tests/e2e/` | Playwright 端到端测试（真实 alphaXiv 页面） |

## 使用

1. 运行 TeXlate 服务：`texlate service start --no-open`，监听 `http://127.0.0.1:8765`。
2. 装好 Tampermonkey 后，在浏览器中打开 <https://raw.githubusercontent.com/yulong-ge/alphaxiv-texlate/main/userscript/alphaxiv-texlate.user.js>，点「安装」。之后脚本会随仓库更新自动更新（Tampermonkey 按其检查周期拉取，也可在面板里手动「检查更新」）。
3. 打开 alphaXiv 论文的 Paper 视图。在工具栏「分享」右侧点 EN，按需选择：
   - **中文版**：未翻译时，后台提交 TeXlate 翻译并显示进度，完成后自动切换。
   - **中英对照版**：每个正文段先显示灰色原文，再显示译文。缺少时由 TeXlate 按需编译，通常只需几秒到几十秒。
   - **英文原版**：切回原文。
4. 每篇论文记住上次选择的模式，再次打开时直接显示该模式。
5. 在 PDF 中划线后，原有的 AI 提问和笔记卡片保持不变；点击其中的翻译图标后，脚本会自动选择「中文」，翻译结果随后显示在右下角卡片中。
6. 同一菜单还提供任务与文件操作：
   - **重新翻译全文**：创建新任务并重新调用模型，绕过旧的段落译文缓存，保留旧任务与 PDF。译文模式下，完成后原地加载新版；英文模式保持英文。需要本地 fork 的全文重译接口，旧服务会明确提示升级。
   - **任务进度 / 刷新任务状态**：显示翻译阶段、百分比、已完成段数、失败原因与提示数量。菜单打开时自动更新。
   - **取消当前翻译**：翻译期间仍可打开菜单并取消；已经显示的 PDF 保留。
   - **继续 / 重试失败任务**：续跑失败、中断、取消或部分完成的任务。保留已成功翻译的段落；需要全部重译时使用「重新翻译全文」。
   - **下载中文 PDF / 下载中英对照 PDF**：下载已生成的对应文件，不依赖当前阅读器显示的语言。
   - **打开任务详情 / 打开 TeXlate**：在新标签页查看日志、产物和完整设置。

## 工作原理

- alphaXiv 阅读器是 pdf.js `PDFViewer`。PDF 经全局 `fetch` 从 `pdfs.assets.alphaxiv.org/{id}.pdf` 取得，并缓存在 CacheStorage `alphaxiv-pdfs-v1`。脚本在中文或对照模式下改为返回 TeXlate 的 PDF，同时不让译文写入 alphaXiv 的缓存。
- 热切换：阅读器加载 PDF 的 effect 依赖 `[canonicalId, pdfError]`。脚本经页面的 jotai store 把 `pdfError` 置错再清空，阅读器即重新取 PDF；切换后按滚动比例恢复阅读位置。
- TeXlate 用 LaTeX 重新编译，PDF 内的 hyperref 链接得以保留，所以 alphaXiv 的引用解析在中文版上照常工作。
- AI 侧边栏的引用跳转靠在 PDF 文字里匹配英文引文，中文版里匹配不上。中文模式下脚本接管这类点击：先把英文引文对应到 TeXlate 的段落，再按 TeXlate 写进中文 PDF 的段落标记找到位置，滚动并高亮。英文版和对照版仍用 alphaXiv 原生跳转。

详见 [docs/subsystems/](docs/subsystems/README.md) 和[跨仓库联动开发](docs/subsystems/cross-repo-development.md)。

## 限制

- 只适用于提供 LaTeX 源码的 arXiv 论文。
- 依赖 alphaXiv 前端的内部结构（模块文件名前缀、jotai atom 形状、工具栏 aria-label）；alphaXiv 改版后可能失效，失败会在按钮下方显示原因。
- 中英页数不同，切换后的阅读位置只是近似对齐。
- 中文模式下，悬停引用按钮时的预览图仍按英文页码截取中文 PDF，内容可能对不上；点击跳转不受影响。
- 引用跳转只定位到段落；引文落在公式、表格或图注里时可能找不到对应段，此时跳到换算后的页并提示。

## 许可

[MIT](LICENSE)
