from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Word(Base):
    __tablename__ = "words"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    term: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    definition: Mapped[str] = mapped_column(Text, default="")
    example: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[str] = mapped_column(String(256), default="")

    correct_count: Mapped[int] = mapped_column(Integer, default=0)
    wrong_count: Mapped[int] = mapped_column(Integer, default=0)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    mistakes: Mapped[list["Mistake"]] = relationship(back_populates="word", cascade="all, delete-orphan")
    srs_card: Mapped["SrsCard | None"] = relationship(back_populates="word", cascade="all, delete-orphan", uselist=False)
    deck_links: Mapped[list["DeckWord"]] = relationship(back_populates="word", cascade="all, delete-orphan")


class Mistake(Base):
    __tablename__ = "mistakes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    word_id: Mapped[int] = mapped_column(ForeignKey("words.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    word: Mapped[Word] = relationship(back_populates="mistakes")


class Simulation(Base):
    __tablename__ = "simulations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    level: Mapped[str] = mapped_column(String(32))
    target_terms_json: Mapped[str] = mapped_column(Text)  # JSON list[str]
    passage: Mapped[str] = mapped_column(Text)
    questions_json: Mapped[str] = mapped_column(Text)  # JSON list[question]
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Deck(Base):
    __tablename__ = "decks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    word_links: Mapped[list["DeckWord"]] = relationship(back_populates="deck", cascade="all, delete-orphan")


class DeckWord(Base):
    __tablename__ = "deck_words"
    __table_args__ = (UniqueConstraint("deck_id", "word_id", name="uq_deck_word"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    deck_id: Mapped[int] = mapped_column(ForeignKey("decks.id"), index=True)
    word_id: Mapped[int] = mapped_column(ForeignKey("words.id"), index=True)

    chapter: Mapped[str] = mapped_column(String(64), default="")
    position: Mapped[int] = mapped_column(Integer, default=0)
    added_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    deck: Mapped[Deck] = relationship(back_populates="word_links")
    word: Mapped[Word] = relationship(back_populates="deck_links")


class SrsCard(Base):
    __tablename__ = "srs_cards"

    word_id: Mapped[int] = mapped_column(ForeignKey("words.id"), primary_key=True)
    state: Mapped[int] = mapped_column(Integer, default=1)  # fsrs.State int value
    step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stability: Mapped[float | None] = mapped_column(Float, nullable=True)
    difficulty: Mapped[float | None] = mapped_column(Float, nullable=True)
    due_at: Mapped[datetime] = mapped_column(DateTime, index=True, server_default=func.now())
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    word: Mapped[Word] = relationship(back_populates="srs_card")
    review_logs: Mapped[list["SrsReviewLog"]] = relationship(back_populates="card", cascade="all, delete-orphan")


class SrsReviewLog(Base):
    __tablename__ = "srs_review_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    word_id: Mapped[int] = mapped_column(ForeignKey("srs_cards.word_id"), index=True)
    rating: Mapped[int] = mapped_column(Integer)  # fsrs.Rating int value
    reviewed_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    card: Mapped[SrsCard] = relationship(back_populates="review_logs")


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), unique=True, index=True)

    daily_new_limit: Mapped[int] = mapped_column(Integer, default=20)
    daily_review_limit: Mapped[int] = mapped_column(Integer, default=200)
    suspend_new_when_due_over: Mapped[int] = mapped_column(Integer, default=200)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    deck_links: Mapped[list["PlanDeck"]] = relationship(back_populates="plan", cascade="all, delete-orphan")
    word_links: Mapped[list["PlanWord"]] = relationship(back_populates="plan", cascade="all, delete-orphan")


class PlanDeck(Base):
    __tablename__ = "plan_decks"
    __table_args__ = (UniqueConstraint("plan_id", "deck_id", name="uq_plan_deck"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    deck_id: Mapped[int] = mapped_column(ForeignKey("decks.id"), index=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    plan: Mapped[Plan] = relationship(back_populates="deck_links")
    deck: Mapped[Deck] = relationship()


class PlanWord(Base):
    __tablename__ = "plan_words"
    __table_args__ = (UniqueConstraint("plan_id", "word_id", name="uq_plan_word"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    plan_id: Mapped[int] = mapped_column(ForeignKey("plans.id"), index=True)
    word_id: Mapped[int] = mapped_column(ForeignKey("words.id"), index=True)
    source_deck_id: Mapped[int | None] = mapped_column(ForeignKey("decks.id"), index=True, nullable=True)

    status: Mapped[str] = mapped_column(String(16), default="active")  # active|paused|done
    added_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    plan: Mapped[Plan] = relationship(back_populates="word_links")
    word: Mapped[Word] = relationship()
    source_deck: Mapped[Deck | None] = relationship(foreign_keys=[source_deck_id])
