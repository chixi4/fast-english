from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _wait_server_ready(base_url: str, timeout_sec: float = 30.0) -> None:
    start = time.time()
    last_error = ""
    while time.time() - start < timeout_sec:
        try:
            resp = httpx.get(f"{base_url}/", timeout=3.0)
            if resp.status_code == 200:
                return
        except Exception as exc:
            last_error = str(exc)
        time.sleep(0.5)
    raise RuntimeError(f"server not ready within {timeout_sec}s: {last_error}")


def _start_server(repo_root: Path, port: int) -> subprocess.Popen:
    env = os.environ.copy()
    env["AI_MOCK"] = "1"
    env["APP_REQUIRE_LOGIN"] = "0"
    env["APP_MULTIUSER_BY_IDENTITY"] = "0"
    python_exe = repo_root / ".venv" / "Scripts" / "python.exe"
    if not python_exe.exists():
        python_exe = Path(sys.executable)
    proc = subprocess.Popen(
        [
            str(python_exe),
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=str(repo_root),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc


def _capture(base_url: str, output_dir: Path) -> list[dict[str, str]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, str]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        device = playwright.devices["iPhone 13"]
        context = browser.new_context(**device, locale="zh-CN", timezone_id="Asia/Shanghai")
        page = context.new_page()

        basic_pages = [
            ("app_home_mobile", "/", "首页 今日学习"),
            ("app_review_mobile", "/review", "复习页面"),
            ("app_mistakes_mobile", "/mistakes", "错词强化"),
            ("app_settings_mobile", "/settings", "设置页面"),
        ]

        for slug, route, title in basic_pages:
            page.goto(f"{base_url}{route}", wait_until="networkidle")
            page.wait_for_timeout(1200)
            out = output_dir / f"{slug}.png"
            page.screenshot(path=str(out), full_page=False)
            results.append({"file": out.name, "title": title, "route": route})

        browser.close()
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture mobile app screenshots for project plan")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--output-dir", default="docs/assets/plan_screenshots")
    args = parser.parse_args()

    repo_root = _repo_root()
    output_dir = repo_root / args.output_dir
    base_url = f"http://127.0.0.1:{args.port}"

    proc = _start_server(repo_root, args.port)
    try:
        _wait_server_ready(base_url, timeout_sec=35.0)
        captures = _capture(base_url, output_dir)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()

    manifest = output_dir / "manifest.json"
    manifest.write_text(json.dumps(captures, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"captured {len(captures)} screenshots")
    print(str(manifest))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
