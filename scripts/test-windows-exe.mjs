// 钉住 Windows 启动器的几条不变量。不编译、不联网、不碰真实目录。
//
// 为什么值得单独测：Stellar.exe 是别人对这个项目的第一印象，
// 而它的行为藏在 C# 源码里 —— 解压时忘了防 ../、或者覆盖了用户的 config.json，
// 都不会让任何 JS 测试变红。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CS = path.join(ROOT, "scripts", "windows", "StellarLauncher.cs");
const BUILD = path.join(ROOT, "scripts", "build-windows-exe.mjs");

test("启动器源码与构建脚本都在", () => {
  assert.ok(fs.existsSync(CS), "缺 scripts/windows/StellarLauncher.cs");
  assert.ok(fs.existsSync(BUILD), "缺 scripts/build-windows-exe.mjs");
});

test("解压时拒绝 ../ 路径穿越", () => {
  const src = fs.readFileSync(CS, "utf8");
  assert.match(src, /rel\.Contains\("\.\."\)/, "解压循环里必须有 ../ 检查");
});

test("解压不覆盖已有的 config.json", () => {
  const src = fs.readFileSync(CS, "utf8");
  assert.match(src, /config\.json/, "要专门判断 config.json");
  assert.match(src, /File\.Exists\(dest\)/, "判断目标已存在才跳过");
});

test("能让用户选择目录，且有默认值", () => {
  const src = fs.readFileSync(CS, "utf8");
  assert.match(src, /--extract/, "要支持无人值守解压（构建自检用）");
  assert.match(src, /DefaultTarget\(\)/, "要有默认目录");
});

test("exe 不会自己装 DSH / SnowLuma", () => {
  const src = fs.readFileSync(CS, "utf8");
  assert.doesNotMatch(src, /Process\.Start\("[^"]*(msiexec|winget|choco|npm)/i);
});

test("构建脚本把 exe 挡在仓库外", () => {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gi, /^\/dist\/$/m, "dist/ 必须被 git 忽略");
});
