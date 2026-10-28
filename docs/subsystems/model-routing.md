# 模型路由

## 当前配置（2026-10-28）

| 层 | 配置 |
| --- | --- |
| TeXlate 通道 | Magpie `http://127.0.0.1:3425`，模型 `group/texlate-fast`，使用专用 gateway key `texlate` |
| `group/texlate-fast` | `order` 路由：先 `group/texlate-pool`，失败时用 `workbuddy/step-5-preview:low` |
| `group/texlate-pool` | `weight`：`opencode-zen-free/glm-5.3-flash-free`（权重 3）、`openrouter/dots-studio/dots-3-note-preview:free:none`（1）、`openrouter/nvidia/nemotron-3-ultra-550b-a55b:free:none`（1） |
| key `texlate` 模型白名单 | 以上分组及其成员（OpenRouter 只列 `:free` 型号），另加旧分组 `texlate-glm`、`texlate-backup` 与 `zhipu/glm-5.3-flash` |
| TeXlate 设置 | `concurrency=12`，`warmup=false` |

## 约束

- OpenRouter 免费模型必须带 `:none`（关闭推理）。默认推理时，单批要输出 6k–15k 推理 token，导致超时和空内容；关闭后质量基本不变，速度提高 5–10 倍。不认 `none` 的模型（如 `flint`）不采用。
- OpenRouter 免费额度：每分钟 20 次、每天 1000 次（账户累计充值过 ≥10 美元才是这一档）。超过每分钟限额时返回 429，Magpie 会转给组内其他成员。用 `GET https://openrouter.ai/api/v1/key` 查看 `free_model_daily_requests`。

- OpenRouter 只用 `:free` 且标价为 0 的模型，不动用余额。网关层用 key 白名单把关；不用费用上限，原因见 [LESSONS.md](../../LESSONS.md)。
- 加入任何新模型前，先用 `tools/gen_arms.py` 和 qualbench 评测质量，过程见 [选型记录](../research/2026-10-28-model-selection.md)。

## 修改方式

```sh
magpie group set texlate-glm models=<a>,<b> routing=<order|weight|rotate>
magpie gateway-key models <texlate-key-id> <model>...
```

新增模型时，要同时把它加入 key 白名单，否则 TeXlate 的请求会被网关拒绝。
