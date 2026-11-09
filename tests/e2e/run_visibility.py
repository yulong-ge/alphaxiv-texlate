"""Verify that the PDF mode control stays out of abstract pages during SPA navigation.

Usage: uv run --with playwright python -I tests/e2e/run_visibility.py [arxiv_id]
No translation is requested; the reader stays in its default English mode.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from harness import HOST, PDF_TEXT, install


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paper", nargs="?", default="2510.07550")
    args = parser.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        install(ctx)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(f"https://www.alphaxiv.org/abs/{args.paper}")
        expect(page.locator(f'a[href="/pdf/{args.paper}"]').first).to_be_visible(
            timeout=90_000
        )
        page.wait_for_timeout(1200)
        expect(page.locator(HOST)).to_be_hidden()
        print("direct abstract: PDF mode control hidden")

        page.evaluate("window.__visibilityNavigation = true")
        page.locator(f'a[href="/pdf/{args.paper}"]').first.click()
        page.wait_for_selector(PDF_TEXT, timeout=90_000)
        expect(page.locator(HOST)).to_be_visible(timeout=10_000)
        page.locator(HOST + " .main").click()
        expect(page.locator(HOST + " .menu")).to_be_visible()
        print("PDF: mode control and menu visible")

        page.locator(f'a[href="/abs/{args.paper}"]').click()
        page.wait_for_url(f"**/abs/{args.paper}")
        page.wait_for_timeout(1200)
        expect(page.locator(HOST)).to_be_hidden()
        expect(page.locator(HOST + " .menu")).to_be_hidden()
        assert page.evaluate("window.__visibilityNavigation === true"), (
            "Navigation reloaded the page"
        )
        print("PDF → abstract: mode control and menu hidden without reload")

        page.locator(f'a[href="/pdf/{args.paper}"]').first.click()
        page.wait_for_selector(PDF_TEXT, timeout=90_000)
        expect(page.locator(HOST)).to_be_visible(timeout=10_000)
        expect(page.locator(HOST + " .menu")).to_be_hidden()
        assert not errors, errors
        print("abstract → PDF: mode control restored, menu closed, no page errors")
        browser.close()


if __name__ == "__main__":
    main()
