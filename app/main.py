from __future__ import annotations

import asyncio
import base64
import binascii
import difflib
from datetime import datetime, timedelta, timezone
import hmac
import html
import json
import httpx
import os
import time
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlencode

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore[assignment]

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fsrs import Rating
from markupsafe import Markup
from sqlalchemy import case, func
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware

from app.ai import AiClient, LEVEL_GUIDE, LEVEL_LABELS, _safe_json_extract
from app.ai_types import GeneratedSimulation
from app.auth import decode_session, encode_session, hash_password, new_session_for_user, verify_password
from app.auth_db import get_auth_session, init_auth_db
from app.auth_models import AuthEvent, AuthUser
from app.config import get_settings
from app.db import get_session, init_db
from app.models import (
    Deck,
    DeckWord,
    Mistake,
    MistakePracticeSettings,
    ParentSettings,
    Plan,
    PlanDeck,
    PlanWord,
    Simulation,
    SrsCard,
    SrsReviewLog,
    Word,
    Worksheet,
)
from app.request_context import pop_current_user_identity, push_current_user_identity
from app.srs import apply_fsrs_to_db, db_card_to_fsrs, get_scheduler, parse_rating
from app.wordbooks import get_source, list_sources, load_rows


load_dotenv()
init_db()
init_auth_db()

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

def _static_v() -> str:
    try:
        css_v = (BASE_DIR / "static" / "app.css").stat().st_mtime_ns
        js_v = (BASE_DIR / "static" / "htmx.min.js").stat().st_mtime_ns
        dash_v = (BASE_DIR / "static" / "analytics_dashboard.js").stat().st_mtime_ns
        return str(max(css_v, js_v, dash_v))
    except Exception:
        return "0"

templates.env.globals["static_v"] = _static_v
templates.env.globals["level_labels"] = LEVEL_LABELS

app = FastAPI(title="迅捷单词")
app.add_middleware(GZipMiddleware, minimum_size=500)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

_UI_MODE_COOKIE = "vs_mode"
_UI_MODE_PARENT = "parent"
_UI_MODE_SELF = "self"


def _read_ui_mode(request: Request) -> str:
    raw = (request.cookies.get(_UI_MODE_COOKIE) or "").strip().lower()
    if raw in {_UI_MODE_PARENT, _UI_MODE_SELF}:
        return raw
    return _UI_MODE_SELF


@app.middleware("http")
async def _static_cache_headers(request: Request, call_next):
    resp = await call_next(request)
    if (request.url.path or "").startswith("/static/") and resp.status_code == 200:
        if "cache-control" not in {k.lower() for k in resp.headers.keys()}:
            resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp

@app.middleware("http")
async def _basic_auth_middleware(request: Request, call_next):
    settings = get_settings()
    if not settings.basic_auth_user or not settings.basic_auth_pass:
        return await call_next(request)

    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("basic "):
        token = auth.split(" ", 1)[1].strip()
        try:
            raw = base64.b64decode(token).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            raw = ""
        username, _, password = raw.partition(":")
        if hmac.compare_digest(username, settings.basic_auth_user) and hmac.compare_digest(
            password, settings.basic_auth_pass
        ):
            return await call_next(request)

    return Response(
        status_code=401,
        headers={"WWW-Authenticate": f'Basic realm="{settings.basic_auth_realm}", charset="UTF-8"'},
    )


@app.middleware("http")
async def _auth_session_middleware(request: Request, call_next):
    settings = get_settings()

    path = request.url.path or "/"
    is_public = path.startswith("/static") or path.startswith("/auth/")

    username: str | None = None
    user_id: int | None = None

    token_raw = request.cookies.get(settings.auth_cookie_name) or ""
    sess = decode_session(token_raw)
    if sess is not None:
        username = sess.username
        user_id = sess.user_id

    request.state.user_username = username
    request.state.user_id = user_id
    request.state.ui_mode = _read_ui_mode(request)

    if settings.require_login and (not username) and (not is_public):
        qs = urlencode({"next": str(request.url.path)})
        return RedirectResponse(url="/auth/login?" + qs, status_code=303)

    ctx_token = push_current_user_identity(username)
    started = time.perf_counter()
    try:
        resp = await call_next(request)
    except Exception:
        _log_auth_event(
            user_id=user_id,
            username=username,
            kind="error",
            path=str(request.url.path or "/"),
            method=str(request.method or ""),
            status_code=500,
            duration_ms=int((time.perf_counter() - started) * 1000),
            meta={"exc": "unhandled"},
        )
        raise
    finally:
        pop_current_user_identity(ctx_token)

    if username and (not is_public):
        path = str(request.url.path or "/")
        if not path.startswith(("/static", "/favicon", "/metrics")):
            ctype = (resp.headers.get("content-type") or "").lower()
            kind = "page_view" if (request.method == "GET" and "text/html" in ctype) else "api"
            _log_auth_event(
                user_id=user_id,
                username=username,
                kind=kind,
                path=path,
                method=str(request.method or ""),
                status_code=int(getattr(resp, "status_code", 0) or 0),
                duration_ms=int((time.perf_counter() - started) * 1000),
                meta={
                    "hx": (request.headers.get("HX-Request") or "").strip().lower() == "true",
                    "ua": (request.headers.get("user-agent") or "")[:200],
                    "qs": (request.url.query or "")[:500],
                    "ref": (request.headers.get("referer") or "")[:300],
                    "ip": (getattr(request.client, "host", "") or "")[:80],
                    "lang": (request.headers.get("accept-language") or "")[:120],
                },
            )

    return resp


def _log_auth_event(
    *,
    user_id: int | None,
    username: str | None,
    kind: str,
    path: str,
    method: str,
    status_code: int,
    duration_ms: int,
    meta: dict[str, Any] | None = None,
) -> None:
    if not username or user_id is None:
        return

    def _scrub(obj: Any) -> Any:
        # Best-effort: keep logs rich but avoid obvious secrets.
        if isinstance(obj, dict):
            out: dict[str, Any] = {}
            for k, v in obj.items():
                ks = str(k).lower()
                if any(s in ks for s in ("password", "passwd", "pwd", "secret", "token", "api_key", "apikey", "key")):
                    out[k] = "[redacted]"
                else:
                    out[k] = _scrub(v)
            return out
        if isinstance(obj, list):
            return [_scrub(v) for v in obj][:500]
        if isinstance(obj, str):
            return obj[:6000]
        return obj

    meta = _scrub(meta or {})
    try:
        meta_s = json.dumps(meta or {}, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        meta_s = "{}"
    try:
        with get_auth_session() as session:
            session.add(
                AuthEvent(
                    user_id=int(user_id),
                    username_norm=(username or "").strip().lower(),
                    kind=(kind or "").strip()[:32],
                    path=(path or "/")[:256],
                    method=(method or "").strip().upper()[:8],
                    status_code=int(status_code or 0),
                    duration_ms=int(duration_ms or 0),
                    meta_json=meta_s[:8000],
                )
            )
    except Exception:
        return


def _redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url=url, status_code=303)


def _is_htmx(request: Request) -> bool:
    return (request.headers.get("HX-Request") or "").strip().lower() == "true"


def _word_display_parts(word: Word | None) -> tuple[str, str]:
    if word is None or not word.definition:
        return ("", "")
    raw = str(word.definition)
    text = raw.replace("\r\n", "\n").replace("\\r\\n", "\n").replace("\\n", "\n")
    t = text.strip()
    if t.startswith("/") and t.find("/", 1) > 1:
        j = t.find("/", 1)
        return (t[: j + 1].strip(), t[j + 1 :].strip())
    return ("", t)


def _review_card_dict(word: Word, card: SrsCard, *, chapter: str = "") -> dict[str, Any]:
    phonetic, definition_text = _word_display_parts(word)
    return {
        "word_id": int(word.id),
        "term": str(word.term or ""),
        "chapter": str(chapter or ""),
        "phonetic": phonetic,
        "definition_text": definition_text,
        "example": str(word.example or ""),
        "state": int(card.state or 0),
        "correct_count": int(word.correct_count or 0),
        "wrong_count": int(word.wrong_count or 0),
    }


def _word_dict(word: Word) -> dict[str, Any]:
    phonetic, definition_text = _word_display_parts(word)
    return {
        "word_id": int(word.id),
        "term": str(word.term or ""),
        "definition": str(word.definition or ""),
        "phonetic": phonetic,
        "definition_text": definition_text,
        "example": str(word.example or ""),
    }

def _cookie_is_secure(request: Request) -> bool:
    xf_proto = (request.headers.get("x-forwarded-proto") or "").strip().lower()
    if xf_proto == "https":
        return True
    return request.url.scheme == "https"


def _set_session_cookie(resp: Response, request: Request, token: str) -> None:
    settings = get_settings()
    max_age = int(settings.auth_cookie_days) * 86400
    resp.set_cookie(
        settings.auth_cookie_name,
        token,
        max_age=max_age,
        httponly=True,
        secure=_cookie_is_secure(request),
        samesite="lax",
        path="/",
    )


def _set_ui_mode_cookie(resp: Response, request: Request, mode: str) -> None:
    m = (mode or "").strip().lower()
    if m not in {_UI_MODE_PARENT, _UI_MODE_SELF}:
        m = _UI_MODE_SELF
    # Not sensitive; allow templates/JS to read if needed.
    resp.set_cookie(
        _UI_MODE_COOKIE,
        m,
        max_age=180 * 86400,
        httponly=False,
        secure=_cookie_is_secure(request),
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(resp: Response) -> None:
    settings = get_settings()
    resp.delete_cookie(settings.auth_cookie_name, path="/")


def _norm_username(username: str) -> tuple[str, str]:
    raw = (username or "").strip()
    return raw, raw.lower()


def _request_owner_norm(request: Request) -> str:
    username = getattr(request.state, "user_username", None)
    norm = (username or "").strip().lower()
    return norm or "__default__"


def _safe_next(next_url: str | None) -> str:
    n = (next_url or "/").strip() or "/"
    # Avoid open redirects.
    if not n.startswith("/"):
        return "/"
    return n


@app.get("/auth/login", response_class=HTMLResponse)
def auth_login(request: Request, next: str = "/", toast: str | None = None, username: str | None = None):
    if request.state.user_username:
        return _redirect(_safe_next(next))
    return templates.TemplateResponse(
        request,
        "auth_login.html",
        {
            "title": "登录",
            "toast": (toast or "").strip(),
            "next": _safe_next(next),
            "username": (username or "").strip(),
        },
    )


@app.post("/auth/login", response_class=HTMLResponse)
def auth_login_post(request: Request, username: str = Form(...), password: str = Form(...), next: str = Form("/")):
    next = _safe_next(next)
    raw, norm = _norm_username(username)
    if not raw or not password:
        return templates.TemplateResponse(
            request,
            "auth_login.html",
            {"title": "登录", "toast": "请输入账号和密码。", "next": next, "username": raw},
            status_code=400,
        )

    with get_auth_session() as session:
        user = session.query(AuthUser).filter(AuthUser.username_norm == norm).first()
        if not user or not verify_password(password, user.password_hash):
            return templates.TemplateResponse(
                request,
                "auth_login.html",
                {"title": "登录", "toast": "账号或密码错误。", "next": next, "username": raw},
                status_code=400,
            )

    sess = new_session_for_user(user.id, user.username)
    token = encode_session(sess)
    resp = _redirect(next)
    _set_session_cookie(resp, request, token)
    return resp


@app.get("/auth/register", response_class=HTMLResponse)
def auth_register(request: Request, next: str = "/", toast: str | None = None, username: str | None = None):
    if request.state.user_username:
        return _redirect(_safe_next(next))
    return templates.TemplateResponse(
        request,
        "auth_register.html",
        {
            "title": "注册",
            "toast": (toast or "").strip(),
            "next": _safe_next(next),
            "username": (username or "").strip(),
        },
    )


@app.post("/auth/register", response_class=HTMLResponse)
def auth_register_post(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    password2: str = Form(...),
    next: str = Form("/"),
):
    next = _safe_next(next)
    raw, norm = _norm_username(username)
    if not raw:
        return templates.TemplateResponse(
            request,
            "auth_register.html",
            {"title": "注册", "toast": "请输入账号。", "next": next, "username": raw},
            status_code=400,
        )
    if len(raw) > 64:
        return templates.TemplateResponse(
            request,
            "auth_register.html",
            {"title": "注册", "toast": "账号太长（最多 64 字）。", "next": next, "username": raw},
            status_code=400,
        )
    if not password or len(password) < 4:
        return templates.TemplateResponse(
            request,
            "auth_register.html",
            {"title": "注册", "toast": "密码至少 4 位。", "next": next, "username": raw},
            status_code=400,
        )
    if password != password2:
        return templates.TemplateResponse(
            request,
            "auth_register.html",
            {"title": "注册", "toast": "两次输入的密码不一致。", "next": next, "username": raw},
            status_code=400,
        )

    with get_auth_session() as session:
        existed = session.query(AuthUser).filter(AuthUser.username_norm == norm).first()
        if existed:
            return templates.TemplateResponse(
                request,
                "auth_register.html",
                {"title": "注册", "toast": "该账号已存在，请换一个。", "next": next, "username": raw},
                status_code=400,
            )
        user = AuthUser(username=raw, username_norm=norm, password_hash=hash_password(password))
        session.add(user)
        session.flush()
        uid = int(user.id)
        display = user.username

    sess = new_session_for_user(uid, display)
    token = encode_session(sess)
    resp = _redirect(next)
    _set_session_cookie(resp, request, token)
    return resp


@app.post("/auth/logout")
def auth_logout(request: Request):
    resp = _redirect("/auth/login")
    _clear_session_cookie(resp)
    return resp


def _utcnow() -> datetime:
    return datetime.utcnow()


def _get_app_tzinfo(*, timezone_name: str) -> Any:
    name = (timezone_name or "").strip() or "Asia/Shanghai"
    if ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            pass

    # Common fallback: Windows dev env without tzdata.
    if name.lower() in {"asia/shanghai", "asia/chongqing", "asia/beijing", "prc", "cst"}:
        return timezone(timedelta(hours=8))

    try:
        return datetime.now().astimezone().tzinfo or timezone.utc
    except Exception:
        return timezone.utc


def _next_local_midnight_utc_naive(*, now_utc: datetime, tzinfo: Any) -> datetime:
    """
    Convert "tomorrow 00:00" in app timezone to naive UTC datetime (to match DB convention).
    """
    aware_utc = now_utc.replace(tzinfo=timezone.utc)
    local = aware_utc.astimezone(tzinfo)
    tomorrow = local.date() + timedelta(days=1)
    local_midnight = datetime(tomorrow.year, tomorrow.month, tomorrow.day, 0, 0, 0, tzinfo=tzinfo)
    return local_midnight.astimezone(timezone.utc).replace(tzinfo=None)


def _apply_daily_new_limit(
    session,
    *,
    now: datetime,
    daily_new_limit: int,
    suspend_new_when_due_over: int,
    timezone_name: str,
) -> dict[str, Any]:
    """
    Enforce plan behavior:
    - If review backlog > suspend_new_when_due_over => pause new cards for today (effective new limit = 0)
    - If due new cards > effective limit => postpone extra new cards' due_at to next local midnight
    Returns a small state dict for UI hints.
    """
    new_limit = max(0, int(daily_new_limit or 0))
    suspend_over = max(0, int(suspend_new_when_due_over or 0))

    due_review_total = int(
        session.query(func.count(SrsCard.word_id))
        .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_not(None))
        .scalar()
        or 0
    )
    new_paused = bool(suspend_over > 0 and due_review_total > suspend_over)
    effective_new_limit = 0 if new_paused else new_limit

    due_new_total = int(
        session.query(func.count(SrsCard.word_id))
        .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None))
        .scalar()
        or 0
    )

    postponed = 0
    next_midnight_utc: datetime | None = None
    if due_new_total > effective_new_limit:
        tzinfo = _get_app_tzinfo(timezone_name=timezone_name)
        next_midnight_utc = _next_local_midnight_utc_naive(now_utc=now, tzinfo=tzinfo)
        extra_rows = (
            session.query(SrsCard.word_id)
            .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None))
            .order_by(SrsCard.due_at.asc(), SrsCard.created_at.asc(), SrsCard.word_id.asc())
            .offset(effective_new_limit)
            .limit(50000)
            .all()
        )
        extra_ids = [int(wid) for (wid,) in extra_rows]
        postponed = len(extra_ids)
        if extra_ids:
            session.query(SrsCard).filter(SrsCard.word_id.in_(extra_ids)).update(
                {SrsCard.due_at: next_midnight_utc}, synchronize_session=False
            )
            session.flush()
        due_new_total = min(due_new_total, effective_new_limit)

    return {
        "due_review_total": due_review_total,
        "due_new_total": due_new_total,
        "new_paused": new_paused,
        "effective_new_limit": effective_new_limit,
        "postponed_new": postponed,
        "next_midnight_utc": next_midnight_utc,
    }


def _merge_tags(*values: str) -> str:
    items: list[str] = []
    seen: set[str] = set()
    for v in values:
        raw = (v or "").strip()
        if not raw:
            continue
        for part in raw.replace(";", ",").split(","):
            t = part.strip()
            if not t:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            items.append(t)
    return ", ".join(items)


def _format_next_due_at(next_due_at: datetime | None, *, now: datetime) -> str:
    if next_due_at is None:
        return ""
    try:
        delta = next_due_at - now
    except Exception:
        return next_due_at.strftime("%Y-%m-%d %H:%M")
    seconds = int(delta.total_seconds())
    if seconds <= 0:
        return "现在"
    mins = seconds // 60
    if mins < 60:
        return f"约 {mins} 分钟后"
    hours = mins // 60
    if hours < 48:
        return f"约 {hours} 小时后"
    return next_due_at.strftime("%Y-%m-%d %H:%M")


_PASSAGE_MARK_RE = re.compile(r"\[\[(.+?)\]\]")


def _passage_to_html(passage: str) -> str:
    escaped = html.escape(passage or "")
    escaped = escaped.replace("\r\n", "\n").replace("\r", "\n")
    escaped = escaped.replace("\n", "<br>")
    return _PASSAGE_MARK_RE.sub(r'<mark class="kw">\1</mark>', escaped)


def _kw_to_html(text: str | None) -> Markup:
    escaped = html.escape(text or "")
    escaped = escaped.replace("\r\n", "\n").replace("\r", "\n")
    escaped = escaped.replace("\n", "<br>")
    return Markup(_PASSAGE_MARK_RE.sub(r"<mark class=\"kw\">\1</mark>", escaped))


templates.env.filters["kw"] = _kw_to_html


def _ensure_deck(session, name: str) -> Deck:
    name = (name or "").strip()
    if not name:
        raise ValueError("deck name required")
    deck = session.query(Deck).filter(Deck.name == name).first()
    if deck:
        return deck
    deck = Deck(name=name)
    session.add(deck)
    session.flush()
    return deck


def _ensure_srs_card(session, word_id: int) -> SrsCard:
    card = session.get(SrsCard, word_id)
    if card:
        return card
    card = SrsCard(word_id=word_id, due_at=_utcnow())
    session.add(card)
    session.flush()
    return card


def _ensure_default_plan(session) -> Plan:
    plan = session.query(Plan).order_by(Plan.id.asc()).first()
    if plan:
        return plan
    plan = Plan(name="默认计划", daily_new_limit=20, daily_review_limit=200, suspend_new_when_due_over=200)
    session.add(plan)
    session.flush()
    return plan


def _ensure_parent_settings(session) -> ParentSettings:
    row = session.query(ParentSettings).filter(ParentSettings.name == "默认").first()
    if row:
        return row

    decks = session.query(Deck).order_by(Deck.id.asc()).all()

    def _pick_deck_id(pred) -> int | None:
        for d in decks:
            try:
                if pred(d):
                    return int(d.id)
            except Exception:
                continue
        return None

    textbook_id = _pick_deck_id(lambda d: ("课本" in (d.name or "")) or ("教材" in (d.name or "")))
    freq_id = _pick_deck_id(lambda d: ("高频 10k" in (d.name or "")) or ("高频10k" in (d.name or "")))

    target_ids: list[int] = []
    zk_id = _pick_deck_id(lambda d: "中考" in (d.name or ""))
    if zk_id is not None:
        target_ids.append(int(zk_id))

    row = ParentSettings(
        name="默认",
        stage="junior",
        daily_words=10,
        textbook_deck_id=textbook_id,
        target_deck_ids_json=json.dumps(target_ids, ensure_ascii=False),
        frequency_deck_id=freq_id,
    )
    session.add(row)
    session.flush()
    return row


def _ensure_mistake_practice_settings(session, owner_norm: str) -> MistakePracticeSettings:
    owner = (owner_norm or "").strip().lower() or "__default__"
    row = session.query(MistakePracticeSettings).filter(MistakePracticeSettings.owner_norm == owner).first()
    if row:
        return row
    row = MistakePracticeSettings(
        owner_norm=owner,
        default_level="auto",
        default_length_mode="standard",
        default_include_once=0,
        use_fixed_target_count=0,
        default_target_count=None,
    )
    session.add(row)
    session.flush()
    return row


def _ensure_plan_deck(session, plan: Plan, deck_id: int) -> PlanDeck:
    link = session.query(PlanDeck).filter(PlanDeck.plan_id == plan.id, PlanDeck.deck_id == deck_id).first()
    if link:
        return link
    max_pri = session.query(func.max(PlanDeck.priority)).filter(PlanDeck.plan_id == plan.id).scalar()
    pri = int(max_pri or 0)
    link = PlanDeck(plan_id=plan.id, deck_id=deck_id, priority=pri + 1)
    session.add(link)
    session.flush()
    return link


def _ensure_plan_word(session, plan: Plan, word_id: int, source_deck_id: int | None) -> PlanWord:
    pw = session.query(PlanWord).filter(PlanWord.plan_id == plan.id, PlanWord.word_id == word_id).first()
    if pw:
        if pw.source_deck_id is None and source_deck_id is not None:
            pw.source_deck_id = source_deck_id
        return pw
    pw = PlanWord(plan_id=plan.id, word_id=word_id, source_deck_id=source_deck_id, status="active")
    session.add(pw)
    session.flush()
    return pw


def _bootstrap_plan_state() -> None:
    """
    Keep plan<>card consistency:
    - For existing DBs: SrsCard exists => ensure PlanWord exists
    - For plan words: ensure SrsCard exists
    """
    with get_session() as session:
        plan = _ensure_default_plan(session)

        # SrsCard -> PlanWord
        missing_plan_words = (
            session.query(SrsCard.word_id)
            .outerjoin(
                PlanWord,
                (PlanWord.word_id == SrsCard.word_id) & (PlanWord.plan_id == plan.id),
            )
            .filter(PlanWord.word_id.is_(None))
            .all()
        )
        for (wid,) in missing_plan_words:
            src_deck_id = (
                session.query(DeckWord.deck_id)
                .filter(DeckWord.word_id == wid)
                .order_by(DeckWord.id.asc())
                .scalar()
            )
            if src_deck_id is not None:
                _ensure_plan_deck(session, plan, int(src_deck_id))
            session.add(PlanWord(plan_id=plan.id, word_id=wid, source_deck_id=src_deck_id, status="active"))

        # PlanWord -> SrsCard
        missing_cards = (
            session.query(PlanWord.word_id)
            .outerjoin(SrsCard, SrsCard.word_id == PlanWord.word_id)
            .filter(PlanWord.plan_id == plan.id, SrsCard.word_id.is_(None))
            .all()
        )
        for (wid,) in missing_cards:
            session.add(SrsCard(word_id=wid, due_at=_utcnow()))


