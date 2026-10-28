"""对所有 done/partial 的 arXiv 任务生成对照版 PDF，汇总成败。

用法：uv run python -I bi_all.py
"""

import json
import sqlite3
import time
import urllib.request
from pathlib import Path

API = "http://127.0.0.1:8765/api"
DB = Path("~/.texlate/texlate.db").expanduser()


def call(method: str, path: str) -> tuple[int, dict]:
    req = urllib.request.Request(API + path, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


_, body = call("GET", "/tasks")
tasks = [t for t in body["tasks"] if t["status"] in ("done", "partial") and t["kind"].startswith("arxiv")]
con = sqlite3.connect(DB)
# 只认本轮入队之后的事件：旧轮次的成功/失败行不能当作本轮结果
base_seq = {
    t["task_id"]: con.execute("SELECT COALESCE(MAX(seq), -1) FROM task_events WHERE task_id=?", (t["task_id"],)).fetchone()[0]
    for t in tasks
}
for t in tasks:
    code, resp = call("POST", f"/task/{t['task_id']}/bilingual")
    if code != 202:
        print("enqueue failed", t["arxiv_id"], code, resp)


def state(tid: str) -> tuple[bool, str]:
    has = con.execute("SELECT 1 FROM files WHERE task_id=? AND kind='bi_pdf'", (tid,)).fetchone() is not None
    row = con.execute(
        "SELECT data FROM task_events WHERE task_id=? AND seq>? AND (data LIKE '%对照版生成失败%' OR data LIKE '%bilingual: bi.pdf%')"
        " ORDER BY seq DESC LIMIT 1",
        (tid, base_seq[tid]),
    ).fetchone()
    return has, (json.loads(row[0]).get("message") or json.loads(row[0]).get("line") or "")[:200] if row else ""


deadline = time.time() + 1200
while time.time() < deadline:
    pending = [t for t in tasks if not state(t["task_id"])[1]]
    if not pending:
        break
    time.sleep(10)
for t in tasks:
    has, msg = state(t["task_id"])
    print(f"{t['arxiv_id']:14s} {t['status']:8s} bi={'Y' if has else 'N'} {msg.splitlines()[-1] if msg else 'TIMEOUT'}")
