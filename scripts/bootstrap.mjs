#!/usr/bin/env node
/**
 * bootstrap.mjs — 第一次跑这个项目时，把「环境检查 + 基础配置」一次做完。
 *
 * 场景：用户从仓库下载并解压，双击「首次启动.bat」（或自己跑这个脚本），
 * 程序自检 Node / 依赖 / 配置 / state / ACL / DSH 注册 / 端口，缺什么补什么。
 *
 * 三条硬约束（决定了下面的写法）：
 *   1. 必须在 **npm install 之前**就能跑 → 本文件只允许 import node: 内置模块；
 *      体检规则在 ./bootstrap-plan.mjs（同样零依赖），依赖装完后再动态 import 插件侧的 doctor.js。
 *   2. **绝不覆盖已有配置**。config.json 存在就只读不动；state/ 存在就不碰内容。
 *   3. 每一步都要能单独失败而不拖垮其它步骤：失败记账继续走，最后统一汇总。
 *
 * 用法：
 *   node scripts/bootstrap.mjs            # 交互：先打印计划，问一句再动手
 *   node scripts/bootstrap.mjs --yes      # 非交互（.bat 用这个）
 *   node scripts/bootstrap.mjs --dry-run  # 只看计划，什么都不改
 *   node scripts/bootstrap.mjs --json     # 机器可读
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MIN_NODE, REQUIRED_DEPS, buildPlan, parseArgs, summarize, nodeSatisfies,
} from './bootstrap-plan.mjs';
import { findDshNode, findDshPnpm, onPath } from './dsh-locate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, 'state');
const CONFIG = path.join(ROOT, 'config.json');
const EXAMPLE = path.join(ROOT, 'config.example.json');
const LOG = path.join(STATE_DIR, 'bootstrap.log');
const NM = path.join(ROOT, 'node_modules');
const NODE_EXE = findDshNode() || process.execPath;

const flags = parseArgs(process.argv.slice(2));
const isTTY = Boolean(process.stdin.isTTY);
const color = Boolean(process.stdout.isTTY) && !flags.json && process.env.NO_COLOR == null;

const c = {
  dim: (s) => (color ? '\x1b[2m' + s + '\x1b[0m' : s),
  green: (s) => (color ? '\x1b[32m' + s + '\x1b[0m' : s),
  yellow: (s) => (color ? '\x1b[33m' + s + '\x1b[0m' : s),
  red: (s) => (color ? '\x1b[31m' + s + '\x1b[0m' : s),
  cyan: (s) => (color ? '\x1b[36m' + s + '\x1b[0m' : s),
};

/** 所有步骤的执行记录：key → { ok, detail }。 */
const ran = new Map();

function say(line = '') {
  if (!flags.json) process.stdout.write(line + '\n');
}

function appendLog(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch { /* 日志写不了不影响主流程 */ }
}

function mark(key, ok, detail = '') {
  ran.set(key, { ok, detail });
  appendLog((ok ? 'ok   ' : 'FAIL ') + key + (detail ? ' :: ' + detail : ''));
  say((ok ? c.green('  ✓') : c.red('  ✗')) + ' ' + (detail || key));
}

// ---------------------------------------------------------------- 环境探测

function detectProfile() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const dir = path.join(home, '.dsh', 'profiles');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return ''; }
  for (const name of names) {
    const base = path.join(dir, name);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
      const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles;
      if (Array.isArray(bundles) && bundles.some((b) => String(b).includes('stellar'))) return name;
    } catch { /* 没有 package.json 就继续看 cordis */ }
    try {
      const yml = fs.readFileSync(path.join(base, 'cordis.patch.yml'), 'utf8');
      if (/stellar|mcp-snowluma/.test(yml)) return name;
    } catch { /* ignore */ }
  }
  return '';
}

function readConfig() {
  if (!fs.existsSync(CONFIG)) return { exists: false, cfg: null };
  try {
    return { exists: true, cfg: JSON.parse(fs.readFileSync(CONFIG, 'utf8')) };
  } catch {
    return { exists: true, cfg: null, broken: true };
  }
}

