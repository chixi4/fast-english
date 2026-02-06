from __future__ import annotations

import json

from app.db import get_session
from app.models import Worksheet, Word


def _enable_parent_mode(client) -> None:
    client.cookies.set("vs_mode", "parent")


def _create_words(n: int = 6) -> list[int]:
    with get_session() as session:
        ids: list[int] = []
        for i in range(n):
            w = Word(term=f"w{i+1}", definition=f"释义{i+1}", example="")
            session.add(w)
            session.flush()
            ids.append(int(w.id))
        return ids


def test_worksheet_can_generate_reading_section_in_mock_mode(client):
    _enable_parent_mode(client)
    word_ids = _create_words(6)
    data = {
        "mode": "extract",
        "stage": "junior",
        "word_ids": [str(x) for x in word_ids],
        "question_types": ["reading"],
    }
    resp = client.post("/worksheets/generate", data=data, follow_redirects=False)
    assert resp.status_code == 303
    ws_id = int((resp.headers.get("location") or "").rsplit("/", 1)[-1])

    with get_session() as session:
        row = session.get(Worksheet, ws_id)
        assert row is not None
        sheet = json.loads(row.sheet_json)
        assert sheet["question_types"] == ["reading"]
        reading = sheet.get("reading") or {}
        assert isinstance(reading, dict)
        assert reading.get("passage")
        assert isinstance(reading.get("questions"), list)
        assert len(reading.get("questions") or []) > 0
        answers = sheet.get("answers") or {}
        assert "reading" in answers
        assert len(answers["reading"]) >= 1
