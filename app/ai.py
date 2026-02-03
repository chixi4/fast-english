from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any, AsyncIterator

import httpx
from pydantic import ValidationError

from app.ai_types import GeneratedSimulation
from app.config import Settings


LEVEL_GUIDE: dict[str, str] = {
    "junior": "初中：220-320词，3-4段；句式简单，尽量少从句。",
    "senior": "高中：300-420词，4-5段；允许适量从句与转折。",
    "cet4": "四级：360-520词，4-6段；中等难度阅读风格，包含少量长句。",
    "cet6": "六级：480-680词，5-7段；更学术/新闻风格，包含更多长难句。",
    "kaoyan": "考研：600-820词，6-8段；信息密度更高，长难句占比更高。",
}

# Short Chinese labels for UI (keys remain stable for backend).
LEVEL_LABELS: dict[str, str] = {
    "junior": "初中",
    "senior": "高中",
    "cet4": "四级",
    "cet6": "六级",
    "kaoyan": "考研",
}


def _safe_json_extract(text: str) -> str:
    text = text.strip()
    if text.startswith("{") and text.endswith("}"):
        return text
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start : end + 1]
    raise ValueError("Model output does not contain a JSON object.")


def _contains_all_terms(passage: str, terms: list[str]) -> tuple[bool, list[str]]:
    missing: list[str] = []
    for term in terms:
        # If term contains non-word chars (space, hyphen, etc.), fall back to substring match.
        # Otherwise, use word-boundary match to avoid "at" matching "cat".
        if re.search(r"[^\w]", term):
            found = term.lower() in passage.lower()
        else:
            found = re.search(rf"\\b{re.escape(term)}\\b", passage, flags=re.IGNORECASE) is not None
        if not found:
            missing.append(term)
    return (len(missing) == 0, missing)


class MissingTermsError(RuntimeError):
    def __init__(self, missing: list[str]):
        super().__init__(f"Generated passage missing target terms: {', '.join(missing)}")
        self.missing = missing


