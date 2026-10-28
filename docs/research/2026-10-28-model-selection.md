# 翻译模型选型（2026-10-28）

## 结论（2026-10-29 更新）

- OpenRouter 免费模型此前失败的主因是默认推理：超时、空内容（`finish_reason=length`）、慢。加 `:none` 后：
  - `dots-3-note:free` 得 97.4 分，24 块 36 s。
  - `nemotron-3-ultra:free` 得 96.7 分，24 块 63 s。
  两者都进入主力池 `texlate-pool`，与 Zen GLM 按 3:1:1 混合。
- 实测：Solaris（140 块）重译 179 s，状态 done（原为 partial）。共 94 个请求，其中 13 个触发 OpenRouter 每分钟限额后由 Magpie 转给其他成员；Zen 额度用尽时被自动跳过。

## 早期结论

- 第一层用 OpenCode Zen 免费 `glm-5.3-flash-free`：质量第一档、不推理、并发能力强。缺点是免费额度会用尽。
- 后备层轮转 `workbuddy/step-5-preview:low` 和 OpenRouter 免费 `nemotron-3-ultra`：两者质量都在第一档，但都慢。
- 不用：原 `group/group-translate`（混入机器翻译 `doubao`，丢失占位符，质量 89.3）；OpenRouter 其余免费模型（证据见下）。

## 质量（qualbench）

样本 `qualframe-live-v1`，3 篇论文共 24 块。被评模型先经产品管线（`XlatPipeline` + `pair_feedback`）翻译；评审为 `codex/gpt-6.1-sol`，协议 ESA esa2，不启用二裁。数据见 [qualbench_summary.txt](qualbench_summary.txt)。

| 配置 | stated100 | major |
| --- | --- | --- |
| step-5-preview:low | 97.5 | 5 |
| glm-5.3-flash | 97.2 | 3 |
| nemotron-3-ultra:free | 97.0 | 7 |
| swe-2-medium（参照） | 96.8 | 7 |
| deepseek-v4.1-flash:low | 95.8 | 7 |
| hy3:low | 95.3 | 9 |
| nemotron-3.5-super-vl:free | 95.0 | 10 |
| dots-3-note:free:none | 97.4 | 4 |
| nemotron-3-ultra:free:none | 96.7 | 6 |
| north-mini-code:free:none | 90.0 | 22 |
| laguna-s-2.1:free:none | 88.9 | 24 |
| group-translate（原分组） | 89.3 | 18 |

## 速度与可用性

- 推理程度：`hy3`、`deepseek-v4.1-flash` 设为 `low` 甚至 `none`，仍输出 4–7k 推理 token。Magpie 会把 `none` 换成模型支持的最近档位。
- GLM-5.3-Flash 的不同来源（5 块批次）：
  - zhipu：单请求 11–19 s，8 路并发时中位 131 s，实际是串行处理。
  - zcode：16 路并发时出现 401 和 429。
  - OpenCode Zen：24 路并发全部成功，吞吐约 0.35 req/s 时饱和。
- OpenRouter 免费模型：13 个模型各测 2 轮，结果见 [or_free_summary.txt](or_free_summary.txt)。

  | 情况 | 模型 |
  | --- | --- |
  | 两轮成功且占位符完整 | laguna-s（快）、nemotron-ultra、nemotron-super-vl、dots（均慢） |
  | 占位符损坏 | north-mini、laguna-xs、nano-omni；lfm、flint 各坏一轮 |
  | 不可用 | gemma×2、xing（429），nemotron-lightning（超时） |
  | 不提供普通 API 调用 | inkling×2（仅限 agent 应用） |
  | 免费版已下架 | nemotron-3-super（404） |

  laguna-s 在完整管线的大批次下反复返回空内容（`finish_reason=length`），24 块在 25–40 分钟内都没完成，因此不采用。
- 端到端耗时：
  - 1502.02761（74 块）：Zen 正常时 138 s；优化前 1440 s。
  - 2610.12412（238 块）：914 s，期间 Zen 额度用尽，61 个请求降级。
  - 2608.06257（216 块）：498 s。
