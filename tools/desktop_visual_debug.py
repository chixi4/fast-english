from __future__ import annotations

import argparse
import json
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from playwright.sync_api import BrowserContext, Error as PlaywrightError, Page, sync_playwright

SLOW_REQUEST_MS = 1500
MAX_TIMELINE = 200
DEFAULT_DEVICE = "Pixel 7"


INIT_SCRIPT = r"""
(() => {
  if (window.__vsDebugInstalled) return;
  window.__vsDebugInstalled = true;

  const emit = (type, payload = {}) => {
    try {
      if (typeof window.__vsDebugEmit === 'function') {
        window.__vsDebugEmit({ type, ...payload, ts_client_ms: Date.now() });
      }
    } catch {}
  };

  const cssPath = (node) => {
    if (!(node instanceof Element)) return '';
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += '#' + CSS.escape(cur.id);
        parts.unshift(part);
        break;
      }
      const classList = Array.from(cur.classList || []).slice(0, 2).map((n) => CSS.escape(n));
      if (classList.length) part += '.' + classList.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((el) => el.tagName === cur.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const shortText = (node) => {
    if (!(node instanceof Element)) return '';
    const txt = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    return txt.slice(0, 220);
  };

  const currentPath = () => `${location.pathname || '/'}${location.search || ''}`;

  let panel = null;
  let selectedTarget = null;

  const ensurePanel = () => {
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'vs-debug-note-panel';
    panel.style.cssText = [
      'position:fixed',
      'right:12px',
      'bottom:12px',
      'width:min(420px, calc(100vw - 24px))',
      'max-height:70vh',
      'z-index:2147483646',
      'background:#111827',
      'color:#e5e7eb',
      'border:1px solid #374151',
      'border-radius:8px',
      'box-shadow:0 12px 30px rgba(0,0,0,.4)',
      'padding:10px',
      'font:13px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
      'display:none'
    ].join(';');

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <div style="font-weight:600;">可视化注释</div>
        <button type="button" data-vs-note-action="close" style="border:1px solid #4b5563;background:#111827;color:#d1d5db;border-radius:6px;width:24px;height:24px;cursor:pointer;">×</button>
      </div>
      <div id="vsNoteMeta" style="font-size:12px;color:#9ca3af;white-space:pre-wrap;word-break:break-all;margin-bottom:8px;"></div>
      <textarea id="vsNoteText" rows="4" placeholder="写下问题现象、预期和复现步骤..."
        style="width:100%;resize:vertical;border:1px solid #4b5563;background:#0b1220;color:#e5e7eb;border-radius:6px;padding:8px;"></textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">
        <button type="button" data-vs-note-action="cancel" style="border:1px solid #4b5563;background:#111827;color:#d1d5db;border-radius:6px;padding:6px 10px;cursor:pointer;">取消</button>
        <button type="button" data-vs-note-action="save" style="border:1px solid #ea580c;background:#1f1411;color:#fdba74;border-radius:6px;padding:6px 10px;cursor:pointer;">保存注释</button>
      </div>
    `;

    document.body.appendChild(panel);

    panel.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('[data-vs-note-action]') : null;
      if (!btn) return;
      const action = btn.getAttribute('data-vs-note-action') || '';
      if (action === 'close' || action === 'cancel') {
        hidePanel();
        return;
      }
      if (action === 'save') {
        const noteEl = panel.querySelector('#vsNoteText');
        const note = noteEl instanceof HTMLTextAreaElement ? noteEl.value.trim() : '';
        if (!note) return;
        const t = selectedTarget;
        emit('annotation', {
          note,
          selector: t ? cssPath(t) : '',
          tag: t ? t.tagName.toLowerCase() : '',
          text: t ? shortText(t) : '',
          href: t ? String(t.getAttribute('href') || '') : '',
          guide_anchor: t ? String(t.getAttribute('data-guide-anchor') || '') : '',
          page_path: currentPath(),
        });
        hidePanel();
      }
    }, true);

    return panel;
  };

  const hidePanel = () => {
    const p = ensurePanel();
    const noteEl = p.querySelector('#vsNoteText');
    if (noteEl instanceof HTMLTextAreaElement) noteEl.value = '';
    p.style.display = 'none';
    selectedTarget = null;
  };

  const openPanel = (target) => {
    selectedTarget = target;
    const p = ensurePanel();
    const metaEl = p.querySelector('#vsNoteMeta');
    const noteEl = p.querySelector('#vsNoteText');
    const meta = [
      `页面: ${currentPath()}`,
      `元素: ${target ? target.tagName.toLowerCase() : ''}`,
      `选择器: ${target ? cssPath(target) : ''}`,
      `文本: ${target ? shortText(target) : ''}`,
    ].join('\n');
    if (metaEl) metaEl.textContent = meta;
    if (noteEl instanceof HTMLTextAreaElement) {
      noteEl.value = '';
      noteEl.focus();
    }
    p.style.display = 'block';
  };

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && panel && panel.style.display !== 'none') {
      hidePanel();
    }
  }, true);

  document.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;

    if (ev.altKey && ev.shiftKey) {
      ev.preventDefault();
      ev.stopPropagation();
      openPanel(target);
      return;
    }

    const clickable = target.closest('a[href],button,[role="button"],input[type="submit"],input[type="button"],summary');
    if (!clickable) return;

    emit('click', {
      href: String(clickable.getAttribute('href') || ''),
      tag: clickable.tagName.toLowerCase(),
      text: shortText(clickable),
      selector: cssPath(clickable),
      guide_anchor: String(clickable.getAttribute('data-guide-anchor') || ''),
      page_path: currentPath(),
    });
  }, true);
})();
"""


