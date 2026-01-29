from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any

import httpx
from pydantic import ValidationError

from app.ai_types import GeneratedSimulation
from app.config import Settings


LEVEL_GUIDE: dict[str, str] = {
    "junior": "初中：120-180词，句式简单，尽量少从句。",
    "senior": "高中：180-260词，允许适量从句与转折。",
    "cet4": "四级：220-320词，中等难度阅读风格，包含1-2个长句。",
    "cet6": "六级：280-420词，更学术/新闻风格，包含多个长难句。",
    "kaoyan": "考研：350-520词，更密集信息与抽象表达，长难句占比更高。",
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

    async def generate_simulation(
        self,
        *,
        level: str,
        terms: list[str],
        term_notes: dict[str, str],
        question_count: int = 6,
    ) -> GeneratedSimulation:
        if self.settings.ai_mock:
            return _mock_simulation(level=level, terms=terms, question_count=question_count)
        if not self.settings.ai_api_key:
            raise RuntimeError("Missing AI_API_KEY (or set AI_MOCK=1).")

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
        user = f"""
请用下面这组目标词写一篇短文，并基于短文出题（阅读理解 + 词汇题混合）。

难度：{guide}
硬性要求：
1) 短文必须自然包含每个目标词（大小写不敏感），不要生硬堆砌。
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
            "model": self.settings.ai_model,
            "messages": messages,
            "temperature": 0.6,
        }

        last_err: Exception | None = None
        last_parsed: GeneratedSimulation | None = None
        last_missing: list[str] | None = None
        for attempt in range(1, 4):
            try:
                text = await self._chat_completions(payload)
                json_text = _safe_json_extract(text)
                parsed = GeneratedSimulation.model_validate(json.loads(json_text))

                ok, missing = _contains_all_terms(parsed.passage, terms)
                if not ok:
                    last_parsed = parsed
                    last_missing = missing
                    raise MissingTermsError(missing)
                return parsed
            except MissingTermsError as e:
                last_err = e
                missing_list = ", ".join(e.missing)
                payload = {
                    **payload,
                    "messages": [
                        {"role": "system", "content": system},
                        {
                            "role": "user",
                            "content": (
                                "You omitted some target terms in the passage. "
                                "Regenerate and ensure these terms appear verbatim (exact spelling) "
                                f"in the passage body: {missing_list}. "
                                "Output only valid JSON."
                            ),
                        },
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.2,
                }
                continue
            except (ValueError, json.JSONDecodeError, ValidationError, RuntimeError) as e:
                last_err = e
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

        # Fallback: if we successfully parsed but the model keeps omitting target terms,
        # patch the passage to include the missing terms so the user can proceed.
        if last_parsed is not None and last_missing:
            patched = last_parsed.model_copy(deep=True)
            patched.passage = patched.passage.rstrip() + "\n\nKey words (added): " + ", ".join(last_missing) + "."
            return patched

        raise RuntimeError(f"AI generation failed after retries: {last_err}") from last_err


def _mock_simulation(*, level: str, terms: list[str], question_count: int) -> GeneratedSimulation:
    passage_terms = ", ".join(terms)
    passage = (
        f"This is a MOCK passage for level={level}. "
        f"It includes the target words: {passage_terms}. "
        "Read carefully and answer the questions."
    )
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
