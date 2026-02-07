from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import secrets
import string
import sys
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from fsrs import Rating
from sqlalchemy import func

_THIS_FILE = Path(__file__).resolve()
_REPO_ROOT = _THIS_FILE.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import app.main as main_app
from app.auth import hash_password
from app.auth_db import get_auth_session, init_auth_db
from app.auth_models import AuthEvent, AuthOnboardingState, AuthUser
from app.config import get_settings
from app.db import get_session, init_db
from app.models import Deck, DeckWord, Mistake, SrsCard, SrsReviewLog, Word
from app.request_context import pop_current_user_identity, push_current_user_identity
from app.srs import apply_fsrs_to_db, db_card_to_fsrs, get_scheduler


_SAFE_FILE_CHARS_RE = re.compile(r"[^a-zA-Z0-9._-]+")
_ALPHABET = string.ascii_lowercase + string.digits


@dataclass(frozen=True)
class SimulationConfig:
    username: str | None
    password: str | None
    stage: str
    source_id: str
    start_date: date
    end_date: date
    intensity: str
    seed: int
    artifact_root: Path
    skip_http_check: bool


@dataclass
class SimulationResult:
    username: str
    password: str
    username_norm: str
    stage: str
    source_id: str
    start_date: str
    end_date: str
    intensity: str
    auth_db_path: str
    user_db_path: str
    stats: dict[str, Any]
    smoke_check: dict[str, Any]
    artifact_dir: str


def _identity_to_db_filename(identity: str) -> str:
    norm = (identity or "").strip().lower()
    if not norm:
        return "user_local.db"
    safe = _SAFE_FILE_CHARS_RE.sub("_", norm.replace("@", "_at_"))
    safe = safe.strip("._-") or "user"
    digest = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:10]
    return f"{safe}_{digest}.db"


def _user_db_path_for_identity(identity: str) -> Path:
    settings = get_settings()
    return settings.user_db_dir / _identity_to_db_filename(identity)


def _dispose_user_db_engine(db_path: Path) -> None:
    # app.db 会缓存 engine；回滚删除文件前先释放句柄。
    try:
        import app.db as app_db_mod

        target = str(db_path.resolve())
        engines = getattr(app_db_mod, "_ENGINES", {})
        factories = getattr(app_db_mod, "_SESSION_FACTORIES", {})
        for key, engine in list(engines.items()):
            if str(Path(key).resolve()) != target:
                continue
            try:
                engine.dispose()
            except Exception:
                pass
            try:
                del engines[key]
            except Exception:
                pass
            try:
                del factories[key]
            except Exception:
                pass
    except Exception:
        pass


def _norm_username(raw: str) -> tuple[str, str]:
    text = (raw or "").strip()
    return text, text.lower()


def _parse_date(raw: str) -> date:
    try:
        return date.fromisoformat((raw or "").strip())
    except Exception as exc:
        raise ValueError(f"invalid date: {raw}") from exc


