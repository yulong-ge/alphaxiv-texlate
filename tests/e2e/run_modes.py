"""真实 alphaXiv 页面上依次热切换 双 → 中 → EN，断言不整页刷新、内容语言正确、无 pageerror。

用法：uv run --with playwright python -I tests/e2e/run_modes.py <arxiv_id> [out_dir]
前提：本机 TeXlate 服务在 127.0.0.1:8765；系统装有 Google Chrome。
未翻译的论文会在此过程中被真实翻译（耗模型额度与时间）。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from harness import HOST, PDF_PAGE, PDF_TEXT, has_cjk, install, visible_text, wait_switch_done  # noqa: E402

EXPECT_CJK = {"bi": True, "zh": True, "en": False}

# 切换前塞一条假的引用预览缓存与假高亮（模拟上一模式下悬停/点击过引用），切换后两者都必须被清掉；
# 否则 alphaXiv 会按上一个 PDF 的页码与坐标跳转（2026-10-29 用户实测）。
CITE_STATE = """async (seed) => {
  const urls = [...performance.getEntriesByType('resource').map((e) => e.name),
    ...[...document.querySelectorAll('link[rel=modulepreload], script[src]')].map((l) => l.href || l.src)];
  const mod = async (prefix) => {
    const url = urls.find((x) => new URL(x, location.href).pathname.startsWith('/assets/' + prefix));
    return url ? import(url) : null;
  };
  const apiMod = await mod('api-typed-');
  const userMod = await mod('user-');
  const api = [userMod, apiMod].filter(Boolean).flatMap((m) => Object.values(m));
  const qc = api.filter((v) => typeof v === 'function' && v.length === 0 && /^\\(\\)=>[\\w$]+\\?\\?=[\\w$]+\\(\\)$/.test(String(v)))
    .map((f) => f()).find((c) => c && typeof c.removeQueries === 'function');
  const storeMod = await mod('bind-mutations-');
  const store = [storeMod, apiMod].filter(Boolean).flatMap((m) => Object.values(m))
    .find((v) => v && v.get && v.set && v.sub);
  const atomMod = (await mod('pdf.atoms-')) || (await mod('pdfjs-enums-'));
  const atomGroup = atomMod && Object.values(atomMod).find(
    (v) => v && typeof v === 'object' && 'pdfError' in v && 'pdfViewer' in v && 'loadedCanonicalId' in v,
  );
  const citationMod = await mod('paper-citation.atoms-');
  const atoms = [
    ...['citationPreview', 'currentSelection', 'activeAnchor', 'activeFocus']
      .filter((k) => atomGroup && k in atomGroup).map((k) => atomGroup[k]),
    ...(citationMod ? Object.values(citationMod) : []),
  ];
  const key = ['overview-citation-preview', { canonicalId: 'texlate-test', page: 1, startText: 'a', endText: 'b' }];
  if (seed) {
    qc.setQueryData(key, { stale: true });
    if (atoms[0]) store.set(atoms[0], { pageIndex: 0, rects: [{ x1: 0, y1: 0, x2: 1, y2: 1 }] });
  }
  const hl = atoms.some((a) => {
    const v = store.get(a);
    return v && typeof v === 'object' && ('rects' in v || 'pageIndex' in v);
  });
  return { cached: qc.getQueryData(key) !== undefined, highlight: hl };
}"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paper")
    parser.add_argument("out", nargs="?", type=Path)
    parser.add_argument("--modes", nargs="+", choices=tuple(EXPECT_CJK), default=["bi", "zh", "en"])
    args = parser.parse_args()
    paper, out = args.paper, args.out
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        install(ctx)
        page = ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)[:120]))
        page.goto(f"https://www.alphaxiv.org/pdf/{paper}")
        page.wait_for_selector(PDF_TEXT, timeout=90_000, state="attached")
        page.wait_for_timeout(2000)
        page.evaluate("window.__noReload = 1")
        for mode in args.modes:
            seeded = page.evaluate(CITE_STATE, True)
            if not (seeded["cached"] and seeded["highlight"]):
                failures.append(f"{mode}: 无法预置引用缓存/高亮（{seeded}）")
            page.locator(HOST + " .main").click()
            page.locator(f"{HOST} .menu button[data-m={mode}]").click()
            wait_switch_done(page)
            page.wait_for_timeout(2500)
            txt = visible_text(page)
            pages = page.locator(PDF_PAGE).count()
            no_reload = page.evaluate("window.__noReload === 1")
            tip = page.locator(HOST + " .tip").inner_text()
            print(f"{mode}: pages={pages} cjk={has_cjk(txt)} noReload={no_reload} tip={tip!r}")
            left = page.evaluate(CITE_STATE, False)
            print(f"   citation state after switch: {left}")
            if left["cached"] or left["highlight"]:
                failures.append(f"{mode}: 切换后旧引用缓存/高亮未清除（{left}）")
            if not no_reload:
                failures.append(f"{mode}: 页面被整页刷新")
            if has_cjk(txt) != EXPECT_CJK[mode]:
                failures.append(f"{mode}: 文字层语言不符（cjk={has_cjk(txt)}）")
            if out:
                page.screenshot(path=str(out / f"mode_{mode}.png"))
        # 注入一次桥接失败，验证失败不写模式，且下一次点击可以正常恢复。
        saved = page.evaluate("GM_getValue('mode:' + location.pathname.split('/').pop().replace(/v\\d+$/, ''), 'en')")
        target = "en" if saved == "zh" else "zh"
        page.evaluate("""() => {
          window.__testReload = window.__texlateReloadPdf;
          window.__texlateReloadPdf = async () => { throw new Error('injected reload failure'); };
        }""")
        page.locator(HOST + " .main").click()
        page.locator(f"{HOST} .menu button[data-m={target}]").click()
        wait_switch_done(page)
        after = page.evaluate("GM_getValue('mode:' + location.pathname.split('/').pop().replace(/v\\d+$/, ''), 'en')")
        tip = page.locator(HOST + " .tip").inner_text()
        if after != saved or "injected reload failure" not in tip:
            failures.append(f"切换失败污染模式: before={saved} after={after} tip={tip}")
        page.evaluate("window.__texlateReloadPdf = window.__testReload")
        page.locator(HOST + " .main").click()
        page.locator(f"{HOST} .menu button[data-m={target}]").click()
        wait_switch_done(page)
        if has_cjk(visible_text(page)) != EXPECT_CJK[target]:
            failures.append("失败后的重试未能恢复切换")
        print(f"failure recovery: persisted={saved} -> {after}, retry={target}, tip={tip!r}")
        if errors:
            failures.append(f"pageerror: {errors}")
        browser.close()
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
