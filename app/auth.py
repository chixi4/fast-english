from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
import secrets
from typing import Any

from app.config import get_settings


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def hash_password(password: str) -> str:
    password = password or ""
    password_bytes = password.encode("utf-8")
    salt = secrets.token_bytes(16)
    iterations = 210_000
    dk = hashlib.pbkdf2_hmac("sha256", password_bytes, salt, iterations, dklen=32)
    return "pbkdf2_sha256${}${}${}".format(
        iterations,
        _b64url_encode(salt),
        _b64url_encode(dk),
    )


def verify_password(password: str, password_hash: str) -> bool:
    try:
        algo, iters_s, salt_s, dk_s = (password_hash or "").split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iters_s)
        salt = _b64url_decode(salt_s)
        expected = _b64url_decode(dk_s)
    except Exception:
        return False

    password_bytes = (password or "").encode("utf-8")
    actual = hashlib.pbkdf2_hmac("sha256", password_bytes, salt, iterations, dklen=len(expected))
    return hmac.compare_digest(actual, expected)


def _get_secret() -> bytes:
    # Stable for the process lifetime (so sessions keep working even if APP_AUTH_SECRET_KEY is not set).
    # For real deployments, set APP_AUTH_SECRET_KEY in .env to make it stable across restarts.
    global _RUNTIME_SECRET
    settings = get_settings()
    if settings.auth_secret_key:
        return settings.auth_secret_key.encode("utf-8")
    return _RUNTIME_SECRET


_RUNTIME_SECRET = os.urandom(32)


@dataclass(frozen=True)
class SessionData:
    user_id: int
    username: str
    exp: int  # unix seconds


def encode_session(data: SessionData) -> str:
    payload = {"uid": data.user_id, "un": data.username, "exp": data.exp}
    body = _b64url_encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    sig = hmac.new(_get_secret(), body.encode("ascii"), hashlib.sha256).digest()
    return body + "." + _b64url_encode(sig)


def decode_session(token: str) -> SessionData | None:
    if not token:
        return None
    try:
        body, sig_s = token.split(".", 1)
        sig = _b64url_decode(sig_s)
    except Exception:
        return None

    expected = hmac.new(_get_secret(), body.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected):
        return None

    try:
        payload: dict[str, Any] = json.loads(_b64url_decode(body).decode("utf-8"))
        uid = int(payload.get("uid"))
        un = str(payload.get("un") or "")
        exp = int(payload.get("exp"))
    except Exception:
        return None

    if not un:
        return None
    now = int(datetime.now(tz=timezone.utc).timestamp())
    if exp < now:
        return None

    return SessionData(user_id=uid, username=un, exp=exp)


def new_session_for_user(user_id: int, username: str) -> SessionData:
    settings = get_settings()
    days = int(settings.auth_cookie_days)
    exp_dt = datetime.now(tz=timezone.utc) + timedelta(days=days)
    return SessionData(user_id=int(user_id), username=username, exp=int(exp_dt.timestamp()))
