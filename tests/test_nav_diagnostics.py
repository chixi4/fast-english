from __future__ import annotations

from app.auth_db import get_auth_session
from app.auth_models import AuthEvent


def _register(client, username: str, password: str = "pass1234"):
    return client.post(
        "/auth/register",
        data={"username": username, "password": password, "password2": password, "next": "/"},
        follow_redirects=False,
    )


def test_analytics_events_mark_diag_kind_and_can_export(client):
    reg = _register(client, "diag_user_1")
    assert reg.status_code == 303

    resp = client.post(
        "/api/analytics/events",
        json={
            "sid": "sid_1",
            "pid": "pid_1",
            "diag": 1,
            "events": [
                {"t": "click", "path": "/settings", "ts": 1, "dt_ms": 42},
                {"t": "route_change", "path": "/mistakes", "ts": 2, "dt_ms": 13},
            ],
        },
    )
    assert resp.status_code == 200
    assert resp.json().get("stored") == 2

    with get_auth_session() as session:
        rows = (
            session.query(AuthEvent)
            .filter(AuthEvent.username_norm == "diag_user_1")
            .order_by(AuthEvent.id.desc())
            .limit(5)
            .all()
        )
        assert any(r.kind == "client_diag" for r in rows)

    out = client.get("/api/diagnostics/nav?minutes=120&limit=200")
    assert out.status_code == 200
    data = out.json()
    assert data["ok"] is True
    assert data["count"] >= 2
    assert data["sid"] == "sid_1"
    assert data["pid"] == "pid_1"
    assert any((it.get("event") or {}).get("t") == "click" for it in data["events"])


def test_diagnostics_endpoint_requires_login(client):
    resp = client.get("/api/diagnostics/nav")
    assert resp.status_code == 401