_bootstrap_plan_state()


def _wants_html(request: Request) -> bool:
    accept = request.headers.get("accept", "")
    return "text/html" in accept or "*/*" in accept


def _is_parent_mode(request: Request) -> bool:
    return getattr(request.state, "ui_mode", _UI_MODE_SELF) == _UI_MODE_PARENT


def _require_parent_mode_for_worksheets(request: Request) -> Response | None:
    if _is_parent_mode(request):
        return None
    msg = "作业功能仅家长模式可用"
    if _wants_html(request):
        return _redirect("/settings?" + urlencode({"toast": msg}))
    raise HTTPException(status_code=403, detail=msg)


@app.exception_handler(HTTPException)
def http_exception_handler(request: Request, exc: HTTPException):
    if _wants_html(request):
        return templates.TemplateResponse(
            request,
            "error.html",
            {"status_code": exc.status_code, "detail": exc.detail},
            status_code=exc.status_code,
        )
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(StarletteHTTPException)
def starlette_http_exception_handler(request: Request, exc: StarletteHTTPException):
    # Handle framework-level 404s (route not found), etc.
    if _wants_html(request):
        return templates.TemplateResponse(
            request,
            "error.html",
            {"status_code": exc.status_code, "detail": exc.detail},
            status_code=exc.status_code,
        )
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(Exception)
def unhandled_exception_handler(request: Request, exc: Exception):
    if _wants_html(request):
        return templates.TemplateResponse(
            request,
            "error.html",
            {"status_code": 500, "detail": str(exc)},
            status_code=500,
        )
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})


@app.get("/", response_class=HTMLResponse)
def home(request: Request, deck_id: int | None = None, toast: str | None = None):
    if getattr(request.state, "ui_mode", _UI_MODE_SELF) == _UI_MODE_PARENT:
        now = _utcnow()
        with get_session() as session:
            parent = _ensure_parent_settings(session)
            stage = (parent.stage or "junior").strip().lower()
            daily_words = int(parent.daily_words or 10)

            word_count = int(session.query(Word).count())
            deck_count = int(session.query(Deck).count())

            due_count = int(session.query(func.count(SrsCard.word_id)).filter(SrsCard.due_at <= now).scalar() or 0)
            mistake_words = int(session.query(func.count(func.distinct(Mistake.word_id))).scalar() or 0)

            pending_ws: Worksheet | None = None
            for w in session.query(Worksheet).order_by(Worksheet.id.desc()).limit(30).all():
                meta = _safe_json_dict(w.meta_json)
                if not meta.get("graded_at"):
                    pending_ws = w
                    break

        return templates.TemplateResponse(
            request,
            "home_parent.html",
            {
                "title": "今日作业",
                "toast": (toast or "").strip(),
                "stage": stage,
                "stage_label": _stage_label(stage),
                "daily_words": daily_words,
                "word_count": word_count,
                "deck_count": deck_count,
                "due_count": due_count,
                "mistake_words": mistake_words,
                "pending_ws": pending_ws,
            },
        )

    if deck_id == 0:
        deck_id = None
    now = _utcnow()
    settings = get_settings()
    with get_session() as session:
        plan = _ensure_default_plan(session)
        daily_new_limit = int(plan.daily_new_limit or 20)
        daily_review_limit = int(plan.daily_review_limit or 200)
        suspend_new_when_due_over = int(plan.suspend_new_when_due_over or 200)
        quick_add_count = max(1, min(10, daily_new_limit))

        plan_state = _apply_daily_new_limit(
            session,
            now=now,
            daily_new_limit=daily_new_limit,
            suspend_new_when_due_over=suspend_new_when_due_over,
            timezone_name=settings.app_timezone,
        )

        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        word_count = int(session.query(Word).count())
        deck_count = int(session.query(Deck).count())

        deck_word_counts = dict(
            session.query(DeckWord.deck_id, func.count(DeckWord.word_id)).group_by(DeckWord.deck_id).all()
        )
        deck_planned_counts = dict(
            session.query(DeckWord.deck_id, func.count(SrsCard.word_id))
            .join(SrsCard, SrsCard.word_id == DeckWord.word_id)
            .group_by(DeckWord.deck_id)
            .all()
        )
        deck_items = []
        for d in decks:
            total_w = int(deck_word_counts.get(d.id, 0))
            planned_w = int(deck_planned_counts.get(d.id, 0))
            deck_items.append(
                {
                    "deck": d,
                    "word_count": total_w,
                    "planned_count": planned_w,
                    "remaining_count": max(0, total_w - planned_w),
                }
            )

        suggested_deck_id: int | None = deck_id
        if suggested_deck_id is None:
            for it in deck_items:
                if it["remaining_count"] > 0:
                    suggested_deck_id = it["deck"].id
                    break
        if suggested_deck_id is None and decks:
            suggested_deck_id = decks[0].id

        selected_deck_label = "全部词书"
        if deck_id is not None:
            for d in decks:
                if int(d.id) == int(deck_id):
                    selected_deck_label = d.name
                    break

        unplanned_word_count = int(
            session.query(func.count(Word.id))
            .outerjoin(SrsCard, SrsCard.word_id == Word.id)
            .filter(SrsCard.word_id.is_(None))
            .scalar()
            or 0
        )

        base_q = session.query(SrsCard)
        if deck_id is not None:
            base_q = (
                base_q.join(DeckWord, DeckWord.word_id == SrsCard.word_id)
                .filter(DeckWord.deck_id == deck_id)
            )

        total = int(base_q.count())
        due_review_total = int(base_q.filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_not(None)).count())
        due_new_total = int(base_q.filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None)).count())

        due_review_today = due_review_total if daily_review_limit <= 0 else min(due_review_total, daily_review_limit)
        due_new_today = min(due_new_total, int(plan_state.get("effective_new_limit") or 0))
        due_today = due_review_today + due_new_today
        due_total = due_review_total + due_new_total

        mistake_count = int(session.query(Mistake).count())
        sim_count = int(session.query(Simulation).count())

    est_minutes = max(1, int(round(due_today * 0.25))) if total > 0 else 0

    return templates.TemplateResponse(
        request,
        "home.html",
        {
            "decks": decks,
            "deck_items": deck_items,
            "deck_id": deck_id,
            "suggested_deck_id": suggested_deck_id,
            "deck_count": deck_count,
            "word_count": word_count,
            "total": total,
            "due_count": due_today,
            "due_total": due_total,
            "due_review_total": due_review_total,
            "due_new_total": due_new_total,
            "due_review_today": due_review_today,
            "due_new_today": due_new_today,
            "new_paused": bool(plan_state.get("new_paused")),
            "postponed_new": int(plan_state.get("postponed_new") or 0),
            "est_minutes": est_minutes,
            "unplanned_word_count": unplanned_word_count,
            "mistake_count": mistake_count,
            "sim_count": sim_count,
            "toast": (toast or "").strip(),
            "daily_new_limit": daily_new_limit,
            "daily_review_limit": daily_review_limit,
            "suspend_new_when_due_over": suspend_new_when_due_over,
            "quick_add_count": quick_add_count,
            "selected_deck_label": selected_deck_label,
        },
    )


@app.get("/practice", response_class=HTMLResponse)
def practice(request: Request):
    with get_session() as session:
        mistake_count = int(session.query(Mistake).count())
        sim_count = int(session.query(Simulation).count())
        word_count = int(session.query(Word).count())
    return templates.TemplateResponse(
        request,
        "practice.html",
        {"mistake_count": mistake_count, "sim_count": sim_count, "word_count": word_count},
    )


_WORD_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")


def _extract_terms_from_text(text: str) -> list[str]:
    raw = (text or "").strip()
    if not raw:
        return []

    tokens = _WORD_TOKEN_RE.findall(raw)
    cleaned: list[str] = []
    for t in tokens:
        w = (t or "").strip().strip("'-").lower()
        if w.endswith("'s") and len(w) > 3:
            w = w[:-2]
        w = w.strip("'-")
        if len(w) < 2:
            continue
        cleaned.append(w)

    # Dedupe, keep order
    seen: set[str] = set()
    out: list[str] = []
    for w in cleaned:
        if w in seen:
            continue
        seen.add(w)
        out.append(w)
    return out


def _short_definition(defn: str) -> str:
    s = (defn or "").strip()
    if not s:
        return ""
    # Some sources store line breaks as literal "\n" in a single CSV cell.
    # Normalize those first so we can reliably cut at the first meaning line.
    s = s.replace("\\r\\n", "\n").replace("\\n", "\n")
    if "\n" in s:
        s = s.split("\n", 1)[0].strip()
    s = re.sub(r"\s+", " ", s)
    # ECDICT-like defs often start with phonetic wrapped by slashes: "/kæmp/ n. 露营..."
    # If we split by "/" too early, we end up with empty "short defs" and show "（无释义）".
    s = re.sub(r"^/[^/]{1,64}/\s*", "", s)
    # Drop the first part-of-speech marker ("n." / "vt." / "adj." ...) if present.
    s = re.sub(r"^(?:[a-z]{1,4}\.)\s*", "", s, flags=re.IGNORECASE)
    # Common separators in ecdict-like defs: "/" ";" "；"
    for sep in ["；", ";", "/", "｜", "|"]:
        if sep in s:
            s = s.split(sep, 1)[0].strip()
    if len(s) > 28:
        s = s[:28].rstrip() + "…"
    return s


def _stage_label(stage: str) -> str:
    return "小学" if (stage or "").strip().lower() == "primary" else "初中"


def _pos_hint_from_definition(defn: str) -> str:
    s = (defn or "").strip()
    if not s:
        return ""
    # ECDICT-like defs often start with phonetic wrapped by slashes: "/kæmp/ n. 露营..."
    s = re.sub(r"^/[^/]{1,64}/\s*", "", s)
    head = s[:48].lower()
    # Common POS markers.
    m = re.search(r"\b(vt|vi|v|n|adj|adv|prep|conj|pron|int)\.\b", head)
    if not m:
        m = re.search(r"^(vt|vi|v|n|adj|adv|prep|conj|pron|int)\.\b", head.strip())
    if not m:
        return ""
    tag = m.group(1)
    if tag in {"vt", "vi"}:
        return "v"
    return tag


