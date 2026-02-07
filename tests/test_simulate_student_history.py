from __future__ import annotations

import importlib
import os
from datetime import date, datetime
from pathlib import Path

from app.auth_db import get_auth_session
from app.auth_models import AuthUser


def _load_sim_module(tmp_path: Path):
    os.environ["APP_DB_PATH"] = str(tmp_path / "app.db")
    os.environ["APP_AUTH_DB_PATH"] = str(tmp_path / "auth.db")
    os.environ["APP_USER_DB_DIR"] = str(tmp_path / "userdb")
    os.environ["APP_MULTIUSER_BY_IDENTITY"] = "1"
    os.environ["APP_REQUIRE_LOGIN"] = "0"
    os.environ["APP_DEV_USER_IDENTITY"] = ""
    os.environ["AI_MOCK"] = "1"
    os.environ["AI_API_KEY"] = ""
    os.environ["APP_BASIC_AUTH_USER"] = ""
    os.environ["APP_BASIC_AUTH_PASS"] = ""

    mod = importlib.import_module("tools.simulate_student_history")
    mod = importlib.reload(mod)
    return mod


def test_simulate_history_and_rollback(tmp_path: Path, monkeypatch):
    sim = _load_sim_module(tmp_path)

    def _fake_prepare_source_and_deck(*, source_id: str, stage: str, start_dt: datetime):
        _ = source_id
        _ = stage
        with sim.get_session() as session:
            deck = session.query(sim.Deck).filter(sim.Deck.name == "小升初/初中基础（高频精选）").first()
            if deck is None:
                deck = sim.Deck(name="小升初/初中基础（高频精选）", description="")
                session.add(deck)
                session.flush()
                words = [
                    sim.Word(term=f"junior_term_{i}", definition=f"def_{i}", example="", tags="junior")
                    for i in range(1, 2401)
                ]
                session.add_all(words)
                session.flush()
                links = [
                    sim.DeckWord(deck_id=int(deck.id), word_id=int(w.id), chapter="", position=idx)
                    for idx, w in enumerate(words, start=1)
                ]
                session.add_all(links)
            deck_id = int(deck.id)

            # 预置 200 张初始卡，确保首日可学。
            for _ in range(5):
                _name, added, _remaining = sim.main_app._add_next_words_to_plan(session, deck_id=deck_id, count=40)
                if int(added or 0) <= 0:
                    break
            session.query(sim.SrsCard).filter(
                sim.SrsCard.word_id.in_(
                    session.query(sim.DeckWord.word_id).filter(sim.DeckWord.deck_id == deck_id)
                )
            ).update({sim.SrsCard.due_at: start_dt}, synchronize_session=False)
            session.flush()
        return deck_id, "小升初/初中基础（高频精选）", "gen_xsc_2000"

    monkeypatch.setattr(sim, "_prepare_source_and_deck", _fake_prepare_source_and_deck)

    cfg = sim.SimulationConfig(
        username="sim_test_junior_001",
        password="SimTest#1234",
        stage="junior",
        source_id="gen_xsc_2000",
        start_date=date(2025, 11, 10),
        end_date=date(2026, 2, 7),
        intensity="medium",
        seed=20260207,
        artifact_root=tmp_path / "artifacts",
        skip_http_check=True,
    )
    result = sim.run_simulation(cfg)

    assert result.username == "sim_test_junior_001"
    assert result.stats["review_logs"] > 1500
    assert result.stats["reviewed_words"] > 300
    assert Path(result.artifact_dir).exists()
    assert (Path(result.artifact_dir) / "SUMMARY.md").exists()
    assert (Path(result.artifact_dir) / "session.json").exists()

    with get_auth_session() as session:
        user = session.query(AuthUser).filter(AuthUser.username_norm == result.username_norm).first()
        assert user is not None

    rolled = sim.rollback_account(result.username)
    assert rolled["ok"] is True
    assert rolled["removed_user"] is True

    with get_auth_session() as session:
        user = session.query(AuthUser).filter(AuthUser.username_norm == result.username_norm).first()
        assert user is None
