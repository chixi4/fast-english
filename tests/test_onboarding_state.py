from __future__ import annotations

from datetime import datetime

from app.auth import hash_password
from app.auth_db import get_auth_session
from app.auth_models import AuthEvent, AuthOnboardingState, AuthUser
from app.db import get_session
from app.models import Deck, DeckWord, Simulation, SrsCard, SrsReviewLog, Word


def _register(client, username: str, password: str = "pass1234"):
    return client.post(
        "/auth/register",
        data={"username": username, "password": password, "password2": password, "next": "/"},
        follow_redirects=False,
    )


def test_register_creates_active_onboarding_state(client):
    resp = _register(client, "new_user_1")
    assert resp.status_code == 303

    with get_auth_session() as session:
        row = (
            session.query(AuthOnboardingState)
            .filter(AuthOnboardingState.username_norm == "new_user_1")
            .first()
        )
        assert row is not None
        assert row.status == "active"
        assert int(row.guide_version or 0) == 2


def test_onboarding_state_requires_role_selection_for_new_user(client):
    resp = _register(client, "new_user_2")
    assert resp.status_code == 303

    state_resp = client.get("/api/onboarding/state")
    assert state_resp.status_code == 200
    data = state_resp.json()
    assert data["enabled"] is True
    assert data["status"] == "active"
    assert data["role_selection_required"] is True
    assert data["entry_role"] == ""
    assert data["current_step"]["key"] == "choose_role"


def test_choose_role_self_sets_self_flow(client):
    resp = _register(client, "new_user_3")
    assert resp.status_code == 303

    choose = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose.status_code == 200
    data = choose.json()

    assert data["flow"] == "self"
    assert data["entry_role"] == "self"
    assert data["role_selection_required"] is False
    assert data["stage_selection_required"] is True
    assert data["current_step"]["key"] == "choose_stage"
    assert "vs_mode=self" in (choose.headers.get("set-cookie") or "")


def test_choose_role_parent_sets_cookie_and_parent_flow(client):
    resp = _register(client, "new_user_4")
    assert resp.status_code == 303

    choose = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "parent"})
    assert choose.status_code == 200
    data = choose.json()

    assert data["flow"] == "parent"
    assert data["entry_role"] == "parent"
    assert data["role_selection_required"] is False
    assert data["stage_selection_required"] is True
    assert data["current_step"]["key"] == "choose_stage"
    assert "vs_mode=parent" in (choose.headers.get("set-cookie") or "")

    step_map = {s["key"]: s for s in data["steps"]}
    assert step_map["parent_switch_mode"]["done"] is True


def test_choose_stage_unblocks_next_step_for_self_flow(client):
    resp = _register(client, "new_user_4b")
    assert resp.status_code == 303

    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200
    data = choose_stage.json()
    assert data["flow"] == "self"
    assert data["stage_selection_required"] is False
    assert data["selected_stage"] == "junior"
    assert data["current_step"]["key"] == "self_first_review"


def test_choose_stage_unblocks_next_step_for_parent_flow(client):
    resp = _register(client, "new_user_4c")
    assert resp.status_code == 303

    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "parent"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "primary"})
    assert choose_stage.status_code == 200
    data = choose_stage.json()
    assert data["flow"] == "parent"
    assert data["stage_selection_required"] is False
    assert data["selected_stage"] == "primary"
    assert "vs_mode=parent" in (choose_stage.headers.get("set-cookie") or "")


def test_onboarding_actions_snooze_dismiss_restart(client):
    resp = _register(client, "new_user_5")
    assert resp.status_code == 303

    snooze = client.post("/api/onboarding/action", json={"action": "snooze", "hours": 12})
    assert snooze.status_code == 200
    snooze_data = snooze.json()
    assert snooze_data["status"] == "snoozed"
    assert snooze_data["show"] is False

    dismiss = client.post("/api/onboarding/action", json={"action": "dismiss"})
    assert dismiss.status_code == 200
    dismiss_data = dismiss.json()
    assert dismiss_data["status"] == "dismissed"
    assert dismiss_data["show"] is False

    restart = client.post("/api/onboarding/action", json={"action": "restart"})
    assert restart.status_code == 200
    restart_data = restart.json()
    assert restart_data["status"] == "active"


def test_old_user_without_state_defaults_to_done_when_has_learning_data(client):
    with get_auth_session() as session:
        user = AuthUser(username="legacy_user", username_norm="legacy_user", password_hash=hash_password("pass1234"))
        session.add(user)

    with get_session() as session:
        d = Deck(name="legacy deck", description="")
        session.add(d)

    login = client.post(
        "/auth/login",
        data={"username": "legacy_user", "password": "pass1234", "next": "/"},
        follow_redirects=False,
    )
    assert login.status_code == 303

    state_resp = client.get("/api/onboarding/state")
    assert state_resp.status_code == 200
    data = state_resp.json()
    assert data["status"] == "done"
    assert data["show"] is False
    assert data["role_selection_required"] is False
    assert data["stage_selection_required"] is False

    with get_auth_session() as session:
        row = (
            session.query(AuthOnboardingState)
            .filter(AuthOnboardingState.username_norm == "legacy_user")
            .first()
        )
        assert row is not None
        assert row.status == "done"


def test_self_steps_complete_then_auto_mark_done(client):
    resp = _register(client, "new_user_6")
    assert resp.status_code == 303
    choose = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    now = datetime.utcnow()
    with get_session() as session:
        w = Word(term="term_auto_done", definition="定义", example="")
        session.add(w)
        session.flush()

        d = Deck(name="deck_auto_done", description="")
        session.add(d)
        session.flush()

        session.add(DeckWord(deck_id=int(d.id), word_id=int(w.id), chapter="", position=1))
        session.add(SrsCard(word_id=int(w.id), due_at=now, last_reviewed_at=now))
        session.add(SrsReviewLog(word_id=int(w.id), rating=3, reviewed_at=now, duration_ms=1000))
        session.add(
            Simulation(
                level="cet4",
                target_terms_json='["term_auto_done"]',
                passage="p",
                questions_json='{"questions":[]}',
            )
        )

    with get_auth_session() as session:
        user = session.query(AuthUser).filter(AuthUser.username_norm == "new_user_6").first()
        assert user is not None
        session.add(
            AuthEvent(
                user_id=int(user.id),
                username_norm="new_user_6",
                kind="page_view",
                path="/dashboard",
                method="GET",
                status_code=200,
                duration_ms=1,
                meta_json="{}",
            )
        )

    state_resp = client.get("/api/onboarding/state")
    assert state_resp.status_code == 200
    data = state_resp.json()
    assert data["summary"]["done"] == 3
    assert data["summary"]["total"] == 3
    assert data["status"] == "done"
