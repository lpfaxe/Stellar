#!/usr/bin/env node
// 构建 Windows 单文件启动器 Stellar.exe。
//
// 产物 = 一个 exe：内部带 /resource 嵌入的 Stellar.payload.zip（当前仓库快照）。
//   · 放在空目录里双击 → 问一个目标目录，解压出来，再跑「首次启动.bat」
//   · 放在程序目录里双击 → 直接进菜单（首次检查 / 启动桥接 / 打开控制台）
//
// 依赖：Windows 自带的 .NET Framework 4.8（csc.exe）与 PowerShell。不下载任何东西。
// 用法：
//   node scripts/build-windows-exe.mjs                 # 产物在 dist/Stellar.exe
//   node scripts/build-windows-exe.mjs --out foo.exe   # 指定输出
//   node scripts/build-windows-exe.mjs --keep-stage    # 保留临时目录以便排查
//
// 为什么产物不进 git：3 MB 二进制在每次重建时都会让仓库历史翻倍，安装清单也算它的哈希。
// 正确做法是把 exe 挂到 GitHub Release 当资产（见 docs/guides/getting-started/INSTALL.md）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "scripts", "windows", "StellarLauncher.cs");
const PAYLOAD_NAME = "Stellar.payload.zip";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const outFile = path.resolve(ROOT, opt("--out", path.join("dist", "Stellar.exe")));
const keepStage = flag("--keep-stage");

// 不进包的东西：仓库元数据、依赖、运行时状态、构建产物。
const SKIP_DIRS = new Set([".git", "node_modules", "state", "dist"]);

function fail(message) {
  console.error("[build] " + message);
  process.exit(1);
}

function findCsc() {
  const candidates = [
    "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  fail("找不到 csc.exe（.NET Framework 4.x）。这个脚本只在 Windows 上跑。");
}

function findPowershell() {
  const c = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  if (fs.existsSync(c)) return c;
  fail("找不到 powershell.exe。");
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    timeout: opts.timeout || 600000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (res.stdout || "") + (res.stderr || "");
  if (res.status !== 0) fail(cmd + " 退出码 " + res.status + "\n" + out.trim().slice(0, 4000));
  return out;
}

function stageTree(dest) {
  let files = 0;
  let bytes = 0;
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.toLowerCase().endsWith(".exe")) continue;
      const from = path.join(src, entry.name);
      const to = path.join(dst, entry.name);
      if (entry.isDirectory()) { walk(from, to); continue; }
      if (!entry.isFile()) continue;
      // config.json 不放：首次启动时 bootstrap 会从 config.example.json 复制一份，
      // 包里带一份空配置只会让人以为「已经配好了」。
      if (entry.name === "config.json" && src === ROOT) continue;
      fs.copyFileSync(from, to);
      files++;
      bytes += fs.statSync(to).size;
    }
  };
  walk(ROOT, dest);
  return { files, bytes };
}

function makeZip(stageDir, zipPath) {
  const ps = findPowershell();
  const win = (p) => p.replace(/\//g, "\\");
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem;",
    "[IO.Compression.ZipFile]::CreateFromDirectory(" + JSON.stringify(win(stageDir)) + "," + JSON.stringify(win(zipPath)) + ",[IO.Compression.CompressionLevel]::Optimal,$false);",
  ].join(" ");
  run(ps, ["-NoProfile", "-NonInteractive", "-Command", script]);
}

function compile(outPath, zipPath, workDir) {
  const csc = findCsc();
  // csc 读不了含非 ASCII 的源码路径（CS1504），所以复制到临时目录再编译。
  const localCs = path.join(workDir, "StellarLauncher.cs");
  fs.copyFileSync(LAUNCHER, localCs);
  fs.copyFileSync(zipPath, path.join(workDir, PAYLOAD_NAME));
  run(csc, [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/out:" + path.basename(outPath),
    "/r:System.dll",
    "/r:System.Core.dll",
    "/r:System.IO.Compression.dll",
    "/r:System.IO.Compression.FileSystem.dll",
    "/resource:" + PAYLOAD_NAME + "," + PAYLOAD_NAME,
    "StellarLauncher.cs",
  ], { cwd: workDir });
  fs.copyFileSync(path.join(workDir, path.basename(outPath)), outPath);
}

function main() {
  if (process.platform !== "win32") fail("这个脚本只在 Windows 上跑（需要 csc.exe）。");
  if (!fs.existsSync(LAUNCHER)) fail("缺少启动器源码：" + LAUNCHER);
  if (!fs.existsSync(path.join(ROOT, "src", "bridge.js"))) fail("这个目录不像 Stellar 仓库根目录（缺 src/bridge.js）。");

  const tmpRoot = process.env.TEMP || process.env.TMP || os.tmpdir();
  const work = fs.mkdtempSync(path.join(tmpRoot, "stellar-exe-"));
  const stageDir = path.join(work, "stage");
  const zipPath = path.join(work, PAYLOAD_NAME);
  fs.mkdirSync(stageDir, { recursive: true });

  try {
    console.log("[build] 收集文件…");
    const staged = stageTree(stageDir);
    console.log("[build] " + staged.files + " 个文件 / " + (staged.bytes / 1048576).toFixed(2) + " MB");

    console.log("[build] 打包载荷…");
    makeZip(stageDir, zipPath);
    const zipSize = fs.statSync(zipPath).size;
    console.log("[build] " + PAYLOAD_NAME + " " + (zipSize / 1048576).toFixed(2) + " MB");

    console.log("[build] 编译 exe…");
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    compile(outFile, zipPath, work);

    const size = fs.statSync(outFile).size;
    console.log("[build] 完成：" + outFile);
    console.log("[build] " + (size / 1048576).toFixed(2) + " MB（未签名；首次运行 Windows 会提示「未知发布者」，点「更多信息 → 仍要运行」）");
    console.log("[build] 自检：node " + path.relative(ROOT, outFile) + " --check");
  } finally {
    if (keepStage) console.log("[build] 临时目录保留在 " + work);
    else fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
