# alphaXiv × TeXlate

alphaXiv 阅读器内热切换 TeXlate 中文 / 中英对照 PDF 的油猴脚本，外加评测与批处理工具。用户说明见 [README](README.md)。

## 改动前先读

- 改油猴脚本前，先读 [userscript 子系统](docs/subsystems/userscript.md)：其中有 alphaXiv 内部依赖点、钩子与热重载的约束。
- 改调用 TeXlate 的接口前，先读 [TeXlate 接口](docs/subsystems/texlate-api.md)。
- 选择或调整翻译模型前，先读 [模型路由](docs/subsystems/model-routing.md) 和 [选型记录](docs/research/2026-10-28-model-selection.md)。
- 写代码和验收时，先读 [代码规范与验收](docs/code-standards.md)。
- 已踩过的坑见 [LESSONS.md](LESSONS.md)。

## 固定事实

| 项 | 值 |
| --- | --- |
| TeXlate 服务 | `http://127.0.0.1:8765` |
| TeXlate 源码 | 本地 fork `~/code/texlate`，分支 `local/alphaxiv` |
| 翻译网关 | Magpie `http://127.0.0.1:3425`，模型 `group/texlate-fast` |
| OpenRouter | 只许 `:free` 且标价 0 的模型，不动用账户余额 |
