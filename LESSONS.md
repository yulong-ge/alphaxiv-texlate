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
