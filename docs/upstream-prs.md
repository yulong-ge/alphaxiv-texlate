# 向 TeXlate 上游提交的改动

本地 fork：`~/code/texlate`。每个 PR 分支都从 `origin/main`（`7df59124`）切出，只包含一项改动，并已单独跑过对应测试。

| 分支 | 类型 | 内容 | 验证 |
| --- | --- | --- | --- |
| `pr/arxiv-title` | 修 bug | eprint 分支原本从不含标题的 `meta.json` 取标题，arXiv 任务因此永远只显示 id；改为从已有的 Atom/OAI 元数据取标题 | 新测试先失败后通过；`test_worker_audit_fixes.py` 60 passed |
| `pr/pypdf-font-import` | 修 bug | pypdf 6.21 把 `Font` 移到 `pypdf.generic._font`，seqpos 报 `No module named 'pypdf._font'`。依赖声明是 `pypdf>=5.0`，所以先从新位置导入，失败再用旧位置 | 上游代码在 pypdf 6.21.3 下 seqpos 测试 8 failed；修复后 6.19 和 6.21.3 均 37 passed |
| `pr/autogloss-concurrent` | 性能 | 术语表提取的多批由串行改为并发；按批次顺序合并投票，结果与原来一致 | 新增并发测试先失败后通过；autogloss 23 passed |
| `pr/optional-warmup` | 功能 | 新增 `PipelineConfig.warmup` 与 `warmup` 设置（默认 true，即保持原行为），用于在轮转网关下跳过首项单飞 | 新增 2 项测试；xlat 与设置相关测试 1028 passed |
| `pr/tasklist-zh-pdf` | 功能 | 任务列表的 done/partial 行增加「中/ZH」按钮，在新标签页内联打开 `zh.pdf`；有标题时，arXiv id 显示在副行 | vitest 17 passed，typecheck 通过 |
| `pr/qualbench-gateway-env` | bench 修复 | qualbench 评审读取 `TEXLATE_BASE_URL`（与 `_shared.paid_factory` 的文档一致）和 `TEXLATE_QUALBENCH_SLOTS`；评审模型被以「去掉 provider 前缀的名字」回显时不判为 fallback | 仓库内没有 qualbench 测试；已在本机实跑 144 格评审，全部 judged |

## 建议先开 issue 讨论

- **中英对照 PDF（`bi.pdf`）**：涉及新的 job 类型、新的 API（`POST /api/task/{id}/bilingual`）、产物类型和 hjfy 兼容字段，属于产品层面的决定。先开 issue 说明设计（按需编译、配对规则、计数器保护），作者认可后再提 PR（本地提交 `ba2e0147`）。

## 不提交

- Magpie 候选模型的 qualbench frames 和 `FRAMES` 登记：只对本机网关有意义。
