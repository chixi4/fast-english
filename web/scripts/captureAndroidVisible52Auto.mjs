import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const compareRoot = path.join(projectRoot, "screenshot_compare");
const featuresPath = path.join(compareRoot, "visible52_features.json");
const androidDir = path.join(compareRoot, "android_visible52");
const reportDir = path.join(compareRoot, "report");
const localAdbPath = path.join(projectRoot, "tools", "android-sdk", "platform-tools", "adb");
const defaultWindowsAdbPath = "/mnt/c/adbtemp/adb.exe";
const packageName = "com.kaoyan.wordhelper";

const TAB_COORDS = {
  学习: [147, 2660],
  查词: [469, 2660],
  词库: [791, 2660],
  我的: [1113, 2660],
};

const STEP_TEXT_CHECKS = {
  1: [{ text: "认词模式" }, { text: "拼写模式" }],
  13: [{ text: "复习时间", contains: true }],
  19: [{ text: "请输入单词拼写", contains: true }],
  21: [{ text: "首字母", contains: true }],
  22: [{ text: "长度", contains: true }],
  24: [{ text: "请抄写正确拼写后继续", contains: true }],
  28: [{ text: "长句解析", contains: true }],
  30: [{ text: "abandon", contains: true }],
  31: [{ text: "AI 中文翻译", contains: true }],
  33: [{ text: "AI 助记", contains: true }],
  35: [{ text: "长句解析", contains: true }],
  36: [{ text: "我的词库", contains: true }],
  38: [{ text: "导出词书", contains: true }],
  40: [{ text: "全选" }, { text: "确认" }],
  43: [{ text: "我的词库", contains: true }],
  44: [{ text: "清空生词本", contains: true }],
  46: [{ text: "词书构建教程", contains: true }],
  48: [{ text: "学习统计", contains: true }],
  49: [{ text: "学习数据", contains: true }],
  50: [{ text: "我的", contains: true }],
  51: [{ text: "今日新词选择", contains: true }],
  52: [{ text: "实验室", contains: true }],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveAdb() {
  const fromEnv = process.env.ADB_EXECUTABLE?.trim();
  if (fromEnv) {
    return fs
      .stat(fromEnv)
      .then(() => fromEnv)
      .catch(() => localAdbPath);
  }

  return fs
    .stat(localAdbPath)
    .then(() => localAdbPath)
    .catch(() =>
      fs
        .stat(defaultWindowsAdbPath)
        .then(() => defaultWindowsAdbPath)
        .catch(() => "adb"),
    );
}

function runAdb(adbExecutable, args, options = {}) {
  const encoding = Object.prototype.hasOwnProperty.call(options, "encoding")
    ? options.encoding
    : "utf8";
  const stdio = Object.prototype.hasOwnProperty.call(options, "stdio")
    ? options.stdio
    : "pipe";
  const maxBuffer = Object.prototype.hasOwnProperty.call(options, "maxBuffer")
    ? options.maxBuffer
    : 30 * 1024 * 1024;
  const timeout = Object.prototype.hasOwnProperty.call(options, "timeout")
    ? options.timeout
    : 16_000;
  return execFileSync(adbExecutable, args, {
    encoding,
    maxBuffer,
    stdio,
    timeout,
  });
}

function ensureAdbReady(adbExecutable) {
  try {
    runAdb(adbExecutable, ["version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "未找到 adb，请先执行 npm run android:setup 下载 Android Platform Tools，或自行安装 adb 到系统环境变量",
    );
  }

  const outputText = runAdb(adbExecutable, ["devices"]);
  const onlineDevices = outputText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice"));

  if (onlineDevices.length === 0) {
    throw new Error("未检测到在线安卓设备，请连接手机并开启 USB 调试");
  }
}

async function loadFeatures() {
  const exists = await fs.stat(featuresPath).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error("缺少 visible52_features.json，请先执行 npm run qa:visible52 或 npm run screenshot:web:visible52");
  }
  const content = await fs.readFile(featuresPath, "utf8");
  return JSON.parse(content);
}

async function cleanAndroidScreenshots() {
  await fs.mkdir(androidDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  const files = await fs.readdir(androidDir);
  await Promise.all(
    files
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => fs.unlink(path.join(androidDir, name))),
  );
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function parseNodes(xml) {
  const nodes = [];
  const tagMatches = xml.matchAll(/<node\b([^>]*)>/g);
  for (const tag of tagMatches) {
    const attrs = {};
    const attrMatches = tag[1].matchAll(/([a-zA-Z0-9:_-]+)="([^"]*)"/g);
    for (const attr of attrMatches) {
      attrs[attr[1]] = decodeXml(attr[2]);
    }
    nodes.push(attrs);
  }
  return nodes;
}

function boundsCenter(bounds) {
  const match = bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return null;
  const x = Math.floor((Number(match[1]) + Number(match[3])) / 2);
  const y = Math.floor((Number(match[2]) + Number(match[4])) / 2);
  return { x, y };
}

function findNode(nodes, predicate) {
  return nodes.find(predicate) ?? null;
}

function findNodeByText(nodes, text, contains = false) {
  return findNode(nodes, (node) => {
    const value = (node.text ?? "").trim();
    if (!value) return false;
    if (contains) return value.includes(text);
    return value === text;
  });
}

function findNodeByDesc(nodes, desc, contains = false) {
  return findNode(nodes, (node) => {
    const value = (node["content-desc"] ?? "").trim();
    if (!value) return false;
    if (contains) return value.includes(desc);
    return value === desc;
  });
}

function parseBounds(bounds) {
  const match = bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  if (!match) return null;
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

function boundsContainPoint(bounds, x, y) {
  const box = parseBounds(bounds);
  if (!box) return false;
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

function captureOne(adbExecutable, id) {
  const pngBuffer = runAdb(adbExecutable, ["exec-out", "screencap", "-p"], {
    encoding: null,
    maxBuffer: 25 * 1024 * 1024,
  });
  return fs.writeFile(path.join(androidDir, `${id}.png`), pngBuffer);
}

function tap(adbExecutable, x, y) {
  runAdb(adbExecutable, ["shell", "input", "tap", String(x), String(y)], { stdio: "ignore" });
}

function swipe(adbExecutable, x1, y1, x2, y2, duration = 320) {
  runAdb(
    adbExecutable,
    ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(duration)],
    { stdio: "ignore" },
  );
}

function inputText(adbExecutable, text) {
  runAdb(adbExecutable, ["shell", "input", "text", text], { stdio: "ignore" });
}

function keyevent(adbExecutable, keyCode) {
  runAdb(adbExecutable, ["shell", "input", "keyevent", String(keyCode)], { stdio: "ignore" });
}

function launchApp(adbExecutable) {
  try {
    runAdb(adbExecutable, ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"], {
      stdio: "ignore",
    });
  } catch {
    runAdb(adbExecutable, ["shell", "am", "start", "-n", `${packageName}/.MainActivity`], {
      stdio: "ignore",
      timeout: 20_000,
    });
  }
}

function getForegroundPackage(adbExecutable) {
  const output = runAdb(adbExecutable, ["shell", "dumpsys", "activity", "activities"], {
    maxBuffer: 40 * 1024 * 1024,
  });
  const topMatch = output.match(/topResumedActivity=ActivityRecord\{[^\}]*\s([a-zA-Z0-9._]+)\/[a-zA-Z0-9.$_]+/);
  if (topMatch?.[1]) {
    return topMatch[1];
  }
  const resumedMatch = output.match(/ResumedActivity:\s+ActivityRecord\{[^\}]*\s([a-zA-Z0-9._]+)\/[a-zA-Z0-9.$_]+/);
  if (resumedMatch?.[1]) {
    return resumedMatch[1];
  }
  return "";
}

function isKeyboardShown(adbExecutable) {
  const output = runAdb(adbExecutable, ["shell", "dumpsys", "input_method"], {
    maxBuffer: 18 * 1024 * 1024,
  });
  return output.includes("mInputShown=true");
}

async function dismissKeyboardIfNeeded(adbExecutable) {
  try {
    if (isKeyboardShown(adbExecutable)) {
      keyevent(adbExecutable, 4);
      await sleep(260);
    }
  } catch {
    // 键盘状态查询失败时不阻断主流程
  }
}

async function ensureAppForeground(adbExecutable, options = {}) {
  const {
    retries = 4,
    delayMs = 700,
  } = options;

  for (let i = 0; i <= retries; i += 1) {
    const pkg = getForegroundPackage(adbExecutable);
    if (pkg === packageName) {
      return true;
    }
    launchApp(adbExecutable);
    await sleep(delayMs);
  }
  return false;
}

async function assertAppForeground(adbExecutable, context) {
  const pkg = getForegroundPackage(adbExecutable);
  if (pkg !== packageName) {
    throw new Error(`${context} 时前台应用漂移，当前包名 ${pkg || "未知"}`);
  }
}

function getDumpNodes(adbExecutable) {
  const pkg = getForegroundPackage(adbExecutable);
  if (pkg !== packageName) {
    throw new Error(`读取页面结构失败，当前前台应用不是目标应用，包名 ${pkg || "未知"}`);
  }
  runAdb(adbExecutable, ["shell", "uiautomator", "dump", "/sdcard/uidump.xml"], { stdio: "ignore" });
  const xml = runAdb(adbExecutable, ["exec-out", "cat", "/sdcard/uidump.xml"]);
  return parseNodes(xml);
}

function tapTab(adbExecutable, tabName) {
  const coords = TAB_COORDS[tabName];
  if (!coords) return;
  tap(adbExecutable, coords[0], coords[1]);
}

async function dismissUnexpectedPopups(adbExecutable) {
  const nodes = getDumpNodes(adbExecutable);
  const backupHint = findNodeByText(nodes, "备份你的集合", true);
  if (backupHint) {
    const later =
      findNodeByText(nodes, "稍后", true) ||
      findNodeByText(nodes, "以后再说", true) ||
      findNodeByText(nodes, "暂不", true) ||
      findNodeByText(nodes, "取消", true);
    if (later) {
      const center = boundsCenter(later.bounds);
      if (center) {
        tap(adbExecutable, center.x, center.y);
        await sleep(420);
      }
    } else {
      keyevent(adbExecutable, 4);
      await sleep(320);
    }
  }
}

async function tapByText(adbExecutable, text, options = {}) {
  const {
    contains = false,
    retries = 2,
    delayMs = 500,
  } = options;

  for (let i = 0; i <= retries; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const node = findNodeByText(nodes, text, contains);
    if (node) {
      const center = boundsCenter(node.bounds);
      if (center) {
        tap(adbExecutable, center.x, center.y);
        await sleep(delayMs);
        return true;
      }
    }
    await sleep(220);
  }
  return false;
}

async function tapByDesc(adbExecutable, desc, options = {}) {
  const {
    contains = false,
    retries = 2,
    delayMs = 500,
  } = options;

  for (let i = 0; i <= retries; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const node = findNodeByDesc(nodes, desc, contains);
    if (node) {
      const center = boundsCenter(node.bounds);
      if (center) {
        tap(adbExecutable, center.x, center.y);
        await sleep(delayMs);
        return true;
      }
    }
    await sleep(220);
  }
  return false;
}

function clearFocusedInput(adbExecutable, maxDeletes = 36) {
  keyevent(adbExecutable, 123);
  for (let i = 0; i < maxDeletes; i += 1) {
    keyevent(adbExecutable, 67);
  }
}

function hasTextInNodes(nodes, text, contains = false) {
  return !!findNodeByText(nodes, text, contains);
}

function isMainTabSubPage(nodes) {
  const subPageHints = [
    "今日新词选择",
    "实验室",
    "学习数据",
    "词书构建教程",
    "AI 中文翻译",
    "导出词书",
  ];
  if (subPageHints.some((text) => hasTextInNodes(nodes, text, true))) {
    return true;
  }
  if (findNodeByText(nodes, "返回", false)) {
    return true;
  }
  if (findNodeByDesc(nodes, "返回", true) || findNodeByDesc(nodes, "Navigate up", true)) {
    return true;
  }
  return false;
}

async function hasTextOnScreen(adbExecutable, text, contains = false) {
  const nodes = getDumpNodes(adbExecutable);
  return hasTextInNodes(nodes, text, contains);
}

async function verifyStepUi(adbExecutable, stepIndex) {
  const checks = STEP_TEXT_CHECKS[stepIndex];
  if (!checks || checks.length === 0) {
    return true;
  }
  const nodes = getDumpNodes(adbExecutable);
  if (stepIndex === 50) {
    return hasTextInNodes(nodes, "学习统计", true) || hasTextInNodes(nodes, "数据管理", true);
  }
  for (const check of checks) {
    const found = hasTextInNodes(nodes, check.text, check.contains ?? false);
    if (!found) {
      return false;
    }
  }
  return true;
}

function isChipSelected(nodes, label) {
  const textNode = findNodeByText(nodes, label, false);
  if (!textNode) return false;
  const center = boundsCenter(textNode.bounds);
  if (!center) return false;

  const chipNode = nodes.find((node) => {
    const checkable = String(node.checkable ?? "").toLowerCase() === "true";
    if (!checkable) return false;
    return boundsContainPoint(node.bounds, center.x, center.y);
  });
  if (!chipNode) return false;
  return String(chipNode.checked ?? "").toLowerCase() === "true";
}

async function ensurePlannedWordsDisabled(adbExecutable) {
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "我的");
  await sleep(780);

  for (let i = 0; i < 5; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    if (findNodeByText(nodes, "规划单词", true)) {
      const offSelected = isChipSelected(nodes, "关闭");
      if (!offSelected) {
        await tapByText(adbExecutable, "关闭", { retries: 2, delayMs: 560 });
      }
      return true;
    }
    swipe(adbExecutable, 630, 2200, 630, 900, 320);
    await sleep(440);
  }
  return false;
}

