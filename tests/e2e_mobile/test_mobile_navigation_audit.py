from __future__ import annotations

import json
import os
import time
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pytest

from app.db import get_session
from app.models import Deck, DeckWord, Simulation, SrsCard, SrsReviewLog, Word, Worksheet
from .helpers.live_server import run_live_server

if os.environ.get("RUN_E2E_MOBILE", "0") != "1":
    pytest.skip("set RUN_E2E_MOBILE=1 to run mobile e2e audit", allow_module_level=True)

playwright_sync = pytest.importorskip("playwright.sync_api")
sync_playwright = playwright_sync.sync_playwright
PlaywrightTimeoutError = playwright_sync.TimeoutError


VIEWPORTS = [1280, 1024, 768, 640, 414, 390, 375, 360]
PAGE_MATRIX = [
    {"path": "/auth/login", "mode": "self"},
    {"path": "/auth/register", "mode": "self"},
    {"path": "/", "mode": "self"},
    {"path": "/review", "mode": "self"},
    {"path": "/mistakes", "mode": "self"},
    {"path": "/worksheets", "mode": "parent"},
    {"path": "/worksheets/{worksheet_id}", "mode": "parent"},
    {"path": "/settings", "mode": "self"},
    {"path": "/decks", "mode": "self"},
    {"path": "/words", "mode": "self"},
    {"path": "/simulations", "mode": "self"},
    {"path": "/dashboard", "mode": "self"},
    {"path": "/analytics", "mode": "self"},
]


@dataclass
class SeedData:
    worksheet_id: int


def _resolve_page_matrix(seed: SeedData | None) -> list[dict[str, str]]:
    matrix: list[dict[str, str]] = []
    worksheet_id_env = str(os.environ.get("E2E_WORKSHEET_ID", "")).strip()
    worksheet_id = 0
    if seed is not None:
        worksheet_id = int(seed.worksheet_id)
    elif worksheet_id_env.isdigit():
        worksheet_id = int(worksheet_id_env)
    for spec in PAGE_MATRIX:
        path = str(spec["path"])
        if "{worksheet_id}" in path and worksheet_id <= 0:
            continue
        matrix.append(
            {
                "path": path.format(worksheet_id=worksheet_id),
                "mode": str(spec.get("mode") or "self"),
            }
        )
    return matrix


def _resolve_viewports() -> list[int]:
    raw = str(os.environ.get("E2E_VIEWPORTS", "")).strip()
    if not raw:
        return VIEWPORTS
    out: list[int] = []
    for p in raw.split(","):
        p2 = p.strip()
        if not p2:
            continue
        try:
            n = int(p2)
        except Exception:
            continue
        if n >= 240 and n <= 2000:
            out.append(n)
    return out or VIEWPORTS


def _path_from_url(url: str) -> str:
    parsed = urlparse(url)
    return f"{parsed.path}{f'?{parsed.query}' if parsed.query else ''}"


def _seed_data() -> SeedData:
    now = int(time.time())
    with get_session() as session:
        w1 = Word(term=f"audit_alpha_{now}", definition="示例词义 alpha", example="alpha example")
        w2 = Word(term=f"audit_beta_{now}", definition="示例词义 beta", example="beta example")
        session.add_all([w1, w2])
        session.flush()

        deck = Deck(name=f"audit_deck_{now}", description="e2e")
        session.add(deck)
        session.flush()
        session.add_all(
            [
                DeckWord(deck_id=int(deck.id), word_id=int(w1.id), chapter="1", position=1),
                DeckWord(deck_id=int(deck.id), word_id=int(w2.id), chapter="1", position=2),
            ]
        )

        session.add_all(
            [
                SrsCard(word_id=int(w1.id)),
                SrsCard(word_id=int(w2.id)),
                SrsReviewLog(word_id=int(w1.id), rating=3, reviewed_at=datetime.now(UTC), duration_ms=900),
            ]
        )

        session.add(
            Simulation(
                level="cet4",
                target_terms_json=json.dumps([w1.term, w2.term], ensure_ascii=False),
                passage="audit passage",
                questions_json=json.dumps({"questions": []}, ensure_ascii=False),
            )
        )

        sheet = {
            "version": 1,
            "stage": "junior",
            "question_types": ["spelling", "mcq"],
            "warnings": [],
            "words": [
                {
                    "word_id": int(w1.id),
                    "term": w1.term,
                    "definition_short": "示例词义 alpha",
                    "example": w1.example,
                },
                {
                    "word_id": int(w2.id),
                    "term": w2.term,
                    "definition_short": "示例词义 beta",
                    "example": w2.example,
                },
            ],
            "mcq": [
                {"stem": w1.term, "choices": ["示例词义 alpha", "干扰项1", "干扰项2", "干扰项3"]},
                {"stem": w2.term, "choices": ["示例词义 beta", "干扰项1", "干扰项2", "干扰项3"]},
            ],
            "cloze": [],
            "reading": {},
            "answers": {"mcq": ["A", "A"]},
        }
        ws = Worksheet(
            title=f"审计作业 {now}",
            mode="today",
            stage="junior",
            word_ids_json=json.dumps([int(w1.id), int(w2.id)], ensure_ascii=False),
            sheet_json=json.dumps(sheet, ensure_ascii=False),
            meta_json=json.dumps({}, ensure_ascii=False),
        )
        session.add(ws)
        session.flush()
        worksheet_id = int(ws.id)

    return SeedData(worksheet_id=worksheet_id)


