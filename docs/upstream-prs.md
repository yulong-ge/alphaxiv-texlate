# 向 TeXlate 上游提交的改动

本地 fork：`~/code/texlate`，GitHub fork [yulong-ge/texlate](https://github.com/yulong-ge/texlate)。2026-10-28 已全部提交。每个 PR 分支都从 `origin/main`（`7df59124`）切出，只包含一项改动，并已单独跑过对应测试。

| 分支 | 类型 | 内容 | 验证 |
| --- | --- | --- | --- |
| [#33](https://github.com/WncFht/texlate/pull/33) `pr/arxiv-title` | 修 bug | eprint 分支原本从不含标题的 `meta.json` 取标题，arXiv 任务因此永远只显示 id；改为从已有的 Atom/OAI 元数据取标题 | 新测试先失败后通过；`test_worker_audit_fixes.py` 60 passed |
| [#34](https://github.com/WncFht/texlate/pull/34) `pr/pypdf-font-import` | 修 bug | pypdf 6.21 把 `Font` 移到 `pypdf.generic._font`，seqpos 报 `No module named 'pypdf._font'`。依赖声明是 `pypdf>=5.0`，所以先从新位置导入，失败再用旧位置 | 上游代码在 pypdf 6.21.3 下 seqpos 测试 8 failed；修复后 6.19 和 6.21.3 均 37 passed |
| [#35](https://github.com/WncFht/texlate/pull/35) `pr/autogloss-concurrent` | 性能 | 术语表提取的多批由串行改为并发；按批次顺序合并投票，结果与原来一致 | 新增并发测试先失败后通过；autogloss 23 passed |
| [#36](https://github.com/WncFht/texlate/pull/36) `pr/optional-warmup` | 功能 | 新增 `PipelineConfig.warmup` 与 `warmup` 设置（默认 true，即保持原行为），用于在轮转网关下跳过首项单飞 | 新增 2 项测试；xlat 与设置相关测试 1028 passed |
| [#37](https://github.com/WncFht/texlate/pull/37) `pr/tasklist-zh-pdf` | 功能 | 任务列表的 done/partial 行增加「中/ZH」按钮，在新标签页内联打开 `zh.pdf`；有标题时，arXiv id 显示在副行 | vitest 17 passed，typecheck 通过 |
| [#38](https://github.com/WncFht/texlate/pull/38) `pr/qualbench-gateway-env` | bench 修复 | qualbench 评审读取 `TEXLATE_BASE_URL`（与 `_shared.paid_factory` 的文档一致）和 `TEXLATE_QUALBENCH_SLOTS`；评审模型被以「去掉 provider 前缀的名字」回显时不判为 fallback | 仓库内没有 qualbench 测试；已在本机实跑 144 格评审，全部 judged |

2026-10-29 追加（同样从 `origin/main` 切出）：

| 分支 | 类型 | 内容 | 验证 |
| --- | --- | --- | --- |
| [#40](https://github.com/WncFht/texlate/pull/40) `pr/validate-special-chars` | 修 bug | 译文净增未转义 `_ ^ & #` 判 error，并注册同名缓存拦截网。2601.00393 的数据集名被意译成 `公寓_发布_…`，导致整篇编译失败 | 1284 passed；4811 个历史块回放 0 误报 |
| [#41](https://github.com/WncFht/texlate/pull/41) `pr/fixloop-ifsym-shim` | 修 bug | `font_sub_shim` 增加 `ifsym → marvosym` 映射和 `drop_options` 开关；修复 tectonic 下缺 `ifsym10` 时 xdvipdfmx 退出的问题 | 155 passed；手工复现 rc=0 |

对照版的两处修复（括号不配平的块不配对；对照版编译不干净时跑 fixloop）只在 fork 的 `local/alphaxiv` 分支，等 [#39](https://github.com/WncFht/texlate/issues/39) 有结论后随对照版一起提交。

## 先开 issue 讨论（[#39](https://github.com/WncFht/texlate/issues/39)）

- **中英对照 PDF（`bi.pdf`）**：涉及新的 job 类型、新的 API（`POST /api/task/{id}/bilingual`）、产物类型和 hjfy 兼容字段，属于产品层面的决定。先开 issue 说明设计（按需编译、配对规则、计数器保护），作者认可后再提 PR（本地提交 `ba2e0147`）。

## 不提交

- Magpie 候选模型的 qualbench frames 和 `FRAMES` 登记：只对本机网关有意义。
