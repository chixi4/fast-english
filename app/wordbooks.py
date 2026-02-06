from __future__ import annotations

import asyncio
import csv
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx


@dataclass(frozen=True)
class WordbookSource:
    id: str
    name: str
    description: str
    homepage: str
    license: str
    url: str
    kind: str  # "plain_words" | "ecdict_tag" | "generated_subset"
    default_deck: str
    default_tags: str = ""
    config: dict[str, Any] = field(default_factory=dict)


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def cache_dir() -> Path:
    p = _repo_root() / "data" / "wordbooks-cache"
    p.mkdir(parents=True, exist_ok=True)
    return p


def list_sources() -> list[WordbookSource]:
    ecdict_home = "https://github.com/skywind3000/ECDICT"
    ecdict_license = "MIT (skywind3000/ECDICT)"
    ecdict_csv = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"

    hf_home = "https://github.com/arstgit/high-frequency-vocabulary"
    hf_license = "MIT (arstgit/high-frequency-vocabulary)"

    return [
        # Generated subsets (MIT-derived, non-official): use HF lists + fill definitions from ECDICT
        WordbookSource(
            id="gen_primary_1200",
            name="小学核心词汇（高频精选 1200）",
            description="基于 高频10k 取前1200，并用 ECDICT 补全释义（非官方词表）",
            homepage=hf_home,
            license=f"MIT（派生自 {hf_home} + {ecdict_home}）",
            url="https://raw.githubusercontent.com/arstgit/high-frequency-vocabulary/master/10k.txt",
            kind="generated_subset",
            default_deck="小学核心词汇（高频精选）",
            default_tags="primary, frequency, generated",
            config={"base_source_id": "hf_10k", "top_n": 1200, "fill_ecdict": True},
        ),
        WordbookSource(
            id="gen_xsc_2000",
            name="小升初/初中基础（高频精选 2000）",
            description="基于 高频10k 取前2000，并用 ECDICT 补全释义（非官方词表）",
            homepage=hf_home,
            license=f"MIT（派生自 {hf_home} + {ecdict_home}）",
            url="https://raw.githubusercontent.com/arstgit/high-frequency-vocabulary/master/10k.txt",
            kind="generated_subset",
            default_deck="小升初/初中基础（高频精选）",
            default_tags="junior, frequency, generated",
            config={"base_source_id": "hf_10k", "top_n": 2000, "fill_ecdict": True},
        ),
        WordbookSource(
            id="gen_ket_1800",
            name="KET 词汇（高频建议 1800）",
            description="基于 高频10k 取前1800，并用 ECDICT 补全释义（非官方建议）",
            homepage=hf_home,
            license=f"MIT（派生自 {hf_home} + {ecdict_home}）",
            url="https://raw.githubusercontent.com/arstgit/high-frequency-vocabulary/master/10k.txt",
            kind="generated_subset",
            default_deck="KET 词汇（高频建议）",
            default_tags="ket, frequency, generated",
            config={"base_source_id": "hf_10k", "top_n": 1800, "fill_ecdict": True},
        ),
        WordbookSource(
            id="gen_pet_3500",
            name="PET 词汇（高频建议 3500）",
            description="基于 高频30k 取前3500，并用 ECDICT 补全释义（非官方建议）",
            homepage=hf_home,
            license=f"MIT（派生自 {hf_home} + {ecdict_home}）",
            url="https://raw.githubusercontent.com/arstgit/high-frequency-vocabulary/master/30k.txt",
            kind="generated_subset",
            default_deck="PET 词汇（高频建议）",
            default_tags="pet, frequency, generated",
            config={"base_source_id": "hf_30k", "top_n": 3500, "fill_ecdict": True},
        ),
        # ECDICT tag-based packs
        WordbookSource(
            id="ecdict_zk",
            name="中考词汇（ECDICT）",
            description="从 ECDICT 的 tag=zk 生成（中考/初中常见）",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="中考词汇（ECDICT）",
            default_tags="zk, ECDICT",
            config={"tag": "zk"},
        ),
        WordbookSource(
            id="ecdict_gk",
            name="高考词汇（ECDICT）",
            description="从 ECDICT 的 tag=gk 生成（高考/高中常见）",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="高考词汇（ECDICT）",
            default_tags="gk, ECDICT",
            config={"tag": "gk"},
        ),
        WordbookSource(
            id="ecdict_cet4",
            name="四级词汇（ECDICT）",
            description="从 ECDICT 的 tag=cet4 生成",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="四级词汇（ECDICT）",
            default_tags="cet4, ECDICT",
            config={"tag": "cet4"},
        ),
        WordbookSource(
            id="ecdict_cet6",
            name="六级词汇（ECDICT）",
            description="从 ECDICT 的 tag=cet6 生成",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="六级词汇（ECDICT）",
            default_tags="cet6, ECDICT",
            config={"tag": "cet6"},
        ),
        WordbookSource(
            id="ecdict_ky",
            name="考研词汇（ECDICT）",
            description="从 ECDICT 的 tag=ky 生成（考研）",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="考研词汇（ECDICT）",
            default_tags="ky, ECDICT",
            config={"tag": "ky"},
        ),
        WordbookSource(
            id="ecdict_ielts",
            name="IELTS（ECDICT）",
            description="从 ECDICT 的 tag=ielts 生成",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="IELTS（ECDICT）",
            default_tags="ielts, ECDICT",
            config={"tag": "ielts"},
        ),
        WordbookSource(
            id="ecdict_toefl",
            name="TOEFL（ECDICT）",
            description="从 ECDICT 的 tag=toefl 生成",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="TOEFL（ECDICT）",
            default_tags="toefl, ECDICT",
            config={"tag": "toefl"},
        ),
        WordbookSource(
            id="ecdict_gre",
            name="GRE（ECDICT）",
            description="从 ECDICT 的 tag=gre 生成",
            homepage=ecdict_home,
            license=ecdict_license,
            url=ecdict_csv,
            kind="ecdict_tag",
            default_deck="GRE（ECDICT）",
            default_tags="gre, ECDICT",
            config={"tag": "gre"},
        ),
        # Other open word lists
        WordbookSource(
            id="hf_10k",
            name="高频 10k（arstgit）",
            description="一行一个词（Top 10k）",
            homepage=hf_home,
            license=hf_license,
            url="https://raw.githubusercontent.com/arstgit/high-frequency-vocabulary/master/10k.txt",
            kind="plain_words",
            default_deck="高频 10k（arstgit）",
            default_tags="frequency, 10k",
            config={"split_slash": False},
        ),
        WordbookSource(
            id="hf_30k",
            name="高频 30k（arstgit）",
            description="一行一个词（Top 30k）",
            homepage=hf_home,
            license=hf_license,
            url="https://raw.githubusercontent.com/arstgit/high-frequency-vocabulary/master/30k.txt",
            kind="plain_words",
            default_deck="高频 30k（arstgit）",
            default_tags="frequency, 30k",
            config={"split_slash": False},
        ),
    ]


