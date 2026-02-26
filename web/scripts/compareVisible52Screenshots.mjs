import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const compareRoot = path.join(projectRoot, "screenshot_compare");
const featuresPath = path.join(compareRoot, "visible52_features.json");
const androidDir = path.join(compareRoot, "android_visible52");
const webDir = path.join(compareRoot, "web_visible52");
const diffDir = path.join(compareRoot, "diff_visible52");
const reportDir = path.join(compareRoot, "report");
const panelDir = path.join(reportDir, "panels_visible52");

async function ensureDirs() {
  await fs.mkdir(androidDir, { recursive: true });
  await fs.mkdir(webDir, { recursive: true });
  await fs.mkdir(diffDir, { recursive: true });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.mkdir(panelDir, { recursive: true });
}

async function cleanPngDir(dirPath) {
  const files = await fs.readdir(dirPath);
  await Promise.all(
    files
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => fs.unlink(path.join(dirPath, name))),
  );
}

async function loadFeatures() {
  const exists = await fs.stat(featuresPath).then(() => true).catch(() => false);
  if (!exists) {
    throw new Error("缺少 visible52_features.json，请先执行 npm run qa:visible52 或 npm run screenshot:web:visible52");
  }
  const content = await fs.readFile(featuresPath, "utf8");
  return JSON.parse(content);
}

async function readPng(filePath) {
  const buffer = await fs.readFile(filePath);
  return PNG.sync.read(buffer);
}

function createWhiteCanvas(width, height) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (let i = 3; i < png.data.length; i += 4) {
    png.data[i] = 255;
  }
  return png;
}

function pasteImage(target, source) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const srcOffset = (source.width * y + x) * 4;
      const dstOffset = (target.width * y + x) * 4;
      target.data[dstOffset] = source.data[srcOffset];
      target.data[dstOffset + 1] = source.data[srcOffset + 1];
      target.data[dstOffset + 2] = source.data[srcOffset + 2];
      target.data[dstOffset + 3] = source.data[srcOffset + 3];
    }
  }
}

function normalizePair(androidPng, webPng) {
  const width = Math.max(androidPng.width, webPng.width);
  const height = Math.max(androidPng.height, webPng.height);
  const androidCanvas = createWhiteCanvas(width, height);
  const webCanvas = createWhiteCanvas(width, height);
  pasteImage(androidCanvas, androidPng);
  pasteImage(webCanvas, webPng);
  return { width, height, androidCanvas, webCanvas };
}

function buildPanel(androidCanvas, webCanvas, diffCanvas) {
  const width = androidCanvas.width * 3;
  const height = androidCanvas.height;
  const panel = createWhiteCanvas(width, height);

  pasteImage(panel, androidCanvas);

  for (let y = 0; y < webCanvas.height; y += 1) {
    for (let x = 0; x < webCanvas.width; x += 1) {
      const srcOffset = (webCanvas.width * y + x) * 4;
      const dstOffset = (panel.width * y + (x + webCanvas.width)) * 4;
      panel.data[dstOffset] = webCanvas.data[srcOffset];
      panel.data[dstOffset + 1] = webCanvas.data[srcOffset + 1];
      panel.data[dstOffset + 2] = webCanvas.data[srcOffset + 2];
      panel.data[dstOffset + 3] = webCanvas.data[srcOffset + 3];
    }
  }

  for (let y = 0; y < diffCanvas.height; y += 1) {
    for (let x = 0; x < diffCanvas.width; x += 1) {
      const srcOffset = (diffCanvas.width * y + x) * 4;
      const dstOffset = (panel.width * y + (x + diffCanvas.width * 2)) * 4;
      panel.data[dstOffset] = diffCanvas.data[srcOffset];
      panel.data[dstOffset + 1] = diffCanvas.data[srcOffset + 1];
      panel.data[dstOffset + 2] = diffCanvas.data[srcOffset + 2];
      panel.data[dstOffset + 3] = diffCanvas.data[srcOffset + 3];
    }
  }

  return panel;
}

function toPercent(diffPixels, totalPixels) {
  if (!totalPixels) return 0;
  return (diffPixels / totalPixels) * 100;
}