def _ai_generate_sentences_for_terms(*, stage: str, terms: list[str], term_notes: dict[str, str]) -> dict[str, str]:
    """
    Best-effort: ask the writer model for one short sentence per term.
    Output: {term: "I ... [[term]] ..."}
    """
    settings = get_settings()
    if settings.ai_mock or not settings.ai_api_key:
        return {}

    stage = (stage or "junior").strip().lower()
    stage_hint = "小学" if stage == "primary" else "初中"
    max_words = 10 if stage == "primary" else 14
    min_words = 5 if stage == "primary" else 6

    vocab_lines: list[str] = []
    for t in terms:
        note = (term_notes.get(t) or "").strip()
        if note:
            vocab_lines.append(f"- {t}: {note}")
        else:
            vocab_lines.append(f"- {t}")
    vocab_block = "\n".join(vocab_lines)

    schema_hint = {"sentences": [{"term": "string", "sentence": "string"}]}
    system = "你是英语老师。你只输出严格 JSON，不要输出 Markdown，不要输出多余文本。"
    user = (
        f"请为下面每个单词各写 1 句英文例句，适合{stage_hint}学生，尽量简单自然。\n"
        f"硬性要求：\n"
        f"1) 每句不超过 {max_words} 个英文单词（不含标点）。\n"
        f"1.1) 每句至少 {min_words} 个英文单词（不含标点），避免“太短太模板”。\n"
        "2) 每句必须包含该目标词一次，并且用 [[目标词]] 标记，例如 [[apple]]。\n"
        "3) 不要使用目标词变形（复数/过去式/ing），只允许大小写不同。\n"
        "4) 不要写过于模板的句子（例如：This is [[word]]. / This is a [[word]]. / I like [[word]].）。\n"
        "5) 尽量写具体语境（学校/家庭/运动/旅行/食物等），自然一些。\n"
        "4) 只输出 JSON，结构如下：\n"
        f"{json.dumps(schema_hint, ensure_ascii=False)}\n\n"
        "单词（含释义/备注）：\n"
        f"{vocab_block}\n"
    ).strip()

    url = f"{settings.ai_base_url}/chat/completions"
    payload: dict[str, Any] = {
        "model": settings.ai_writer_model or settings.ai_model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.4,
    }

    def _en_word_count(s: str) -> int:
        return len(re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", s or ""))

    def _ok(term: str, sent: str) -> bool:
        if not term or not sent:
            return False
        wc = _en_word_count(sent)
        if wc < min_words or wc > max_words:
            return False
        # Must contain [[term]] marker (case-insensitive).
        return re.search(rf"\[\[{re.escape(term)}\]\]", sent, flags=re.IGNORECASE) is not None

    last_err: Exception | None = None
    for _attempt in range(2):
        try:
            with httpx.Client(timeout=90.0) as client:
                resp = client.post(url, headers={"Authorization": f"Bearer {settings.ai_api_key}"}, json=payload)
                resp.raise_for_status()
                data = resp.json()
            text = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
            json_text = _safe_json_extract(str(text))
            obj = json.loads(json_text)
            raw_out: dict[str, str] = {}
            for it in (obj.get("sentences") or []):
                if not isinstance(it, dict):
                    continue
                term = str(it.get("term") or "").strip()
                sent = str(it.get("sentence") or "").strip()
                if not term or not sent:
                    continue
                raw_out[term] = sent

            out = {t: s for (t, s) in raw_out.items() if _ok(t, s)}
            bad_terms = [t for t in terms if t not in out]
            if not bad_terms:
                return out

            # Try to fix missing/invalid items with either checker model or the same writer model.
            fix_model = settings.ai_checker_model or (settings.ai_writer_model or settings.ai_model)
            if fix_model:
                checker_schema = {"sentences": [{"term": "string", "sentence": "string"}]}
                checker_user_lines: list[str] = []
                checker_user_lines.append(f"请修复下面这些例句，使其满足全部硬性要求。只输出 JSON：{json.dumps(checker_schema, ensure_ascii=False)}")
                checker_user_lines.append("硬性要求：")
                checker_user_lines.append(f"1) 每句不超过 {max_words} 个英文单词（不含标点）。")
                checker_user_lines.append(f"1.1) 每句至少 {min_words} 个英文单词（不含标点）。")
                checker_user_lines.append("2) 每句必须包含该目标词一次，并且用 [[目标词]] 标记。")
                checker_user_lines.append("3) 不要使用目标词变形（复数/过去式/ing），只允许大小写不同。")
                checker_user_lines.append("4) 不要写模板句（This is [[word]]. / This is a [[word]]. / I like [[word]].）。")
                checker_user_lines.append("5) 尽量写具体语境，自然一些。")
                checker_user_lines.append("需要修复的条目：")
                for t in bad_terms:
                    note = (term_notes.get(t) or "").strip()
                    prev = (raw_out.get(t) or "").strip()
                    checker_user_lines.append(f"- {t}: {note} | draft={prev}")

                checker_payload: dict[str, Any] = {
                    "model": fix_model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": "\n".join(checker_user_lines).strip()},
                    ],
                    "temperature": 0.2,
                }

                try:
                    with httpx.Client(timeout=90.0) as client:
                        resp2 = client.post(
                            url,
                            headers={"Authorization": f"Bearer {settings.ai_api_key}"},
                            json=checker_payload,
                        )
                        resp2.raise_for_status()
                        data2 = resp2.json()
                    text2 = (((data2.get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
                    json_text2 = _safe_json_extract(str(text2))
                    obj2 = json.loads(json_text2)
                    for it2 in (obj2.get("sentences") or []):
                        if not isinstance(it2, dict):
                            continue
                        term2 = str(it2.get("term") or "").strip()
                        sent2 = str(it2.get("sentence") or "").strip()
                        if term2 in bad_terms and _ok(term2, sent2):
                            out[term2] = sent2
                except Exception:
                    pass

            return out
        except Exception as e:
            last_err = e
            payload = {**payload, "temperature": 0.2}
            continue

    _ = last_err
    return {}


def _ai_generate_reading_for_worksheet(
    *,
    stage: str,
    terms: list[str],
    term_notes: dict[str, str],
) -> GeneratedSimulation | None:
    """
    Best-effort: generate a short reading passage + multiple-choice questions for printed worksheets.
    Output uses the same schema as GeneratedSimulation.
    """
    settings = get_settings()
    if settings.ai_mock:
        # Minimal deterministic mock for offline demo / tests.
        picked = [t for t in terms if t.strip()][:6]
        if not picked:
            return None
        p1 = " ".join([f"We learn [[{t}]] today." for t in picked[:3]])
        p2 = " ".join([f"Please remember [[{t}]] for homework." for t in picked[3:]])
        passage = (p1 + "\n\n" + p2).strip()
        qs: list[dict[str, Any]] = []
        for i, t in enumerate(picked[:4]):
            qs.append(
                {
                    "id": f"q{i+1}",
                    "type": "detail",
                    "stem": f"Which word appears in the passage?",
                    "choices": [t, picked[(i + 1) % len(picked)], picked[(i + 2) % len(picked)], picked[(i + 3) % len(picked)]],
                    "answer_index": 0,
                    "explanation": "It is marked in the passage.",
                    "target_term": t,
                }
            )
        return GeneratedSimulation.model_validate({"passage": passage, "questions": qs})

    if not settings.ai_api_key:
        return None

    stage2 = (stage or "junior").strip().lower()
    stage_hint = "小学" if stage2 == "primary" else "初中"
    question_count = 3 if stage_hint == "小学" else 4
    # Keep reading shorter than self-study simulations.
    if stage_hint == "小学":
        lo, hi = 90, 130
        p_lo, p_hi = 2, 3
    else:
        lo, hi = 150, 220
        p_lo, p_hi = 2, 4

    vocab_lines: list[str] = []
    for t in terms:
        note = (term_notes.get(t) or "").strip()
        if note:
            vocab_lines.append(f"- {t}: {note}")
        else:
            vocab_lines.append(f"- {t}")
    vocab_block = "\n".join(vocab_lines)

    schema_hint = {
        "passage": "string",
        "questions": [
            {
                "id": "q1",
                "type": "main_idea|detail|inference|vocab_in_context",
                "stem": "string",
                "choices": ["A ...", "B ...", "C ...", "D ..."],
                "answer_index": 0,
                "explanation": "string",
                "target_term": "string|null",
            }
        ],
    }

    system = "你是英语阅读理解出题老师。你只输出严格 JSON，不要输出 Markdown，不要输出多余文本。"
    user = (
        f"请写 1 篇适合{stage_hint}学生的短文，并出 {question_count} 道选择题（阅读理解为主，可包含少量词汇语境题）。\n"
        "硬性要求：\n"
        f"1) 短文长度约 {lo}-{hi} 词，分成 {p_lo}-{p_hi} 段。\n"
        "2) 短文必须自然包含每个目标词（大小写不敏感），并且用 [[目标词]] 标记。\n"
        "3) 必须使用目标词原形拼写（与目标词列表一致，只允许大小写不同），不要使用变形（复数/过去式/ing）。\n"
        f"4) 题目总数 = {question_count}；每题 4 个选项（choices 长度 = 4）；answer_index 为 0-3。\n"
        "5) explanation 每题 1 句话即可。\n"
        "6) 如果题目与某个目标词强相关，请把 target_term 填成该词；否则填 null。\n"
        "7) 只输出 JSON，结构如下：\n"
        f"{json.dumps(schema_hint, ensure_ascii=False)}\n\n"
        "目标词（含释义/备注）：\n"
        f"{vocab_block}\n"
    ).strip()

    url = f"{settings.ai_base_url}/chat/completions"
    payload: dict[str, Any] = {
        "model": settings.ai_writer_model or settings.ai_model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.6,
    }

    def _missing_terms(passage: str) -> list[str]:
        miss: list[str] = []
        for t in terms:
            if not t:
                continue
            if re.search(rf"\[\[{re.escape(t)}\]\]", passage or "", flags=re.IGNORECASE) is None:
                miss.append(t)
        return miss

    last_err: Exception | None = None
    for attempt in range(1, 4):
        try:
            with httpx.Client(timeout=120.0) as client:
                resp = client.post(url, headers={"Authorization": f"Bearer {settings.ai_api_key}"}, json=payload)
                resp.raise_for_status()
                data = resp.json()
            text = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
            json_text = _safe_json_extract(str(text))
            parsed = GeneratedSimulation.model_validate(json.loads(json_text))

            missing = _missing_terms(parsed.passage)
            if missing:
                raise RuntimeError(f"reading passage missing terms: {', '.join(missing)}")
            if len(parsed.questions) != question_count:
                # Allow small deviation but keep it bounded for printing.
                if not (question_count - 1 <= len(parsed.questions) <= question_count + 1):
                    raise RuntimeError("reading question_count out of range")
            for q in parsed.questions:
                if len(q.choices) != 4:
                    raise RuntimeError("reading question choices must be 4")
            return parsed
        except Exception as e:
            last_err = e
            payload = {
                **payload,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": "上一次输出不符合要求（JSON不可解析或不满足硬性要求）。请严格按要求只输出 JSON。"},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.4 if attempt == 1 else 0.2,
            }
            continue

    _ = last_err
    return None


@app.get("/worksheets", response_class=HTMLResponse)
def worksheets_page(request: Request, toast: str | None = None):
    blocked = _require_parent_mode_for_worksheets(request)
    if blocked is not None:
        return blocked

    with get_session() as session:
        parent = _ensure_parent_settings(session)
        stage = (parent.stage or "junior").strip().lower()
        daily_words = int(parent.daily_words or 10)
        worksheets = session.query(Worksheet).order_by(Worksheet.id.desc()).limit(30).all()
    return templates.TemplateResponse(
        request,
        "worksheets.html",
        {
            "toast": (toast or "").strip(),
            "worksheets": worksheets,
            "stage": stage,
            "stage_label": _stage_label(stage),
            "daily_words": daily_words,
        },
    )


@app.post("/worksheets/extract", response_class=HTMLResponse)
def worksheets_extract(request: Request, source_text: str = Form("")):
    blocked = _require_parent_mode_for_worksheets(request)
    if blocked is not None:
        return blocked

    _ = source_text
    return _redirect("/worksheets?" + urlencode({"toast": "“课文导入”已下线，请直接使用“生成今日作业”。"}))


@app.post("/worksheets/generate_today")
def worksheets_generate_today(request: Request, question_types: list[str] = Form([])):
    blocked = _require_parent_mode_for_worksheets(request)
    if blocked is not None:
        return blocked

    with get_session() as session:
        parent = _ensure_parent_settings(session)
        stage = (parent.stage or "junior").strip().lower()
        if stage not in {"primary", "junior"}:
            stage = "junior"
        desired = max(1, min(60, int(parent.daily_words or 10)))

        allowed_qt = {"spelling", "mcq", "cloze", "reading"}
        cleaned_qt: list[str] = []
        for raw in question_types or []:
            key = str(raw or "").strip().lower()
            if key in allowed_qt and key not in cleaned_qt:
                cleaned_qt.append(key)
        if not cleaned_qt:
            cleaned_qt = ["spelling", "mcq"] if stage == "primary" else ["spelling", "mcq", "cloze"]

        warnings: list[str] = []

        now = _utcnow()

        # 1) Always prioritize recent mistakes (even if FSRS schedules them slightly in the future).
        mistake_rows = (
            session.query(Mistake.word_id, func.max(Mistake.created_at))
            .group_by(Mistake.word_id)
            .order_by(func.max(Mistake.created_at).desc(), Mistake.word_id.desc())
            .limit(desired)
            .all()
        )
        mistake_ids = [int(wid) for (wid, _ts) in mistake_rows]

        # 2) Then fill with due cards.
        due_rows = (
            session.query(SrsCard.word_id)
            .filter(SrsCard.due_at <= now)
            .order_by(SrsCard.due_at.asc(), SrsCard.word_id.asc())
            .limit(desired)
            .all()
        )
        due_ids = [int(wid) for (wid,) in due_rows]

        picked: list[int] = []
        seen: set[int] = set()
        for wid in mistake_ids + due_ids:
            if wid in seen:
                continue
            seen.add(wid)
            picked.append(wid)
            if len(picked) >= desired:
                break

        if len(picked) < desired:
            need = desired - len(picked)

            target_deck_ids: list[int] = []
            try:
                obj = json.loads(parent.target_deck_ids_json or "[]")
                if isinstance(obj, list):
                    for x in obj:
                        if isinstance(x, int) and x > 0:
                            target_deck_ids.append(int(x))
            except Exception:
                target_deck_ids = []

            if not target_deck_ids:
                plan = _ensure_default_plan(session)
                target_deck_ids = [
                    int(did)
                    for (did,) in session.query(PlanDeck.deck_id)
                    .filter(PlanDeck.plan_id == plan.id)
                    .order_by(PlanDeck.priority.asc(), PlanDeck.id.asc())
                    .all()
                ]

            # Last fallback: any decks.
            if not target_deck_ids:
                target_deck_ids = [int(d.id) for d in session.query(Deck).order_by(Deck.id.asc()).limit(10).all()]

            for did in target_deck_ids:
                if need <= 0:
                    break
                try:
                    _name, added, _remaining = _add_next_words_to_plan(session, deck_id=int(did), count=need)
                except Exception:
                    continue
                need -= int(added)

            # Refresh "now": _add_next_words_to_plan sets due_at to its own _utcnow(), which might be slightly later.
            now = _utcnow()
            more_rows = (
                session.query(SrsCard.word_id)
                .filter(SrsCard.due_at <= now)
                .order_by(SrsCard.due_at.asc(), SrsCard.word_id.asc())
                .limit(desired)
                .all()
            )
            for (wid,) in more_rows:
                iw = int(wid)
                if iw in seen:
                    continue
                seen.add(iw)
                picked.append(iw)
                if len(picked) >= desired:
                    break

        if not picked:
            msg = "今天没有可生成作业的单词。先去“词书库”导入词书，或先在自学模式积累学习记录。"
            return _redirect("/?" + urlencode({"toast": msg}))

        plan = _ensure_default_plan(session)
        fetched = session.query(Word).filter(Word.id.in_(picked)).all()
        by_id = {int(w.id): w for w in fetched}
        words: list[dict[str, Any]] = []
        for wid in picked:
            w = by_id.get(int(wid))
            if not w:
                continue
            _ensure_plan_word(session, plan, int(w.id), None)
            if session.get(SrsCard, int(w.id)) is None:
                session.add(SrsCard(word_id=int(w.id), due_at=now))
            words.append(
                {
                    "word_id": int(w.id),
                    "term": str(w.term or ""),
                    "definition_short": _short_definition(w.definition),
                    "example": str(w.example or "").strip(),
                    "pos": _pos_hint_from_definition(str(w.definition or "")),
                }
            )

        if not words:
            msg = "今天没有可生成作业的单词（选中的词条不存在或已被删除）。"
            return _redirect("/?" + urlencode({"toast": msg}))

        has_missing_def = any(not str(w.get("definition_short") or "").strip() for w in words)
        if has_missing_def and "mcq" in cleaned_qt:
            cleaned_qt = [t for t in cleaned_qt if t != "mcq"]
            warnings.append("部分单词缺少中文释义，已自动移除“选择题”。")
        if has_missing_def and "spelling" in cleaned_qt:
            warnings.append("缺少中文释义的单词：拼写题将不显示中文提示。")
        if not cleaned_qt:
            cleaned_qt = ["spelling"]
            warnings.append("本次作业没有可用题型，已自动保留“拼写题”。")

        mcq: list[dict[str, Any]] = []
        mcq_answers: list[str] = []
        if "mcq" in cleaned_qt:
            pool = _query_mcq_distractor_pool(session, exclude_word_ids={int(w["word_id"]) for w in words})
            mcq, mcq_answers = _build_mcq(words, distractor_pool=pool)

        cloze: list[dict[str, Any]] = []
        cloze_answers: list[str] = []
        if "cloze" in cleaned_qt:
            cloze, cloze_answers = _build_cloze(words, stage=stage)

        reading: dict[str, Any] = {}
        reading_answers: list[str] = []
        if "reading" in cleaned_qt:
            all_terms = [str(w.get("term") or "").strip() for w in words if str(w.get("term") or "").strip()]
            k = 5 if stage == "primary" else 6
            reading_terms = all_terms[:k]
            if len(reading_terms) < 3:
                cleaned_qt = [t for t in cleaned_qt if t != "reading"]
                warnings.append("阅读理解需要至少 3 个单词，本次已自动移除。")
            else:
                notes = {str(w.get("term") or "").strip(): str(w.get("definition_short") or "").strip() for w in words}
                sim = _ai_generate_reading_for_worksheet(stage=stage, terms=reading_terms, term_notes=notes)
                if sim is None:
                    cleaned_qt = [t for t in cleaned_qt if t != "reading"]
                    warnings.append("阅读理解生成失败，已自动移除。")
                else:
                    reading = sim.model_dump()
                    reading["target_terms"] = reading_terms
                    letters = ["A", "B", "C", "D"]
                    for q in sim.questions:
                        idx = int(getattr(q, "answer_index", 0) or 0)
                        reading_answers.append(letters[idx] if 0 <= idx < 4 else "A")

        if not cleaned_qt:
            cleaned_qt = ["spelling"]
            warnings.append("本次作业题型生成失败，已自动保留“拼写题”。")

        answers: dict[str, Any] = {}
        if mcq_answers:
            answers["mcq"] = mcq_answers
        if cloze_answers:
            answers["cloze"] = cloze_answers
        if reading_answers:
            answers["reading"] = reading_answers
        sheet = {
            "version": 1,
            "stage": stage,
            "question_types": cleaned_qt,
            "warnings": warnings,
            "words": words,
            "mcq": mcq,
            "cloze": cloze,
            "reading": reading,
            "answers": answers,
        }

        row = Worksheet(
            title=f"作业（今日）{now.strftime('%Y-%m-%d')}",
            mode="today",
            stage=stage,
            word_ids_json=json.dumps([int(w["word_id"]) for w in words], ensure_ascii=False),
            sheet_json=json.dumps(sheet, ensure_ascii=False),
            meta_json=json.dumps({}, ensure_ascii=False),
        )
        session.add(row)
        session.flush()
        ws_id = int(row.id)

    return _redirect(f"/worksheets/{ws_id}")


def _def_bigrams(s: str) -> set[str]:
    t = (s or "").strip()
    if not t:
        return set()
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"[，。,;；/｜|（）()\\[\\]{}<>·—…\\-]+", "", t)
    if not t:
        return set()
    if len(t) == 1:
        return {t}
    return {t[i : i + 2] for i in range(len(t) - 1)}


def _def_similarity(a: str, b: str) -> float:
    a2 = (a or "").strip()
    b2 = (b or "").strip()
    if not a2 or not b2:
        return 0.0
    bg_a = _def_bigrams(a2)
    bg_b = _def_bigrams(b2)
    if not bg_a or not bg_b:
        return 0.0
    inter = len(bg_a & bg_b)
    union = len(bg_a | bg_b)
    jaccard = (inter / union) if union else 0.0
    seq = difflib.SequenceMatcher(None, a2, b2).ratio()
    return jaccard * 0.7 + seq * 0.3


def _term_similarity(a: str, b: str) -> float:
    a2 = (a or "").strip().lower()
    b2 = (b or "").strip().lower()
    if not a2 or not b2:
        return 0.0
    if a2 == b2:
        return 1.0
    return difflib.SequenceMatcher(None, a2, b2).ratio()


def _query_mcq_distractor_pool(
    session,
    *,
    limit: int = 900,
    exclude_word_ids: set[int] | None = None,
) -> list[dict[str, str]]:
    q = session.query(Word.id, Word.term, Word.definition).filter(Word.definition.is_not(None))
    q = q.filter(Word.definition != "")
    if exclude_word_ids:
        q = q.filter(~Word.id.in_(exclude_word_ids))
    rows = q.order_by(Word.id.desc()).limit(int(limit)).all()
    out: list[dict[str, str]] = []
    for _wid, term, definition in rows:
        sd = _short_definition(str(definition or ""))
        if not sd:
            continue
        out.append({"term": str(term or ""), "definition_short": sd})
    return out


def _build_mcq(
    words: list[dict[str, Any]],
    *,
    distractor_pool: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """
    Multiple-choice (英译中):
    - Prefer distractors from "confusable" words (spelling-similar terms).
    - Fallback to meaning-similar short definitions.
    - Never use placeholder fillers (以上都不对/无法判断/先跳过...).
    """
    base_pool: list[tuple[str, str]] = []
    seen_terms: set[str] = set()

    def _add(term: str, def_short: str) -> None:
        t = (term or "").strip()
        d = (def_short or "").strip()
        if not t or not d:
            return
        key = t.lower()
        if key in seen_terms:
            return
        seen_terms.add(key)
        base_pool.append((t, d))

    for w in words:
        _add(str(w.get("term") or ""), str(w.get("definition_short") or ""))
    for it in (distractor_pool or []):
        _add(str(it.get("term") or ""), str(it.get("definition_short") or ""))

    questions: list[dict[str, Any]] = []
    answers: list[str] = []
    pool_defs = [d for (_t, d) in base_pool]

    for i, w in enumerate(words):
        term = str(w.get("term") or "").strip()
        correct = str(w.get("definition_short") or "").strip() or "（无释义）"
        distractors: list[str] = []

        # 1) Confusable terms (spelling-similar)
        similar: list[tuple[float, str]] = []
        for t2, d2 in base_pool:
            if not d2 or d2 == correct:
                continue
            if t2.strip().lower() == term.lower():
                continue
            sim = _term_similarity(term, t2)
            if sim >= 0.72:
                similar.append((sim, d2))
        similar.sort(key=lambda x: x[0], reverse=True)
        for _sim, d2 in similar:
            if d2 not in distractors:
                distractors.append(d2)
            if len(distractors) >= 3:
                break

        # 2) Meaning-similar (Chinese short definition similarity)
        if len(distractors) < 3 and correct and correct != "（无释义）":
            ms: list[tuple[float, str]] = []
            for d2 in pool_defs:
                if not d2 or d2 == correct or d2 in distractors:
                    continue
                score = _def_similarity(correct, d2)
                if score > 0:
                    ms.append((score, d2))
            ms.sort(key=lambda x: x[0], reverse=True)
            for _score, d2 in ms:
                if d2 not in distractors:
                    distractors.append(d2)
                if len(distractors) >= 3:
                    break

        # 3) Fill with any other defs (deterministic order)
        if len(distractors) < 3:
            for d2 in pool_defs:
                if not d2 or d2 == correct or d2 in distractors:
                    continue
                distractors.append(d2)
                if len(distractors) >= 3:
                    break

        # Worst-case: still not enough (tiny datasets). Use safe placeholders (rare, offline tests).
        while len(distractors) < 3:
            distractors.append("—")

        choices = [correct] + distractors[:3]
        rot = i % 4
        choices = choices[rot:] + choices[:rot]
        answer_index = choices.index(correct) if correct in choices else 0
        answers.append(["A", "B", "C", "D"][answer_index])
        questions.append(
            {
                "word_id": int(w["word_id"]),
                "stem": term,
                "choices": choices,
                "answer_index": answer_index,
            }
        )

    return questions, answers


def _build_cloze(words: list[dict[str, Any]], *, stage: str) -> tuple[list[dict[str, Any]], list[str]]:
    def _guess_pos(short_def: str, pos_hint: str) -> str:
        hint = (pos_hint or "").strip().lower()
        if hint in {"n", "v", "adj", "adv"}:
            return hint
        s = (short_def or "").strip()
        if not s:
            return ""
        if s.endswith("的"):
            return "adj"
        # Common verb-like Chinese hints.
        if any(k in s for k in ["做", "使", "让", "增加", "提高", "收集", "进行", "拥有", "拿", "举", "抬"]):
            return "v"
        return ""

    def _fallback_sentence(term: str, *, stage: str, pos: str, note: str, seed: int) -> str:
        t = (term or "").strip()
        if not t:
            return "____."
        stage2 = (stage or "junior").strip().lower()
        pos2 = (pos or "").strip().lower()
        note2 = (note or "").strip()

        noun_primary = [
            "I see [[{t}]] at school.",
            "We visit the [[{t}]] today.",
            "Look at the [[{t}]].",
            "The [[{t}]] is over there.",
            "My friend has a [[{t}]].",
        ]
        verb_primary = [
            "I [[{t}]] my hand in class.",
            "I [[{t}]] a book at home.",
            "We [[{t}]] together after school.",
            "I [[{t}]] it every day.",
            "They [[{t}]] it for fun.",
        ]
        adj_primary = [
            "The food is [[{t}]] today.",
            "This cake tastes [[{t}]].",
            "I feel [[{t}]] today.",
            "The day is [[{t}]].",
            "This is [[{t}]] to me.",
        ]
        other_primary = [
            "Today we learn [[{t}]].",
            "Please write [[{t}]] here.",
            "Can you spell [[{t}]]?",
            "We practice [[{t}]] now.",
            "Remember [[{t}]] today.",
        ]

        noun_junior = [
            "We saw a [[{t}]] on our way home.",
            "The [[{t}]] is near the city.",
            "Our class visited the [[{t}]] last week.",
            "He works in a [[{t}]].",
            "They live on the [[{t}]].",
        ]
        verb_junior = [
            "Please [[{t}]] your hand to answer.",
            "I [[{t}]] stamps as a hobby.",
            "We [[{t}]] the problem step by step.",
            "They [[{t}]] money for the trip.",
            "I [[{t}]] it every morning.",
        ]
        adj_junior = [
            "The soup smells [[{t}]] and warm.",
            "I am [[{t}]] that we can finish it.",
            "It is [[{t}]] to happen soon.",
            "The answer is [[{t}]] this time.",
            "The view is [[{t}]] after rain.",
        ]
        other_junior = [
            "Try to use [[{t}]] in a sentence.",
            "Please spell [[{t}]] correctly.",
            "We will review [[{t}]] tomorrow.",
            "Write down [[{t}]] in your notebook.",
            "Remember the word [[{t}]] today.",
        ]

        if stage2 == "primary":
            table = {"n": noun_primary, "v": verb_primary, "adj": adj_primary, "adv": other_primary}
        else:
            table = {"n": noun_junior, "v": verb_junior, "adj": adj_junior, "adv": other_junior}
        templates = table.get(pos2) or table.get("n") or noun_junior

        # Small hint-based tweaks for a few common notes.
        if pos2 == "v" and ("收集" in note2 or "搜集" in note2):
            templates = [tpl for tpl in templates if "stamps" in tpl] + templates
        if pos2 == "v" and ("举" in note2 or "抬" in note2):
            templates = [tpl for tpl in templates if "hand" in tpl] + templates
        if pos2 == "adj" and ("美味" in note2 or "好吃" in note2):
            templates = [tpl for tpl in templates if "cake" in tpl or "food" in tpl] + templates

        tpl = templates[seed % len(templates)]
        return tpl.format(t=t)

    need_ai_terms: list[str] = []
    term_notes: dict[str, str] = {}
    for w in words:
        term = str(w.get("term") or "").strip()
        ex = str(w.get("example") or "").strip()
        if term and (not ex or term.lower() not in ex.lower()):
            need_ai_terms.append(term)
            term_notes[term] = str(w.get("definition_short") or "").strip()

    ai_sentences: dict[str, str] = {}
    if need_ai_terms:
        ai_sentences = _ai_generate_sentences_for_terms(stage=stage, terms=need_ai_terms[:20], term_notes=term_notes)

    items: list[dict[str, Any]] = []
    answers: list[str] = []
    used_blanks: set[str] = set()
    for w in words:
        term = str(w.get("term") or "").strip()
        ex = str(w.get("example") or "").strip()
        note = str(w.get("definition_short") or "").strip()
        pos = _guess_pos(note, str(w.get("pos") or ""))
        sent = ex
        # Prefer AI sentence when example is missing or doesn't contain term.
        if term and term in ai_sentences:
            sent = ai_sentences[term]
        if not sent:
            sent = _fallback_sentence(term, stage=stage, pos=pos, note=note, seed=len(items))
        # Normalize marker to blank
        blank = sent
        if term:
            blank = re.sub(rf"\[\[{re.escape(term)}\]\]", "____", blank, flags=re.IGNORECASE)
            blank = re.sub(rf"\b{re.escape(term)}\b", "____", blank, flags=re.IGNORECASE)
        # Avoid repeated ultra-generic blanks in fallback mode by rotating templates.
        if blank in used_blanks and term:
            for extra in range(1, 8):
                sent2 = _fallback_sentence(term, stage=stage, pos=pos, note=note, seed=len(items) + extra)
                blank2 = re.sub(rf"\[\[{re.escape(term)}\]\]", "____", sent2, flags=re.IGNORECASE)
                blank2 = re.sub(rf"\b{re.escape(term)}\b", "____", blank2, flags=re.IGNORECASE)
                if blank2 not in used_blanks:
                    blank = blank2
                    break
        used_blanks.add(blank)
        items.append({"word_id": int(w["word_id"]), "sentence_blank": blank})
        answers.append(term or "")

    return items, answers


@app.post("/worksheets/generate")
def worksheets_generate(
    request: Request,
    mode: str = Form("extract"),
    stage: str = Form("junior"),
    word_ids: list[int] = Form([]),
    question_types: list[str] = Form([]),
):
    blocked = _require_parent_mode_for_worksheets(request)
    if blocked is not None:
        return blocked

    stage = (stage or "junior").strip().lower()
    if stage not in {"primary", "junior"}:
        stage = "junior"

    allowed_qt = {"spelling", "mcq", "cloze", "reading"}
    cleaned_qt: list[str] = []
    for raw in question_types or []:
        key = str(raw or "").strip().lower()
        if key in allowed_qt and key not in cleaned_qt:
            cleaned_qt.append(key)
    if not cleaned_qt:
        cleaned_qt = ["spelling", "mcq"] if stage == "primary" else ["spelling", "mcq", "cloze"]

    warnings: list[str] = []

    cleaned: list[int] = []
    for raw in word_ids or []:
        try:
            wid = int(raw)
        except Exception:
            continue
        if wid > 0 and wid not in cleaned:
            cleaned.append(wid)
    if not cleaned:
        return _redirect("/worksheets?" + urlencode({"toast": "请至少勾选 1 个单词"}))

    now = _utcnow()
    with get_session() as session:
        plan = _ensure_default_plan(session)
        fetched = session.query(Word).filter(Word.id.in_(cleaned)).all()
        by_id = {int(w.id): w for w in fetched}
        words: list[dict[str, Any]] = []
        for wid in cleaned:
            w = by_id.get(wid)
            if not w:
                continue
            words.append(
                {
                    "word_id": int(w.id),
                    "term": str(w.term or ""),
                    "definition_short": _short_definition(w.definition),
                    "example": str(w.example or "").strip(),
                    "pos": _pos_hint_from_definition(str(w.definition or "")),
                }
            )

        if not words:
            return _redirect("/worksheets?" + urlencode({"toast": "勾选的单词已不存在（可能被删除）。"}))

        has_missing_def = any(not str(w.get("definition_short") or "").strip() for w in words)
        if has_missing_def and "mcq" in cleaned_qt:
            cleaned_qt = [t for t in cleaned_qt if t != "mcq"]
            warnings.append("部分单词缺少中文释义，已自动移除“选择题”。")
        if has_missing_def and "spelling" in cleaned_qt:
            warnings.append("缺少中文释义的单词：拼写题将不显示中文提示。")
        if not cleaned_qt:
            cleaned_qt = ["spelling"]
            warnings.append("本次作业没有可用题型，已自动保留“拼写题”。")

        mcq: list[dict[str, Any]] = []
        mcq_answers: list[str] = []
        if "mcq" in cleaned_qt:
            pool = _query_mcq_distractor_pool(session, exclude_word_ids={int(w["word_id"]) for w in words})
            mcq, mcq_answers = _build_mcq(words, distractor_pool=pool)

        cloze: list[dict[str, Any]] = []
        cloze_answers: list[str] = []
        if "cloze" in cleaned_qt:
            cloze, cloze_answers = _build_cloze(words, stage=stage)

        reading: dict[str, Any] = {}
        reading_answers: list[str] = []
        if "reading" in cleaned_qt:
            all_terms = [str(w.get("term") or "").strip() for w in words if str(w.get("term") or "").strip()]
            k = 5 if stage == "primary" else 6
            reading_terms = all_terms[:k]
            if len(reading_terms) < 3:
                cleaned_qt = [t for t in cleaned_qt if t != "reading"]
                warnings.append("阅读理解需要至少 3 个单词，本次已自动移除。")
            else:
                notes = {str(w.get("term") or "").strip(): str(w.get("definition_short") or "").strip() for w in words}
                sim = _ai_generate_reading_for_worksheet(stage=stage, terms=reading_terms, term_notes=notes)
                if sim is None:
                    cleaned_qt = [t for t in cleaned_qt if t != "reading"]
                    warnings.append("阅读理解生成失败，已自动移除。")
                else:
                    reading = sim.model_dump()
                    reading["target_terms"] = reading_terms
                    letters = ["A", "B", "C", "D"]
                    for q in sim.questions:
                        idx = int(getattr(q, "answer_index", 0) or 0)
                        reading_answers.append(letters[idx] if 0 <= idx < 4 else "A")

        if not cleaned_qt:
            cleaned_qt = ["spelling"]
            warnings.append("本次作业题型生成失败，已自动保留“拼写题”。")

        answers: dict[str, Any] = {}
        if mcq_answers:
            answers["mcq"] = mcq_answers
        if cloze_answers:
            answers["cloze"] = cloze_answers
        if reading_answers:
            answers["reading"] = reading_answers

        sheet = {
            "version": 1,
            "stage": stage,
            "question_types": cleaned_qt,
            "warnings": warnings,
            "words": words,
            "mcq": mcq,
            "cloze": cloze,
            "reading": reading,
            "answers": answers,
        }

        # Ensure plan + cards exist so grading can feed FSRS.
        for w in words:
            wid = int(w["word_id"])
            _ensure_plan_word(session, plan, wid, None)
            if session.get(SrsCard, wid) is None:
                session.add(SrsCard(word_id=wid, due_at=now))

        title = f"作业（{_stage_label(stage)}）{now.strftime('%Y-%m-%d')}"
        row = Worksheet(
            title=title,
            mode=(mode or "extract").strip().lower(),
            stage=stage,
            word_ids_json=json.dumps([int(w["word_id"]) for w in words], ensure_ascii=False),
            sheet_json=json.dumps(sheet, ensure_ascii=False),
            meta_json=json.dumps({}, ensure_ascii=False),
        )
        session.add(row)
        session.flush()
        wid = int(row.id)

    return _redirect(f"/worksheets/{wid}")


@app.get("/worksheets/{worksheet_id}", response_class=HTMLResponse)
def worksheet_detail(
    request: Request,
    worksheet_id: int,
    toast: str | None = None,
    view: str | None = None,
    layout: str | None = None,
):
    blocked = _require_parent_mode_for_worksheets(request)
    if blocked is not None:
        return blocked

    def _is_missing_short_def(s: str) -> bool:
        t = (s or "").strip()
        return (not t) or t in {"（无释义）", "(无释义)", "无释义"}

    def _mcq_has_placeholders(mcq_items: list[dict[str, Any]]) -> bool:
        fillers = {
            "（无释义）",
            "(无释义)",
            "（以上都不对）",
            "（无法判断）",
            "（先跳过）",
            "（都不是）",
            "（不确定）",
        }
        for q in mcq_items or []:
            for c in (q.get("choices") or []):
                if str(c or "").strip() in fillers:
                    return True
        return False

    with get_session() as session:
        row = session.get(Worksheet, int(worksheet_id))
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        sheet = _safe_json_dict(row.sheet_json)
        meta = _safe_json_dict(row.meta_json)

        stage = str(row.stage or sheet.get("stage") or "junior").strip().lower()
        if stage not in {"primary", "junior"}:
            stage = "junior"

        question_types_raw = sheet.get("question_types")
        question_types: list[str] = []
        if isinstance(question_types_raw, list):
            for x in question_types_raw:
                k = str(x or "").strip().lower()
                if k in {"spelling", "mcq", "cloze", "reading"} and k not in question_types:
                    question_types.append(k)
        if not question_types:
            question_types = ["spelling", "mcq"] if stage == "primary" else ["spelling", "mcq", "cloze"]

        warnings = list(sheet.get("warnings") or []) if isinstance(sheet.get("warnings"), list) else []

        words = list(sheet.get("words") or [])
        # Hydrate missing short defs/examples from the DB so older worksheets remain usable.
        word_ids = [int(w.get("word_id") or 0) for w in words if int(w.get("word_id") or 0) > 0]
        if word_ids:
            fetched = session.query(Word).filter(Word.id.in_(word_ids)).all()
            by_id = {int(w.id): w for w in fetched}
            for it in words:
                wid = int(it.get("word_id") or 0)
                if wid <= 0:
                    continue
                w = by_id.get(wid)
                if not w:
                    continue
                if not str(it.get("term") or "").strip():
                    it["term"] = str(w.term or "")
                if _is_missing_short_def(str(it.get("definition_short") or "")):
                    d = _short_definition(str(w.definition or ""))
                    if d:
                        it["definition_short"] = d
                    else:
                        it["definition_short"] = ""
                if not str(it.get("example") or "").strip() and str(w.example or "").strip():
                    it["example"] = str(w.example or "").strip()

        missing_def_count = sum(1 for w in words if _is_missing_short_def(str(w.get("definition_short") or "")))
        if missing_def_count > 0:
            if "mcq" in question_types:
                question_types = [t for t in question_types if t != "mcq"]
                warnings.append("本次作业包含缺少中文释义的单词，已自动移除“选择题”。")
            if "spelling" in question_types:
                warnings.append("缺少中文释义的单词：拼写题将不显示中文提示。")
        if not question_types:
            question_types = ["spelling"]
            warnings.append("本次作业没有可用题型，已自动保留“拼写题”。")

        mcq = list(sheet.get("mcq") or []) if "mcq" in question_types else []
        cloze = list(sheet.get("cloze") or []) if "cloze" in question_types else []
        reading_obj = sheet.get("reading") or {}
        reading: dict[str, Any] = reading_obj if isinstance(reading_obj, dict) else {}
        reading_questions = list(reading.get("questions") or []) if "reading" in question_types else []
        reading_passage_html = _passage_to_html(str(reading.get("passage") or "")) if "reading" in question_types else ""
        answers = sheet.get("answers") or {}

        if "mcq" in question_types and _mcq_has_placeholders(mcq) and missing_def_count == 0:
            pool = _query_mcq_distractor_pool(session, exclude_word_ids={int(w.get("word_id") or 0) for w in words})
            mcq, mcq_answers = _build_mcq(words, distractor_pool=pool)
            answers = dict(answers or {})
            answers["mcq"] = mcq_answers
        else:
            mcq_answers = list((answers.get("mcq") or []))

        cloze_answers = list((answers.get("cloze") or [])) if "cloze" in question_types else []
        reading_answers = list((answers.get("reading") or [])) if "reading" in question_types else []

    word_bank = [str(w.get("term") or "") for w in words]
    spelling_answers = [str(w.get("term") or "") for w in words]

    view2 = "grading" if str(view or "").strip().lower() == "grading" else "sheet"
    layout2 = "standard" if str(layout or "").strip().lower() == "standard" else "economy"

    return templates.TemplateResponse(
        request,
        "worksheet.html",
        {
            "worksheet_id": int(row.id),
            "title": (row.title or f"作业 #{row.id}").strip(),
            "created_at": row.created_at,
            "stage": stage,
            "stage_label": _stage_label(stage),
            "words": words,
            "mcq": mcq,
            "cloze": cloze,
            "reading_passage_html": reading_passage_html,
            "reading_questions": reading_questions,
            "word_bank": word_bank,
            "mcq_answers": mcq_answers,
            "cloze_answers": cloze_answers,
            "reading_answers": reading_answers,
            "spelling_answers": spelling_answers,
            "question_types": question_types,
            "warnings": warnings,
            "missing_def_count": int(missing_def_count),
            "already_graded": bool(meta.get("graded_at")),
            "toast": (toast or "").strip(),
            "view": view2,
            "layout": layout2,
        },
    )


@app.post("/worksheets/{worksheet_id}/grade")
def worksheet_grade(
    request: Request,
    worksheet_id: int,
    wrong_word_ids: list[int] = Form([]),
    view: str | None = None,
    layout: str | None = None,
):
    blocked = _require_parent_mode_for_worksheets(request)
    if blocked is not None:
        return blocked

    cleaned_wrong: set[int] = set()
    for raw in wrong_word_ids or []:
        try:
            cleaned_wrong.add(int(raw))
        except Exception:
            continue

    with get_session() as session:
        row = session.get(Worksheet, int(worksheet_id))
        if not row:
            raise HTTPException(status_code=404, detail="not found")

        meta = _safe_json_dict(row.meta_json)
        if meta.get("graded_at"):
            params = {"toast": "此作业已提交过"}
            if str(view or "").strip().lower() == "grading":
                params["view"] = "grading"
            if str(layout or "").strip().lower() == "standard":
                params["layout"] = "standard"
            return _redirect(f"/worksheets/{worksheet_id}?" + urlencode(params))

        sheet = _safe_json_dict(row.sheet_json)
        words = list(sheet.get("words") or [])
        word_ids = [int(w.get("word_id") or 0) for w in words if int(w.get("word_id") or 0) > 0]

        scheduler = get_scheduler()
        now = _utcnow()

        for wid in word_ids:
            word = session.get(Word, wid)
            if not word:
                continue

            card_row = _ensure_srs_card(session, wid)
            fsrs_card = db_card_to_fsrs(card_row)
            r = Rating.Again if wid in cleaned_wrong else Rating.Good
            updated_card, _log = scheduler.review_card(fsrs_card, r)
            apply_fsrs_to_db(card_row, updated_card)

            word.last_reviewed_at = now
            if r == Rating.Again:
                word.wrong_count += 1
                session.add(Mistake(word_id=wid))
            else:
                word.correct_count += 1

            session.add(SrsReviewLog(word_id=wid, rating=int(r.value), reviewed_at=now, duration_ms=None))

        meta["graded_at"] = now.isoformat()
        meta["wrong_word_ids"] = sorted(list(cleaned_wrong))
        row.meta_json = json.dumps(meta, ensure_ascii=False)

    params = {"toast": "已记录错词并安排复习"}
    if str(view or "").strip().lower() == "grading":
        params["view"] = "grading"
    if str(layout or "").strip().lower() == "standard":
        params["layout"] = "standard"
    return _redirect(f"/worksheets/{worksheet_id}?" + urlencode(params))


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, toast: str | None = None):
    s = get_settings()
    ai_status = "Mock（离线演示）" if s.ai_mock else ("已配置" if s.ai_api_key else "未配置")
    owner_norm = _request_owner_norm(request)
    with get_session() as session:
        plan = _ensure_default_plan(session)
        parent = _ensure_parent_settings(session)
        mistakes_pref = _ensure_mistake_practice_settings(session, owner_norm)
        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        word_count = int(session.query(Word).count())
        deck_count = int(session.query(Deck).count())

    target_ids = json.loads(parent.target_deck_ids_json or "[]")
    if not isinstance(target_ids, list):
        target_ids = []
    target_id_set = {int(x) for x in target_ids if isinstance(x, int) or (isinstance(x, str) and str(x).isdigit())}

    target_candidates: list[Deck] = []
    freq_candidates: list[Deck] = []
    for d in decks:
        name = (d.name or "").strip()
        if any(k in name for k in ["中考", "小升初", "KET", "PET", "高频", "词频"]):
            target_candidates.append(d)
        if any(k in name for k in ["高频", "10k", "30k", "词频"]):
            freq_candidates.append(d)
    return templates.TemplateResponse(
        request,
        "settings.html",
        {
            "ai_status": ai_status,
            "ai_base_url": s.ai_base_url,
            "ai_model": s.ai_writer_model or s.ai_model,
            "ai_checker_model": s.ai_checker_model or "",
            "db_path": str(s.db_path),
            "word_count": word_count,
            "deck_count": deck_count,
            "plan_daily_new_limit": int(plan.daily_new_limit),
            "plan_daily_review_limit": int(plan.daily_review_limit),
            "plan_suspend_new_when_due_over": int(plan.suspend_new_when_due_over),
            "parent_stage": (parent.stage or "junior"),
            "parent_daily_words": int(parent.daily_words or 10),
            "parent_textbook_deck_id": int(parent.textbook_deck_id) if parent.textbook_deck_id else 0,
            "parent_target_deck_ids": sorted(target_id_set),
            "parent_frequency_deck_id": int(parent.frequency_deck_id) if parent.frequency_deck_id else 0,
            "decks": decks,
            "parent_target_deck_candidates": target_candidates,
            "parent_frequency_deck_candidates": freq_candidates,
            "mistake_default_level": (mistakes_pref.default_level or "auto"),
            "mistake_default_length_mode": (mistakes_pref.default_length_mode or "standard"),
            "mistake_default_include_once": 1 if int(mistakes_pref.default_include_once or 0) == 1 else 0,
            "mistake_use_fixed_target_count": 1 if int(mistakes_pref.use_fixed_target_count or 0) == 1 else 0,
            "mistake_default_target_count": (
                int(mistakes_pref.default_target_count)
                if mistakes_pref.default_target_count is not None
                else 10
            ),
            "toast": (toast or "").strip(),
        },
    )


@app.post("/settings/mode")
def update_ui_mode(request: Request, mode: str = Form("self"), return_to: str = Form("/settings")):
    mode = (mode or "").strip().lower()
    if mode not in {_UI_MODE_PARENT, _UI_MODE_SELF}:
        mode = _UI_MODE_SELF

    label = "家长帮孩子学" if mode == _UI_MODE_PARENT else "自己学"
    dest = _safe_next(return_to or "/settings")
    dest_url = dest + "?" + urlencode({"toast": f"已切换到：{label}"})

    # The app uses hx-boost and only swaps #content, but the top navigation lives outside that swap area.
    # When switching modes we must force a full navigation so the header is re-rendered with the new mode.
    if (request.headers.get("HX-Request") or "").strip().lower() == "true":
        resp = Response(status_code=200)
        resp.headers["HX-Redirect"] = dest_url
        _set_ui_mode_cookie(resp, request, mode)
        return resp

    resp = _redirect(dest_url)
    _set_ui_mode_cookie(resp, request, mode)
    return resp


@app.post("/settings/plan")
def update_plan_settings(
    daily_new_limit: int = Form(20),
    daily_review_limit: int = Form(200),
    suspend_new_when_due_over: int = Form(200),
    return_to: str | None = Form(None),
):
    def _to_int(v: Any, *, name: str, lo: int, hi: int) -> int:
        try:
            n = int(v)
        except Exception:
            raise HTTPException(status_code=400, detail=f"{name} must be an integer")
        if n < lo or n > hi:
            raise HTTPException(status_code=400, detail=f"{name} must be between {lo} and {hi}")
        return n

    new_limit = _to_int(daily_new_limit, name="daily_new_limit", lo=1, hi=200)
    review_limit = _to_int(daily_review_limit, name="daily_review_limit", lo=0, hi=5000)
    suspend_over = _to_int(suspend_new_when_due_over, name="suspend_new_when_due_over", lo=0, hi=5000)

    with get_session() as session:
        plan = _ensure_default_plan(session)
        old_new_limit = int(plan.daily_new_limit or 20)
        plan.daily_new_limit = new_limit
        plan.daily_review_limit = review_limit
        plan.suspend_new_when_due_over = suspend_over

        # If user increases daily_new_limit, top up "today due new cards" so 首页「今天待学」会立刻增加。
        # This matches the UX expectation that changing the plan immediately makes more words available.
        auto_added = 0
        if new_limit > old_new_limit:
            now = _utcnow()
            due_review_total = int(
                session.query(func.count(SrsCard.word_id))
                .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_not(None))
                .scalar()
                or 0
            )
            due_new = int(
                session.query(func.count(SrsCard.word_id))
                .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None))
                .scalar()
                or 0
            )
            if suspend_over <= 0 or due_review_total <= suspend_over:
                need = max(0, new_limit - due_new)
                if need > 0:
                    planned_ids = session.query(PlanWord.word_id).filter(PlanWord.plan_id == plan.id)
                    # Prefer decks already linked to the plan (by priority), then any deck with remaining words.
                    plan_deck_ids = [
                        int(did)
                        for (did,) in session.query(PlanDeck.deck_id)
                        .filter(PlanDeck.plan_id == plan.id)
                        .order_by(PlanDeck.priority.asc(), PlanDeck.id.asc())
                        .all()
                    ]

                    def _deck_remaining_counts(deck_ids: list[int] | None) -> list[tuple[int, int]]:
                        q = session.query(DeckWord.deck_id, func.count(DeckWord.word_id))
                        q = q.filter(~DeckWord.word_id.in_(planned_ids))
                        if deck_ids:
                            q = q.filter(DeckWord.deck_id.in_(deck_ids))
                        q = q.group_by(DeckWord.deck_id).order_by(func.count(DeckWord.word_id).desc())
                        return [(int(d), int(c)) for (d, c) in q.all()]

                    candidates: list[int] = []
                    # First pass: plan decks
                    for did, _cnt in _deck_remaining_counts(plan_deck_ids):
                        if did not in candidates:
                            candidates.append(did)
                    # Second pass: any decks
                    for did, _cnt in _deck_remaining_counts(None):
                        if did not in candidates:
                            candidates.append(did)

                    for did in candidates:
                        if need <= 0:
                            break
                        _name, added, _remaining = _add_next_words_to_plan(session, deck_id=did, count=need)
                        if added > 0:
                            auto_added += int(added)
                            need -= int(added)
                    # If still need > 0, there simply aren't enough remaining words to add.

    toast = "已保存学习计划设置"
    if auto_added > 0:
        toast += f"（已补充今日新词 {auto_added} 个）"
    msg = {"toast": toast}
    if (return_to or "").strip().lower() in {"home", "today", "/"}:
        return _redirect("/?" + urlencode(msg))
    return _redirect("/settings?" + urlencode(msg))