def get_source(source_id: str) -> WordbookSource:
    for s in list_sources():
        if s.id == source_id:
            return s
    raise KeyError(f"Unknown wordbook source: {source_id}")


async def _download_with_retries(*, url: str, path: Path, max_attempts: int = 4) -> Path:
    last_err: Exception | None = None
    backoff = 0.6
    for attempt in range(1, max_attempts + 1):
        try:
            tmp = path.with_suffix(path.suffix + ".tmp")
            async with httpx.AsyncClient(timeout=90.0, follow_redirects=True) as client:
                async with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    with tmp.open("wb") as f:
                        async for chunk in resp.aiter_bytes():
                            if chunk:
                                f.write(chunk)
            tmp.replace(path)
            return path
        except Exception as e:
            last_err = e
            if attempt >= max_attempts:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 8.0)
    raise RuntimeError(f"Failed to download after {max_attempts} attempts: {url} ({last_err})") from last_err


async def ensure_cached(source: WordbookSource, *, force: bool = False) -> Path:
    cdir = cache_dir()
    if source.kind == "ecdict_tag":
        # Shared cache file across all ECDICT tag packs
        path = cdir / "ecdict.csv"
    else:
        suffix = ".txt"
        if source.url.lower().endswith(".csv"):
            suffix = ".csv"
        elif source.url.lower().endswith(".json"):
            suffix = ".json"
        path = cdir / f"{source.id}{suffix}"

    if not force and path.exists() and path.stat().st_size > 0:
        return path

    return await _download_with_retries(url=source.url, path=path)


def _row_template() -> dict[str, str]:
    return {
        "term": "",
        "definition": "",
        "example": "",
        "tags": "",
        "deck": "",
        "chapter": "",
        "position": "",
    }


def _parse_plain_words(text: str, *, split_slash: bool) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    pos = 0
    for raw in text.splitlines():
        line = (raw or "").strip()
        if not line:
            continue
        if line.startswith("#") or line.startswith("//"):
            continue
        # If the file contains extra columns, keep the first token as the term.
        for sep in ["\t", " "]:
            if sep in line:
                line = line.split(sep, 1)[0].strip()
        if not line:
            continue

        terms = [line]
        if split_slash and "/" in line and len(line) <= 30:
            parts = [p.strip() for p in line.split("/") if p.strip()]
            if parts:
                terms = parts

        for t in terms:
            out = _row_template()
            out["term"] = t
            out["position"] = str(pos + 1)
            rows.append(out)
            pos += 1
    return rows


