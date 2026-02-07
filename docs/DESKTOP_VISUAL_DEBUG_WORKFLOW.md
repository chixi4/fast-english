# 桌面可视化反馈工具（移动端仿真）

## 目标
用电脑浏览器复现手机端问题，并在页面上直接打注释，导出可读的时间线和网络日志。

## 功能
- 移动端设备仿真（默认 `Pixel 7`）
- 自动记录：`navigate / click / annotation / request / response / request_failed / console`
- `Alt + Shift + 点击` 任意元素可打开注释面板
- 输出产物到 `artifacts/visual_debug/<时间戳>-<profile>/`

## 快速启动
```powershell
.\tools\start_visual_debug.ps1 -Url "https://yuookie.qzz.io/" -Profile "real-mobile-bug"
```

无头短跑（做冒烟验证）：
```powershell
.\tools\start_visual_debug.ps1 -Headless -RunSeconds 8 -NoVideo
```

有头模式下如需更窄的手机窗口：
```powershell
python tools\desktop_visual_debug.py --url "https://yuookie.qzz.io/" --window-width 430 --window-height 920
```

## 交互说明
1. 正常点击页面进行复现。
2. 需要备注问题时：`Alt + Shift + 点击目标元素`。
3. 在右下角面板输入注释，点“保存注释”。
4. 关闭浏览器（或 `Ctrl+C`）结束本次采集。

## 产物说明
- `SUMMARY.md`：核心摘要（注释列表、关键操作时间线、慢请求）
- `session.json`：完整事件流
- `last_page.png`：结束时页面截图
- `nav_diag.json`：`/api/diagnostics/nav` 拉取结果
- `videos/`：浏览器录屏（默认开启）

## 常见问题
1. 之前出现 `Page.handleJavaScriptDialog` 报错：
   - 该版本已不使用 `prompt/alert`，改为页面内注释面板，避免该类崩溃。
2. 看不到注释记录：
   - 检查 `SUMMARY.md` 里的“你加的注释”章节。
3. 想调手机宽度：
   - `-Device` 改为其他 Playwright 设备名。
