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
  console.log('SKIP Tailnet 网段判定：仓库自带的 stellar-manager 是最小控制台（只有 server.mjs，没有 lib/auth.js）；这条断言的是完整面板，只在完整部署里跑');
  process.exit(0);
}
/**
 * Tailscale 网段（100.64.0.0/10）必须按内网算，否则手机上走 tailnet 打开面板只能是只读。
 * 同时钉住边界：100.63/100.128 不是 CGNAT；带 Cloudflare 头的一律 public。
 *
 * 跑法：node scripts/test-tailnet-scope.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-scope-'));
process.env.STELLAR_DATA_DIR = root;

const { requestScope, canWrite, tailnetAddresses } = await import(pathToFileURL(pathProbe.join(panelRoot, 'lib', 'auth.js')).href);

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

const req = (ip, headers = {}) => ({ headers: { host: '192.168.0.3:3300', ...headers }, socket: { remoteAddress: ip } });

test('100.64/10 的三个边界都算内网（可写）', () => {
  for (const ip of ['100.64.0.1', '100.101.102.103', '100.127.255.254']) {
    assert.equal(requestScope(req(ip)), 'lan', ip);
    assert.equal(canWrite(req(ip)), true, ip);
  }
});

test('100.63 / 100.128 不是 CGNAT，仍是 public（只读）', () => {
  for (const ip of ['100.63.255.255', '100.128.0.1']) {
    assert.equal(requestScope(req(ip)), 'public', ip);
    assert.equal(canWrite(req(ip)), false, ip);
  }
});

test('走了 Cloudflare 的请求即使来源是 tailnet 也只读', () => {
  const r = req('100.101.102.103', { 'cf-connecting-ip': '100.101.102.103', host: 'x.trycloudflare.com' });
  assert.equal(requestScope(r), 'public');
  assert.equal(canWrite(r), false);
});

test('tailnetAddresses 只挑 100.64/10，且没装时回空数组', () => {
  const list = tailnetAddresses();
  assert.ok(Array.isArray(list));
  for (const a of list) {
    const m = /^(\d+)\.(\d+)\./.exec(a.address);
    assert.ok(m, a.address);
    assert.equal(Number(m[1]), 100);
    assert.ok(Number(m[2]) >= 64 && Number(m[2]) <= 127, a.address);
  }
});
