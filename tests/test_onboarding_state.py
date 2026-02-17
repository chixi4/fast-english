from __future__ import annotations

from datetime import datetime, timedelta

from app.auth import hash_password
from app.auth_db import get_auth_session
from app.auth_models import AuthEvent, AuthOnboardingState, AuthUser
from app.db import get_session
from app.models import Deck, DeckWord, Mistake, Plan, Simulation, SrsCard, SrsReviewLog, Word
from app.wordbooks import get_source


def _register(client, username: str, password: str = "pass1234"):
    return client.post(
        "/auth/register",
        data={"username": username, "password": password, "password2": password, "next": "/"},
        follow_redirects=False,
    )


def test_register_creates_active_onboarding_state(client):
    resp = _register(client, "new_user_1")
    assert resp.status_code == 303
    assert "onboarding_entry=1" in (resp.headers.get("location") or "")

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
    assert data["current_step"]["target_selector"] == '[data-guide-anchor="self-first-review-home"]'
    assert data["next_href"] == "/review"
    assert data["prep_status"] in {"ready", "warming"}
    assert int(data["prep_eta_ms"]) >= 0


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
    assert data["next_href"] == "/worksheets"
    assert data["prep_status"] == "ready"
    assert int(data["prep_eta_ms"]) == 0


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


def test_onboarding_restart_resets_role_stage_selection(client):
    resp = _register(client, "new_user_restart_reset")
    assert resp.status_code == 303

    choose = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    restart = client.post("/api/onboarding/action", json={"action": "restart"})
    assert restart.status_code == 200
    data = restart.json()
    assert data["status"] == "active"
    assert data["role_selection_required"] is True
    assert data["stage_selection_required"] is False
    assert isinstance(data["current_step"], dict)
    assert data["current_step"]["key"] == "choose_role"


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


def test_self_try_mistakes_points_to_review_when_no_mistake(client):
    resp = _register(client, "new_user_nomistake")
    assert resp.status_code == 303
    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    state_resp = client.get("/api/onboarding/state")
    assert state_resp.status_code == 200
    data = state_resp.json()
    step_map = {s["key"]: s for s in data["steps"]}
    assert step_map["self_try_mistakes"]["href"] == "/review"


def test_self_try_mistakes_points_to_relax_once_when_only_once_mistakes(client):
    resp = _register(client, "new_user_once_only")
    assert resp.status_code == 303
    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    with get_session() as session:
        w = Word(term="once_only_term", definition="定义", example="")
        session.add(w)
        session.flush()
        session.add(Mistake(word_id=int(w.id)))

    state_resp = client.get("/api/onboarding/state")
    assert state_resp.status_code == 200
    data = state_resp.json()
    step_map = {s["key"]: s for s in data["steps"]}
    assert step_map["self_try_mistakes"]["href"] == "/mistakes?include_once=1&from_onboarding=1"


def test_self_try_mistakes_points_to_mistakes_when_visible_mistakes_exist(client):
    resp = _register(client, "new_user_visible_mistake")
    assert resp.status_code == 303
    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    with get_session() as session:
        w = Word(term="visible_mistake_term", definition="定义", example="")
        session.add(w)
        session.flush()
        session.add(Mistake(word_id=int(w.id)))
        session.add(Mistake(word_id=int(w.id)))

    state_resp = client.get("/api/onboarding/state")
    assert state_resp.status_code == 200
    data = state_resp.json()
    step_map = {s["key"]: s for s in data["steps"]}
    assert step_map["self_try_mistakes"]["href"] == "/mistakes"


def test_onboarding_review_still_shows_new_cards_when_daily_new_limit_is_zero(client):
    resp = _register(client, "new_user_review_limit0")
    assert resp.status_code == 303
    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    now = datetime.utcnow()
    with get_session() as session:
        plan = session.query(Plan).order_by(Plan.id.asc()).first()
        if plan is None:
            plan = Plan(name="默认计划", daily_new_limit=0, daily_review_limit=200, suspend_new_when_due_over=200)
            session.add(plan)
            session.flush()
        plan.daily_new_limit = 0
        plan.daily_review_limit = 200
        plan.suspend_new_when_due_over = 200

        d = Deck(name="review_limit0_deck", description="")
        session.add(d)
        session.flush()

        w = Word(term="review_limit0_term", definition="定义", example="")
        session.add(w)
        session.flush()

        session.add(DeckWord(deck_id=int(d.id), word_id=int(w.id), chapter="", position=1))
        session.add(SrsCard(word_id=int(w.id), due_at=now, last_reviewed_at=None))

    review_resp = client.get("/review")
    assert review_resp.status_code == 200
    html = review_resp.text
    assert "暂无到期卡片" not in html
    assert "review_limit0_term" in html