async function ensurePlannedWordsEnabled(adbExecutable) {
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "我的");
  await sleep(780);

  for (let i = 0; i < 5; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    if (findNodeByText(nodes, "规划单词", true)) {
      const onSelected = isChipSelected(nodes, "开启");
      if (!onSelected) {
        await tapByText(adbExecutable, "开启", { retries: 2, delayMs: 560 });
      }
      return true;
    }
    swipe(adbExecutable, 630, 2200, 630, 900, 320);
    await sleep(440);
  }
  return false;
}

async function ensureActiveBook(adbExecutable, bookName) {
  await ensureOnMainTabs(adbExecutable);
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "词库");
  await sleep(700);

  for (let i = 0; i < 4; i += 1) {
    console.log(`BOOK_SWITCH target=${bookName} try=${i + 1}`);
    const nodes = getDumpNodes(adbExecutable);
    const activeBook = findNode(nodes, (node) => {
      const value = (node.text ?? "").trim();
      return value.includes("当前词书") && value.includes(bookName);
    });
    if (activeBook) {
      return true;
    }

    await dismissKeyboardIfNeeded(adbExecutable);
    await tapByText(adbExecutable, "切换", { retries: 1, delayMs: 420 });
    if (bookName.includes("生词本")) {
      tap(adbExecutable, 1045, 930);
    } else {
      tap(adbExecutable, 1045, 1620);
    }
    await sleep(760);
  }
  return false;
}

