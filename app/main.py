from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fsrs import Rating
from sqlalchemy import func
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.ai import AiClient, LEVEL_GUIDE
from app.config import get_settings
from app.db import get_session, init_db
from app.models import Deck, DeckWord, Mistake, Simulation, SrsCard, SrsReviewLog, Word
from app.srs import apply_fsrs_to_db, db_card_to_fsrs, get_scheduler, parse_rating
from app.wordbooks import get_source, list_sources, load_rows


load_dotenv()
init_db()

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

app = FastAPI(title="Vocabulary Study MVP")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


def _redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url=url, status_code=303)


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


def _bootstrap_srs_cards() -> None:
    # Create SRS cards for existing words from older DBs.
    with get_session() as session:
        missing_ids = (
            session.query(Word.id)
            .outerjoin(SrsCard, SrsCard.word_id == Word.id)
            .filter(SrsCard.word_id.is_(None))
            .all()
        )
        for (wid,) in missing_ids:
            session.add(SrsCard(word_id=wid, due_at=_utcnow()))


_bootstrap_srs_cards()


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
        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        word_count = int(session.query(Word).count())
        deck_count = int(session.query(Deck).count())

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
            "deck_id": deck_id,
            "deck_count": deck_count,
            "word_count": word_count,
            "total": total,
            "due_count": due_count,
            "new_count": new_count,
            "est_minutes": est_minutes,
            "mistake_count": mistake_count,
            "sim_count": sim_count,
            "toast": (toast or "").strip(),
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
def settings_page(request: Request):
    s = get_settings()
    ai_status = "Mock（离线演示）" if s.ai_mock else ("已配置" if s.ai_api_key else "未配置")
    with get_session() as session:
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
        },
    )


@app.get("/decks", response_class=HTMLResponse)
def list_decks(request: Request):
    now = _utcnow()
    with get_session() as session:
        decks = session.query(Deck).order_by(Deck.name.asc()).all()
        word_counts = dict(
            session.query(DeckWord.deck_id, func.count(DeckWord.word_id)).group_by(DeckWord.deck_id).all()
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
        items.append(
            {
                "deck": d,
                "word_count": int(word_counts.get(d.id, 0)),
                "due_count": int(due_counts.get(d.id, 0)),
                "new_count": int(new_counts.get(d.id, 0)),
            }
        )
    return templates.TemplateResponse(request, "decks.html", {"items": items})


@app.post("/decks")
def create_deck(name: str = Form(...), description: str = Form("")):
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    with get_session() as session:
        exists = session.query(Deck).filter(Deck.name == name).first()
        if exists:
            raise HTTPException(status_code=400, detail="这个词书已存在")
        session.add(Deck(name=name, description=description.strip()))
    return _redirect("/decks")


@app.post("/decks/{deck_id}/delete")
def delete_deck(deck_id: int):
    with get_session() as session:
        deck = session.get(Deck, deck_id)
        if not deck:
            raise HTTPException(status_code=404, detail="not found")
        session.delete(deck)
    return _redirect("/decks")


@app.get("/decks/{deck_id}", response_class=HTMLResponse)
def deck_detail(request: Request, deck_id: int):
    now = _utcnow()
    with get_session() as session:
        deck = session.get(Deck, deck_id)
        if not deck:
            raise HTTPException(status_code=404, detail="not found")
        rows = (
            session.query(DeckWord, Word, SrsCard)
            .join(Word, Word.id == DeckWord.word_id)
            .join(SrsCard, SrsCard.word_id == Word.id)
            .filter(DeckWord.deck_id == deck_id)
            .order_by(SrsCard.due_at.asc(), Word.term.asc())
            .limit(300)
            .all()
        )
        due_count = (
            session.query(func.count(SrsCard.word_id))
            .join(DeckWord, DeckWord.word_id == SrsCard.word_id)
            .filter(DeckWord.deck_id == deck_id, SrsCard.due_at <= now)
            .scalar()
        )
    items = [{"link": dw, "word": w, "card": c} for (dw, w, c) in rows]
    return templates.TemplateResponse(
        request,
        "deck_detail.html",
        {"deck": deck, "items": items, "due_count": int(due_count or 0), "state_map": {1: "Learning", 2: "Review", 3: "Relearning"}},
    )


@app.get("/library", response_class=HTMLResponse)
def wordbook_library(request: Request):
    sources = list_sources()
    return templates.TemplateResponse(request, "library.html", {"sources": sources})


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
) -> tuple[int, int, int, int, list[str]]:
    inserted = 0
    updated = 0
    linked = 0
    skipped = 0

    on_conflict = (on_conflict or "skip").strip().lower()
    if on_conflict not in {"skip", "update"}:
        raise HTTPException(status_code=400, detail="on_conflict must be skip|update")

    with get_session() as session:
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
                        _ensure_srs_card(session, word.id)
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
                        _ensure_srs_card(session, word.id)
                        updated += 1
                except Exception as e:
                    errors.append(f"Row {idx}: failed to import '{term}': {e}")
                    continue

            deck_n = (r.get("deck") or "").strip()
            if deck_n and word is not None:
                try:
                    deck = deck_cache.get(deck_n)
                    if deck is None:
                        deck = _ensure_deck(session, deck_n)
                        deck_cache[deck_n] = deck
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
        _ensure_srs_card(session, word.id)
        if deck_name.strip():
            deck = _ensure_deck(session, deck_name)
            link = session.query(DeckWord).filter(DeckWord.deck_id == deck.id, DeckWord.word_id == word.id).first()
            if not link:
                session.add(DeckWord(deck_id=deck.id, word_id=word.id, chapter=chapter.strip()))
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

    # Dedupe (keep first occurrence)
    deduped: dict[str, dict[str, str]] = {}
    for r in rows:
        term = (r.get("term") or "").strip()
        if not term:
            continue
        key = term.lower()
        if key not in deduped:
            deduped[key] = r
    rows = list(deduped.values())

    inserted = 0
    updated = 0
    linked = 0
    skipped = 0
    errors: list[str] = list(parse_errors)

    on_conflict = (on_conflict or "skip").strip().lower()
    if on_conflict not in {"skip", "update"}:
        raise HTTPException(status_code=400, detail="on_conflict must be skip|update")

    with get_session() as session:
        terms = [(r.get("term") or "").strip() for r in rows if (r.get("term") or "").strip()]
        terms_lower = [t.lower() for t in terms]
        existing_terms = [t for (t,) in session.query(Word.term).filter(func.lower(Word.term).in_(terms_lower)).all()]
        existing_lower = {t.lower(): t for t in existing_terms}

        deck_cache: dict[str, Deck] = {}

        for idx, r in enumerate(rows, start=1):
            term = (r.get("term") or "").strip()
            if not term:
                errors.append(f"第{idx}条：term为空")
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
                        _ensure_srs_card(session, word.id)
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
                        _ensure_srs_card(session, word.id)
                        updated += 1
                except Exception as e:
                    errors.append(f"第{idx}条：{term} 导入失败：{e}")
                    continue

            # Link to deck (optional)
            deck_n = (r.get("deck") or "").strip()
            if deck_n and word is not None:
                try:
                    deck = deck_cache.get(deck_n)
                    if deck is None:
                        deck = _ensure_deck(session, deck_n)
                        deck_cache[deck_n] = deck
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
                    errors.append(f"第{idx}条：{term} 关联词书失败：{e}")

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
def review(request: Request, deck_id: int | None = None):
    if deck_id == 0:
        deck_id = None
    now = _utcnow()
    with get_session() as session:
        decks = session.query(Deck).order_by(Deck.name.asc()).all()

        base_q = session.query(Word, SrsCard).join(SrsCard, SrsCard.word_id == Word.id)
        if deck_id is not None:
            base_q = (
                base_q.join(DeckWord, DeckWord.word_id == Word.id)
                .filter(DeckWord.deck_id == deck_id)
            )

        due_q = base_q.filter(SrsCard.due_at <= now)
        due_pair = due_q.order_by(SrsCard.due_at.asc(), Word.term.asc()).first()
        due_count = int(due_q.count())
        total = int(base_q.count())

        next_pair = base_q.filter(SrsCard.due_at > now).order_by(SrsCard.due_at.asc()).first()
        next_due_at = next_pair[1].due_at if next_pair else None

        word = due_pair[0] if due_pair else None
        card = due_pair[1] if due_pair else None
        chapter = ""
        if word is not None and deck_id is not None:
            link = session.query(DeckWord).filter(DeckWord.deck_id == deck_id, DeckWord.word_id == word.id).first()
            chapter = link.chapter if link else ""

    return templates.TemplateResponse(
        request,
        "review.html",
        {
            "word": word,
            "card": card,
            "chapter": chapter,
            "decks": decks,
            "deck_id": deck_id,
            "due_count": due_count,
            "total": total,
            "next_due_at": next_due_at,
            "state_map": {1: "Learning", 2: "Review", 3: "Relearning"},
        },
    )


