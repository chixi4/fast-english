from __future__ import annotations

from app.db import get_session
from app.models import Mistake, MistakePracticeSettings, Word


def _get_pref_row() -> MistakePracticeSettings:
    with get_session() as session:
        row = session.query(MistakePracticeSettings).filter(MistakePracticeSettings.owner_norm == "__default__").first()
        assert row is not None
        return row


def _seed_mistakes(n: int, events_per_word: int = 2) -> None:
    with get_session() as session:
        for i in range(n):
            w = Word(term=f"pref_term_{i}", definition=f"pref_def_{i}", example="")
            session.add(w)
            session.flush()
            for _ in range(max(1, events_per_word)):
                session.add(Mistake(word_id=int(w.id)))


def test_mistakes_visit_creates_default_preference(client):
    resp = client.get("/mistakes")
    assert resp.status_code == 200

    row = _get_pref_row()
    assert row.default_level == "auto"
    assert row.default_length_mode == "standard"
    assert int(row.default_include_once) == 0
    assert int(row.use_fixed_target_count) == 0
    assert row.default_target_count is None


def test_save_mistake_settings_with_validation_and_fallback(client):
    resp = client.post(
        "/settings/mistakes",
        data={
            "default_level": "invalid-level",
            "default_length_mode": "invalid-mode",
            "default_include_once": "1",
            "use_fixed_target_count": "1",
            "default_target_count": "99",
        },
        follow_redirects=False,
    )
    assert resp.status_code == 303

    row = _get_pref_row()
    assert row.default_level == "auto"
    assert row.default_length_mode == "standard"
    assert int(row.default_include_once) == 1
    assert int(row.use_fixed_target_count) == 1
    assert int(row.default_target_count or 0) == 14

    resp2 = client.post(
        "/settings/mistakes",
        data={
            "default_level": "cet6",
            "default_length_mode": "long",
            "default_include_once": "0",
            "default_target_count": "6",
        },
        follow_redirects=False,
    )
    assert resp2.status_code == 303

    row2 = _get_pref_row()
    assert row2.default_level == "cet6"
    assert row2.default_length_mode == "long"
    assert int(row2.default_include_once) == 0
    assert int(row2.use_fixed_target_count) == 0
    assert row2.default_target_count is None


def test_mistakes_query_priority_overrides_saved_defaults(client):
    resp = client.post(
        "/settings/mistakes",
        data={
            "default_level": "senior",
            "default_length_mode": "long",
            "default_include_once": "1",
            "use_fixed_target_count": "1",
            "default_target_count": "12",
        },
        follow_redirects=False,
    )
    assert resp.status_code == 303

    _seed_mistakes(6)

    page = client.get("/mistakes")
    assert page.status_code == 200
    html = page.text
    assert 'name="level" value="senior"' in html
    assert 'name="target_count" id="generateTargetCount" value="12"' in html
    assert 'name="length_mode" value="long"' in html
    assert 'id="includeOnceHidden"' not in html
    assert 'id="useFixedTargetCountHidden"' not in html

    page2 = client.get("/mistakes?level=junior&length_mode=standard&include_once=0&use_fixed_target_count=0")
    assert page2.status_code == 200
    html2 = page2.text
    assert 'name="level" value="junior"' in html2
    assert 'name="target_count" id="generateTargetCount" value="8"' in html2
    assert 'name="length_mode" value="standard"' in html2
    assert 'id="includeOnceHidden"' not in html2
    assert 'id="useFixedTargetCountHidden"' not in html2


def test_generate_endpoints_still_work_without_manual_word_ids(client):
    with get_session() as session:
        words: list[Word] = []
        for i in range(6):
            w = Word(term=f"auto_term_{i}", definition=f"def_{i}", example="")
            session.add(w)
            session.flush()
            session.add(Mistake(word_id=int(w.id)))
            words.append(w)

    resp = client.post(
        "/simulations/generate",
        data={"level": "cet4", "target_count": "6", "length_mode": "standard", "word_ids": ""},
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert (resp.headers.get("location") or "").startswith("/simulations/")

    stream_resp = client.post(
        "/simulations/generate_stream",
        data={"level": "cet4", "target_count": "6", "length_mode": "standard", "word_ids": ""},
    )
    assert stream_resp.status_code == 200
    assert "text/event-stream" in (stream_resp.headers.get("content-type") or "")
    assert '"t": "done"' in stream_resp.text