function countAllow(cfg) {
  if (!cfg) return 0;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && x !== false).length : 0);
  return list(cfg.allow && cfg.allow.groups) + list(cfg.allow && cfg.allow.private);
}

function missingDeps() {
  return REQUIRED_DEPS.filter((name) => !fs.existsSync(path.join(NM, name, 'package.json')));
}

/** 探测端口：判「有人监听」，1.5 秒超时。 */
function probePort(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** config.json 里配的 DSH 地址现在能连上吗（连不上就说明端口变了，要重新同步）。 */
async function probeDsh(cfg) {
  const base = String(cfg?.dsh?.baseUrl ?? '').trim();
  if (!base) return false;
  try {
    const url = new URL(base);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!port) return false;
    return await probePort(port, url.hostname || '127.0.0.1');
  } catch {
    return false;
  }
}

async function probeSnowluma() {
  for (const port of [3000, 3001]) {
    if (await probePort(port)) return true;
  }
  return false;
}

/**
 * @snowluma/* 的 dist 里还有「相对导入没写扩展名」的吗。
 *
 * 必须与 scripts/patch-snowluma-sdk.mjs 用**同一条规则**判断（连"目标文件存在才补"
 * 这条也要一致），否则会出现「计划说已补、补丁说还有」的死循环。
 * 读不了就返回 true：宁可多跑一次幂等补丁，也不要跳过。
 */
function detectSdkNeedsPatch() {
  const specs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) specs.push(full);
    }
  };
  try {
    for (const pkg of ['@snowluma/sdk', '@snowluma/mcp']) {
      const dist = path.join(NM, pkg, 'dist');
      if (!fs.existsSync(dist)) continue;
      specs.length = 0;
      walk(dist);
      for (const file of specs) {
        const src = fs.readFileSync(file, 'utf8');
        const re = /from\s+'(\.(?:[^']+))'/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          const spec = m[1];
          if (spec.endsWith('.js') || spec.endsWith('.json')) continue;
          const target = path.resolve(path.dirname(file), spec);
          if (fs.existsSync(target + '.js') || fs.existsSync(target + '.json')) return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * state/ 的 ACL 现在收紧了吗。
 * 探测失败（没有 state/、icacls 不可用、沙箱禁子进程）一律返回 undefined = 当作没收紧，
 * 让计划里继续排加固步骤 —— 这与 start.bat 每次都跑一遍 harden-state-acl 的取舍一致。
 */
async function detectAclHardened() {
  if (!fs.existsSync(STATE_DIR)) return undefined;
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'state-acl.mjs')).href);
    return mod.isHardened(STATE_DIR) === true;
  } catch {
    return undefined;
  }
}

async function collect() {
  const { exists, cfg } = readConfig();
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const hasDshHome = home ? fs.existsSync(path.join(home, '.dsh')) : false;
  const snowluma = await probeSnowluma();
  return {
    nodeVersion: process.versions.node,
    missingDeps: missingDeps(),
    hasConfig: exists,
    ownerQQ: (cfg && cfg.ownerQQ) || '',
    allowCount: countAllow(cfg),
    hasStateDir: fs.existsSync(STATE_DIR),
    aclHardened: await detectAclHardened(),
    hasDshHome,
    dshProfile: detectProfile(),
    hasSnowlumaSdk: fs.existsSync(path.join(NM, '@snowluma', 'sdk')),
    sdkNeedsPatch: detectSdkNeedsPatch(),
    snowluma,
    dshReachable: await probeDsh(cfg),
    cfg,
  };
}

// ---------------------------------------------------------------- 副作用

function runNode(script, args = []) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    stdio: flags.json ? 'pipe' : 'inherit',
    env: Object.assign({}, process.env, { NO_COLOR: process.env.NO_COLOR || '1' }),
    timeout: 5 * 60 * 1000,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    error: res.error ? res.error.message : '',
  };
}

