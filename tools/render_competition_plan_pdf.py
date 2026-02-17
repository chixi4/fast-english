from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import markdown
from playwright.sync_api import sync_playwright


_AUTO_BLOCK_START = "<!-- AUTO_SCREENSHOT_APPENDIX_START -->"
_AUTO_BLOCK_END = "<!-- AUTO_SCREENSHOT_APPENDIX_END -->"


@dataclass(frozen=True)
class LayoutVariant:
    name: str
    page_margin_top: str
    page_margin_right: str
    page_margin_bottom: str
    page_margin_left: str
    shell_width_mm: int
    shell_padding_inline_mm: int
    shell_padding_block_mm: int
    cover_border_color: str


STANDARD_BINDING = LayoutVariant(
    name="standard",
    page_margin_top="25mm",
    page_margin_right="25mm",
    page_margin_bottom="25mm",
    page_margin_left="30mm",
    shell_width_mm=175,
    shell_padding_inline_mm=12,
    shell_padding_block_mm=14,
    cover_border_color="#cfd6e2",
)


CENTERED_SHOWCASE = LayoutVariant(
    name="centered",
    page_margin_top="25mm",
    page_margin_right="25mm",
    page_margin_bottom="25mm",
    page_margin_left="25mm",
    shell_width_mm=170,
    shell_padding_inline_mm=12,
    shell_padding_block_mm=14,
    cover_border_color="#cfd6e2",
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


_ROOT = _repo_root()
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _load_manifest(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    items: list[dict[str, str]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            file_name = str(item.get("file") or "").strip()
            title = str(item.get("title") or "").strip()
            route = str(item.get("route") or "").strip()
            if not file_name:
                continue
            items.append({"file": file_name, "title": title, "route": route})
    return items


def _strip_old_auto_block(text: str) -> str:
    pattern = re.compile(
        rf"\n?{re.escape(_AUTO_BLOCK_START)}[\s\S]*?{re.escape(_AUTO_BLOCK_END)}\n?",
        flags=re.MULTILINE,
    )
    return re.sub(pattern, "\n", text)


def _build_screenshot_appendix(manifest_items: list[dict[str, str]], image_dir: Path) -> str:
    if not manifest_items:
        return ""

    wanted_titles = {"首页 今日学习", "复习页面", "错词强化", "设置页面"}
    filtered_items: list[dict[str, str]] = []
    for item in manifest_items:
        title = str(item.get("title") or "").strip()
        if title in wanted_titles:
            filtered_items.append(item)
    if filtered_items:
        manifest_items = filtered_items

    rows: list[str] = []
    rows.append(_AUTO_BLOCK_START)
    rows.append("\n### 1 应用界面截图")

    for index, item in enumerate(manifest_items[:4], start=1):
        file_name = item.get("file") or ""
        title = item.get("title") or f"应用页面 {index}"
        path = (image_dir / file_name).resolve()
        if not path.exists():
            continue
        rel = path.relative_to(_repo_root()).as_posix()
        rows.append(f"\n#### 图 A{index} {title}")
        rows.append(f"\n![图 A{index} {title}]({rel})")

    rows.append(f"\n{_AUTO_BLOCK_END}")
    return "\n".join(rows).strip() + "\n"


def _compose_competition_markdown(base_md: str, appendix_md: str) -> str:
    text = _strip_old_auto_block(base_md).rstrip() + "\n"
    if appendix_md:
        text = text.rstrip() + "\n\n" + appendix_md
    return text.rstrip() + "\n"


def _extract_toc_items(markdown_text: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for line in markdown_text.splitlines():
        m2 = re.match(r"^##\s+(.+?)\s*$", line)
        if m2:
            items.append({"level": 2, "title": m2.group(1).strip()})
            continue
        m3 = re.match(r"^###\s+(.+?)\s*$", line)
        if m3:
            items.append({"level": 3, "title": m3.group(1).strip()})
    return items


def _build_toc_html(markdown_text: str) -> str:
    items = _extract_toc_items(markdown_text)
    if not items:
        return "<p>目录将在最终稿生成。</p>"

    rows: list[str] = ["<div class=\"toc-list\">"]
    for idx, item in enumerate(items, start=1):
        level = int(item["level"])
        title = str(item["title"])
        fake_page = 3 + max(0, idx // 3)
        cls = "toc-item toc-level-2" if level == 2 else "toc-item toc-level-3"
        rows.append(
            f"<div class=\"{cls}\">"
            f"<div class=\"toc-title-col\">{html.escape(title)}</div>"
            f"<div class=\"toc-leader\"></div>"
            f"<div class=\"toc-page-col\">{fake_page}</div>"
            f"</div>"
        )
    rows.append("</div>")
    return "\n".join(rows)


def _md_to_html(markdown_text: str) -> str:
    return markdown.markdown(
        markdown_text,
        extensions=[
            "extra",
            "tables",
            "fenced_code",
            "sane_lists",
            "nl2br",
            "attr_list",
        ],
    )


def _absolutize_local_img_src(article_html: str) -> str:
    repo_root = _repo_root()

    def _replace(match: re.Match[str]) -> str:
        src = str(match.group(1) or "").strip()
        lower = src.lower()
        if lower.startswith("http://") or lower.startswith("https://") or lower.startswith("file://") or lower.startswith("data:"):
            return match.group(0)

        raw = src.split("?", 1)[0].split("#", 1)[0].strip()
        if not raw:
            return match.group(0)
        candidate = (repo_root / raw).resolve()
        if not candidate.exists():
            return match.group(0)

        return match.group(0).replace(src, candidate.as_uri())

    return re.sub(r'src="([^"]+)"', _replace, article_html)


def _build_variant_css(variant: LayoutVariant, is_compact_appendix: bool) -> str:
    appendix_max_w = "52mm" if is_compact_appendix else "65mm"
    appendix_gap = "3.2mm" if is_compact_appendix else "5.0mm"

    return f"""
    @page {{
      size: A4;
      margin: {variant.page_margin_top} {variant.page_margin_right} {variant.page_margin_bottom} {variant.page_margin_left};
    }}
    html, body {{
      margin: 0;
      padding: 0;
      background: #f5f7fb;
    }}
    body {{
      font-family: SimSun, 宋体, serif;
      font-size: 12pt;
      line-height: 1.5;
      color: #111827;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }}
    .page-shell {{
      width: {variant.shell_width_mm}mm;
      margin: 0 auto;
      background: #fff;
      box-shadow: 0 3mm 8mm rgba(0,0,0,0.08);
      padding: {variant.shell_padding_block_mm}mm {variant.shell_padding_inline_mm}mm;
      box-sizing: border-box;
      min-height: 260mm;
      border: none;
    }}
    .cover {{
      page-break-after: always;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      min-height: 248mm;
      border: none;
      padding: 10mm 12mm;
      box-sizing: border-box;
      background: #fff;
    }}
    .cover-top {{
      font-family: SimHei, 黑体, sans-serif;
      font-size: 16pt;
      letter-spacing: 0.4mm;
      color: #111827;
      margin: 0 0 14mm;
      text-align: center;
    }}
    .cover-title {{
      font-family: SimHei, 黑体, sans-serif;
      font-size: 26pt;
      font-weight: 700;
      line-height: 1.3;
      text-align: center;
      margin: 0 0 14mm;
      color: #0f172a;
    }}
    .cover-subtitle {{
      text-align: center;
      margin-top: 8mm;
      font-size: 12pt;
      color: #1f2937;
      letter-spacing: 0.2mm;
      display: none;
    }}
    .cover-meta {{
      margin-top: 0;
      border-top: none;
      padding-top: 0;
      font-size: 12pt;
      width: 128mm;
      max-width: 100%;
    }}
    .cover-meta table {{
      width: 100%;
      border-collapse: collapse;
    }}
    .cover-meta td {{
      padding: 3.1mm 1.6mm;
      border-bottom: none;
      vertical-align: middle;
    }}
    .cover-meta .k {{
      width: 36mm;
      color: #334155;
      font-family: SimHei, 黑体, sans-serif;
    }}
    .toc-page {{
      page-break-after: always;
      border: none;
      padding: 8mm 7mm;
      box-sizing: border-box;
      min-height: 250mm;
    }}
    .toc-title {{
      font-family: SimHei, 黑体, sans-serif;
      font-size: 16pt;
      margin: 0 0 6mm 0;
      color: #0f172a;
      text-align: center;
      padding-bottom: 2.2mm;
      border-bottom: 0.25mm solid #d1d5db;
    }}
    .toc-list {{
      display: block;
    }}
    .toc-item {{
      display: flex;
      align-items: flex-end;
      gap: 2mm;
      margin: 1.7mm 0;
      min-height: 6.4mm;
      page-break-inside: avoid;
    }}
    .toc-title-col {{
      flex: 0 1 auto;
      max-width: 78%;
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
      line-height: 1.35;
    }}
    .toc-leader {{
      flex: 1 1 auto;
      border-bottom: 0.2mm dotted #94a3b8;
      transform: translateY(-1.1mm);
      min-width: 30mm;
    }}
    .toc-page-col {{
      flex: 0 0 auto;
      width: 8mm;
      text-align: right;
      font-family: SimHei, 黑体, sans-serif;
      color: #374151;
      line-height: 1;
      font-size: 10.8pt;
    }}
    .toc-level-2 .toc-title-col {{
      font-family: SimHei, 黑体, sans-serif;
      font-size: 12pt;
      font-weight: 700;
      color: #0f172a;
    }}
    .toc-level-3 {{
      padding-left: 5.5mm;
    }}
    .toc-level-3 .toc-title-col {{
      font-size: 11pt;
      color: #334155;
    }}
    .article {{
      background: #fff;
    }}
    .article h1, .article h2 {{
      font-family: SimHei, 黑体, sans-serif;
      font-weight: 700;
      color: #0f172a;
      margin-top: 8mm;
      margin-bottom: 3.2mm;
      line-height: 1.3;
      page-break-after: avoid;
    }}
    .article h1 {{
      font-size: 20pt;
      text-align: center;
      margin-top: 1.8mm;
      margin-bottom: 6mm;
    }}
    .article h2 {{
      font-size: 16pt;
      text-align: center;
      border-bottom: none;
      padding-bottom: 0;
    }}
    .article h3 {{
      font-family: SimHei, 黑体, sans-serif;
      font-size: 14pt;
      font-weight: 700;
      margin-top: 5.1mm;
      margin-bottom: 2.4mm;
      color: #1f2937;
      page-break-after: avoid;
    }}
    .article h4 {{
      font-family: SimHei, 黑体, sans-serif;
      font-size: 12pt;
      margin-top: 3.8mm;
      margin-bottom: 2.0mm;
      color: #1f2937;
      page-break-after: avoid;
    }}
    .article p {{
      margin: 0 0 3.0mm 0;
      text-indent: 2em;
      text-align: justify;
      color: #111827;
      line-height: 1.5;
      widows: 2;
      orphans: 2;
    }}
    .article ul,
    .article ol {{
      margin: 0 0 3.0mm 0;
      padding-left: 7mm;
    }}
    .article li {{
      margin: 0 0 1.0mm 0;
      line-height: 1.45;
    }}
    .article li p {{
      text-indent: 0;
      margin: 0;
    }}
    .article hr {{
      display: none;
    }}
    .article table {{
      width: 100%;
      border-collapse: collapse;
      margin: 3.2mm 0 4.6mm;
      font-size: 11.5pt;
    }}
    .article th,
    .article td {{
      border: 0.2mm solid #cfd5df;
      padding: 1.9mm 2.3mm;
      vertical-align: top;
      line-height: 1.4;
      word-break: break-word;
    }}
    .article th {{
      background: #f8fafc;
      font-family: SimHei, 黑体, sans-serif;
      font-weight: 700;
    }}
    .article code {{
      font-family: Consolas, Courier New, monospace;
      font-size: 10.4pt;
      background: #f1f5f9;
      padding: 0.35mm 0.9mm;
      border-radius: 0.9mm;
    }}
    .article pre {{
      background: #0f172a;
      color: #e2e8f0;
      padding: 2.4mm;
      border-radius: 1.5mm;
      overflow: auto;
      line-height: 1.35;
      font-size: 10.3pt;
      page-break-inside: avoid;
    }}
    .article pre code {{
      background: transparent;
      color: inherit;
      padding: 0;
    }}
    .article h4 {{
      break-after: avoid;
    }}
    .article img {{
      display: block;
      width: 100%;
      max-width: {appendix_max_w};
      margin: 1.0mm auto 1.0mm;
      border: 0.2mm solid #c9ced8;
      border-radius: 1.3mm;
      box-shadow: 0 0.9mm 2.2mm rgba(15, 23, 42, 0.08);
      page-break-inside: avoid;
      break-inside: avoid;
    }}
    .appendix-grid {{
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 1.2mm;
      align-items: start;
      margin-top: 0.6mm;
      page-break-inside: avoid;
      break-inside: avoid;
    }}
    .appendix-item {{
      margin: 0;
      padding: 0;
      page-break-inside: avoid;
      break-inside: avoid;
    }}
    .appendix-item img {{
      width: 100%;
      max-width: none;
      margin: 0;
      border: none;
      border-radius: 0.6mm;
      box-shadow: none;
      display: block;
      aspect-ratio: auto;
      object-fit: contain;
    }}
    .appendix-caption {{
      margin: 0.5mm 0 0;
      padding: 0;
      text-indent: 0;
      text-align: center;
      font-family: SimHei, 黑体, sans-serif;
      font-size: 8.8pt;
      line-height: 1.2;
      color: #111827;
    }}
    @media print {{
      html, body {{
        background: #fff;
      }}
      .page-shell {{
        width: auto;
        margin: 0;
        padding: 0;
        min-height: auto;
        box-shadow: none;
        border: none;
      }}
    }}
    """


def _tighten_appendix_html(article_html: str) -> str:
    if "图 A" not in article_html:
        return article_html

    heading_pattern = re.compile(r"<h[34]>\s*图\s*A\d+[^<]*</h[34]>", flags=re.IGNORECASE)
    matches = list(heading_pattern.finditer(article_html))
    if not matches:
        return article_html

    prefix = article_html[: matches[0].start()]
    suffix = article_html[matches[0].start() :]

    card_pattern = re.compile(
        r"<h[34]>\s*(图\s*A\d+[^<]*)</h[34]>\s*"
        r"(?:<p>\s*页面[:：]\s*<code>([^<]*)</code>\s*</p>\s*)?"
        r"<p>\s*(<img[^>]+>)\s*</p>",
        flags=re.IGNORECASE,
    )

    cards: list[str] = []
    consumed_end = 0
    for m in card_pattern.finditer(suffix):
        caption = (m.group(1) or "").strip()
        img = (m.group(3) or "").strip()
        card = ["<div class=\"appendix-item\">"]
        card.append(img)
        card.append(f"<p class=\"appendix-caption\">{html.escape(caption)}</p>")
        card.append("</div>")
        cards.append("".join(card))
        consumed_end = m.end()

    if not cards:
        return article_html

    rebuilt = prefix
    rebuilt += "<div class=\"appendix-grid\">" + "".join(cards) + "</div>"
    rebuilt += suffix[consumed_end:]
    return rebuilt


def _build_html_document(markdown_text: str, project_title: str, variant: LayoutVariant) -> str:
    body_html = _md_to_html(markdown_text)
    body_html = _absolutize_local_img_src(body_html)
    body_html = _tighten_appendix_html(body_html)
    toc_html = _build_toc_html(markdown_text)

    css = _build_variant_css(variant=variant, is_compact_appendix=True)
    today = dt.date.today().strftime("%Y 年 %m 月 %d 日")
    variant_label = "标准装订版" if variant.name == "standard" else "居中展示版"

    return f"""<!doctype html>
<html lang=\"zh-CN\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>{html.escape(project_title)} {variant_label}</title>
  <style>{css}</style>
</head>
<body>
  <div class=\"page-shell\">
    <section class=\"cover\">
      <div class=\"cover-top\">中国国际大学生创新大赛项目计划书</div>
      <h1 class=\"cover-title\">{html.escape(project_title)}</h1>
      <div class=\"cover-meta\">
        <table>
          <tr><td class=\"k\">项目名称</td><td>迅捷单词</td></tr>
          <tr><td class=\"k\">参赛赛事</td><td>中国国际大学生创新大赛</td></tr>
          <tr><td class=\"k\">团队名称</td><td>________________________</td></tr>
          <tr><td class=\"k\">所在学校</td><td>________________________</td></tr>
          <tr><td class=\"k\">项目负责人</td><td>________________________</td></tr>
          <tr><td class=\"k\">指导老师</td><td>________________________</td></tr>
          <tr><td class=\"k\">提交日期</td><td>________________________</td></tr>
        </table>
      </div>
    </section>

    <section class=\"toc-page\">
      <h2 class=\"toc-title\">目录</h2>
      {toc_html}
    </section>

    <main class=\"article\">
      {body_html}
    </main>
  </div>
</body>
</html>
"""


def _render_pdf(html_path: Path, output_pdf: Path, variant: LayoutVariant) -> None:
    output_pdf.parent.mkdir(parents=True, exist_ok=True)

    footer = (
        "<div style='width:100%;font-size:9px;color:#6b7280;padding:0 10mm 2mm;text-align:center;'>"
        "第 <span class='pageNumber'></span> 页 / 共 <span class='totalPages'></span> 页"
        "</div>"
    )
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(html_path.resolve().as_uri(), wait_until="networkidle")
        page.emulate_media(media="print")
        page.pdf(
            path=str(output_pdf),
            format="A4",
            print_background=True,
            display_header_footer=True,
            header_template="<div></div>",
            footer_template=footer,
            margin={
                "top": variant.page_margin_top,
                "right": variant.page_margin_right,
                "bottom": variant.page_margin_bottom,
                "left": variant.page_margin_left,
            },
            prefer_css_page_size=True,
        )
        browser.close()


def _build_outputs_for_variant(
    *,
    repo_root: Path,
    variant: LayoutVariant,
    markdown_text: str,
    project_title: str,
    output_html: Path,
    output_pdf: Path,
) -> None:
    html_doc = _build_html_document(markdown_text, project_title=project_title, variant=variant)
    output_html.parent.mkdir(parents=True, exist_ok=True)
    output_html.write_text(html_doc, encoding="utf-8")
    _render_pdf(output_html, output_pdf, variant=variant)


def _render_pdf_preview_png(pdf_path: Path, preview_dir: Path) -> None:
    import fitz

    if not pdf_path.exists():
        return
    preview_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(str(pdf_path))
    try:
        picks = []
        if len(doc) >= 1:
            picks.append((0, "page01_cover"))
        if len(doc) >= 2:
            picks.append((1, "page02_toc"))
        if len(doc) >= 1:
            picks.append((len(doc) - 1, "page_last_appendix"))

        matrix = fitz.Matrix(2.0, 2.0)
        for idx, name in picks:
            page = doc.load_page(idx)
            pix = page.get_pixmap(matrix=matrix, alpha=False)
            out = preview_dir / f"{name}.png"
            pix.save(str(out))
    finally:
        doc.close()


def _choose_variants(mode: str) -> list[LayoutVariant]:
    normalized = (mode or "both").strip().lower()
    if normalized == "standard":
        return [STANDARD_BINDING]
    if normalized == "centered":
        return [CENTERED_SHOWCASE]
    return [STANDARD_BINDING, CENTERED_SHOWCASE]


def _seed_demo_data_for_screenshots() -> None:
    from app.db import get_session
    from app.models import Mistake, Word

    seed_words = [
        ("efficient", "高效的"),
        ("analyze", "分析"),
        ("context", "语境"),
        ("strategy", "策略"),
        ("evaluate", "评估"),
        ("review", "复习"),
        ("priority", "优先级"),
        ("schedule", "计划"),
    ]

    with get_session() as session:
        existing = session.query(Word).all()
        existing_terms = {str(w.term).strip().lower(): int(w.id) for w in existing}
        created_ids: list[int] = []
        for term, meaning in seed_words:
            key = term.lower()
            if key in existing_terms:
                created_ids.append(existing_terms[key])
                continue
            row = Word(term=term, definition=meaning, example=f"Example sentence for {term}.", tags="demo")
            session.add(row)
            session.flush()
            created_ids.append(int(row.id))

        for wid in created_ids[:6]:
            session.add(Mistake(word_id=wid))


def _regenerate_screenshots(repo_root: Path) -> None:
    import subprocess
    import sys

    _seed_demo_data_for_screenshots()
    python_exe = repo_root / ".venv" / "Scripts" / "python.exe"
    if not python_exe.exists():
        python_exe = Path(sys.executable)
    subprocess.run(
        [str(python_exe), "tools/capture_plan_screenshots.py"],
        cwd=str(repo_root),
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Render competition-style PDF from project plan markdown")
    parser.add_argument("--input-md", default="docs/迅捷单词 项目计划书.md", help="source markdown path")
    parser.add_argument("--manifest", default="docs/assets/plan_screenshots/manifest.json", help="screenshot manifest")
    parser.add_argument("--image-dir", default="docs/assets/plan_screenshots", help="screenshot directory")
    parser.add_argument("--variant", default="both", choices=["standard", "centered", "both"], help="layout variant")
    parser.add_argument("--output-md", default="docs/迅捷单词 项目计划书_参赛版.md", help="render-ready markdown")
    parser.add_argument("--output-html-standard", default="artifacts/plan_pdf/迅捷单词_项目计划书_参赛版_标准装订.html", help="standard html")
    parser.add_argument("--output-html-centered", default="artifacts/plan_pdf/迅捷单词_项目计划书_参赛版_居中展示.html", help="centered html")
    parser.add_argument("--output-pdf-standard", default="docs/迅捷单词 项目计划书_参赛版_标准装订.pdf", help="standard pdf")
    parser.add_argument("--output-pdf-centered", default="docs/迅捷单词 项目计划书_参赛版_居中展示.pdf", help="centered pdf")
    parser.add_argument("--project-title", default="迅捷单词项目计划书", help="cover title")
    parser.add_argument("--refresh-screenshots", type=int, default=1, help="refresh screenshots before rendering")
    args = parser.parse_args()

    repo_root = _repo_root()
    input_md = (repo_root / args.input_md).resolve()
    manifest_path = (repo_root / args.manifest).resolve()
    image_dir = (repo_root / args.image_dir).resolve()

    if int(args.refresh_screenshots or 0) == 1:
        _regenerate_screenshots(repo_root)

    base_md = _read_text(input_md)
    manifest_items = _load_manifest(manifest_path)
    appendix_md = _build_screenshot_appendix(manifest_items, image_dir)
    final_md = _compose_competition_markdown(base_md, appendix_md)

    output_md = (repo_root / args.output_md).resolve()
    output_md.parent.mkdir(parents=True, exist_ok=True)
    output_md.write_text(final_md, encoding="utf-8")

    selected = _choose_variants(args.variant)
    for variant in selected:
        if variant.name == "standard":
            html_path = (repo_root / args.output_html_standard).resolve()
            pdf_path = (repo_root / args.output_pdf_standard).resolve()
        else:
            html_path = (repo_root / args.output_html_centered).resolve()
            pdf_path = (repo_root / args.output_pdf_centered).resolve()

        _build_outputs_for_variant(
            repo_root=repo_root,
            variant=variant,
            markdown_text=final_md,
            project_title=args.project_title,
            output_html=html_path,
            output_pdf=pdf_path,
        )
        preview_dir = repo_root / "artifacts" / "plan_pdf" / "previews" / variant.name
        _render_pdf_preview_png(pdf_path=pdf_path, preview_dir=preview_dir)
        print(f"variant={variant.name} html={html_path}")
        print(f"variant={variant.name} pdf={pdf_path}")
        print(f"variant={variant.name} preview_dir={preview_dir}")

    print(f"markdown={output_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
