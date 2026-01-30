from __future__ import annotations

from contextlib import contextmanager
import hashlib
from pathlib import Path
import re
from threading import Lock

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings
from app.request_context import get_current_user_identity


class Base(DeclarativeBase):
    pass


def _ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


_LOCK = Lock()
_ENGINES: dict[str, object] = {}
_SESSION_FACTORIES: dict[str, sessionmaker] = {}


_SAFE_FILE_CHARS_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _identity_to_db_filename(identity: str) -> str:
    norm = (identity or "").strip().lower()
    if not norm:
        return "user_local.db"
    safe = _SAFE_FILE_CHARS_RE.sub("_", norm.replace("@", "_at_"))
    safe = safe.strip("._-") or "user"
    digest = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:10]
    return f"{safe}_{digest}.db"


def _get_db_path_for_request() -> Path:
    settings = get_settings()
    if not settings.multiuser_by_identity:
        return settings.db_path

    identity = get_current_user_identity() or settings.dev_user_identity
    if not identity:
        return settings.db_path

    filename = _identity_to_db_filename(identity)
    return settings.user_db_dir / filename


def _ensure_factory_for_path(db_path: Path) -> sessionmaker:
    from app import models  # noqa: F401

    key = str(db_path.resolve())
    with _LOCK:
        factory = _SESSION_FACTORIES.get(key)
        if factory is not None:
            return factory

        _ensure_parent_dir(db_path)
        engine = create_engine(f"sqlite:///{db_path}", future=True)
        Base.metadata.create_all(engine)
        factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)
        _ENGINES[key] = engine
        _SESSION_FACTORIES[key] = factory
        return factory


def init_db() -> None:
    # Ensure default DB exists (for local single-user / CLI usage).
    settings = get_settings()
    _ensure_factory_for_path(settings.db_path)


@contextmanager
def get_session() -> Session:
    db_path = _get_db_path_for_request()
    factory = _ensure_factory_for_path(db_path)
    session: Session = factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
