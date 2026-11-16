/**
 * 面板本机也要登录（PITFALLS #208 的回归）。
 *
 * 修前：isAuthed/gate 里 isLoopback(req) 为真就直接放行，于是同一台电脑上
 * 任何账户、任何进程打 http://127.0.0.1:3300/api/status 都能拿到明文口令，
 * 拿到就能从公网隧道登录。绑回环只挡住外面的人，挡不住本机别的用户。
 *
 * 修后两条不变量，正是在这里钉住：
 *   1. 本机没会话 → 401（不再自动放行）；
 *   2. 原始口令换会话只允许本机：隧道来的请求（带 cf-* / x-forwarded-for）必须被拒，
 *      否则口令进了 URL 就等于把长期凭据放到公网日志里。
 *
 * 跑法：node scripts/test-panel-local-auth.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-panel-auth-'));
process.env.DSH_HOME = root;
process.env.STELLAR_DATA_DIR = path.join(root, 'stellar');

const here = path.dirname(fileURLToPath(import.meta.url));
const panelRoots = ['../stellar-manager', '../../stellar-manager'].map((rel) => path.resolve(here, rel));
const panelRoot = panelRoots.find((dir) => fs.existsSync(path.join(dir, 'server.mjs')));
if (!panelRoot) {
  console.log('SKIP 面板本机登录：这个仓库布局里找不到 stellar-manager/');
  process.exit(0);
}
const auth = await import(pathToFileURL(path.join(panelRoot, 'lib', 'auth.js')).href);

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

function fakeReq({ ip = '127.0.0.1', host = '127.0.0.1:3300', headers = {}, cookie = '' } = {}) {
  const h = { host, ...headers };
  if (cookie) h.cookie = cookie;
  return { socket: { remoteAddress: ip }, headers: h, method: 'GET' };
}
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    writeHead(code, extra) { this.statusCode = code; Object.assign(this.headers, extra || {}) },
    write(s) { this.body += String(s) },
    end(s) { if (s) this.body += String(s); this.ended = true },
  };
  return res;
}
function urlOf(q) { return new URL('http://127.0.0.1:3300/' + (q || '')) }

test('本机也不再有免口令：没有会话就 401', () => {
  const req = fakeReq();
  const res = fakeRes();
  const ok = auth.gate(req, res, urlOf('api/status'));
  assert.equal(ok, false, '本机无会话不该放行');
  assert.equal(res.statusCode, 401, '应该回 401 而不是 200');
});

test('isAuthed 只认会话，不认回环', () => {
  assert.equal(auth.isAuthed(fakeReq()), false, 'isAuthed 不能因为回环就为真');
});

test('本机带原始口令换会话：302 并下发 Cookie', () => {
  const token = auth.currentToken();
  const req = fakeReq();
  const res = fakeRes();
  const ok = auth.gate(req, res, urlOf('?code=' + token));
  assert.equal(ok, false, '换来会话后要让浏览器重定向，不能在同一次里继续渲染');
  assert.equal(res.statusCode, 302);
  assert.match(String(res.headers['set-cookie'] || ''), /panel_sid=[a-f0-9]{32,64}/, '没下发会话 Cookie');
  assert.ok(!String(res.headers.location || '').includes('code='), '重定向地址里不能留着口令');
});

test('隧道来源不能用原始口令换会话（口令不得进公网 URL）', () => {
  const token = auth.currentToken();
  for (const headers of [{ 'cf-connecting-ip': '1.2.3.4' }, { 'cf-ray': 'abc-HKG' }, { 'x-forwarded-for': '1.2.3.4' }, { 'cdn-loop': 'cloudflare' }]) {
    const req = fakeReq({ headers });
    const res = fakeRes();
    const ok = auth.gate(req, res, urlOf('?code=' + token));
    assert.equal(ok, false);
    assert.equal(res.statusCode, 401, '带了 ' + Object.keys(headers)[0] + ' 还被当成会话：' + JSON.stringify(res.headers['set-cookie'] || ''));
    assert.ok(!res.headers['set-cookie'], '隧道来源不该拿到 Cookie');
  }
});

test('会话文件被当作敏感文件加固（ACL 白名单里有它）', async () => {
  const acl = await import(pathToFileURL(path.resolve(here, '..', 'src', 'state-acl.mjs')).href);
  assert.ok(acl.SENSITIVE_BASENAMES.has('panel-sessions.json'), 'panel-sessions.json 不在加固名单里，同机其他账户能读到 sid');
  assert.ok(acl.SENSITIVE_BASENAMES.has('panel-token.txt'));
});

test('面板 launcher 会带 ?code= 打开（否则本机也要手输口令）', () => {
  const batPath = path.join(panelRoot, 'open-panel.bat');
  if (!fs.existsSync(batPath)) {
    // Windows 发布包不带 open-panel.bat（用「启动控制台.bat」），这条只在开发目录有意义
    assert.ok(fs.existsSync(path.join(panelRoot, 'server.mjs')));
    return;
  }
  const bat = fs.readFileSync(batPath, 'utf8');
  assert.match(bat, /panel-token\.txt/, 'open-panel.bat 没读 panel-token.txt');
  assert.match(bat, /\?code=/, 'open-panel.bat 没把口令带进 URL，本机开机还得手输');
  // 批处理必须纯 ASCII：中文会被 cmd 按字节切碎（PITFALLS #…）
  assert.ok(!/[\u4e00-\u9fff]/.test(bat), 'open-panel.bat 里有中文，cmd 会按字节切碎');
});

test('README/文档别把「本机免口令」写回去', () => {
  const authSrc = fs.readFileSync(path.join(panelRoot, 'lib', 'auth.js'), 'utf8');
  assert.ok(!/isLoopback\(req\)\s*\|\|\s*validSession\(req\)/.test(authSrc), 'isAuthed 又退回「回环即登录」');
  assert.ok(!/export function gate\(req, res, url\) \{\s*if \(isLoopback\(req\)\) return true/.test(authSrc), 'gate 又给回环开后门');
});

console.log('panel local auth tests OK');