@app.post("/settings/mistakes")
def update_mistake_settings(
    request: Request,
    default_level: str = Form("auto"),
    default_length_mode: str = Form("standard"),
    default_include_once: int = Form(0),
    use_fixed_target_count: int = Form(0),
    default_target_count: int | None = Form(None),
):
    level_raw = (default_level or "auto").strip().lower()
    allowed_levels = {"auto", *set(LEVEL_GUIDE.keys())}
    level_value = level_raw if level_raw in allowed_levels else "auto"

    length_raw = (default_length_mode or "standard").strip().lower()
    length_value = length_raw if length_raw in {"standard", "long"} else "standard"

    include_once_value = 1 if int(default_include_once or 0) == 1 else 0
    use_fixed_value = 1 if int(use_fixed_target_count or 0) == 1 else 0

    target_value: int | None = None
    if use_fixed_value == 1:
        try:
            n = int(default_target_count) if default_target_count is not None else 10
        except Exception:
            n = 10
        target_value = max(6, min(14, n))

    owner_norm = _request_owner_norm(request)
    with get_session() as session:
        row = _ensure_mistake_practice_settings(session, owner_norm)
        row.default_level = level_value
        row.default_length_mode = length_value
        row.default_include_once = include_once_value
        row.use_fixed_target_count = use_fixed_value
        row.default_target_count = target_value if use_fixed_value == 1 else None

    return _redirect("/settings?" + urlencode({"toast": "已保存错词篮默认设置"}))


@app.post("/settings/parent")
def update_parent_settings(
    stage: str = Form("junior"),
    daily_words: int = Form(10),
    textbook_deck_id: int = Form(0),
    frequency_deck_id: int = Form(0),
    target_deck_ids: list[int] = Form([]),
):
    stage = (stage or "").strip().lower()
    if stage not in {"primary", "junior"}:
        stage = "junior"

    try:
        daily_n = int(daily_words)
    except Exception:
        daily_n = 10
    daily_n = max(1, min(60, daily_n))

    tb_id = int(textbook_deck_id or 0) or None
    freq_id = int(frequency_deck_id or 0) or None

    cleaned_target_ids: list[int] = []
    for raw in target_deck_ids or []:
        try:
            did = int(raw)
        except Exception:
            continue
        if did > 0 and did not in cleaned_target_ids:
            cleaned_target_ids.append(did)

    with get_session() as session:
        row = _ensure_parent_settings(session)
        row.stage = stage
        row.daily_words = daily_n
        row.textbook_deck_id = tb_id
        row.frequency_deck_id = freq_id
        row.target_deck_ids_json = json.dumps(cleaned_target_ids, ensure_ascii=False)

    return _redirect("/settings?" + urlencode({"toast": "已保存家长模式设置"}))


def _norm_days_param(days: Any) -> int:
    try:
        v = int(days)
    except Exception:
        v = 7
    return max(1, min(v, 90))


def _analytics_admin_set() -> set[str]:
    raw = os.getenv("APP_ANALYTICS_ADMIN_USERS", "") or os.getenv("APP_ANALYTICS_ADMIN_USER", "")
    return {u.strip().lower() for u in raw.replace(";", ",").split(",") if u.strip()}


def _analytics_is_admin(username_norm: str) -> tuple[bool, bool]:
    aset = _analytics_admin_set()
    return (bool(aset) and username_norm in aset, bool(aset))


def _safe_json_dict(s: str | None) -> dict[str, Any]:
    try:
        obj = json.loads(s or "{}")
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _analytics_time_ago(ts: datetime | None, now: datetime) -> str:
    if not ts:
        return "-"
    dt = int(max(0, (now - ts).total_seconds()))
    if dt < 10:
        return "刚刚"
    if dt < 60:
        return f"{dt}秒前"
    m = dt // 60
    if m < 60:
        return f"{m}分钟前"
    h = m // 60
    if h < 24:
        return f"{h}小时前"
    d = h // 24
    return f"{d}天前"


def _analytics_online_dot(last_seen: datetime | None, now: datetime) -> str:
    if not last_seen:
        return "⚫"
    delta = now - last_seen
    if delta < timedelta(minutes=5):
        return "🟢"
    if delta < timedelta(minutes=30):
        return "🟡"
    return "⚫"


def _pct_value(values: list[int], p: float) -> int:
    if not values:
        return 0
    xs = sorted(int(v) for v in values if v is not None)
    if not xs:
        return 0
    if p <= 0:
        return xs[0]
    if p >= 1:
        return xs[-1]
    k = (len(xs) - 1) * p
    f = int(k)
    c = min(len(xs) - 1, f + 1)
    if f == c:
        return xs[f]
    frac = k - f
    return int(round(xs[f] * (1 - frac) + xs[c] * frac))


