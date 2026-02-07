from __future__ import annotations

from datetime import datetime

from app.db import get_session
from app.models import Mistake, MistakePracticeSettings, SrsReviewLog, Word


def _register(client, username: str, password: str = "pass1234"):
    return client.post(
        "/auth/register",
        data={"username": username, "password": password, "password2": password, "next": "/"},
        follow_redirects=False,
    )


def test_mistake_aggregate_sorting_and_threshold(main_module):
    with get_session() as session:
        w1 = Word(term="apple", definition="苹果", example="")
        w2 = Word(term="banana", definition="香蕉", example="")
        session.add_all([w1, w2])
        session.flush()

        # w1: more frequent but older
        session.add_all(
            [
                Mistake(word_id=int(w1.id), created_at=datetime(2026, 2, 1, 0, 0, 0)),
                Mistake(word_id=int(w1.id), created_at=datetime(2026, 2, 2, 0, 0, 0)),
                Mistake(word_id=int(w1.id), created_at=datetime(2026, 2, 3, 0, 0, 0)),
            ]
        )
        # w2: less frequent but more recent
        session.add_all(
            [
                Mistake(word_id=int(w2.id), created_at=datetime(2026, 2, 5, 0, 0, 0)),
                Mistake(word_id=int(w2.id), created_at=datetime(2026, 2, 6, 0, 0, 0)),
            ]
        )

    with get_session() as session:
        out_freq = main_module._query_mistake_aggregates(session, min_events=2, sort="freq", limit=10)
        assert [it["word"].term for it in out_freq[:2]] == ["apple", "banana"]

        out_time = main_module._query_mistake_aggregates(session, min_events=2, sort="time", limit=10)
        assert [it["word"].term for it in out_time[:2]] == ["banana", "apple"]

        out_min3 = main_module._query_mistake_aggregates(session, min_events=3, sort="freq", limit=10)
        assert len(out_min3) == 1
        assert out_min3[0]["word"].term == "apple"


def test_mistakes_page_uses_saved_defaults_when_query_absent(client):
    with get_session() as session:
        row = session.query(MistakePracticeSettings).filter(MistakePracticeSettings.owner_norm == "__default__").first()
        if row is None:
            row = MistakePracticeSettings(owner_norm="__default__")
            session.add(row)
            session.flush()
        row.default_level = "cet4"
        row.default_length_mode = "long"
        row.default_include_once = 1
        row.use_fixed_target_count = 1
        row.default_target_count = 11

        for i in range(6):
            w = Word(term=f"agg_pref_term_{i}", definition=f"agg_pref_def_{i}", example="")
            session.add(w)
            session.flush()
            session.add(Mistake(word_id=int(w.id)))

    resp = client.get("/mistakes")
    assert resp.status_code == 200
    html = resp.text
    assert 'name="level" value="cet4"' in html
    assert 'name="target_count" id="generateTargetCount" value="11"' in html
    assert 'name="length_mode" value="long"' in html


def test_mistakes_empty_state_shows_onboarding_relax_once_action(client):
    reg = _register(client, "mistake_onboarding_user")
    assert reg.status_code == 303
    choose_role = client.post("/api/onboarding/action", json={"action": "choose_role", "role": "self"})
    assert choose_role.status_code == 200
    choose_stage = client.post("/api/onboarding/action", json={"action": "choose_stage", "stage": "junior"})
    assert choose_stage.status_code == 200

    with get_session() as session:
        w = Word(term="mistake_once_only", definition="定义", example="")
        session.add(w)
        session.flush()
        session.add(Mistake(word_id=int(w.id)))
        # 先完成学生第一步，确保当前引导步骤推进到 self_try_mistakes。
        session.add(SrsReviewLog(word_id=int(w.id), rating=3, reviewed_at=datetime(2026, 2, 7, 0, 0, 0), duration_ms=900))

    resp = client.get("/mistakes", follow_redirects=False)
    assert resp.status_code in {302, 303, 307}
    assert (resp.headers.get("location") or "").startswith("/mistakes?include_once=1&from_onboarding=1")

    final = client.get("/mistakes?include_once=1&from_onboarding=1")
    assert final.status_code == 200
    html = final.text
    assert "按当前错词开始练习（本次含错1次）" not in html
    assert "高级设置（仅当前页）" not in html
