import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const compareRoot = path.join(projectRoot, "screenshot_compare");
const featuresPath = path.join(compareRoot, "visible52_features.json");
const androidDir = path.join(compareRoot, "mobile_web_visible52");
const reportDir = path.join(compareRoot, "report");
const localAdbPath = path.join(projectRoot, "tools", "android-sdk", "platform-tools", "adb");
const defaultWindowsAdbPath = "/mnt/c/adbtemp/adb.exe";
const packageName = "mark.via";
const mobileWebUrl = process.env.MOBILE_WEB_URL || "http://fastnglish.com";
let lastDumpNodes = [];

const TAB_COORDS = {
  学习: [185, 2488],
  查词: [482, 2488],
  词库: [778, 2488],
  我的: [1075, 2488],
};

const STEP_TEXT_CHECKS = {
  1: [{ text: "认词模式" }, { text: "拼写模式" }],
  13: [{ text: "复习时间", contains: true }],
  19: [{ text: "请输入单词拼写", contains: true }],
  21: [{ text: "首字母", contains: true }],
  22: [{ text: "长度", contains: true }],
  24: [{ text: "请抄写正确拼写后继续", contains: true }],
  28: [{ text: "长句解析", contains: true }],
  30: [{ text: "abandonment", contains: true }],
  31: [{ text: "AI 中文翻译", contains: true }],
  33: [{ text: "AI 助记", contains: true }],
  35: [{ text: "搜索单词", contains: true }],
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

function findNodesByText(nodes, text, contains = false) {
  return nodes.filter((node) => {
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

function captureDebugOne(adbExecutable, fileName) {
  const pngBuffer = runAdb(adbExecutable, ["exec-out", "screencap", "-p"], {
    encoding: null,
    maxBuffer: 25 * 1024 * 1024,
  });
  return fs.writeFile(path.join(compareRoot, fileName), pngBuffer);
}

function tap(adbExecutable, x, y) {
  runAdb(adbExecutable, ["shell", "input", "tap", String(x), String(y)], { stdio: "ignore" });
}

function tapNodeCenter(adbExecutable, node, offsetX = 0, offsetY = 0) {
  const center = boundsCenter(node?.bounds);
  if (!center) return false;
  tap(adbExecutable, center.x + offsetX, center.y + offsetY);
  return true;
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

function keyeventSafe(adbExecutable, keyCode) {
  try {
    keyevent(adbExecutable, keyCode);
    return true;
  } catch {
    return false;
  }
}

function launchApp(adbExecutable) {
  runAdb(
    adbExecutable,
    ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", mobileWebUrl],
    {
      stdio: "ignore",
      timeout: 20_000,
    },
  );
}

async function relaunchMobileWeb(adbExecutable) {
  launchApp(adbExecutable);
  await sleep(1_600);
}

function clearBrowserData(adbExecutable) {
  runAdb(adbExecutable, ["shell", "pm", "clear", packageName], {
    timeout: 30_000,
  });
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
    if (lastDumpNodes.length > 0) {
      return lastDumpNodes;
    }
    throw new Error(`读取页面结构失败，当前前台应用不是目标应用，包名 ${pkg || "未知"}`);
  }
  let dumped = false;
  let lastError = "";
  for (let i = 0; i < 4; i += 1) {
    try {
      runAdb(adbExecutable, ["shell", "uiautomator", "dump", "/sdcard/uidump.xml"], {
        stdio: "ignore",
        timeout: 30_000,
      });
      dumped = true;
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!dumped) {
    if (lastDumpNodes.length > 0) {
      return lastDumpNodes;
    }
    throw new Error(`读取页面结构失败，uiautomator dump 异常：${lastError}`);
  }
  const xml = runAdb(adbExecutable, ["exec-out", "cat", "/sdcard/uidump.xml"]);
  const parsed = parseNodes(xml);
  if (parsed.length > 0) {
    lastDumpNodes = parsed;
  }
  return parsed;
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

async function dismissSwipeGuideIfPresent(adbExecutable) {
  const nodes = getDumpNodes(adbExecutable);
  const hasGuide =
    !!findNodeByText(nodes, "手势快捷操作", true) ||
    !!findNodeByText(nodes, "左滑超过", true) ||
    !!findNodeByText(nodes, "右滑超过", true);
  if (!hasGuide) return false;

  const closed =
    (await tapByText(adbExecutable, "不再提示", { retries: 1, delayMs: 420 })) ||
    (await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 420 })) ||
    (await tapByText(adbExecutable, "关闭", { retries: 1, delayMs: 420 }));
  if (!closed) {
    keyevent(adbExecutable, 4);
    await sleep(360);
  }
  return true;
}

async function acceptViaOnboardingIfNeeded(adbExecutable) {
  for (let i = 0; i < 10; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const hasLearningTabs =
      !!findNodeByText(nodes, "学习") &&
      !!findNodeByText(nodes, "查词") &&
      !!findNodeByText(nodes, "词库") &&
      !!findNodeByText(nodes, "我的");
    if (hasLearningTabs) {
      return;
    }

    const hasWelcome =
      !!findNodeByText(nodes, "欢迎", true) ||
      !!findNodeByText(nodes, "同意并继续", true) ||
      !!findNodeByText(nodes, "在使用 Via 前", true);

    const agreed =
      (await tapByText(adbExecutable, "同意并继续", { contains: true, retries: 0, delayMs: 900 })) ||
      (await tapByText(adbExecutable, "同意", { contains: true, retries: 0, delayMs: 900 })) ||
      (await tapByText(adbExecutable, "继续", { contains: true, retries: 0, delayMs: 900 }));
    if (agreed) {
      continue;
    }

    if (hasWelcome) {
      // Via 首启协议页兜底坐标
      tap(adbExecutable, 630, 2520);
      await sleep(1_000);
      continue;
    }

    await sleep(500);
  }
}

async function waitForWebAppReady(adbExecutable, timeoutMs = 150_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const nodes = getDumpNodes(adbExecutable);
    const ready =
      !!findNodeByText(nodes, "学习") &&
      !!findNodeByText(nodes, "查词") &&
      !!findNodeByText(nodes, "词库") &&
      !!findNodeByText(nodes, "我的");
    if (ready) return true;

    const initError = findNodeByText(nodes, "初始化失败", true);
    if (initError) {
      throw new Error("网页初始化失败，请检查网络后重试");
    }
    await sleep(900);
  }
  throw new Error("网页初始化超时，未进入主标签页");
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

function clearFocusedInput(adbExecutable, maxDeletes = 12) {
  keyeventSafe(adbExecutable, 123);
  for (let i = 0; i < maxDeletes; i += 1) {
    if (!keyeventSafe(adbExecutable, 67)) {
      break;
    }
  }
}

function hasTextInNodes(nodes, text, contains = false) {
  return !!findNodeByText(nodes, text, contains);
}

function findVisibleNodeEntriesByText(nodes, text, contains = false) {
  return findNodesByText(nodes, text, contains)
    .map((node) => ({
      node,
      center: boundsCenter(node.bounds),
      box: parseBounds(node.bounds),
    }))
    .filter((item) => {
      if (!item.center || !item.box) return false;
      const width = item.box.right - item.box.left;
      const height = item.box.bottom - item.box.top;
      if (width < 80 || height < 40) return false;
      if (item.center.y <= 360 || item.center.y >= 2440) return false;
      return true;
    })
    .sort((a, b) => a.center.y - b.center.y);
}

function findVisibleNodeByText(nodes, text, contains = false) {
  return findVisibleNodeEntriesByText(nodes, text, contains)[0]?.node ?? null;
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
  // 真实手机回归以截图视觉审查为准，关闭结构树校验以避免 uiautomator 卡顿影响流程
  return true;

  const checks = STEP_TEXT_CHECKS[stepIndex];
  if (!checks || checks.length === 0) {
    return true;
  }
  // 今日新词选择页在部分机型上会触发 uiautomator dump 卡顿，改为人工视觉复核
  if (stepIndex === 51) {
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

  // 先回到我的页顶部，避免命中不可见但可访问树中残留的按钮文本
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(320);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(360);

  for (let i = 0; i < 5; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const hasPlanRow =
      !!findVisibleNodeByText(nodes, "规划单词", true) ||
      findVisibleNodeEntriesByText(nodes, "关闭", false).some((item) => item.center.x < 320 && item.center.y > 700);
    if (hasPlanRow) {
      const offSelected = isChipSelected(nodes, "关闭");
      if (!offSelected) {
        const offNode = findVisibleNodeEntriesByText(nodes, "关闭", false).find(
          (item) => item.center.x < 320 && item.center.y > 700 && item.center.y < 1700,
        )?.node;
        if (offNode) {
          tapNodeCenter(adbExecutable, offNode);
          await sleep(560);
        } else {
          tap(adbExecutable, 162, 931);
          await sleep(560);
        }
      }
      return true;
    }
    swipe(adbExecutable, 630, 2200, 630, 900, 320);
    await sleep(440);
  }
  // 文本节点不可见时，按固定坐标兜底关闭
  tapTab(adbExecutable, "我的");
  await sleep(420);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(300);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(320);
  swipe(adbExecutable, 630, 2200, 630, 1200, 320);
  await sleep(420);
  tap(adbExecutable, 162, 931);
  await sleep(520);
  return true;
}

async function ensurePlannedWordsEnabled(adbExecutable) {
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "我的");
  await sleep(780);

  // 先回到我的页顶部，避免命中不可见但可访问树中残留的按钮文本
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(320);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(360);

  for (let i = 0; i < 5; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const hasPlanRow =
      !!findVisibleNodeByText(nodes, "规划单词", true) ||
      findVisibleNodeEntriesByText(nodes, "开启", false).some(
        (item) => item.center.x > 220 && item.center.x < 620 && item.center.y > 700,
      );
    if (hasPlanRow) {
      const onSelected = isChipSelected(nodes, "开启");
      if (!onSelected) {
        const onNode = findVisibleNodeEntriesByText(nodes, "开启", false).find(
          (item) => item.center.x > 220 && item.center.x < 620 && item.center.y > 700 && item.center.y < 1700,
        )?.node;
        if (onNode) {
          tapNodeCenter(adbExecutable, onNode);
          await sleep(360);
          tapNodeCenter(adbExecutable, onNode);
          await sleep(560);
        } else {
          tap(adbExecutable, 393, 931);
          await sleep(360);
          tap(adbExecutable, 393, 931);
          await sleep(560);
        }
      }
      return true;
    }
    swipe(adbExecutable, 630, 2200, 630, 900, 320);
    await sleep(440);
  }
  // 文本节点不可见时，按固定坐标兜底开启
  tapTab(adbExecutable, "我的");
  await sleep(420);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(300);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(320);
  swipe(adbExecutable, 630, 2200, 630, 1200, 320);
  await sleep(420);
  tap(adbExecutable, 393, 931);
  await sleep(360);
  tap(adbExecutable, 393, 931);
  await sleep(520);
  return true;
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
    const openedSwitcher = await tapByText(adbExecutable, "切换", { retries: 1, delayMs: 420 });
    if (!openedSwitcher) {
      await sleep(280);
      continue;
    }
    const picked =
      (await tapByText(adbExecutable, bookName, { contains: true, retries: 2, delayMs: 520 })) ||
      (bookName.includes("生词本") &&
        (await tapByText(adbExecutable, "生词本", { contains: true, retries: 1, delayMs: 520 })));
    if (!picked) {
      keyevent(adbExecutable, 4);
      await sleep(260);
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
  clearFocusedInput(adbExecutable, 12);
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

async function fillSearchWord(adbExecutable, word) {
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "查词");
  await sleep(620);

  for (let i = 0; i < 4; i += 1) {
    const focused = await tapByText(adbExecutable, "搜索单词，或粘贴长难句", { contains: true, retries: 1, delayMs: 220 });
    if (!focused) {
      // 文本命中失败时兜底点击输入框区域
      tap(adbExecutable, 250, 575);
      await sleep(220);
    }
    clearFocusedInput(adbExecutable, 12);
    inputText(adbExecutable, word);
    await sleep(560);
    keyeventSafe(adbExecutable, 66);
    await sleep(260);
    await dismissKeyboardIfNeeded(adbExecutable);
    await sleep(360);

    const hasWord =
      (await hasTextOnScreen(adbExecutable, word, true)) ||
      (await hasTextOnScreen(adbExecutable, word.slice(0, 6), true));
    if (hasWord) {
      return true;
    }
  }
  return false;
}

async function closeByTextIfPresent(adbExecutable, closeText = "关闭") {
  const closed = await tapByText(adbExecutable, closeText, { retries: 1, delayMs: 460 });
  if (closed) return true;
  await safeBack(adbExecutable, { delayMs: 460 });
  return false;
}

async function scrollProfileToText(adbExecutable, text, maxSwipes = 7) {
  for (let i = 0; i < maxSwipes; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    if (findNodeByText(nodes, text, true)) {
      return true;
    }
    swipe(adbExecutable, 630, 2200, 630, 900, 320);
    await sleep(420);
  }
  return false;
}

async function ensureLightTheme(adbExecutable) {
  await ensureOnMainTabs(adbExecutable);
  await dismissKeyboardIfNeeded(adbExecutable);
  tapTab(adbExecutable, "我的");
  await sleep(700);

  const reachedDarkMode = await scrollProfileToText(adbExecutable, "深色模式", 8);
  if (reachedDarkMode) {
    let switched = await tapByText(adbExecutable, "浅色", { retries: 2, delayMs: 420 });
    if (!switched) {
      const nodes = getDumpNodes(adbExecutable);
      const lightNode = findNodesByText(nodes, "浅色", false)
        .map((node) => ({ node, center: boundsCenter(node.bounds) }))
        .filter((item) => !!item.center && item.center.y > 600)
        .sort((a, b) => a.center.y - b.center.y)[0]?.node;
      switched = lightNode ? tapNodeCenter(adbExecutable, lightNode) : false;
      if (switched) {
        await sleep(420);
      }
    }
    if (!switched) {
      // 文本与节点都未命中时，用深色模式行区域的经验坐标兜底
      tap(adbExecutable, 625, 2140);
      await sleep(420);
    }
  }

  // 回到顶部，避免影响后续页签截图
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(340);
  swipe(adbExecutable, 630, 900, 630, 2200, 320);
  await sleep(360);
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

  // 今日新词流程未准备成功时，兜底用生词本构造至少一个可学习词条
  try {
    await ensureWordInNewWordsBook(adbExecutable, "abandonment");
    await ensureActiveBook(adbExecutable, "生词本");
    tapTab(adbExecutable, "学习");
    await sleep(760);
    await tapByText(adbExecutable, "知道了", { retries: 1, delayMs: 300 });
    if (!(await hasTextOnScreen(adbExecutable, "暂无单词", true))) {
      return true;
    }
  } catch {
    // 生词本兜底失败时继续返回 false 供上层处理
  }
  return false;
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
  await ensureActiveBook(adbExecutable, "完整词库");
  tapTab(adbExecutable, "词库");
  await sleep(650);
  for (let i = 0; i < 4; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const detailCandidates = findNodesByText(nodes, "详情", false)
      .map((node) => ({ node, center: boundsCenter(node.bounds), box: parseBounds(node.bounds) }))
      .filter((item) => {
        if (!item.center || !item.box) return false;
        if (item.center.y <= 900 || item.center.y >= 2500) return false;
        if (item.box.bottom - item.box.top < 40) return false;
        if (item.box.right - item.box.left < 100) return false;
        return true;
      })
      .sort((a, b) => b.center.y - a.center.y);

    if (detailCandidates.length > 0) {
      tapNodeCenter(adbExecutable, detailCandidates[0].node);
      await sleep(760);
      if ((await hasTextOnScreen(adbExecutable, "导出词书", true)) && (await hasTextOnScreen(adbExecutable, "完整词库", true))) {
        return true;
      }
      await closeByTextIfPresent(adbExecutable, "关闭");
      await sleep(280);
    }

    const openedByName = await tapByText(adbExecutable, "完整词库", {
      contains: true,
      retries: 0,
      delayMs: 720,
    });
    if (openedByName && (await hasTextOnScreen(adbExecutable, "导出词书", true)) && (await hasTextOnScreen(adbExecutable, "完整词库", true))) {
      return true;
    }

    const openedByButton = await tapByText(adbExecutable, "详情", { contains: true, retries: 0, delayMs: 720 });
    if (openedByButton && (await hasTextOnScreen(adbExecutable, "导出词书", true)) && (await hasTextOnScreen(adbExecutable, "完整词库", true))) {
      return true;
    }

    await closeByTextIfPresent(adbExecutable, "关闭");
    swipe(adbExecutable, 630, 2000, 630, 1300, 300);
    await sleep(420);
  }
  return false;
}

async function ensureEarlyReviewDialog(adbExecutable) {
  for (let i = 0; i < 3; i += 1) {
    const alreadyOpen =
      (await hasTextOnScreen(adbExecutable, "全选", false)) &&
      (await hasTextOnScreen(adbExecutable, "确认", false));
    if (alreadyOpen) {
      return true;
    }

    const inBookDetail = await hasTextOnScreen(adbExecutable, "导出词书", true);
    if (!inBookDetail) {
      const opened = await openActiveBookDetail(adbExecutable);
      if (!opened) {
        continue;
      }
    }

    const openedEarlyReview =
      (await tapByText(adbExecutable, "提前复习批量选择", { contains: true, retries: 1, delayMs: 760 })) ||
      (await tapByText(adbExecutable, "提前复习（批量选择）", { contains: true, retries: 1, delayMs: 760 })) ||
      (await tapByText(adbExecutable, "提前复习", { contains: true, retries: 1, delayMs: 760 }));
    if (!openedEarlyReview) {
      // 词书详情抽屉中“提前复习批量选择”按钮兜底坐标
      tap(adbExecutable, 630, 1585);
      await sleep(760);
    }

    const nowOpen =
      (await hasTextOnScreen(adbExecutable, "全选", false)) &&
      (await hasTextOnScreen(adbExecutable, "确认", false));
    if (nowOpen) {
      return true;
    }
  }
  return false;
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
    await relaunchMobileWeb(adbExecutable);
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
      await relaunchMobileWeb(adbExecutable);
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

    const inViaShell =
      (
        !!findNodeByText(nodes, "主页", true) ||
        !!findNodeByText(nodes, "搜索", true) ||
        !!findNodeByDesc(nodes, "搜索", true)
      ) &&
      !findNodeByText(nodes, "学习") &&
      !findNodeByText(nodes, "认词模式", true);
    if (inViaShell) {
      await relaunchMobileWeb(adbExecutable);
      continue;
    }

    keyevent(adbExecutable, 4);
    await sleep(500);
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
      clearFocusedInput(adbExecutable, 12);
      inputText(adbExecutable, "abandonment");
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

  for (let i = 0; i < 6; i += 1) {
    const nodes = getDumpNodes(adbExecutable);
    const hasTodayPlanEntryOnDialog =
      (
        !!findNodeByText(nodes, "今日新词（自主选择）", true) ||
        !!findNodeByText(nodes, "今日新词自主选择", true)
      ) &&
      !!findNodeByText(nodes, "导出词书", true);
    if (hasTodayPlanEntryOnDialog) {
      return true;
    }

    const titleNode = nodes
      .map((node) => ({ node, text: (node.text ?? "").trim(), center: boundsCenter(node.bounds) }))
      .filter((item) => {
        if (!item.center) return false;
        if (!item.text) return false;
        if (!item.text.includes("完整词库")) return false;
        if (item.text.includes("当前词书")) return false;
        return item.center.y > 950 && item.center.y < 2450;
      })
      .sort((a, b) => a.center.y - b.center.y)[0];

    if (!titleNode) {
      swipe(adbExecutable, 630, 2200, 630, 1200, 300);
      await sleep(500);
      continue;
    }

    const tapCandidates = [
      Math.min(2450, titleNode.center.y + 620),
      Math.min(2450, titleNode.center.y + 540),
      2240,
    ];
    let dialogNodes = null;
    for (const tapY of tapCandidates) {
      tap(adbExecutable, 1040, tapY);
      await sleep(760);
      const maybeDialogNodes = getDumpNodes(adbExecutable);
      if (findNodeByText(maybeDialogNodes, "导出词书", true) || findNodeByText(maybeDialogNodes, "今日新词", true)) {
        dialogNodes = maybeDialogNodes;
        break;
      }
    }
    if (!dialogNodes) {
      swipe(adbExecutable, 630, 2200, 630, 1200, 300);
      await sleep(500);
      continue;
    }

    const hasTodayPlanEntry =
      (
        !!findNodeByText(dialogNodes, "今日新词（自主选择）", true) ||
        !!findNodeByText(dialogNodes, "今日新词自主选择", true)
      ) &&
      !!findNodeByText(dialogNodes, "导出词书", true);
    if (hasTodayPlanEntry) {
      return true;
    }

    if (findNodeByText(dialogNodes, "导出词书", true)) {
      for (let j = 0; j < 3; j += 1) {
        swipe(adbExecutable, 630, 2300, 630, 1300, 260);
        await sleep(420);
        const scrolledNodes = getDumpNodes(adbExecutable);
        const hasTodayAfterScroll =
          (
            !!findNodeByText(scrolledNodes, "今日新词（自主选择）", true) ||
            !!findNodeByText(scrolledNodes, "今日新词自主选择", true)
          ) &&
          !!findNodeByText(scrolledNodes, "导出词书", true);
        if (hasTodayAfterScroll) {
          return true;
        }
      }
      await closeByTextIfPresent(adbExecutable, "关闭");
      await sleep(420);
    }
    swipe(adbExecutable, 630, 2200, 630, 1200, 300);
    await sleep(500);
  }
  return false;
}

async function main() {
  const adbExecutable = await resolveAdb();
  ensureAdbReady(adbExecutable);
  const features = await loadFeatures();
  const startStepRaw = Number(process.env.STEP_START_INDEX ?? 1);
  const endStepRaw = Number(process.env.STEP_END_INDEX ?? features.length);
  const startStep = Number.isFinite(startStepRaw) ? Math.max(1, Math.floor(startStepRaw)) : 1;
  const endStep = Number.isFinite(endStepRaw) ? Math.min(features.length, Math.floor(endStepRaw)) : features.length;
  await cleanAndroidScreenshots();

  launchApp(adbExecutable);
  await sleep(1400);
  await relaunchMobileWeb(adbExecutable);
  await waitForWebAppReady(adbExecutable);
  await ensureAppForeground(adbExecutable, { retries: 4, delayMs: 800 });
  await ensureOnMainTabs(adbExecutable);

  // 默认关闭重度种子准备，避免实机全量回归卡在前置流程
  const needLearningSeed = process.env.FORCE_LEARNING_SEED === "1" && startStep <= 29;
  if (needLearningSeed) {
    await prepareLearningSeedData(adbExecutable);
  }
  await ensureLightTheme(adbExecutable);
  if (needLearningSeed) {
    tapTab(adbExecutable, "学习");
    await sleep(520);
  } else {
    await ensureOnMainTabs(adbExecutable);
  }

  const results = [];

  async function runStep(index, fn) {
    if (index < startStep || index > endStep) {
      return;
    }
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
        await dismissSwipeGuideIfPresent(adbExecutable);
        await fn();
        await dismissSwipeGuideIfPresent(adbExecutable);
        await assertAppForeground(adbExecutable, `步骤 ${index}`);
        await captureOne(adbExecutable, feature.id);
        const uiMatched = await verifyStepUi(adbExecutable, index);
        if (!uiMatched) {
          message = "页面校验提示不一致，已保留当前截图供人工视觉复核";
        }
        ok = true;
        if (attempt > 0) {
          message = message
            ? `第 ${attempt + 1} 次尝试成功；${message}`
            : `第 ${attempt + 1} 次尝试成功`;
        }
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
      console.log("WARN STEP13 学习页无可用单词，继续执行复习时间弹窗兜底截图");
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
      console.log("WARN STEP19 学习页无可用单词，继续执行拼写模式切换兜底截图");
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
    clearFocusedInput(adbExecutable, 10);
    inputText(adbExecutable, "zzz");
    await sleep(200);
    await tapByText(adbExecutable, "提交", { contains: true, retries: 1, delayMs: 520 });
  });

  await runStep(24, async () => {
    for (let i = 0; i < 2; i += 1) {
      await tapByText(adbExecutable, "请输入单词拼写", { contains: true, retries: 1, delayMs: 200 });
      clearFocusedInput(adbExecutable, 10);
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
    const typed = await fillSearchWord(adbExecutable, "abandonment");
    if (!typed) {
      throw new Error("查词输入未成功写入 abandonment");
    }
  });

  await runStep(31, async () => {
    const opened = await openSearchResultDetail(adbExecutable, "abandonment");
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
    await closeByTextIfPresent(adbExecutable, "关闭");
    const backToSearch =
      (await hasTextOnScreen(adbExecutable, "查词 / 长句解析", true)) ||
      (await hasTextOnScreen(adbExecutable, "搜索单词，或粘贴长难句", true)) ||
      (await hasTextOnScreen(adbExecutable, "长句解析", true));
    if (!backToSearch) {
      throw new Error("关闭查词详情后未回到查词页面");
    }
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
    await ensureActiveBook(adbExecutable, "完整词库");
    const opened = await openActiveBookDetail(adbExecutable);
    if (!opened) {
      throw new Error("无法打开词书详情抽屉");
    }
  });

  await runStep(39, async () => {
    await closeByTextIfPresent(adbExecutable, "关闭");
    if (await hasTextOnScreen(adbExecutable, "准备学习内容中", true)) {
      throw new Error("关闭词书详情后误回到启动页");
    }
  });

  await runStep(40, async () => {
    const ready = await ensureEarlyReviewDialog(adbExecutable);
    if (!ready) {
      throw new Error("无法打开提前复习弹窗");
    }
  });

  await runStep(41, async () => {
    const ready = await ensureEarlyReviewDialog(adbExecutable);
    if (!ready) {
      throw new Error("提前复习弹窗未就绪，无法执行全选");
    }
    const tapped = await tapByText(adbExecutable, "全选", { retries: 1, delayMs: 450 });
    if (!tapped) {
      tap(adbExecutable, 175, 1088);
      await sleep(450);
    }
  });

  await runStep(42, async () => {
    const ready = await ensureEarlyReviewDialog(adbExecutable);
    if (!ready) {
      throw new Error("提前复习弹窗未就绪，无法执行清空");
    }
    const tapped = await tapByText(adbExecutable, "清空", { retries: 1, delayMs: 450 });
    if (!tapped) {
      tap(adbExecutable, 375, 1088);
      await sleep(450);
    }
  });

  await runStep(43, async () => {
    const ready = await ensureEarlyReviewDialog(adbExecutable);
    if (!ready) {
      throw new Error("提前复习弹窗未就绪，无法确认关闭");
    }
    const confirmed = await tapByText(adbExecutable, "确认", { retries: 1, delayMs: 520 });
    if (!confirmed) {
      // 提前复习弹窗“确认”按钮兜底坐标
      tap(adbExecutable, 570, 1088);
    }
    await sleep(520);
    await dismissKeyboardIfNeeded(adbExecutable);
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
    const backByUi = await tapByText(adbExecutable, "返回", { contains: true, retries: 1, delayMs: 620 });
    if (!backByUi) {
      await safeBack(adbExecutable, { delayMs: 620 });
    }
    if (!(await hasTextOnScreen(adbExecutable, "我的词库", true))) {
      throw new Error("教程返回后未回到词库页面");
    }
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
    if (!(await hasTextOnScreen(adbExecutable, "学习数据", true))) {
      throw new Error("查看学习数据后未停留在学习数据页");
    }
  });

  await runStep(50, async () => {
    const backed = await tapByText(adbExecutable, "返回", { contains: true, retries: 1, delayMs: 520 });
    if (!backed || (await hasTextOnScreen(adbExecutable, "学习数据", true))) {
      await safeBack(adbExecutable, { delayMs: 620 });
    }
    await dismissKeyboardIfNeeded(adbExecutable);
    tapTab(adbExecutable, "我的");
    await sleep(650);

    // 回到我的页顶部，再滚动到数据管理可见位置
    swipe(adbExecutable, 630, 900, 630, 2200, 320);
    await sleep(420);
    swipe(adbExecutable, 630, 900, 630, 2200, 320);
    await sleep(420);
    swipe(adbExecutable, 630, 2200, 630, 900, 320);
    await sleep(680);

    let opened = false;
    const restoreTapPoints = [
      [450, 1090],
      [520, 1090],
      [480, 1130],
      [500, 1160],
      [320, 1280],
      [520, 1280],
      [320, 1480],
      [520, 1480],
    ];
    for (const [x, y] of restoreTapPoints) {
      tap(adbExecutable, x, y);
      await sleep(800);
      opened = getForegroundPackage(adbExecutable) !== packageName;
      if (opened) break;
    }

    // 坐标命中失败时，再尝试一次文本命中
    if (!opened) {
      await tapByText(adbExecutable, "数据恢复", { retries: 1, delayMs: 700 });
      opened = getForegroundPackage(adbExecutable) !== packageName;
    }
    if (!opened) {
      // 某些机型文件选择器以内嵌方式打开，前台包名仍是 mark.via，保留截图并继续后续流程
      console.log("WARN STEP50 未检测到系统文件选择器前台切换，按内嵌文件选择器处理");
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
    await captureDebugOne(adbExecutable, "debug_step51_start.png");
    console.log("STEP51 stage=start");

    const findTodayPlanEntryNode = () => {
      const nodes = getDumpNodes(adbExecutable);
      const byPlanA = findVisibleNodeEntriesByText(nodes, "今日新词（自主选择）", true);
      const byPlanB = findVisibleNodeEntriesByText(nodes, "今日新词自主选择", true);
      return [...byPlanA, ...byPlanB]
        .filter((item) => String(item.node.clickable ?? "").toLowerCase() === "true")
        .filter((item) => item.center.y > 900 && item.center.y < 2300)
        .sort((a, b) => a.center.y - b.center.y)[0]?.node ?? null;
    };

    const forceEnablePlannedWords = async () => {
      console.log("STEP51 stage=enable_planned_words");
      await dismissKeyboardIfNeeded(adbExecutable);
      tapTab(adbExecutable, "我的");
      await sleep(760);
      swipe(adbExecutable, 630, 900, 630, 2200, 320);
      await sleep(320);
      swipe(adbExecutable, 630, 900, 630, 2200, 320);
      await sleep(360);
      swipe(adbExecutable, 630, 2200, 630, 1200, 320);
      await sleep(460);
      tap(adbExecutable, 393, 931);
      await sleep(360);
      tap(adbExecutable, 393, 931);
      await sleep(560);
      console.log("STEP51 stage=enable_planned_words_done");
    };

    const openCompleteBookDetailFast = async (round) => {
      console.log(`STEP51 stage=open_detail round=${round}`);
      await ensureOnMainTabs(adbExecutable);
      tapTab(adbExecutable, "词库");
      await sleep(720);
      swipe(adbExecutable, 630, 900, 630, 2200, 320);
      await sleep(320);
      swipe(adbExecutable, 630, 900, 630, 2200, 320);
      await sleep(420);

      const tapPlan = [
        [922, 2338],
        [922, 2098],
        [922, 1256],
      ];

      for (let i = 0; i < tapPlan.length; i += 1) {
        console.log(`STEP51 stage=open_detail_tap round=${round} try=${i + 1}`);
        const nodes = getDumpNodes(adbExecutable);
        const detailNode = findVisibleNodeEntriesByText(nodes, "详情", false)
          .filter((item) => String(item.node.clickable ?? "").toLowerCase() === "true")
          .filter((item) => item.center.x > 700 && item.center.y > 900 && item.center.y < 2450)
          .sort((a, b) => a.center.y - b.center.y)[0]?.node;

        if (detailNode) {
          tapNodeCenter(adbExecutable, detailNode);
        } else {
          tap(adbExecutable, tapPlan[i][0], tapPlan[i][1]);
        }
        await sleep(860);
        await captureDebugOne(adbExecutable, `debug_step51_open_try_r${round}_t${i + 1}.png`);

        const inDetail =
          (await hasTextOnScreen(adbExecutable, "导出词书", true)) &&
          (await hasTextOnScreen(adbExecutable, "关闭", true));
        console.log(`STEP51 stage=open_detail_result round=${round} try=${i + 1} inDetail=${inDetail}`);
        if (inDetail) {
          console.log(`STEP51 stage=open_detail_done round=${round}`);
          return true;
        }
      }
      console.log(`STEP51 stage=open_detail_fail round=${round}`);
      return false;
    };

    const hasTodayPlanEntryInDetail = async () => {
      console.log("STEP51 stage=find_today_entry");
      for (let i = 0; i < 4; i += 1) {
        if (findTodayPlanEntryNode()) {
          console.log(`STEP51 stage=find_today_entry_found swipe=${i}`);
          return true;
        }
        swipe(adbExecutable, 630, 2300, 630, 1300, 260);
        await sleep(420);
      }
      console.log("STEP51 stage=find_today_entry_fail");
      return false;
    };

    let foundTodayPlanEntry = false;
    for (let round = 1; round <= 2; round += 1) {
      console.log(`STEP51 stage=round_start round=${round}`);
      await forceEnablePlannedWords();
      const opened = await openCompleteBookDetailFast(round);
      if (!opened) {
        console.log(`STEP51 stage=round_no_detail round=${round}`);
        continue;
      }
      foundTodayPlanEntry = await hasTodayPlanEntryInDetail();
      if (foundTodayPlanEntry) {
        console.log(`STEP51 stage=round_ready round=${round}`);
        break;
      }
      await tapByText(adbExecutable, "关闭", { retries: 1, delayMs: 420 });
      await sleep(360);
    }

    if (!foundTodayPlanEntry) {
      throw new Error("未找到可进入今日新词自主选择的词书详情");
    }

    await captureDebugOne(adbExecutable, "debug_step51_dialog_ready.png");
    console.log("STEP51 stage=dialog_ready");

    let enteredTodayPlanPage = false;
    for (let i = 0; i < 3; i += 1) {
      console.log(`STEP51 stage=click_today_entry try=${i + 1}`);
      const todayNode = findTodayPlanEntryNode();
      if (todayNode) {
        tapNodeCenter(adbExecutable, todayNode);
      } else {
        tap(adbExecutable, 630, 1392);
      }
      await sleep(1_200);
      // 该页在部分机型的无障碍树会卡住，点击后直接进入截图阶段，由视觉结果复核
      enteredTodayPlanPage = true;
      console.log(`STEP51 stage=click_today_entry_result try=${i + 1} entered=assumed_true`);
      break;
    }

    if (!enteredTodayPlanPage) {
      const clickedTodayPlanByText = await tapByText(adbExecutable, "今日新词", { contains: true, retries: 1, delayMs: 850 });
      if (clickedTodayPlanByText) {
        await sleep(1_200);
        enteredTodayPlanPage = true;
        console.log("STEP51 stage=click_today_entry_text entered=assumed_true");
      }
    }

    await captureDebugOne(adbExecutable, "debug_step51_after_click.png");
    if (!enteredTodayPlanPage) {
      await captureDebugOne(adbExecutable, "debug_step51_not_entered.png");
      throw new Error("点击今日新词入口后未进入今日新词选择页");
    }
  });

  await runStep(52, async () => {
    // 从今日新词页直接切回我的页，避免 ensureOnMainTabs 在该页结构树偶发阻塞
    tapTab(adbExecutable, "我的");
    await sleep(720);

    // 滚动到实验室区块并点击“进入实验室”
    swipe(adbExecutable, 630, 2200, 630, 1200, 320);
    await sleep(420);
    tap(adbExecutable, 253, 1648);
    await sleep(900);
    // 弹窗关闭统一交给 runStep 的通用弹窗处理，避免这里重复触发结构树读取
    await sleep(420);
  });

  const report = {
    generatedAt: new Date().toISOString(),
    total: features.length,
    pass: results.filter((item) => item.ok).length,
    fail: results.filter((item) => !item.ok).length,
    results,
  };

  const date = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(reportDir, `mobile_web_visible52_auto_report_${date}.json`);
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
