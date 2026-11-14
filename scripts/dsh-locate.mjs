#!/usr/bin/env node
// dsh-locate.mjs — 在「只装了 DSH、没有把任何东西加进 PATH」的机器上找到能用的工具。
//
// 典型场景：用户从 GitHub 下载解压，双击 首次启动.bat。这台机器上
//   · 没有系统 Node（node/npm 都不在 PATH）
//   · 没有 dsh.cmd（桌面版 CLI 在 <安装目录>\resources\runtime\cli\bin\，从没加进 PATH）
// 但 DSH 自己带了一套运行时：~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/{node,pnpm}。
// 所以「找不到」不等于「用不了」，先按下面这些位置找一遍。
//
// 约束：本文件只允许 import node: 内置模块 —— bootstrap 要在 npm install 之前就能跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** PATH 里能不能找到某个可执行文件（Windows 会补 .cmd/.exe 后缀）。 */
export function onPath(name, { env = process.env, exts = ['', '.exe', '.cmd', '.bat'] } = {}) {
  const raw = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of raw) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.existsSync(file) && fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return '';
}

/** DSH 自带 runtime 的根（node / pnpm 都在它下面）。 */
export function dshRuntimeRoot({ env = process.env, home = env.USERPROFILE || os.homedir() } = {}) {
  const dshHome = env.DSH_HOME || path.join(home, '.dsh');
  const base = path.join(dshHome, 'dsh-runtimes');
  const candidates = [path.join(base, 'dsh-primary-runtime')];
  try {
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      if (fs.existsSync(path.join(dir, 'dependencies'))) candidates.push(dir);
    }
  } catch {}
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'dependencies'))) return dir;
  }
  return '';
}

/** 找真正能跑 .mjs 的 node：PATH → DSH_NODE → DSH 自带 runtime → Program Files。 */
export function findDshNode({ env = process.env, home = env.USERPROFILE || os.homedir(), execPath = process.execPath } = {}) {
  const fromPath = onPath('node', { env, exts: process.platform === 'win32' ? ['', '.exe'] : [''] });
  if (fromPath) return fromPath;
  const runtime = dshRuntimeRoot({ env, home });
  const candidates = [
    env.DSH_NODE,
    runtime && path.join(runtime, 'dependencies', 'node', 'bin', 'node.exe'),
    runtime && path.join(runtime, 'dependencies', 'node', 'bin', 'node'),
    // 从 DSH Desktop 安装目录里跑（Harness.exe）时的同级布局
    path.join(path.dirname(String(execPath || '')), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
  ];
  for (const file of [...new Set(candidates.filter(Boolean))]) {
    try { if (/^node(\.exe)?$/i.test(path.basename(file)) && fs.existsSync(file)) return file; } catch {}
  }
  return '';
}

/** pnpm 的入口是 .cjs，要用 node 去跑（它本身不是可执行文件）。 */
export function findDshPnpm({ env = process.env, home = env.USERPROFILE || os.homedir() } = {}) {
  const runtime = dshRuntimeRoot({ env, home });
  const candidates = [
    env.DSH_PNPM,
    runtime && path.join(runtime, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
  for (const file of [...new Set(candidates.filter(Boolean))]) {
    try { if (fs.existsSync(file)) return file; } catch {}
  }
  return '';
}

/**
 * 找 dsh CLI。桌面版装在 <install>\resources\runtime\cli\bin\dsh.cmd，默认不在 PATH 里，
 * 所以除了 PATH 还要看正在运行的 DSH 进程（detect-profile 已经这么干过）。
 */
export function findDshCmd({ env = process.env, home = env.USERPROFILE || os.homedir(), execPath = process.execPath } = {}) {
  const names = process.platform === 'win32' ? ['dsh', 'dsh.cmd'] : ['dsh'];
  if (env.DSH_CLI) {
    try { if (fs.existsSync(env.DSH_CLI)) return env.DSH_CLI; } catch {}
  }
  for (const name of names) {
    const hit = onPath(name, { env, exts: process.platform === 'win32' ? ['', '.cmd', '.exe'] : [''] });
    if (hit) return hit;
  }
  const fromInstall = (installDir) => {
    if (!installDir) return '';
    const cli = path.join(installDir, 'resources', 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
    try { return fs.existsSync(cli) ? cli : ''; } catch { return ''; }
  };
  // 我们自己就住在安装目录里（极少见，但便宜）
  const near = fromInstall(path.dirname(String(execPath || '')));
  if (near) return near;
  // 正在运行的 DSH 桌面进程 → 安装目录
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        "Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path"
      ], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      const exe = String(out || '').trim().split(/\r?\n/)[0];
      if (exe) {
        const hit = fromInstall(path.dirname(exe));
        if (hit) return hit;
      }
    } catch {}
  }
  return '';
}

/** 给用户手动跑的那一条命令（找不到 CLI 时用来提示，别让他们猜）。 */
export function dshPluginInstallCommand(profile) {
  return 'dsh plugin --profile ' + profile + ' install';
}
