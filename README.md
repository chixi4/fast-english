# Vocabulary Study (MVP)

核心差异化：把“错词”重组为**阅读短文 + 实战出题**，训练你在语境中做题，而不是只背静态例句。

## 功能（当前MVP）
- 单词库：添加/删除/搜索
- 词书（Deck）：创建/查看/按词书复习
- 批量导入：支持 `deck/chapter/position`、文件头元信息（`#deck/#tags/#separator/#columns`）、重复策略（跳过/更新）
- 学习计划：导入词书只入库；按词书分批“加入学习计划”后才会出现在“今日学习”
- 复习：FSRS 间隔重复（Again/Hard/Good/Easy 评分 → 自动排程），Again 会进入错词篮
- 错词篮：选择错词 + 难度，一键生成“短文 + 题目”，并支持判分
- 作业（家长模式）：粘贴文本提取生词 → 一键生成可打印作业（3题型）→ 勾选错题回流到复习
- 支持 OpenAI-Compatible（`/chat/completions`）以及 `AI_MOCK=1` 的离线演示

## 本地运行（Windows）
1) 复制环境变量文件：把 `.env.example` 复制为 `.env`
2) 配置AI（可选）
   - 不配置：把 `AI_MOCK=1`
   - 配置：填 `AI_API_KEY`，按需改 `AI_BASE_URL`/`AI_MODEL`
3) 启动：
   - 推荐（在 PowerShell 里直接执行）：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\run.ps1`
   - 如果你不想处理 PowerShell 执行策略：直接运行 `run.cmd`
   - 直接启动并自动打开词书库：`run-library.cmd`
   - 如果系统禁止运行 `.ps1`：依次执行
     - `python -m venv .venv`（仅第一次）
     - `.\\.venv\\Scripts\\python -m pip install -r requirements.txt`
     - `.\\.venv\\Scripts\\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
4) 打开：`http://127.0.0.1:8000`

## 清空本地数据
会清空本地 SQLite 数据库里的所有数据（单词/词书/复习记录/错词/实战短文）。

- 一键脚本：`reset-data.cmd`

## 导入词书（Deck）
1) 打开 `http://127.0.0.1:8000/words`
2) 在“批量导入”里填写“导入到词书（可选）”，也可以在文件头里写 `#deck:`
3) 上传文件或粘贴文本后导入；导入完成后去 `http://127.0.0.1:8000/` 或 `http://127.0.0.1:8000/decks` 把单词分批加入学习计划，再开始复习

支持字段：
- `term,definition,example,tags,deck,chapter,position`（CSV/TSV，可带表头）
- 或每行一个词（仅 term）

支持文件头元信息（可选，类似 Anki 习惯）：
- `#deck: CET4`
- `#tags: 高频, v1`
- `#separator: tab|comma|semicolon|pipe`
- `#columns: term,definition,example,tags,chapter,position`

## 词书库（一键导入）
打开 `http://127.0.0.1:8000/library`，选择词书并点击“一键导入”（下载后会缓存到 `data/wordbooks-cache`）。
导入完成后回到“今日”，把单词加入学习计划（建议每天 10~30 个），再开始学习。

当前内置来源（均有明确开源许可）：
- **ECDICT（MIT）**：中考/高考/CET4/CET6/考研/IELTS/TOEFL/GRE（按 tag 生成词书）
- **high-frequency-vocabulary（MIT）**：高频 10k / 30k（word-only）
- **cet-word-list（MIT）**：四/六级词表合集（word-only）

## 文档
- `docs/IMPLEMENTATION.md`：完整实现文档（PRD/架构/数据模型/Prompt/迭代路线）
- `docs/PARENT_MODE_MVP.md`：家长模式（纸质作业）使用说明