async function ensureWordInNewWordsBook(adbExecutable, word) {
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "查词");
  await sleep(650);
  await tapByText(adbExecutable, "搜索单词，或粘贴长难句", { contains: true, retries: 2, delayMs: 260 });
  clearFocusedInput(adbExecutable, 44);
  inputText(adbExecutable, word);
  await sleep(820);

  let detailOpened = false;
  for (let i = 0; i < 3; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const resultNode = nodes.find((node) => {
      const value = (node.text ?? "").trim();
      if (!value || !value.includes(word)) return false;
      const center = boundsCenter(node.bounds);
      return !!center && center.y > 500;
    });

    if (resultNode) {
      const center = boundsCenter(resultNode.bounds);
      if (center) {
        tap(adbExecutable, center.x, center.y);
      } else {
        tap(adbExecutable, 250, 760);
      }
    } else {
      tap(adbExecutable, 250, 760);
    }
    await sleep(820);

    detailOpened =
      (await hasTextOnScreen(adbExecutable, "AI 中文翻译", true)) ||
      (await hasTextOnScreen(adbExecutable, "加入生词本", true)) ||
      (await hasTextOnScreen(adbExecutable, "已在生词本", true));
    if (detailOpened) {
      break;
    }
  }

  if (!detailOpened) {
    throw new Error(`未打开 ${word} 的查词详情`);
  }

  const already = await hasTextOnScreen(adbExecutable, "已在生词本", true);
  if (!already) {
    const added = await tapByText(adbExecutable, "加入生词本", { contains: true, retries: 2, delayMs: 520 });
    if (!added) {
      throw new Error(`无法将 ${word} 加入生词本`);
    }
  }
  await safeBack(adbExecutable, { delayMs: 420, fallbackTab: "查词" });
}