def _build_analytics_dashboard(*, days: int, username_norm: str, is_admin: bool) -> dict[str, Any]:
    now = _utcnow()
    cutoff = now - timedelta(days=days)

    # Auth DB: web/app/client events
    with get_auth_session() as session:
        users = session.query(AuthUser).order_by(AuthUser.id.asc()).all()
        user_map = {u.username_norm: u.username for u in users}

        q = session.query(AuthEvent).filter(AuthEvent.created_at >= cutoff)
        if (not is_admin) and username_norm:
            q = q.filter(AuthEvent.username_norm == username_norm)
        events = q.order_by(AuthEvent.created_at.desc()).all()

        q_last = session.query(AuthEvent.username_norm, func.max(AuthEvent.created_at)).group_by(AuthEvent.username_norm)
        if (not is_admin) and username_norm:
            q_last = q_last.filter(AuthEvent.username_norm == username_norm)
        last_seen_rows = q_last.all()

        # Retention (admin only): cohorts for the last 14 days.
        retention_table: list[dict[str, Any]] = []
        retention_curve: list[dict[str, Any]] = []
        if is_admin:
            cohort_start = (now - timedelta(days=14)).date()
            cohort_users = (
                session.query(AuthUser.username_norm, AuthUser.created_at)
                .filter(AuthUser.created_at >= datetime(cohort_start.year, cohort_start.month, cohort_start.day))
                .all()
            )
            cohorts: dict[str, list[str]] = {}
            for un, created_at in cohort_users:
                if not un or not created_at:
                    continue
                d0 = created_at.date().isoformat()
                cohorts.setdefault(d0, []).append(str(un))

            cohort_keys = sorted(cohorts.keys())[-10:]
            all_users_norm = sorted({u for d0 in cohort_keys for u in cohorts.get(d0, [])})
            event_day_counts: dict[tuple[str, str], int] = {}
            if all_users_norm:
                ev_rows = (
                    session.query(
                        AuthEvent.username_norm,
                        func.strftime("%Y-%m-%d", AuthEvent.created_at),
                        func.count(AuthEvent.id),
                    )
                    .filter(AuthEvent.username_norm.in_(all_users_norm))
                    .filter(AuthEvent.kind.in_(["page_view", "action"]))
                    .filter(AuthEvent.created_at >= datetime(cohort_start.year, cohort_start.month, cohort_start.day))
                    .group_by(AuthEvent.username_norm, func.strftime("%Y-%m-%d", AuthEvent.created_at))
                    .all()
                )
                for un, day_s, cnt in ev_rows:
                    if un and day_s:
                        event_day_counts[(str(un), str(day_s))] = int(cnt or 0)

            def _ret_stats(d0: str, un_list: list[str], n: int) -> dict[str, Any] | None:
                try:
                    y, m, d = [int(x) for x in d0.split("-")]
                    target = datetime(y, m, d).date() + timedelta(days=n)
                except Exception:
                    return None
                if now.date() < target:
                    return None
                target_s = target.isoformat()
                returned_users = [un for un in un_list if (un, target_s) in event_day_counts]
                returned = len(returned_users)
                total = len(un_list)
                pct = int(round(100 * (returned / max(1, total))))
                events_total = sum(int(event_day_counts.get((un, target_s), 0)) for un in returned_users)
                avg_events = (events_total / returned) if returned else 0.0
                return {
                    "pct": pct,
                    "returned": returned,
                    "total": total,
                    "events": events_total,
                    "avg_events": avg_events,
                }

            for d0 in reversed(cohort_keys):
                un_list = cohorts.get(d0, [])
                if not un_list:
                    continue
                d1 = _ret_stats(d0, un_list, 1)
                d3 = _ret_stats(d0, un_list, 3)
                d7 = _ret_stats(d0, un_list, 7)
                d14 = _ret_stats(d0, un_list, 14)
                d30 = _ret_stats(d0, un_list, 30)
                retention_table.append(
                    {
                        "date": d0[5:],
                        "size": len(un_list),
                        "d1": (d1["pct"] if d1 else None),
                        "d1_avg": (round(float(d1["avg_events"]), 1) if d1 else None),
                        "d3": (d3["pct"] if d3 else None),
                        "d3_avg": (round(float(d3["avg_events"]), 1) if d3 else None),
                        "d7": (d7["pct"] if d7 else None),
                        "d7_avg": (round(float(d7["avg_events"]), 1) if d7 else None),
                        "d14": (d14["pct"] if d14 else None),
                        "d14_avg": (round(float(d14["avg_events"]), 1) if d14 else None),
                        "d30": (d30["pct"] if d30 else None),
                        "d30_avg": (round(float(d30["avg_events"]), 1) if d30 else None),
                    }
                )

            curve_days = [1, 3, 7, 14, 30]
            for n in curve_days:
                total_u = 0
                total_ret = 0
                total_events = 0
                for d0 in cohort_keys:
                    un_list = cohorts.get(d0, [])
                    if not un_list:
                        continue
                    st = _ret_stats(d0, un_list, n)
                    if st is None:
                        continue
                    total_u += int(st["total"])
                    total_ret += int(st["returned"])
                    total_events += int(st["events"])
                retention_curve.append(
                    {
                        "day": f"D{n}",
                        "pct": (total_ret / total_u) if total_u else 0.0,
                        "avg_events": (total_events / total_ret) if total_ret else 0.0,
                    }
                )

    last_seen_map: dict[str, datetime] = {str(un): ts for un, ts in last_seen_rows if un and ts}

    # Main DB: study/review data (single shared DB in this MVP)
    with get_session() as session:
        rating_rows = (
            session.query(SrsReviewLog.rating, func.count(SrsReviewLog.id))
            .filter(SrsReviewLog.reviewed_at >= cutoff)
            .group_by(SrsReviewLog.rating)
            .all()
        )
        rating_counts: dict[int, int] = {int(r): int(c) for r, c in rating_rows}

        time_buckets = {"lt2": 0, "2to5": 0, "5to10": 0, "gt10": 0}
        for (ms,) in session.query(SrsReviewLog.duration_ms).filter(SrsReviewLog.reviewed_at >= cutoff).all():
            if ms is None:
                continue
            s = float(ms) / 1000.0
            if s < 2:
                time_buckets["lt2"] += 1
            elif s < 5:
                time_buckets["2to5"] += 1
            elif s < 10:
                time_buckets["5to10"] += 1
            else:
                time_buckets["gt10"] += 1

        diff_rows = (
            session.query(
                Word.term,
                func.count(SrsReviewLog.id).label("total"),
                func.sum(case((SrsReviewLog.rating == Rating.Again.value, 1), else_=0)).label("again"),
            )
            .join(Word, Word.id == SrsReviewLog.word_id)
            .filter(SrsReviewLog.reviewed_at >= cutoff)
            .group_by(Word.id)
            .order_by(
                func.sum(case((SrsReviewLog.rating == Rating.Again.value, 1), else_=0)).desc(),
                func.count(SrsReviewLog.id).desc(),
            )
            .limit(10)
            .all()
        )
        difficult: list[dict[str, Any]] = []
        for term, total, again in diff_rows:
            total_i = int(total or 0)
            again_i = int(again or 0)
            score = (again_i / total_i) if total_i else 0.0
            stars = 1
            if score >= 0.8:
                stars = 5
            elif score >= 0.6:
                stars = 4
            elif score >= 0.4:
                stars = 3
            elif score >= 0.2:
                stars = 2
            difficult.append({"term": str(term), "dots": ("●" * stars) + ("○" * (5 - stars)), "again_pct": f"{score * 100:.0f}%"})

        # Word terms for recent review_rate activities
        review_word_ids: set[int] = set()
        for ev in events[:40]:
            if ev.kind != "action":
                continue
            meta = _safe_json_dict(ev.meta_json)
            if (meta.get("action") or "") == "review_rate":
                try:
                    wid = int(meta.get("word_id") or 0)
                except Exception:
                    wid = 0
                if wid > 0:
                    review_word_ids.add(wid)
        word_term_map: dict[int, str] = {}
        if review_word_ids:
            for wid, term in session.query(Word.id, Word.term).filter(Word.id.in_(sorted(review_word_ids))).all():
                word_term_map[int(wid)] = str(term)

    def _format_activity(ev: AuthEvent) -> dict[str, Any]:
        u = user_map.get(str(ev.username_norm or "")) or str(ev.username_norm or "")
        when = _analytics_time_ago(ev.created_at, now)
        line = ""
        sub = ""
        if ev.kind == "action":
            meta = _safe_json_dict(ev.meta_json)
            act = str(meta.get("action") or "action")
            if act == "review_rate":
                try:
                    wid = int(meta.get("word_id") or 0)
                except Exception:
                    wid = 0
                term = word_term_map.get(wid, "")
                rating = str(meta.get("rating") or "").strip()
                term_s = f"“{term}”" if term else ""
                line = f"复习单词 {term_s} → {rating}".strip()
            else:
                line = f"动作 → {act}"
        elif ev.kind == "client":
            meta = _safe_json_dict(ev.meta_json)
            evp = meta.get("ev") if isinstance(meta.get("ev"), dict) else {}
            t = str(evp.get("t") or "client")
            if t == "click":
                el = evp.get("el") if isinstance(evp.get("el"), dict) else {}
                txt = str((el.get("text") or "")).strip()[:50]
                line = f"点击 “{txt}”" if txt else "点击"
            elif t in {"error", "rejection"}:
                msg = str(evp.get("msg") or "").strip()[:80]
                line = f"前端错误 → {msg}".strip()
            elif t == "page":
                line = "打开页面"
                v = evp.get("v") if isinstance(evp.get("v"), dict) else {}
                w = v.get("w")
                h = v.get("h")
                lang = v.get("lang")
                sub = f"{w}×{h} · {lang}".strip(" ·")
            else:
                line = f"客户端 → {t}"
        elif ev.kind == "page_view":
            line = f"访问 {ev.path}"
        elif ev.kind == "api":
            line = f"请求 {ev.path}"
            sub = f"{ev.method} · {ev.status_code} · {ev.duration_ms}ms".strip()
        elif ev.kind == "error":
            line = "服务端错误"
            sub = f"{ev.method} {ev.path} · {ev.status_code} · {ev.duration_ms}ms"
        else:
            line = f"{ev.kind} {ev.path}"
        return {"username": u, "when": when, "line": line, "sub": sub, "ts": (ev.created_at.isoformat() if ev.created_at else "")}

    total_events = len(events)
    active_users = len({str(e.username_norm or "") for e in events if e.username_norm})
    err_count = sum(1 for e in events if e.kind == "error")

    api_durations = [int(e.duration_ms or 0) for e in events if e.kind == "api" and e.duration_ms is not None]
    avg_api_ms = int(round(sum(api_durations) / len(api_durations))) if api_durations else 0

    review_count = 0
    for e in events:
        if e.kind != "action":
            continue
        meta = _safe_json_dict(e.meta_json)
        if (meta.get("action") or "") == "review_rate":
            review_count += 1

    error_rate = (err_count / total_events) if total_events else 0.0

    curr_start = now - timedelta(hours=24)
    prev_start = now - timedelta(hours=48)
    curr = [e for e in events if e.created_at and e.created_at >= curr_start]
    prev = [e for e in events if e.created_at and prev_start <= e.created_at < curr_start]

    def _metrics(window: list[AuthEvent]) -> dict[str, Any]:
        t = len(window)
        au = len({str(e.username_norm or "") for e in window if e.username_norm})
        er = sum(1 for e in window if e.kind == "error")
        rr = 0
        ad = [int(e.duration_ms or 0) for e in window if e.kind == "api" and e.duration_ms is not None]
        for e in window:
            if e.kind == "action":
                meta = _safe_json_dict(e.meta_json)
                if (meta.get("action") or "") == "review_rate":
                    rr += 1
        return {"total": t, "active_users": au, "review": rr, "error_rate": (er / t) if t else 0.0, "avg_api_ms": (sum(ad) / len(ad)) if ad else 0.0}

    m_cur = _metrics(curr)
    m_prev = _metrics(prev)

    def _delta_str(value: float, unit: str = "", *, is_rate: bool = False) -> tuple[str, str]:
        if is_rate:
            s = f"{value * 100:.1f}%"
        else:
            if unit == "ms":
                s = f"{int(round(value))}ms"
            else:
                try:
                    s = f"{int(round(value)):,}"
                except Exception:
                    s = str(value)
        if value > 0:
            return ("up", f"↑{s} 今日")
        if value < 0:
            return ("down", f"↓{s.lstrip('-')} 今日")
        return ("flat", f"—{s} 今日")

    delta_active = _delta_str(m_cur["active_users"] - m_prev["active_users"])
    delta_total = _delta_str(m_cur["total"] - m_prev["total"])
    delta_review = _delta_str(m_cur["review"] - m_prev["review"])
    delta_err_rate = _delta_str(m_cur["error_rate"] - m_prev["error_rate"], is_rate=True)
    delta_avg_ms = _delta_str(m_cur["avg_api_ms"] - m_prev["avg_api_ms"], unit="ms")

    daily_counts: dict[str, int] = {}
    for e in events:
        if not e.created_at:
            continue
        k = e.created_at.date().isoformat()
        daily_counts[k] = daily_counts.get(k, 0) + 1

    labels: list[str] = []
    values: list[int] = []
    for i in range(days - 1, -1, -1):
        d = (now - timedelta(days=i)).date().isoformat()
        labels.append(d[5:])
        values.append(int(daily_counts.get(d, 0)))

    hourly = [0] * 24
    for e in events:
        if not e.created_at or e.created_at < curr_start:
            continue
        hourly[int(e.created_at.hour)] += 1

    top_paths: dict[str, int] = {}
    for e in events:
        if e.kind != "page_view":
            continue
        p = str(e.path or "/")
        top_paths[p] = top_paths.get(p, 0) + 1
    top_pages = [{"path": p, "count": c} for p, c in sorted(top_paths.items(), key=lambda kv: kv[1], reverse=True)[:10]]

    per_user_counts: dict[str, int] = {}
    for e in events:
        un = str(e.username_norm or "")
        if not un:
            continue
        per_user_counts[un] = per_user_counts.get(un, 0) + 1
    ranked = sorted(per_user_counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)[:5]
    max_cnt = max([c for _u, c in ranked] or [1])
    ranking = []
    for i, (un, c) in enumerate(ranked, start=1):
        disp = user_map.get(un) or un
        ls = last_seen_map.get(un)
        ranking.append(
            {
                "rank": i,
                "username": disp,
                "count": int(c),
                "bar": int(round(100 * (c / max_cnt))) if max_cnt else 0,
                "status": _analytics_online_dot(ls, now),
                "last_seen": _analytics_time_ago(ls, now) if ls else "-",
            }
        )

    online_items = []
    for un, ts in sorted(last_seen_map.items(), key=lambda kv: kv[1], reverse=True)[:6]:
        online_items.append({"username": user_map.get(un) or un, "status": _analytics_online_dot(ts, now), "last_seen": _analytics_time_ago(ts, now)})

    recent_errors: list[dict[str, Any]] = []
    for e in events[:200]:
        if e.kind == "error":
            recent_errors.append({"msg": "服务端错误", "where": f"{e.path}", "when": _analytics_time_ago(e.created_at, now)})
        elif e.kind == "client":
            meta = _safe_json_dict(e.meta_json)
            evp = meta.get("ev") if isinstance(meta.get("ev"), dict) else {}
            if str(evp.get("t") or "") in {"error", "rejection"}:
                msg = str(evp.get("msg") or "前端错误").strip()[:120]
                src = str(evp.get("src") or "").strip()[:120]
                recent_errors.append({"msg": msg, "where": src, "when": _analytics_time_ago(e.created_at, now)})
        if len(recent_errors) >= 12:
            break

    api_events = [e for e in events if e.kind == "api" and e.created_at]
    api_events_12h = [e for e in api_events if e.created_at >= (now - timedelta(hours=12))]
    buckets: dict[str, list[int]] = {}
    for e in api_events_12h:
        t = e.created_at
        key = t.replace(minute=0, second=0, microsecond=0).isoformat()
        buckets.setdefault(key, []).append(int(e.duration_ms or 0))
    series_labels = []
    series_values = []
    for k in sorted(buckets.keys()):
        xs = buckets[k]
        series_labels.append(k[11:16])
        series_values.append(int(round(sum(xs) / len(xs))) if xs else 0)

    p50 = _pct_value(api_durations, 0.50)
    p95 = _pct_value(api_durations, 0.95)
    p99 = _pct_value(api_durations, 0.99)

    slow_by_path: dict[str, list[int]] = {}
    for e in api_events:
        p = str(e.path or "")
        if not p.startswith("/api"):
            continue
        slow_by_path.setdefault(p, []).append(int(e.duration_ms or 0))
    slow_items = []
    for p, xs in sorted(slow_by_path.items(), key=lambda kv: (sum(kv[1]) / max(1, len(kv[1])), len(kv[1])), reverse=True)[:8]:
        slow_items.append({"path": p, "avg_ms": int(round(sum(xs) / len(xs))) if xs else 0, "p95_ms": _pct_value(xs, 0.95), "count": len(xs)})

    funnel: dict[str, Any] = {"enabled": False, "steps": [], "users": [], "events": [], "mode_default": "users"}
    if is_admin:
        funnel["enabled"] = True
        step_defs = [
            ("home", "首页"),
            ("decks", "词书"),
            ("practice", "练习"),
            ("completed", "完成复习"),
        ]
        funnel["steps"] = [{"key": k, "name": name} for k, name in step_defs]

        user_sets: dict[str, set[str]] = {k: set() for k, _name in step_defs}
        event_counts: dict[str, int] = {k: 0 for k, _name in step_defs}

        def _is_home(ev: AuthEvent) -> bool:
            return ev.kind == "page_view" and (ev.path or "") == "/"

        def _is_decks(ev: AuthEvent) -> bool:
            p = str(ev.path or "")
            return ev.kind == "page_view" and (p == "/decks" or p.startswith("/decks/"))

        def _is_practice(ev: AuthEvent) -> bool:
            p = str(ev.path or "")
            return ev.kind == "page_view" and (p == "/practice" or p.startswith("/practice/"))

        def _is_completed(ev: AuthEvent) -> bool:
            if ev.kind != "action":
                return False
            meta = _safe_json_dict(ev.meta_json)
            return (meta.get("action") or "") in {"review_rate", "retest_rate"}

        matchers = {
            "home": _is_home,
            "decks": _is_decks,
            "practice": _is_practice,
            "completed": _is_completed,
        }

        for e in events:
            un = str(e.username_norm or "")
            for k, _name in step_defs:
                try:
                    ok = bool(matchers[k](e))
                except Exception:
                    ok = False
                if not ok:
                    continue
                if un:
                    user_sets[k].add(un)
                event_counts[k] += 1

        user_counts = {k: len(user_sets[k]) for k, _name in step_defs}
        base_users = max(1, user_counts.get(step_defs[0][0], 0))
        base_events = max(1, event_counts.get(step_defs[0][0], 0))

        def _build_series(counts: dict[str, int], base: int) -> list[dict[str, Any]]:
            out = []
            prev = None
            for idx, (k, name) in enumerate(step_defs):
                c = int(counts.get(k, 0))
                width = (c / base) if base else 0.0
                conv = (c / prev) if (prev and prev > 0) else (1.0 if idx == 0 else 0.0)
                drop = max(0.0, 1.0 - conv) if idx > 0 else 0.0
                out.append(
                    {
                        "key": k,
                        "name": name,
                        "count": c,
                        "width": width,
                        "conv": conv,
                        "drop": drop,
                    }
                )
                prev = c
            return out

        funnel["users"] = _build_series(user_counts, base_users)
        funnel["events"] = _build_series(event_counts, base_events)

    screens: dict[str, int] = {}
    tzs: dict[str, int] = {}
    langs: dict[str, int] = {}
    dprs: dict[str, int] = {}
    for e in events:
        if e.kind != "client":
            continue
        meta = _safe_json_dict(e.meta_json)
        evp = meta.get("ev") if isinstance(meta.get("ev"), dict) else {}
        if str(evp.get("t") or "") != "page":
            continue
        v = evp.get("v") if isinstance(evp.get("v"), dict) else {}
        try:
            w = int(v.get("w") or 0)
        except Exception:
            w = 0
        if w:
            screens[f"{w}px"] = screens.get(f"{w}px", 0) + 1
        tz = str(v.get("tz") or "").strip()
        if tz:
            tzs[tz] = tzs.get(tz, 0) + 1
        lang = str(v.get("lang") or "").strip()
        if lang:
            langs[lang] = langs.get(lang, 0) + 1
        dpr = v.get("dpr")
        try:
            dpr_i = int(round(float(dpr)))
        except Exception:
            dpr_i = 0
        if dpr_i:
            dprs[f"{dpr_i}x"] = dprs.get(f"{dpr_i}x", 0) + 1

    def _top_k(d: dict[str, int], k: int) -> list[dict[str, Any]]:
        total = sum(d.values()) or 0
        out = []
        for name, c in sorted(d.items(), key=lambda kv: kv[1], reverse=True)[:k]:
            out.append({"name": name, "count": c, "pct": (c / total) if total else 0.0})
        return out

    rating_map = {
        Rating.Again.value: ("again", "Again"),
        Rating.Hard.value: ("hard", "Hard"),
        Rating.Good.value: ("good", "Good"),
        Rating.Easy.value: ("easy", "Easy"),
    }
    rating_items = []
    total_r = sum(rating_counts.values()) or 0
    for rv in [Rating.Again.value, Rating.Hard.value, Rating.Good.value, Rating.Easy.value]:
        key, label = rating_map[rv]
        cnt = int(rating_counts.get(rv, 0))
        rating_items.append({"key": key, "label": label, "count": cnt, "pct": (cnt / total_r) if total_r else 0.0})

    time_total = sum(time_buckets.values()) or 0
    time_items = [
        {"label": "<2s", "count": time_buckets["lt2"], "pct": (time_buckets["lt2"] / time_total) if time_total else 0.0},
        {"label": "2-5s", "count": time_buckets["2to5"], "pct": (time_buckets["2to5"] / time_total) if time_total else 0.0},
        {"label": "5-10s", "count": time_buckets["5to10"], "pct": (time_buckets["5to10"] / time_total) if time_total else 0.0},
        {"label": ">10s", "count": time_buckets["gt10"], "pct": (time_buckets["gt10"] / time_total) if time_total else 0.0},
    ]

    dashboard: dict[str, Any] = {
        "meta": {"now": now.isoformat(), "days": days, "cutoff": cutoff.isoformat(), "is_admin": bool(is_admin)},
        "overview": {
            "active_users": {"label": "活跃用户", "icon": "👥", "value": active_users, "delta": delta_active[1], "trend": delta_active[0]},
            "total_events": {"label": "总事件", "icon": "📱", "value": total_events, "delta": delta_total[1], "trend": delta_total[0]},
            "review_count": {"label": "复习次数", "icon": "📖", "value": review_count, "delta": delta_review[1], "trend": delta_review[0]},
            "error_rate": {"label": "错误率", "icon": "❌", "value": error_rate, "delta": delta_err_rate[1], "trend": delta_err_rate[0]},
            "avg_response": {"label": "平均响应", "icon": "⏱", "value": avg_api_ms, "delta": delta_avg_ms[1], "trend": delta_avg_ms[0]},
        },
        "trend": {"labels": labels, "values": values},
        "hours": {"labels": [str(i) for i in range(24)], "values": hourly},
        "activity": [_format_activity(e) for e in events[:12]],
        "ranking": ranking,
        "online": online_items,
        "learning": {"ratings": rating_items, "difficulty": difficult, "time": time_items},
        "funnel": funnel,
        "retention": {"table": retention_table, "curve": retention_curve} if is_admin else {"table": [], "curve": []},
        "pages": top_pages,
        "performance": {"series": {"labels": series_labels, "values": series_values}, "p50_ms": p50, "p95_ms": p95, "p99_ms": p99, "slow": slow_items},
        "errors": recent_errors,
        "env": {"screens": _top_k(screens, 3), "tz": _top_k(tzs, 1), "lang": _top_k(langs, 2), "dpr": _top_k(dprs, 3)},
    }
    return dashboard


