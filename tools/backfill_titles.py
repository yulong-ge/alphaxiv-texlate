"""一次性：给 ~/.texlate/texlate.db 中标题为空的 arXiv 任务补论文标题。

用法：uv run --project ~/code/texlate python -I backfill_titles.py [DB_PATH]
只写 title 为空的行；arXiv 未返回标题的论文逐条列出并以非零退出码结束。
"""

import sqlite3
import sys
from pathlib import Path

from texlate.arxiv.fetch import Fetcher
from texlate.arxiv.meta import fetch_metadata_batch, req_base_ver
from texlate.arxiv.ratelimit import RateLimiter

db_path = Path(sys.argv[1] if len(sys.argv) > 1 else "~/.texlate/texlate.db").expanduser()
if not db_path.is_file():
    sys.exit(f"数据库不存在：{db_path}")

con = sqlite3.connect(db_path)
rows = con.execute(
    "SELECT id, arxiv_id FROM tasks WHERE kind IN ('arxiv', 'arxiv_html')"
    " AND title = '' AND arxiv_id != ''"
).fetchall()
print(f"待补标题任务：{len(rows)}")
if not rows:
    sys.exit(0)

fetcher = Fetcher(RateLimiter(db_path.parent / "src-cache" / "ratelimit.json"))
try:
    metas = fetch_metadata_batch([a for _, a in rows], fetcher=fetcher)
finally:
    fetcher.close()

missing = []
with con:
    for tid, arxiv_id in rows:
        meta = metas.get(req_base_ver(arxiv_id)[0])
        if meta is None or not meta.title:
            missing.append(arxiv_id)
            continue
        con.execute("UPDATE tasks SET title = ? WHERE id = ? AND title = ''", (meta.title, tid))
        print(f"{arxiv_id}\t{meta.title}")

if missing:
    sys.exit(f"arXiv 未返回标题：{', '.join(missing)}")
