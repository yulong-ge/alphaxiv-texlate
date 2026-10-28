"""真实 alphaXiv 页面上依次热切换 双 → 中 → EN，断言不整页刷新、内容语言正确、无 pageerror。

用法：uv run --with playwright python -I tests/e2e/run_modes.py <arxiv_id> [out_dir]
前提：本机 TeXlate 服务在 127.0.0.1:8765；系统装有 Google Chrome。
未翻译的论文会在此过程中被真实翻译（耗模型额度与时间）。
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from harness import HOST, has_cjk, install, visible_text, wait_switch_done  # noqa: E402

EXPECT_CJK = {"bi": True, "zh": True, "en": False}


def main() -> int:
    paper = sys.argv[1]
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        install(ctx)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:120]))
        page.goto(f"https://www.alphaxiv.org/pdf/{paper}")
        page.wait_for_selector(".page .textLayer span", timeout=90_000, state="attached")
        page.wait_for_timeout(2000)
        page.evaluate("window.__noReload = 1")
        for mode in ("bi", "zh", "en"):
            page.locator(HOST + " .main").click()
            page.locator(f"{HOST} .menu button[data-m={mode}]").click()
            wait_switch_done(page)
            page.wait_for_timeout(2500)
            txt = visible_text(page)
            pages = page.locator(".paperBody .page").count()
            no_reload = page.evaluate("window.__noReload === 1")
            tip = page.locator(HOST + " .tip").inner_text()
            print(f"{mode}: pages={pages} cjk={has_cjk(txt)} noReload={no_reload} tip={tip!r}")
            if not no_reload:
                failures.append(f"{mode}: 页面被整页刷新")
            if has_cjk(txt) != EXPECT_CJK[mode]:
                failures.append(f"{mode}: 文字层语言不符（cjk={has_cjk(txt)}）")
            if out:
                page.screenshot(path=str(out / f"mode_{mode}.png"))
        if errors:
            failures.append(f"pageerror: {errors}")
        browser.close()
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
