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
const baseUrl = process.env.QA_BASE_URL || "http://127.0.0.1:4173";
const useExistingServer = process.env.QA_USE_EXISTING === "1";
const localDepsLibDir = path.join(projectRoot, ".playwright-deps", "usr", "lib", "x86_64-linux-gnu");

let devServer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

async function applyLocalLibraryPath() {
  const exists = await fs.stat(localDepsLibDir).then(() => true).catch(() => false);
  if (!exists) return;
  const current = process.env.LD_LIBRARY_PATH?.trim();
  process.env.LD_LIBRARY_PATH = current ? `${localDepsLibDir}:${current}` : localDepsLibDir;
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
    await sleep(250);
  }
}

async function openApp(page) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "学习", exact: true }).waitFor({ timeout: 60_000 });
  await sleep(900);
  await dismissSwipeGuide(page);
}

async function clickBottomTab(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  await sleep(320);
}

async function closeDialog(page) {
  const closeButton = page.locator(".dialog-head .icon-button").first();
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click();
    await sleep(220);
  }
}

async function readLearningProgress(page) {
  const text = await page.locator(".learning-meta-line").innerText();
  const match = text.match(/学习进度\s*(\d+)\/(\d+)/);
  if (!match) {
    throw new Error(`无法解析学习进度: ${text}`);
  }
  return {
    current: Number(match[1]),
    total: Number(match[2]),
    raw: text,
  };
}

async function dragWordCard(page, ratio) {
  const card = page.locator(".word-flip-area").first();
  await card.waitFor({ timeout: 15_000 });
  const box = await card.boundingBox();
  if (!box) {
    throw new Error("学习卡片未渲染");
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const deltaX = box.width * ratio;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY, { steps: 12 });
  await page.mouse.up();
  await sleep(260);
}

