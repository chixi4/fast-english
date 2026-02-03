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
        payload: dict[str, Any] = {"model": self.model, "messages": messages, "temperature": temperature}
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        with httpx.Client(timeout=180.0) as client:
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

    # Keep the context compact but concrete.
    product_context = (
        "产品：一个网页端背单词工具（FastAPI）。\n"
        "目标用户：小学/初中家长；孩子完全不接触屏幕；家长每天花 3 分钟生成纸质作业并录入错题。\n\n"
        "现有信息架构（导航 5 项）：\n"
        "- 今日(/)：显示“今天待学”数量，主按钮是“开始学习”→ /review（屏幕闪卡打分）\n"
        "- 词书(/decks)：已导入词书列表\n"
        "- 作业(/worksheets)：粘贴文本→提取生词→勾选→生成可打印作业（固定 3 题型：中译英拼写/英译中选择/语境填空）→打印→网页勾错题回流复习\n"
        "- 应语(/practice)：错词篮/实战短文等（偏屏幕使用）\n"
        "- 我的(/settings)：学习计划（每日新词/复习上限）+ 家长模式设置（阶段/每日推荐词量/可选词表）\n\n"
        "家长模式的词表能力：可以标注“课本内/外”，支持“考试目标词表（如中考/小升初/KET）”与“课外高频词表”。\n\n"
        "真实用例观察：\n"
        "- 家长点“作业→一键生成今日作业”时，系统会尝试自动补新词，但有时仍提示“没有到期单词可生成作业”；\n"
        "  但回到“今日”首页又能看到待学数量增加（说明本次生成可能没捞到，或提示文案误导）。\n"
        "- 现在家长模式与旧的屏幕学习入口并列，家长容易看到“开始学习/应语/错词篮”等入口而困惑。\n"
    ).strip()

    prompts: list[tuple[str, list[dict[str, Any]]]] = []

    prompts.append(
        (
            "R1-融合形态选择",
            [
                {
                    "role": "system",
                    "content": (
                        "你是目标用户：小学/初中家长。孩子完全不接触屏幕。你只想：少操作、少选择、可打印、错题能循环。"
                        "请严格只输出 JSON（必须以 { 开头，以 } 结尾），不要 Markdown。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        product_context
                        + "\n\n请在 3 种形态中选 1 个最适合家长模式的，并给出具体落地建议：\n"
                        + "A) 把“今日(/)”改造成家长的“今日作业”主入口；把屏幕闪卡学习入口收进“高级/更多”。\n"
                        + "B) 保持“作业(/worksheets)”作为唯一主入口；把“今日(/)”重命名为“屏幕学习”，并在家长模式下隐藏。\n"
                        + "C) 增加“模式开关（家长/自学）”，切换后整套导航、首页内容都变。\n\n"
                        + "输出 JSON 字段：\n"
                        + "- best_form: \"A\"|\"B\"|\"C\"\n"
                        + "- reasons: [string]（<=6）\n"
                        + "- nav_when_parent: [string]（家长模式导航文字，从左到右，<=5项）\n"
                        + "- what_to_hide: [string]（放入高级/隐藏的入口）\n"
                        + "- p0_daily_flow: [string]（<=6步）\n"
                        + "- biggest_confusions_today: [string]（<=6条）\n"
                    ),
                },
            ],
        )
    )

    prompts.append(
        (
            "R2-页面改造与降选择",
            [
                {
                    "role": "system",
                    "content": (
                        "你是目标用户：小学/初中家长。孩子完全不接触屏幕。你希望每天 3 分钟搞定。"
                        "请严格只输出 JSON（必须以 { 开头，以 } 结尾），不要 Markdown。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        product_context
                        + "\n\n请给出“最小改造”方案，让家长不纠结、不迷路：\n"
                        + "1) 首页（或主入口页）应该出现哪些区块？每块一句话+一个按钮文案。\n"
                        + "2) 作业页怎么分区，才能把“粘贴文本/一键今日/历史作业/错词复习”放得清楚？\n"
                        + "3) 设置页只保留哪些设置？如何把“课本内/外、考试目标（中考/小升初/KET）、课外高频”做成家长一眼懂的选择？\n\n"
                        + "输出 JSON 字段：\n"
                        + "- homepage_blocks: [string]\n"
                        + "- worksheets_blocks: [string]\n"
                        + "- settings_blocks: [string]\n"
                        + "- choice_reduction_rules: [string]（<=8条，默认值/自动选择规则）\n"
                        + "- copy_rewrites: [{from:string,to:string}]（技术词→家长说法，<=10条）\n"
                    ),
                },
            ],
        )
    )

    prompts.append(
        (
            "R3-P0优先级与验收",
            [
                {
                    "role": "system",
                    "content": (
                        "你是目标用户：小学/初中家长。孩子完全不接触屏幕。你只关心：少操作、少选择、可打印、错题能循环。"
                        "请严格只输出 JSON（必须以 { 开头，以 } 结尾），不要 Markdown。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        product_context
                        + "\n\n请输出一个 P0 改造清单（按优先级），并给出 3 分钟可演示验收标准。\n"
                        + "输出 JSON 字段：\n"
                        + "- p0_tasks: [string]（<=10条）\n"
                        + "- acceptance: [string]（<=8条）\n"
                        + "- risks: [string]（<=6条）\n"
                    ),
                },
            ],
        )
    )

    out: dict[str, Any] = {
        "generated_at_utc": _utc_iso_now(),
        "base_url": base_url,
        "models": [m.model for m in models],
        "rounds": [],
    }

    for title, messages in prompts:
        sec: dict[str, Any] = {"title": title, "answers": []}
        for m in models:
            sec["answers"].append({"model": m.model, "raw": m.chat(messages=messages, temperature=0.2)})
        out["rounds"].append(sec)

    root = Path(__file__).resolve().parent.parent
    md_path = root / "docs" / "parent_mode" / "AI_ALIGNMENT_2026-02-03_integration.md"
    json_path = root / "docs" / "parent_mode" / "AI_ALIGNMENT_2026-02-03_integration.raw.json"

    _write_utf8(json_path, json.dumps(out, ensure_ascii=False, indent=2))

    lines: list[str] = []
    lines.append("# 双模型对齐记录（家长模式-融合形态）")
    lines.append("")
    lines.append(f"- 生成时间（UTC）：{out['generated_at_utc']}")
    lines.append(f"- OpenAI-Compatible Base URL：`{base_url}`")
    lines.append(f"- 模型：`{models[0].model}` / `{models[1].model}`")
    lines.append("")

    for sec in out["rounds"]:
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

