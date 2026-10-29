# 教训

每条先写规则，再写原因和证据。同一教训在 3 个不同的日子被发现，就移进 [docs/code-standards.md](docs/code-standards.md)，并在这里注明已移动。

## 2026-10-28

- **在阅读器客户端渲染出 `.paperBody .page` 之前，不向页面插入任何节点。**
  原因：工具栏是服务端渲染后由客户端 hydrate 的，提前插入会触发 React #418。证据：带脚本时出现 pageerror `Minified React error #418`，不带脚本时没有；加入此判断后消失。
- **切换钮挂在 `<body>` 上用 `position:fixed` 定位，不插进工具栏。**
  原因：插进工具栏会撑宽它，把右端的打印按钮挤出可视区（宽度 1400 px 时实测）。
- **Shadow DOM 里给设置了 `display` 的元素补上 `[hidden]{display:none}`。**
  原因：作者样式的 `display:flex` 会覆盖 `hidden` 属性的默认效果，隐藏的菜单仍会拦截点击。证据：Playwright 报告 “menu subtree intercepts pointer events”。
- **热重载要触发阅读器 effect 的依赖（`pdfError`），不能靠切换 Abstract/Paper 标签。**
  原因：切换标签后，阅读器复用了原来的 pdf.js 实例和页节点，不会重新 `setDocument`。证据：切换前后 `.page` 节点保持同一批（旧节点标记全在）。
- **端到端测试以「按钮恢复可点」作为切换完成的判据。**
  原因：「出现新页文字层」在后台翻译或生成期间就会被旧页满足，导致测量过早。
- **Magpie gateway key 不要用费用上限来拦付费模型，要用模型白名单。**
  原因：Magpie 按模型目录标价估算费用，免费模型也会被计费，0.01 美元的上限会把正常翻译拦成 429。证据：texlate key 报 “has used $0.05 of its $0.01”。
- **OpenCode Zen 免费额度会用尽（429 “Free usage limit reached”），翻译耗时以降级模型为准评估。**
  证据：WorldCast（238 块）翻译期间，61 个请求降级到 step-5-preview，用时 914 s；1502.02761 在 Zen 正常服务时只用 138 s。
- **调用 OpenRouter 免费模型时显式关闭推理（Magpie 成员写 `:none`）。**
  原因：默认推理下，单批输出 6k–15k 推理 token，导致超时、空内容和占位符损坏；关闭后，dots 从 94–108 s 降到 11 s，nemotron-ultra 从 66–143 s 降到 16 s，质量仍在第一档。证据：`docs/research/2026-10-28-model-selection.md`。

## 2026-10-29

- **在 alphaXiv 的 React 事件之前接管点击，要在 `document` 上注册捕获阶段监听并 `stopPropagation`。**
  原因：React 17+ 的监听挂在根容器上，`document` 捕获阶段先于它执行。引用按钮的处理函数从 props 闭包取引文，改 DOM 属性影响不到它，只能整体接管。
- **TeXlate 段级缓存命中会绕过 `validate_pair`，新加的译文校验规则必须同时注册为拦截网（`CACHE_VETO_RULES` + `_INTERCEPT_NETS`）。**
  证据：只加规则时，`prefer=fresh` 重跑 NeoVerse 仍从缓存取回 `公寓_发布_…` 坏译文，编译照样失败。
- **对照版从 `base/` 重新拼装，主编译 fixloop 在 `build-zh` 里做的修复带不过来；对照版编译不干净时要再跑一次 fixloop。**
  证据：NeoVerse 中文版靠 ifsym→marvosym 替换编译成功，对照版仍因 `ifsym10` 无字体失败，加 fixloop 后 25 页成功。
