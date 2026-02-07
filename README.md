# 敏捷英语

文档更新时间 2026-02-07

## 项目简介

这个项目是一套面向英语学习的网页系统，核心目标不是把单词独立地背下来，而是把单词放回真实语境里反复使用，让学习过程从记住单词逐步走向会用单词。

系统把日常学习分成清晰的闭环，先完成词书导入和学习计划，再完成今日学习和错词回流，最后通过短文练习或纸质作业把薄弱点继续压实，整个过程都保存在本地数据库里，便于追踪和复盘。

项目同时支持自学模式和家长模式，两种模式共用同一套数据引擎与排程逻辑，只是页面入口和日常动作不同，因此同一个家庭可以在同一个站点里完成自学和作业管理两类任务。

系统支持 OpenAI-Compatible 接口，含义是接口格式遵循 `POST /chat/completions`，可以接入兼容这个格式的服务；系统也支持 `AI_MOCK=1` 的离线演示模式，在没有密钥时仍可完整跑通流程。

系统内置 FSRS 排程，FSRS 是按遗忘规律安排复习时间的一种算法，系统会根据每次评分自动计算下一次复习时间，从而减少盲目重复。

## 两种使用模式

### 自学模式

自学模式的主流程是 导入词书 到 今日学习 到 错词练习。

你先导入词书并把词条加入学习计划，然后在今日学习里完成新词和复习词，遇到不会的词会进入错词篮，最后在错词篮里一键生成短文练习，通过语境题巩固薄弱点。

### 家长模式

家长模式的主流程是 生成作业 到 打印 到 勾错词回流。

家长在网页上生成当天作业并打印，孩子在线下完成纸质作业，家长回到网页勾选错词后提交，系统会把错词写回复习计划，下一次会自动安排更高频的复习。

## 功能全景

### 第一层 数据准备

系统支持词书库一键导入，也支持批量文本和表格导入，导入后数据先进入词库，再由学习计划控制每日投放量，这样可以避免一次性堆积过多新词。

### 第二层 每日学习

今日学习页面会把当天需要处理的学习任务集中展示，你完成每个词条评分后，系统会自动更新记忆状态和下次时间，不需要手动维护复习日历。

### 第三层 错词强化

错词篮会按错误记录聚合词条，你可以直接一键生成短文和题目，也可以在高级设置里手动挑词，系统会输出可判分的结构化结果并保存历史记录。

### 第四层 家长作业闭环

作业模块支持按当天排程自动出卷，也支持按词条组合出卷，页面内置打印样式和批改入口，勾选错词后会立即回流到复习系统，形成闭环。

### 第五层 看板与诊断

系统提供学习看板、分析接口和链路诊断接口，既能看学习进度，也能定位页面跳转、交互和网络链路中的问题。

## 三分钟快速启动 Windows

### 第一步 首次准备

在项目根目录执行以下操作，先复制环境文件，再开启无密钥演示模式。

```powershell
Copy-Item .env.example .env
```

把 `.env` 里的 `AI_MOCK` 改成 `1`，这样不填密钥也可以启动。

### 第二步 启动服务

你可以按自己的终端习惯选择以下任意一种方式。

#### 方式一 推荐 PowerShell 脚本

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

#### 方式二 使用命令行批处理

```cmd
run.cmd
```

#### 方式三 启动后自动打开词书库

```cmd
run-library.cmd
```

### 第三步 访问地址与端口

服务默认监听 `127.0.0.1:8000`，浏览器访问 `http://127.0.0.1:8000`。

### 第四步 常见启动失败处理

如果你看到端口占用，先关闭已有的 Python 进程再重启，`run-library.cmd` 已包含自动清理 `8000` 端口监听进程的逻辑。

如果系统限制执行脚本，你可以直接用 Python 手动启动。

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

## Linux 与 Docker 补充

### Linux 原生启动

