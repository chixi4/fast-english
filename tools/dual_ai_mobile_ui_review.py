from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_ymd_local() -> str:
    # For filenames only; use local date.
    return datetime.now().strftime("%Y-%m-%d")


def _write_utf8(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _extract_json(text: str) -> tuple[str, Any | None]:
    raw = (text or "").strip()
    if not raw:
        return ("", None)

    # Strip common Markdown fences.
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, flags=re.IGNORECASE)
    if fenced:
        raw2 = fenced.group(1).strip()
    else:
        raw2 = raw

    # Find the first '{' and last '}' as a best-effort JSON slice.
    i = raw2.find("{")
    j = raw2.rfind("}")
    if i >= 0 and j > i:
        cand = raw2[i : j + 1].strip()
    else:
        cand = raw2

    try:
        obj = json.loads(cand)
    except Exception:
        return (cand, None)
    return (cand, obj)


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


def _build_context() -> str:
    return (
        "项目：FastAPI 网页背单词（SQLite + FSRS + AI）。\n"
        "目标用户：小学/初中家长；孩子完全不接触屏幕；家长主要用手机操作，生成纸质作业、打印、批改、录入错题。\n\n"
        "当前家长模式信息架构：\n"
        "- 设置页可切换「使用模式：纸质作业（家长）/屏幕自学（本人）」\n"
        "- 家长模式导航仅 3 项：今日作业(/) / 词书(/decks) / 设置(/settings)\n"
        "- 今日作业页：一键「生成今日作业并打印」，以及“从文本生成/待录入错题”等入口\n"
        "- 作业页(/worksheets)：粘贴文本→提取生词→勾选→生成作业；也可一键生成今日作业；有历史作业列表\n"
        "- 试卷页(/worksheets/{id})：白底纸张区域，固定 3 题型：\n"
        "  题型一 中译英拼写（表格）\n"
        "  题型二 英译中选择（2列选项卡片）\n"
        "  题型三 语境填空（词库 + 句子列表）\n"
        "  打印时隐藏导航/答案/录入区；当前 CSS 用 .worksheet-break 强制每个大区分页。\n\n"
        "已知/疑似移动端问题线索（请在评估里覆盖）：\n"
        "1) 试卷的 .worksheet-table 在手机上可能横向溢出；移动端只对 .table 做了横向滚动处理。\n"
        "2) .worksheet-q-choices 默认两列，手机上可能拥挤。\n"
        "3) deck-picker 下拉菜单在手机上可能被滚动容器裁切或超出屏幕（无 max-height/scroll）。\n"
        "4) 当前文案有些“AI味”偏重/重复（例如反复强调孩子不接触屏幕），需要更像真实产品。\n"
        "5) 希望从“拿到词 → 孩子学会”全链路模拟（打印、批改、错题回流、下次复习、每周复盘）。\n"
    ).strip()


