"""Isolated browser tests for task actions; never calls a model or changes real tasks.

uv run --with playwright python -I tests/e2e/run_actions.py
"""
from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
from harness import HOST, SHIM, USERSCRIPT  # noqa: E402

PAPER = '2610.31668v2'
OTHER = '2601.00393v2'
HTML = '''<!doctype html><meta charset="utf-8"><title>alphaXiv action fixture</title>
<style>body{margin:16px}.toolbar{position:fixed;top:16px;right:80px}.page{height:800px;width:600px}</style>
<div class="toolbar"><button aria-label="Share paper">Share</button></div>
<div id="viewer"><div class="page"><div class="textLayer"><span>English paper</span></div></div></div>'''
PDF = b'%PDF-1.4\nfixture download\n%%EOF'


def snap(tid: str, status: str, created: int, paper: str = PAPER) -> dict:
    return {'task_id': tid, 'kind': 'arxiv', 'arxiv_id': paper, 'status': status,
            'progress': 100 if status == 'done' else 30, 'created_at': created,
            'updated_at': created, 'message': status, 'model': 'group/texlate-fast',
            'counters': {'total': 10, 'done': 10 if status == 'done' else 3, 'cached': 0, 'failed': 0, 'tokens': 0},
            'warnings': [], 'error': None,
            'artifacts': {k: f'/api/files/{tid}/{v}' for k, v in [('zh_pdf', 'zh.pdf'), ('bi_pdf', 'bi.pdf')]} if status == 'done' else {}}


class Service:
    def __init__(self):
        self.tasks = {'t_old': snap('t_old', 'done', 1)}
        self.latest = {PAPER: 't_old'}
        self.calls = []
        self.unsupported = False
        self.offline = False
        self.n = 0

    def request(self, method, url, data, response_type):
        if self.offline:
            raise RuntimeError('fixture service unavailable')
        path = unquote(urlsplit(url).path)
        self.calls.append((method, path, json.loads(data) if data else None))
        status, body = 200, {}
        if method == 'GET' and path.startswith('/api/arxivStatus/'):
            tid = self.latest.get(path.removeprefix('/api/arxivStatus/'))
            if tid:
                task = self.tasks[tid]
                body = {'task_id': tid, 'status': 'start' if task['status'] in ['queued', 'translating'] else 'finished', 'progress': task['progress']}
            else:
                status, body = 404, {'error': 'not_found'}
        elif method == 'GET' and path.startswith('/api/task/'):
            body = self.tasks[path.split('/')[3]]
        elif method == 'POST' and path.endswith('/retranslate'):
            if self.unsupported:
                status, body = 404, {'detail': 'Not Found'}
            else:
                self.n += 1
                tid = f't_new{self.n}'
                self.tasks[tid] = snap(tid, 'translating', self.n + 1)
                self.latest[PAPER] = tid
                status, body = 202, {'task_id': tid, 'status': 'queued'}
        elif method == 'POST' and path.endswith('/cancel'):
            tid = path.split('/')[3]
            self.tasks[tid]['status'] = 'cancelled'
            self.tasks[tid]['updated_at'] += 1
            body = {'task_id': tid, 'status': 'cancelled'}
        elif method == 'POST' and path.endswith('/retry'):
            tid = path.split('/')[3]
            self.tasks[tid]['status'] = 'translating'
            self.tasks[tid]['updated_at'] += 1
            status, body = 202, {'task_id': tid, 'status': 'queued'}
        elif method == 'GET' and path.startswith('/api/files/'):
            return {'status': 200, 'text': '', 'b64': base64.b64encode(PDF).decode()}
        else:
            raise RuntimeError(f'Unexpected fixture API request: {method} {path}')
        return {'status': status, 'text': json.dumps(copy.deepcopy(body)), 'b64': ''}

    def finish(self, tid):
        old = self.tasks[tid]
        self.tasks[tid] = snap(tid, 'done', old['created_at'])
        self.tasks[tid]['updated_at'] = old['updated_at'] + 10


