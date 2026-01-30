from __future__ import annotations

import asyncio
import base64
import binascii
from datetime import datetime, timedelta
import hmac
import html
import json
import os
import time
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlencode

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

from app.ai import AiClient, LEVEL_GUIDE, _safe_json_extract
from app.ai_types import GeneratedSimulation
from app.auth import decode_session, encode_session, hash_password, new_session_for_user, verify_password
from app.auth_db import get_auth_session, init_auth_db
from app.auth_models import AuthEvent, AuthUser
from app.config import get_settings
from app.db import get_session, init_db
from app.models import Deck, DeckWord, Mistake, Plan, PlanDeck, PlanWord, Simulation, SrsCard, SrsReviewLog, Word
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
        return str(max(css_v, js_v))
    except Exception:
        return "0"

templates.env.globals["static_v"] = _static_v

app = FastAPI(title="Vocabulary Study MVP")
app.add_middleware(GZipMiddleware, minimum_size=500)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


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


def _clear_session_cookie(resp: Response) -> None:
    settings = get_settings()
    resp.delete_cookie(settings.auth_cookie_name, path="/")


def _norm_username(username: str) -> tuple[str, str]:
    raw = (username or "").strip()
    return raw, raw.lower()


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
    if deck_id == 0:
        deck_id = None
    now = _utcnow()
    with get_session() as session:
        plan = _ensure_default_plan(session)
        daily_new_limit = int(plan.daily_new_limit or 20)
        daily_review_limit = int(plan.daily_review_limit or 200)
        suspend_new_when_due_over = int(plan.suspend_new_when_due_over or 200)
        quick_add_count = max(1, min(10, daily_new_limit))

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
        due_count = int(base_q.filter(SrsCard.due_at <= now).count())
        new_count = int(base_q.filter(SrsCard.last_reviewed_at.is_(None)).count())

        mistake_count = int(session.query(Mistake).count())
        sim_count = int(session.query(Simulation).count())

    est_minutes = max(1, int(round((due_count + min(new_count, 20)) * 0.25))) if total > 0 else 0

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
            "due_count": due_count,
            "new_count": new_count,
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


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, toast: str | None = None):
    s = get_settings()
    ai_status = "Mock（离线演示）" if s.ai_mock else ("已配置" if s.ai_api_key else "未配置")
    with get_session() as session:
        plan = _ensure_default_plan(session)
        word_count = int(session.query(Word).count())
        deck_count = int(session.query(Deck).count())
    return templates.TemplateResponse(
        request,
        "settings.html",
        {
            "ai_status": ai_status,
            "ai_base_url": s.ai_base_url,
            "ai_model": s.ai_model,
            "db_path": str(s.db_path),
            "word_count": word_count,
            "deck_count": deck_count,
            "plan_daily_new_limit": int(plan.daily_new_limit),
            "plan_daily_review_limit": int(plan.daily_review_limit),
            "plan_suspend_new_when_due_over": int(plan.suspend_new_when_due_over),
            "toast": (toast or "").strip(),
        },
    )


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
            due_total = int(session.query(func.count(SrsCard.word_id)).filter(SrsCard.due_at <= now).scalar() or 0)
            due_new = int(
                session.query(func.count(SrsCard.word_id))
                .filter(SrsCard.due_at <= now, SrsCard.last_reviewed_at.is_(None))
                .scalar()
                or 0
            )
            if suspend_over <= 0 or due_total <= suspend_over:
                need = max(0, new_limit - due_new)
                if need > 0:
                    planned_ids_subq = session.query(PlanWord.word_id).filter(PlanWord.plan_id == plan.id).subquery()
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
                        q = q.filter(~DeckWord.word_id.in_(planned_ids_subq))
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

    cutoff = _utcnow() - timedelta(days=days)

    with get_auth_session() as session:
        users = session.query(AuthUser).order_by(AuthUser.id.asc()).all()
        q = session.query(AuthEvent).filter(AuthEvent.created_at >= cutoff)
        if not is_admin and username_norm:
            q = q.filter(AuthEvent.username_norm == username_norm)
        events = q.order_by(AuthEvent.created_at.asc()).all()

    # Aggregate (keep it simple; this is MVP-sized data).
    per_user: dict[str, dict[str, Any]] = {}
    for u in users:
        per_user[u.username_norm] = {
            "username": u.username,
            "username_norm": u.username_norm,
            "page_views": 0,
            "actions": 0,
            "errors": 0,
            "last_seen": None,
        }

    daily: dict[str, int] = {}
    top_paths: dict[str, int] = {}
    actions: dict[str, int] = {}

    for ev in events:
        un = str(ev.username_norm or "")
        row = per_user.setdefault(
            un,
            {
                "username": un,
                "username_norm": un,
                "page_views": 0,
                "actions": 0,
                "errors": 0,
                "last_seen": None,
            },
        )
        row["last_seen"] = ev.created_at
        if ev.kind == "page_view":
            row["page_views"] += 1
            top_paths[ev.path] = top_paths.get(ev.path, 0) + 1
        elif ev.kind in {"action", "client", "api"}:
            row["actions"] += 1
            act = "action"
            try:
                meta = json.loads(ev.meta_json or "{}")
                if ev.kind == "action":
                    act = str(meta.get("action") or "action")
                elif ev.kind == "client":
                    evp = meta.get("ev") if isinstance(meta, dict) else None
                    t = (evp.get("t") if isinstance(evp, dict) else None) or "client"
                    act = f"client:{t}"
                else:
                    act = f"api:{ev.path}"
            except Exception:
                act = "action"
            actions[act] = actions.get(act, 0) + 1
        elif ev.kind == "error":
            row["errors"] += 1

        d = (ev.created_at.date().isoformat() if ev.created_at else "")
        if d:
            daily[d] = daily.get(d, 0) + 1

    max_views = max([v["page_views"] for v in per_user.values()] + [1])
    max_actions = max([v["actions"] for v in per_user.values()] + [1])

    user_rows = list(per_user.values())
    user_rows.sort(key=lambda r: (r["page_views"] + r["actions"], r["username_norm"]), reverse=True)

    daily_rows = [{"day": d, "count": daily[d]} for d in sorted(daily.keys())]
    top_path_rows = [{"path": p, "count": c} for p, c in sorted(top_paths.items(), key=lambda kv: kv[1], reverse=True)[:12]]
    action_rows = [{"action": a, "count": c} for a, c in sorted(actions.items(), key=lambda kv: kv[1], reverse=True)[:12]]

    return templates.TemplateResponse(
        request,
        "analytics.html",
        {
            "title": "交互报表",
            "days": days,
            "cutoff": cutoff,
            "is_admin": is_admin,
            "admin_hint_set": bool(admin_set),
            "current_user": username,
            "users": user_rows,
            "daily": daily_rows,
            "top_paths": top_path_rows,
            "actions": action_rows,
            "max_views": max_views,
            "max_actions": max_actions,
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
    return templates.TemplateResponse(request, "library.html", {"sources": sources})


def _add_next_words_to_plan(session, *, deck_id: int, count: int) -> tuple[str, int, int]:
    deck = session.get(Deck, deck_id)
    if not deck:
        raise HTTPException(status_code=404, detail="deck not found")

    plan = _ensure_default_plan(session)
    _ensure_plan_deck(session, plan, deck_id)

    planned_ids_subq = session.query(PlanWord.word_id).filter(PlanWord.plan_id == plan.id).subquery()
    rows = (
        session.query(DeckWord.word_id)
        .join(Word, Word.id == DeckWord.word_id)
        .filter(DeckWord.deck_id == deck_id, ~DeckWord.word_id.in_(planned_ids_subq))
        .order_by(DeckWord.position.asc(), Word.term.asc())
        .limit(count)
        .all()
    )
    word_ids = [int(wid) for (wid,) in rows]

    now = _utcnow()
    for wid in word_ids:
        _ensure_plan_word(session, plan, wid, deck_id)
        if session.get(SrsCard, wid) is None:
            session.add(SrsCard(word_id=wid, due_at=now))

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
    prefetch_limit = 120
    with get_session() as session:
        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        plan = _ensure_default_plan(session)

        if deck_id is None and decks:
            deck_id = int(decks[0].id)

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

        due_q = base_q.filter(SrsCard.due_at <= now).order_by(SrsCard.due_at.asc(), Word.term.asc())
        prefetch_rows: list[Any] = []
        if deck_id is not None:
            prefetch_rows = (
                session.query(Word, SrsCard, DeckWord.chapter)
                .join(SrsCard, SrsCard.word_id == Word.id)
                .join(DeckWord, DeckWord.word_id == Word.id)
                .filter(DeckWord.deck_id == deck_id)
                .filter(SrsCard.due_at <= now)
                .order_by(SrsCard.due_at.asc(), Word.term.asc())
                .limit(prefetch_limit)
                .all()
            )
        else:
            prefetch_rows = due_q.limit(prefetch_limit).all()

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
        due_count = int(due_count or 0)

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


@app.get("/mistakes", response_class=HTMLResponse)
def mistakes(
    request: Request,
    level: str | None = None,
    target_count: int | None = None,
    length_mode: str = "standard",
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

    selected_level = _norm_level(level)
    selected_length_mode = _norm_length_mode(length_mode)
    if target_count is None:
        selected_target_count = _default_k(selected_level)
    else:
        try:
            selected_target_count = int(target_count)
        except Exception:
            selected_target_count = _default_k(selected_level)
        selected_target_count = max(6, min(14, selected_target_count))

    with get_session() as session:
        # Get recent mistakes with word info (simple approach for MVP)
        rows = (
            session.query(Mistake, Word)
            .join(Word, Mistake.word_id == Word.id)
            .order_by(Mistake.id.desc())
            .limit(200)
            .all()
        )
    items = [{"mistake": m, "word": w} for (m, w) in rows]
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
            # Auto-pick from recent mistakes (dedupe by word_id, then prefer higher wrong_count)
            rows = (
                session.query(Mistake, Word)
                .join(Word, Mistake.word_id == Word.id)
                .order_by(Mistake.id.desc())
                .limit(600)
                .all()
            )
            latest: dict[int, tuple[Word, datetime]] = {}
            for m, w in rows:
                if w.id not in latest:
                    latest[w.id] = (w, m.created_at)

            candidates = list(latest.values())
            candidates.sort(key=lambda t: (t[0].wrong_count, t[1]), reverse=True)
            words = [w for (w, _ts) in candidates[:k]]

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
        row = Simulation(
            level=selected_level,
            target_terms_json=json.dumps(terms, ensure_ascii=False),
            passage=sim.passage,
            questions_json=sim.model_dump_json(ensure_ascii=False),
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
                    rows = (
                        session.query(Mistake, Word)
                        .join(Word, Mistake.word_id == Word.id)
                        .order_by(Mistake.id.desc())
                        .limit(600)
                        .all()
                    )
                    latest: dict[int, tuple[Word, datetime]] = {}
                    for m, w in rows:
                        if w.id not in latest:
                            latest[w.id] = (w, m.created_at)
                    candidates = list(latest.values())
                    candidates.sort(key=lambda t: (t[0].wrong_count, t[1]), reverse=True)
                    words = [w for (w, _ts) in candidates[:k]]
                    yield _note(
                        "word selection=auto "
                        f"scanned_rows={len(rows)} unique={len(candidates)} picked={len(words)} "
                        f"sort=(wrong_count,latest) dt={(time.perf_counter() - sel_t0) * 1000:.0f}ms"
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
                row = Simulation(
                    level=selected_level,
                    target_terms_json=json.dumps(terms, ensure_ascii=False),
                    passage=sim.passage,
                    questions_json=sim.model_dump_json(ensure_ascii=False),
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
    with get_session() as session:
        row = session.get(Simulation, sim_id)
    if not row:
        raise HTTPException(status_code=404, detail="not found")

    payload = json.loads(row.questions_json)
    questions: list[dict[str, Any]] = payload["questions"]

    form = await request.form()
    answers: dict[str, int] = {}
    for q in questions:
        qid = q["id"]
        raw = form.get(qid)
        if raw is None:
            continue
        try:
            answers[qid] = int(raw)
        except ValueError:
            continue

    graded = []
    correct = 0
    for q in questions:
        qid = q["id"]
        user_idx = answers.get(qid, -1)
        ok = user_idx == int(q["answer_index"])
        if ok:
            correct += 1
        graded.append({**q, "user_answer_index": user_idx, "is_correct": ok})

    score = f"{correct}/{len(questions)}"
    return templates.TemplateResponse(
        request,
        "simulation_result.html",
        {
            "sim": row,
            "graded": graded,
            "score": score,
            "level_guide": LEVEL_GUIDE,
        },
    )
