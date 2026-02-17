---
name: codex-visible-ops
description: Control Windows visible Codex CLI windows using actions new peek and ask. Use this for natural language requests about progress, continuing work, or opening a new Codex window in a target folder.
user-invocable: true
disable-model-invocation: false
---

# codex-visible-ops

Use this skill whenever the user asks in Chinese or English to control Codex on their Windows laptop.

Node target priority:
- `LAPTOP-2VGALCCI`
- `Lenovo-Laptop`

Atomic script path:
- `D:\\dev\\vocabulary-study\\tools\\openclaw-node\\codex-visible-ops.ps1`

## Natural language mapping

If user asks what Codex is doing now, map to `peek`.
If user asks continue current Codex task, map to `ask`.
If user asks open a new Codex in some folder, map to `new`.

Common Chinese intents:
- 看看现在进度
- 现在 codex 在做什么
- 继续刚才那个任务
- 在 D 盘某目录新开一个 codex
- 把最新结果发给我

## Execute actions

1) `new <workdir>`

Invoke node command:
["powershell","-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File","D:\\dev\\vocabulary-study\\tools\\openclaw-node\\codex-visible-ops.ps1","-Action","new","-Workdir","<workdir>","-WindowQuery","gpt-5.3-codex"]

Default `<workdir>`:
- `D:\\dev\\vocabulary-study`

2) `peek`

Invoke node command:
["powershell","-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File","D:\\dev\\vocabulary-study\\tools\\openclaw-node\\codex-visible-ops.ps1","-Action","peek","-WindowQuery","gpt-5.3-codex","-RouteWorkdir","D:\\dev\\openclaw-codex-lab"]

3) `ask <text>`

Invoke node command:
["powershell","-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File","D:\\dev\\vocabulary-study\\tools\\openclaw-node\\codex-visible-ops.ps1","-Action","ask","-WindowQuery","gpt-5.3-codex","-RouteWorkdir","D:\\dev\\openclaw-codex-lab","-Text","<text>","-MaxWaitSeconds","120","-PollIntervalMs","1200","-PollMaxTries","40"]

Keep `<text>` exactly as user says.

For `nodes` action `run`, set `timeout_ms` to at least `180000`.

## Reply contract

Always include these keys in user-facing response:
- `latest_assistant`
- `latest_assistant_timestamp`
- `screenshot_url`
- `target_window.hwnd`

If action is `new`, also include:
- `workdir`
- `open_window.pid`
- `open_window.hwnd`

If failure happens, return:
- `error`
- `poll_tries`
- `screenshot_url` when available

If node is disconnected, instruct exactly this one-click command:
- `D:\\dev\\vocabulary-study\\tools\\openclaw-node\\start-openclaw-node.cmd`

## Failure reason mapping hard rule

When parsing `failure_reason` from script output, use exact mapping below and do not invent alternate reason text.

- `node_disconnected` or `bridge_unavailable`:
  - You may say node is disconnected or unavailable.
  - Recovery command is `D:\\dev\\vocabulary-study\\tools\\openclaw-node\\start-openclaw-node.cmd`.

- `session_missing`, `assistant_missing`, `assistant_stale`, `screenshot_stale`:
  - You must say node is online, but no fresh output is available yet.
  - You must not say disconnected.
  - Keep `failure_reason` value in response text.

## Strict output guard

For normal user chats, do not dump raw JSON and do not start with hwnd or pid.

Output format must be:
- 状态：<一句中文结论>
- 结果：<latest_assistant>
- 截图：<screenshot_url>
- 窗口：<target_window.hwnd>

Do not include these unless user explicitly asks technical detail:
- pid
- title
- tracker
- request_id
- session_id
- raw JSON payload

## Action-first behavior

When user says "试试", "看下", "继续", "发我", execute matching action immediately.
Do not ask follow-up before first run when intent is clear.

## Workdir routing behavior

If user explicitly mentions a Windows folder path, use it.

- For `peek`, append `-RouteWorkdir <path>`.
- For `ask`, append `-RouteWorkdir <path>`.
- For `new`, append `-Workdir <path>`.

If route binding is missing, `ask` may auto-open a new Codex window. This is expected behavior.

## Multi-window intent behavior

For intents asking "how many codex windows" or "which codex windows", include:
- `codex_windows_count`
- a short hwnd list from `codex_windows`
- latest assistant summary
- screenshot url