def _iter_ecdict_tag_rows(path: Path, *, tag: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    pos = 0
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tags = (row.get("tag") or "").split()
            if tag not in tags:
                continue
            term = (row.get("word") or "").strip()
            if not term:
                continue
            phonetic = (row.get("phonetic") or "").strip()
            translation = (row.get("translation") or "").strip()
            definition = (row.get("definition") or "").strip()
            meaning = translation or definition
            if phonetic:
                meaning = f"/{phonetic}/ {meaning}" if meaning else f"/{phonetic}/"

            out = _row_template()
            out["term"] = term
            out["definition"] = meaning
            out["tags"] = tag
            out["position"] = str(pos + 1)
            rows.append(out)
            pos += 1
    return rows


def _format_ecdict_meaning(row: dict[str, str]) -> str:
    phonetic = (row.get("phonetic") or "").strip()
    translation = (row.get("translation") or "").strip()
    definition = (row.get("definition") or "").strip()
    meaning = translation or definition
    if phonetic:
        meaning = f"/{phonetic}/ {meaning}" if meaning else f"/{phonetic}/"
    return meaning


def _ecdict_meaning_by_term(path: Path, terms: list[str]) -> tuple[dict[str, str], list[str]]:
    need = {(t or "").strip().lower() for t in terms if (t or "").strip()}
    out: dict[str, str] = {}
    warnings: list[str] = []

    if not need:
        return out, warnings

    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            term = (row.get("word") or "").strip()
            if not term:
                continue
            key = term.lower()
            if key not in need or key in out:
                continue
            out[key] = _format_ecdict_meaning(row)
            if len(out) >= len(need):
                break

    missing = [t for t in terms if (t or "").strip() and (t.strip().lower() not in out)]
    if missing:
        warnings.append(f"ECDICT 未找到释义：{len(missing)} 个（例如：{', '.join(missing[:6])}）")
    return out, warnings


async def load_rows(source: WordbookSource, *, force_download: bool = False) -> tuple[list[dict[str, str]], list[str]]:
    """
    Returns (rows, warnings). Rows are compatible with /words/import internal structure.
    """
    warnings: list[str] = []

    if source.kind == "generated_subset":
        base_id = str(source.config.get("base_source_id") or "").strip()
        top_n = int(source.config.get("top_n") or 0)
        top_n = max(1, min(top_n, 50000))
        if not base_id:
            raise ValueError("generated_subset: base_source_id missing in source config")

        try:
            base = get_source(base_id)
        except KeyError as e:
            raise ValueError(f"generated_subset: unknown base_source_id={base_id}") from e

        base_path = await ensure_cached(base, force=force_download)
        text = await asyncio.to_thread(base_path.read_text, encoding="utf-8-sig", errors="replace")
        base_rows = await asyncio.to_thread(
            _parse_plain_words,
            text,
            split_slash=bool(base.config.get("split_slash")),
        )
        terms = [str(r.get("term") or "").strip() for r in base_rows if str(r.get("term") or "").strip()][:top_n]

        # Fill definitions from ECDICT (MIT). Best-effort: if ECDICT cache is missing, it will be downloaded once.
        ecdict_stub = get_source("ecdict_zk")
        ecdict_path = await ensure_cached(ecdict_stub, force=force_download)
        meaning_map, w2 = await asyncio.to_thread(_ecdict_meaning_by_term, ecdict_path, terms)
        warnings.extend(w2)

        rows: list[dict[str, str]] = []
        for i, t in enumerate(terms, start=1):
            out = _row_template()
            out["term"] = t
            out["definition"] = meaning_map.get(t.lower(), "")
            out["position"] = str(i)
            rows.append(out)
        if not rows:
            warnings.append("generated_subset produced 0 rows.")
        return rows, warnings

    path = await ensure_cached(source, force=force_download)

    if source.kind == "plain_words":
        text = await asyncio.to_thread(path.read_text, encoding="utf-8-sig", errors="replace")
        rows = await asyncio.to_thread(_parse_plain_words, text, split_slash=bool(source.config.get("split_slash")))
        return rows, warnings

    if source.kind == "ecdict_tag":
        tag = str(source.config.get("tag") or "").strip()
        if not tag:
            raise ValueError("ECDICT tag missing in source config")
        rows = await asyncio.to_thread(_iter_ecdict_tag_rows, path, tag=tag)
        if not rows:
            warnings.append(f"ECDICT tag='{tag}' produced 0 rows (dataset may have changed).")
        return rows, warnings

    raise ValueError(f"Unknown source kind: {source.kind}")
