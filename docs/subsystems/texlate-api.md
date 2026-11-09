# TeXlate 接口

脚本使用 `GM_xmlhttpRequest` 访问 `http://127.0.0.1:8765`；工具脚本直接用 HTTP 访问。

| 接口 | 用途 | 关键语义 |
| --- | --- | --- |
| `GET /api/arxivFiles/{id}` | 查询译文产物 | 无任务时返回 404 `{"error":"not_found"}`。`data.zhCN` 非空表示中文 PDF 可用；`data.bi` 非空表示对照版可用（fork 扩展字段） |
| `GET /api/arxivStatus/{id}` | 查询进度 | `status ∈ start / finished / failed / error / fault`，并带 `progress` 和 `task_id`。查询的是该 id 最新的任务 |
| `POST /api/arxiv/{id}/translate` | 提交翻译 | 返回 202 和 `task_id`。`options.prefer=fresh` 只强制新建任务，仍可复用段落译文缓存 |
| `POST /api/task/{tid}/retranslate` | 全文重译（本地 fork 扩展） | 空 JSON 请求；仅支持已结束的 arXiv 任务。按当前渠道设置创建新任务，保留旧任务和产物，绕过持久段落缓存的读写。返回 202 和新的 `task_id`；旧服务返回 404/405 时提示升级，不降级为 fresh |
| `POST /api/task/{tid}/cancel` | 取消任务 | 活跃任务返回 200；终态返回 409。不会删除旧产物 |
| `POST /api/task/{tid}/retry` | 继续 / 重试 | 空 JSON 请求；失败、中断、取消、部分完成或缺认证任务返回 202，同一任务 ID，保留已成功的段落；done 不允许 |
| `POST /api/task/{tid}/bilingual` | 生成对照版 | 返回 202；任务不是 done/partial 时返回 409。不发翻译请求，只重新编译 |
| `GET /api/task/{tid}`（Accept: JSON） | 任务快照 | 包含原始 status、progress、counters、error、warnings 和 artifacts；`warnings` 中以 `[bilingual]` 开头的项表示对照版生成失败 |
| `GET /api/files/{tid}/{zh.pdf\|bi.pdf}` | 下载产物 | 脚本用 GM 获取字节，再创建 `application/pdf` Blob 下载，文件名含论文 ID 与语言 |

## 入站闸

TeXlate 本地模式会拒绝带跨站 `Origin` 或 `Sec-Fetch-Site: cross-site` 的写请求，返回 403。不带 `Origin` 的请求（如 curl、脚本）会被放行。Tampermonkey 的 `GM_xmlhttpRequest` 预期会删除 `Origin`（依据其 5.6 源码），但尚未在真实浏览器中验证。

## 对照版规则（fork 实现）

只有顶层正文段（不在环境中，或位于 `abstract` 环境内，并且不在命令参数的花括号里）会写成「灰色原文 + 译文」；其余块只放译文。原文副本中的 `\label` 被置空，公式和脚注计数器在副本前后保存并恢复。