def _round_prompt(round_no: int) -> tuple[str, list[dict[str, Any]]]:
    ctx = _build_context()

    if round_no == 1:
        title = "Round 1：全链路场景模拟（手机端）"
        system = (
            "你是目标用户：小学/初中家长。你每天用手机完成：生成纸质作业→打印→孩子做→你批改→你录入错题→系统安排下次。"
            "请用简体中文。只输出 JSON（必须以 { 开头，以 } 结尾），不要 Markdown，不要多余文本。"
        )
        user = (
            f"{ctx}\n\n"
            "请你完整模拟 2 天 + 1 次每周复盘的真实流程（你在手机上的点击/页面感受 + 线下动作），并指出：\n"
            "1) 哪些步骤会卡住/容易出错/认知负担大？\n"
            "2) 你希望系统替你自动做哪些选择？你只愿意做哪些最小输入？\n"
            "3) 你希望‘试卷’长什么样，才能让孩子更愿意写、家长更容易批改？\n\n"
            "输出 JSON 字段：\n"
            "- day1_flow: [string]（<=10步，包含线上+线下）\n"
            "- day2_flow: [string]（<=10步，包含线上+线下）\n"
            "- weekly_flow: [string]（<=10步）\n"
            "- pain_points: [{step:string, why:string, severity:1|2|3}]（<=12条）\n"
            "- auto_defaults: [string]（<=10条）\n"
            "- worksheet_expectations: [string]（<=10条，聚焦题型内容/排版/批改）\n"
            "- success_metrics: [string]（<=6条，可量化）\n"
        )
        return title, [{"role": "system", "content": system}, {"role": "user", "content": user}]

    if round_no == 2:
        title = "Round 2：逐页移动端 Bug 清单 + 试卷重排版"
        system = (
            "你是产品体验审查员（目标用户视角），擅长找移动端排版/交互 bug，并给出最小改造建议。"
            "请用简体中文。只输出 JSON（必须以 { 开头，以 } 结尾），不要 Markdown，不要多余文本。"
        )
        user = (
            f"{ctx}\n\n"
            "请对以下页面做逐页审查（以手机为第一优先）：\n"
            "A) 今日作业页(/)（家长模式）\n"
            "B) 作业列表/提取页(/worksheets)\n"
            "C) 试卷详情页(/worksheets/{id})（重点：表格/分页/答题区/批改区/打印）\n"
            "D) 设置页(/settings)（模式切换 + 家长设置）\n"
            "E) 词书库(/library) 与 词书页(/decks)\n\n"
            "输出移动端 bug/不佳体验 + 修复建议。特别要求：\n"
            "- 明确指出可能的“溢出/遮挡/不可点/太小/滚动异常/打印分页浪费纸”等问题。\n"
            "- 对试卷给出 2 套排版方案：省纸版 / 标准版（更像正规试卷）。\n\n"
            "输出 JSON 字段：\n"
            "- page_issues: [{page:string, issues:[{title:string, symptom:string, fix:string, priority:0|1|2|3}]}]\n"
            "- worksheet_layout_options: {\n"
            "    economy: {sections:[string], page_break_rules:[string], typography:[string]},\n"
            "    standard: {sections:[string], page_break_rules:[string], typography:[string]}\n"
            "  }\n"
            "- mobile_css_changes: [string]（<=18条，尽量写成 CSS 级别建议）\n"
            "- acceptance_tests: [string]（<=10条，可在手机上手工验证）\n"
        )
        return title, [{"role": "system", "content": system}, {"role": "user", "content": user}]

    if round_no == 3:
        title = "Round 3：文案去 AI 味 + 交互再精简"
        system = (
            "你是资深产品文案 + UX 设计师（偏家长工具）。目标：中文更自然、更短、更像真实产品；交互更少选择。"
            "请用简体中文。只输出 JSON（必须以 { 开头，以 } 结尾），不要 Markdown，不要多余文本。"
        )
        user = (
            f"{ctx}\n\n"
            "请对家长模式所有页面的中文文案做“去 AI 味”重写，并给出交互再精简建议。\n"
            "优先处理这些文案：\n"
            "- ‘推荐流程’、‘孩子不接触屏幕…’、‘一键生成今日作业’、‘提交并安排复习’、‘录入错题（用于下次复习）’、‘词库’、‘答案（仅网页显示）’\n"
            "以及：试卷里的标题/提示语/区块标题。\n\n"
            "输出 JSON 字段：\n"
            "- terminology: {today_page:string, worksheets_page:string, mistakes:string, review:string, plan:string}\n"
            "- copy_rewrites: [{page:string, from:string, to:string, reason:string}]（<=20条）\n"
            "- interaction_simplifications: [string]（<=12条）\n"
            "- worksheet_content_tweaks: [string]（<=12条，偏题目内容/难度/提示）\n"
            "- final_p0_acceptance: [string]（<=8条）\n"
        )
        return title, [{"role": "system", "content": system}, {"role": "user", "content": user}]

    raise ValueError(f"Unsupported round: {round_no}")


def run_round(round_no: int) -> dict[str, Any]:
    base_url = _env("AI_BASE_URL", "http://127.0.0.1:8317/v1").rstrip("/")
    api_key = _env("AI_API_KEY", "your-api-key-1")

    models = [
        ChatModel(base_url=base_url, api_key=api_key, model="gemini-3-pro-preview"),
        ChatModel(base_url=base_url, api_key=api_key, model="gemini-claude-opus-4-5-thinking"),
    ]

    title, messages = _round_prompt(round_no)

    section: dict[str, Any] = {"round": round_no, "title": title, "answers": []}
    for m in models:
        raw = m.chat(messages=messages, temperature=0.2)
        json_text, parsed = _extract_json(raw)
        section["answers"].append(
            {
                "model": m.model,
                "raw": raw,
                "json_text": json_text,
                "parsed_ok": parsed is not None,
                "parsed": parsed,
            }
        )

    return {
        "generated_at_utc": _utc_iso_now(),
        "base_url": base_url,
        "models": [m.model for m in models],
        "section": section,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Dual-model mobile UX review for parent mode.")
    parser.add_argument("--round", type=int, choices=[1, 2, 3], required=True)
    args = parser.parse_args()

    out = run_round(int(args.round))

    root = Path(__file__).resolve().parent.parent
    ymd = _today_ymd_local()
    md_path = root / "docs" / "parent_mode" / f"AI_MOBILE_UX_REVIEW_{ymd}_R{args.round}.md"
    json_path = root / "docs" / "parent_mode" / f"AI_MOBILE_UX_REVIEW_{ymd}_R{args.round}.raw.json"

    _write_utf8(json_path, json.dumps(out, ensure_ascii=False, indent=2))

    sec = out["section"]
    lines: list[str] = []
    lines.append(f"# 双模型移动端评估（R{args.round}）")
    lines.append("")
    lines.append(f"- 生成时间（UTC）：{out['generated_at_utc']}")
    lines.append(f"- OpenAI-Compatible Base URL：`{out['base_url']}`")
    lines.append(f"- 模型：`{out['models'][0]}` / `{out['models'][1]}`")
    lines.append("")
    lines.append(f"## {sec['title']}")
    lines.append("")

    for ans in sec["answers"]:
        lines.append(f"### {ans['model']}")
        lines.append("")
        lines.append("```")
        lines.append(ans["json_text"] or ans["raw"])
        lines.append("```")
        lines.append("")

    _write_utf8(md_path, "\n".join(lines).rstrip() + "\n")
    print(str(md_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

