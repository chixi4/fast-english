import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const reportDir = path.join(projectRoot, "screenshot_compare", "report");
const visible52FeaturePath = path.join(projectRoot, "screenshot_compare", "visible52_features.json");
const webVisible52Dir = path.join(projectRoot, "screenshot_compare", "web_visible52");
const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4173";
const useExistingServer = process.env.QA_USE_EXISTING === "1";
const captureMode = process.env.QA_CAPTURE === "1" || process.argv.includes("--capture");
const localDepsLibDir = path.join(projectRoot, ".playwright-deps", "usr", "lib", "x86_64-linux-gnu");

let devServer = null;

const XEROX_VISUAL_PLAN = [
  "xerox",
  "unflappable",
  "unfold",
  "unforeseen",
  "unforgettable",
  "unfortunate",
  "unfortunately",
  "unfounded",
  "unfit",
];

const UNFLAPPABLE_VISUAL_PLAN = [
  "unflappable",
  "a",
  "abacus",
  "abalone",
  "abandon",
  "abandonment",
  "abase",
  "abash",
  "abate",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildCheckId(index) {
  return `visible_${String(index).padStart(2, "0")}`;
}

function resolveModule(index) {
  if (index <= 27) return "学习";
  if (index <= 35) return "查词";
  if (index <= 47) return "词库";
  if (index <= 50) return "我的";
  if (index === 51) return "词库";
  return "我的";
}

function startDevServer() {
  const args = ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173", "--strictPort"];
  devServer = spawn("npm", args, {
    cwd: projectRoot,
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    stdio: "pipe",
    env: process.env,
  });

  devServer.stdout.on("data", () => {});
  devServer.stderr.on("data", () => {});
}

async function waitForServer() {
  await waitOn({
    resources: [`http-get://${new URL(baseUrl).host}`],
    timeout: 120_000,
    interval: 250,
    window: 1_000,
  });
}

async function stopDevServer() {
  if (!devServer) return;

  try {
    if (process.platform !== "win32" && devServer.pid) {
      process.kill(-devServer.pid, "SIGTERM");
    } else {
      devServer.kill("SIGTERM");
    }
  } catch {
    // ignore
  }

  await sleep(500);

  try {
    if (process.platform !== "win32" && devServer.pid) {
      process.kill(-devServer.pid, "SIGKILL");
    } else if (!devServer.killed) {
      devServer.kill("SIGKILL");
    }
  } catch {
    // ignore
  }

  devServer.stdout?.destroy();
  devServer.stderr?.destroy();
}

async function applyLocalLibraryPath() {
  const exists = await fs.stat(localDepsLibDir).then(() => true).catch(() => false);
  if (!exists) return;
  const current = process.env.LD_LIBRARY_PATH?.trim();
  process.env.LD_LIBRARY_PATH = current ? `${localDepsLibDir}:${current}` : localDepsLibDir;
}

async function waitForWebFonts(page) {
  await page.evaluate(async () => {
    if (!("fonts" in document)) return;
    try {
      await document.fonts.ready;
      const timeout = 2_000;
      const started = Date.now();
      while (document.fonts.status !== "loaded" && Date.now() - started < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    } catch {
      // ignore
    }
  });
}

async function cleanPngFiles(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  const files = await fs.readdir(dirPath);
  await Promise.all(
    files
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => fs.unlink(path.join(dirPath, name))),
  );
}

async function saveScreenshot(page, id) {
  await waitForWebFonts(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(180);
  const outputPath = path.join(webVisible52Dir, `${id}.png`);
  await page.screenshot({
    path: outputPath,
    fullPage: false,
  });
  return outputPath;
}

async function dismissSwipeGuide(page) {
  const heading = page.getByRole("heading", { name: "手势快捷操作" });
  if (await heading.isVisible().catch(() => false)) {
    const neverAgain = page.getByRole("button", { name: "不再提示", exact: true });
    if (await neverAgain.isVisible().catch(() => false)) {
      await neverAgain.click();
    } else {
      await page.getByRole("button", { name: "知道了", exact: true }).click();
    }
    await sleep(220);
  }
}

async function openApp(page) {
  const target = new URL(baseUrl);
  target.searchParams.set("androidVisual", "1");
  await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "学习", exact: true }).waitFor({ timeout: 60_000 });
  await sleep(900);
  await dismissSwipeGuide(page);
}