```bash
cp .env.example .env
sed -i 's/^AI_MOCK=.*/AI_MOCK=1/' .env
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### Docker Compose 启动

仓库默认 `docker-compose.yml` 采用应用服务加可选 AI 网关服务的组合，使用时直接在根目录执行。

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

如果你当前不需要连接外部 AI 服务，可以在 `.env` 中设置 `AI_MOCK=1`，应用服务仍可独立完成主要功能流程。

## 环境变量说明

下表按用途分组列出关键变量，默认值来自 `.env.example`。

### AI 组

| 变量 | 默认值 | 何时需要修改 | 常见值 |
| --- | --- | --- | --- |
| `AI_API_KEY` | 空 | 接入在线 AI 服务时必须填写 | 你在网关或平台申请的密钥 |
| `AI_BASE_URL` | `https://api.openai.com/v1` | 更换接口地址时 | 内网网关地址或第三方兼容地址 |
| `AI_MODEL` | `gemini-3-flash-preview` | 调整默认模型时 | 你可用的兼容模型名 |
| `AI_WRITER_MODEL` | 空 | 需要把生成模型和默认模型分开时 | 某个写作或出题模型名 |
| `AI_CHECKER_MODEL` | 空 | 需要单独校验模型时 | 某个校验模型名 |
| `AI_MOCK` | `0` | 无密钥演示或本地离线测试时 | `1` 表示启用离线演示 |

### 应用与数据组

| 变量 | 默认值 | 何时需要修改 | 常见值 |
| --- | --- | --- | --- |
| `APP_DB_PATH` | `data/app.db` | 需要改主数据库路径时 | 绝对路径或新的相对路径 |
| `APP_TIMEZONE` | `Asia/Shanghai` | 需要改日期切换时区时 | `Asia/Shanghai` `UTC` |

### 登录与多用户组

| 变量 | 默认值 | 何时需要修改 | 常见值 |
| --- | --- | --- | --- |
| `APP_REQUIRE_LOGIN` | `1` | 本地调试要临时关闭登录时 | `0` 或 `1` |
| `APP_MULTIUSER_BY_IDENTITY` | `1` | 只想使用单库模式时 | `0` 或 `1` |
| `APP_USER_DB_DIR` | `data/userdb` | 需要移动多用户数据库目录时 | 新目录路径 |
| `APP_DEV_USER_IDENTITY` | 空 | 关闭登录但又想模拟用户隔离时 | 测试邮箱或标识字符串 |

### 安全组

| 变量 | 默认值 | 何时需要修改 | 常见值 |
| --- | --- | --- | --- |
| `APP_AUTH_DB_PATH` | `data/auth.db` | 需要改认证库位置时 | 新路径 |
| `APP_AUTH_SECRET_KEY` | `change-me-long-random` | 生产环境必须改密钥时 | 长随机字符串 |
| `APP_AUTH_COOKIE_NAME` | `vs_session` | 与现有系统冲突时 | 自定义 Cookie 名 |
| `APP_AUTH_COOKIE_DAYS` | `30` | 需要更短或更长登录有效期时 | `7` `14` `30` |
| `APP_BASIC_AUTH_USER` | 空 | 需要站点级账号保护时 | 自定义用户名 |
| `APP_BASIC_AUTH_PASS` | 空 | 需要站点级账号保护时 | 高强度密码 |
| `APP_BASIC_AUTH_REALM` | `Vocabulary Study` | 需要改浏览器弹窗提示时 | 自定义站点名 |

### 复习算法组

| 变量 | 默认值 | 何时需要修改 | 常见值 |
| --- | --- | --- | --- |
| `SRS_DESIRED_RETENTION` | `0.9` | 需要调整复习密度时 | `0.85` `0.9` `0.95` |

## 日常操作手册

### 任务 A 导入词书

入口路由 `http://127.0.0.1:8000/library` 或 `http://127.0.0.1:8000/words`。

执行步骤
1. 在词书库页面选择词书并点击导入，或者在单词页批量导入文本和表格。
2. 导入完成后进入词书页确认词条数量。
3. 返回今日页准备加入学习计划。

结果预期
- 词书在 `/decks` 可见。
- 词条在 `/words` 可检索。

### 任务 B 加入学习计划并开始复习

入口路由 `http://127.0.0.1:8000/` 和 `http://127.0.0.1:8000/review`。

执行步骤
1. 在今日页或词书页把词条加入学习计划。
2. 进入今日学习完成评分。
3. 当天结束后查看剩余任务和下次到期时间。

结果预期
- `/review` 页面出现待学词。
- 评分后复习状态和下次时间自动更新。

### 任务 C 在错词篮生成短文练习

入口路由 `http://127.0.0.1:8000/mistakes`。

执行步骤
1. 打开错词篮直接点击生成短文练习。
2. 如需细调，再展开高级设置调整难度和篇幅。
3. 提交后进入练习页完成答题和判分。

结果预期
- 生成结果保存在 `/simulations`。
- 练习结果可在历史中再次查看。

### 任务 D 家长模式生成 打印 批改作业