// 装依赖时子进程里要能跑 `node`：postinstall 是 `node scripts/patch-snowluma-sdk.mjs`，
// 而「只装了 DSH」的机器上 node 根本不在 PATH 里。把找到的那个 node 的目录塞进 PATH 最省事，
// 比给每个生命周期脚本改写法都稳（npm 和 pnpm 都会继承这个 env）。
function installEnv(nodeExe = NODE_EXE) {
  const env = Object.assign({}, process.env);
  if (nodeExe) {
    const dir = path.dirname(nodeExe);
    const cur = String(env.PATH || env.Path || '');
    const parts = cur.split(path.delimiter).filter(Boolean);
    if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase())) {
      env.PATH = dir + path.delimiter + cur;
      if (process.platform === 'win32') env.Path = env.PATH;
    }
  }
  return env;
}

function npmArgs() {
  const args = ['install', '--no-audit', '--no-fund'];
  if (flags.registry) args.push('--registry=' + flags.registry);
  return args;
}

/** pnpm 不认 --no-audit / --no-fund（会直接报 Unknown options 并退出 1）。 */
function pnpmArgs() {
  const args = ['install', '--no-frozen-lockfile'];
  if (flags.registry) args.push('--registry=' + flags.registry);
  return args;
}

/** 系统 npm 优先；没有就用 DSH 自带 pnpm（它是 .cjs，得拿 node 去跑）。 */
function resolveInstaller() {
  const npm = onPath(process.platform === 'win32' ? 'npm' : 'npm', {
    exts: process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''],
  });
  if (npm) return { kind: 'npm', label: 'npm install', cmd: npm, args: npmArgs(), shell: process.platform === 'win32' };
  const pnpm = findDshPnpm();
  if (pnpm) {
    // --no-frozen-lockfile：仓库带的是 package-lock.json，不是 pnpm-lock.yaml
    return { kind: 'pnpm', label: 'pnpm install（DSH 自带）', cmd: NODE_EXE, args: [pnpm, ...pnpmArgs()], shell: false };
  }
  return null;
}

function runInstaller() {
  const plan = resolveInstaller();
  if (!plan) {
    return {
      ok: false,
      detail: '这台机器上既没有 npm 也没有 DSH 自带的 pnpm',
      hint: '装一个 Node.js LTS（22.13+）再重跑，或者先把 DSH 桌面版打开一次让它把运行时放到位',
      label: '',
    };
  }
  say(c.dim('  用 ' + plan.label + ' 装依赖（首次约 1-3 分钟）…'));
  const res = spawnSync(plan.cmd, plan.args, {
    cwd: ROOT,
    // Windows 上 npm 是 .cmd，必须走 shell 才能执行
    shell: plan.shell,
    stdio: flags.json ? 'pipe' : 'inherit',
    env: installEnv(),
    timeout: 15 * 60 * 1000,
  });
  return {
    ok: !res.error && res.status === 0,
    detail: res.error ? res.error.message : 'exit ' + res.status,
    label: plan.label,
  };
}

/** 首次写 config.json：只从 example 复制，绝不改内容。 */
function createConfig() {
  if (!fs.existsSync(EXAMPLE)) return { ok: false, detail: 'config.example.json 不见了（仓库不完整？）' };
  try {
    fs.copyFileSync(EXAMPLE, CONFIG);
    return { ok: true, detail: '已从 config.example.json 复制' };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

async function hardenAcl() {
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'state-acl.mjs')).href);
    const res = mod.hardenDir(STATE_DIR);
    // ACL 收紧失败不算错：start.bat 每次启动也会重试一次
    return res && res.ok ? { detail: '已收紧（当前用户 + SYSTEM + Administrators）' } : { detail: '降级：' + String((res && res.detail) || '未知原因') };
  } catch (error) {
    return { detail: '降级（' + (error && error.message ? error.message : String(error)) + '）' };
  }
}

