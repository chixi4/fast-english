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
const mobileWebDir = path.join(compareRoot, "mobile_web_visible52");
const outputRoot = path.join(compareRoot, "first51_mobile_review");
const diffDir = path.join(outputRoot, "diff");
const panelDir = path.join(outputRoot, "panels");
const reportJsonPath = path.join(outputRoot, "first51_compare_summary.json");
const reportMdPath = path.join(outputRoot, "first51_compare_summary.md");

async function ensureDirs() {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.mkdir(diffDir, { recursive: true });
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
    throw new Error("缺少 visible52_features.json");
  }
  const content = await fs.readFile(featuresPath, "utf8");
  const all = JSON.parse(content);
  return all.filter((item) => Number(item.index) >= 1 && Number(item.index) <= 51);
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

function pasteAt(target, source, offsetX) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const srcOffset = (source.width * y + x) * 4;
      const dstOffset = (target.width * y + (x + offsetX)) * 4;
      target.data[dstOffset] = source.data[srcOffset];
      target.data[dstOffset + 1] = source.data[srcOffset + 1];
      target.data[dstOffset + 2] = source.data[srcOffset + 2];
      target.data[dstOffset + 3] = source.data[srcOffset + 3];
    }
  }
}

function normalizePair(androidPng, mobileWebPng) {
  const width = Math.max(androidPng.width, mobileWebPng.width);
  const height = Math.max(androidPng.height, mobileWebPng.height);
  const androidCanvas = createWhiteCanvas(width, height);
  const webCanvas = createWhiteCanvas(width, height);
  pasteAt(androidCanvas, androidPng, 0);
  pasteAt(webCanvas, mobileWebPng, 0);
  return { width, height, androidCanvas, webCanvas };
}

function buildPanel(androidCanvas, webCanvas, diffCanvas) {
  const panel = createWhiteCanvas(androidCanvas.width * 3, androidCanvas.height);
  pasteAt(panel, androidCanvas, 0);
  pasteAt(panel, webCanvas, androidCanvas.width);
  pasteAt(panel, diffCanvas, androidCanvas.width * 2);
  return panel;
}

function toPercent(diffPixels, totalPixels) {
  if (!totalPixels) return 0;
  return (diffPixels / totalPixels) * 100;
}

function levelByDiffPercent(diffPercent) {
  if (diffPercent < 10) return "低";
  if (diffPercent < 25) return "中";
  return "高";
}

async function main() {
  await ensureDirs();
  await cleanPngDir(diffDir);
  await cleanPngDir(panelDir);
  const features = await loadFeatures();

  const results = [];

  for (const feature of features) {
    const androidPath = path.join(androidDir, `${feature.id}.png`);
    const webPath = path.join(mobileWebDir, `${feature.id}.png`);
    const diffPath = path.join(diffDir, `${feature.id}.png`);
    const panelPath = path.join(panelDir, `${feature.id}_panel.png`);

    const androidExists = await fs.stat(androidPath).then(() => true).catch(() => false);
    const webExists = await fs.stat(webPath).then(() => true).catch(() => false);

    if (!androidExists || !webExists) {
      results.push({
        index: feature.index,
        id: feature.id,
        module: feature.module,
        feature: feature.feature,
        status: !androidExists && !webExists ? "MISSING_BOTH" : !androidExists ? "MISSING_ANDROID" : "MISSING_WEB",
        diffPixels: null,
        diffPercent: null,
        diffLevel: "高",
        panelPath: null,
        androidPath: androidExists ? androidPath : null,
        mobileWebPath: webExists ? webPath : null,
      });
      continue;
    }

    const androidPng = await readPng(androidPath);
    const webPng = await readPng(webPath);
    const { width, height, androidCanvas, webCanvas } = normalizePair(androidPng, webPng);
    const diffPng = new PNG({ width, height });
    const diffPixels = pixelmatch(androidCanvas.data, webCanvas.data, diffPng.data, width, height, {
      threshold: 0.1,
      includeAA: true,
      alpha: 0.65,
    });
    const diffPercent = Number(toPercent(diffPixels, width * height).toFixed(4));
    await fs.writeFile(diffPath, PNG.sync.write(diffPng));

    const panel = buildPanel(androidCanvas, webCanvas, diffPng);
    await fs.writeFile(panelPath, PNG.sync.write(panel));

    results.push({
      index: feature.index,
      id: feature.id,
      module: feature.module,
      feature: feature.feature,
      status: diffPixels === 0 ? "MATCH" : "DIFF",
      diffPixels,
      diffPercent,
      diffLevel: levelByDiffPercent(diffPercent),
      panelPath,
      androidPath,
      mobileWebPath: webPath,
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
    highDiff: results.filter((item) => item.diffLevel === "高").length,
    mediumDiff: results.filter((item) => item.diffLevel === "中").length,
    lowDiff: results.filter((item) => item.diffLevel === "低").length,
    results,
  };

  const markdown = [
    "# 前51项真实手机截图对比总表",
    "",
    `生成时间：${summary.generatedAt}`,
    `总数：${summary.total}`,
    `一致：${summary.matched}`,
    `差异：${summary.diffed}`,
    `缺安卓：${summary.missingAndroid}`,
    `缺网页：${summary.missingWeb}`,
    `缺双方：${summary.missingBoth}`,
    `高差异：${summary.highDiff}`,
    `中差异：${summary.mediumDiff}`,
    `低差异：${summary.lowDiff}`,
    "",
    "面板说明：每张面板从左到右依次是 安卓截图 网页截图 差异图",
    "",
    "| 序号 | 场景ID | 模块 | 功能 | 状态 | 差异率 | 差异等级 | 面板图 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const item of results) {
    const diffPercent = item.diffPercent === null ? "-" : `${item.diffPercent}%`;
    const panelText = item.panelPath ? `\`${path.relative(projectRoot, item.panelPath)}\`` : "-";
    markdown.push(
      `| ${item.index} | ${item.id} | ${item.module} | ${item.feature} | ${item.status} | ${diffPercent} | ${item.diffLevel} | ${panelText} |`,
    );
  }

  await fs.writeFile(reportJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(reportMdPath, `${markdown.join("\n")}\n`, "utf8");

  console.log(`REPORT_JSON ${reportJsonPath}`);
  console.log(`REPORT_MD ${reportMdPath}`);
  console.log(
    `SUMMARY total=${summary.total} matched=${summary.matched} diffed=${summary.diffed} high=${summary.highDiff} medium=${summary.mediumDiff} low=${summary.lowDiff}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