async function openSearchResultDetail(adbExecutable, word) {
  for (let i = 0; i < 3; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const resultNode = nodes.find((node) => {
      const value = (node.text ?? "").trim();
      if (!value || !value.includes(word)) return false;
      const center = boundsCenter(node.bounds);
      return !!center && center.y > 500;
    });

    if (resultNode) {
      const center = boundsCenter(resultNode.bounds);
      if (center) {
        tap(adbExecutable, center.x, center.y);
      } else {
        tap(adbExecutable, 250, 760);
      }
    } else {
      tap(adbExecutable, 250, 760);
    }
    await sleep(780);

    const opened =
      (await hasTextOnScreen(adbExecutable, "AI 中文翻译", true)) ||
      (await hasTextOnScreen(adbExecutable, "加入生词本", true)) ||
      (await hasTextOnScreen(adbExecutable, "已在生词本", true));
    if (opened) {
      return true;
    }
    await dismissKeyboardIfNeeded(adbExecutable);
  }
  return false;
}

async function ensureLearningHasWord(adbExecutable) {
  await ensureOnMainTabs(adbExecutable);
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "学习");
  await sleep(760);
  await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 300 });

  if (!(await hasTextOnScreen(adbExecutable, "暂无单词", true))) {
    return true;
  }

  await ensurePlannedWordsEnabled(adbExecutable);
  await ensureActiveBook(adbExecutable, "完整词库");
  tapTab(adbExecutable, "学习");
  await sleep(760);
  await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 300 });
  if (!(await hasTextOnScreen(adbExecutable, "暂无单词", true))) {
    return true;
  }

  const preparedToday = await ensureTodayWordsForLearning(adbExecutable);
  if (preparedToday) {
    return true;
  }

  await ensureWordInNewWordsBook(adbExecutable, "abandon");
  await ensureWordInNewWordsBook(adbExecutable, "abandonment");
  await ensureActiveBook(adbExecutable, "生词本");
  tapTab(adbExecutable, "学习");
  await sleep(760);
  await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 300 });

  return !(await hasTextOnScreen(adbExecutable, "暂无单词", true));
}

async function ensureTodayWordsForLearning(adbExecutable) {
  await ensureOnMainTabs(adbExecutable);
  await ensurePlannedWordsEnabled(adbExecutable);
  await ensureActiveBook(adbExecutable, "完整词库");

  const opened = await openBookDetailWithTodayPlan(adbExecutable);
  if (!opened) {
    return false;
  }

  const clickedTodayPlan =
    (await tapByText(adbExecutable, "今日新词（自主选择）", { contains: true, retries: 1, delayMs: 760 })) ||
    (await tapByText(adbExecutable, "今日新词自主选择", { contains: true, retries: 1, delayMs: 760 }));
  if (!clickedTodayPlan) {
    return false;
  }

  await tapByText(adbExecutable, "随机选取", { contains: true, retries: 1, delayMs: 420 });
  const confirmed =
    (await tapByText(adbExecutable, "确认使用", { contains: true, retries: 2, delayMs: 760 })) ||
    (await tapByText(adbExecutable, "确认", { contains: true, retries: 1, delayMs: 760 }));
  if (!confirmed) {
    tap(adbExecutable, 1050, 1290);
    await sleep(760);
  }

  if (await hasTextOnScreen(adbExecutable, "今日新词选择", true)) {
    await safeBack(adbExecutable, { delayMs: 520, fallbackTab: "学习" });
  } else {
    tapTab(adbExecutable, "学习");
    await sleep(620);
  }
  await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 300 });
  return !(await hasTextOnScreen(adbExecutable, "暂无单词", true));
}

