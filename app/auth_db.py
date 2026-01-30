from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.auth_models import AuthBase
from app.config import get_settings


def _ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


_ENGINE = None
_SESSION_FACTORY: sessionmaker | None = None


def init_auth_db() -> None:
    from app import auth_models  # noqa: F401

    global _ENGINE, _SESSION_FACTORY
    settings = get_settings()
    _ensure_parent_dir(settings.auth_db_path)
    _ENGINE = create_engine(f"sqlite:///{settings.auth_db_path}", future=True)
    AuthBase.metadata.create_all(_ENGINE)
    _SESSION_FACTORY = sessionmaker(
        bind=_ENGINE, autoflush=False, autocommit=False, expire_on_commit=False, future=True
    )


@contextmanager
def get_auth_session() -> Session:
    global _SESSION_FACTORY
    if _SESSION_FACTORY is None:
        init_auth_db()
    assert _SESSION_FACTORY is not None
    session: Session = _SESSION_FACTORY()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