@app.get("/analytics", response_class=HTMLResponse)
def analytics_page(request: Request, days: int = 7):
    try:
        days = int(days)
    except Exception:
        days = 7
    days = max(1, min(days, 90))

    username = getattr(request.state, "user_username", None)
    username_norm = (username or "").strip().lower()

    admin_raw = os.getenv("APP_ANALYTICS_ADMIN_USERS", "") or os.getenv("APP_ANALYTICS_ADMIN_USER", "")
    admin_set = {u.strip().lower() for u in admin_raw.replace(";", ",").split(",") if u.strip()}
    is_admin = bool(admin_set) and (username_norm in admin_set)

    dashboard = _build_analytics_dashboard(days=days, username_norm=username_norm, is_admin=is_admin)
    cutoff = datetime.fromisoformat(str(dashboard.get("meta", {}).get("cutoff") or _utcnow().isoformat()))
    dashboard_json = json.dumps(dashboard, ensure_ascii=False).replace("<", "\\u003c")
    return templates.TemplateResponse(
        request,
        "analytics.html",
        {
            "title": "数据中心",
            "days": days,
            "cutoff": cutoff,
            "is_admin": is_admin,
            "admin_hint_set": bool(admin_set),
            "current_user": username,
            "dashboard": dashboard,
            "dashboard_json": Markup(dashboard_json),
        },
    )


@app.get("/api/analytics/dashboard", response_class=JSONResponse)
def api_analytics_dashboard(request: Request, days: int = 7):
    username = getattr(request.state, "user_username", None)
    user_id = getattr(request.state, "user_id", None)
    if not username or user_id is None:
        raise HTTPException(status_code=401, detail="not logged in")

    days = _norm_days_param(days)
    username_norm = (username or "").strip().lower()
    is_admin, _admin_hint_set = _analytics_is_admin(username_norm)
    return _build_analytics_dashboard(days=days, username_norm=username_norm, is_admin=is_admin)


def _build_learning_dashboard(
    session,
    *,
    now: datetime,
    timezone_name: str,
    days: int = 14,
    mastered_stability_days: int = 30,
) -> dict[str, Any]:
    tzinfo = _get_app_tzinfo(timezone_name=timezone_name)
    days = max(7, min(int(days or 14), 60))
    mastered_thr = max(1, int(mastered_stability_days or 30))

    total_cards = int(session.query(func.count(SrsCard.word_id)).scalar() or 0)
    new_cards = int(session.query(func.count(SrsCard.word_id)).filter(SrsCard.last_reviewed_at.is_(None)).scalar() or 0)
    mastered_cards = int(
        session.query(func.count(SrsCard.word_id))
        .filter(
            SrsCard.state == 2,  # Review
            SrsCard.stability.is_not(None),
            SrsCard.stability >= float(mastered_thr),
        )
        .scalar()
        or 0
    )
    learning_cards = int(
        session.query(func.count(SrsCard.word_id))
        .filter(
            SrsCard.last_reviewed_at.is_not(None),
            ~(
                (SrsCard.state == 2)
                & (SrsCard.stability.is_not(None))
                & (SrsCard.stability >= float(mastered_thr))
            ),
        )
        .scalar()
        or 0
    )
    due_cards = int(session.query(func.count(SrsCard.word_id)).filter(SrsCard.due_at <= now).scalar() or 0)

    last_review_at = session.query(func.max(SrsReviewLog.reviewed_at)).scalar()
    last_review_at_local = ""
    if isinstance(last_review_at, datetime):
        last_review_at_local = last_review_at.replace(tzinfo=timezone.utc).astimezone(tzinfo).strftime("%Y-%m-%d %H:%M")

    cutoff = now - timedelta(days=days - 1)
    log_rows = (
        session.query(SrsReviewLog.reviewed_at, SrsReviewLog.rating)
        .filter(SrsReviewLog.reviewed_at >= cutoff)
        .order_by(SrsReviewLog.reviewed_at.asc())
        .all()
    )
    daily_total: dict[str, int] = {}
    daily_again: dict[str, int] = {}
    for reviewed_at, rating in log_rows:
        if not isinstance(reviewed_at, datetime):
            continue
        local_day = reviewed_at.replace(tzinfo=timezone.utc).astimezone(tzinfo).date().isoformat()
        daily_total[local_day] = int(daily_total.get(local_day, 0) + 1)
        if int(rating or 0) == int(Rating.Again.value):
            daily_again[local_day] = int(daily_again.get(local_day, 0) + 1)

    today_local = now.replace(tzinfo=timezone.utc).astimezone(tzinfo).date()
    series: list[dict[str, Any]] = []
    max_count = 0
    study_days = 0
    for i in range(days - 1, -1, -1):
        d = today_local - timedelta(days=i)
        key = d.isoformat()
        cnt = int(daily_total.get(key, 0))
        ag = int(daily_again.get(key, 0))
        if cnt > 0:
            study_days += 1
        max_count = max(max_count, cnt)
        series.append({"day": key, "label": d.strftime("%m-%d"), "count": cnt, "again": ag})

    # 高频错词（按 wrong_count）
    wrong_rows = (
        session.query(Word, func.max(Mistake.created_at).label("last_wrong_at"))
        .join(Mistake, Mistake.word_id == Word.id)
        .filter(Word.wrong_count > 0)
        .group_by(Word.id)
        .order_by(Word.wrong_count.desc(), func.max(Mistake.created_at).desc(), Word.term.asc())
        .limit(10)
        .all()
    )
    wrong_top: list[dict[str, Any]] = []
    for w, last_wrong_at in wrong_rows:
        ts = ""
        if isinstance(last_wrong_at, datetime):
            ts = last_wrong_at.replace(tzinfo=timezone.utc).astimezone(tzinfo).strftime("%m-%d %H:%M")
        wrong_top.append({"term": str(w.term or ""), "wrong_count": int(w.wrong_count or 0), "last_wrong_at": ts})

    return {
        "meta": {"days": days, "tz": timezone_name, "mastered_thr": mastered_thr, "last_review_at": last_review_at_local},
        "counts": {
            "total": total_cards,
            "new": new_cards,
            "learning": learning_cards,
            "mastered": mastered_cards,
            "due": due_cards,
        },
        "series": {"items": series, "max": max_count, "study_days": int(study_days)},
        "wrong_top": wrong_top,
    }


@app.get("/dashboard", response_class=HTMLResponse)
def learning_dashboard_page(request: Request):
    now = _utcnow()
    settings = get_settings()
    is_parent_mode = getattr(request.state, "ui_mode", _UI_MODE_SELF) == _UI_MODE_PARENT
    with get_session() as session:
        dash = _build_learning_dashboard(session, now=now, timezone_name=settings.app_timezone, days=14, mastered_stability_days=30)
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "title": "学习看板" if not is_parent_mode else "学习进度",
            "dash": dash,
            "is_parent_mode": bool(is_parent_mode),
        },
    )


@app.get("/decks", response_class=HTMLResponse)
def list_decks(request: Request, toast: str | None = None):
    now = _utcnow()
    with get_session() as session:
        plan = _ensure_default_plan(session)
        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        word_counts = dict(
            session.query(DeckWord.deck_id, func.count(DeckWord.word_id)).group_by(DeckWord.deck_id).all()
        )
        planned_counts = dict(
            session.query(DeckWord.deck_id, func.count(SrsCard.word_id))
            .join(SrsCard, SrsCard.word_id == DeckWord.word_id)
            .group_by(DeckWord.deck_id)
            .all()
        )
        due_counts = dict(
            session.query(DeckWord.deck_id, func.count(SrsCard.word_id))
            .join(SrsCard, SrsCard.word_id == DeckWord.word_id)
            .filter(SrsCard.due_at <= now)
            .group_by(DeckWord.deck_id)
            .all()
        )
        new_counts = dict(
            session.query(DeckWord.deck_id, func.count(SrsCard.word_id))
            .join(SrsCard, SrsCard.word_id == DeckWord.word_id)
            .filter(SrsCard.last_reviewed_at.is_(None))
            .group_by(DeckWord.deck_id)
            .all()
        )

    items = []
    for d in decks:
        total_words = int(word_counts.get(d.id, 0))
        planned_words = int(planned_counts.get(d.id, 0))
        items.append(
            {
                "deck": d,
                "word_count": total_words,
                "planned_count": planned_words,
                "remaining_count": max(0, total_words - planned_words),
                "due_count": int(due_counts.get(d.id, 0)),
                "new_count": int(new_counts.get(d.id, 0)),
            }
        )
    return templates.TemplateResponse(
        request,
        "decks.html",
        {"items": items, "toast": (toast or "").strip(), "daily_new_limit": int(plan.daily_new_limit or 20)},
    )


@app.post("/decks")
def create_deck(name: str = Form(...), description: str = Form("")):
    raise HTTPException(status_code=404, detail="disabled")


@app.post("/decks/{deck_id}/delete")
def delete_deck(deck_id: int):
    with get_session() as session:
        deck = session.get(Deck, deck_id)
        if not deck:
            raise HTTPException(status_code=404, detail="not found")
        session.delete(deck)
    return _redirect("/decks")


@app.get("/decks/{deck_id}", response_class=HTMLResponse)
def deck_detail(request: Request, deck_id: int, toast: str | None = None):
    now = _utcnow()
    with get_session() as session:
        plan = _ensure_default_plan(session)
        deck = session.get(Deck, deck_id)
        if not deck:
            raise HTTPException(status_code=404, detail="not found")

        total_words = int(session.query(func.count(DeckWord.word_id)).filter(DeckWord.deck_id == deck_id).scalar() or 0)
        planned_count = int(
            session.query(func.count(SrsCard.word_id))
            .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
            .filter(DeckWord.deck_id == deck_id)
            .scalar()
            or 0
        )
        learned_count = int(
            session.query(func.count(SrsCard.word_id))
            .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
            .filter(DeckWord.deck_id == deck_id, SrsCard.last_reviewed_at.is_not(None))
            .scalar()
            or 0
        )
        due_count = int(
            session.query(func.count(SrsCard.word_id))
            .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
            .filter(DeckWord.deck_id == deck_id, SrsCard.due_at <= now)
            .scalar()
            or 0
        )
        new_count = int(
            session.query(func.count(SrsCard.word_id))
            .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
            .filter(DeckWord.deck_id == deck_id, SrsCard.last_reviewed_at.is_(None))
            .scalar()
            or 0
        )

        rows = (
            session.query(DeckWord, Word, SrsCard)
            .join(Word, Word.id == DeckWord.word_id)
            .outerjoin(SrsCard, SrsCard.word_id == Word.id)
            .filter(DeckWord.deck_id == deck_id)
            .order_by(DeckWord.position.asc(), Word.term.asc())
            .limit(300)
            .all()
        )

    items = [{"link": dw, "word": w, "card": c} for (dw, w, c) in rows]
    return templates.TemplateResponse(
        request,
        "deck_detail.html",
        {
            "deck": deck,
            "items": items,
            "toast": (toast or "").strip(),
            "total_words": total_words,
            "planned_count": planned_count,
            "remaining_count": max(0, total_words - planned_count),
            "learned_count": learned_count,
            "due_count": due_count,
            "new_count": new_count,
            "daily_new_limit": int(plan.daily_new_limit or 20),
            "state_map": {1: "Learning", 2: "Review", 3: "Relearning"},
        },
    )


@app.get("/library", response_class=HTMLResponse)
def wordbook_library(request: Request):
    sources = list_sources()
    groups = [
        ("家长/中小学生（推荐）", [s for s in sources if str(getattr(s, "kind", "")).strip() == "generated_subset"]),
        ("考试词汇（ECDICT）", [s for s in sources if str(getattr(s, "kind", "")).strip() == "ecdict_tag"]),
        ("高频词表（原始）", [s for s in sources if str(getattr(s, "kind", "")).strip() == "plain_words"]),
    ]
    groups = [(name, items) for (name, items) in groups if items]
    return templates.TemplateResponse(
        request,
        "library.html",
        {
            "sources": sources,
            "groups": groups,
            "sources_note_path": "docs/WORDBOOK_SOURCES.md",
        },
    )


def _add_next_words_to_plan(session, *, deck_id: int, count: int) -> tuple[str, int, int]:
    deck = session.get(Deck, deck_id)
    if not deck:
        raise HTTPException(status_code=404, detail="deck not found")

    plan = _ensure_default_plan(session)
    _ensure_plan_deck(session, plan, deck_id)

    planned_ids = session.query(PlanWord.word_id).filter(PlanWord.plan_id == plan.id)
    rows = (
        session.query(DeckWord.word_id)
        .join(Word, Word.id == DeckWord.word_id)
        .filter(DeckWord.deck_id == deck_id, ~DeckWord.word_id.in_(planned_ids))
        # Randomize selection so added words don't always follow deck order / alphabetical order.
        .order_by(func.random())
        .limit(count)
        .all()
    )
    word_ids = [int(wid) for (wid,) in rows]

    now = _utcnow()
    for wid in word_ids:
        _ensure_plan_word(session, plan, wid, deck_id)
        if session.get(SrsCard, wid) is None:
            session.add(SrsCard(word_id=wid, due_at=now))

    # Important: this app runs with autoflush=False. Flush so subsequent queries can see new cards.
    session.flush()

    total_words = int(session.query(func.count(DeckWord.word_id)).filter(DeckWord.deck_id == deck_id).scalar() or 0)
    planned_count = int(
        session.query(func.count(SrsCard.word_id))
        .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
        .filter(DeckWord.deck_id == deck_id)
        .scalar()
        or 0
    )
    remaining = max(0, total_words - planned_count)
    return deck.name, len(word_ids), remaining


@app.post("/plan/add")
def add_to_plan(
    deck_id: int = Form(...),
    count: int = Form(20),
    return_to: str = Form("today"),
):
    try:
        count = int(count)
    except Exception:
        raise HTTPException(status_code=400, detail="count must be an integer")
    if count < 1 or count > 500:
        raise HTTPException(status_code=400, detail="count must be between 1 and 500")

    with get_session() as session:
        deck_name, added, remaining = _add_next_words_to_plan(session, deck_id=int(deck_id), count=count)

    if added > 0:
        toast = f"已加入学习计划：{deck_name} {added} 个（剩余 {remaining}）"
    else:
        toast = f"{deck_name} 没有可加入的新词（可能已全部加入计划）"

    return_to = (return_to or "today").strip().lower()
    if return_to == "deck":
        return _redirect("/decks/" + str(deck_id) + "?" + urlencode({"toast": toast}))
    if return_to == "decks":
        return _redirect("/decks?" + urlencode({"toast": toast}))
    if return_to == "review":
        return _redirect("/review?" + urlencode({"deck_id": str(deck_id), "toast": toast}))
    return _redirect("/?" + urlencode({"deck_id": str(deck_id), "toast": toast}))


@app.post("/decks/{deck_id}/plan_add")
def add_deck_to_plan(
    deck_id: int,
    count: int = Form(20),
    return_to: str = Form("today"),
):
    raise HTTPException(status_code=404, detail="disabled")


def _dedupe_import_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    # Keep first occurrence (case-insensitive by term)
    deduped: dict[str, dict[str, str]] = {}
    for r in rows:
        term = (r.get("term") or "").strip()
        if not term:
            continue
        key = term.lower()
        if key not in deduped:
            deduped[key] = r
    return list(deduped.values())


def _apply_rows_to_db(
    rows: list[dict[str, str]],
    *,
    on_conflict: str,
    errors: list[str],
    add_to_plan: bool = False,
) -> tuple[int, int, int, int, list[str]]:
    inserted = 0
    updated = 0
    linked = 0
    skipped = 0

    on_conflict = (on_conflict or "skip").strip().lower()
    if on_conflict not in {"skip", "update"}:
        raise HTTPException(status_code=400, detail="on_conflict must be skip|update")

    with get_session() as session:
        plan: Plan | None = _ensure_default_plan(session) if add_to_plan else None
        terms = [(r.get("term") or "").strip() for r in rows if (r.get("term") or "").strip()]
        terms_lower = [t.lower() for t in terms]
        existing_terms = [t for (t,) in session.query(Word.term).filter(func.lower(Word.term).in_(terms_lower)).all()]
        existing_lower = {t.lower(): t for t in existing_terms}

        deck_cache: dict[str, Deck] = {}

        for idx, r in enumerate(rows, start=1):
            term = (r.get("term") or "").strip()
            if not term:
                errors.append(f"Row {idx}: empty term")
                continue

            existing_term = existing_lower.get(term.lower())
            word: Word | None = None
            if existing_term is not None:
                word = session.query(Word).filter(Word.term == existing_term).first()
                if word is None:
                    word = session.query(Word).filter(func.lower(Word.term) == term.lower()).first()

            if word is not None and on_conflict == "skip":
                skipped += 1
            else:
                try:
                    if word is None:
                        word = Word(
                            term=term,
                            definition=(r.get("definition") or "").strip(),
                            example=(r.get("example") or "").strip(),
                            tags=(r.get("tags") or "").strip(),
                        )
                        session.add(word)
                        session.flush()
                        inserted += 1
                    else:
                        new_def = (r.get("definition") or "").strip()
                        new_ex = (r.get("example") or "").strip()
                        new_tags = (r.get("tags") or "").strip()
                        if new_def:
                            word.definition = new_def
                        if new_ex:
                            word.example = new_ex
                        if new_tags:
                            word.tags = _merge_tags(word.tags, new_tags)
                        updated += 1
                except Exception as e:
                    errors.append(f"Row {idx}: failed to import '{term}': {e}")
                    continue

            deck_n = (r.get("deck") or "").strip()
            source_deck_id: int | None = None
            if deck_n and word is not None:
                try:
                    deck = deck_cache.get(deck_n)
                    if deck is None:
                        deck = _ensure_deck(session, deck_n)
                        deck_cache[deck_n] = deck
                    source_deck_id = int(deck.id)
                    link = (
                        session.query(DeckWord)
                        .filter(DeckWord.deck_id == deck.id, DeckWord.word_id == word.id)
                        .first()
                    )
                    if not link:
                        link = DeckWord(deck_id=deck.id, word_id=word.id)
                        session.add(link)
                    chap = (r.get("chapter") or "").strip()
                    if chap:
                        link.chapter = chap
                    pos = (r.get("position") or "").strip()
                    if pos.isdigit():
                        link.position = int(pos)
                    linked += 1
                except Exception as e:
                    errors.append(f"Row {idx}: failed to link deck '{deck_n}' for '{term}': {e}")

            if add_to_plan and word is not None and plan is not None:
                try:
                    if source_deck_id is not None:
                        _ensure_plan_deck(session, plan, source_deck_id)
                    _ensure_plan_word(session, plan, word.id, source_deck_id)
                    _ensure_srs_card(session, word.id)
                except Exception as e:
                    errors.append(f"Row {idx}: failed to add '{term}' to plan: {e}")

    return inserted, updated, linked, skipped, errors


