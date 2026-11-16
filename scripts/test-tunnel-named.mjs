/**
 * 这一条依赖 stellar-manager（控制台，端口 3300）的源码做源码级断言。
 * 公开仓库**不发布**控制台目录，所以这里先探测：缺了就跳过（打印原因并以 0 退出），
 * 有就照常跑。真实仓库里 stellar-manager 与 stellar 同级，6 条断言全部生效。
 */
import fsProbe from 'node:fs';
import pathProbe from 'node:path';
import { fileURLToPath as urlProbe, pathToFileURL } from 'node:url';
const scriptsDir = pathProbe.dirname(urlProbe(import.meta.url));
// 控制台源码的两个候选位置：仓库自己那份（发布仓库里是最小控制台，没有 lib/auth.js），
// 以及「stellar 与 stellar-manager 同级」的完整部署布局。先看前者，避免发布仓库里
// 因为机器上碰巧存在 ../stellar-manager 就把断言跑到别人家的目录上。
const repoRoot = pathProbe.resolve(scriptsDir, '..');
// 先认**本仓库自己的** stellar-manager（存在就用它，不管里面是完整面板还是最小控制台），
// 只有本仓库里根本没有这个目录时，才回退到「stellar 与 stellar-manager 同级」的完整部署布局。
// 这样发布仓库不会因为开发机上碰巧有 ../stellar-manager 就把断言跑到别人的目录里。
const ownManager = pathProbe.join(repoRoot, 'stellar-manager');
const siblingManager = pathProbe.resolve(repoRoot, '..', 'stellar-manager');
const panelRoot = (() => {
  try { if (fsProbe.statSync(ownManager).isDirectory()) return ownManager; } catch {}
  return siblingManager;
})();
// 公开仓库里 stellar-manager 只是一个空占位（仅 README.md），所以判定的是「有没有控制台源码」：
// server.mjs 与 lib/auth.js 是这批断言真正要读的两个文件，缺一个就跳过。
const panelSrc = (() => {
  try {
    return fsProbe.existsSync(pathProbe.join(panelRoot, 'server.mjs'))
      && fsProbe.existsSync(pathProbe.join(panelRoot, 'lib', 'auth.js'));
  } catch { return false; }
})();
if (!panelSrc) {
  console.log('SKIP 命名隧道：仓库自带的 stellar-manager 是最小控制台（只有 server.mjs，没有 lib/auth.js）；这条断言的是完整面板，只在完整部署里跑');
  process.exit(0);
}
/**
 * 命名隧道（固定域名）回归：token/域名校验、状态落盘、切回快速隧道、ACL 白名单。
 * 全程在 fixture 里跑（STELLAR_DATA_DIR 指到临时目录），不碰真实 panel-tunnel.json。
 *
 * 跑法：node scripts/test-tunnel-named.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-tunnel-'));
process.env.DSH_HOME = root;
process.env.STELLAR_DATA_DIR = path.join(root, 'stellar');

const tun = await import(pathToFileURL(pathProbe.join(panelRoot, 'lib', 'tunnel.js')).href);
const acl = await import('../src/state-acl.mjs');

test.after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('token 太短 / 字符非法 / 域名不合法都被拒', () => {
  assert.equal(tun.setNamedTunnel({ token: 'abc', hostname: 'panel.example.com' }).ok, false);
  const bad = tun.setNamedTunnel({ token: 'x'.repeat(60) + ' 空格', hostname: 'panel.example.com' });
  assert.equal(bad.ok, false);
  const host = tun.setNamedTunnel({ token: 'a'.repeat(60), hostname: 'http://not a host/' });
  assert.equal(host.ok, false);
  assert.match(host.message, /域名/);
  // 第一次配必须有 token：空 token 不许把模式悄悄改成「有域名但没通道」
  const noToken = tun.setNamedTunnel({ token: '', hostname: 'panel.example.com' });
  assert.equal(noToken.ok, false);
  assert.match(noToken.message, /token/);
});

test('合法 token 存成单独文件并收紧 ACL，状态变 named/permanent', () => {
  const r = tun.setNamedTunnel({ token: 'AbCdEf0123456789'.repeat(6), hostname: 'https://panel.example.com/' });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(tun.TUNNEL_TOKEN_FILE), true);
  const st = tun.tunnelState();
  assert.equal(st.mode, 'named');
  assert.equal(st.hostname, 'panel.example.com');
  assert.equal(st.hasToken, true);
  assert.equal(st.permanent, true);
  assert.equal(st.url, 'https://panel.example.com');
  assert.equal(acl.isHardened(tun.TUNNEL_TOKEN_FILE), true);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.STELLAR_DATA_DIR, 'state', 'panel-tunnel.json'), 'utf8'));
  assert.equal(saved.mode, 'named');
  assert.equal(saved.hostname, 'panel.example.com');
  assert.equal(String(saved.token || ''), '');
});

test('命名隧道缺 token 时不假装能开（给可行动的错误）', () => {
  fs.rmSync(tun.TUNNEL_TOKEN_FILE, { force: true });
  // 造一个假 cloudflared，让 startTunnel 的「二进制在不在」这层通过，才能测到 token 守卫
  const binDir = path.join(process.env.STELLAR_DATA_DIR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'cloudflared.exe'), 'stub', 'utf8');
  tun.tunnel.mode = 'named';
  tun.tunnel.token = '';
  tun.tunnel.enabled = false;
  const r = tun.startTunnel();
  assert.equal(r.ok, false);
  assert.match(String(r.message) + String(r.tunnel && r.tunnel.error || ''), /token/);
});

test('切回快速隧道：清 token、清域名', () => {
  tun.setNamedTunnel({ token: 'ZzZz0123456789'.repeat(5), hostname: 'panel.example.com' });
  const r = tun.clearNamedTunnel();
  assert.equal(r.ok, true);
  const st = tun.tunnelState();
  assert.equal(st.mode, 'quick');
  assert.equal(st.hostname, '');
  assert.equal(st.hasToken, false);
  assert.equal(fs.existsSync(tun.TUNNEL_TOKEN_FILE), false);
});

test('cloudflare-tunnel-token.txt 在敏感文件白名单里', () => {
  assert.equal(acl.isSensitiveFile('C:/x/state/cloudflare-tunnel-token.txt'), true);
});
