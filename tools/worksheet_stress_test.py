from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

import sqlite3
from fastapi.testclient import TestClient


def _backup_sqlite(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    with sqlite3.connect(str(src)) as src_conn:
        with sqlite3.connect(str(dest)) as dest_conn:
            src_conn.backup(dest_conn)


def _count_pattern(text: str, pattern: str) -> int:
    try:
        return len(re.findall(pattern, text or ""))
    except re.error:
        return (text or "").count(pattern)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="Stress test worksheet generation (optionally with real AI).")
    p.add_argument("--iterations", type=int, default=3, help="How many times to generate worksheets.")
    p.add_argument("--stage", choices=["primary", "junior"], default="junior")
    p.add_argument(
        "--question-types",
        default="spelling,mcq,cloze,reading",
        help="Comma-separated question types.",
    )
    p.add_argument("--use-real-ai", action="store_true", help="Use AI_API_KEY from .env/.env vars (AI_MOCK=0).")
    args = p.parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    src_db = repo_root / "data" / "app.db"
    if not src_db.exists():
        print(f"[fatal] missing db: {src_db}", file=sys.stderr)
        return 2

    tmp_dir = Path(tempfile.mkdtemp(prefix="vs_ws_stress_"))
    db_path = tmp_dir / "app.db"
    auth_db_path = tmp_dir / "auth.db"
    _backup_sqlite(src_db, db_path)

    os.environ["APP_DB_PATH"] = str(db_path)
    os.environ["APP_AUTH_DB_PATH"] = str(auth_db_path)
    os.environ["APP_REQUIRE_LOGIN"] = "0"
    os.environ["APP_MULTIUSER_BY_IDENTITY"] = "0"
    os.environ["APP_DEV_USER_IDENTITY"] = ""

    if args.use_real_ai:
        os.environ["AI_MOCK"] = "0"
        # Force gemini3flash as requested (do not print AI_API_KEY).
        os.environ["AI_MODEL"] = "gemini-3-flash-preview"
        os.environ["AI_WRITER_MODEL"] = "gemini-3-flash-preview"
        os.environ["AI_CHECKER_MODEL"] = ""
    else:
        os.environ["AI_MOCK"] = "1"
        os.environ["AI_API_KEY"] = ""
        os.environ["AI_BASE_URL"] = "http://example.invalid/v1"

    # Ensure tests aren't blocked by any local .env basic auth.
    os.environ["APP_BASIC_AUTH_USER"] = ""
    os.environ["APP_BASIC_AUTH_PASS"] = ""

    import importlib

    if "app.main" in sys.modules:
        main_mod = importlib.reload(sys.modules["app.main"])
    else:
        import app.main as main_mod  # type: ignore

    qts = [x.strip().lower() for x in (args.question_types or "").split(",") if x.strip()]
    qts = [x for x in qts if x in {"spelling", "mcq", "cloze", "reading"}]
    if not qts:
        qts = ["spelling", "mcq", "cloze"]

    print(f"[info] db_copy={db_path}")
    print(f"[info] stage={args.stage} iterations={args.iterations} qts={qts} real_ai={bool(args.use_real_ai)}")

    failures = 0
    with TestClient(main_mod.app) as client:
        for i in range(1, max(1, args.iterations) + 1):
            resp = client.post(
                "/worksheets/generate_today",
                data={"question_types": qts},
                follow_redirects=True,
            )
            ok = resp.status_code == 200 and "worksheet-sheet" in (resp.text or "")
            cloze_bad = _count_pattern(resp.text, r"This is\\s+____\\.") if resp.text else 0
            filler_bad = _count_pattern(resp.text, r"（以上都不对）|（无法判断）|（先跳过）|（都不是）|（不确定）") if resp.text else 0
            has_reading = "阅读（短文理解）" in (resp.text or "")
            print(
                f"[{i}] status={resp.status_code} ok={ok} cloze_this_is={cloze_bad} filler={filler_bad} reading={has_reading}"
            )
            if not ok or filler_bad:
                failures += 1

    if failures:
        print(f"[done] failures={failures} (see logs above)", file=sys.stderr)
        return 1
    print("[done] all iterations succeeded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