入口路由 `http://127.0.0.1:8000/settings` `http://127.0.0.1:8000/worksheets` `http://127.0.0.1:8000/worksheets/{worksheet_id}`。

执行步骤
1. 在设置页切换到家长模式并保存阶段参数。
2. 在作业页生成今日作业并打印。
3. 孩子完成后进入批改视图勾选错词并提交。

结果预期
- 错词写回复习系统。
- 下次作业和复习会自动提高对这些词的关注。

### 任务 E 清空本地数据

入口命令 `reset-data.cmd`。

执行步骤
1. 在项目根目录运行 `reset-data.cmd`。
2. 在确认提示里输入 `YES`。
3. 脚本执行完成后重启服务。

结果预期
- 本地 SQLite 数据清空。
- 词书 单词 复习记录 错词记录和短文记录被移除。

## 测试与质量保障

### 基础依赖安装

```bash
pip install -r requirements.txt
pip install -r requirements-dev.txt
```

### 核心回归测试 与持续集成一致

```bash
pytest tests/test_auth_feedback.py tests/test_onboarding_state.py tests/test_worksheets_question_types.py tests/test_worksheets_reading.py -q
```

### 全量本地回归

```bash
pytest -q
```

### 移动端审计测试

先安装浏览器驱动。

```bash
python -m playwright install chromium
```

再执行移动端审计，下面命令与仓库中的工作流保持一致。

```bash
RUN_E2E_MOBILE=1 E2E_MAX_CLICKS=4 E2E_STRICT=1 pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q
```

需要更严格覆盖时把点击数提升到 `12`。

```bash
RUN_E2E_MOBILE=1 E2E_MAX_CLICKS=12 E2E_STRICT=1 pytest tests/e2e_mobile/test_mobile_navigation_audit.py -q
```

说明
- `tests/e2e_mobile/test_mobile_navigation_audit.py` 默认会跳过，只有 `RUN_E2E_MOBILE=1` 才会启用。
- 其余单元测试不依赖该变量，默认可直接运行。

## 部署与团队分享

### 服务器部署流程

部署日期建议记录在你自己的运维日志里，以下流程可直接在 Linux 服务器执行。

```bash
git clone https://github.com/chixi4/fast-english.git
cd fast-english
cp .env.example .env
```

修改 `.env` 的关键项
- 把 `APP_AUTH_SECRET_KEY` 改成高强度随机值。
- 按实际情况设置 `APP_REQUIRE_LOGIN`。
- 如果暂时不接在线 AI，把 `AI_MOCK=1`。

启动服务

```bash
docker compose up -d --build
docker compose ps
```

访问地址
- 本机访问 `http://127.0.0.1:8000`
- 局域网或公网访问 `http://服务器IP:8000`

### 团队分享流程 Cloudflare Tunnel 加 Access

这套流程用于把你本机服务安全分享给团队成员，步骤以 Windows 为例。

一键初始化

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\cf_full_setup.ps1
```

启动应用并启动隧道

```cmd
start-all.cmd
```

如果你希望分开启动，也可以用两段命令。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\share.ps1
```

Access 配置核心项
1. 在 Cloudflare Zero Trust 新建 Self-hosted 应用。
2. 绑定你的域名，例如 `yuookie.qzz.io`。
3. 在身份验证里启用邮箱一次性验证码。
4. 在访问策略里允许团队成员邮箱。

多用户隔离说明
- 当 Access 带上用户身份头 `Cf-Access-Authenticated-User-Email` 时，系统会按身份写入独立数据库文件。
- 文件路径默认在 `data/userdb`。
- 你可以通过 `APP_MULTIUSER_BY_IDENTITY` 开关控制是否启用隔离。

### 最小安全清单

1. 生产环境必须启用登录，不要把 `APP_REQUIRE_LOGIN` 长期设为 `0`。
2. 必须替换 `APP_AUTH_SECRET_KEY`，不要保留模板默认值。
3. 对公网暴露前要配置 Access 或 `APP_BASIC_AUTH_USER` 与 `APP_BASIC_AUTH_PASS`。
4. 管理端口和内部网关端口不要直接暴露给不可信来源。

## 移动端可视化调试

这个工具用于在桌面浏览器里复现手机页面问题，并把过程保存成可追溯证据。

### 启动命令

```powershell
.\tools\start_visual_debug.ps1 -Url "https://yuookie.qzz.io/" -Profile "real-mobile-bug"
```

无头短跑命令

```powershell
.\tools\start_visual_debug.ps1 -Headless -RunSeconds 8 -NoVideo
```