def now_utc_iso() -> str:
  return datetime.now(timezone.utc).isoformat()


def now_ms() -> int:
  return int(time.time() * 1000)


def slugify(text: str) -> str:
  raw = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").strip().lower())
  return raw.strip("-") or "run"


def with_utc(event: dict[str, Any]) -> dict[str, Any]:
  if "ts_utc" not in event:
    event["ts_utc"] = now_utc_iso()
  return event


def to_path(url: str) -> str:
  try:
    u = urlparse(url)
    return f"{u.path or '/'}{('?' + u.query) if u.query else ''}"
  except Exception:
    return url or "/"


def make_run_dir(root: Path, profile: str) -> Path:
  ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
  out = root / f"{ts}-{slugify(profile)}"
  out.mkdir(parents=True, exist_ok=False)
  return out


def summarize(events: list[dict[str, Any]]) -> dict[str, Any]:
  navs = [e for e in events if e.get("type") == "navigate"]
  clicks = [e for e in events if e.get("type") == "click"]
  notes = [e for e in events if e.get("type") == "annotation"]
  slow = [e for e in events if e.get("type") == "response" and int(e.get("duration_ms") or 0) >= SLOW_REQUEST_MS]
  errors = [e for e in events if e.get("type") in {"request_failed", "dialog"}]
  errors.extend(e for e in events if e.get("type") == "console" and str(e.get("level") or "").lower() in {"error", "assert"})

  bounces: list[tuple[str, str, str]] = []
  for i in range(len(navs) - 2):
    a = str(navs[i].get("path") or "")
    b = str(navs[i + 1].get("path") or "")
    c = str(navs[i + 2].get("path") or "")
    if a and b and a == c and a != b:
      bounces.append((a, b, c))

  timeline = [e for e in events if e.get("type") in {"navigate", "click", "annotation"}]
  if len(timeline) > MAX_TIMELINE:
    timeline = timeline[-MAX_TIMELINE:]

  slow_sorted = sorted(slow, key=lambda e: int(e.get("duration_ms") or 0), reverse=True)[:15]

  return {
    "events_count": len(events),
    "nav_count": len(navs),
    "click_count": len(clicks),
    "annotation_count": len(notes),
    "slow_count": len(slow),
    "error_count": len(errors),
    "bounce_count": len(bounces),
    "bounces": bounces,
    "timeline": timeline,
    "slow_top": slow_sorted,
    "annotations": notes,
  }