/** --json 的两条早退路径也要有输出，否则调用方拿到空串、以为程序没跑。 */
function emitJson(payload) {
  if (!flags.json) return;
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function printPlan(steps, compact) {
  for (const item of steps) {
    if (compact && item.status === 'skip') continue;
    const icon = { todo: c.cyan('  →'), skip: c.dim('  ·'), warn: c.yellow('  !'), fail: c.red('  ✗') }[item.status] || '  ?';
    say(icon + ' ' + item.name + (item.detail ? c.dim('  ' + item.detail) : ''));
    if (item.fix && item.status !== 'skip') say(c.dim('      → ' + item.fix));
  }
}

async function execute(item, state) {
  const key = item.key;
  say(c.dim('\n[' + item.name + ']'));
  try {
    if (key === 'deps') {
      const res = runInstaller();
      mark(res.label || 'install', res.ok, res.ok ? '依赖装好了' : '失败：' + res.detail + (res.hint ? '（' + res.hint + '）' : '（可加 --registry= 换源）'));
      return;
    }
    if (key === 'config') {
      const res = createConfig();
      mark('config.json', res.ok, res.detail);
      if (res.ok) say(c.dim('      → 打开 config.json 改三处：ownerQQ（你的 QQ）、allow.groups / allow.private（白名单）、snowluma 的 wsUrl / httpUrl'));
      return;
    }
    if (key === 'state') {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      mark('state/', true, '已创建');
      return;
    }
    if (key === 'harden-acl') {
      const res = await hardenAcl();
      mark('state/ 权限', true, res.detail);
      return;
    }
    if (key === 'patch-sdk') {
      const res = runNode('patch-snowluma-sdk.mjs');
      mark('@snowluma SDK', res.ok, res.ok ? '已补 .js 扩展名' : '失败：' + (res.error || 'exit ' + res.status));
      return;
    }
    if (key === 'dsh') {
      const res = runNode('setup-dsh.mjs', state.dshProfile ? [state.dshProfile] : []);
      mark('装进 DSH', res.ok, res.ok ? 'preset / MCP / bundle 已写入' : '失败：' + (res.error || 'exit ' + res.status));
      if (res.ok) say(c.dim('      → 必须完全退出 DSH 再重新打开，新注册的东西才会生效'));
      return;
    }
    if (key === 'sync-port') {
      const res = runNode('sync-dsh-port.mjs');
      mark('DSH 端口', res.ok, res.ok ? 'config.json 的 dsh.baseUrl 已对齐' : '当前 DSH 没在运行，跳过（启动 DSH 后重跑）');
      return;
    }
    if (key === 'snowluma') {
      const online = await probeSnowluma();
      mark('SnowLuma', online, online ? '3000 / 3001 有人在监听' : '没探测到（装好后重跑本程序）');
      return;
    }
    mark(key, true, '无需处理');
  } catch (error) {
    mark(key, false, error instanceof Error ? error.message : String(error));
  }
}

async function runDoctor(state) {
  const file = path.join(ROOT, 'plugins', 'stellar', 'lib', 'doctor.js');
  if (!fs.existsSync(file)) return [];
  if (missingDeps().length) return [];
  try {
    const mod = await import(pathToFileURL(file).href);
    const cfg = state.cfg || {};
    const snow = cfg.snowluma || {};
    const allow = cfg.allow || {};
    const pick = (v) => (Array.isArray(v) ? v.filter((x) => x && x !== false) : []);
    return mod.buildInstallChecks({
      nodeVersion: process.versions.node,
      hasUnified: state.hasConfig,
      unifiedMasked: state.hasConfig ? 'config.json' : '',
      ownerQQ: cfg.ownerQQ || '',
      groups: pick(allow.groups),
      privates: pick(allow.private),
      snow: { wsUrl: snow.wsUrl || '', httpUrl: snow.httpUrl || '' },
      snowState: { state: state.snowluma ? 'connected' : 'not-running' },
      bridgeSrc: fs.existsSync(path.join(ROOT, 'src', 'bridge.js')),
      bridgeMasked: 'src/bridge.js',
      profile: state.dshProfile,
      token: '',
    });
  } catch {
    return [];
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(String(answer).trim()); });
  });
}

