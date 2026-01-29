from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


@dataclass(frozen=True)
class Settings:
    db_path: Path
    ai_api_key: str | None
    ai_base_url: str
    ai_model: str
    ai_mock: bool


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def get_settings() -> Settings:
    db_path = Path(os.getenv("APP_DB_PATH", "data/app.db"))
    ai_api_key = os.getenv("AI_API_KEY") or None
    ai_base_url = os.getenv("AI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    ai_model = os.getenv("AI_MODEL", "gpt-4o-mini")
    ai_mock = _env_bool("AI_MOCK", False)
    return Settings(
        db_path=db_path,
        ai_api_key=ai_api_key,
        ai_base_url=ai_base_url,
        ai_model=ai_model,
        ai_mock=ai_mock,
    )

