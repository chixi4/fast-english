# 截图对比目录说明

本目录用于存放安卓截图、网页截图及 PNG 差异对比结果，命名必须与 `scenarios.json` 中的 `id` 完全一致。

## 目录结构

- `android/` 安卓截图基线
- `web/` 网页自动截图输出
- `diff/` 像素差异图输出
- `report/` 对比汇总报告
- `scenarios.json` 场景清单

## 运行步骤

1. 安装安卓截图工具

```bash
npm run android:setup
```

该命令会下载 Android Platform Tools 到项目目录 `tools/android-sdk/platform-tools`。

2. 采集安卓截图

```bash
npm run screenshot:android
```

脚本会按场景清单逐个提示，按回车后自动执行 `adb exec-out screencap -p`，并保存到 `android/`。

3. 生成网页截图

```bash
npm run screenshot:web
```

4. 安卓截图也可手工放入 `screenshot_compare/android/`，文件名与场景 ID 对齐，例如：

- `learning_recognition.png`
- `search_home.png`

5. 运行像素对比

```bash
npm run screenshot:compare
```

6. 查看报告

- `screenshot_compare/report/compare_summary.md`
- `screenshot_compare/report/compare_summary.json`

## 备注

- 当前脚本默认网页分辨率为 `412 x 915`，建议安卓截图也使用同等视口尺寸，减少尺寸差异带来的误报。
- 如果安卓截图尺寸不同，脚本会自动补白后再对比，并在报告里保留原始尺寸。
- Linux 环境若缺少浏览器依赖库，可先执行 `npx playwright install-deps chromium` 安装系统依赖。
- `screenshot:android` 会优先使用项目内 `tools/android-sdk/platform-tools/adb`，找不到时再回退到系统 adb。