@app.post("/library/import", response_class=HTMLResponse)
async def import_wordbook(
    request: Request,
    source_id: str = Form(...),
    deck_name: str = Form(""),
    default_tags: str = Form(""),
    on_conflict: str = Form("skip"),
    force_download: int = Form(0),
    after: str = Form("today"),
):
    try:
        source = get_source(source_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown wordbook source")

    rows, warnings = await load_rows(source, force_download=bool(force_download))
    if not rows:
        raise HTTPException(status_code=400, detail="Wordbook source returned no rows")

    deck = (deck_name or "").strip() or source.default_deck
    merged_tags = _merge_tags(source.default_tags, default_tags)

    for r in rows:
        r["deck"] = (r.get("deck") or "").strip() or deck
        r["tags"] = _merge_tags(r.get("tags", ""), merged_tags)

    rows = _dedupe_import_rows(rows)

    errors: list[str] = []
    errors.extend([f"WARNING: {w}" for w in warnings])

    inserted, updated, linked, skipped, errors = _apply_rows_to_db(rows, on_conflict=on_conflict, errors=errors)

    after = (after or "").strip().lower()
    if after == "today":
        deck_id: int | None = None
        with get_session() as session:
            d = session.query(Deck).filter(Deck.name == deck).first()
            deck_id = d.id if d else None
        toast_msg = f"已导入：{deck}（新增{inserted}，更新{updated}，跳过{skipped}）"
        qs = {"toast": toast_msg}
        if deck_id is not None:
            qs["deck_id"] = str(deck_id)
        return _redirect("/?" + urlencode(qs))

    return templates.TemplateResponse(
        request,
        "import_result.html",
        {
            "inserted": inserted,
            "updated": updated,
            "linked": linked,
            "skipped": skipped,
            "total": len(rows),
            "errors": errors[:50],
        },
    )


@app.get("/words", response_class=HTMLResponse)
def list_words(request: Request, q: str | None = None):
    with get_session() as session:
        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        query = session.query(Word).order_by(Word.id.desc())
        if q:
            like = f"%{q.strip()}%"
            query = query.filter(Word.term.like(like))
        words = query.limit(200).all()
    return templates.TemplateResponse(request, "words.html", {"words": words, "q": q or "", "decks": decks})


@app.post("/words")
def add_word(
    term: str = Form(...),
    definition: str = Form(""),
    example: str = Form(""),
    tags: str = Form(""),
    deck_name: str = Form(""),
    chapter: str = Form(""),
):
    term = term.strip()
    if not term:
        raise HTTPException(status_code=400, detail="term required")
    with get_session() as session:
        exists = session.query(Word).filter(Word.term == term).first()
        if exists:
            raise HTTPException(status_code=400, detail="这个单词已存在")
        word = Word(term=term, definition=definition.strip(), example=example.strip(), tags=tags.strip())
        session.add(word)
        session.flush()
        plan = _ensure_default_plan(session)
        source_deck_id: int | None = None
        if deck_name.strip():
            deck = _ensure_deck(session, deck_name)
            source_deck_id = int(deck.id)
            link = session.query(DeckWord).filter(DeckWord.deck_id == deck.id, DeckWord.word_id == word.id).first()
            if not link:
                session.add(DeckWord(deck_id=deck.id, word_id=word.id, chapter=chapter.strip()))
            _ensure_plan_deck(session, plan, source_deck_id)

        _ensure_plan_word(session, plan, word.id, source_deck_id)
        _ensure_srs_card(session, word.id)
    return _redirect("/words")


def _parse_import_meta_and_body(content: str) -> tuple[dict[str, str], str]:
    meta: dict[str, str] = {}
    body_lines: list[str] = []
    for raw in (content or "").splitlines():
        s = raw.strip()
        if not s:
            continue
        if s.startswith("#") and ":" in s:
            k, v = s[1:].split(":", 1)
            meta[k.strip().lower()] = v.strip()
            continue
        body_lines.append(raw.rstrip("\n\r"))
    return meta, "\n".join(body_lines)


def _parse_bulk_words(
    text: str,
    *,
    delimiter: str | None = None,
    columns: list[str] | None = None,
) -> tuple[list[dict[str, str]], list[str]]:
    """
    Supports:
    - One word per line: term
    - CSV/TSV per line: term<TAB>definition<TAB>example<TAB>tags<TAB>deck<TAB>chapter<TAB>position
    - CSV with header: term,definition,example,tags,deck,chapter,position (header names can be EN/ZH variants)
    - "columns" override (for files without header)
    """
    import csv

    raw_lines = [ln.rstrip("\n\r") for ln in (text or "").splitlines() if ln.strip()]
    if not raw_lines:
        return [], ["内容为空"]
    if len(raw_lines) > 5000:
        return [], ["导入行数过多（上限5000）"]

    if delimiter is None:
        first_line = raw_lines[0]
        if "\t" in first_line:
            delimiter = "\t"
        elif "," in first_line:
            delimiter = ","
        elif ";" in first_line:
            delimiter = ";"
        elif "|" in first_line:
            delimiter = "|"
        else:
            delimiter = None

    def _norm_token(tok: str) -> str:
        tok = tok.strip().lstrip("\ufeff").strip().strip('"').strip("'").strip()
        return tok.lower() if tok.isascii() else tok

    def _row_template() -> dict[str, str]:
        return {"term": "", "definition": "", "example": "", "tags": "", "deck": "", "chapter": "", "position": ""}

    def _as_int_str(s: str) -> str:
        s = (s or "").strip()
        if not s:
            return ""
        try:
            return str(int(float(s)))
        except ValueError:
            return ""

    def pick(d: dict[str, str], keys: list[str]) -> str:
        for k in keys:
            if k in d and d[k]:
                return str(d[k]).strip()
        return ""

    rows: list[dict[str, str]] = []
    errors: list[str] = []

    if delimiter is None:
        for i, ln in enumerate(raw_lines, start=1):
            term = ln.strip()
            if not term:
                errors.append(f"第{i}行：term为空")
                continue
            r = _row_template()
            r["term"] = term
            rows.append(r)
        return rows, errors

    # Normalize columns override
    norm_cols = [_norm_token(c) for c in (columns or []) if (c or "").strip()]
    if norm_cols:
        reader = csv.reader(raw_lines, delimiter=delimiter)
        for i, cols in enumerate(reader, start=1):
            cols = [c if c is not None else "" for c in cols]
            if not cols or not any(str(c).strip() for c in cols):
                continue
            r = _row_template()
            for idx, key in enumerate(norm_cols):
                if idx >= len(cols):
                    break
                val = str(cols[idx]).strip()
                if key in r:
                    r[key] = val
            if not r["term"].strip():
                errors.append(f"第{i}行：term为空")
                continue
            r["position"] = _as_int_str(r.get("position", ""))
            rows.append(r)
        return rows, errors

    # Header detection
    try:
        header_tokens = next(csv.reader([raw_lines[0]], delimiter=delimiter))
    except Exception:
        header_tokens = []
    header_set = {_norm_token(t) for t in header_tokens if t is not None}
    term_keys = {"term", "word", "单词", "词"}
    has_header = bool(header_set & term_keys)

    if has_header:
        reader = csv.DictReader(raw_lines, delimiter=delimiter)
        for i, r in enumerate(reader, start=2):
            rd = {_norm_token(str(k)): (str(v).strip() if v is not None else "") for k, v in (r or {}).items()}
            term = pick(rd, ["term", "word", "单词", "词"])
            if not term:
                errors.append(f"第{i}行：缺少term")
                continue
            out = _row_template()
            out["term"] = term
            out["definition"] = pick(rd, ["definition", "meaning", "释义", "备注"])
            out["example"] = pick(rd, ["example", "sentence", "例句"])
            out["tags"] = pick(rd, ["tags", "tag", "标签"])
            out["deck"] = pick(rd, ["deck", "book", "词书", "单词书"])
            out["chapter"] = pick(rd, ["chapter", "unit", "章节", "单元"])
            out["position"] = _as_int_str(pick(rd, ["position", "pos", "序号"]))
            rows.append(out)
        return rows, errors

    reader2 = csv.reader(raw_lines, delimiter=delimiter)
    for i, cols in enumerate(reader2, start=1):
        cols = [str(c).strip() if c is not None else "" for c in cols]
        if not cols or not any(cols):
            continue
        term = cols[0].strip()
        if not term:
            errors.append(f"第{i}行：term为空")
            continue
        out = _row_template()
        out["term"] = term
        out["definition"] = cols[1].strip() if len(cols) > 1 else ""
        out["example"] = cols[2].strip() if len(cols) > 2 else ""
        out["tags"] = cols[3].strip() if len(cols) > 3 else ""
        out["deck"] = cols[4].strip() if len(cols) > 4 else ""
        out["chapter"] = cols[5].strip() if len(cols) > 5 else ""
        out["position"] = _as_int_str(cols[6]) if len(cols) > 6 else ""
        rows.append(out)
    return rows, errors


@app.post("/words/import", response_class=HTMLResponse)
async def import_words(
    request: Request,
    text: str = Form(""),
    file: UploadFile | None = File(None),
    deck_name: str = Form(""),
    default_tags: str = Form(""),
    add_to_plan: int = Form(0),
    on_conflict: str = Form("skip"),
):
    content = text or ""
    if file is not None:
        raw = await file.read()
        try:
            content = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            # fallback for some Windows-exported CSVs
            content = raw.decode("gbk", errors="replace")

    meta, body = _parse_import_meta_and_body(content)

    sep = (meta.get("separator") or meta.get("sep") or "").strip().lower()
    delimiter: str | None = None
    if sep in {"tab", "\\t"}:
        delimiter = "\t"
    elif sep in {"comma", ","}:
        delimiter = ","
    elif sep in {"semicolon", ";"}:
        delimiter = ";"
    elif sep in {"pipe", "|"}:
        delimiter = "|"

    columns = None
    if meta.get("columns"):
        columns = [c.strip() for c in meta["columns"].split(",") if c.strip()]

    rows, parse_errors = _parse_bulk_words(body, delimiter=delimiter, columns=columns)
    if not rows:
        raise HTTPException(status_code=400, detail="；".join(parse_errors) if parse_errors else "没有可导入的数据")

    file_deck = (meta.get("deck") or meta.get("book") or "").strip()
    file_tags = (meta.get("tags") or "").strip()
    file_chapter = (meta.get("chapter") or meta.get("unit") or "").strip()
    default_deck = (deck_name or "").strip() or file_deck
    merged_default_tags = _merge_tags(file_tags, default_tags)

    for r in rows:
        r["deck"] = (r.get("deck") or "").strip() or default_deck
        if file_chapter and not (r.get("chapter") or "").strip():
            r["chapter"] = file_chapter
        r["tags"] = _merge_tags(r.get("tags", ""), merged_default_tags)

    rows = _dedupe_import_rows(rows)

    errors: list[str] = list(parse_errors)
    inserted, updated, linked, skipped, errors = _apply_rows_to_db(
        rows,
        on_conflict=on_conflict,
        errors=errors,
        add_to_plan=bool(add_to_plan),
    )
    return templates.TemplateResponse(
        request,
        "import_result.html",
        {
            "inserted": inserted,
            "updated": updated,
            "linked": linked,
            "skipped": skipped,
            "total": len(rows),
            "errors": errors[:50],
        },
    )


@app.post("/words/{word_id}/delete")
def delete_word(word_id: int):
    with get_session() as session:
        word = session.get(Word, word_id)
        if not word:
            raise HTTPException(status_code=404, detail="not found")
        session.delete(word)
    return _redirect("/words")


@app.get("/review", response_class=HTMLResponse)
def review(request: Request, deck_id: int | None = None, toast: str | None = None):
    if deck_id == 0:
        deck_id = None
    now = _utcnow()
    settings = get_settings()
    prefetch_limit = 120
    with get_session() as session:
        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        plan = _ensure_default_plan(session)
        plan_state = _apply_daily_new_limit(
            session,
            now=now,
            daily_new_limit=int(plan.daily_new_limit or 20),
            suspend_new_when_due_over=int(plan.suspend_new_when_due_over or 200),
            timezone_name=settings.app_timezone,
        )

        word_count = int(session.query(func.count(Word.id)).scalar() or 0)

        deck_name = ""
        deck_word_count = word_count
        if deck_id is not None:
            deck = session.get(Deck, deck_id)
            deck_name = deck.name if deck else ""
            deck_word_count = int(
                session.query(func.count(DeckWord.word_id)).filter(DeckWord.deck_id == deck_id).scalar() or 0
            )

        base_q = session.query(Word, SrsCard).join(SrsCard, SrsCard.word_id == Word.id)
        if deck_id is not None:
            base_q = (
                base_q.join(DeckWord, DeckWord.word_id == Word.id)
                .filter(DeckWord.deck_id == deck_id)
            )

        prefetch_rows: list[Any] = []
        review_limit = int(plan.daily_review_limit or 200)
        if review_limit < 0:
            review_limit = 0
        due_review_total = int(
            base_q.filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_not(None)).count()
        )
        due_new_total = int(base_q.filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None)).count())
        due_review_today = due_review_total if review_limit <= 0 else min(due_review_total, review_limit)
        due_new_today = min(due_new_total, int(plan_state.get("effective_new_limit") or 0))
        due_today = due_review_today + due_new_today

        if deck_id is not None:
            review_rows = (
                session.query(Word, SrsCard, DeckWord.chapter)
                .join(SrsCard, SrsCard.word_id == Word.id)
                .join(DeckWord, DeckWord.word_id == Word.id)
                .filter(DeckWord.deck_id == deck_id)
                .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_not(None))
                .order_by(SrsCard.due_at.asc(), Word.term.asc())
                .limit(min(prefetch_limit, max(0, due_review_today)))
                .all()
            )
            remaining = max(0, prefetch_limit - len(review_rows))
            new_rows = []
            if remaining > 0 and due_new_today > 0:
                new_rows = (
                    session.query(Word, SrsCard, DeckWord.chapter)
                    .join(SrsCard, SrsCard.word_id == Word.id)
                    .join(DeckWord, DeckWord.word_id == Word.id)
                    .filter(DeckWord.deck_id == deck_id)
                    .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None))
                    .order_by(SrsCard.due_at.asc(), SrsCard.created_at.asc(), Word.term.asc())
                    .limit(min(remaining, due_new_today))
                    .all()
                )
            prefetch_rows = list(review_rows) + list(new_rows)
        else:
            review_rows = (
                base_q.filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_not(None))
                .order_by(SrsCard.due_at.asc(), Word.term.asc())
                .limit(min(prefetch_limit, max(0, due_review_today)))
                .all()
            )
            remaining = max(0, prefetch_limit - len(review_rows))
            new_rows = []
            if remaining > 0 and due_new_today > 0:
                new_rows = (
                    base_q.filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None))
                    .order_by(SrsCard.due_at.asc(), SrsCard.created_at.asc(), Word.term.asc())
                    .limit(min(remaining, due_new_today))
                    .all()
                )
            prefetch_rows = list(review_rows) + list(new_rows)

        due_pair = None
        if prefetch_rows:
            if deck_id is not None:
                w, c, _ch = prefetch_rows[0]
                due_pair = (w, c)
            else:
                due_pair = prefetch_rows[0]
        cards_q = session.query(SrsCard)
        if deck_id is not None:
            cards_q = cards_q.join(DeckWord, DeckWord.word_id == SrsCard.word_id).filter(DeckWord.deck_id == deck_id)
        total, due_count = cards_q.with_entities(
            func.count(SrsCard.word_id),
            func.coalesce(func.sum(case((SrsCard.due_at <= now, 1), else_=0)), 0),
        ).first() or (0, 0)
        total = int(total or 0)
        due_count = int(min(int(due_count or 0), due_today))

        next_pair = base_q.filter(SrsCard.due_at > now).order_by(SrsCard.due_at.asc()).first()
        next_due_at = next_pair[1].due_at if next_pair else None
        next_due_at_display = _format_next_due_at(next_due_at, now=now) if next_due_at else ""

        word = due_pair[0] if due_pair else None
        card = due_pair[1] if due_pair else None
        chapter = ""
        if word is not None and deck_id is not None:
            link = session.query(DeckWord).filter(DeckWord.deck_id == deck_id, DeckWord.word_id == word.id).first()
            chapter = link.chapter if link else ""

    word_phonetic, word_definition_text = _word_display_parts(word)

    prefetch_cards: list[dict[str, Any]] = []
    if prefetch_rows:
        if deck_id is not None:
            for w, c, ch in prefetch_rows:
                prefetch_cards.append(_review_card_dict(w, c, chapter=str(ch or "")))
        else:
            for w, c in prefetch_rows:
                prefetch_cards.append(_review_card_dict(w, c))

    return templates.TemplateResponse(
        request,
        "review.html",
        {
            "word": word,
            "card": card,
            "chapter": chapter,
            "word_phonetic": word_phonetic,
            "word_definition_text": word_definition_text,
            "decks": decks,
            "deck_id": deck_id,
            "due_count": due_count,
            "total": total,
            "next_due_at": next_due_at,
            "next_due_at_display": next_due_at_display,
            "word_count": word_count,
            "deck_word_count": deck_word_count,
            "deck_name": deck_name,
            "toast": (toast or "").strip(),
            "daily_new_limit": int(plan.daily_new_limit or 20),
            "daily_review_limit": int(plan.daily_review_limit or 200),
            "new_paused": bool(plan_state.get("new_paused")),
            "state_map": {1: "Learning", 2: "Review", 3: "Relearning"},
            "prefetch_cards_json": json.dumps(prefetch_cards, ensure_ascii=False),
        },
    )


@app.post("/review/{word_id}")
def submit_review(
    request: Request,
    word_id: int,
    rating: str = Form(...),
    deck_id: int | None = Form(None),
    duration_ms: int | None = Form(None),
):
    try:
        r = parse_rating(rating)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid rating") from None
    with get_session() as session:
        word = session.get(Word, word_id)
        if not word:
            raise HTTPException(status_code=404, detail="not found")

        card_row = _ensure_srs_card(session, word_id)
        scheduler = get_scheduler()
        fsrs_card = db_card_to_fsrs(card_row)
        updated_card, _log = scheduler.review_card(fsrs_card, r)
        apply_fsrs_to_db(card_row, updated_card)

        now = _utcnow()
        word.last_reviewed_at = now

        if r == Rating.Again:
            word.wrong_count += 1
            session.add(Mistake(word_id=word_id))
        else:
            word.correct_count += 1

        session.add(
            SrsReviewLog(
                word_id=word_id,
                rating=int(r.value),
                reviewed_at=now,
                duration_ms=duration_ms,
            )
        )

    # HTMX (mobile) optimization: avoid POST->redirect->GET roundtrip.
    if _is_htmx(request):
        return review(request, deck_id=deck_id)

    if deck_id is not None:
        return _redirect(f"/review?deck_id={deck_id}")
    return _redirect("/review")


@app.post("/api/review/{word_id}/rate", response_class=JSONResponse)
def api_rate_review_word(
    request: Request,
    word_id: int,
    rating: str = Form(...),
    deck_id: int | None = Form(None),
    duration_ms: int | None = Form(None),
):
    try:
        r = parse_rating(rating)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid rating") from None

    with get_session() as session:
        word = session.get(Word, word_id)
        if not word:
            raise HTTPException(status_code=404, detail="not found")

        card_row = _ensure_srs_card(session, word_id)
        scheduler = get_scheduler()
        fsrs_card = db_card_to_fsrs(card_row)
        updated_card, _log = scheduler.review_card(fsrs_card, r)
        apply_fsrs_to_db(card_row, updated_card)

        now = _utcnow()
        word.last_reviewed_at = now

        if r == Rating.Again:
            word.wrong_count += 1
            session.add(Mistake(word_id=word_id))
        else:
            word.correct_count += 1

        session.add(
            SrsReviewLog(
                word_id=word_id,
                rating=int(r.value),
                reviewed_at=now,
                duration_ms=duration_ms,
            )
        )

    _log_auth_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "user_username", None),
        kind="action",
        path=str(request.url.path or "/"),
        method="POST",
        status_code=200,
        duration_ms=0,
        meta={"action": "review_rate", "word_id": int(word_id), "rating": str(rating), "deck_id": deck_id},
    )
    return {"ok": True, "deck_id": deck_id}


@app.post("/api/analytics/events", response_class=JSONResponse)
async def api_analytics_events(request: Request):
    username = getattr(request.state, "user_username", None)
    user_id = getattr(request.state, "user_id", None)
    if not username or user_id is None:
        raise HTTPException(status_code=401, detail="not logged in")

    try:
        payload = await request.json()
    except Exception:
        payload = None

    if isinstance(payload, list):
        events = payload
        ctx: dict[str, Any] = {}
    elif isinstance(payload, dict):
        events = payload.get("events") or []
        ctx = {k: payload.get(k) for k in ("sid", "pid", "url", "page") if k in payload}
    else:
        events = []
        ctx = {}

    if not isinstance(events, list):
        events = []

    # Store each event as a row for maximal detail (small userbase; OK).
    stored = 0
    for ev in events[:300]:
        if not isinstance(ev, dict):
            continue
        path = str(ev.get("path") or request.url.path or "/")
        meta = {"ctx": ctx, "ev": ev}
        _log_auth_event(
            user_id=user_id,
            username=username,
            kind="client",
            path=path,
            method="POST",
            status_code=200,
            duration_ms=int(ev.get("dt_ms") or 0),
            meta=meta,
        )
        stored += 1

    return {"ok": True, "stored": stored}


def _query_mistake_aggregates(
    session,
    *,
    min_events: int,
    sort: str,
    limit: int,
) -> list[dict[str, Any]]:
    min_events = max(1, int(min_events or 1))
    sort = (sort or "freq").strip().lower()
    sort = sort if sort in {"freq", "time"} else "freq"
    limit = max(1, min(2000, int(limit or 200)))

    agg = (
        session.query(
            Mistake.word_id.label("word_id"),
            func.count(Mistake.id).label("wrong_events"),
            func.max(Mistake.created_at).label("last_wrong_at"),
        )
        .group_by(Mistake.word_id)
        .subquery()
    )

    q = session.query(Word, agg.c.wrong_events, agg.c.last_wrong_at).join(agg, agg.c.word_id == Word.id)
    if min_events > 1:
        q = q.filter(agg.c.wrong_events >= min_events)

    if sort == "time":
        q = q.order_by(agg.c.last_wrong_at.desc(), agg.c.wrong_events.desc(), Word.term.asc())
    else:
        q = q.order_by(agg.c.wrong_events.desc(), agg.c.last_wrong_at.desc(), Word.term.asc())

    out: list[dict[str, Any]] = []
    for w, wrong_events, last_wrong_at in q.limit(limit).all():
        out.append(
            {
                "word": w,
                "wrong_events": int(wrong_events or 0),
                "last_wrong_at": last_wrong_at,
            }
        )
    return out


@app.get("/mistakes", response_class=HTMLResponse)
def mistakes(
    request: Request,
    level: str | None = None,
    target_count: int | None = None,
    length_mode: str = "standard",
    sort: str = "freq",
    include_once: int = 0,
    use_fixed_target_count: int | None = None,
    error: str | None = None,
):
    def _default_k(lv: str) -> int:
        mapping = {"junior": 8, "senior": 9, "cet4": 10, "cet6": 10, "kaoyan": 12}
        return int(mapping.get(lv, 10))

    def _norm_level(lv: str | None) -> str:
        lv = (lv or "").strip().lower()
        return lv if lv in LEVEL_GUIDE else "cet4"

    def _norm_length_mode(mode: str | None) -> str:
        mode = (mode or "standard").strip().lower()
        return mode if mode in {"standard", "long"} else "standard"

    query_keys = request.query_params.keys()
    has_level = "level" in query_keys
    has_target_count = "target_count" in query_keys
    has_length_mode = "length_mode" in query_keys
    has_include_once = "include_once" in query_keys
    has_sort = "sort" in query_keys
    has_use_fixed_target_count = "use_fixed_target_count" in query_keys

    with get_session() as session:
        def _guess_level_from_deck_name(name: str) -> str | None:
            n = (name or "").strip().lower()
            if not n:
                return None
            # Chinese / common naming conventions
            if ("中考" in n) or ("初中" in n) or ("junior" in n):
                return "junior"
            if ("高考" in n) or ("高中" in n) or ("senior" in n):
                return "senior"
            if ("四级" in n) or ("cet4" in n) or ("cet-4" in n):
                return "cet4"
            if ("六级" in n) or ("cet6" in n) or ("cet-6" in n):
                return "cet6"
            if ("考研" in n) or ("研究生" in n) or ("kaoyan" in n):
                return "kaoyan"
            return None

        owner_norm = _request_owner_norm(request)
        pref = _ensure_mistake_practice_settings(session, owner_norm)

        pref_level = (pref.default_level or "auto").strip().lower()
        if pref_level not in {"auto", *set(LEVEL_GUIDE.keys())}:
            pref_level = "auto"
        pref_length_mode = _norm_length_mode(pref.default_length_mode or "standard")
        pref_include_once = 1 if int(pref.default_include_once or 0) == 1 else 0
        pref_use_fixed_target_count = 1 if int(pref.use_fixed_target_count or 0) == 1 else 0

        pref_target_count: int | None = None
        if pref.default_target_count is not None:
            try:
                pref_target_count = max(6, min(14, int(pref.default_target_count)))
            except Exception:
                pref_target_count = None

        if has_include_once:
            include_once_effective = 1 if int(include_once or 0) == 1 else 0
        else:
            include_once_effective = pref_include_once

        sort2 = (sort or "freq").strip().lower() if has_sort else "freq"
        sort2 = sort2 if sort2 in {"freq", "time"} else "freq"

        if has_use_fixed_target_count:
            use_fixed_target_count_effective = 1 if int(use_fixed_target_count or 0) == 1 else 0
        else:
            use_fixed_target_count_effective = pref_use_fixed_target_count

        min_events = 1 if include_once_effective == 1 else 2

        items = _query_mistake_aggregates(session, min_events=min_events, sort=sort2, limit=240)

        # For auto level mode, use the most common deck among mistakes.
        guessed_level: str | None = None
        if items:
            deck_row = (
                session.query(Deck.name, func.count(Mistake.id))
                .join(DeckWord, DeckWord.deck_id == Deck.id)
                .join(Mistake, Mistake.word_id == DeckWord.word_id)
                .group_by(Deck.id)
                .order_by(func.count(Mistake.id).desc(), Deck.id.asc())
                .first()
            )
            if deck_row and deck_row[0]:
                guessed_level = _guess_level_from_deck_name(str(deck_row[0]))

    level_control_value = (level or "").strip().lower() if has_level else pref_level
    if level_control_value not in {"auto", *set(LEVEL_GUIDE.keys())}:
        level_control_value = "auto"
    selected_level = _norm_level(guessed_level if level_control_value == "auto" else level_control_value)

    selected_length_mode = _norm_length_mode(length_mode if has_length_mode else pref_length_mode)

    if has_target_count:
        try:
            selected_target_count = int(target_count)
        except Exception:
            selected_target_count = _default_k(selected_level)
        selected_target_count = max(6, min(14, selected_target_count))
    elif use_fixed_target_count_effective == 1 and pref_target_count is not None:
        selected_target_count = pref_target_count
    else:
        selected_target_count = _default_k(selected_level)

    return templates.TemplateResponse(
        request,
        "mistakes.html",
        {
            "items": items,
            "levels": list(LEVEL_GUIDE.keys()),
            "level_guide": LEVEL_GUIDE,
            "selected_level": selected_level,
            "target_count": selected_target_count,
            "length_mode": selected_length_mode,
            "level_control_value": level_control_value,
            "use_fixed_target_count": use_fixed_target_count_effective,
            "sort": sort2,
            "include_once": include_once_effective,
            "error": (error or "").strip(),
        },
    )