async function prepareLearningSeedData(adbExecutable) {
  await ensureOnMainTabs(adbExecutable);
  await ensurePlannedWordsEnabled(adbExecutable);
  await ensureWordInNewWordsBook(adbExecutable, "abandon");
  await ensureWordInNewWordsBook(adbExecutable, "abandonment");

  const switched = await ensureActiveBook(adbExecutable, "完整词库");
  if (!switched) {
    console.log("WARN 预置阶段无法切换到完整词库，将进入学习队列兜底流程");
  }

  tapTab(adbExecutable, "学习");
  await sleep(820);
  await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 420 });

  if (await hasTextOnScreen(adbExecutable, "暂无单词", true)) {
    await ensureLearningHasWord(adbExecutable);
  }
}

async function openActiveBookDetail(adbExecutable) {
  await ensureOnMainTabs(adbExecutable);
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "词库");
  await sleep(650);
  tap(adbExecutable, 620, 1640);
  await sleep(760);

  if (await hasTextOnScreen(adbExecutable, "导出词书", true)) {
    return true;
  }

  const tappedByName = await tapByText(adbExecutable, "完整词库", { contains: true, retries: 1, delayMs: 760 });
  if (tappedByName) {
    if (await hasTextOnScreen(adbExecutable, "导出词书", true)) {
      return true;
    }
  }

  tap(adbExecutable, 620, 1640);
  await sleep(760);
  return hasTextOnScreen(adbExecutable, "导出词书", true);
}

async function safeBack(adbExecutable, options = {}) {
  const {
    delayMs = 420,
    fallbackTab = null,
  } = options;
  keyevent(adbExecutable, 4);
  await sleep(delayMs);

  const ok = await ensureAppForeground(adbExecutable, { retries: 2, delayMs: 750 });
  if (!ok) {
    throw new Error("返回后无法回到目标应用");
  }

  if (fallbackTab) {
    await ensureOnMainTabs(adbExecutable);
    tapTab(adbExecutable, fallbackTab);
    await sleep(520);
  }
}

async function ensureOnMainTabs(adbExecutable) {
  for (let i = 0; i < 5; i += 1) {
    const inApp = await ensureAppForeground(adbExecutable, { retries: 1, delayMs: 720 });
    if (!inApp) {
      await sleep(300);
      continue;
    }

    const nodes = getDumpNodes(adbExecutable);
    const hasTabs =
      !!findNodeByText(nodes, "学习") &&
      !!findNodeByText(nodes, "查词") &&
      !!findNodeByText(nodes, "词库") &&
      !!findNodeByText(nodes, "我的");
    if (hasTabs && !isMainTabSubPage(nodes)) return true;
    keyevent(adbExecutable, 4);
    await sleep(350);
  }
  throw new Error("无法回到应用主标签页");
}

async function recoverByFeatureModule(adbExecutable, feature, index) {
  const inApp = await ensureAppForeground(adbExecutable, { retries: 3, delayMs: 760 });
  if (!inApp) {
    throw new Error("恢复步骤失败，无法拉起目标应用");
  }

  await ensureOnMainTabs(adbExecutable);

  if (feature.module === "学习") {
    if (index <= 27) {
      await dismissKeyboardIfNeeded(adbExecutable);
      tapTab(adbExecutable, "学习");
      await sleep(620);
      if (index >= 19 && index <= 27) {
        await tapByText(adbExecutable, "拼写模式", { retries: 1, delayMs: 640 });
      }
      return;
    }
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "学习");
    await sleep(620);
    if (index >= 19 && index <= 27) {
      await tapByText(adbExecutable, "拼写模式", { retries: 1, delayMs: 640 });
    }
  } else if (feature.module === "查词") {
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "查词");
    await sleep(620);
    if (index >= 30) {
      await tapByText(adbExecutable, "搜索单词，或粘贴长难句", { contains: true, retries: 1, delayMs: 240 });
      clearFocusedInput(adbExecutable, 44);
      inputText(adbExecutable, "abandon");
      await sleep(760);
    }
  } else if (feature.module === "词库") {
    if (index <= 43 || index === 51) {
      await ensureActiveBook(adbExecutable, "完整词库");
    }
    if (index === 44 || index === 45) {
      await ensureActiveBook(adbExecutable, "生词本");
    }
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "词库");
    await sleep(620);
  } else {
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "我的");
    await sleep(620);
  }
}

