"""Playwright 注入油猴脚本的公共件：GM API 垫片（经 Python 转发到本机 TeXlate）与页面观测。

真实 Tampermonkey 的 GM_xmlhttpRequest 跑在扩展后台；这里用 expose_function 把请求交给
Python 发出，等价于「无 Origin 的本地客户端」——与 Tampermonkey 删除 Origin 头的行为一致
（该一致性本身未在真实浏览器验证，见 README「未验证」）。
"""

from __future__ import annotations

import base64
import urllib.error
import urllib.request
from pathlib import Path

USERSCRIPT = Path(__file__).resolve().parents[2] / "userscript" / "alphaxiv-texlate.user.js"
HOST = "span[data-texlate]"
FRESH_TEXT = ".paperBody .page:not([data-texlate-stale]) .textLayer span"

SHIM = r"""
(() => {
  const P = '__gm:';
  window.unsafeWindow = window;
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(P + k); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(P + k, JSON.stringify(v));
  window.GM_xmlhttpRequest = (o) => {
    window.__gmxhr(o.method, o.url, o.data || null, o.responseType || 'text').then((r) => {
      let response = r.text;
      if (o.responseType === 'arraybuffer') {
        const bin = atob(r.b64); const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        response = u.buffer;
      }
      o.onload({ status: r.status, responseText: r.text, response });
    }, () => o.onerror());
  };
})();
"""


def gmxhr(method: str, url: str, data: str | None, response_type: str) -> dict:
    req = urllib.request.Request(
        url,
        method=method,
        data=data.encode() if data else None,
        headers={"content-type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            status, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read()
    if response_type == "arraybuffer":
        return {"status": status, "text": "", "b64": base64.b64encode(body).decode()}
    return {"status": status, "text": body.decode("utf-8", "replace")}


def install(ctx) -> None:
    """给 BrowserContext 装 GM 垫片与油猴脚本（每个新页面 document-start 注入）。"""
    ctx.expose_function("__gmxhr", gmxhr)
    ctx.add_init_script(SHIM + "\n" + USERSCRIPT.read_text(encoding="utf-8"))


def has_cjk(s: str) -> bool:
    return any("一" <= ch <= "鿿" for ch in s)


def wait_switch_done(page, timeout_ms: int = 600_000) -> None:
    """等工具栏按钮恢复可点（busy 结束 = 翻译/生成/热切换整条链路完成）。"""
    page.wait_for_timeout(500)
    page.wait_for_function(
        f"() => {{ const h = document.querySelector('{HOST}'); "
        "return h && !h.shadowRoot.querySelector('.main').disabled; }",
        timeout=timeout_ms,
    )


def visible_text(page, limit: int = 4000) -> str:
    return page.eval_on_selector_all(
        ".page:not([data-texlate-stale]) .textLayer span",
        "els => els.map(e => e.textContent).join('')",
    )[:limit]