async function prepareVisualBaseline(page) {
  const result = await page.evaluate(() => {
    const exposed = window.__WORD_WEB_STORE__;
    if (!exposed) {
      return { ok: false, reason: "store_not_exposed" };
    }

    const store = exposed;
    const fullBook = store.books.find((book) => book.type === 0 && book.name.includes("完整词库")) ?? store.books.find((book) => book.type === 0);
    if (!fullBook) {
      return { ok: false, reason: "full_book_not_found" };
    }

    const plannedKeys = [
      "xerox",
      "unflappable",
      "unfold",
      "unforeseen",
      "unforgettable",
      "unfortunate",
      "unfortunately",
      "unfounded",
      "unfit",
    ].filter((key) => !!store.wordsByKey[key]);

    const defaultNewWords = [
      "a",
      "abacus",
      "abalone",
      "abandon",
      "abandonment",
      "abase",
      "abash",
      "abask",
      "abate",
    ].filter((key) => !!store.wordsByKey[key]);

    const progressedKeys = [
      "a",
      "abacus",
      "abalone",
      "abandon",
      "abandonment",
      "abase",
      "abash",
      "abask",
      "abate",
      "abatement",
      "abdicate",
      "abdication",
      "abdomen",
      "abdominal",
    ].filter((key) => !!store.wordsByKey[key]);

    const exported = store.exportBackup();
    const backup = JSON.parse(exported);
    backup.data.progressMap = {};
    backup.data.dailyStatsMap = {};
    backup.data.studyLogMap = {};
    backup.data.earlyReviewMap = {};
    backup.data.newWords = [];
    backup.data.todayPlan = {
      learningDate: "",
      bookId: null,
      wordKeys: [],
    };
    backup.data.trainingSamples = [];
    backup.data.mlModel = {
      sampleCount: 0,
      userBaseRetention: 0.85,
      avgResponseTime: 0,
      stdResponseTime: 0,
    };
    backup.data.settings = {
      ...backup.data.settings,
      fontScale: 1,
      darkMode: 1,
      algorithmV4Enabled: false,
      reviewPressureReliefEnabled: true,
      reviewPressureDailyCap: 120,
      pronunciationEnabled: false,
      pronunciationSource: 0,
      recognitionAutoPronounceEnabled: false,
      mlAdaptiveEnabled: false,
      plannedNewWordsEnabled: true,
      newWordsShuffleEnabled: false,
      newWordsLimit: 20,
      swipeGestureGuideShown: true,
    };
    backup.data.activeBookId = fullBook.id;
    const restoreResult = store.importBackup(JSON.stringify(backup));
    if (!restoreResult?.ok) {
      return { ok: false, reason: "restore_baseline_failed" };
    }

    store.setSettings({
      plannedNewWordsEnabled: true,
      newWordsShuffleEnabled: false,
      newWordsLimit: 20,
      swipeGestureGuideShown: true,
    });
    store.switchBook(fullBook.id);
    store.saveTodayPlan(fullBook.id, plannedKeys);
    store.clearNewWords();
    defaultNewWords.forEach((key) => {
      store.addToNewWords(key);
    });

    const now = Date.now();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(4, 0, 0, 0);
    progressedKeys.forEach((key) => {
      store.setProgress(key, {
        wordKey: key,
        status: 1,
        repetitions: 1,
        intervalDays: 1,
        nextReviewTime: tomorrow.getTime(),
        easeFactor: 2.5,
        reviewCount: 1,
        spellCorrectCount: 0,
        spellWrongCount: 0,
        markedEasyCount: 0,
        lastEasyTime: 0,
        consecutiveCorrect: 0,
        avgResponseTimeMs: 850,
        lastReviewTime: now - 6 * 60 * 60 * 1000,
      });
    });

    const pad = (value) => String(value).padStart(2, "0");
    const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const today = new Date();
    const peakDay = new Date(today);
    peakDay.setDate(today.getDate() - 3);

    store.updateDailyStats(dateKey(today), {
      spellPracticeCount: 30,
    });
    store.updateDailyStats(dateKey(peakDay), {
      newWordsCount: 1,
    });

    return {
      ok: true,
      bookId: fullBook.id,
      planCount: plannedKeys.length,
      newWordsCount: defaultNewWords.length,
      progressedCount: progressedKeys.length,
      firstWord: plannedKeys[0] ?? "",
    };
  });

  assert(result.ok, `视觉基线预置失败: ${result.reason ?? "未知错误"}`);
  await sleep(380);
}

async function stageLearningVisual(page, options) {
  const { planKeys, newWordKeys = [], mode = "RECOGNITION" } = options;
  const result = await page.evaluate(({ planKeys: nextPlanKeys, newWordKeys: nextNewWordKeys }) => {
    const exposed = window.__WORD_WEB_STORE__;
    if (!exposed) {
      return { ok: false, reason: "store_not_exposed" };
    }
    const store = exposed;
    const fullBook = store.books.find((book) => book.type === 0 && book.name.includes("完整词库")) ?? store.books.find((book) => book.type === 0);
    if (!fullBook) {
      return { ok: false, reason: "full_book_not_found" };
    }

    const fullBookKeys = new Set(store.bookWordKeys[fullBook.id] ?? []);
    const plannedKeys = nextPlanKeys.filter((key) => !!store.wordsByKey[key] && fullBookKeys.has(key));
    if (!plannedKeys.length) {
      return { ok: false, reason: "empty_plan_keys" };
    }
    const chosenNewWordKeys = nextNewWordKeys.filter((key) => !!store.wordsByKey[key]);

    store.switchBook(fullBook.id);
    Object.keys(store.progressMap).forEach((key) => {
      store.removeProgress(key);
    });
    store.saveTodayPlan(fullBook.id, plannedKeys);
    store.clearNewWords();
    chosenNewWordKeys.forEach((key) => {
      store.addToNewWords(key);
    });

    return {
      ok: true,
      planCount: plannedKeys.length,
      firstWord: plannedKeys[0],
      newWordsCount: chosenNewWordKeys.length,
    };
  }, { planKeys, newWordKeys });

  assert(result.ok, `学习截图状态预置失败: ${result.reason ?? "未知错误"}`);

  await clickBottomTab(page, "查词");
  await clickBottomTab(page, "学习");
  await page.getByRole("button", { name: "认词模式", exact: true }).waitFor({ timeout: 10_000 });
  if (mode === "SPELLING") {
    await page.getByRole("button", { name: "拼写模式", exact: true }).click();
    await page.getByText("拼写练习", { exact: true }).waitFor({ timeout: 10_000 });
  } else {
    await page.getByRole("button", { name: "认词模式", exact: true }).click();
    await page.locator(".recognition-actions").waitFor({ timeout: 10_000 });
  }
  await sleep(220);
}