async function openProfileLabEntry(adbExecutable) {
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "我的");
  await sleep(650);
  for (let i = 0; i < 5; i += 1) {
    if (await tapByText(adbExecutable, "进入实验室", { retries: 0, delayMs: 700 })) {
      return true;
    }
    swipe(adbExecutable, 630, 2300, 630, 900, 350);
    await sleep(550);
  }
  return false;
}

async function openBookDetailWithTodayPlan(adbExecutable) {
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "词库");
  await sleep(650);

  // 先尽量回到词库列表顶部，保证目标卡片位置稳定
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(480);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(520);

  // 在常见布局下，这里是“完整词库”卡片区域
  tap(adbExecutable, 380, 1860);
  await sleep(760);

  let dialogNodes = getDumpNodes(adbExecutable);
  if (
    findNodeByText(dialogNodes, "今日新词（自主选择）", true) ||
    findNodeByText(dialogNodes, "今日新词自主选择", true)
  ) {
    return true;
  }

  keyevent(adbExecutable, 4);
  await sleep(420);

  for (let i = 0; i < 5; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const preferredBook =
      findNodeByText(nodes, "完整词库", true) ||
      findNodeByText(nodes, "完整词库（精选）", true);

    if (preferredBook) {
      const center = boundsCenter(preferredBook.bounds);
      if (center) {
        tap(adbExecutable, center.x, center.y + 30);
      } else {
        tap(adbExecutable, 450, 1700);
      }
    } else {
      // 安卓词库详情支持直接点击词书卡片区域打开，不依赖“详情”按钮文案
      tap(adbExecutable, 450, 1700);
    }
    await sleep(760);

    const dialogNodes = getDumpNodes(adbExecutable);
    if (
      findNodeByText(dialogNodes, "今日新词（自主选择）", true) ||
      findNodeByText(dialogNodes, "今日新词自主选择", true)
    ) {
      return true;
    }

    keyevent(adbExecutable, 4);
    await sleep(450);
    swipe(adbExecutable, 630, 2200, 630, 1200, 300);
    await sleep(500);
  }
  return false;
}