def test_review_onboarding_does_not_show_retry_prepare_button(client):
    resp = _register(client, "new_user_no_retry_btn")
    assert resp.status_code == 303
    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    review_resp = client.get("/review")
    assert review_resp.status_code == 200
    assert "重试准备" not in review_resp.text


def test_review_onboarding_kaoyan_shows_warming_with_fallback_actions(client):
    resp = _register(client, "new_user_kaoyan_warming")
    assert resp.status_code == 303

    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "kaoyan"})
    assert choose_stage.status_code == 200

    review_resp = client.get("/review")
    assert review_resp.status_code == 200
    html = review_resp.text
    assert "正在准备学习内容" in html
    assert "最长约 10 秒" in html
    assert "重新尝试" in html
    assert "返回首页" in html


def test_onboarding_review_falls_back_to_stage_cards_when_due_queue_empty(client):
    resp = _register(client, "new_user_due_empty_fallback")
    assert resp.status_code == 303

    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    source = get_source("gen_xsc_2000")
    deck_name = str(source.default_deck or "").strip() or "xsc_fallback_deck"

    now = datetime.utcnow()
    with get_session() as session:
        deck = session.query(Deck).filter(Deck.name == deck_name).first()
        if deck is None:
            deck = Deck(name=deck_name, description="")
            session.add(deck)
            session.flush()

        w = Word(term="future_due_term", definition="定义", example="")
        session.add(w)
        session.flush()
        session.add(DeckWord(deck_id=int(deck.id), word_id=int(w.id), chapter="", position=1))
        session.add(SrsCard(word_id=int(w.id), due_at=now + timedelta(days=3), last_reviewed_at=now))

    review_resp = client.get("/review")
    assert review_resp.status_code == 200
    html = review_resp.text
    assert "暂无到期卡片" not in html
    assert "future_due_term" in html


def test_home_redirects_to_review_when_self_mode_has_no_cards(client):
    resp = _register(client, "new_user_home_redirect")
    assert resp.status_code == 303

    home = client.get("/", follow_redirects=False)
    assert home.status_code in {302, 303, 307}
    location = home.headers.get("location") or ""
    assert location.startswith("/review")


def test_home_redirects_to_mistakes_during_self_onboarding_step(client):
    resp = _register(client, "new_user_home_step_redirect")
    assert resp.status_code == 303

    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    now = datetime.utcnow()
    with get_session() as session:
        w = Word(term="home_step_term", definition="定义", example="")
        session.add(w)
        session.flush()
        session.add(SrsCard(word_id=int(w.id), due_at=now, last_reviewed_at=now))
        session.add(SrsReviewLog(word_id=int(w.id), rating=3, reviewed_at=now, duration_ms=600))
        session.add(Mistake(word_id=int(w.id)))
        session.add(Mistake(word_id=int(w.id)))

    home = client.get("/", follow_redirects=False)
    assert home.status_code in {302, 303, 307}
    location = home.headers.get("location") or ""
    assert location.startswith("/mistakes")


def test_review_done_card_uses_relax_once_mistakes_link_in_onboarding(client):
    resp = _register(client, "new_user_review_done_mistake_link")
    assert resp.status_code == 303

    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    with get_session() as session:
        w = Word(term="review_done_once_mistake", definition="定义", example="")
        session.add(w)
        session.flush()
        session.add(Mistake(word_id=int(w.id)))
        session.add(SrsCard(word_id=int(w.id), due_at=datetime.utcnow()))

    review_resp = client.get("/review")
    assert review_resp.status_code == 200
    assert "include_once=1" in review_resp.text
    assert "from_onboarding=1" in review_resp.text