def _set_mode_cookie(context, base_url: str, mode: str) -> None:
    parsed = urlparse(base_url)
    context.add_cookies(
        [
            {
                "name": "vs_mode",
                "value": "parent" if mode == "parent" else "self",
                "domain": parsed.hostname or "127.0.0.1",
                "path": "/",
                "sameSite": "Lax",
            }
        ]
    )


def _context_kwargs(viewport_w: int) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"viewport": {"width": viewport_w, "height": 844}}
    auth_raw = str(os.environ.get("E2E_HTTP_AUTH", "")).strip()
    if ":" in auth_raw:
        u, p = auth_raw.split(":", 1)
        kwargs["http_credentials"] = {"username": u, "password": p}
    headers_raw = str(os.environ.get("E2E_EXTRA_HEADERS_JSON", "")).strip()
    if headers_raw:
        try:
            headers = json.loads(headers_raw)
            if isinstance(headers, dict):
                kwargs["extra_http_headers"] = {str(k): str(v) for k, v in headers.items()}
        except Exception:
            pass
    return kwargs


def _collect_targets(page, *, max_clicks: int) -> list[dict[str, Any]]:
    script = """
    (maxClicks) => {
      const sel = 'a[href],button,[role="button"],input[type="submit"],input[type="button"]';
      const nodes = Array.from(document.querySelectorAll(sel));
      const visible = (el) => {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const out = [];
      let idx = 0;
      for (const n of nodes) {
        if (!visible(n)) continue;
        if (n.disabled) continue;
        n.setAttribute('data-audit-click-idx', String(idx));
        out.push({
          idx,
          tag: (n.tagName || '').toLowerCase(),
          text: String((n.innerText || n.value || n.getAttribute('aria-label') || n.getAttribute('title') || '').trim()).slice(0, 80),
          href: String(n.getAttribute('href') || ''),
        });
        idx += 1;
        if (out.length >= maxClicks) break;
      }
      return out;
    }
    """
    return list(page.evaluate(script, max_clicks) or [])


def _measure_overflow(page) -> dict[str, Any]:
    script = """
    () => {
      const root = document.documentElement;
      const viewport = root.clientWidth || window.innerWidth || 0;
      const scrollW = root.scrollWidth || 0;
      const overflowPx = Math.max(0, scrollW - viewport);
      const offenders = [];
      const nodes = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
      for (const el of nodes) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const exceed = r.right - viewport;
        if (exceed > 1) {
          const label = el.getAttribute('data-audit-id') || el.getAttribute('data-guide-anchor') || el.id || el.className || el.tagName;
          offenders.push({ label: String(label || '').slice(0, 120), exceed: Math.round(exceed * 100) / 100 });
          if (offenders.length >= 12) break;
        }
      }
      const content = document.querySelector('#content .container');
      const textLen = content ? String(content.innerText || '').replace(/\\s+/g, '').length : 0;
      const interactives = content ? content.querySelectorAll('a[href],button,input[type="submit"],input[type="button"]').length : 0;
      return { viewport, scrollW, overflowPx, offenders, textLen, interactives };
    }
    """
    return dict(page.evaluate(script) or {})


