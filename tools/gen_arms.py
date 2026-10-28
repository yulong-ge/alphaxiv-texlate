"""用 TeXlate 产品翻译管线（XlatPipeline + GatewayTranslator + pair_feedback）
经 Magpie 让各候选模型翻译 bench 冻结样本，产出 qualbench manifest。

用法：uv run --project ~/code/texlate python -I gen_arms.py <out_dir> <label=model[:effort]>...
样本：~/code/texlate/bench/nominations/qualframe-live-v1.jsonl（3 篇 24 块）。
每臂输出 <out_dir>/<label>.jsonl（qualbench manifest 行）与 timing 汇总行（stdout）。
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from texlate.chunk import ChunkIn
from texlate.validate.rules import pair_feedback
from texlate.xlat.client import ChatClient
from texlate.xlat.pipeline import PipelineConfig, XlatPipeline
from texlate.xlat.pipeline.translator import GatewayTranslator

FRAME = Path("~/code/texlate/bench/nominations/qualframe-live-v1.jsonl").expanduser()
GATEWAY = "http://127.0.0.1:3425"
EFFORTS = {"none", "minimal", "low", "medium", "high"}


def load_key() -> str:
    # BENCH_CHANNELS 可指向带通用 Magpie 密钥的 channels.json（TeXlate 自用密钥有模型白名单）
    src = Path(os.environ.get("BENCH_CHANNELS") or "~/.texlate/channels.json").expanduser()
    chans = json.loads(src.read_text())["channels"]
    key = next(c["api_key"] for c in chans if c["base_url"] == GATEWAY)
    if not key:
        sys.exit("channels.json 中 Magpie 通道没有 api_key")
    return key


def split_spec(spec: str) -> tuple[str, str, str]:
    label, _, target = spec.partition("=")
    head, _, tail = target.rpartition(":")
    if head and tail in EFFORTS:
        return label, head, tail
    return label, target, ""


async def run_arm(key: str, rows: list[dict], label: str, model: str, effort: str, out_dir: Path) -> dict:
    calls = 0

    def sink(_rec: object) -> None:
        nonlocal calls
        calls += 1

    client = ChatClient(GATEWAY, key, usage_sink=sink)
    translator = GatewayTranslator(client, model, reasoning_effort=effort)
    pipe = XlatPipeline(
        translator,
        config=PipelineConfig(concurrency=8, warmup=False),
        validator=pair_feedback,
    )
    chunks = [ChunkIn(chunk_id=f"{r['paper']}#{r['chunk_id']}", content=r["src"], kind=r["kind"]) for r in rows]
    t0 = time.monotonic()
    results = await pipe.run(chunks)
    secs = round(time.monotonic() - t0, 1)
    await client.aclose()
    by_id = {r.chunk_id: r for r in results}
    statuses: dict[str, int] = {}
    with (out_dir / f"{label}.jsonl").open("w", encoding="utf-8") as f:
        for r in rows:
            res = by_id[f"{r['paper']}#{r['chunk_id']}"]
            statuses[res.status] = statuses.get(res.status, 0) + 1
            f.write(
                json.dumps(
                    {
                        "paper": r["paper"],
                        "chunk_id": r["chunk_id"],
                        "kind": r["kind"],
                        "model": label,
                        "src": r["src"],
                        "zh": res.translation,
                        "status": res.status,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    return {"arm": label, "model": model, "effort": effort, "seconds": secs, "calls": calls, "status": statuses}


async def main() -> None:
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(ln) for ln in FRAME.read_text(encoding="utf-8").splitlines() if ln.strip()]
    key = load_key()
    arms = [split_spec(s) for s in sys.argv[2:]]
    # 硬闸：OpenRouter 只许 :free 模型（不得动用账户余额）
    paid = [m for _, m, _ in arms if m.startswith("openrouter/") and not m.endswith(":free")]
    if paid:
        sys.exit(f"拒绝运行：OpenRouter 非免费模型 {paid}")
    async def one(lb: str, m: str, e: str) -> None:
        print(json.dumps(await run_arm(key, rows, lb, m, e, out_dir), ensure_ascii=False), flush=True)

    await asyncio.gather(*(one(lb, m, e) for lb, m, e in arms))


asyncio.run(main())
