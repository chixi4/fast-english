from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def _ensure_parent_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def get_engine():
    settings = get_settings()
    _ensure_parent_dir(settings.db_path)
    return create_engine(f"sqlite:///{settings.db_path}", future=True)


_ENGINE = None
_SESSION_FACTORY = None


def init_db() -> None:
    from app import models  # noqa: F401

    global _ENGINE, _SESSION_FACTORY
    _ENGINE = get_engine()
    Base.metadata.create_all(_ENGINE)
    _SESSION_FACTORY = sessionmaker(
        bind=_ENGINE, autoflush=False, autocommit=False, expire_on_commit=False, future=True
    )


@contextmanager
def get_session() -> Session:
    if _SESSION_FACTORY is None:
        init_db()
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