def _write_audit_markdown(report_path: Path, findings: list[dict[str, Any]]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    p0 = [x for x in findings if x.get("severity") == "P0"]
    p1 = [x for x in findings if x.get("severity") == "P1"]
    base_url = str(os.environ.get("E2E_BASE_URL", "")).strip() or "local_test_server"

    lines = [
        "# 全站导航与移动端横滑审计（自动巡检）",
        "",
        f"- 目标基址：{base_url}",
        f"- 生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 总问题数：{len(findings)}",
        f"- P0：{len(p0)}",
        f"- P1：{len(p1)}",
        "",
        "## 问题清单",
        "",
        "| 严重度 | 类型 | 视口 | 页面 | 目标 | 详情 |",
        "|---|---|---:|---|---|---|",
    ]
    for item in findings[:300]:
        lines.append(
            "| {sev} | {typ} | {vp} | `{path}` | `{target}` | {detail} |".format(
                sev=item.get("severity", "P1"),
                typ=item.get("type", ""),
                vp=item.get("viewport", ""),
                path=item.get("page", ""),
                target=(item.get("target") or "")[:60].replace("|", "/"),
                detail=(item.get("detail") or "")[:140].replace("|", "/"),
            )
        )

    lines.extend(
        [
            "",
            "## 运行方式",
            "",
            "- 手工巡检：`RUN_E2E_MOBILE=1 pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`",
            "- 严格门禁：`RUN_E2E_MOBILE=1 E2E_STRICT=1 pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`",
            "- 线上基址：`RUN_E2E_MOBILE=1 E2E_BASE_URL=https://yuookie.qzz.io pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`",
            "- 线上带认证：`RUN_E2E_MOBILE=1 E2E_BASE_URL=https://yuookie.qzz.io E2E_HTTP_AUTH=user:pass pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q`",
            "",
            "## CI 门禁",
            "",
            "- PR Smoke：`.github/workflows/mobile-audit-smoke.yml`",
            "- Nightly 全量：`.github/workflows/mobile-audit-nightly.yml`",
        ]
    )

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_mobile_navigation_and_overflow_audit(main_module):
    external_base = str(os.environ.get("E2E_BASE_URL", "")).strip().rstrip("/")
    seed = None if external_base else _seed_data()
    page_matrix = _resolve_page_matrix(seed)
    max_clicks = max(4, int(os.environ.get("E2E_MAX_CLICKS", "12")))
    strict_mode = os.environ.get("E2E_STRICT", "0") == "1"
    page_timeout_ms = max(2000, int(os.environ.get("E2E_PAGE_TIMEOUT_MS", "12000")))
    idle_timeout_ms = max(600, int(os.environ.get("E2E_IDLE_TIMEOUT_MS", "1800")))
    viewports = _resolve_viewports()
    findings: list[dict[str, Any]] = []

    base_ctx = nullcontext(external_base) if external_base else run_live_server(main_module.app)
    with base_ctx as base_url:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                for viewport_w in viewports:
                    for spec in page_matrix:
                        path = str(spec["path"])
                        mode = str(spec.get("mode") or "self")
                        context = browser.new_context(**_context_kwargs(viewport_w))
                        _set_mode_cookie(context, base_url, mode)
                        page = context.new_page()
                        url = f"{base_url}{path}"

                        try:
                            resp = page.goto(url, wait_until="domcontentloaded", timeout=page_timeout_ms)
                        except PlaywrightTimeoutError:
                            findings.append(
                                {
                                    "severity": "P1",
                                    "type": "http_timeout",
                                    "viewport": viewport_w,
                                    "page": path,
                                    "target": "page_root",
                                    "detail": f"timeout={page_timeout_ms}ms",
                                }
                            )
                            context.close()
                            continue
                        try:
                            page.wait_for_load_state("networkidle", timeout=idle_timeout_ms)
                        except PlaywrightTimeoutError:
                            pass
                        status = int(resp.status) if resp is not None else 0
                        if status >= 400:
                            findings.append(
                                {
                                    "severity": "P1",
                                    "type": "http_error",
                                    "viewport": viewport_w,
                                    "page": path,
                                    "target": "page_root",
                                    "detail": f"status={status}",
                                }
                            )
                            context.close()
                            continue

                        base_overflow = _measure_overflow(page)
                        if float(base_overflow.get("overflowPx", 0)) > 1:
                            findings.append(
                                {
                                    "severity": "P0",
                                    "type": "horizontal_overflow",
                                    "viewport": viewport_w,
                                    "page": path,
                                    "target": "page_root",
                                    "detail": f"overflow={base_overflow.get('overflowPx')} offenders={base_overflow.get('offenders')}",
                                }
                            )

                        targets = _collect_targets(page, max_clicks=max_clicks)
                        for t in targets:
                            try:
                                resp_click = page.goto(url, wait_until="domcontentloaded", timeout=page_timeout_ms)
                            except PlaywrightTimeoutError:
                                findings.append(
                                    {
                                        "severity": "P1",
                                        "type": "http_timeout",
                                        "viewport": viewport_w,
                                        "page": path,
                                        "target": t.get("text") or t.get("tag") or "unknown",
                                        "detail": f"timeout={page_timeout_ms}ms",
                                    }
                                )
                                break
                            try:
                                page.wait_for_load_state("networkidle", timeout=idle_timeout_ms)
                            except PlaywrightTimeoutError:
                                pass
                            status_click = int(resp_click.status) if resp_click is not None else 0
                            if status_click >= 400:
                                findings.append(
                                    {
                                        "severity": "P1",
                                        "type": "http_error",
                                        "viewport": viewport_w,
                                        "page": path,
                                        "target": t.get("text") or t.get("tag") or "unknown",
                                        "detail": f"status={status_click}",
                                    }
                                )
                            _collect_targets(page, max_clicks=max_clicks)

                            before = _path_from_url(page.url)
                            nav_paths: list[str] = []

                            def _on_nav(frame):
                                if frame == page.main_frame:
                                    nav_paths.append(_path_from_url(frame.url))

                            page.on("framenavigated", _on_nav)
                            t0 = time.perf_counter()
                            click_ok = True
                            click_error = ""
                            locator = page.locator(f'[data-audit-click-idx="{int(t["idx"])}"]').first
                            try:
                                locator.click(timeout=2000)
                            except Exception as ex:  # pragma: no cover - runtime-only branch
                                click_ok = False
                                click_error = str(ex)

                            try:
                                page.wait_for_load_state("networkidle", timeout=idle_timeout_ms)
                            except PlaywrightTimeoutError:
                                pass
                            page.wait_for_timeout(260)
                            elapsed_ms = int((time.perf_counter() - t0) * 1000)
                            after = _path_from_url(page.url)
                            page.remove_listener("framenavigated", _on_nav)

                            if click_ok and elapsed_ms > 5000:
                                findings.append(
                                    {
                                        "severity": "P1",
                                        "type": "slow_navigation",
                                        "viewport": viewport_w,
                                        "page": path,
                                        "target": t.get("text") or t.get("tag") or "unknown",
                                        "detail": f"{elapsed_ms}ms",
                                    }
                                )

                            if click_ok:
                                bounced = before in nav_paths[1:] and any(p != before for p in nav_paths)
                                unexpected_return = (after == before) and any(p != before for p in nav_paths)
                                chain_redirect = len([p for p in nav_paths if p != before]) >= 2
                                if bounced:
                                    findings.append(
                                        {
                                            "severity": "P0",
                                            "type": "bounce_back",
                                            "viewport": viewport_w,
                                            "page": path,
                                            "target": t.get("text") or t.get("tag") or "unknown",
                                            "detail": f"{before} -> {nav_paths} -> {after}",
                                        }
                                    )
                                if unexpected_return:
                                    findings.append(
                                        {
                                            "severity": "P0",
                                            "type": "unexpected_return",
                                            "viewport": viewport_w,
                                            "page": path,
                                            "target": t.get("text") or t.get("tag") or "unknown",
                                            "detail": f"{before} -> {nav_paths} -> {after}",
                                        }
                                    )
                                if chain_redirect:
                                    findings.append(
                                        {
                                            "severity": "P0",
                                            "type": "chain_redirect",
                                            "viewport": viewport_w,
                                            "page": path,
                                            "target": t.get("text") or t.get("tag") or "unknown",
                                            "detail": f"nav={nav_paths}",
                                        }
                                    )

                                post_overflow = _measure_overflow(page)
                                if float(post_overflow.get("overflowPx", 0)) > 1:
                                    findings.append(
                                        {
                                            "severity": "P0",
                                            "type": "horizontal_overflow",
                                            "viewport": viewport_w,
                                            "page": after or path,
                                            "target": t.get("text") or t.get("tag") or "unknown",
                                            "detail": f"overflow={post_overflow.get('overflowPx')} offenders={post_overflow.get('offenders')}",
                                        }
                                    )

                                if (after != before) and int(post_overflow.get("textLen", 0)) < 8 and int(post_overflow.get("interactives", 0)) == 0:
                                    findings.append(
                                        {
                                            "severity": "P0",
                                            "type": "ghost_transition",
                                            "viewport": viewport_w,
                                            "page": after or path,
                                            "target": t.get("text") or t.get("tag") or "unknown",
                                            "detail": f"after={after}, nav={nav_paths}",
                                        }
                                    )
                            elif click_error:
                                findings.append(
                                    {
                                        "severity": "P1",
                                        "type": "click_error",
                                        "viewport": viewport_w,
                                        "page": path,
                                        "target": t.get("text") or t.get("tag") or "unknown",
                                        "detail": click_error[:200],
                                    }
                                )

                        context.close()
            finally:
                browser.close()

    report_file = Path("docs/UI_NAV_AUDIT_2026-02-06.md")
    _write_audit_markdown(report_file, findings)

    p0 = [x for x in findings if x.get("severity") == "P0"]
    if strict_mode:
        assert not p0, f"found P0 issues: {p0[:5]}"
