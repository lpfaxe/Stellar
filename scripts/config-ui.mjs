#!/usr/bin/env node
// 配置编辑器：一个只在本机回环上跑的小网页，用来自查/改 config.json。
//
// 为什么要有它：config.json 有两百多个键，手改容易漏逗号、把 token 填错、把白名单写成字符串。
// 这个页面只覆盖「基本配置」那几十个键，其余键在保存时原样保留（见 config-ui-core.mjs 的 deepMerge）。
//
// 三条硬规则：
//   1. 绝不自动检索磁盘上的 config.json —— 路径只能由用户在页面里填、或者点「浏览…」选。
//   2. 只绑 127.0.0.1，且每个请求都要带本次运行随机生成的 token（防本机其它网页 CSRF）。
//   3. 写入前先备份、先校验；校验不过一个字节都不写。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  checkConfigPath, readConfigFile, writeConfigFile, deepMerge, validateConfig,
} from './config-ui-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'public', 'config-ui.html');
const EXAMPLE = path.join(ROOT, 'config.example.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const hit = argv.find((a) => a.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : '';
};

const TOKEN = randomBytes(24).toString('hex');
let currentPath = value('--config');

function log(...args) { console.log('[config-ui]', ...args); }

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是 JSON')); }
    });
    req.on('error', reject);
  });
}

// 浏览器发来的请求必然带 Origin；命令行 curl 不会。两者都得过 token，
// 但有 Origin 时必须与本次监听地址同源，挡掉「别的网站替用户点保存」。
function sameOrigin(req, port) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  const allowed = new Set([
    'http://127.0.0.1:' + port,
    'http://localhost:' + port,
  ]);
  return allowed.has(origin);
}

function authorized(req) {
  const got = String(req.headers['x-config-ui-token'] || '');
  if (got.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) diff |= TOKEN.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// 原生「浏览…」：浏览器拿不到绝对路径，只能让宿主弹 Windows 对话框。
// 路径不走 stdout —— Windows PowerShell 5.1 重定向用 GBK，中文目录会变乱码；
// 改成写临时 UTF-8 文件再读回来（与插件里既有的做法一致）。
function pickPath(mode, title) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: '只有 Windows 支持原生选择框，请手动粘贴路径' });
      return;
    }
    const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const outFile = path.join(os.tmpdir(), 'stellar-config-ui-' + process.pid + '-' + randomUUID() + '.txt');
    const writeOut = (expr) => '[System.IO.File]::WriteAllText(' + psQuote(outFile) + ', ' + expr + ", (New-Object System.Text.UTF8Encoding -ArgumentList $false))";
    const ps = mode === 'dir'
      ? 'Add-Type -AssemblyName System.Windows.Forms;' +
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;' +
        '$d.Description = ' + psQuote(title || '选择目录') + ';' +
        '$d.ShowNewFolderButton = $true;' +
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ' + writeOut('$d.SelectedPath') + ' }'
      : 'Add-Type -AssemblyName System.Windows.Forms;' +
        '$d = New-Object System.Windows.Forms.OpenFileDialog;' +
        '$d.Title = ' + psQuote(title || '选择配置文件') + ';' +
        '$d.Filter = "配置文件 (*.json)|*.json|所有文件 (*.*)|*.*";' +
        '$d.CheckFileExists = $true;' +
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ' + writeOut('$d.FileName') + ' }';
    const child = execFile('powershell.exe', ['-STA', '-NoProfile', '-Command', ps], { windowsHide: true, timeout: 180000 }, (error) => {
      let picked = '';
      try { picked = String(fs.readFileSync(outFile, 'utf8')).replace(/^\uFEFF/, '').trim(); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      if (!picked) {
        resolve({ ok: false, cancelled: true, error: error ? '选择框打不开：' + String(error.message || error).slice(0, 160) : '已取消' });
        return;
      }
      resolve({ ok: true, path: picked });
    });
    child.on('error', () => {
      try { fs.unlinkSync(outFile); } catch {}
      resolve({ ok: false, error: '无法启动 PowerShell（可能不在本机桌面）' });
    });
  });
}

