from __future__ import annotations

import json

from app.db import get_session
from app.models import Worksheet, Word


def _enable_parent_mode(client) -> None:
    client.cookies.set("vs_mode", "parent")


def _create_words_with_missing_definition():
    with get_session() as session:
        w1 = Word(term="alpha", definition="", example="")
        w2 = Word(term="beta", definition="测试", example="")
        session.add_all([w1, w2])
        session.flush()
        return int(w1.id), int(w2.id)


def test_worksheet_question_types_degrade_when_missing_definition(client):
    _enable_parent_mode(client)
    w1_id, w2_id = _create_words_with_missing_definition()

    data = {
        "mode": "extract",
        "stage": "primary",
        "word_ids": [str(w1_id), str(w2_id)],
        "question_types": ["spelling", "mcq"],
    }
    resp = client.post("/worksheets/generate", data=data, follow_redirects=False)
    assert resp.status_code == 303
    loc = resp.headers.get("location") or ""
    assert loc.startswith("/worksheets/")
    ws_id = int(loc.rsplit("/", 1)[-1])

    with get_session() as session:
        row = session.get(Worksheet, ws_id)
        assert row is not None
        sheet = json.loads(row.sheet_json)
        assert sheet["question_types"] == ["spelling"]
        warnings = "\n".join(sheet.get("warnings") or [])
        assert "已自动移除“选择题”" in warnings
        assert "拼写题将不显示中文提示" in warnings


def test_worksheet_never_ends_up_with_no_question_types(client):
    _enable_parent_mode(client)
    w1_id, w2_id = _create_words_with_missing_definition()

    # Intentionally request only MCQ, but missing defs should force fallback to spelling.
    data = {
        "mode": "extract",
        "stage": "junior",
        "word_ids": [str(w1_id), str(w2_id)],
        "question_types": ["mcq"],
    }
    resp = client.post("/worksheets/generate", data=data, follow_redirects=False)
    assert resp.status_code == 303
    ws_id = int((resp.headers.get("location") or "").rsplit("/", 1)[-1])

    with get_session() as session:
        row = session.get(Worksheet, ws_id)
        assert row is not None
        sheet = json.loads(row.sheet_json)
        assert sheet["question_types"] == ["spelling"]


def test_worksheets_page_redirects_in_self_mode(client):
    resp = client.get("/worksheets", follow_redirects=False)
    assert resp.status_code == 303
    location = resp.headers.get("location") or ""
    assert location.startswith("/settings?")


def test_worksheets_extract_is_deprecated(client):
    _enable_parent_mode(client)
    resp = client.post("/worksheets/extract", data={"source_text": "hello world"}, follow_redirects=False)
    assert resp.status_code == 303
    location = resp.headers.get("location") or ""
    assert location.startswith("/worksheets?")