def open_fixture(browser, service, width=1000):
    ctx = browser.new_context(viewport={'width': width, 'height': 800}, accept_downloads=True)
    ctx.expose_function('__gmxhr', service.request)
    ctx.add_init_script(SHIM + '\n' + USERSCRIPT.read_text())
    ctx.route('https://www.alphaxiv.org/**', lambda route: route.fulfill(body=HTML, content_type='text/html'))
    page = ctx.new_page()
    page.set_default_timeout(10000)
    page.errors = []
    page.on('pageerror', lambda err: page.errors.append(str(err)))
    page.goto(f'https://www.alphaxiv.org/pdf/{PAPER}')
    page.locator(HOST + ' .main').wait_for(state='visible')
    page.locator(HOST + ' .main').click()
    expect(page.locator(HOST + ' .task-status')).to_contain_text('已完成')
    expect(page.locator(HOST + ' [data-a=retranslate]')).to_be_enabled()
    return ctx, page


def button(page, action):
    return page.locator(f'{HOST} button[data-a={action}]')


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome')
        service = Service()
        ctx, page = open_fixture(browser, service)
        expect(page.locator(HOST + ' [data-a=details]')).to_have_attribute('href', 'http://127.0.0.1:8765/#/reader/t_old')
        for mode in ['zh', 'bi']:
            with page.expect_download() as event:
                button(page, f'download-{mode}').click()
            download = event.value
            assert download.suggested_filename == f'2610.31668-{mode}.pdf'
            assert Path(download.path()).read_bytes() == PDF
            if not page.locator(HOST + ' .menu').is_visible():
                page.locator(HOST + ' .main').click()
        print('PASS: downloads and task details')
        # Double dispatch must create one task, and the menu must remain available.
        page.locator(HOST + ' [data-a=retranslate]').evaluate('(b) => { b.click(); b.click(); }')
        expect(page.locator(HOST + ' .task-status')).to_contain_text('翻译中')
        assert len([c for c in service.calls if c[1].endswith('/retranslate')]) == 1
        assert service.tasks['t_old']['status'] == 'done'
        expect(button(page, 'retranslate')).to_be_disabled()
        expect(button(page, 'cancel')).to_be_visible()
        expect(page.locator(HOST + ' [data-a=details]')).to_have_attribute('href', 'http://127.0.0.1:8765/#/reader/t_new1')
        page.locator(HOST + ' .main').click()
        page.locator(HOST + ' .main').click()
        button(page, 'cancel').click()
        expect(page.locator(HOST + ' .task-status')).to_contain_text('已取消')
        expect(button(page, 'retry')).to_be_visible()
        button(page, 'retry').click()
        expect(page.locator(HOST + ' .task-status')).to_contain_text('翻译中')
        service.finish('t_new1')
        expect(page.locator(HOST + ' .task-status')).to_contain_text('已完成', timeout=15000)
        expect(button(page, 'download-zh')).to_be_enabled()
        assert service.n == 1
        assert not page.errors, page.errors
        print('PASS: retranslate, duplicate prevention, cancel, retry, progress, completion')
        ctx.close()

        service = Service()
        service.unsupported = True
        ctx, page = open_fixture(browser, service)
        button(page, 'retranslate').click()
        expect(page.locator(HOST + ' .task-error')).to_contain_text('请升级 TeXlate')
        assert service.n == 0
        assert not page.errors, page.errors
        print('PASS: unsupported server reports upgrade instead of fake retranslation')
        ctx.close()

        service = Service()
        ctx, page = open_fixture(browser, service, width=390)
        bounds = page.locator(HOST + ' .menu').bounding_box()
        assert bounds and bounds['x'] >= 16 and bounds['x'] + bounds['width'] <= 374
        button(page, 'retranslate').click()
        expect(page.locator(HOST + ' .task-status')).to_contain_text('翻译中')
        page.evaluate(f"history.pushState(null, '', '/pdf/{OTHER}')")
        expect(page.locator(HOST + ' .menu')).to_be_hidden()
        page.locator(HOST + ' .main').click()
        expect(page.locator(HOST + ' .task-status')).to_contain_text('尚未翻译')
        service.finish('t_new1')
        # Wait through one background task poll, then verify old completion did not touch the new paper.
        page.wait_for_timeout(3500)
        expect(page.locator(HOST + ' .task-status')).to_contain_text('尚未翻译')
        expect(page.locator(HOST + ' .tip')).to_be_hidden()
        assert not page.errors, page.errors
        print('PASS: narrow layout and navigation during retranslation')
        ctx.close()

        service = Service()
        ctx, page = open_fixture(browser, service)
        service.offline = True
        button(page, 'refresh').click()
        expect(page.locator(HOST + ' .task-error')).to_contain_text('无法连接 TeXlate')
        assert not page.errors, page.errors
        print('PASS: connection failure is visible without page errors')
        ctx.close()
        browser.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
