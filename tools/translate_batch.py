"""逐篇提交 arXiv 翻译（TeXlate 串行队列），记录各篇耗时与终态，完成后生成对照版。

用法：uv run python -I translate_batch.py <arxiv_id>...
"""

import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "http://127.0.0.1:8765/api"
DB = Path("~/.texlate/texlate.db").expanduser()
TERMINAL = {"done", "partial", "fault", "cancelled", "interrupted", "needs_auth"}


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


con = sqlite3.connect(DB)
jobs = []
for aid in sys.argv[1:]:
    code, resp = call("POST", f"/arxiv/{aid}/translate", {"options": {"prefer": "fresh"}})
    if code not in (200, 202):
        print(f"{aid} submit failed: HTTP {code} {resp}", flush=True)
        continue
    jobs.append((aid, resp["task_id"]))
    print(f"{aid} queued {resp['task_id']}", flush=True)

for aid, tid in jobs:
    while True:
        st, created, updated, chunks, msg, title = con.execute(
            "SELECT status, created_at, updated_at, (SELECT count(*) FROM chunks WHERE task_id=tasks.id), message, title"
            " FROM tasks WHERE id=?",
            (tid,),
        ).fetchone()
        if st in TERMINAL:
            break
        time.sleep(10)
    # 实际运行时长：首个 stage 事件到终态（排队等待不计）
    t0 = con.execute("SELECT min(created_at) FROM task_events WHERE task_id=? AND type='stage'", (tid,)).fetchone()[0]
    run_s = round(updated - (t0 or created))
    print(f"{aid} {st} run={run_s}s chunks={chunks} msg={msg} title={title}", flush=True)
    if st in ("done", "partial"):
        code, resp = call("POST", f"/task/{tid}/bilingual")
        print(f"{aid} bilingual enqueue HTTP {code}", flush=True)