async function runScenario(browser, scenario) {
  const context = await browser.newContext({
    viewport: { width: 420, height: 934 },
    deviceScaleFactor: 3,
    locale: "zh-CN",
  });
  const page = await context.newPage();

  try {
    const detail = await scenario.run(page);
    return {
      step: scenario.name,
      ok: true,
      detail,
    };
  } catch (error) {
    return {
      step: scenario.name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await context.close();
  }
}

const scenarios = [
  {
    name: "学习页-左滑太简单撤销回滚",
    run: async (page) => {
      await openApp(page);
      await page.getByRole("button", { name: "认词模式", exact: true }).click();
      await sleep(180);
      const before = await readLearningProgress(page);

      await page.getByRole("button", { name: "左滑太简单", exact: true }).click();
      await page.locator(".snackbar").filter({ hasText: "已标记为太简单" }).first().waitFor({ timeout: 6_000 });
      const afterMark = await readLearningProgress(page);

      await page.locator(".snackbar").getByRole("button", { name: "撤销", exact: true }).click();
      await sleep(320);
      const afterUndo = await readLearningProgress(page);

      assert(afterUndo.current === before.current && afterUndo.total === before.total, `撤销未回滚: before=${before.current}/${before.total} afterUndo=${afterUndo.current}/${afterUndo.total}`);
      return `before=${before.current}/${before.total} afterMark=${afterMark.current}/${afterMark.total} afterUndo=${afterUndo.current}/${afterUndo.total}`;
    },
  },
  {
    name: "学习页-拼写失败三次后抄写继续",
    run: async (page) => {
      await openApp(page);
      await page.getByRole("button", { name: "拼写模式", exact: true }).click();
      await page.getByText("拼写练习", { exact: true }).waitFor({ timeout: 10_000 });

      const before = await readLearningProgress(page);
      for (let i = 0; i < 3; i += 1) {
        await page.getByPlaceholder("请输入单词拼写").fill(`zzz${i}`);
        await page.getByRole("button", { name: /^(提交|重试)$/ }).click();
        await sleep(150);
      }

      const correctText = page.locator(".error-text").filter({ hasText: "正确拼写：" }).first();
      await correctText.waitFor({ timeout: 8_000 });
      await sleep(600);
      assert(await correctText.isVisible(), "第三次拼写失败后未停留在抄写继续界面");

      const afterFail = await readLearningProgress(page);
      assert(afterFail.current === before.current, `失败后直接跳词: before=${before.current}/${before.total} afterFail=${afterFail.current}/${afterFail.total}`);

      const correctWord = (await correctText.innerText()).replace("正确拼写：", "").trim();
      assert(correctWord.length > 0, "未读取到正确拼写文本");

      await page.getByPlaceholder("请抄写正确拼写后继续").fill(correctWord);
      await page.getByRole("button", { name: "继续", exact: true }).click();
      await page.getByPlaceholder("请输入单词拼写").waitFor({ timeout: 8_000 });

      const afterContinue = await readLearningProgress(page);
      assert(afterContinue.current >= before.current + 1, `抄写继续后进度未推进: before=${before.current} afterContinue=${afterContinue.current}`);
      return `before=${before.current}/${before.total} afterFail=${afterFail.current}/${afterFail.total} afterContinue=${afterContinue.current}/${afterContinue.total} word=${correctWord}`;
    },
  },
  {
    name: "学习页-星标双向切换",
    run: async (page) => {
      await openApp(page);
      const star = page.locator(".star-toggle").first();
      await star.waitFor({ timeout: 10_000 });

      const initialChecked = ((await star.getAttribute("class")) ?? "").includes("checked");
      await star.click();
      await sleep(180);
      const firstChecked = ((await star.getAttribute("class")) ?? "").includes("checked");
      await star.click();
      await sleep(180);
      const secondChecked = ((await star.getAttribute("class")) ?? "").includes("checked");

      assert(firstChecked !== initialChecked && secondChecked === initialChecked, `星标切换失败: initial=${initialChecked} first=${firstChecked} second=${secondChecked}`);
      return `initial=${initialChecked} first=${firstChecked} second=${secondChecked}`;
    },
  },
  {
    name: "学习页-AI关闭后入口隐藏",
    run: async (page) => {
      await openApp(page);
      await clickBottomTab(page, "我的");
      await page.getByRole("button", { name: "进入实验室", exact: true }).click();
      await page.getByRole("heading", { name: "实验室", exact: true }).waitFor({ timeout: 12_000 });

      const aiRow = page.locator(".switch-row").filter({ hasText: "启用 AI 增强" }).first();
      const aiSwitch = aiRow.locator("input[type='checkbox']");
      const wasEnabled = await aiSwitch.isChecked();
      if (wasEnabled) {
        await aiRow.locator("label.switch span").click();
      }
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      await page.locator(".snackbar").filter({ hasText: "AI 配置已保存" }).first().waitFor({ timeout: 8_000 });

      await page.getByRole("button", { name: "返回", exact: true }).first().click();
      await clickBottomTab(page, "学习");
      await page.getByRole("button", { name: "认词模式", exact: true }).waitFor({ timeout: 10_000 });

      const aiEntry = page.locator(".learning-card-bottom button").filter({ hasText: /^(AI|助记推荐)$/ }).first();
      const visible = await aiEntry.isVisible().catch(() => false);
      assert(!visible, "AI 已关闭但学习页仍显示 AI 入口");
      return `aiEnabledBefore=${wasEnabled} aiEntryVisible=${visible}`;
    },
  },
  {
    name: "学习页-真实拖拽触发右滑入生词本",
    run: async (page) => {
      await openApp(page);
      const before = await readLearningProgress(page);
      await dragWordCard(page, 0.5);
      await page.locator(".snackbar").filter({ hasText: /已加入生词本|已在生词本中/ }).first().waitFor({ timeout: 8_000 });
      const after = await readLearningProgress(page);
      assert(after.current >= before.current + 1, `拖拽未触发切词: before=${before.current}/${before.total} after=${after.current}/${after.total}`);
      return `before=${before.current}/${before.total} after=${after.current}/${after.total}`;
    },
  },
  {
    name: "查词页-搜索与详情",
    run: async (page) => {
      await openApp(page);
      await clickBottomTab(page, "查词");
      await page.getByRole("heading", { name: "查词 / 长句解析", exact: true }).waitFor({ timeout: 10_000 });
      await page.getByPlaceholder("搜索单词，或粘贴长难句（超过20字自动解析）").fill("abandon");
      await page.locator(".search-item").first().waitFor({ timeout: 10_000 });
      await page.locator(".search-item").first().click();
      await page.locator(".dialog-backdrop").first().waitFor({ timeout: 10_000 });

      const wordTitle = await page.locator(".dialog-head h3").first().innerText();
      const actionButton = page.getByRole("button", { name: /生成 AI 助记|重新生成助记/ }).first();
      assert(await actionButton.isVisible(), "查词详情缺少 AI 助记按钮");
      await closeDialog(page);
      return `detailWord=${wordTitle}`;
    },
  },
  {
    name: "词库页-详情与提前复习入口",
    run: async (page) => {
      await openApp(page);
      await clickBottomTab(page, "词库");
      await page.getByRole("heading", { name: "我的词库", exact: true }).waitFor({ timeout: 10_000 });

      const detailButton = page.getByRole("button", { name: "详情", exact: true }).first();
      await detailButton.waitFor({ timeout: 10_000 });
      await detailButton.click();
      await page.locator(".dialog-backdrop").first().waitFor({ timeout: 10_000 });
      const detailTitle = await page.locator(".dialog-head h3").first().innerText();
      await closeDialog(page);

      const earlyButton = page.getByRole("button", { name: "提前复习", exact: true }).first();
      if (await earlyButton.isVisible().catch(() => false)) {
        await earlyButton.click();
        await page.locator(".dialog-head h3").filter({ hasText: "提前复习" }).first().waitFor({ timeout: 8_000 });
        await closeDialog(page);
        return `detail=${detailTitle} earlyReview=opened`;
      }

      return `detail=${detailTitle} earlyReview=not-available`;
    },
  },
  {
    name: "我的页-设置持久化与学习数据入口",
    run: async (page) => {
      await openApp(page);
      await clickBottomTab(page, "我的");
      await page.getByRole("heading", { name: "学习统计", exact: true }).waitFor({ timeout: 10_000 });

      const input = page.locator(".field-row .text-input").first();
      await input.fill("23");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await sleep(220);

      await clickBottomTab(page, "学习");
      await clickBottomTab(page, "我的");
      const persisted = await input.inputValue();
      assert(persisted === "23", `每日新学词数未持久化: ${persisted}`);

      await page.getByRole("button", { name: "查看学习数据", exact: true }).click();
      await page.getByRole("heading", { name: "学习数据", exact: true }).waitFor({ timeout: 10_000 });
      const monthButton = page.getByRole("button", { name: "近30天", exact: true });
      await monthButton.click();
      const monthClass = (await monthButton.getAttribute("class")) ?? "";
      assert(monthClass.includes("active"), "学习数据范围未切换到近30天");
      await page.getByRole("button", { name: "返回", exact: true }).first().click();

      let restoreAlert = "";
      page.once("dialog", async (dialog) => {
        restoreAlert = dialog.message();
        await dialog.accept();
      });
      const restoreInput = page.locator("label.file-button input[type='file']").first();
      await restoreInput.setInputFiles({
        name: "broken.json",
        mimeType: "application/json",
        buffer: Buffer.from("{ invalid json }", "utf8"),
      });
      await page.getByRole("heading", { name: "恢复数据", exact: true }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "继续", exact: true }).click();
      await sleep(350);
      assert(restoreAlert.includes("备份文件解析失败"), `异常备份恢复提示不正确: ${restoreAlert || "empty"}`);

      return `persistedLimit=${persisted} restoreAlert=${restoreAlert}`;
    },
  },
  {
    name: "今日新词-选择流程",
    run: async (page) => {
      await openApp(page);
      await clickBottomTab(page, "我的");
      const plannedRow = page.locator(".field-row").filter({ hasText: "规划单词" }).first();
      await plannedRow.getByRole("button", { name: "开启", exact: true }).click();
      await sleep(200);

      await clickBottomTab(page, "词库");
      await page.getByRole("heading", { name: "我的词库", exact: true }).waitFor({ timeout: 10_000 });

      const detailButtons = page.getByRole("button", { name: "详情", exact: true });
      const detailCount = await detailButtons.count();
      if (detailCount > 1) {
        await detailButtons.nth(1).click();
      } else {
        await detailButtons.first().click();
      }
      await page.locator(".dialog-backdrop").first().waitFor({ timeout: 10_000 });
      const openPlanButton = page.getByRole("button", { name: /今日新词自主选择/ }).first();
      await openPlanButton.waitFor({ timeout: 10_000 });
      await openPlanButton.click();
      await page.getByRole("heading", { name: "今日新词选择", exact: true }).waitFor({ timeout: 10_000 });

      const firstCandidate = page.locator(".selectable-item").first();
      const hasCandidate = await firstCandidate.isVisible().catch(() => false);
      if (hasCandidate) {
        await firstCandidate.click();
        await sleep(120);
      }

      await page.waitForFunction(() => {
        return Array.from(document.querySelectorAll("button")).some((button) => {
          return button.textContent?.trim() === "确认使用";
        });
      }, { timeout: 15_000 });
      await page.evaluate(() => {
        const target = Array.from(document.querySelectorAll("button")).find((button) => {
          return button.textContent?.trim() === "确认使用";
        });
        if (!target) {
          throw new Error("未找到确认使用按钮");
        }
        (target).click();
      });
      await page.getByRole("heading", { name: "我的词库", exact: true }).waitFor({ timeout: 10_000 });

      return hasCandidate ? "selected=1 and confirmed" : "no-candidate confirmed";
    },
  },
];

async function main() {
  await fs.mkdir(reportDir, { recursive: true });
  await applyLocalLibraryPath();

  if (!useExistingServer) {
    startDevServer();
  }

  await waitForServer();

  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const scenario of scenarios) {
      const result = await runScenario(browser, scenario);
      results.push(result);
      const status = result.ok ? "PASS" : "FAIL";
      console.log(`${status} ${result.step} ${result.detail}`);
    }
  } finally {
    await browser.close();
    if (!useExistingServer) {
      await stopDevServer();
    }
  }

  const report = {
    executedAt: new Date().toISOString(),
    pass: results.filter((item) => item.ok).length,
    fail: results.filter((item) => !item.ok).length,
    results,
  };

  const date = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(reportDir, `user_flow_qa_${date}.json`);
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
