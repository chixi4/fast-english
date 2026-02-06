from __future__ import annotations


def _register(client, username: str, password: str = "pass1234"):
    return client.post(
        "/auth/register",
        data={"username": username, "password": password, "password2": password, "next": "/"},
        follow_redirects=False,
    )


def test_login_missing_credentials_feedback(client):
    resp = client.post(
        "/auth/login",
        data={"username": "", "password": "", "next": "/"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    html = resp.text
    assert 'data-error-code="missing_credentials"' in html
    assert "请填写账号。" in html
    assert "请填写密码。" in html


def test_login_account_not_found_uses_generic_message_by_default(client):
    resp = client.post(
        "/auth/login",
        data={"username": "no_such_user", "password": "1234", "next": "/"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    html = resp.text
    assert 'data-error-code="auth_failed"' in html
    assert "账号或密码错误。" in html
    assert "账号未注册。" not in html


def test_login_wrong_password_uses_generic_message_by_default(client):
    reg = _register(client, "alice")
    assert reg.status_code == 303

    resp = client.post(
        "/auth/login",
        data={"username": "alice", "password": "wrong", "next": "/"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    html = resp.text
    assert 'data-error-code="auth_failed"' in html
    assert "账号或密码错误。" in html
    assert "密码错误，请重试。" not in html


def test_login_error_has_single_register_entry(client):
    resp = client.post(
        "/auth/login",
        data={"username": "no_such_user", "password": "1234", "next": "/"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    html = resp.text
    assert html.count("去注册") == 1


def test_login_detailed_feedback_when_verbose_enabled(client, monkeypatch):
    monkeypatch.setenv("APP_LOGIN_VERBOSE_ERRORS", "1")

    not_found = client.post(
        "/auth/login",
        data={"username": "nobody", "password": "1234", "next": "/"},
        follow_redirects=False,
    )
    assert not_found.status_code == 400
    html1 = not_found.text
    assert 'data-error-code="account_not_found"' in html1
    assert "账号未注册。" in html1

    reg = _register(client, "bob")
    assert reg.status_code == 303

    wrong = client.post(
        "/auth/login",
        data={"username": "bob", "password": "wrong", "next": "/"},
        follow_redirects=False,
    )
    assert wrong.status_code == 400
    html2 = wrong.text
    assert 'data-error-code="wrong_password"' in html2
    assert "密码错误。" in html2


def test_register_validation_feedback(client):
    mismatch = client.post(
        "/auth/register",
        data={"username": "new_user", "password": "1234", "password2": "9999", "next": "/"},
        follow_redirects=False,
    )
    assert mismatch.status_code == 400
    html1 = mismatch.text
    assert 'data-error-code="password_mismatch"' in html1
    assert "两次密码不一致。" in html1

    reg = _register(client, "taken_user")
    assert reg.status_code == 303

    taken = _register(client, "taken_user")
    assert taken.status_code == 400
    html2 = taken.text
    assert 'data-error-code="username_taken"' in html2
    assert "账号已被使用。" in html2


def test_auth_forms_disable_hx_boost(client):
    login = client.get("/auth/login")
    assert login.status_code == 200
    assert 'action="/auth/login" hx-boost="false"' in login.text

    register = client.get("/auth/register")
    assert register.status_code == 200
    assert 'action="/auth/register" hx-boost="false"' in register.text
