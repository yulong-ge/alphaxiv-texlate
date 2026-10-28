# 代码规范与验收

| 规则 | 检查什么 |
| --- | --- |
| 失败显式报出：TeXlate 请求失败、切换超时、找不到 alphaXiv 内部模块，都抛出 `TexlateError`，并在按钮下方显示原因 | 没有吞掉异常的 `catch`；没有静默回退到刷新页面 |
| 依赖 alphaXiv 内部结构的地方，按文件名前缀和对象形状查找，不写死带 hash 的文件名或压缩后的导出名 | `PAGE_HELPER` 内没有 `-[A-Za-z0-9]{8}\.js` 字面量 |
| 只有在客户端渲染完成后才挂载节点 | 端到端测试无 pageerror |
| OpenRouter 只用 `:free` 模型；脚本在批量调用前拦截非 `:free` 的 OpenRouter 模型 | `tools/bench_models.py`、`tools/gen_arms.py` 中的硬闸 |
| 不把论文原文、译文和评测载荷提交进仓库 | `git status` 中没有 `arms/`、`*_results.jsonl` |

## 验收命令

```sh
node --check userscript/alphaxiv-texlate.user.js
uv run --with playwright python -I tests/e2e/run_modes.py 2605.05118   # 需本机 TeXlate 有该论文译文
```

端到端测试在真实 alphaXiv 页面上依次切换「双 → 中 → EN」。失败条件：整页刷新、文字层语言不符或出现 pageerror，任一发生即以非零状态退出。真实 Tampermonkey 环境下的验证见 README「限制」，尚未自动化。