@app.post("/simulations/generate")
async def generate_simulation(
    request: Request,
    level: str = Form(...),
    word_ids: str = Form(""),
    target_count: int = Form(0),
    length_mode: str = Form("standard"),
):
    def _default_k(lv: str) -> int:
        mapping = {"junior": 8, "senior": 9, "cet4": 10, "cet6": 10, "kaoyan": 12}
        return int(mapping.get(lv, 10))

    def _norm_level(lv: str | None) -> str:
        lv = (lv or "").strip().lower()
        return lv if lv in LEVEL_GUIDE else "cet4"

    def _norm_length_mode(mode: str | None) -> str:
        mode = (mode or "standard").strip().lower()
        return mode if mode in {"standard", "long"} else "standard"

    def _min_words(lv: str, mode: str) -> int:
        standard = {"junior": 220, "senior": 300, "cet4": 360, "cet6": 480, "kaoyan": 600}
        long = {"junior": 320, "senior": 420, "cet4": 520, "cet6": 680, "kaoyan": 820}
        return int((long if mode == "long" else standard).get(lv, 360))

    def _paragraph_range(target_words: int) -> tuple[int, int]:
        if target_words <= 280:
            return (3, 4)
        if target_words <= 520:
            return (4, 6)
        return (5, 8)

    selected_level = _norm_level(level)
    selected_length_mode = _norm_length_mode(length_mode)
    try:
        k = int(target_count) if int(target_count) > 0 else _default_k(selected_level)
    except Exception:
        k = _default_k(selected_level)
    k = max(6, min(14, k))

    ids = [int(x) for x in (word_ids or "").split(",") if x.strip().isdigit()]
    ids = list(dict.fromkeys(ids))  # dedupe keep order

    # Manual selection is allowed, but keep an upper bound for quality.
    max_manual = 14
    if len(ids) > max_manual:
        ids = ids[:max_manual]

    with get_session() as session:
        words: list[Word] = []
        if ids:
            fetched = session.query(Word).filter(Word.id.in_(ids)).all()
            by_id = {w.id: w for w in fetched}
            words = [by_id[i] for i in ids if i in by_id]
            if not words:
                return mistakes(
                    request,
                    level=selected_level,
                    target_count=k,
                    length_mode=selected_length_mode,
                    error="你勾选的单词已不存在（可能被删除）。请刷新后重试，或直接不勾选让系统自动选词。",
                )
        else:
            # Auto-pick from mistakes (aggregated per word)
            picked: list[Word] = []
            items = _query_mistake_aggregates(session, min_events=2, sort="freq", limit=800)
            picked.extend([it["word"] for it in items[:k]])
            if len(picked) < k:
                items2 = _query_mistake_aggregates(session, min_events=1, sort="freq", limit=800)
                seen = {int(w.id) for w in picked}
                for it in items2:
                    w = it["word"]
                    if int(w.id) in seen:
                        continue
                    seen.add(int(w.id))
                    picked.append(w)
                    if len(picked) >= k:
                        break
            words = picked[:k]

    if not words:
        return mistakes(
            request,
            level=selected_level,
            target_count=k,
            length_mode=selected_length_mode,
            error="还没有错词可生成。先去“今日学习”里点几次“不认识/Again”。",
        )

    terms = [w.term for w in words]
    term_notes = {w.term: (w.definition or w.example or "").strip() for w in words}

    min_words = _min_words(selected_level, selected_length_mode)
    target_words = max(min_words, len(terms) * 30)
    lo = int(round(target_words * 0.9))
    hi = int(round(target_words * 1.15))
    p_lo, p_hi = _paragraph_range(target_words)
    question_count = max(6, min(10, int(round(target_words / 60))))

    settings = get_settings()
    client = AiClient(settings=settings)
    try:
        sim = await client.generate_simulation(
            level=selected_level,
            terms=terms,
            term_notes=term_notes,
            passage_word_range=(lo, hi),
            paragraph_range=(p_lo, p_hi),
            question_count=question_count,
        )
    except Exception as e:
        msg = str(e) or "AI generation failed"
        if "Missing AI_API_KEY" in msg:
            msg = "AI 未配置：请在 .env 配置 AI_API_KEY，或开启 AI_MOCK=1。"
        return mistakes(
            request,
            level=selected_level,
            target_count=k,
            length_mode=selected_length_mode,
            error=msg,
        )

    with get_session() as session:
        term_word_map = {str(w.term or "").strip().lower(): int(w.id) for w in words if str(w.term or "").strip()}
        payload_obj = sim.model_dump()
        payload_obj["term_word_map"] = term_word_map
        row = Simulation(
            level=selected_level,
            target_terms_json=json.dumps(terms, ensure_ascii=False),
            passage=sim.passage,
            questions_json=json.dumps(payload_obj, ensure_ascii=False),
        )
        session.add(row)
        session.flush()
        sim_id = row.id
    return _redirect(f"/simulations/{sim_id}")


@app.post("/simulations/generate_stream")
async def generate_simulation_stream(
    request: Request,
    level: str = Form(...),
    word_ids: str = Form(""),
    target_count: int = Form(0),
    length_mode: str = Form("standard"),
):
    def _default_k(lv: str) -> int:
        mapping = {"junior": 8, "senior": 9, "cet4": 10, "cet6": 10, "kaoyan": 12}
        return int(mapping.get(lv, 10))

    def _norm_level(lv: str | None) -> str:
        lv = (lv or "").strip().lower()
        return lv if lv in LEVEL_GUIDE else "cet4"

    def _norm_length_mode(mode: str | None) -> str:
        mode = (mode or "standard").strip().lower()
        return mode if mode in {"standard", "long"} else "standard"

    def _min_words(lv: str, mode: str) -> int:
        standard = {"junior": 220, "senior": 300, "cet4": 360, "cet6": 480, "kaoyan": 600}
        long = {"junior": 320, "senior": 420, "cet4": 520, "cet6": 680, "kaoyan": 820}
        return int((long if mode == "long" else standard).get(lv, 360))

    def _paragraph_range(target_words: int) -> tuple[int, int]:
        if target_words <= 280:
            return (3, 4)
        if target_words <= 520:
            return (4, 6)
        return (5, 8)

    def _sse(obj: dict[str, Any]) -> str:
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    selected_level = _norm_level(level)
    selected_length_mode = _norm_length_mode(length_mode)
    try:
        k = int(target_count) if int(target_count) > 0 else _default_k(selected_level)
    except Exception:
        k = _default_k(selected_level)
    k = max(6, min(14, k))

    ids = [int(x) for x in (word_ids or "").split(",") if x.strip().isdigit()]
    ids = list(dict.fromkeys(ids))  # dedupe keep order
    if len(ids) > 14:
        ids = ids[:14]

    settings = get_settings()
    client = AiClient(settings=settings)

    async def gen():
        try:
            started_at = time.perf_counter()

            def _stamp() -> str:
                return f"{(time.perf_counter() - started_at):.2f}s"

            def _note(msg: str) -> str:
                return _sse({"t": "note", "msg": f"[{_stamp()}] {msg}"})

            yield _note(
                f"request accepted level={selected_level} length={selected_length_mode} "
                f"k={k} manual_ids={len(ids)}"
            )

            # Select words (manual IDs or auto-pick from mistakes)
            sel_t0 = time.perf_counter()
            with get_session() as session:
                words: list[Word] = []
                if ids:
                    fetched = session.query(Word).filter(Word.id.in_(ids)).all()
                    by_id = {w.id: w for w in fetched}
                    words = [by_id[i] for i in ids if i in by_id]
                    yield _note(
                        "word selection=manual "
                        f"requested={len(ids)} found={len(words)} dt={(time.perf_counter() - sel_t0) * 1000:.0f}ms"
                    )
                else:
                    items = _query_mistake_aggregates(session, min_events=2, sort="freq", limit=800)
                    words = [it["word"] for it in items[:k]]
                    scanned_rows = len(items)
                    unique = scanned_rows
                    if len(words) < k:
                        items2 = _query_mistake_aggregates(session, min_events=1, sort="freq", limit=800)
                        seen = {int(w.id) for w in words}
                        for it in items2:
                            w = it["word"]
                            if int(w.id) in seen:
                                continue
                            seen.add(int(w.id))
                            words.append(w)
                            if len(words) >= k:
                                break
                        scanned_rows = max(scanned_rows, len(items2))
                        unique = scanned_rows
                    yield _note(
                        "word selection=auto "
                        f"scanned_rows={scanned_rows} unique={unique} picked={len(words)} "
                        f"sort=(wrong_events,last_wrong_at) dt={(time.perf_counter() - sel_t0) * 1000:.0f}ms"
                    )

            if not words:
                yield _sse({"t": "error", "msg": "还没有错词可生成。先去“今日学习”里点几次“不认识/Again”。"})
                return

            terms = [w.term for w in words]
            term_notes = {w.term: (w.definition or w.example or "").strip() for w in words}
            yield _note(f"terms={len(terms)} [{', '.join(terms)}]")

            min_words = _min_words(selected_level, selected_length_mode)
            target_words = max(min_words, len(terms) * 30)
            lo = int(round(target_words * 0.9))
            hi = int(round(target_words * 1.15))
            p_lo, p_hi = _paragraph_range(target_words)
            question_count = max(6, min(10, int(round(target_words / 60))))
            yield _note(
                "generation plan "
                f"passage_words≈{target_words} range=[{lo},{hi}] paragraphs=[{p_lo},{p_hi}] questions={question_count}"
            )

            if settings.ai_mock:
                yield _note("AI_MOCK=1 generating mock output")
                sim = await client.generate_simulation(
                    level=selected_level,
                    terms=terms,
                    term_notes=term_notes,
                    passage_word_range=(lo, hi),
                    paragraph_range=(p_lo, p_hi),
                    question_count=question_count,
                )
                mock_text = json.dumps(sim.model_dump(), ensure_ascii=False)
                step = 140
                for i in range(0, len(mock_text), step):
                    chunk = mock_text[i : i + step]
                    yield _sse({"t": "delta", "c": chunk})
                    await asyncio.sleep(0.01)
            else:
                if not settings.ai_api_key:
                    yield _sse({"t": "error", "msg": "AI 未配置：请在 .env 配置 AI_API_KEY，或开启 AI_MOCK=1。"})
                    return

                prompt_t0 = time.perf_counter()
                yield _note("building prompt")
                payload, system, user = client.build_simulation_payload(
                    level=selected_level,
                    terms=terms,
                    term_notes=term_notes,
                    passage_word_range=(lo, hi),
                    paragraph_range=(p_lo, p_hi),
                    question_count=question_count,
                )
                prompt_ms = (time.perf_counter() - prompt_t0) * 1000
                yield _note(
                    "prompt ready "
                    f"dt={prompt_ms:.0f}ms system_chars={len(system)} user_chars={len(user)} "
                    f"messages={len(payload.get('messages') or [])}"
                )

                last_parsed: GeneratedSimulation | None = None
                last_missing: list[str] | None = None
                sim: GeneratedSimulation | None = None
                for attempt in range(1, 4):
                    yield _note(f"AI request attempt={attempt}/3")
                    parts: list[str] = []

                    stream_it = client.chat_completions_content_stream(payload).__aiter__()
                    got_any = False
                    attempt_started_at = time.perf_counter()

                    pending = asyncio.create_task(stream_it.__anext__())
                    while True:
                        try:
                            delta = await asyncio.wait_for(asyncio.shield(pending), timeout=0.9)
                        except asyncio.TimeoutError:
                            if not got_any:
                                waited = time.perf_counter() - attempt_started_at
                                yield _note(f"waiting for first token... waited={waited:.1f}s")
                            continue
                        except StopAsyncIteration:
                            break

                        if not got_any:
                            got_any = True
                            waited = time.perf_counter() - attempt_started_at
                            yield _note(f"first token received waited={waited:.2f}s")

                        parts.append(delta)
                        if delta:
                            yield _sse({"t": "delta", "c": delta})

                        pending = asyncio.create_task(stream_it.__anext__())

                    text = "".join(parts)
                    try:
                        parse_t0 = time.perf_counter()
                        yield _note(f"stream finished, parsing json chars={len(text)}")
                        json_text = _safe_json_extract(text)
                        parsed = GeneratedSimulation.model_validate(json.loads(json_text))
                        sim = parsed
                        parse_ms = (time.perf_counter() - parse_t0) * 1000
                        yield _note(f"parse ok dt={parse_ms:.0f}ms")
                        break
                    except Exception:
                        yield _note("validation failed, retrying with stricter instructions")
                        payload = {
                            **payload,
                            "messages": [
                                {"role": "system", "content": system},
                                {
                                    "role": "user",
                                    "content": (
                                        "上一次输出不符合要求（JSON不可解析或缺少目标词）。"
                                        "请严格输出可解析的JSON，并确保短文自然包含所有目标词。"
                                        "只输出JSON，不要多余文本。"
                                    ),
                                },
                                {"role": "user", "content": user},
                            ],
                            "temperature": 0.4,
                        }
                        continue

                if sim is None:
                    if last_parsed is not None and last_missing:
                        patched = last_parsed.model_copy(deep=True)
                        patched.passage = patched.passage.rstrip() + "\n\nKey words (added): " + ", ".join(last_missing) + "."
                        sim = patched
                    else:
                        yield _sse({"t": "error", "msg": "AI 生成失败：多次重试仍未得到可用结果。"})
                        return

            with get_session() as session:
                term_word_map = {str(w.term or "").strip().lower(): int(w.id) for w in words if str(w.term or "").strip()}
                payload_obj = sim.model_dump()
                payload_obj["term_word_map"] = term_word_map
                row = Simulation(
                    level=selected_level,
                    target_terms_json=json.dumps(terms, ensure_ascii=False),
                    passage=sim.passage,
                    questions_json=json.dumps(payload_obj, ensure_ascii=False),
                )
                session.add(row)
                session.flush()
                sim_id = row.id

            yield _sse({"t": "done", "sim_id": sim_id})
        except asyncio.CancelledError:
            return
        except Exception as e:
            msg = str(e) or "AI generation failed"
            if "Missing AI_API_KEY" in msg:
                msg = "AI 未配置：请在 .env 配置 AI_API_KEY，或开启 AI_MOCK=1。"
            yield _sse({"t": "error", "msg": msg})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/simulations/{sim_id}", response_class=HTMLResponse)
def show_simulation(request: Request, sim_id: int):
    with get_session() as session:
        row = session.get(Simulation, sim_id)
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    payload = json.loads(row.questions_json)
    questions = payload["questions"]
    passage_html = _passage_to_html(row.passage or "")
    return templates.TemplateResponse(
        request,
        "simulation.html",
        {
            "sim": row,
            "passage_html": passage_html,
            "questions": questions,
            "level_guide": LEVEL_GUIDE,
        },
    )


@app.get("/simulations/{sim_id}/retest", response_class=HTMLResponse)
def simulation_retest(request: Request, sim_id: int, i: int = 0, toast: str | None = None):
    try:
        i = int(i)
    except Exception:
        i = 0
    i = max(0, i)

    with get_session() as session:
        row = session.get(Simulation, sim_id)
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        try:
            terms: list[str] = json.loads(row.target_terms_json)
        except Exception:
            terms = []
        terms = [str(t).strip() for t in terms if str(t).strip()]

        # Only retest words that are currently in mistakes (错词篮)
        fetched: list[Word] = []
        if terms:
            fetched = (
                session.query(Word)
                .join(Mistake, Mistake.word_id == Word.id)
                .filter(Word.term.in_(terms))
                .all()
            )
        by_term = {w.term: w for w in fetched}
        retest_words = [by_term[t] for t in terms if t in by_term]

        total = len(retest_words)
        if total == 0:
            return templates.TemplateResponse(
                request,
                "simulation_retest.html",
                {"sim": row, "word": None, "i": 0, "total": 0, "remaining": 0, "toast": (toast or "").strip()},
            )

        if i >= total:
            i = total - 1

        word = retest_words[i]
        remaining = total - i

        prefetch_words = [_word_dict(w) for w in retest_words]
        word_phonetic, word_definition_text = _word_display_parts(word)

    return templates.TemplateResponse(
        request,
        "simulation_retest.html",
        {
            "sim": row,
            "word": word,
            "i": i,
            "total": total,
            "remaining": remaining,
            "toast": (toast or "").strip(),
            "prefetch_words_json": json.dumps(prefetch_words, ensure_ascii=False),
            "word_phonetic": word_phonetic,
            "word_definition_text": word_definition_text,
        },
    )


@app.post("/simulations/{sim_id}/retest/{word_id}")
def simulation_retest_rate(
    request: Request,
    sim_id: int,
    word_id: int,
    rating: str = Form(...),
    i: int = Form(0),
):
    try:
        i = int(i)
    except Exception:
        i = 0
    i = max(0, i)

    moved_out = False
    term = ""
    with get_session() as session:
        row = session.get(Simulation, sim_id)
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        w = session.get(Word, int(word_id))
        if not w:
            raise HTTPException(status_code=404, detail="word not found")
        term = w.term

        r = (rating or "").strip().lower()
        if r in {"good", "easy"}:
            session.query(Mistake).filter(Mistake.word_id == w.id).delete(synchronize_session=False)
            moved_out = True

    # If removed from mistakes, the list shrinks; keep index.
    next_i = i if moved_out else (i + 1)
    # HTMX (mobile) optimization: avoid POST->redirect->GET roundtrip.
    if _is_htmx(request):
        return simulation_retest(request, sim_id, i=next_i)

    return _redirect("/simulations/" + str(sim_id) + "/retest?" + urlencode({"i": str(next_i)}))


@app.post("/api/simulations/{sim_id}/retest/{word_id}/rate", response_class=JSONResponse)
def api_rate_simulation_retest(
    request: Request,
    sim_id: int,
    word_id: int,
    rating: str = Form(...),
):
    moved_out = False
    with get_session() as session:
        row = session.get(Simulation, sim_id)
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        w = session.get(Word, int(word_id))
        if not w:
            raise HTTPException(status_code=404, detail="word not found")

        r = (rating or "").strip().lower()
        if r in {"good", "easy"}:
            session.query(Mistake).filter(Mistake.word_id == w.id).delete(synchronize_session=False)
            moved_out = True

    _log_auth_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "user_username", None),
        kind="action",
        path=str(request.url.path or "/"),
        method="POST",
        status_code=200,
        duration_ms=0,
        meta={
            "action": "retest_rate",
            "sim_id": int(sim_id),
            "word_id": int(word_id),
            "rating": str(rating),
            "moved_out": bool(moved_out),
        },
    )
    return {"ok": True, "moved_out": moved_out}


@app.get("/simulations", response_class=HTMLResponse)
def list_simulations(request: Request):
    with get_session() as session:
        sims = session.query(Simulation).order_by(Simulation.id.desc()).limit(50).all()
    items = []
    for s in sims:
        try:
            terms = json.loads(s.target_terms_json)
        except Exception:
            terms = []
        items.append({"sim": s, "terms": terms})
    return templates.TemplateResponse(request, "simulations.html", {"items": items, "level_guide": LEVEL_GUIDE})


@app.post("/simulations/{sim_id}/grade_async", response_class=HTMLResponse)
async def grade_simulation_async(request: Request, sim_id: int):
    form = await request.form()

    def _idx_label(i: int) -> str:
        try:
            return ["A", "B", "C", "D"][int(i)]
        except Exception:
            return ""

    with get_session() as session:
        row = session.get(Simulation, sim_id)
        if not row:
            raise HTTPException(status_code=404, detail="not found")

        payload = json.loads(row.questions_json or "{}")
        questions: list[dict[str, Any]] = list(payload.get("questions") or [])

        term_word_map_raw = payload.get("term_word_map") or {}
        term_word_map: dict[str, int] = {}
        if isinstance(term_word_map_raw, dict):
            for k, v in term_word_map_raw.items():
                key = str(k or "").strip().lower()
                try:
                    wid = int(v)
                except Exception:
                    continue
                if key and wid > 0:
                    term_word_map[key] = wid

        answers: dict[str, int] = {}
        for q in questions:
            qid = str(q.get("id") or "")
            if not qid:
                continue
            raw = form.get(qid)
            if raw is None:
                continue
            try:
                answers[qid] = int(raw)
            except ValueError:
                continue

        graded: list[dict[str, Any]] = []
        correct = 0
        term_has_wrong: dict[str, bool] = {}

        for q in questions:
            qid = str(q.get("id") or "")
            user_idx = answers.get(qid, -1)
            answer_idx = int(q.get("answer_index") or 0)
            ok = user_idx == answer_idx
            if ok:
                correct += 1

            target_term = str(q.get("target_term") or "").strip()
            if target_term:
                key = target_term.lower()
                term_has_wrong[key] = bool(term_has_wrong.get(key, False) or (not ok))

            choices = list(q.get("choices") or [])
            user_choice = choices[user_idx] if 0 <= user_idx < len(choices) else ""
            answer_choice = choices[answer_idx] if 0 <= answer_idx < len(choices) else ""

            graded.append(
                {
                    **q,
                    "user_answer_index": user_idx,
                    "answer_index": answer_idx,
                    "user_answer_label": _idx_label(user_idx),
                    "answer_label": _idx_label(answer_idx),
                    "user_choice_text": user_choice,
                    "answer_choice_text": answer_choice,
                    "is_correct": ok,
                }
            )

        # ---- FSRS writeback (per target_term) ----
        scheduler = get_scheduler()
        now = _utcnow()
        reviewed: list[dict[str, Any]] = []
        needs_relearn: list[Word] = []

        for term_key, has_wrong in term_has_wrong.items():
            wid = int(term_word_map.get(term_key) or 0)
            if wid <= 0:
                # Fallback: lookup by term (case-insensitive)
                w0 = session.query(Word).filter(func.lower(Word.term) == term_key).first()
                wid = int(w0.id) if w0 else 0
            if wid <= 0:
                continue

            word = session.get(Word, wid)
            if not word:
                continue

            card_row = _ensure_srs_card(session, wid)
            fsrs_card = db_card_to_fsrs(card_row)
            r = Rating.Again if has_wrong else Rating.Good
            updated_card, _log = scheduler.review_card(fsrs_card, r)
            apply_fsrs_to_db(card_row, updated_card)

            word.last_reviewed_at = now
            if r == Rating.Again:
                word.wrong_count += 1
                session.add(Mistake(word_id=wid))
                needs_relearn.append(word)
            else:
                word.correct_count += 1

            session.add(SrsReviewLog(word_id=wid, rating=int(r.value), reviewed_at=now, duration_ms=None))
            reviewed.append({"word_id": wid, "term": str(word.term or ""), "rating": str(r.name)})

        score = f"{correct}/{len(questions)}"
        needs_relearn.sort(key=lambda w: (w.wrong_count, str(w.term or "")), reverse=True)

        return templates.TemplateResponse(
            request,
            "simulation_result.html",
            {
                "sim": row,
                "graded": graded,
                "score": score,
                "reviewed": reviewed,
                "needs_relearn": needs_relearn,
                "level_guide": LEVEL_GUIDE,
            },
        )