async function main() {
  const adbExecutable = await resolveAdb();
  ensureAdbReady(adbExecutable);
  const features = await loadFeatures();
  await cleanAndroidScreenshots();

  launchApp(adbExecutable);
  await sleep(1400);
  await ensureAppForeground(adbExecutable, { retries: 4, delayMs: 800 });
  await ensureOnMainTabs(adbExecutable);
  await prepareLearningSeedData(adbExecutable);

  const results = [];

  async function runStep(index, fn) {
    const feature = features[index - 1];
    console.log(`STEP_START [${feature.index}/52] ${feature.feature}`);
    const maxAttempts = 2;
    let ok = false;
    let message = "";
    let attempts = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attempts = attempt + 1;
      try {
        await ensureAppForeground(adbExecutable, { retries: 3, delayMs: 760 });
        await dismissUnexpectedPopups(adbExecutable);
        await fn();
        await assertAppForeground(adbExecutable, `步骤 ${index}`);
        const uiMatched = await verifyStepUi(adbExecutable, index);
        if (!uiMatched) {
          throw new Error(`步骤 ${index} 页面校验失败`);
        }
        await captureOne(adbExecutable, feature.id);
        ok = true;
        message = attempt > 0 ? `第 ${attempt + 1} 次尝试成功` : "";
        break;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
        if (attempt < maxAttempts - 1) {
          try {
            await recoverByFeatureModule(adbExecutable, feature, index);
          } catch (recoverError) {
            const text = recoverError instanceof Error ? recoverError.message : String(recoverError);
            message = message ? `${message}; 恢复失败: ${text}` : `恢复失败: ${text}`;
          }
        }
      }
    }

    if (!ok) {
      try {
        await recoverByFeatureModule(adbExecutable, feature, index);
        await captureOne(adbExecutable, feature.id);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        message = message ? `${message}; 兜底截图失败: ${text}` : `兜底截图失败: ${text}`;
      }
    }

    results.push({
      index: feature.index,
      id: feature.id,
      module: feature.module,
      feature: feature.feature,
      ok,
      attempts,
      message,
    });
    console.log(`${ok ? "PASS" : "FAIL"} [${feature.index}/52] ${feature.feature}${message ? ` -> ${message}` : ""}`);
  }

  // 1-10 学习主界面连续截图
  for (let i = 1; i <= 10; i += 1) {
    await runStep(i, async () => {
      await dismissKeyboardIfNeeded(adbExecutable);
      tapTab(adbExecutable, "学习");
      await sleep(300);
    });
  }

  await runStep(11, async () => {
    tap(adbExecutable, 630, 1330);
    await sleep(700);
  });

  await runStep(12, async () => {
    tap(adbExecutable, 630, 1330);
    await sleep(700);
  });

  await runStep(13, async () => {
    const ready = await ensureLearningHasWord(adbExecutable);
    if (!ready) {
      throw new Error("学习页无可用单词，无法验证复习时间弹窗");
    }
    const opened = await tapByText(adbExecutable, "未安排", { retries: 1, delayMs: 600 });
    if (!opened) {
      tap(adbExecutable, 250, 590);
      await sleep(600);
    }
  });

  await runStep(14, async () => {
    if (!(await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 420 }))) {
      await safeBack(adbExecutable, { delayMs: 420, fallbackTab: "学习" });
    }
  });

  await runStep(15, async () => {
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "学习");
    await sleep(300);
  });

  await runStep(16, async () => {
    await tapByText(adbExecutable, "不认识", { retries: 1, delayMs: 520 });
  });

  await runStep(17, async () => {
    tap(adbExecutable, 630, 1330);
    await sleep(420);
  });

  await runStep(18, async () => {
    await tapByDesc(adbExecutable, "加入生词本", { retries: 1, delayMs: 520 });
  });

  await runStep(19, async () => {
    const ready = await ensureLearningHasWord(adbExecutable);
    if (!ready) {
      throw new Error("学习页无可用单词，无法切换到拼写模式");
    }
    await tapByText(adbExecutable, "拼写模式", { retries: 2, delayMs: 700 });
  });

  await runStep(20, async () => {
    await sleep(250);
  });

  await runStep(21, async () => {
    await tapByText(adbExecutable, "首字母", { contains: true, retries: 1, delayMs: 520 });
  });

  await runStep(22, async () => {
    await tapByText(adbExecutable, "长度", { contains: true, retries: 1, delayMs: 520 });
  });

  await runStep(23, async () => {
    await tapByText(adbExecutable, "请输入单词拼写", { contains: true, retries: 1, delayMs: 300 });
    clearFocusedInput(adbExecutable, 20);
    inputText(adbExecutable, "zzz");
    await sleep(200);
    await tapByText(adbExecutable, "提交", { contains: true, retries: 1, delayMs: 520 });
  });

  await runStep(24, async () => {
    for (let i = 0; i < 2; i += 1) {
      await tapByText(adbExecutable, "请输入单词拼写", { contains: true, retries: 1, delayMs: 200 });
      clearFocusedInput(adbExecutable, 20);
      inputText(adbExecutable, `err${i}`);
      await sleep(150);
      await tapByText(adbExecutable, "重试", { contains: true, retries: 1, delayMs: 450 });
    }
  });

  await runStep(25, async () => {
    await sleep(260);
  });

  await runStep(26, async () => {
    await sleep(260);
  });

  await runStep(27, async () => {
    await tapByText(adbExecutable, "认词模式", { retries: 2, delayMs: 700 });
  });

  await runStep(28, async () => {
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "查词");
    await sleep(620);
  });

  await runStep(29, async () => {
    await sleep(250);
  });

  await runStep(30, async () => {
    await tapByText(adbExecutable, "搜索单词，或粘贴长难句", { contains: true, retries: 1, delayMs: 260 });
    clearFocusedInput(adbExecutable, 44);
    inputText(adbExecutable, "abandon");
    await sleep(700);
  });

  await runStep(31, async () => {
    const opened = await openSearchResultDetail(adbExecutable, "abandon");
    if (!opened) {
      throw new Error("未打开查词详情");
    }
  });

  await runStep(32, async () => {
    await sleep(220);
  });

  await runStep(33, async () => {
    await sleep(220);
  });

  await runStep(34, async () => {
    await tapByText(adbExecutable, "加入生词本", { contains: true, retries: 1, delayMs: 520 });
  });

  await runStep(35, async () => {
    await safeBack(adbExecutable, { delayMs: 520 });
  });

  await runStep(36, async () => {
    await ensureOnMainTabs(adbExecutable);
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "词库");
    await sleep(650);
  });

  await runStep(37, async () => {
    await sleep(220);
  });

  await runStep(38, async () => {
    const opened = await openActiveBookDetail(adbExecutable);
    if (!opened) {
      throw new Error("无法打开词书详情抽屉");
    }
  });

  await runStep(39, async () => {
    await safeBack(adbExecutable, { delayMs: 520 });
  });

  await runStep(40, async () => {
    if (!(await hasTextOnScreen(adbExecutable, "导出词书", true))) {
      const opened = await openActiveBookDetail(adbExecutable);
      if (!opened) {
        throw new Error("提前复习前无法进入词书详情");
      }
    }
    const openedEarlyReview =
      (await tapByText(adbExecutable, "提前复习（批量选择）", { contains: true, retries: 1, delayMs: 760 })) ||
      (await tapByText(adbExecutable, "提前复习", { contains: true, retries: 1, delayMs: 760 }));
    if (!openedEarlyReview) {
      throw new Error("无法打开提前复习弹窗");
    }
  });

  await runStep(41, async () => {
    await tapByText(adbExecutable, "全选", { retries: 1, delayMs: 450 });
  });

  await runStep(42, async () => {
    await tapByText(adbExecutable, "清空", { retries: 1, delayMs: 450 });
  });

  await runStep(43, async () => {
    await tapByText(adbExecutable, "确认", { retries: 1, delayMs: 520 });
  });

  await runStep(44, async () => {
    await ensureOnMainTabs(adbExecutable);
    await ensureActiveBook(adbExecutable, "生词本");
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "词库");
    await sleep(500);
    const opened = await tapByText(adbExecutable, "清空", { retries: 1, delayMs: 620 });
    if (!opened) {
      throw new Error("无法打开清空生词本确认弹窗");
    }
  });

  await runStep(45, async () => {
    await tapByText(adbExecutable, "取消", { retries: 1, delayMs: 520 });
  });

  await runStep(46, async () => {
    await tapByText(adbExecutable, "教程", { retries: 2, delayMs: 720 });
  });

  await runStep(47, async () => {
    await safeBack(adbExecutable, { delayMs: 620 });
  });

  await runStep(48, async () => {
    await ensureOnMainTabs(adbExecutable);
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "我的");
    await sleep(650);
    swipe(adbExecutable, 630, 900, 630, 2200, 320);
    await sleep(380);
  });

  await runStep(49, async () => {
    let opened = false;
    for (let i = 0; i < 4; i += 1) {
      opened = await tapByText(adbExecutable, "查看学习数据", { retries: 0, delayMs: 850 });
      if (opened) break;
      swipe(adbExecutable, 630, 1800, 630, 1200, 320);
      await sleep(380);
    }
    if (!opened) {
      throw new Error("未打开学习数据页面");
    }
  });

  await runStep(50, async () => {
    await safeBack(adbExecutable, { delayMs: 500 });
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "我的");
    await sleep(650);

    let opened = false;
    for (let i = 0; i < 6; i += 1) {
      const tapped = await tapByText(adbExecutable, "数据恢复", { retries: 0, delayMs: 620 });
      if (tapped) {
        await sleep(320);
        opened = getForegroundPackage(adbExecutable) !== packageName;
        if (opened) break;
      }

      // 交替上下滚动，确保覆盖数据管理卡片所在区域
      if (i % 2 === 0) {
        swipe(adbExecutable, 630, 900, 630, 2200, 320);
      } else {
        swipe(adbExecutable, 630, 2200, 630, 1100, 320);
      }
      await sleep(460);
    }

    // 文本匹配失败时兜底坐标点击数据管理卡片右侧按钮区域
    if (!opened) {
      tap(adbExecutable, 742, 610);
      await sleep(700);
      opened = getForegroundPackage(adbExecutable) !== packageName;
    }
    if (!opened) {
      throw new Error("未打开数据恢复确认弹窗");
    }

    // 安卓会进入系统文件选择器，按返回视为取消恢复并回到我的页
    if (getForegroundPackage(adbExecutable) !== packageName) {
      keyevent(adbExecutable, 4);
      await sleep(680);
      const backOk = await ensureAppForeground(adbExecutable, { retries: 2, delayMs: 760 });
      if (!backOk) {
        throw new Error("从系统文件选择器返回失败");
      }
      await ensureOnMainTabs(adbExecutable);
      tapTab(adbExecutable, "我的");
      await sleep(620);
    }
  });

  await runStep(51, async () => {
    await ensureOnMainTabs(adbExecutable);

    // 先在我的页开启“规划单词”，再进入词库详情才能看到“今日新词（自主选择）”
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "我的");
    await sleep(650);
    swipe(adbExecutable, 630, 2200, 630, 900, 350);
    await sleep(550);
    swipe(adbExecutable, 630, 2200, 630, 900, 350);
    await sleep(550);
    await tapByText(adbExecutable, "开启", { retries: 1, delayMs: 420 });

    await ensureActiveBook(adbExecutable, "完整词库");
    const opened = await openBookDetailWithTodayPlan(adbExecutable);
    if (!opened) {
      throw new Error("未找到可进入今日新词自主选择的词书详情");
    }
    const clickedTodayPlan =
      (await tapByText(adbExecutable, "今日新词（自主选择）", { contains: true, retries: 1, delayMs: 800 })) ||
      (await tapByText(adbExecutable, "今日新词自主选择", { contains: true, retries: 1, delayMs: 800 }));

    if (!clickedTodayPlan) {
      throw new Error("未找到今日新词自主选择入口");
    }
  });

  await runStep(52, async () => {
    await ensureOnMainTabs(adbExecutable);
    const openedLab = await openProfileLabEntry(adbExecutable);
    if (!openedLab) {
      throw new Error("未找到进入实验室按钮");
    }
    await tapByText(adbExecutable, "查看成本提示", { retries: 0, delayMs: 500 });
    await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 420 });
    await tapByText(adbExecutable, "查看隐私说明", { retries: 0, delayMs: 500 });
    await sleep(300);
  });

  const report = {
    generatedAt: new Date().toISOString(),
    total: features.length,
    pass: results.filter((item) => item.ok).length,
    fail: results.filter((item) => !item.ok).length,
    results,
  };

  const date = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(reportDir, `android_visible52_auto_report_${date}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`REPORT ${outputPath}`);

  if (report.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
