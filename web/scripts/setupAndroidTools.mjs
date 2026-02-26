import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import https from "node:https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const sdkRoot = path.join(projectRoot, "tools", "android-sdk");
const platformToolsDir = path.join(sdkRoot, "platform-tools");
const zipPath = path.join(sdkRoot, "platform-tools-latest.zip");

function detectPackageUrl() {
  const platform = process.platform;
  if (platform === "linux") {
    return "https://dl.google.com/android/repository/platform-tools-latest-linux.zip";
  }
  if (platform === "darwin") {
    return "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip";
  }
  if (platform === "win32") {
    return "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
  }
  throw new Error(`当前系统 ${platform} 暂不支持自动安装`);
}

async function exists(filePath) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

async function ensureDir() {
  await fs.mkdir(sdkRoot, { recursive: true });
}

function downloadFile(url, outPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, outPath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`下载失败，HTTP 状态码 ${response.statusCode}`));
        response.resume();
        return;
      }

      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", async () => {
        try {
          const buffer = Buffer.concat(chunks);
          await fs.writeFile(outPath, buffer);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", reject);
  });
}

function runPythonUnzip(zipFile, targetDir) {
  return new Promise((resolve, reject) => {
    const code = [
      "import zipfile",
      `zip_path=r'''${zipFile}'''`,
      `target=r'''${targetDir}'''`,
      "with zipfile.ZipFile(zip_path,'r') as z:",
      "    z.extractall(target)",
    ].join("\n");

    const proc = spawn("python3", ["-c", code], {
      stdio: "inherit",
      cwd: projectRoot,
      env: process.env,
    });

    proc.on("exit", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`解压失败，退出码 ${exitCode ?? -1}`));
    });

    proc.on("error", reject);
  });
}

async function main() {
  const adbName = process.platform === "win32" ? "adb.exe" : "adb";
  const adbPath = path.join(platformToolsDir, adbName);
  if (await exists(adbPath)) {
    console.log(`已检测到 Android Platform Tools：${adbPath}`);
    return;
  }

  await ensureDir();
  const url = detectPackageUrl();
  console.log(`开始下载：${url}`);
  await downloadFile(url, zipPath);
  console.log("下载完成，开始解压");
  await runPythonUnzip(zipPath, sdkRoot);
  console.log(`安装完成：${adbPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