### 关键交互

在页面上按住 `Alt + Shift` 后点击目标元素，右下角会打开注释面板，保存后会进入本次调试时间线。

### 产物目录

所有产物写入 `artifacts/visual_debug/<时间戳>-<profile>/`，其中最关键文件如下。

- `SUMMARY.md` 包含核心结论和时间线摘要。
- `session.json` 包含完整事件流。
- `last_page.png` 是结束时页面截图。
- `nav_diag.json` 是诊断接口拉取结果。
- `videos/` 存放录屏。

## 项目结构与关键文件

```text
app/
  main.py                 主路由与页面逻辑
  models.py               数据模型
  db.py                   业务数据库会话与多用户分库
  auth_db.py              认证数据库会话
  config.py               环境变量读取
  templates/              页面模板
  static/                 前端静态资源

tests/
  test_auth_feedback.py
  test_onboarding_state.py
  test_worksheets_question_types.py
  test_worksheets_reading.py
  e2e_mobile/             移动端审计测试

docs/
  IMPLEMENTATION.md
  PARENT_MODE_MVP.md
  DESKTOP_VISUAL_DEBUG_WORKFLOW.md
  SHARE_WITH_TEAM.md
  DEPLOY_SERVER.md

tools/
  start_visual_debug.ps1
  desktop_visual_debug.py
  cf_full_setup.ps1
  share.ps1
  one_click_share.ps1
  reset_data.py
```

## 路由速查

### 自学域

| 路由 | 用途 |
| --- | --- |
| `/` | 今日页面与任务总览 |
| `/review` | 今日学习与评分 |
| `/mistakes` | 错词聚合与练习生成 |
| `/practice` | 练习入口页 |
| `/simulations` | 短文练习历史列表 |
| `/simulations/{sim_id}` | 练习详情与答题 |
| `/simulations/{sim_id}/retest` | 错词复测页面 |

### 家长域

| 路由 | 用途 |
| --- | --- |
| `/worksheets` | 作业列表与生成入口 |
| `/worksheets/{worksheet_id}` | 作业详情 打印与批改入口 |
| `/worksheets/{worksheet_id}/grade` | 提交勾选错词 |

### 管理与数据域

| 路由 | 用途 |
| --- | --- |
| `/settings` | 模式切换与系统设置 |
| `/decks` | 词书列表 |
| `/decks/{deck_id}` | 词书详情与加计划 |
| `/words` | 单词列表与批量导入 |
| `/library` | 词书库导入入口 |
| `/dashboard` | 学习看板 |
| `/analytics` | 分析页面 |
| `/api/analytics/dashboard` | 看板数据接口 |
| `/api/diagnostics/nav` | 导航链路诊断导出 |

### 认证与引导域

| 路由 | 用途 |
| --- | --- |
| `/auth/login` | 登录 |
| `/auth/register` | 注册 |
| `/auth/logout` | 退出登录 |
| `/api/onboarding/state` | 新手引导状态查询 |
| `/api/onboarding/action` | 新手引导动作提交 |

## FAQ

### 本地能启动但页面提示 AI 未配置

这是正常现象，说明你当前没有填密钥且未开启离线演示，只要把 `.env` 中 `AI_MOCK` 设为 `1` 并重启服务，系统就会走离线演示流程。

### Windows 终端提示脚本执行被禁止

你可以直接运行 `run.cmd`，也可以继续使用 Python 手动启动命令，这两种方式都不依赖 PowerShell 执行策略。

### 团队成员登录后数据互相干扰

先确认 `APP_MULTIUSER_BY_IDENTITY=1`，再确认共享链路已经启用 Access 并且请求里带有身份头，满足这两个条件后系统会按身份写入不同数据库文件。

### 移动端审计测试没有执行

请先执行 `python -m playwright install chromium`，然后在命令前加上 `RUN_E2E_MOBILE=1`，否则该测试文件会按默认逻辑跳过。

### 一键清库后页面仍显示旧数据

通常是服务进程尚未重启或浏览器缓存未刷新，先重启服务，再强制刷新页面，数据会与新库状态一致。

## 深入文档

- `docs/IMPLEMENTATION.md` 详细实现说明
- `docs/PARENT_MODE_MVP.md` 家长模式说明
- `docs/DESKTOP_VISUAL_DEBUG_WORKFLOW.md` 可视化调试说明
- `docs/SHARE_WITH_TEAM.md` 团队分享说明
- `docs/DEPLOY_SERVER.md` 服务器部署说明
