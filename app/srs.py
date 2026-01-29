from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os

from fsrs import Card, Rating, Scheduler, State

from app.models import SrsCard


def _to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _to_naive_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return _to_utc(dt).replace(tzinfo=None)


def _to_aware_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return _to_utc(dt)


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def get_scheduler() -> Scheduler:
    desired_retention = _env_float("SRS_DESIRED_RETENTION", 0.9)
    return Scheduler(desired_retention=desired_retention)


@dataclass(frozen=True)
class ReviewedResult:
    card: Card
    rating: Rating
    reviewed_at_utc: datetime
    duration_ms: int | None


def db_card_to_fsrs(row: SrsCard) -> Card:
    due = _to_aware_utc(row.due_at) or datetime.now(timezone.utc)
    last_review = _to_aware_utc(row.last_reviewed_at)
    return Card(
        card_id=int(row.word_id),
        state=State(int(row.state)),
        step=row.step,
        stability=row.stability,
        difficulty=row.difficulty,
        due=due,
        last_review=last_review,
    )


def apply_fsrs_to_db(row: SrsCard, card: Card) -> None:
    row.state = int(card.state.value)
    row.step = card.step
    row.stability = card.stability
    row.difficulty = card.difficulty
    row.due_at = _to_naive_utc(card.due) or row.due_at
    row.last_reviewed_at = _to_naive_utc(card.last_review) if card.last_review else row.last_reviewed_at


def parse_rating(raw: str) -> Rating:
    key = (raw or "").strip().lower()
    mapping = {
        "again": Rating.Again,
        "hard": Rating.Hard,
        "good": Rating.Good,
        "easy": Rating.Easy,
        "1": Rating.Again,
        "2": Rating.Hard,
        "3": Rating.Good,
        "4": Rating.Easy,
    }
    if key not in mapping:
        raise ValueError("invalid rating")
    return mapping[key]

