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
  console.log('SKIP 公网 IPv6 可写白名单：仓库自带的 stellar-manager 是最小控制台（只有 server.mjs，没有 lib/auth.js）；这条断言的是完整面板，只在完整部署里跑');
  process.exit(0);
}
/**
 * 公网 IPv6 可写白名单回归：前缀匹配、fail-closed 默认、/64 归并、文件校验。
 *
 * 面板现在监听 ::（双栈），公网 IPv6 能直接打开；所以「谁能写」必须由这张表说了算，
 * 而且默认必须是拒绝。
 *
 * 跑法：node scripts/test-panel-remote-allow.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-v6-'));
process.env.DSH_HOME = root;
process.env.STELLAR_DATA_DIR = path.join(root, 'stellar');

const ra = await import(pathToFileURL(pathProbe.join(panelRoot, 'lib', 'remote-allow.js')).href)
const auth = await import(pathToFileURL(pathProbe.join(panelRoot, 'lib', 'auth.js')).href);

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

test('空表 = 一律不放行（fail-closed）', () => {
  assert.equal(ra.isAllowedRemote('2409:8d30:d001:4194:69ca:a923:1133:ad2'), false);
  assert.deepEqual(ra.readAllow().prefixes, []);
});

test('/64 前缀只匹配同前缀，跨段不匹配', () => {
  ra.addPrefix({ cidr: '2409:8d30:d001:4194::/64', label: '家' });
  assert.equal(ra.isAllowedRemote('2409:8d30:d001:4194:69ca:a923:1133:ad2'), true);
  assert.equal(ra.isAllowedRemote('2409:8d30:d001:4195::1'), false);
  assert.equal(ra.isAllowedRemote('2409:8d30:d001:4193::1'), false);
});

test('IPv4-mapped 地址按 IPv4 规则匹配', () => {
  ra.addPrefix({ cidr: '192.168.0.0/24', label: 'lan' });
  assert.equal(ra.isAllowedRemote('::ffff:192.168.0.3'), true);
  assert.equal(ra.isAllowedRemote('192.168.1.3'), false);
});

test('坏前缀被拒、重复被拒、能删能清', () => {
  assert.equal(ra.addPrefix({ cidr: 'not-a-cidr' }).ok, false);
  assert.equal(ra.addPrefix({ cidr: '2409:8d30:d001:4194::/64' }).ok, false)
  assert.equal(ra.removePrefix('2409:8d30:d001:4194::/64').ok, true);
  assert.equal(ra.removePrefix('2409:8d30:d001:4194::/64').ok, false);
  assert.equal(ra.clearPrefixes().ok, true);
  assert.equal(ra.isAllowedRemote('192.168.0.3'), false);
});

test('requestScope：公网 IPv6 默认 public，白名单命中才 lan', () => {
  const req = (addr) => ({ socket: { remoteAddress: addr }, headers: { host: 'panel.example.com' } })
  const v6 = '2409:8d30:d001:4194:69ca:a923:1133:ad2'
  ra.clearPrefixes()
  assert.equal(auth.requestScope(req(v6)), 'public')
  ra.addPrefix({ cidr: '2409:8d30:d001:4194::/64' })
  assert.equal(auth.requestScope(req(v6)), 'lan')
  // 别的全局 v6 段不在名单里，仍是只读
  assert.equal(auth.requestScope(req('2409:8d30:d001:4195::1')), 'public')
  // 回环永远是 local（本机免口令）
  assert.equal(auth.requestScope({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3300' } }), 'local')
  // 带 CF 代理头的一律 public（隧道转发的来源不可信）
  assert.equal(auth.requestScope({ socket: { remoteAddress: v6 }, headers: { host: 'x', 'cf-connecting-ip': v6 } }), 'public')
})

test('防爆破桶：IPv6 归到 /64，IPv4 原样', () => {
  const a = ra.guardKey('2409:8d30:d001:4194:69ca:a923:1133:ad2');
  const b = ra.guardKey('2409:8d30:d001:4194:25fa:3faf:baad:6e21');
  assert.equal(a, b);
  assert.match(a, /\/64$/);
  assert.equal(ra.guardKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.notEqual(ra.guardKey('2409:8d30:d001:4195::1'), a);
});