def summary_markdown(*, started_at: str, base_url: str, start_url: str, device: str, summary: dict[str, Any]) -> str:
  lines: list[str] = []
  lines.append("# 电脑端可视化调试记录")
  lines.append("")
  lines.append(f"- 开始时间(UTC): {started_at}")
  lines.append(f"- Base URL: `{base_url}`")
  lines.append(f"- Start URL: `{start_url}`")
  lines.append(f"- Device: `{device}`")
  lines.append(f"- 事件总数: {summary['events_count']}")
  lines.append(f"- 导航次数: {summary['nav_count']}")
  lines.append(f"- 注释条数: {summary['annotation_count']}")
  lines.append(f"- 慢请求(>={SLOW_REQUEST_MS}ms): {summary['slow_count']}")
  lines.append(f"- 错误事件: {summary['error_count']}")
  lines.append(f"- 回跳嫌疑(A->B->A, 5秒内): {summary['bounce_count']}")

  lines.append("")
  lines.append("## 你加的注释（Alt+Shift+点击）")
  lines.append("")
  notes = summary["annotations"]
  if not notes:
    lines.append("- (无)")
  else:
    for idx, n in enumerate(notes, start=1):
      lines.append(f"{idx}. `{n.get('page_path', '')}` - `{n.get('selector', '')}` - {n.get('note', '')}")
      txt = str(n.get("text") or "").strip()
      if txt:
        lines.append(f"   - 元素文本: `{txt}`")

  lines.append("")
  lines.append(f"## 关键操作时间线（点击/跳转/注释，最多 {MAX_TIMELINE} 条）")
  lines.append("")
  timeline = summary["timeline"]
  if not timeline:
    lines.append("- (无)")
  else:
    for i, ev in enumerate(timeline, start=1):
      et = ev.get("type")
      if et == "navigate":
        lines.append(f"{i}. [navigate] `{ev.get('path', '')}`")
      elif et == "click":
        sel = ev.get("selector", "")
        txt = ev.get("text", "")
        lines.append(f"{i}. [click] `{ev.get('page_path', '')}` - selector=`{sel}` - text={txt}")
      elif et == "annotation":
        lines.append(f"{i}. [annotation] `{ev.get('page_path', '')}` - selector=`{ev.get('selector', '')}` - text={ev.get('text', '')}")

  lines.append("")
  lines.append("## 回跳嫌疑明细（A -> B -> A）")
  lines.append("")
  if summary["bounces"]:
    for a, b, c in summary["bounces"]:
      lines.append(f"- `{a}` -> `{b}` -> `{c}`")
  else:
    lines.append("- (无)")

  lines.append("")
  lines.append("## 慢请求 Top 15")
  lines.append("")
  if summary["slow_top"]:
    for i, e in enumerate(summary["slow_top"], start=1):
      lines.append(
        f"{i}. `{e.get('duration_ms')}ms` `{e.get('method','')}` `{e.get('resource','')}` `{e.get('url','')}`"
      )
  else:
    lines.append("- (无)")

  lines.append("")
  return "\n".join(lines)


def fetch_nav_diag(base_url: str, context: BrowserContext, out_file: Path) -> None:
  url = f"{base_url.rstrip('/')}/api/diagnostics/nav?minutes=120&limit=3000"
  cookie_list = context.cookies()
  cookie_header = "; ".join([f"{c.get('name','')}={c.get('value','')}" for c in cookie_list if c.get("name")])
  headers = {"Accept": "application/json"}
  if cookie_header:
    headers["Cookie"] = cookie_header

  payload: dict[str, Any] = {"status_code": 0, "url": url, "body": None}
  try:
    with httpx.Client(timeout=20.0, follow_redirects=True) as client:
      resp = client.get(url, headers=headers)
      payload["status_code"] = int(resp.status_code)
      ctype = (resp.headers.get("content-type") or "").lower()
      if "application/json" in ctype:
        payload["body"] = resp.json()
      else:
        payload["body"] = {"raw": resp.text[:3000]}
  except Exception as exc:
    payload["error"] = str(exc)

  out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="桌面可视化反馈工具（移动端仿真）")
  parser.add_argument("--url", default="https://yuookie.qzz.io/", help="起始 URL")
  parser.add_argument("--base-url", default="", help="用于诊断接口抓取的 base URL，默认从 --url 推断")
  parser.add_argument("--profile", default="real-mobile-bug", help="本次调试标签")
  parser.add_argument("--device", default=DEFAULT_DEVICE, help=f"Playwright 设备名，默认 {DEFAULT_DEVICE}")
  parser.add_argument("--headless", action="store_true", help="无头运行")
  parser.add_argument("--run-seconds", type=int, default=0, help="自动运行秒数，0=手动关闭浏览器结束")
  parser.add_argument("--artifact-root", default="artifacts/visual_debug", help="产物输出目录")
  parser.add_argument("--no-video", action="store_true", help="不录制视频")
  parser.add_argument("--slow-threshold", type=int, default=SLOW_REQUEST_MS, help="慢请求阈值(ms)")
  parser.add_argument("--window-width", type=int, default=560, help="有头模式窗口宽度（默认手机比例）")
  parser.add_argument("--window-height", type=int, default=1100, help="有头模式窗口高度（默认手机比例）")
  parser.add_argument("--stop-on-enter", action="store_true", help="按回车结束（仅建议有头模式使用）")
  return parser.parse_args()