async function ensureRecognitionCardFace(page, face) {
  const backFace = page.locator(".word-back-face").first();
  const isBackVisible = await backFace.isVisible().catch(() => false);
  const shouldBack = face === "BACK";
  if (isBackVisible !== shouldBack) {
    await page.locator(".word-flip-area").first().click();
    await sleep(200);
  }
}

async function normalizeTodayStatsForVisual(page) {
  const result = await page.evaluate(() => {
    const exposed = window.__WORD_WEB_STORE__;
    if (!exposed) {
      return { ok: false, reason: "store_not_exposed" };
    }
    const store = exposed;
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const key = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const today = store.dailyStatsMap[key];
    if (!today) {
      return { ok: true, key, gestureEasyCount: 0, gestureNotebookCount: 0, recognizedWordsCount: 0 };
    }

    store.updateDailyStats(key, {
      gestureEasyCount: -today.gestureEasyCount,
      gestureNotebookCount: -today.gestureNotebookCount,
      recognizedWordsCount: -today.recognizedWordsCount,
    });
    const next = store.dailyStatsMap[key];
    return {
      ok: true,
      key,
      gestureEasyCount: next?.gestureEasyCount ?? 0,
      gestureNotebookCount: next?.gestureNotebookCount ?? 0,
      recognizedWordsCount: next?.recognizedWordsCount ?? 0,
    };
  });

  assert(result.ok, `学习数据基线归一失败: ${result.reason ?? "未知错误"}`);
  await sleep(180);
}

async function clickBottomTab(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  await sleep(260);
}

async function closeDialog(page) {
  const closeButton = page.locator(".dialog-head .icon-button").first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await sleep(220);
    return;
  }

  const fallbackButtons = [
    page.getByRole("button", { name: "知道了", exact: true }),
    page.getByRole("button", { name: "取消", exact: true }),
    page.getByRole("button", { name: "关闭", exact: true }),
  ];

  for (const button of fallbackButtons) {
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await sleep(220);
      return;
    }
  }

  const backdrop = page.locator(".dialog-backdrop").first();
  if (await backdrop.isVisible().catch(() => false)) {
    await backdrop.click({ position: { x: 24, y: 24 } }).catch(() => {});
    await sleep(220);
  }
}

async function readLearningProgress(page) {
  const text = await page.locator(".learning-meta-line").innerText();
  const match = text.match(/学习进度\s*(\d+)\/(\d+)/);
  assert(!!match, `学习进度文本解析失败: ${text}`);
  return {
    current: Number(match[1]),
    total: Number(match[2]),
  };
}

async function dragWordCard(page, direction) {
  const card = page.locator(".word-flip-area").first();
  await card.waitFor({ timeout: 10_000 });
  const box = await card.boundingBox();
  assert(!!box, "学习卡片未渲染");

  const startX = direction === "LEFT" ? box.x + box.width * 0.18 : box.x + box.width * 0.82;
  const startY = box.y + box.height * 0.5;
  const deltaX = box.width * 0.48 * (direction === "LEFT" ? -1 : 1);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 14 });
  await page.mouse.up();
  await sleep(260);
}

async function openNonNewWordsDetail(page) {
  const detailButtons = page.getByRole("button", { name: "详情", exact: true });
  const count = await detailButtons.count();

  for (let i = 0; i < count; i += 1) {
    await detailButtons.nth(i).click();
    await page.locator(".dialog-backdrop").first().waitFor({ timeout: 8_000 });

    const planButton = page.getByRole("button", { name: /今日新词自主选择/ }).first();
    const isPlanVisible = await planButton.isVisible().catch(() => false);
    if (isPlanVisible) {
      return true;
    }

    await closeDialog(page);
  }

  const targetCard = page.locator(".book-item-card").filter({ hasText: "完整词库" }).first();
  if (await targetCard.isVisible().catch(() => false)) {
    const openButton = targetCard.locator(".book-item-main-button").first();
    if (await openButton.isVisible().catch(() => false)) {
      await openButton.click();
    } else {
      await targetCard.click();
    }
    await page.locator(".dialog-backdrop").first().waitFor({ timeout: 8_000 });
    const planButton = page.getByRole("button", { name: /今日新词/ }).first();
    if (await planButton.isVisible().catch(() => false)) {
      return true;
    }
    await closeDialog(page);
  }

  return false;
}

