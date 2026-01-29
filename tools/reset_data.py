from __future__ import annotations

import os
import sqlite3
import sys
import time
from pathlib import Path


def _read_env_file(path: Path) -> dict[str, str]:
    data: dict[str, str] = {}
    if not path.exists():
        return data
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip("'").strip('"')
        if k:
            data[k] = v
    return data


def _resolve_db_path(argv: list[str]) -> Path:
    if len(argv) >= 2 and argv[1].strip():
        return Path(argv[1].strip())

    env_db = os.getenv("APP_DB_PATH")
    if env_db:
        return Path(env_db)

    env_file = _read_env_file(Path(".env"))
    if env_file.get("APP_DB_PATH"):
        return Path(env_file["APP_DB_PATH"])

    return Path("data/app.db")


def wipe_sqlite(db_path: Path) -> None:
    if not db_path.exists():
        print(f"No DB file found: {db_path}")
        return

    db_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys=OFF;")
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=8000;")

    existing_tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()}

    tables = [
        "srs_review_logs",
        "srs_cards",
        "plan_words",
        "plan_decks",
        "plans",
        "deck_words",
        "mistakes",
        "simulations",
        "decks",
        "words",
    ]

    last_err: Exception | None = None
    for attempt in range(1, 6):
        try:
            cur = conn.cursor()
            for t in tables:
                if t not in existing_tables:
                    continue
                cur.execute(f"DELETE FROM {t};")
            conn.commit()
            last_err = None
            break
        except sqlite3.OperationalError as e:
            last_err = e
            if "locked" in str(e).lower() and attempt < 5:
                time.sleep(0.6 * attempt)
                continue
            raise

    if last_err is not None:
        raise last_err

    try:
        conn.execute("DELETE FROM sqlite_sequence;")
        conn.commit()
    except Exception:
        pass

    try:
        conn.execute("VACUUM;")
    except Exception:
        pass
    finally:
        conn.close()

    print(f"Wiped data in {db_path}")


def main(argv: list[str]) -> int:
    db_path = _resolve_db_path(argv)
    wipe_sqlite(db_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