function exampleConfig() {
  try {
    const text = fs.readFileSync(EXAMPLE, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function stateOf() {
  const info = {
    path: currentPath || '',
    exists: false,
    ok: false,
    error: '',
    size: 0,
    mtime: '',
    preserved: null,
    example: Boolean(exampleConfig()),
    platform: process.platform,
    node: process.version,
  };
  if (!currentPath) return info;
  const checked = checkConfigPath(currentPath);
  if (!checked.ok) { info.error = checked.error; return info; }
  info.path = checked.path;
  const read = readConfigFile(checked.path);
  if (!read.ok) { info.error = read.error; info.exists = fs.existsSync(checked.path); return info; }
  const st = fs.statSync(checked.path);
  info.exists = true;
  info.ok = true;
  info.size = st.size;
  info.mtime = st.mtime.toISOString();
  info.keys = Object.keys(read.config).length;
  return info;
}

async function handle(req, res, port) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname;

  if (route === '/' || route === '/index.html') {
    let html;
    try { html = fs.readFileSync(PAGE, 'utf8'); } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('找不到页面文件 public/config-ui.html');
      return;
    }
    const body = html.split('__CONFIG_UI_TOKEN__').join(TOKEN);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
    return;
  }

  if (!route.startsWith('/api/')) {
    sendJson(res, 404, { ok: false, error: '没有这个地址' });
    return;
  }
  if (!authorized(req)) { sendJson(res, 403, { ok: false, error: '令牌不对，请从启动窗口里的地址重新打开' }); return; }
  if (!sameOrigin(req, port)) { sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' }); return; }

  try {
    if (route === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...stateOf() });
      return;
    }

    if (route === '/api/read' && req.method === 'POST') {
      const body = await readBody(req);
      const target = String(body.path || currentPath || '').trim();
      const checked = checkConfigPath(target);
      if (!checked.ok) { sendJson(res, 200, { ok: false, error: checked.error }); return; }
      currentPath = checked.path;
      const read = readConfigFile(checked.path);
      if (!read.ok) {
        // 文件不存在是「正常的一种状态」：页面会提示可以按模板新建。
        sendJson(res, 200, { ok: false, missing: Boolean(read.missing), error: read.error, path: checked.path });
        return;
      }
      sendJson(res, 200, { ok: true, path: checked.path, config: read.config, state: stateOf() });
      return;
    }

    if (route === '/api/write' && req.method === 'POST') {
      const body = await readBody(req);
      const target = String(body.path || currentPath || '').trim();
      const checked = checkConfigPath(target);
      if (!checked.ok) { sendJson(res, 200, { ok: false, error: checked.error }); return; }
      currentPath = checked.path;
      let existing = {};
      if (fs.existsSync(checked.path)) {
        const read = readConfigFile(checked.path);
        if (!read.ok) { sendJson(res, 200, { ok: false, error: '原文件读不出来，没敢覆盖：' + read.error }); return; }
        existing = read.config;
      }
      const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : {};
      const merged = deepMerge(existing, patch);
      const verdict = validateConfig(merged);
      if (!verdict.ok) {
        sendJson(res, 200, { ok: false, validation: verdict.errors, error: '有 ' + verdict.errors.length + ' 处需要先改' });
        return;
      }
      const written = writeConfigFile(checked.path, merged, {});
      sendJson(res, 200, {
        ok: true,
        changed: written.changed,
        backup: written.backup,
        path: checked.path,
        state: stateOf(),
      });
      return;
    }

    if (route === '/api/create' && req.method === 'POST') {
      const body = await readBody(req);
      const target = String(body.path || '').trim();
      const checked = checkConfigPath(target);
      if (!checked.ok) { sendJson(res, 200, { ok: false, error: checked.error }); return; }
      if (fs.existsSync(checked.path)) { sendJson(res, 200, { ok: false, error: '文件已经存在，直接读取它就行' }); return; }
      const template = exampleConfig();
      if (!template) { sendJson(res, 200, { ok: false, error: '仓库里没有可用的 config.example.json' }); return; }
      const written = writeConfigFile(checked.path, template, {});
      currentPath = checked.path;
      sendJson(res, 200, { ok: true, path: checked.path, config: template, backup: written.backup, state: stateOf() });
      return;
    }

    if (route === '/api/pick' && req.method === 'POST') {
      const body = await readBody(req);
      const mode = body.mode === 'dir' ? 'dir' : 'file';
      const picked = await pickPath(mode, body.title);
      if (picked.ok && mode === 'file') {
        const checked = checkConfigPath(picked.path);
        if (checked.ok) picked.path = checked.path;
      }
      sendJson(res, 200, picked);
      return;
    }

    sendJson(res, 404, { ok: false, error: '没有这个接口' });
  } catch (error) {
    sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
  }
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    handle(req, res, server.address().port).catch((error) => {
      try { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }); } catch {}
    });
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      log('端口 ' + port + ' 被占用了，换个端口：node scripts/config-ui.mjs --port=0');
      process.exit(1);
    }
    log('启动失败：' + String(error?.message ?? error));
    process.exit(1);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const wantsServer = !flag('--check') && !flag('--json');
if (wantsServer) {
  const port = Number(value('--port') || 0) || 0;
  const server = await startServer(port);
  const addr = 'http://127.0.0.1:' + server.address().port + '/';
  log('配置编辑器已启动：' + addr);
  log('这个地址只在本机能打开；关掉这个窗口页面就失效了。');
  if (currentPath) log('已预填配置路径：' + currentPath);
  if (!flag('--no-open')) {
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['/c', 'start', '', addr] : [addr];
    execFile(cmd, args, { windowsHide: true }, () => {});
  }
} else {
  // --check：不起服务，只验证「页面和模板都在、核心逻辑能跑」，给测试和 CI 用。
  const pageOk = fs.existsSync(PAGE);
  const example = exampleConfig();
  const out = {
    ok: pageOk && Boolean(example),
    page: pageOk ? PAGE : '',
    example: Boolean(example),
    tokenInPage: pageOk ? fs.readFileSync(PAGE, 'utf8').includes('__CONFIG_UI_TOKEN__') : false,
    platform: process.platform,
    node: process.version,
  };
  if (flag('--json') || flag('--check')) console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
