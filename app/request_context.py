from __future__ import annotations

from contextvars import ContextVar, Token


_USER_IDENTITY: ContextVar[str | None] = ContextVar("user_identity", default=None)


def push_current_user_identity(identity: str | None) -> Token[str | None]:
    identity = (identity or "").strip()
    return _USER_IDENTITY.set(identity or None)


def get_current_user_identity() -> str | None:
    return _USER_IDENTITY.get()


def pop_current_user_identity(token: Token[str | None]) -> None:
    _USER_IDENTITY.reset(token)
