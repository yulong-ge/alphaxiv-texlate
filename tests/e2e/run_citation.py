"""中文模式下 AI 侧边栏引用跳转：注入真实格式的 data-citation 按钮并点击，断言高亮落在对应译文段。

用法：uv run --with playwright --with pypdf python -I tests/e2e/run_citation.py <arxiv_id> [n] [out_dir]
前提：本机 TeXlate 已有该论文的中文 PDF；系统装有 Google Chrome。

引文取自 TeXlate 任务里的英文 PDF（en.pdf，即 arXiv 原 PDF）的抽取文字，保留断词连字符、
连字等 PDF 文字层原貌，与 alphaXiv AI 引用的 startText/endText 同源。判据：点击后出现高亮，
高亮区文字与期望段译文的汉字重合率 ≥ 0.6，且页面无整页刷新、无 pageerror。
"""

from __future__ import annotations

import io
import json
import random
import re
import sys
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).parent))
from harness import HOST, install, wait_switch_done  # noqa: E402

TEXLATE = "http://127.0.0.1:8765"
MIN_OVERLAP = 0.6


def get(path: str) -> bytes:
    with urllib.request.urlopen(TEXLATE + path, timeout=60) as r:
        return r.read()


def words(s: str) -> list[str]:
    return re.findall(r"[A-Za-z]{3,}", s)


def plain(latex: str) -> str:
    t = re.sub(r"\\(?:cite[a-zA-Z]*|[a-zA-Z]*ref|label)\*?(?:\[[^\]]*\])*\{[^}]*\}", " ", latex)
    t = re.sub(r"\$[^$]*\$", " ", t)
    return re.sub(r"\\[a-zA-Z@]+\*?", " ", t)


def pick_quotes(paper: str, n: int) -> tuple[str, list[dict]]:
    """从英文 PDF 文字里取 n 段引文：定位段落首 6 个词，截取原样文字作 startText/endText。"""
    files = json.loads(get(f"/api/arxivFiles/{paper}"))["data"]
    tid = files["zhCN"].split("/")[3]
    chunks = json.loads(get(f"/api/task/{tid}/chunks?limit=500"))["chunks"]
    pages = [p.extract_text() or "" for p in PdfReader(io.BytesIO(get(files["origin"]))).pages]
    cands = [c for c in chunks if c["kind"] == "para" and c["status"] == "ok" and len(words(plain(c["en"]))) > 40]
    random.Random(7).shuffle(cands)
    out = []
    for c in cands:
        ws = words(plain(c["en"]))
        hit = None
        for off in (0, 6, 12):  # 段首若有数学/特殊排版，换后面的 6 个词再找
            rx = re.compile(r"\W+".join(map(re.escape, ws[off : off + 6])))
            hit = next(((pno, m) for pno, txt in enumerate(pages, 1) if (m := rx.search(txt))), None)
            if hit:
                break
        if hit:
            pno, m = hit
            body = m.string[m.start() : m.start() + 400].replace("\n", " ")
            out.append({"seq": c["seq"], "zh": c["zh"], "page": pno, "start": body[:70], "end": body[180:240]})
        if len(out) == n:
            break
    if len(out) < n:
        raise SystemExit(f"只在英文 PDF 中定位到 {len(out)} 段可用引文（需要 {n}）")
    return tid, out


def cjk(s: str) -> set[str]:
    return {ch for ch in s if "一" <= ch <= "鿿"}


MARKED_TEXT = """() => {
  const marks = [...document.querySelectorAll('[data-texlate-cite]')];
  if (!marks.length) return null;
  const page = marks[0].closest('.page');
  const boxes = marks.map((m) => m.getBoundingClientRect());
  const spans = [...page.querySelectorAll('.textLayer span')].filter((s) => {
    const r = s.getBoundingClientRect();
    const cy = (r.top + r.bottom) / 2;
    return boxes.some((b) => cy >= b.top && cy <= b.bottom && r.right > b.left && r.left < b.right);
  });
  return { page: Number(page.dataset.pageNumber), marks: marks.length, text: spans.map((s) => s.textContent).join('') };
}"""


def main() -> int:
    paper = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    out = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    tid, quotes = pick_quotes(paper, n)
    print(f"task {tid}: {len(quotes)} quotes")
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        install(ctx)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:160]))
        page.goto(f"https://www.alphaxiv.org/pdf/{paper}")
        page.wait_for_selector(".page .textLayer span", timeout=90_000, state="attached")
        page.wait_for_timeout(2000)
        page.locator(HOST + " .main").click()
        page.locator(f"{HOST} .menu button[data-m=zh]").click()
        wait_switch_done(page)
        page.wait_for_timeout(2000)
        page.evaluate("window.__noReload = 1")
        for i, q in enumerate(quotes):
            cite = json.dumps([None, q["page"], q["start"], q["end"]])
            page.evaluate(
                """(c) => { document.querySelectorAll('[data-test-cite]').forEach((b) => b.remove());
                  const b = document.createElement('button'); b.dataset.testCite = '1';
                  b.setAttribute('data-citation', c); b.textContent = 'cite';
                  b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647';
                  document.body.appendChild(b); }""",
                cite,
            )
            page.locator("[data-test-cite]").click()
            try:
                page.wait_for_selector("[data-texlate-cite]", timeout=20_000, state="attached")
            except Exception:  # noqa: BLE001 - 记失败并附提示框文字，继续下一条
                tip = page.locator(HOST + " .tip").inner_text()
                failures.append(f"seq {q['seq']}: 无高亮（提示：{tip!r}）")
                continue
            page.wait_for_timeout(1500)
            got = page.evaluate(MARKED_TEXT)
            want = cjk(q["zh"])
            have = cjk(got["text"])
            overlap = len(have & want) / max(1, len(have))
            print(f"seq {q['seq']}: en p{q['page']} → zh p{got['page']} marks={got['marks']} overlap={overlap:.2f}")
            print(f"   start={q['start'][:60]!r}")
            if overlap < MIN_OVERLAP:
                failures.append(f"seq {q['seq']}: 高亮文字与期望译文重合率 {overlap:.2f}：{got['text'][:80]!r}")
            if out:
                page.screenshot(path=str(out / f"cite_{i}_seq{q['seq']}.png"))
        if not page.evaluate("window.__noReload === 1"):
            failures.append("页面被整页刷新")
        if errors:
            failures.append(f"pageerror: {errors}")
        browser.close()
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
