from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class AuthBase(DeclarativeBase):
    pass


class AuthUser(AuthBase):
    __tablename__ = "auth_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64))
    username_norm: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AuthEvent(AuthBase):
    __tablename__ = "auth_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    user_id: Mapped[int] = mapped_column(Integer, index=True)
    username_norm: Mapped[str] = mapped_column(String(64), index=True)

    kind: Mapped[str] = mapped_column(String(32), index=True)  # e.g. page_view, action, api, error
    path: Mapped[str] = mapped_column(String(256), index=True)
    method: Mapped[str] = mapped_column(String(8))
    status_code: Mapped[int] = mapped_column(Integer)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    meta_json: Mapped[str] = mapped_column(String(8000), default="{}")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class AuthOnboardingState(AuthBase):
    __tablename__ = "auth_onboarding_states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    username_norm: Mapped[str] = mapped_column(String(64), index=True)

    guide_version: Mapped[int] = mapped_column(Integer, default=1)
    # active | snoozed | dismissed | done
    status: Mapped[str] = mapped_column(String(16), default="active")
    snooze_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
