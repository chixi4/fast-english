# Codex 窗口桥接使用说明

这个目录里有两类脚本，分别解决两件事。

- `codex-window-control.ps1` 负责操作可见窗口，支持开窗口、向窗口输入、读取这一次输入对应的最新回复
- `codex-bridge.ps1` 负责读取 Codex 会话文件，支持按会话和时间过滤最新回复

## 你要的核心能力

现在已经是强绑定流程。

第一步把文本发进你屏幕上可见的 Codex 窗口时，脚本会记录这一笔请求的 UTC 时间。

第二步读取回复时，脚本会自动用这个时间做过滤，只返回这一次输入之后的新回复，避免读到历史旧回复。

状态文件位置如下。

- `tools/openclaw-node/.state/codex-window-last-request.json`

## 可直接复制的本机命令

推荐优先使用原子脚本 `codex-visible-ops.ps1`。它会自动完成窗口定位、输入、输出回传、截图证明，适合手机远程控制。

### 0. 原子模式 新开一个可见 Codex 窗口

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-visible-ops.ps1 -Action new -Workdir D:\dev\vocabulary-study -WindowQuery gpt-5.3-codex
```

### 0.1 原子模式 查看当前活跃 Codex 窗口状态

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-visible-ops.ps1 -Action peek -WindowQuery gpt-5.3-codex
```

### 0.2 原子模式 在活跃窗口继续发要求并回传结果

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-visible-ops.ps1 -Action ask -WindowQuery gpt-5.3-codex -Text "请只回复 hello"
```

如果你已知窗口句柄，也可绑定到指定窗口。

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-visible-ops.ps1 -Action ask -WindowHwnd 14422920 -Text "继续上一步任务"
```

### 1. 查看可见窗口

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action list_windows
```

### 2. 打开可见 Codex 窗口

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action open_codex -Workdir D:\dev\vocabulary-study -Model gpt-5.3-codex -UseYolo true
```

说明如下。

- 如果当前 Codex 版本支持 `--yolo`，会使用 `codex -m gpt-5.3-codex --yolo`
- 如果不支持 `--yolo`，会自动回退到 `--dangerously-bypass-approvals-and-sandbox`

### 3. 向可见 Codex 窗口继续输入

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action send_text -WindowQuery gpt-5.3-codex -Text "请只回复 hello" -PressEnter true
```

### 4. 读取刚才那一次输入的最新回复

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action latest_output
```

这条命令默认会读取上一次 `send_text` 记录的请求时间并过滤。

### 4.1 抓取当前可见 Codex 窗口截图

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action capture_window -WindowQuery gpt-5.3-codex -WindowPadding 10
```

这条命令会返回 `data.screenshot.url`，可直接在手机浏览器查看。

### 5. 指定会话和时间手动读取

```powershell
powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action latest_output -SessionId 019c475c-4345-74f0-b874-3a21b01a9147 -SinceIso 2026-02-10T11:51:27.4044780Z -UseLastRequest false
```

## Discord 里建议的调用口令模板

你在 Discord 里让 Claw 调用本机节点时，参数保持和下面一致。

### 模板一 开可见窗口

`nodes run node=你的Windows节点 cmd="powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action open_codex -Workdir D:\dev\vocabulary-study -Model gpt-5.3-codex -UseYolo true"`

### 模板二 向窗口输入

`nodes run node=你的Windows节点 cmd="powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action send_text -WindowQuery gpt-5.3-codex -Text \"请只回复 hello\" -PressEnter true"`

### 模板三 拉取这一次输出

`nodes run node=你的Windows节点 cmd="powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action latest_output"`

### 模板四 拉取当前可见窗口截图

`nodes run node=你的Windows节点 cmd="powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-window-control.ps1 -Action capture_window -WindowQuery gpt-5.3-codex -WindowPadding 10"`

### 模板五 原子新开窗口并进入指定目录

`nodes run node=你的Windows节点 cmd="powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-visible-ops.ps1 -Action new -Workdir D:\dev\vocabulary-study -WindowQuery gpt-5.3-codex"`

### 模板六 原子继续提要求并回传文本加截图

`nodes run node=你的Windows节点 cmd="powershell -ExecutionPolicy Bypass -File D:\dev\vocabulary-study\tools\openclaw-node\codex-visible-ops.ps1 -Action ask -WindowQuery gpt-5.3-codex -Text \"继续当前任务并只给最终结论\""`

## 返回结果里重点看哪些字段

- `data.bridge.latest_assistant` 是最新回复正文
- `data.bridge.latest_assistant_timestamp` 是这条回复时间
- `data.effective_since` 是用于过滤的起始时间
- `data.last_request` 是上一次窗口输入记录
- `data.screenshot.url` 是当前可见窗口截图链接