def _iter_days(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def _username_exists(norm: str) -> bool:
    with get_auth_session() as session:
        return session.query(AuthUser.id).filter(AuthUser.username_norm == norm).first() is not None


def _generate_unique_username(prefix: str = "sim_junior") -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    for _ in range(50):
        suffix = "".join(secrets.choice(_ALPHABET) for _ in range(4))
        candidate = f"{prefix}_{stamp}_{suffix}"[:64]
        _raw, norm = _norm_username(candidate)
        if not _username_exists(norm):
            return candidate
    raise RuntimeError("failed to generate unique username")


def _generate_password(length: int = 14) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*"
    return "".join(secrets.choice(alphabet) for _ in range(max(12, length)))


def _daily_target(day: date, *, intensity: str, rng: random.Random) -> int:
    level = (intensity or "medium").strip().lower()
    if level == "light":
        lo, hi = 12, 25
    elif level == "high":
        lo, hi = 50, 90
    else:
        lo, hi = 25, 45

    val = rng.randint(lo, hi)
    # 周六略降负载；每 4 周做一次轻微冲刺，贴近真实学习波动。
    if day.weekday() == 5:
        val = max(lo, int(round(val * 0.84)))
    week_no = ((day.toordinal() // 7) % 4)
    if week_no == 3:
        val += 3
    return max(lo, min(hi + 6, val))


def _choose_rating(card_row: SrsCard, word: Word, *, rng: random.Random) -> Rating:
    state = int(card_row.state or 1)
    stability = float(card_row.stability or 0.0)
    wrong = int(word.wrong_count or 0)
    correct = int(word.correct_count or 0)
    seen = card_row.last_reviewed_at is not None

    if not seen:
        weights = [0.30, 0.30, 0.34, 0.06]  # Again/Hard/Good/Easy
    elif state == 2:
        if stability >= 30:
            weights = [0.03, 0.10, 0.64, 0.23]
        elif stability >= 10:
            weights = [0.06, 0.18, 0.62, 0.14]
        else:
            weights = [0.11, 0.24, 0.56, 0.09]
    elif state == 3:
        weights = [0.22, 0.30, 0.42, 0.06]
    else:
        weights = [0.17, 0.29, 0.45, 0.09]

    # 错词偏多时，适当提升 Again/Hard 概率。
    total = max(1, wrong + correct)
    wrong_ratio = wrong / total
    if wrong_ratio > 0.45:
        weights[0] += 0.06
        weights[1] += 0.04
        weights[2] = max(0.18, weights[2] - 0.08)
        weights[3] = max(0.02, weights[3] - 0.02)

    ratings = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]
    return rng.choices(ratings, weights=weights, k=1)[0]


def _create_auth_user(username: str, password: str) -> tuple[int, str]:
    raw, norm = _norm_username(username)
    if not raw:
        raise ValueError("username is empty")
    if len(raw) > 64:
        raise ValueError("username too long")
    if len(password) < 4:
        raise ValueError("password too short")
    with get_auth_session() as session:
        exists = session.query(AuthUser.id).filter(AuthUser.username_norm == norm).first()
        if exists is not None:
            raise ValueError(f"username already exists: {raw}")
        user = AuthUser(username=raw, username_norm=norm, password_hash=hash_password(password))
        session.add(user)
        session.flush()
        uid = int(user.id)
        session.add(
            AuthOnboardingState(
                user_id=uid,
                username_norm=norm,
                guide_version=2,
                status="done",
                completed_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
        )
    return uid, norm


def rollback_account(username: str) -> dict[str, Any]:
    _raw, norm = _norm_username(username)
    removed_user = False
    removed_events = 0
    removed_state = 0
    uid: int | None = None
    with get_auth_session() as session:
        user = session.query(AuthUser).filter(AuthUser.username_norm == norm).first()
        if user is not None:
            uid = int(user.id)
            removed_events = (
                session.query(AuthEvent).filter(AuthEvent.user_id == uid).delete(synchronize_session=False)
            )
            removed_state = (
                session.query(AuthOnboardingState)
                .filter(AuthOnboardingState.user_id == uid)
                .delete(synchronize_session=False)
            )
            session.delete(user)
            removed_user = True

    db_path = _user_db_path_for_identity(norm)
    db_deleted = False
    if db_path.exists():
        _dispose_user_db_engine(db_path)
        db_path.unlink()
        db_deleted = True

    return {
        "ok": True,
        "username_norm": norm,
        "removed_user": removed_user,
        "removed_user_id": uid,
        "removed_events": int(removed_events),
        "removed_onboarding_state": int(removed_state),
        "user_db_deleted": db_deleted,
        "user_db_path": str(db_path.resolve()),
    }


def _prepare_source_and_deck(
    *,
    source_id: str,
    stage: str,
    start_dt: datetime,
) -> tuple[int, str, str]:
    sid = (source_id or "").strip() or main_app._recommended_source_id_for_stage("self", stage)
    ready, deck_name = main_app._ensure_source_wordbook_imported(sid, timeout_sec=90.0)
    if not ready:
        raise RuntimeError(f"source not ready: {sid}")
    main_app._seed_plan_from_source(sid, count=120)

    try:
        if not deck_name:
            deck_name = str(main_app.get_source(sid).default_deck or "").strip()
    except Exception:
        pass
    if not deck_name:
        raise RuntimeError(f"source has no default deck: {sid}")

    with get_session() as session:
        deck = session.query(Deck).filter(Deck.name == deck_name).first()
        if deck is None:
            raise RuntimeError(f"deck missing after import: {deck_name}")
        deck_id = int(deck.id)

        # 首次历史回放从 start_dt 开始，需把未学卡的 due_at 拉回历史起点。
        session.query(SrsCard).filter(
            SrsCard.word_id.in_(
                session.query(DeckWord.word_id).filter(DeckWord.deck_id == deck_id)
            ),
            SrsCard.last_reviewed_at.is_(None),
        ).update({SrsCard.due_at: start_dt}, synchronize_session=False)

        # 预热足够的初始候选词，避免前几天空转。
        for _ in range(8):
            planned = int(
                session.query(func.count(SrsCard.word_id))
                .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
                .filter(DeckWord.deck_id == deck_id)
                .scalar()
                or 0
            )
            if planned >= 480:
                break
            _name, added, _remaining = main_app._add_next_words_to_plan(session, deck_id=deck_id, count=120)
            if int(added or 0) <= 0:
                break
            session.query(SrsCard).filter(
                SrsCard.word_id.in_(
                    session.query(DeckWord.word_id).filter(DeckWord.deck_id == deck_id)
                ),
                SrsCard.last_reviewed_at.is_(None),
                SrsCard.due_at > start_dt,
            ).update({SrsCard.due_at: start_dt}, synchronize_session=False)
        session.flush()

    return deck_id, deck_name, sid


def _pick_due_item(
    session,
    *,
    deck_id: int,
    now_dt: datetime,
    exclude_word_ids: set[int] | None = None,
) -> tuple[SrsCard, Word] | None:
    q = (
        session.query(SrsCard, Word)
        .join(Word, Word.id == SrsCard.word_id)
        .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
        .filter(DeckWord.deck_id == int(deck_id), SrsCard.due_at <= now_dt)
    )
    if exclude_word_ids:
        q = q.filter(~SrsCard.word_id.in_(list(exclude_word_ids)))
    return q.order_by(SrsCard.due_at.asc(), SrsCard.word_id.asc()).first()


def _add_cards_for_simulation(
    session,
    *,
    deck_id: int,
    count: int,
    due_at: datetime,
) -> int:
    before = {
        int(wid)
        for (wid,) in session.query(SrsCard.word_id)
        .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
        .filter(DeckWord.deck_id == int(deck_id))
        .all()
    }
    _name, added, _remaining = main_app._add_next_words_to_plan(session, deck_id=int(deck_id), count=int(count))
    if int(added or 0) <= 0:
        return 0

    q = (
        session.query(SrsCard)
        .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
        .filter(
            DeckWord.deck_id == int(deck_id),
            SrsCard.last_reviewed_at.is_(None),
        )
    )
    if before:
        q = q.filter(~SrsCard.word_id.in_(before))
    new_rows = q.all()
    for row in new_rows:
        row.due_at = due_at
    session.flush()
    return len(new_rows) if new_rows else int(added)


def _simulate_history(
    *,
    deck_id: int,
    start_date: date,
    end_date: date,
    intensity: str,
    seed: int,
) -> dict[str, Any]:
    rng = random.Random(seed)
    scheduler = get_scheduler()

    stats = {
        "study_days": 0,
        "review_logs": 0,
        "again_count": 0,
        "hard_count": 0,
        "good_count": 0,
        "easy_count": 0,
    }

    with get_session() as session:
        for day in _iter_days(start_date, end_date):
            if day.weekday() == 6:
                continue
            stats["study_days"] += 1
            target = _daily_target(day, intensity=intensity, rng=rng)
            current = datetime(day.year, day.month, day.day, 11, rng.randint(5, 40), 0)
            done = 0
            idle = 0
            seen_today: set[int] = set()

            # 每天先引入一批新词，避免长期只在小集合里循环复习。
            if intensity == "high":
                intake = rng.randint(18, 30)
            elif intensity == "light":
                intake = rng.randint(6, 12)
            else:
                intake = rng.randint(10, 18)
            _add_cards_for_simulation(
                session,
                deck_id=deck_id,
                count=intake,
                due_at=current,
            )

            while done < target:
                picked = _pick_due_item(
                    session,
                    deck_id=deck_id,
                    now_dt=current,
                    exclude_word_ids=seen_today,
                )
                if picked is None:
                    add_batch = max(24, min(120, target - done + 12))
                    added = _add_cards_for_simulation(
                        session,
                        deck_id=deck_id,
                        count=add_batch,
                        due_at=current,
                    )
                    if added <= 0:
                        idle += 1
                        if idle >= 3:
                            break
                        current = current + timedelta(minutes=30)
                        continue
                    idle = 0
                    continue

                idle = 0
                card_row, word = picked
                rating = _choose_rating(card_row, word, rng=rng)
                duration_ms = int(rng.randint(900, 7800))
                reviewed_at = current
                reviewed_at_aware = reviewed_at.replace(tzinfo=timezone.utc)

                fsrs_card = db_card_to_fsrs(card_row)
                updated_card, _log = scheduler.review_card(
                    fsrs_card,
                    rating,
                    review_datetime=reviewed_at_aware,
                    review_duration=duration_ms,
                )
                apply_fsrs_to_db(card_row, updated_card)
                word.last_reviewed_at = reviewed_at

                if rating == Rating.Again:
                    word.wrong_count += 1
                    session.add(Mistake(word_id=int(word.id)))
                    stats["again_count"] += 1
                elif rating == Rating.Hard:
                    word.correct_count += 1
                    stats["hard_count"] += 1
                elif rating == Rating.Good:
                    word.correct_count += 1
                    stats["good_count"] += 1
                else:
                    word.correct_count += 1
                    stats["easy_count"] += 1

                session.add(
                    SrsReviewLog(
                        word_id=int(word.id),
                        rating=int(rating.value),
                        reviewed_at=reviewed_at,
                        duration_ms=duration_ms,
                    )
                )
                stats["review_logs"] += 1
                seen_today.add(int(word.id))
                done += 1
                current = current + timedelta(seconds=rng.randint(35, 130))

            session.flush()

    return stats


def _collect_stats(*, end_dt: datetime) -> dict[str, Any]:
    with get_session() as session:
        review_logs = int(session.query(func.count(SrsReviewLog.id)).scalar() or 0)
        again_count = int(
            session.query(func.count(SrsReviewLog.id))
            .filter(SrsReviewLog.rating == int(Rating.Again.value))
            .scalar()
            or 0
        )
        reviewed_words = int(
            session.query(func.count(Word.id)).filter(Word.last_reviewed_at.is_not(None)).scalar() or 0
        )
        total_cards = int(session.query(func.count(SrsCard.word_id)).scalar() or 0)
        due_now = int(session.query(func.count(SrsCard.word_id)).filter(SrsCard.due_at <= end_dt).scalar() or 0)
        mastered = int(
            session.query(func.count(SrsCard.word_id))
            .filter(
                SrsCard.state == 2,
                SrsCard.stability.is_not(None),
                SrsCard.stability >= 30.0,
            )
            .scalar()
            or 0
        )
        mistake_words = int(session.query(func.count(func.distinct(Mistake.word_id))).scalar() or 0)
        active_7_cutoff = end_dt - timedelta(days=6)
        active_30_cutoff = end_dt - timedelta(days=29)
        rows = session.query(SrsReviewLog.reviewed_at).filter(SrsReviewLog.reviewed_at <= end_dt).all()
        active_7 = {
            reviewed_at.date().isoformat()
            for (reviewed_at,) in rows
            if isinstance(reviewed_at, datetime) and reviewed_at >= active_7_cutoff
        }
        active_30 = {
            reviewed_at.date().isoformat()
            for (reviewed_at,) in rows
            if isinstance(reviewed_at, datetime) and reviewed_at >= active_30_cutoff
        }

    again_ratio = (again_count / review_logs) if review_logs else 0.0
    return {
        "review_logs": review_logs,
        "again_count": again_count,
        "again_ratio": round(float(again_ratio), 4),
        "reviewed_words": reviewed_words,
        "total_cards": total_cards,
        "due_now": due_now,
        "mastered_cards": mastered,
        "mistake_words": mistake_words,
        "active_days_7": len(active_7),
        "active_days_30": len(active_30),
    }


def _smoke_check_pages(*, username: str, password: str) -> dict[str, Any]:
    pages = ["/review", "/dashboard", "/mistakes"]
    result: dict[str, Any] = {"ok": True, "login_status": 0, "pages": {}}
    with TestClient(main_app.app) as client:
        resp = client.post(
            "/auth/login",
            data={"username": username, "password": password, "next": "/"},
            follow_redirects=False,
        )
        result["login_status"] = int(resp.status_code)
        if int(resp.status_code) not in {302, 303}:
            result["ok"] = False
            return result
        for path in pages:
            r = client.get(path, follow_redirects=True)
            ok = int(r.status_code) < 400
            result["pages"][path] = {"status": int(r.status_code), "ok": ok}
            if not ok:
                result["ok"] = False
    return result


def _write_artifacts(result: SimulationResult) -> None:
    out_dir = Path(result.artifact_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    session_json = out_dir / "session.json"
    summary_md = out_dir / "SUMMARY.md"

    payload = asdict(result)
    session_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = f"""# Simulated Account Summary

- Username: `{result.username}`
- Password: `{result.password}`
- Stage: `{result.stage}`
- Source: `{result.source_id}`
- Window: `{result.start_date}` to `{result.end_date}`
- Intensity: `{result.intensity}`

## Stats

- Review logs: `{result.stats.get("review_logs")}`
- Again ratio: `{result.stats.get("again_ratio")}`
- Reviewed words: `{result.stats.get("reviewed_words")}`
- Total cards: `{result.stats.get("total_cards")}`
- Due now: `{result.stats.get("due_now")}`
- Mastered cards: `{result.stats.get("mastered_cards")}`
- Mistake words: `{result.stats.get("mistake_words")}`
- Active days (7/30): `{result.stats.get("active_days_7")}` / `{result.stats.get("active_days_30")}`

## Paths

- Auth DB: `{result.auth_db_path}`
- User DB: `{result.user_db_path}`
- Session JSON: `{session_json}`
"""
    summary_md.write_text(summary, encoding="utf-8")


def run_simulation(config: SimulationConfig) -> SimulationResult:
    init_db()
    init_auth_db()

    username = config.username or _generate_unique_username()
    password = config.password or _generate_password()
    _uid, username_norm = _create_auth_user(username, password)

    token = push_current_user_identity(username_norm)
    try:
        start_dt = datetime(config.start_date.year, config.start_date.month, config.start_date.day, 8, 0, 0)
        deck_id, _deck_name, real_source_id = _prepare_source_and_deck(
            source_id=config.source_id,
            stage=config.stage,
            start_dt=start_dt,
        )
        sim_stats = _simulate_history(
            deck_id=deck_id,
            start_date=config.start_date,
            end_date=config.end_date,
            intensity=config.intensity,
            seed=config.seed,
        )
        end_dt = datetime(config.end_date.year, config.end_date.month, config.end_date.day, 23, 59, 59)
        final_stats = _collect_stats(end_dt=end_dt)
        final_stats["study_days"] = int(sim_stats.get("study_days") or 0)
    finally:
        pop_current_user_identity(token)

    smoke = {"ok": True, "skipped": True}
    if not config.skip_http_check:
        smoke = _smoke_check_pages(username=username, password=password)

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    artifact_dir = config.artifact_root / f"{timestamp}-{username_norm}"
    settings = get_settings()
    result = SimulationResult(
        username=username,
        password=password,
        username_norm=username_norm,
        stage=config.stage,
        source_id=real_source_id,
        start_date=config.start_date.isoformat(),
        end_date=config.end_date.isoformat(),
        intensity=config.intensity,
        auth_db_path=str(settings.auth_db_path.resolve()),
        user_db_path=str(_user_db_path_for_identity(username_norm).resolve()),
        stats=final_stats,
        smoke_check=smoke,
        artifact_dir=str(artifact_dir.resolve()),
    )
    _write_artifacts(result)
    return result


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Create one junior student account and simulate 90-day FSRS history.")
    p.add_argument("--rollback", default="", help="Rollback by username (delete auth + user db).")
    p.add_argument("--username", default="", help="Username to create. Omit to auto-generate.")
    p.add_argument("--password", default="", help="Password to create. Omit to auto-generate.")
    p.add_argument("--stage", default="junior", choices=["junior"], help="Learning stage.")
    p.add_argument("--source-id", default="gen_xsc_2000", help="Wordbook source id.")
    p.add_argument("--start-date", default="2025-11-10", help="Simulation start date (YYYY-MM-DD).")
    p.add_argument("--end-date", default="2026-02-07", help="Simulation end date (YYYY-MM-DD).")
    p.add_argument("--intensity", default="medium", choices=["light", "medium", "high"], help="Study intensity.")
    p.add_argument("--seed", type=int, default=20260207, help="Random seed for reproducibility.")
    p.add_argument(
        "--artifact-root",
        default="artifacts/simulated_accounts",
        help="Artifact output root directory.",
    )
    p.add_argument("--skip-http-check", action="store_true", help="Skip login/page smoke check.")
    return p


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    if str(args.rollback or "").strip():
        out = rollback_account(str(args.rollback))
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    start = _parse_date(str(args.start_date))
    end = _parse_date(str(args.end_date))
    if end < start:
        raise ValueError("end_date must be >= start_date")

    cfg = SimulationConfig(
        username=str(args.username or "").strip() or None,
        password=str(args.password or "").strip() or None,
        stage=str(args.stage or "junior"),
        source_id=str(args.source_id or "gen_xsc_2000"),
        start_date=start,
        end_date=end,
        intensity=str(args.intensity or "medium"),
        seed=int(args.seed),
        artifact_root=Path(str(args.artifact_root)),
        skip_http_check=bool(args.skip_http_check),
    )
    result = run_simulation(cfg)
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
