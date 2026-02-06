from __future__ import annotations

from datetime import datetime

from app.db import get_session
from app.models import Mistake, MistakePracticeSettings, Word


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