async function main() {
  await fs.mkdir(reportDir, { recursive: true });
  if (captureMode) {
    await cleanPngFiles(webVisible52Dir);
  }
  await applyLocalLibraryPath();

  if (!useExistingServer) {
    startDevServer();
  }
  await waitForServer();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 420, height: 934 },
    deviceScaleFactor: 3,
    locale: "zh-CN",
  });
  const page = await context.newPage();

  const checks = [];
  const addCheck = (name, run, options = {}) => {
    const index = checks.length + 1;
    checks.push({
      id: buildCheckId(index),
      module: resolveModule(index),
      name,
      run,
      cleanupAfterCapture: typeof options.cleanupAfterCapture === "function" ? options.cleanupAfterCapture : null,
    });
  };

  addCheck("底部标签 学习 可见", async () => {
    assert(await page.getByRole("button", { name: "学习", exact: true }).isVisible(), "学习标签不可见");
  });

  addCheck("底部标签 查词 可见", async () => {
    assert(await page.getByRole("button", { name: "查词", exact: true }).isVisible(), "查词标签不可见");
  });

  addCheck("底部标签 词库 可见", async () => {
    assert(await page.getByRole("button", { name: "词库", exact: true }).isVisible(), "词库标签不可见");
  });

  addCheck("底部标签 我的 可见", async () => {
    assert(await page.getByRole("button", { name: "我的", exact: true }).isVisible(), "我的标签不可见");
  });

  addCheck("学习页已加载", async () => {
    await page.getByRole("button", { name: "认词模式", exact: true }).waitFor({ timeout: 10_000 });
  });

  addCheck("认词模式按钮可见", async () => {
    assert(await page.getByRole("button", { name: "认词模式", exact: true }).isVisible(), "认词模式按钮不可见");
  });

  addCheck("拼写模式按钮可见", async () => {
    assert(await page.getByRole("button", { name: "拼写模式", exact: true }).isVisible(), "拼写模式按钮不可见");
  });

  addCheck("当前词书信息可见", async () => {
    const text = await page.locator(".learning-meta-line").innerText();
    assert(text.includes("当前词书"), `当前词书信息异常: ${text}`);
  });

  addCheck("学习进度文本可解析", async () => {
    const progress = await readLearningProgress(page);
    assert(progress.total >= progress.current, `学习进度异常: ${progress.current}/${progress.total}`);
  });

  addCheck("认词卡正面可见", async () => {
    await stageLearningVisual(page, { planKeys: XEROX_VISUAL_PLAN, newWordKeys: [] });
    await ensureRecognitionCardFace(page, "FRONT");
    const word = page.locator(".learning-word-text").first();
    await word.waitFor({ timeout: 10_000 });
    const text = (await word.innerText()).trim();
    assert(text.length > 0, "认词卡正面单词为空");
  });

  addCheck("点击翻卡可看到背面", async () => {
    await page.locator(".word-flip-area").first().click();
    await page.locator(".word-back-face").first().waitFor({ timeout: 10_000 });
  });

  addCheck("翻回正面成功", async () => {
    await ensureRecognitionCardFace(page, "FRONT");
    const word = page.locator(".learning-word-text").first();
    await word.waitFor({ timeout: 10_000 });
    const text = (await word.innerText()).trim();
    assert(text.length > 0, "认词卡正面单词为空");
  });

  addCheck("复习时间弹窗可打开", async () => {
    await page.locator(".review-tag").first().click();
    await page.getByRole("heading", { name: "复习时间", exact: true }).waitFor({ timeout: 8_000 });
  });

  addCheck("复习时间弹窗可关闭", async () => {
    await closeDialog(page);
    assert(!(await page.getByRole("heading", { name: "复习时间", exact: true }).isVisible().catch(() => false)), "复习时间弹窗未关闭");
  });

  addCheck("认词三按钮区域可见", async () => {
    assert(await page.locator(".recognition-actions").isVisible(), "认词操作区不可见");
  });

  addCheck("左滑太简单快捷按钮可触发", async () => {
    await stageLearningVisual(page, {
      planKeys: UNFLAPPABLE_VISUAL_PLAN,
      newWordKeys: ["unflappable"],
    });
    await ensureRecognitionCardFace(page, "FRONT");
    await dragWordCard(page, "LEFT");
    await page.locator(".snackbar").filter({ hasText: "已标记为太简单" }).first().waitFor({ timeout: 8_000 });
    await stageLearningVisual(page, {
      planKeys: UNFLAPPABLE_VISUAL_PLAN,
      newWordKeys: ["unflappable"],
    });
    await ensureRecognitionCardFace(page, "FRONT");
  });

  addCheck("太简单撤销可执行", async () => {
    await stageLearningVisual(page, {
      planKeys: UNFLAPPABLE_VISUAL_PLAN,
      newWordKeys: ["unflappable"],
    });
    await ensureRecognitionCardFace(page, "FRONT");
    await dragWordCard(page, "LEFT");
    const snackbar = page.locator(".snackbar").filter({ hasText: "已标记为太简单" }).first();
    await snackbar.waitFor({ timeout: 8_000 });
    await snackbar.getByRole("button", { name: "撤销", exact: true }).click();
    await sleep(320);
    await stageLearningVisual(page, { planKeys: UNFLAPPABLE_VISUAL_PLAN, newWordKeys: [] });
    await ensureRecognitionCardFace(page, "BACK");
  });

  addCheck("右滑加入生词本快捷按钮可触发", async () => {
    await stageLearningVisual(page, { planKeys: UNFLAPPABLE_VISUAL_PLAN, newWordKeys: [] });
    await ensureRecognitionCardFace(page, "FRONT");
    await dragWordCard(page, "RIGHT");
    const snackbar = page.locator(".snackbar").filter({ hasText: /已加入生词本|已在生词本中/ }).first();
    const snackbarVisible = await snackbar.isVisible().catch(() => false);
    if (!snackbarVisible) {
      await sleep(260);
    }
    await stageLearningVisual(page, {
      planKeys: UNFLAPPABLE_VISUAL_PLAN,
      newWordKeys: ["unflappable"],
    });
    await ensureRecognitionCardFace(page, "FRONT");
  });

  addCheck("切换到拼写模式成功", async () => {
    await stageLearningVisual(page, { planKeys: UNFLAPPABLE_VISUAL_PLAN, newWordKeys: [] });
    await page.getByRole("button", { name: "拼写模式", exact: true }).click();
    await page.getByText("拼写练习", { exact: true }).waitFor({ timeout: 10_000 });
  });

  addCheck("拼写面板可见", async () => {
    assert(await page.getByText("拼写练习", { exact: true }).isVisible(), "拼写面板不可见");
  });

  addCheck("首字母提示可展开", async () => {
    await page.getByRole("button", { name: "首字母", exact: true }).click();
    await page.getByText("首字母：").first().waitFor({ timeout: 6_000 });
  });

  addCheck("长度提示可展开", async () => {
    await page.getByRole("button", { name: "长度", exact: true }).click();
    await page.getByText("长度：").first().waitFor({ timeout: 6_000 });
  });

  addCheck("拼写错误提示可见", async () => {
    const firstHintButton = page.getByRole("button", { name: "首字母", exact: true });
    const lengthHintButton = page.getByRole("button", { name: "长度", exact: true });

    const firstHintActive = await firstHintButton.evaluate((node) => node.classList.contains("active")).catch(() => false);
    if (firstHintActive) {
      await firstHintButton.click();
      await sleep(80);
    }

    const lengthHintActive = await lengthHintButton.evaluate((node) => node.classList.contains("active")).catch(() => false);
    if (lengthHintActive) {
      await lengthHintButton.click();
      await sleep(80);
    }

    await page.getByPlaceholder("请输入单词拼写").fill("zzz");
    await page.getByRole("button", { name: /^(提交|重试)$/ }).click();
    await page.getByText("拼写错误，请再试一次", { exact: false }).first().waitFor({ timeout: 6_000 });
  });

  addCheck("三次错误进入抄写阶段", async () => {
    for (let i = 0; i < 2; i += 1) {
      await page.getByPlaceholder("请输入单词拼写").fill(`err${i}`);
      await page.getByRole("button", { name: /^(提交|重试)$/ }).click();
      await sleep(140);
    }
    await page.getByPlaceholder("请抄写正确拼写后继续").waitFor({ timeout: 8_000 });
  });

  addCheck("抄写正确后可继续", async () => {
    const text = await page.locator(".error-text").filter({ hasText: "正确拼写：" }).first().innerText();
    const word = text.replace("正确拼写：", "").trim();
    assert(word.length > 0, "未提取到正确拼写");
    const copyInput = page.getByPlaceholder("请抄写正确拼写后继续");
    await copyInput.fill(word);
    await page.getByRole("button", { name: "继续", exact: true }).waitFor({ timeout: 8_000 });
    assert(
      await page.getByRole("button", { name: "继续", exact: true }).isEnabled(),
      "抄写正确后继续按钮未可用",
    );
    await copyInput.fill("");
    await sleep(140);

    await stageLearningVisual(page, { planKeys: UNFLAPPABLE_VISUAL_PLAN, newWordKeys: [], mode: "SPELLING" });
    for (let i = 0; i < 3; i += 1) {
      await page.getByPlaceholder("请输入单词拼写").fill(`err-restage-${i}`);
      await page.getByRole("button", { name: /^(提交|重试)$/ }).click();
      await sleep(120);
    }
    await page.getByPlaceholder("请抄写正确拼写后继续").waitFor({ timeout: 8_000 });
  });

  addCheck("拼写 AI 助记按钮可见", async () => {
    const aiButton = page.getByRole("button", { name: /AI 助记|重新生成 AI 助记/ }).first();
    assert(await aiButton.isVisible(), "拼写 AI 助记按钮不可见");
  });

  addCheck("切回认词模式成功", async () => {
    const continueButton = page.getByRole("button", { name: "继续", exact: true }).first();
    if (
      (await continueButton.isVisible().catch(() => false)) &&
      (await continueButton.isEnabled().catch(() => false))
    ) {
      await continueButton.click();
      await sleep(280);
    }
    await page.getByRole("button", { name: "认词模式", exact: true }).click();
    await page.locator(".recognition-actions").waitFor({ timeout: 10_000 });
    await stageLearningVisual(page, {
      planKeys: UNFLAPPABLE_VISUAL_PLAN,
      newWordKeys: ["unflappable"],
    });
    await ensureRecognitionCardFace(page, "FRONT");
  });

  addCheck("进入查词页成功", async () => {
    await prepareVisualBaseline(page);
    await clickBottomTab(page, "查词");
    await page.getByRole("heading", { name: "查词 / 长句解析" }).waitFor({ timeout: 10_000 });
  });

  addCheck("查词输入框可见", async () => {
    const input = page.getByPlaceholder("搜索单词，或粘贴长难句（超过20字自动解析）");
    assert(await input.isVisible(), "查词输入框不可见");
  });

  addCheck("查词结果可出现", async () => {
    await page.getByPlaceholder("搜索单词，或粘贴长难句（超过20字自动解析）").fill("abandonment");
    await page.locator(".search-item").first().waitFor({ timeout: 10_000 });
  });

  addCheck("查词详情可打开", async () => {
    const target = page.locator(".search-item").filter({ hasText: "abandonment" }).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click();
    } else {
      await page.locator(".search-item").first().click();
    }
    await page.locator(".dialog-backdrop").first().waitFor({ timeout: 10_000 });
  });

  addCheck("详情翻译按钮可见", async () => {
    const button = page.getByRole("button", { name: /生成中文翻译|重新生成翻译/ }).first();
    assert(await button.isVisible(), "详情翻译按钮不可见");
  });

  addCheck("详情 AI 助记按钮可见", async () => {
    const button = page.getByRole("button", { name: /生成 AI 助记|重新生成助记/ }).first();
    assert(await button.isVisible(), "详情 AI 助记按钮不可见");
  });

  addCheck("详情生词本按钮可切换", async () => {
    const toggleButton = page.locator(".search-detail-bottom button").first();
    const before = (await toggleButton.innerText()).trim();
    await toggleButton.click();
    await sleep(220);
    const toggled = (await toggleButton.innerText()).trim();
    assert(before !== toggled, `详情生词本按钮文案未变化: ${before}`);
    await toggleButton.click();
    await sleep(220);
    const restored = (await toggleButton.innerText()).trim();
    assert(restored === before, `详情生词本按钮未恢复初始状态: ${before} -> ${restored}`);
  });

  addCheck("关闭查词详情成功", async () => {
    await closeDialog(page);
    assert(!(await page.locator(".dialog-backdrop").isVisible().catch(() => false)), "查词详情弹窗未关闭");
  });

  addCheck("进入词库页成功", async () => {
    await prepareVisualBaseline(page);
    await clickBottomTab(page, "词库");
    await page.getByRole("heading", { name: "我的词库" }).waitFor({ timeout: 10_000 });
  });

  addCheck("词库卡片列表可见", async () => {
    const count = await page.locator(".book-item-card").count();
    assert(count > 0, "词库卡片为空");
  });

  addCheck("词书详情弹窗可打开", async () => {
    const targetCard = page.locator(".book-item-card").filter({ hasText: "完整词库" }).first();
    const openButton = targetCard.locator(".book-item-main-button").first();
    if (await openButton.isVisible().catch(() => false)) {
      await openButton.click();
    } else {
      await targetCard.click();
    }
    await page.locator(".dialog-backdrop").first().waitFor({ timeout: 8_000 });
  });

  addCheck("词书详情弹窗可关闭", async () => {
    await closeDialog(page);
    assert(!(await page.locator(".dialog-backdrop").isVisible().catch(() => false)), "词书详情弹窗未关闭");
  });

  addCheck("提前复习弹窗可打开", async () => {
    const earlyBtn = page.getByRole("button", { name: "提前复习", exact: true }).first();
    assert(await earlyBtn.isVisible(), "提前复习按钮不可见");
    await earlyBtn.click();
    await page.getByText("提前复习", { exact: false }).first().waitFor({ timeout: 8_000 });
  });

  addCheck("提前复习全选按钮可点击", async () => {
    await page.getByRole("button", { name: "全选", exact: true }).click();
    await sleep(140);
  });

  addCheck("提前复习清空按钮可点击", async () => {
    const earlyReviewDialog = page
      .locator(".dialog-backdrop")
      .filter({ has: page.getByRole("heading", { name: /提前复习/ }) })
      .first();
    await earlyReviewDialog.waitFor({ timeout: 8_000 });
    await earlyReviewDialog.getByRole("button", { name: "清空", exact: true }).click();
    await sleep(140);
    await page.getByText("已选择 0 词", { exact: true }).waitFor({ timeout: 8_000 });
  });

  addCheck("提前复习确认后关闭", async () => {
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await sleep(220);
    assert(!(await page.locator(".dialog-head h3").filter({ hasText: "提前复习" }).first().isVisible().catch(() => false)), "提前复习弹窗未关闭");
  });

  addCheck("清空生词本确认弹窗可打开", async () => {
    await page.evaluate(() => {
      const exposed = window.__WORD_WEB_STORE__;
      if (!exposed) return;
      const store = exposed;
      const newWordsBook = store.books.find((book) => book.type === 2 || book.name.includes("生词本"));
      if (newWordsBook) {
        store.switchBook(newWordsBook.id);
      }
    });
    await sleep(260);

    await page.locator(".snackbar").first().waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
    const newWordsCardClearButton = page
      .locator(".book-item-card")
      .filter({ hasText: "生词本" })
      .first()
      .getByRole("button", { name: "清空", exact: true });
    if (await newWordsCardClearButton.isVisible().catch(() => false)) {
      await newWordsCardClearButton.click();
    } else {
      await page.getByRole("button", { name: "清空", exact: true }).first().click();
    }
    await page.getByRole("heading", { name: "清空生词本", exact: true }).waitFor({ timeout: 8_000 });
  });

  addCheck("清空生词本确认弹窗可取消", async () => {
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await sleep(200);
    assert(!(await page.getByRole("heading", { name: "清空生词本", exact: true }).isVisible().catch(() => false)), "清空生词本弹窗未关闭");
  });

  addCheck("词书教程页可打开", async () => {
    await page.getByRole("button", { name: "教程", exact: true }).click();
    await page.getByRole("heading", { name: "词书构建教程" }).waitFor({ timeout: 10_000 });
  });

  addCheck("词书教程页可返回", async () => {
    await page.getByRole("button", { name: /返回/ }).first().click();
    await page.getByRole("heading", { name: "我的词库" }).waitFor({ timeout: 10_000 });
  });

  addCheck("我的页热力图可见", async () => {
    await clickBottomTab(page, "我的");
    await page.getByRole("heading", { name: "学习统计" }).waitFor({ timeout: 10_000 });
    assert(await page.locator(".heatmap-grid").first().isVisible(), "我的页热力图不可见");
  });

  addCheck(
    "学习数据页切换功能可用",
    async () => {
      await normalizeTodayStatsForVisual(page);
      await page.getByRole("button", { name: "查看学习数据", exact: true }).click();
      await page.getByRole("heading", { name: "学习数据", exact: true }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "未来模式", exact: true }).click();
      await page.getByText("未来 7 天复习压力", { exact: true }).waitFor({ timeout: 8_000 });
      await page.getByRole("button", { name: "近30天", exact: true }).click();
      const monthClass = (await page.getByRole("button", { name: "近30天", exact: true }).getAttribute("class")) ?? "";
      assert(monthClass.includes("active"), "近30天按钮未激活");
      await page.getByRole("button", { name: "历史模式", exact: true }).click();
      await page.getByText("过去 12 周学习热力图", { exact: true }).waitFor({ timeout: 8_000 });
    },
    {
      cleanupAfterCapture: async () => {
        await page.getByRole("button", { name: /返回/ }).first().click();
        await page.getByRole("heading", { name: "学习统计", exact: true }).waitFor({ timeout: 10_000 });
      },
    },
  );

  addCheck(
    "数据恢复确认弹窗可打开并取消",
    async () => {
      const restoreInput = page.locator("label.file-button input[type='file']").first();
      await restoreInput.setInputFiles({
        name: "broken.json",
        mimeType: "application/json",
        buffer: Buffer.from("{ invalid json }", "utf8"),
      });
      await page.getByRole("heading", { name: "恢复数据", exact: true }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await sleep(220);
      assert(
        !(await page.getByRole("heading", { name: "恢复数据", exact: true }).isVisible().catch(() => false)),
        "恢复确认弹窗未关闭",
      );
    },
  );

  addCheck(
    "今日新词页可进入并确认",
    async () => {
      const planningRow = page.locator(".field-row").filter({ hasText: "规划单词" }).first();
      const enableBtn = planningRow.getByRole("button", { name: "开启", exact: true });
      if (await enableBtn.isVisible().catch(() => false)) {
        await enableBtn.click();
        await sleep(180);
      }

      await clickBottomTab(page, "词库");
      await page.evaluate(() => {
        const exposed = window.__WORD_WEB_STORE__;
        if (!exposed) return;
        const store = exposed;
        const fullBook = store.books.find((book) => book.type === 0 && book.name.includes("完整词库")) ?? store.books.find((book) => book.type === 0);
        if (!fullBook) return;
        const selectedKeys = [
          "a",
          "abacus",
          "abalone",
          "abandon",
          "abandonment",
          "abase",
          "abash",
          "abask",
          "abate",
          "abatement",
          "unflappable",
          "unfold",
          "unforeseen",
          "unfortunately",
          "unfounded",
          "unfit",
        ].filter((key) => !!store.wordsByKey[key]);
        store.saveTodayPlan(fullBook.id, selectedKeys);
      });
      await sleep(180);
      const opened = await openNonNewWordsDetail(page);
      assert(opened, "未找到可进入今日新词页的词书详情");
      const todayPlanButton = page.getByRole("button", { name: /今日新词.*自主选择/ }).first();
      await todayPlanButton.waitFor({ timeout: 8_000 });
      await todayPlanButton.click();

      await page.getByRole("heading", { name: "今日新词选择", exact: true }).waitFor({ timeout: 10_000 });
      const confirmButton = page
        .locator(".panel-card .inline-actions button")
        .filter({ hasText: "确认使用" })
        .first();
      await confirmButton.waitFor({ timeout: 10_000 });
    },
    {
      cleanupAfterCapture: async () => {
        const confirmButton = page
          .locator(".panel-card .inline-actions button")
          .filter({ hasText: "确认使用" })
          .first();
        await confirmButton.click();
        await page.getByRole("heading", { name: "我的词库", exact: true }).waitFor({ timeout: 10_000 });
      },
    },
  );

  addCheck(
    "实验室成本与隐私弹窗可打开",
    async () => {
      if (await page.locator(".dialog-backdrop").first().isVisible().catch(() => false)) {
        await closeDialog(page);
      }
      const todayPlanHeading = page.getByRole("heading", { name: "今日新词选择", exact: true });
      if (await todayPlanHeading.isVisible().catch(() => false)) {
        await page.getByRole("button", { name: /返回/ }).first().click();
        await page.getByRole("heading", { name: "我的词库", exact: true }).waitFor({ timeout: 10_000 });
      }

      await clickBottomTab(page, "我的");
      await page.getByRole("button", { name: "进入实验室", exact: true }).click();
      await page.getByRole("heading", { name: "实验室", exact: true }).waitFor({ timeout: 10_000 });

      await page.getByRole("button", { name: "查看成本提示", exact: true }).click();
      await page.getByRole("heading", { name: "AI 成本提示", exact: true }).waitFor({ timeout: 8_000 });
      await page.getByRole("button", { name: "知道了", exact: true }).click();

      await page.getByRole("button", { name: "查看隐私说明", exact: true }).click();
      await page.getByRole("heading", { name: "隐私与风险说明", exact: true }).waitFor({ timeout: 8_000 });
      await page.getByRole("button", { name: "知道了", exact: true }).click();
    },
    {
      cleanupAfterCapture: async () => {
        await page.getByRole("button", { name: /返回/ }).first().click();
        await page.getByRole("heading", { name: "学习统计", exact: true }).waitFor({ timeout: 10_000 });
      },
    },
  );

  assert(checks.length === 52, `检查点数量不是 52，而是 ${checks.length}`);

  await fs.writeFile(
    visible52FeaturePath,
    `${JSON.stringify(checks.map((item, index) => ({
      index: index + 1,
      id: item.id,
      module: item.module,
      feature: item.name,
    })), null, 2)}\n`,
    "utf8",
  );

  const results = [];

  try {
    await openApp(page);
    await prepareVisualBaseline(page);
    await clickBottomTab(page, "学习");

    for (let i = 0; i < checks.length; i += 1) {
      const item = checks[i];
      const startedAt = Date.now();
      try {
        const detail = await item.run();
        const elapsedMs = Date.now() - startedAt;
        let screenshotPath = null;
        let screenshotError = "";
        if (captureMode) {
          try {
            const rawPath = await saveScreenshot(page, item.id);
            screenshotPath = path.relative(projectRoot, rawPath);
          } catch (error) {
            screenshotError = error instanceof Error ? error.message : String(error);
          }
        }
        if (item.cleanupAfterCapture) {
          await item.cleanupAfterCapture();
        }

        results.push({
          index: i + 1,
          id: item.id,
          module: item.module,
          name: item.name,
          ok: true,
          detail: detail ?? "",
          elapsedMs,
          screenshotPath,
          screenshotError,
        });
        console.log(`PASS [${i + 1}/52] ${item.name}`);
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const detail = error instanceof Error ? error.message : String(error);
        let screenshotPath = null;
        let screenshotError = "";
        if (captureMode) {
          try {
            const rawPath = await saveScreenshot(page, item.id);
            screenshotPath = path.relative(projectRoot, rawPath);
          } catch (captureError) {
            screenshotError = captureError instanceof Error ? captureError.message : String(captureError);
          }
        }
        results.push({
          index: i + 1,
          id: item.id,
          module: item.module,
          name: item.name,
          ok: false,
          detail,
          elapsedMs,
          screenshotPath,
          screenshotError,
        });
        console.log(`FAIL [${i + 1}/52] ${item.name} -> ${detail}`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
    if (!useExistingServer) {
      await stopDevServer();
    }
  }

  const report = {
    executedAt: new Date().toISOString(),
    total: checks.length,
    pass: results.filter((item) => item.ok).length,
    fail: results.filter((item) => !item.ok).length,
    captureEnabled: captureMode,
    webCaptureDir: captureMode ? path.relative(projectRoot, webVisible52Dir) : null,
    featureListPath: path.relative(projectRoot, visible52FeaturePath),
    results,
  };

  const date = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(reportDir, `visible_52_qa_${date}.json`);
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`REPORT ${outputPath}`);

  if (report.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
