"""经 Magpie 直连候选模型，用 TeXlate 真实批量提示词测延迟、推理开销与批协议合规率。

用法：uv run --project ~/code/texlate python -I bench_models.py <rounds> <model[:effort]>...
effort 取 none/low/...；省略则不发 reasoning_effort。结果逐行打印并写入 bench_results.jsonl。
"""

import asyncio
import json
import re
import sqlite3
import sys
import time
from pathlib import Path

import httpx
from texlate.xlat.batch import encode_batch, parse_batch_response
from texlate.xlat.prompts import build_system_prompt

TASK = "t_966e49ede03afb9d"  # 2603.07514v3，done
N_CHUNKS = int(__import__("os").environ.get("N_CHUNKS", "12"))
GATEWAY = "http://127.0.0.1:3425/v1/chat/completions"
OUT = Path(__file__).with_name("bench_results.jsonl")
PH = re.compile(r"\[\[[A-Z]+_\d+\]\]")


def load_key() -> str:
    # BENCH_CHANNELS 可指向带通用 Magpie 密钥的 channels.json（TeXlate 自用密钥有模型白名单）
    src = Path(__import__("os").environ.get("BENCH_CHANNELS") or "~/.texlate/channels.json").expanduser()
    chans = json.loads(src.read_text())["channels"]
    key = next(c["api_key"] for c in chans if c["base_url"] == "http://127.0.0.1:3425")
    if not key:
        sys.exit("channels.json 中 Magpie 通道没有 api_key")
    return key


def load_chunks() -> list[str]:
    con = sqlite3.connect(Path("~/.texlate/texlate.db").expanduser())
    rows = con.execute(
        "SELECT src_text FROM chunks WHERE task_id=? AND kind='para' AND length(src_text)>250"
        " ORDER BY seq LIMIT ?",
        (TASK, N_CHUNKS),
    ).fetchall()
    if len(rows) < N_CHUNKS:
        sys.exit(f"任务 {TASK} 的 para 块不足 {N_CHUNKS}")
    return [r[0] for r in rows]


async def one(client: httpx.AsyncClient, key: str, spec: str, system: str, user: str, chunks: list[str], rnd: int) -> dict:
    model, _, effort = spec.rpartition(":") if spec.count(":") and spec.rsplit(":", 1)[1] in {"none", "minimal", "low", "medium", "high"} else (spec, "", "")
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.2,
        "max_tokens": 16384,
    }
    if effort:
        body["reasoning_effort"] = effort
    t0 = time.monotonic()
    rec = {"spec": spec, "round": rnd}
    try:
        r = await client.post(GATEWAY, json=body, headers={"authorization": f"Bearer {key}"}, timeout=300)
    except httpx.HTTPError as e:
        rec.update(ok=False, err=f"{type(e).__name__}: {e}", s=round(time.monotonic() - t0, 1))
        return rec
    rec["s"] = round(time.monotonic() - t0, 1)
    if r.status_code != 200:
        rec.update(ok=False, err=f"HTTP {r.status_code}: {r.text[:200]}")
        return rec
    try:
        data = r.json()
    except json.JSONDecodeError:
        rec.update(ok=False, err=f"HTTP 200 non-JSON body: {r.text[:160]!r}")
        return rec
    msg = data["choices"][0]["message"]
    text = msg.get("content") or ""
    usage = data.get("usage") or {}
    parts = parse_batch_response(text, len(chunks))
    ph_ok = parts is not None and all(
        sorted(PH.findall(src)) == sorted(PH.findall(dst)) for src, dst in zip(chunks, parts)
    )
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿")
    rec.update(
        ok=True,
        served=data.get("model"),
        out=usage.get("completion_tokens"),
        reasoning=(usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
        parsed=parts is not None,
        placeholders_ok=ph_ok,
        cjk=cjk,
        sample=(parts[0][:80] if parts else text[:80]),
    )
    return rec


async def main() -> None:
    rounds = int(sys.argv[1])
    specs = sys.argv[2:]
    # 硬闸：OpenRouter 只许 :free 模型（不得动用账户余额）
    paid = [s for s in specs if s.startswith("openrouter/") and ":free" not in s]
    if paid:
        sys.exit(f"拒绝运行：OpenRouter 非免费模型 {paid}")
    key = load_key()
    chunks = load_chunks()
    system = build_system_prompt("para", batch=True)
    user = encode_batch(chunks)
    print(f"batch: {len(chunks)} chunks, {len(user)} chars")
    async with httpx.AsyncClient() as client:
        for rnd in range(rounds):
            res = await asyncio.gather(*(one(client, key, s, system, user, chunks, rnd) for s in specs))
            with OUT.open("a") as f:
                for rec in res:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    print(json.dumps(rec, ensure_ascii=False))


asyncio.run(main())
