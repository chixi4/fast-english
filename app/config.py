from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


@dataclass(frozen=True)
class Settings:
    db_path: Path
    user_db_dir: Path
    multiuser_by_identity: bool
    dev_user_identity: str | None
    auth_db_path: Path
    auth_secret_key: str | None
    auth_cookie_name: str
    auth_cookie_days: int
    require_login: bool
    ai_api_key: str | None
    ai_base_url: str
    ai_model: str
    ai_mock: bool
    basic_auth_user: str | None
    basic_auth_pass: str | None
    basic_auth_realm: str


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def get_settings() -> Settings:
    db_path = Path(os.getenv("APP_DB_PATH", "data/app.db"))
    user_db_dir = Path(os.getenv("APP_USER_DB_DIR", "data/userdb"))
    multiuser_by_identity = _env_bool("APP_MULTIUSER_BY_IDENTITY", _env_bool("APP_MULTIUSER_BY_EMAIL", True))
    dev_user_identity = os.getenv("APP_DEV_USER_IDENTITY") or (os.getenv("APP_DEV_USER_EMAIL") or None)
    auth_db_path = Path(os.getenv("APP_AUTH_DB_PATH", "data/auth.db"))
    auth_secret_key = os.getenv("APP_AUTH_SECRET_KEY") or None
    auth_cookie_name = (os.getenv("APP_AUTH_COOKIE_NAME", "vs_session") or "vs_session").strip()
    try:
        auth_cookie_days = int(os.getenv("APP_AUTH_COOKIE_DAYS", "30"))
    except Exception:
        auth_cookie_days = 30
    require_login = _env_bool("APP_REQUIRE_LOGIN", True)
    ai_api_key = os.getenv("AI_API_KEY") or None
    ai_base_url = os.getenv("AI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    ai_model = os.getenv("AI_MODEL", "gpt-4o-mini")
    ai_mock = _env_bool("AI_MOCK", False)
    basic_auth_user = os.getenv("APP_BASIC_AUTH_USER") or None
    basic_auth_pass = os.getenv("APP_BASIC_AUTH_PASS") or None
    basic_auth_realm = os.getenv("APP_BASIC_AUTH_REALM", "Vocabulary Study").strip() or "Vocabulary Study"
    return Settings(
        db_path=db_path,
        user_db_dir=user_db_dir,
        multiuser_by_identity=multiuser_by_identity,
        dev_user_identity=dev_user_identity,
        auth_db_path=auth_db_path,
        auth_secret_key=auth_secret_key,
        auth_cookie_name=auth_cookie_name,
        auth_cookie_days=auth_cookie_days,
        require_login=require_login,
        ai_api_key=ai_api_key,
        ai_base_url=ai_base_url,
        ai_model=ai_model,
        ai_mock=ai_mock,
        basic_auth_user=basic_auth_user,
        basic_auth_pass=basic_auth_pass,
        basic_auth_realm=basic_auth_realm,
    )
