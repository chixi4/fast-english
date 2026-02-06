from __future__ import annotations

import json

from app.db import get_session
from app.models import Mistake, Simulation, SrsCard, SrsReviewLog, Word


def test_simulation_grading_writes_back_fsrs_and_mistakes(client):
    with get_session() as session:
        w1 = Word(term="camp", definition="露营", example="We [[camp]] here.")
        w2 = Word(term="body", definition="身体", example="Your [[body]] is strong.")
        session.add_all([w1, w2])
        session.flush()

        # Ensure cards exist so due/last_reviewed_at can change.
        session.add_all([SrsCard(word_id=int(w1.id)), SrsCard(word_id=int(w2.id))])

        questions = [
            {
                "id": "q1",
                "stem": "Q1",
                "choices": ["A", "B", "C", "D"],
                "answer_index": 0,
                "explanation": "x",
                "target_term": "camp",
            },
            {
                "id": "q2",
                "stem": "Q2",
                "choices": ["A", "B", "C", "D"],
                "answer_index": 1,
                "explanation": "y",
                "target_term": "body",
            },
        ]
        payload = {"questions": questions, "term_word_map": {"camp": int(w1.id), "body": int(w2.id)}}
        sim = Simulation(
            level="junior",
            target_terms_json=json.dumps(["camp", "body"], ensure_ascii=False),
            passage="hello [[camp]] [[body]]",
            questions_json=json.dumps(payload, ensure_ascii=False),
        )
        session.add(sim)
        session.flush()
        sim_id = int(sim.id)

    # q1 correct, q2 wrong -> camp=Good, body=Again
    resp = client.post(f"/simulations/{sim_id}/grade_async", data={"q1": "0", "q2": "0"})
    assert resp.status_code == 200

    with get_session() as session:
        w1r = session.query(Word).filter(Word.term == "camp").one()
        w2r = session.query(Word).filter(Word.term == "body").one()

        assert int(w1r.correct_count) == 1
        assert int(w1r.wrong_count) == 0
        assert int(w2r.correct_count) == 0
        assert int(w2r.wrong_count) == 1

        assert session.query(Mistake).filter(Mistake.word_id == int(w1r.id)).count() == 0
        assert session.query(Mistake).filter(Mistake.word_id == int(w2r.id)).count() == 1

        assert session.query(SrsReviewLog).filter(SrsReviewLog.word_id == int(w1r.id)).count() == 1
        assert session.query(SrsReviewLog).filter(SrsReviewLog.word_id == int(w2r.id)).count() == 1

        c1 = session.get(SrsCard, int(w1r.id))
        c2 = session.get(SrsCard, int(w2r.id))
        assert c1 is not None and c1.last_reviewed_at is not None
        assert c2 is not None and c2.last_reviewed_at is not None

