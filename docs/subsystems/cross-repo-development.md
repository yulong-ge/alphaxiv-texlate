# alphaXiv × TeXlate 联动开发

alphaXiv-texlate 和本地 TeXlate fork 保持两个 Git 仓库、两个发布物。

- `alphaxiv-texlate` 是浏览器侧集成：菜单、PDF 字节替换、阅读器热重载、引用跳转和任务操作。
- `texlate` 是服务侧管线：arXiv 取源、分段翻译、LaTeX 重建、PDF 编译、对齐标记和任务 API。

两边保持分离的理由是：服务端可以被 CLI、其他阅读器和批处理工具使用，油猴脚本可以独立发布和回滚。跨仓库改动通过 API 契约、兼容矩阵和集成测试协调，不通过复制源码或把两个仓库嵌套维护。

## 变更边界

先修 TeXlate 的产物或算法，再让脚本消费稳定接口。脚本不应通过解析坏 PDF、猜测内部文件或保留兼容性补丁来掩盖服务端错误。例如 moving argument 中的 MCID 泄漏属于 TeXlate 编译问题，应修复 TeXlate 的标记算法；alphaXiv 只验证目录、文字层、引用跳转和 PDF 加载结果。

脚本侧新增服务调用时，先更新本页的 API 版本要求和 `docs/subsystems/texlate-api.md`，再在 TeXlate 增加对应端点和回归测试。旧服务不支持端点时，脚本应显示明确的升级提示，不静默降级为语义不同的操作。

## 发布兼容矩阵

| alphaXiv-texlate | TeXlate fork | 关键能力 |
| --- | --- | --- |
| `0.6.x` | `b1adf04` 及以后 | 语言切换、任务菜单、下载、取消/重试、`POST /api/task/{tid}/retranslate` |
| `0.5.x` | `587fc84`–`b774a20` | 语言切换、中英对照版、引用跳转；不支持全文 clean retranslate |

提交新的服务端接口或 PDF 产物规则时，同时更新矩阵。矩阵中的 TeXlate 提交必须是可复现的 fork revision；不要只写“最新版”。

## 验收顺序

1. TeXlate：运行受影响的单元/服务测试，验证真实 PDF 产物和 API 响应。
2. alphaXiv：运行 `node --check userscript/alphaxiv-texlate.user.js` 和 `tests/e2e/run_actions.py`。
3. 联动：运行 `run_visibility.py`、`run_modes.py` 和 `run_citation.py`；任务 API 变更还要覆盖旧服务的明确错误提示。
4. 发布：先发布或重启匹配的 TeXlate fork，再发布脚本；脚本更新必须提升 `@version`。

需要同时修改两边时，在各自仓库创建关联提交，并在 alphaXiv 提交说明中记录对应的 TeXlate revision。只有当多个版本持续必须原子发布、API 不再有独立消费者、且独立测试和发布已经成为主要负担时，才重新评估合并为 monorepo。