async function main() {
  await ensureDirs();
  await cleanPngDir(diffDir);
  await cleanPngDir(panelDir);

  const features = await loadFeatures();
  const results = [];

  for (const feature of features) {
    const androidPath = path.join(androidDir, `${feature.id}.png`);
    const webPath = path.join(webDir, `${feature.id}.png`);
    const diffPath = path.join(diffDir, `${feature.id}.png`);

    const androidExists = await fs.stat(androidPath).then(() => true).catch(() => false);
    const webExists = await fs.stat(webPath).then(() => true).catch(() => false);

    if (!androidExists || !webExists) {
      results.push({
        index: feature.index,
        id: feature.id,
        module: feature.module,
        feature: feature.feature,
        status: !androidExists && !webExists ? "MISSING_BOTH" : !androidExists ? "MISSING_ANDROID" : "MISSING_WEB",
        androidPath: androidExists ? androidPath : null,
        webPath: webExists ? webPath : null,
        diffPath: null,
        panelPath: null,
        width: null,
        height: null,
        diffPixels: null,
        diffPercent: null,
        visualReview: "PENDING",
      });
      continue;
    }

    const androidPng = await readPng(androidPath);
    const webPng = await readPng(webPath);
    const { width, height, androidCanvas, webCanvas } = normalizePair(androidPng, webPng);

    const diff = new PNG({ width, height });
    const diffPixels = pixelmatch(
      androidCanvas.data,
      webCanvas.data,
      diff.data,
      width,
      height,
      { threshold: 0.1, includeAA: true, alpha: 0.65 },
    );

    const totalPixels = width * height;
    const diffPercent = toPercent(diffPixels, totalPixels);
    await fs.writeFile(diffPath, PNG.sync.write(diff));

    const panel = buildPanel(androidCanvas, webCanvas, diff);
    const panelPath = path.join(panelDir, `${feature.id}_panel.png`);
    await fs.writeFile(panelPath, PNG.sync.write(panel));

    results.push({
      index: feature.index,
      id: feature.id,
      module: feature.module,
      feature: feature.feature,
      status: diffPixels === 0 ? "MATCH" : "DIFF",
      androidPath,
      webPath,
      diffPath,
      panelPath,
      width,
      height,
      diffPixels,
      diffPercent: Number(diffPercent.toFixed(4)),
      visualReview: "PENDING",
      androidOriginalSize: { width: androidPng.width, height: androidPng.height },
      webOriginalSize: { width: webPng.width, height: webPng.height },
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    matched: results.filter((item) => item.status === "MATCH").length,
    diffed: results.filter((item) => item.status === "DIFF").length,
    missingAndroid: results.filter((item) => item.status === "MISSING_ANDROID").length,
    missingWeb: results.filter((item) => item.status === "MISSING_WEB").length,
    missingBoth: results.filter((item) => item.status === "MISSING_BOTH").length,
    results,
  };

  const markdownLines = [
    "# 52 点 PNG 对比报告",
    "",
    `生成时间：${summary.generatedAt}`,
    `总场景：${summary.total}`,
    `完全一致：${summary.matched}`,
    `有差异：${summary.diffed}`,
    `缺少安卓截图：${summary.missingAndroid}`,
    `缺少网页截图：${summary.missingWeb}`,
    `安卓与网页都缺失：${summary.missingBoth}`,
    "",
    "面板图说明：每张面板从左到右依次是 安卓截图 网页截图 差异图",
    "",
    "| 序号 | 场景ID | 模块 | 功能 | 状态 | 差异像素 | 差异率 | 视觉复核 |",
    "| ---: | --- | --- | --- | --- | ---: | ---: | --- |",
  ];

  for (const item of results) {
    markdownLines.push(
      `| ${item.index} | ${item.id} | ${item.module} | ${item.feature} | ${item.status} | ${item.diffPixels ?? "-"} | ${item.diffPercent ?? "-"} | ${item.visualReview} |`,
    );
  }

  const visualLines = [
    "# 52 点视觉复核记录",
    "",
    `生成时间：${summary.generatedAt}`,
    "",
    "| 序号 | 场景ID | 功能 | 面板图 | 视觉结论 | 主要差异说明 |",
    "| ---: | --- | --- | --- | --- | --- |",
  ];

  for (const item of results) {
    const panelRef = item.panelPath ? path.relative(projectRoot, item.panelPath) : "-";
    visualLines.push(
      `| ${item.index} | ${item.id} | ${item.feature} | ${panelRef} | ${item.status === "MISSING_ANDROID" ? "待安卓截图" : "待人工复核"} | - |`,
    );
  }

  await fs.writeFile(
    path.join(reportDir, "compare_visible52_summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  await fs.writeFile(
    path.join(reportDir, "compare_visible52_summary.md"),
    `${markdownLines.join("\n")}\n`,
    "utf8",
  );

  await fs.writeFile(
    path.join(reportDir, "visual_review_visible52.md"),
    `${visualLines.join("\n")}\n`,
    "utf8",
  );

  console.log(
    `52 点对比完成：一致 ${summary.matched}，差异 ${summary.diffed}，缺少安卓 ${summary.missingAndroid}，缺少网页 ${summary.missingWeb}。`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