@app.post("/review/{word_id}")
def submit_review(
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

    if deck_id is not None:
        return _redirect(f"/review?deck_id={deck_id}")
    return _redirect("/review")


@app.get("/mistakes", response_class=HTMLResponse)
def mistakes(request: Request):
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
        {"items": items, "levels": list(LEVEL_GUIDE.keys()), "level_guide": LEVEL_GUIDE},
    )


@app.post("/simulations/generate")
async def generate_simulation(
    request: Request,
    level: str = Form(...),
    word_ids: str = Form(""),
):
    ids = [int(x) for x in word_ids.split(",") if x.strip().isdigit()]
    ids = list(dict.fromkeys(ids))  # dedupe keep order
    if not ids:
        raise HTTPException(status_code=400, detail="请选择至少1个错词")

    with get_session() as session:
        words = session.query(Word).filter(Word.id.in_(ids)).all()
    if not words:
        raise HTTPException(status_code=404, detail="words not found")

    terms = [w.term for w in words]
    term_notes = {w.term: (w.definition or w.example or "").strip() for w in words}

    settings = get_settings()
    client = AiClient(settings=settings)
    sim = await client.generate_simulation(level=level, terms=terms, term_notes=term_notes, question_count=6)

    with get_session() as session:
        row = Simulation(
            level=level,
            target_terms_json=json.dumps(terms, ensure_ascii=False),
            passage=sim.passage,
            questions_json=sim.model_dump_json(ensure_ascii=False),
        )
        session.add(row)
        session.flush()
        sim_id = row.id
    return _redirect(f"/simulations/{sim_id}")


@app.get("/simulations/{sim_id}", response_class=HTMLResponse)
def show_simulation(request: Request, sim_id: int):
    with get_session() as session:
        row = session.get(Simulation, sim_id)
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    payload = json.loads(row.questions_json)
    questions = payload["questions"]
    return templates.TemplateResponse(
        request,
        "simulation.html",
        {
            "sim": row,
            "questions": questions,
            "level_guide": LEVEL_GUIDE,
        },
    )


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