async function main() {
  if (flags.help) {
    say('用法: node scripts/bootstrap.mjs [--yes] [--dry-run] [--json] [--no-install] [--skip-dsh] [--skip-acl] [--registry=<url>]');
    return 0;
  }

  say(c.cyan('Stellar 首次启动检查'));
  say(c.dim('  目录 ' + ROOT));
  say(c.dim('  Node v' + process.versions.node + '（需要 >= ' + MIN_NODE + '）'));

  if (!nodeSatisfies(process.versions.node)) {
    say(c.red('\n✗ Node 版本太低：v' + process.versions.node + '，需要 >= ' + MIN_NODE));
    say('  装 Node LTS（https://nodejs.org/）后重开终端再跑一遍。');
    return 1;
  }

  let state = await collect();
  let steps = buildPlan(state, flags);
  const todo = steps.filter((s) => s.status === 'todo');

  if (!todo.length && !steps.some((s) => s.status === 'warn' || s.status === 'fail')) {
    say(c.green('\n全部就绪，不用改任何东西。'));
    say(c.dim('  启动：双击 start.bat（或 npm start），然后完全退出并重开 DSH。'));
    emitJson({ ready: true, steps, summary: summarize(steps), doctor: [], ran: [] });
    return 0;
  }

  say('');
  printPlan(steps, false);

  if (flags.dryRun) {
    say(c.dim('\n--dry-run：以上只是计划，什么都没改。'));
    emitJson({ dryRun: true, steps, summary: summarize(steps), doctor: [], ran: [] });
    return 0;
  }

  if (!flags.yes && isTTY) {
    const answer = await ask('\n按上面的计划开始执行？[Y/n] ');
    if (answer && !/^y(es)?$/i.test(answer)) {
      say('已取消。');
      return 0;
    }
  }

  for (const item of steps) {
    if (item.status !== 'todo') continue;
    await execute(item, state);
  }

  state = await collect();
  steps = buildPlan(state, flags);
  const sum = summarize(steps);

  say('');
  if (!flags.json) printPlan(steps, true);

  const doctor = await runDoctor(state);
  if (doctor.length && !flags.json) {
    say(c.cyan('\n安装体检（与 DSH 设置页里的规则同源）'));
    for (const row of doctor) {
      const tag = row.ok ? c.green('  ✓') : (row.level === 'fail' ? c.red('  ✗') : c.yellow('  !'));
      say(tag + ' ' + row.name + '：' + row.detail);
      if (!row.ok && row.fix) say(c.dim('      → ' + row.fix));
    }
  }

  if (flags.json) {
    emitJson({ dryRun: false, steps, summary: sum, doctor, ran: Array.from(ran.entries()) });
  } else {
    say('');
    if (sum.fail) {
      say(c.red('✗ 有 ' + sum.fail + ' 项挡路，先按上面的 → 提示处理，然后重跑本程序。'));
    } else if (sum.warn) {
      say(c.yellow('! 基础配置已就绪，还有 ' + sum.warn + ' 项需要你手动填（见上面的 →）。'));
    } else {
      say(c.green('✓ 环境检查完成。接下来：'));
      say('  1) 双击 start.bat 启动 QQ 桥接');
      say('  2) 完全退出 DSH 再打开（让新注册的 preset / MCP 生效）');
      say('  3) 在 DSH 设置页「Stellar → 诊断」里确认全绿');
    }
    say(c.dim('\n日志：' + LOG));
  }

  appendLog('done fail=' + sum.fail + ' warn=' + sum.warn + ' todo=' + sum.todo);
  return sum.fail ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write('bootstrap 崩了：' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exitCode = 1;
});
