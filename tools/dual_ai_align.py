from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_utf8(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@dataclass(frozen=True)
class ChatModel:
    base_url: str
    api_key: str
    model: str

    def chat(self, *, messages: list[dict[str, Any]], temperature: float = 0.2) -> str:
        url = self.base_url.rstrip("/") + "/chat/completions"
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        with httpx.Client(timeout=120.0) as client:
            resp = client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            data = resp.json()
        return str((((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or "").strip()


def main() -> int:
    base_url = _env("AI_BASE_URL", "http://127.0.0.1:8317/v1").rstrip("/")
    api_key = _env("AI_API_KEY", "your-api-key-1")

    models = [
        ChatModel(base_url=base_url, api_key=api_key, model="gemini-3-pro-preview"),
        ChatModel(base_url=base_url, api_key=api_key, model="gemini-claude-opus-4-5-thinking"),
    ]

    prompts: list[tuple[str, list[dict[str, Any]]]] = []

    # Prompt A: parent customer
    prompts.append(
        (
            "A-家长客户",
            [
                {
                    "role": "system",
                    "content": (
                        "你是一个希望孩子英语超前的小学/初中家长。孩子完全不接触屏幕，只做纸质作业。"
                        "你会使用网页工具为孩子生成作业并录入错题。你时间少、英语一般、很怕选项太多。"
                        "请以“降低认知负担”为第一优先级。"
                        "只输出严格 JSON，不要 Markdown，不要多余文本。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "我在做一个“家长背单词工具”。核心能力：\n"
                        "1) 粘贴一段英文文本 -> 自动提取生词 -> 生成定制词单\n"
                        "2) 一键生成可打印的纸质作业（必须包含 3 种题型）\n"
                        "3) 家长在网页上录入错题 -> 系统安排下次复习\n"
                        "另外：我希望能区分“课本内词”和“课本外词”，并支持中考/小升初/课外高频/KET 这类词表。\n\n"
                        "请输出 JSON，字段：\n"
                        "- p0_workflow: [string]（家长从打开网页到拿到作业的最短流程，<=6步）\n"
                        "- must_have: [string]（你最需要的 5 个功能，按重要性）\n"
                        "- default_settings: {daily_words:int, question_types:[string], word_sources:[string], "
                        "textbook_handling:string, outside_handling:string}\n"
                        "- confusing_choices: {hide:[string], ask_only_if_needed:[string], wording_tips:[string]}\n"
                        "- success_metric: [string]（什么体验会让你愿意持续用/付费）\n"
                    ),
                },
            ],
        )
    )

    # Prompt B: teacher / pedagogy constraints
    prompts.append(
        (
            "B-英语老师",
            [
                {
                    "role": "system",
                    "content": (
                        "你是小学/初中英语老师，擅长用最小成本提高词汇记忆与拼写。"
                        "学生完全不接触屏幕，只能做纸质作业。"
                        "你要给出可执行、可落地、适合家长监督的建议。"
                        "只输出严格 JSON，不要 Markdown，不要多余文本。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "我打算给家长提供：从文本提取生词 -> 生成纸质作业（3题型）-> 家长录入错题 -> 下次复习。\n"
                        "请输出 JSON，字段：\n"
                        "- recommended_daily_words: {primary:int, junior:int}\n"
                        "- three_question_types: [{name:string, goal:string, how_to_grade:string}]\n"
                        "- grading_rules: {what_is_wrong:[string], how_to_record:[string], review_interval_hint:string}\n"
                        "- pitfalls: [string]（最常见踩坑与如何规避）\n"
                    ),
                },
            ],
        )
    )

    out: dict[str, Any] = {
        "generated_at_utc": _utc_iso_now(),
        "base_url": base_url,
        "models": [m.model for m in models],
        "sections": [],
    }

    for title, messages in prompts:
        section: dict[str, Any] = {"title": title, "answers": []}
        for m in models:
            content = m.chat(messages=messages, temperature=0.2)
            section["answers"].append({"model": m.model, "raw": content})
        out["sections"].append(section)

    root = Path(__file__).resolve().parent.parent
    md_path = root / "docs" / "parent_mode" / "AI_ALIGNMENT_2026-02-03.md"
    json_path = root / "docs" / "parent_mode" / "AI_ALIGNMENT_2026-02-03.raw.json"

    _write_utf8(json_path, json.dumps(out, ensure_ascii=False, indent=2))

    lines: list[str] = []
    lines.append("# 双模型对齐记录（家长模式）")
    lines.append("")
    lines.append(f"- 生成时间（UTC）：{out['generated_at_utc']}")
    lines.append(f"- OpenAI-Compatible Base URL：`{base_url}`")
    lines.append(f"- 模型：`{models[0].model}` / `{models[1].model}`")
    lines.append("")
    for sec in out["sections"]:
        lines.append(f"## {sec['title']}")
        lines.append("")
        for ans in sec["answers"]:
            lines.append(f"### {ans['model']}")
            lines.append("")
            lines.append("```")
            lines.append(ans["raw"])
            lines.append("```")
            lines.append("")

    _write_utf8(md_path, "\n".join(lines).rstrip() + "\n")
    print(str(md_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

