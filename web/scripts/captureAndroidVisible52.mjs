import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const compareRoot = path.join(projectRoot, "screenshot_compare");
const featuresPath = path.join(compareRoot, "visible52_features.json");
const androidDir = path.join(compareRoot, "android_visible52");
const localAdbPath = path.join(projectRoot, "tools", "android-sdk", "platform-tools", "adb");

function resolveAdb() {
  return fs
    .stat(localAdbPath)
    .then(() => localAdbPath)
    .catch(() => "adb");
}

function ensureAdbReady(adbExecutable) {
  try {
    execFileSync(adbExecutable, ["version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "未找到 adb，请先执行 npm run android:setup 下载 Android Platform Tools，或自行安装 adb 到系统环境变量",
    );
  }

  const outputText = execFileSync(adbExecutable, ["devices"], { encoding: "utf8" });
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
  const files = await fs.readdir(androidDir);
  await Promise.all(
    files
      .filter((name) => name.toLowerCase().endsWith(".png"))
      .map((name) => fs.unlink(path.join(androidDir, name))),
  );
}

function captureOne(adbExecutable, id) {
  const pngBuffer = execFileSync(adbExecutable, ["exec-out", "screencap", "-p"], {
    encoding: null,
    maxBuffer: 20 * 1024 * 1024,
  });
  return fs.writeFile(path.join(androidDir, `${id}.png`), pngBuffer);
}

async function main() {
  const adbExecutable = await resolveAdb();
  ensureAdbReady(adbExecutable);
  const features = await loadFeatures();
  await cleanAndroidScreenshots();

  const rl = readline.createInterface({ input, output });
  const captured = [];

  try {
    console.log(`共 ${features.length} 个功能点，开始逐个采集安卓截图。`);

    for (let index = 0; index < features.length; index += 1) {
      const feature = features[index];
      await rl.question(
        `\n[${index + 1}/${features.length}] ${feature.module} ${feature.feature}\n请在安卓设备上打开该界面后按回车继续：`,
      );
      await captureOne(adbExecutable, feature.id);
      captured.push(feature.id);
      console.log(`已保存：${feature.id}.png`);
    }
  } finally {
    rl.close();
  }

  await fs.writeFile(
    path.join(compareRoot, "report", "android_visible52_capture_report.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        adbExecutable,
        total: features.length,
        capturedCount: captured.length,
        captured,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("\n安卓 52 点截图采集完成。");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
