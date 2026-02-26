import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const compareRoot = path.join(projectRoot, "screenshot_compare");
const webDir = path.join(compareRoot, "web");
const reportDir = path.join(compareRoot, "report");
const scenarioPath = path.join(compareRoot, "scenarios.json");

const baseUrl = process.env.SCREENSHOT_BASE_URL || "http://127.0.0.1:4173";
const viewport = { width: 420, height: 934 };
const useExistingServer = process.env.SCREENSHOT_USE_EXISTING === "1";
const localDepsLibDir = path.join(projectRoot, ".playwright-deps", "usr", "lib", "x86_64-linux-gnu");

let devServer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDirs() {
  await fs.mkdir(webDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
}

async function applyLocalLibraryPath() {
  const exists = await fs.stat(localDepsLibDir).then(() => true).catch(() => false);
  if (!exists) return;
  const current = process.env.LD_LIBRARY_PATH?.trim();
  process.env.LD_LIBRARY_PATH = current ? `${localDepsLibDir}:${current}` : localDepsLibDir;
}

async function cleanWebScreenshots() {
  const files = await fs.readdir(webDir);
  await Promise.all(
    files
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => fs.unlink(path.join(webDir, name))),
  );
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

  await sleep(600);

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

async function loadScenarios() {
  const content = await fs.readFile(scenarioPath, "utf8");
  return JSON.parse(content);
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

async function dismissSwipeGuideIfPresent(page) {
  const heading = page.getByRole("heading", { name: "手势快捷操作" });
  if (await heading.isVisible().catch(() => false)) {
    await saveScreenshot(page, "learning_swipe_guide");
    await page.getByRole("button", { name: "知道了", exact: true }).click();
    await sleep(200);
    return true;
  }
  return false;
}

async function saveScreenshot(page, id) {
  await waitForWebFonts(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(180);
  await page.screenshot({
    path: path.join(webDir, `${id}.png`),
    fullPage: false,
  });
}

async function closeDialogIfPresent(page) {
  const closeButton = page.locator(".dialog-head .icon-button").first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await sleep(180);
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
      await sleep(180);
      return;
    }
  }
}

async function clickBottomTab(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  await sleep(250);
}

async function openBookDetail(page, keywords) {
  for (const keyword of keywords) {
    const card = page.locator(".book-item-card").filter({ hasText: keyword }).first();
    if (await card.count()) {
      const button = card.getByRole("button", { name: "详情", exact: true }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        return true;
      }
    }
  }
  return false;
}

async function runCapture() {
  const scenarios = await loadScenarios();
  const captured = [];
  const errors = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 3,
    locale: "zh-CN",
  });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "学习", exact: true }).waitFor({ timeout: 30_000 });
    await sleep(900);

    const hasSwipeGuide = await dismissSwipeGuideIfPresent(page);
    if (hasSwipeGuide) {
      captured.push("learning_swipe_guide");
    }

    await saveScreenshot(page, "learning_recognition");
    captured.push("learning_recognition");

    await page.locator(".word-flip-area").first().click();
    await sleep(220);
    await saveScreenshot(page, "learning_backface");
    captured.push("learning_backface");

    const aiEntryButton = page.locator(".learning-card-bottom button").filter({ hasText: /^(AI|助记推荐)$/ }).first();
    if (await aiEntryButton.isVisible().catch(() => false)) {
      await aiEntryButton.click();
      await page.getByRole("heading", { name: "AI 功能未配置" }).waitFor({ timeout: 5_000 });
      await saveScreenshot(page, "learning_ai_unconfigured");
      captured.push("learning_ai_unconfigured");
      await closeDialogIfPresent(page);
    } else {
      await saveScreenshot(page, "learning_ai_unconfigured");
      captured.push("learning_ai_unconfigured");
    }

    await page.getByRole("button", { name: "拼写模式", exact: true }).click();
    await page.getByText("拼写练习", { exact: true }).waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "learning_spelling");
    captured.push("learning_spelling");

    await clickBottomTab(page, "查词");
    await page.getByRole("heading", { name: "查词 / 长句解析" }).waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "search_home");
    captured.push("search_home");

    const searchInput = page.getByPlaceholder("搜索单词，或粘贴长难句（超过20字自动解析）");
    await searchInput.fill("abandon");
    await sleep(450);
    await saveScreenshot(page, "search_results");
    captured.push("search_results");

    await page.locator(".search-item").first().click();
    await page.locator(".dialog-backdrop").first().waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "search_detail");
    captured.push("search_detail");
    await closeDialogIfPresent(page);

    await clickBottomTab(page, "词库");
    await page.getByRole("heading", { name: "我的词库" }).waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "books_home");
    captured.push("books_home");

    await page.getByRole("button", { name: "详情", exact: true }).first().click();
    await page.locator(".dialog-backdrop").first().waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "books_detail");
    captured.push("books_detail");
    await closeDialogIfPresent(page);

    const earlyReviewButton = page.getByRole("button", { name: "提前复习", exact: true }).first();
    if (await earlyReviewButton.isVisible().catch(() => false)) {
      await earlyReviewButton.click();
      await page.locator(".dialog-head h3").filter({ hasText: "提前复习" }).first().waitFor({ timeout: 10_000 });
      await saveScreenshot(page, "books_early_review");
      captured.push("books_early_review");
      await closeDialogIfPresent(page);
    } else {
      errors.push({
        id: "books_early_review",
        message: "未找到提前复习按钮，可能当前词书不支持该功能",
      });
    }

    await page.getByRole("button", { name: "教程", exact: true }).click();
    await page.getByRole("heading", { name: "词书构建教程" }).waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "build_guide");
    captured.push("build_guide");
    await page.getByRole("button", { name: /返回/ }).first().click();

    await clickBottomTab(page, "我的");
    await page.getByRole("heading", { name: "学习统计" }).waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "profile_home");
    captured.push("profile_home");

    await page.getByRole("button", { name: "进入实验室", exact: true }).click();
    await page.getByRole("heading", { name: "实验室" }).first().waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "ai_lab");
    captured.push("ai_lab");
    await page.getByRole("button", { name: /返回/ }).first().click();

    await page.getByRole("button", { name: "查看学习数据", exact: true }).click();
    await page.getByRole("heading", { name: "学习数据" }).waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "stats_history");
    captured.push("stats_history");

    await page.getByRole("button", { name: "未来模式", exact: true }).click();
    await page.getByText("未来 7 天复习压力").waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "stats_future");
    captured.push("stats_future");
    await page.getByRole("button", { name: /返回/ }).first().click();

    const planningRow = page.locator(".field-row").filter({ hasText: "规划单词" }).first();
    const planningEnable = planningRow.getByRole("button", { name: "开启", exact: true });
    if (await planningEnable.isVisible().catch(() => false)) {
      await planningEnable.click();
      await sleep(220);
    }

    await clickBottomTab(page, "词库");
    const detailOpened = await openBookDetail(page, ["完整词库", "完整词库（精选）"]);
    if (!detailOpened) {
      throw new Error("未能打开词书详情，无法进入今日新词选择");
    }

    const todayPlanButton = page.getByRole("button", { name: "今日新词自主选择", exact: true });
    await todayPlanButton.waitFor({ timeout: 10_000 });
    await todayPlanButton.click();
    await page.getByRole("heading", { name: "今日新词选择" }).waitFor({ timeout: 10_000 });
    await saveScreenshot(page, "today_plan");
    captured.push("today_plan");

    const capturedSet = new Set(captured);
    const missed = scenarios
      .map((item) => item.id)
      .filter((id) => !capturedSet.has(id));

    const report = {
      generatedAt: new Date().toISOString(),
      baseUrl,
      viewport,
      totalScenarios: scenarios.length,
      capturedCount: captured.length,
      captured,
      missed,
      errors,
    };

    await fs.writeFile(
      path.join(reportDir, "web_capture_report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    if (missed.length > 0 || errors.length > 0) {
      console.log(`网页截图完成，但有未覆盖场景 ${missed.length} 个，警告 ${errors.length} 个。`);
    } else {
      console.log("网页截图已全部完成。");
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  await applyLocalLibraryPath();
  await ensureDirs();
  await cleanWebScreenshots();

  try {
    if (!useExistingServer) {
      startDevServer();
    }

    await waitForServer();
    await runCapture();
  } finally {
    if (!useExistingServer) {
      await stopDevServer();
    }
  }
}

main().catch(async (error) => {
  const fallback = {
    generatedAt: new Date().toISOString(),
    failed: true,
    error: error instanceof Error ? error.message : String(error),
  };

  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, "web_capture_report.json"),
    `${JSON.stringify(fallback, null, 2)}\n`,
    "utf8",
  );

  console.error(error);
  process.exit(1);
});