def run(args: argparse.Namespace) -> Path:
  global SLOW_REQUEST_MS
  SLOW_REQUEST_MS = max(200, int(args.slow_threshold or SLOW_REQUEST_MS))

  started_at = now_utc_iso()
  start_url = str(args.url or "").strip() or "https://yuookie.qzz.io/"
  u = urlparse(start_url)
  base_url = (str(args.base_url or "").strip() or f"{u.scheme}://{u.netloc}").rstrip("/")

  root = Path(args.artifact_root)
  out_dir = make_run_dir(root, args.profile)
  events: list[dict[str, Any]] = []

  req_id_seq = 1
  req_key_to_id: dict[int, int] = {}
  req_start_ms: dict[int, int] = {}
  wired_pages: set[int] = set()
  browser_disconnected = False
  stop_on_enter = False

  def emit(event: dict[str, Any]) -> None:
    events.append(with_utc(event))

  def wire_page(page: Page) -> None:
    nonlocal req_id_seq
    pid = id(page)
    if pid in wired_pages:
      return
    wired_pages.add(pid)

    def on_request(request) -> None:
      nonlocal req_id_seq
      try:
        rid = req_id_seq
        req_id_seq += 1
        key = id(request)
        req_key_to_id[key] = rid
        req_start_ms[rid] = now_ms()
        emit(
          {
            "type": "request",
            "rid": rid,
            "method": request.method,
            "resource": request.resource_type,
            "url": request.url,
            "frame_url": request.frame.url if request.frame else "",
          }
        )
      except Exception as exc:
        emit({"type": "console", "level": "error", "text": f"on_request failed: {exc}", "url": ""})

    def on_response(response) -> None:
      try:
        req = response.request
        rid = req_key_to_id.get(id(req), 0)
        started = req_start_ms.get(rid, now_ms())
        emit(
          {
            "type": "response",
            "rid": rid,
            "status": response.status,
            "method": req.method,
            "resource": req.resource_type,
            "url": req.url,
            "duration_ms": max(0, now_ms() - started),
            "frame_url": req.frame.url if req.frame else "",
          }
        )
      except Exception as exc:
        emit({"type": "console", "level": "error", "text": f"on_response failed: {exc}", "url": ""})

    def on_request_failed(request) -> None:
      try:
        rid = req_key_to_id.get(id(request), 0)
        started = req_start_ms.get(rid, now_ms())

        failure_raw = getattr(request, "failure", None)
        if callable(failure_raw):
          failure_raw = failure_raw()

        if isinstance(failure_raw, str):
          failure_text = failure_raw
        elif isinstance(failure_raw, dict):
          failure_text = str(failure_raw.get("error_text") or failure_raw.get("errorText") or "")
        elif failure_raw is None:
          failure_text = ""
        else:
          failure_text = str(getattr(failure_raw, "error_text", getattr(failure_raw, "errorText", failure_raw)))

        emit(
          {
            "type": "request_failed",
            "rid": rid,
            "method": request.method,
            "resource": request.resource_type,
            "url": request.url,
            "duration_ms": max(0, now_ms() - started),
            "error": failure_text,
            "frame_url": request.frame.url if request.frame else "",
          }
        )
      except Exception as exc:
        emit({"type": "console", "level": "error", "text": f"on_request_failed failed: {exc}", "url": ""})

    def on_frame_navigated(frame) -> None:
      try:
        if frame != page.main_frame:
          return
        emit({"type": "navigate", "url": frame.url, "path": to_path(frame.url)})
      except Exception as exc:
        emit({"type": "console", "level": "error", "text": f"on_frame_navigated failed: {exc}", "url": ""})

    def on_console(msg) -> None:
      try:
        emit(
          {
            "type": "console",
            "level": msg.type,
            "text": msg.text,
            "url": page.url,
          }
        )
      except Exception:
        pass

    page.on("request", on_request)
    page.on("response", on_response)
    page.on("requestfailed", on_request_failed)
    page.on("framenavigated", on_frame_navigated)
    page.on("console", on_console)

  with sync_playwright() as p:
    launch_args: list[str] = []
    if not args.headless:
      ww = max(360, int(args.window_width or 460))
      wh = max(640, int(args.window_height or 980))
      launch_args.append(f"--window-size={ww},{wh}")
      # Keep CSS pixel sizing predictable on HiDPI systems.
      launch_args.append("--force-device-scale-factor=1")
    browser = p.chromium.launch(headless=bool(args.headless), args=launch_args)
    def on_browser_disconnected(*_args) -> None:
      nonlocal browser_disconnected
      browser_disconnected = True
      emit({"type": "browser_disconnected"})
    browser.on("disconnected", on_browser_disconnected)

    context_kwargs: dict[str, Any] = {}
    device_name = str(args.device or "").strip()
    if device_name and device_name in p.devices:
      context_kwargs.update(p.devices[device_name])
      context_kwargs["viewport"] = p.devices[device_name].get("viewport")
    if not args.no_video:
      video_dir = out_dir / "videos"
      video_dir.mkdir(parents=True, exist_ok=True)
      context_kwargs["record_video_dir"] = str(video_dir)
      context_kwargs["record_video_size"] = {"width": 412, "height": 915}

    context = browser.new_context(**context_kwargs)

    def on_debug_emit(source, payload) -> None:
      if not isinstance(payload, dict):
        return
      event = dict(payload)
      event_type = str(event.pop("type", "client")).strip() or "client"
      event["type"] = event_type
      page_path = str(event.get("page_path") or "").strip()
      if not page_path:
        try:
          page_path = to_path(source.page.url)
          event["page_path"] = page_path
        except Exception:
          pass
      emit(event)

    context.expose_binding("__vsDebugEmit", on_debug_emit)
    context.add_init_script(INIT_SCRIPT)
    context.on("page", wire_page)

    page = context.new_page()
    wire_page(page)
    page.goto(start_url, wait_until="domcontentloaded", timeout=90000)

    if bool(args.stop_on_enter):
      def _wait_enter() -> None:
        nonlocal stop_on_enter
        try:
          input()
          stop_on_enter = True
          emit({"type": "manual_stop", "source": "enter"})
        except Exception:
          pass
      threading.Thread(target=_wait_enter, daemon=True).start()

    started = time.time()
    while True:
      if args.run_seconds and (time.time() - started) >= int(args.run_seconds):
        break
      if stop_on_enter:
        break
      if browser_disconnected:
        break
      try:
        if not browser.is_connected():
          break
        pages = context.pages
      except PlaywrightError:
        break
      if not pages:
        break
      if all(p.is_closed() for p in pages):
        break
      try:
        time.sleep(0.5)
      except KeyboardInterrupt:
        break

    try:
      pages_snapshot = context.pages
    except PlaywrightError:
      pages_snapshot = []

    if pages_snapshot:
      last_page = pages_snapshot[-1]
      try:
        last_page.screenshot(path=str(out_dir / "last_page.png"), full_page=True)
      except Exception as exc:
        emit({"type": "console", "level": "error", "text": f"screenshot failed: {exc}", "url": last_page.url})

    nav_diag_path = out_dir / "nav_diag.json"
    try:
      if browser.is_connected():
        fetch_nav_diag(base_url, context, nav_diag_path)
      else:
        nav_diag_path.write_text(
          json.dumps({"status_code": 0, "url": f"{base_url}/api/diagnostics/nav", "skipped": "browser_disconnected"}, ensure_ascii=False, indent=2),
          encoding="utf-8",
        )
    except Exception as exc:
      emit({"type": "console", "level": "error", "text": f"fetch_nav_diag failed: {exc}", "url": ""})
      try:
        nav_diag_path.write_text(
          json.dumps({"status_code": 0, "url": f"{base_url}/api/diagnostics/nav", "error": str(exc)}, ensure_ascii=False, indent=2),
          encoding="utf-8",
        )
      except Exception:
        pass

    try:
      context.close()
    except PlaywrightError as exc:
      emit({"type": "console", "level": "error", "text": f"context.close failed: {exc}", "url": ""})
    try:
      browser.close()
    except PlaywrightError as exc:
      emit({"type": "console", "level": "error", "text": f"browser.close failed: {exc}", "url": ""})

  summary = summarize(events)
  session_payload = {
    "started_at": started_at,
    "finished_at": now_utc_iso(),
    "base_url": base_url,
    "start_url": start_url,
    "device": device_name or "custom",
    "events_count": len(events),
    "events": events,
    "files": {
      "last_page_screenshot": "last_page.png",
      "diag_nav": "nav_diag.json",
    },
  }
  (out_dir / "session.json").write_text(json.dumps(session_payload, ensure_ascii=False, indent=2), encoding="utf-8")
  (out_dir / "SUMMARY.md").write_text(
    summary_markdown(started_at=started_at, base_url=base_url, start_url=start_url, device=device_name or "custom", summary=summary),
    encoding="utf-8",
  )
  return out_dir


def main() -> int:
  args = parse_args()
  out = run(args)
  print(str(out.resolve()))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