@dataclass(frozen=True)
class AiClient:
    settings: Settings

    async def _chat_completions(self, payload: dict[str, Any]) -> str:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                f"{self.settings.ai_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.settings.ai_api_key}"},
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
        return data["choices"][0]["message"]["content"]

    async def chat_completions_content_stream(self, payload: dict[str, Any]) -> AsyncIterator[str]:
        stream_payload = {**payload, "stream": True}
        timeout = httpx.Timeout(300.0, connect=15.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                f"{self.settings.ai_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.settings.ai_api_key}"},
                json=stream_payload,
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choice0 = (obj.get("choices") or [{}])[0] or {}
                    delta = choice0.get("delta") or {}
                    content = delta.get("content")
                    if content is None:
                        msg = choice0.get("message") or {}
                        content = msg.get("content")
                    if content:
                        yield content

    def build_simulation_payload(
        self,
        *,
        level: str,
        terms: list[str],
        term_notes: dict[str, str],
        passage_word_range: tuple[int, int] | None = None,
        paragraph_range: tuple[int, int] | None = None,
        question_count: int = 6,
    ) -> tuple[dict[str, Any], str, str]:
        guide = LEVEL_GUIDE.get(level, LEVEL_GUIDE["cet4"])
        vocab_lines = []
        for t in terms:
            note = term_notes.get(t, "").strip()
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
                    "type": "vocab_in_context|cloze|main_idea|detail|inference",
                    "stem": "string",
                    "choices": ["A ...", "B ...", "C ...", "D ..."],
                    "answer_index": 0,
                    "explanation": "string",
                    "target_term": "string|null",
                }
            ],
        }

        system = (
            "你是英语考试出题老师。你只输出严格的JSON对象，不要输出Markdown，不要输出多余文本。"
            "确保JSON可被json.loads解析。"
        )

        length_hint = ""
        if passage_word_range is not None:
            lo, hi = passage_word_range
            if paragraph_range is None:
                paragraph_range = (4, 6)
            p_lo, p_hi = paragraph_range
            length_hint = f"短文长度（不含题目与选项）：约 {lo}-{hi} 词，分成 {p_lo}-{p_hi} 段。"

        user = f"""
请用下面这组目标词写一篇短文，并基于短文出题（阅读理解 + 词汇题混合）。

难度：{guide}
硬性要求：
0) {length_hint if length_hint else "短文长度要符合该难度常见阅读材料长度，段落分明。"}
1) 短文必须自然包含每个目标词（大小写不敏感），不要生硬堆砌。
2) 目标词在短文中出现时，必须用特殊标记包起来：[[目标词]]。例如目标词是 above，则短文中写成 [[above]]。
   注意：必须使用目标词的原形拼写（与目标词列表一致，只允许大小写不同），不要使用变形（如复数/过去式/ing）。
2) 词汇题必须让学生在语境中判断含义/用法（不是死记硬背释义）。
3) 题目总数 = {question_count}，每题4个选项（choices长度=4），answer_index为0-3。
4) 每题给1-2句话的explanation。
5) 输出JSON结构参考（字段一致即可，内容自行生成）：
{json.dumps(schema_hint, ensure_ascii=False)}

目标词（含释义/备注）：
{vocab_block}
""".strip()

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        payload: dict[str, Any] = {
            "model": self.settings.ai_writer_model or self.settings.ai_model,
            "messages": messages,
            "temperature": 0.6,
        }
        return payload, system, user

    async def generate_simulation(
        self,
        *,
        level: str,
        terms: list[str],
        term_notes: dict[str, str],
        passage_word_range: tuple[int, int] | None = None,
        paragraph_range: tuple[int, int] | None = None,
        question_count: int = 6,
    ) -> GeneratedSimulation:
        if self.settings.ai_mock:
            return _mock_simulation(
                level=level,
                terms=terms,
                question_count=question_count,
                passage_word_range=passage_word_range,
                paragraph_range=paragraph_range,
            )
        if not self.settings.ai_api_key:
            raise RuntimeError("Missing AI_API_KEY (or set AI_MOCK=1).")

        payload, system, user = self.build_simulation_payload(
            level=level,
            terms=terms,
            term_notes=term_notes,
            passage_word_range=passage_word_range,
            paragraph_range=paragraph_range,
            question_count=question_count,
        )

        last_err: Exception | None = None
        for attempt in range(1, 4):
            try:
                text = await self._chat_completions(payload)
                json_text = _safe_json_extract(text)
                parsed = GeneratedSimulation.model_validate(json.loads(json_text))
                return parsed
            except (ValueError, json.JSONDecodeError, ValidationError, RuntimeError) as e:
                last_err = e
                payload = {
                    **payload,
                    "messages": [
                        {"role": "system", "content": system},
                        {
                            "role": "user",
                            "content": (
                                "上一次输出不符合要求（JSON不可解析）。"
                                "请严格输出可解析的JSON，并遵守所有硬性要求。"
                                "只输出JSON，不要多余文本。"
                            ),
                        },
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.4,
                }
                continue

        raise RuntimeError(f"AI generation failed after retries: {last_err}") from last_err


def _mock_simulation(
    *,
    level: str,
    terms: list[str],
    question_count: int,
    passage_word_range: tuple[int, int] | None = None,
    paragraph_range: tuple[int, int] | None = None,
) -> GeneratedSimulation:
    passage_terms = ", ".join(terms)
    base = (
        f"This is a MOCK passage for level={level}. "
        f"It includes the target words: {passage_terms}. "
        "Read carefully and answer the questions. "
    )
    target_len = 260
    if question_count >= 9:
        target_len = 520
    if question_count >= 10:
        target_len = 680

    if passage_word_range is not None:
        lo, hi = passage_word_range
        target_len = max(target_len, int((lo + hi) / 2))

    words = base.split()
    while len(words) < target_len:
        words.extend(base.split())
    passage = " ".join(words[:target_len])
    questions = []
    for i in range(question_count):
        t = terms[i % len(terms)] if terms else None
        choices = [f"Option {c}" for c in ["A", "B", "C", "D"]]
        questions.append(
            {
                "id": f"q{i+1}",
                "type": "vocab_in_context" if t else "main_idea",
                "stem": f"(MOCK) Question {i+1} about {t or 'the passage'}",
                "choices": choices,
                "answer_index": 0,
                "explanation": "MOCK explanation.",
                "target_term": t,
            }
        )
    return GeneratedSimulation.model_validate({"passage": passage, "questions": questions})
