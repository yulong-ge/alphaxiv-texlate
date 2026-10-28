# 模型路由

## 当前配置（2026-10-28）

| 层 | 配置 |
| --- | --- |
| TeXlate 通道 | Magpie `http://127.0.0.1:3425`，模型 `group/texlate-fast`，使用专用 gateway key `texlate` |
| `group/texlate-fast` | `order` 路由：先 `group/texlate-glm`，失败时用 `workbuddy/step-5-preview:low` |
| `group/texlate-glm` | `opencode-zen-free/glm-5.3-flash-free` |
| key `texlate` 模型白名单 | `group/texlate-fast`、`group/texlate-glm`、`opencode-zen-free/glm-5.3-flash-free`、`zhipu/glm-5.3-flash`、`workbuddy/step-5-preview` |
| TeXlate 设置 | `concurrency=12`，`warmup=false` |

## 约束

- OpenRouter 只用 `:free` 且标价为 0 的模型，不动用余额。网关层用 key 白名单把关；不用费用上限，原因见 [LESSONS.md](../../LESSONS.md)。
- 加入任何新模型前，先用 `tools/gen_arms.py` 和 qualbench 评测质量，过程见 [选型记录](../research/2026-10-28-model-selection.md)。

## 修改方式

```sh
magpie group set texlate-glm models=<a>,<b> routing=<order|weight|rotate>
magpie gateway-key models <texlate-key-id> <model>...
```

新增模型时，要同时把它加入 key 白名单，否则 TeXlate 的请求会被网关拒绝。
