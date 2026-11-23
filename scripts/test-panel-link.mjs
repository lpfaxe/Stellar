/**
 * 控制台远控地址（2026-11-23）：两条链各自钉一遍。
 *
 * 1) 面板侧（stellar-manager/lib/access-link.js）：候选地址会不会报出打不开的链接、
 *    TCP 实测是不是真的在测、一次性码是不是只在要的时候才发。
 * 2) 她这一侧（src/panel-link.js）：请求长什么样（回环、同源头、body.code）、
 *    失败怎么变成人话、排版是不是只说连得上的。
 *
 * 公开仓库里 stellar-manager 只是最小占位（没有 lib/access-link.js），
 * 所以面板那半先探测、缺了就跳过；桥接这半永远跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const panelRoot = (() => {
  const own = path.join(repoRoot, 'stellar-manager');
  try {
    if (fs.existsSync(path.join(own, 'lib', 'access-link.js'))) return own;
  } catch {}
  return path.resolve(repoRoot, '..', 'stellar-manager');
})();
const panelReady = (() => {
  try { return fs.existsSync(path.join(panelRoot, 'lib', 'access-link.js')) && fs.existsSync(path.join(panelRoot, 'lib', 'auth.js')); } catch { return false }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-panel-link-'));
process.env.STELLAR_DATA_DIR = tmp;
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} });

const bridge = await import(pathToFileURL(path.join(repoRoot, 'src', 'panel-link.js')).href);

// ── 她这一侧 ──────────────────────────────────────────────────────────────
test('端口：环境变量优先，非法值回落到 3300', () => {
  assert.equal(bridge.panelPort({}), 3300);
  assert.equal(bridge.panelPort({ STELLAR_PANEL_PORT: '3399' }), 3399);
  assert.equal(bridge.panelPort({ STELLAR_PANEL_PORT: 'abc' }), 3300);
  assert.equal(bridge.panelPort({ SURFCORE_PANEL_PORT: '3311' }), 3311);
  assert.equal(bridge.panelBaseUrl({ port: 3399 }), 'http://127.0.0.1:3399');
});

test('请求：只打回环 /api/remote-link，带同源头，body 里才是 code', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, port: 3300, host: '0.0.0.0', urls: [], login: null }) };
  };
  await bridge.requestRemoteLink({ port: 3300, code: true, fetchImpl: fakeFetch });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:3300/api/remote-link');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['x-panel-request'], 'panel');
  assert.deepEqual(JSON.parse(seen[0].init.body), { code: true });
});

test('请求：面板没起 / 403 / 非 ok 都说人话，不抛「未知错误」', async () => {
  const mk = (status, payload) => async () => ({ ok: status < 400, status, json: async () => payload });
  await assert.rejects(() => bridge.requestRemoteLink({ fetchImpl: mk(403, { ok: false, message: '远控地址只能在本机上取' }) }), /只能在本机上取/);
  await assert.rejects(() => bridge.requestRemoteLink({ fetchImpl: mk(500, null) }), /HTTP 500/);
  await assert.rejects(() => bridge.requestRemoteLink({ fetchImpl: async () => { throw new Error('fetch failed') } }), /fetch failed/);
});

test('排版：只说连得上的，连不上的单独一行，不带码时提示 link=true', () => {
  const text = bridge.formatRemoteLink({
    port: 3300,
    host: '0.0.0.0',
    urls: [
      { kind: 'tailnet', url: 'http://100.101.102.103:3300/', reachable: true },
      { kind: 'lan', url: 'http://192.168.1.23:3300/', reachable: true },
      { kind: 'v6', url: 'http://[2409:8d30::1]:3300/', reachable: false },
      { kind: 'local', url: 'http://127.0.0.1:3300/', reachable: true }
    ],
    login: null
  });
  assert.match(text, /Tailscale：http:\/\/100\.101\.102\.103:3300\/（实测连得上）/);
  assert.match(text, /局域网：http:\/\/192\.168\.1\.23:3300\//);
  assert.ok(text.includes('连不上的：公网 IPv6 http://[2409:8d30::1]:3300/'));
  assert.ok(text.includes('link=true'));
  assert.ok(!/公网 IPv6：/.test(text), '连不上的不能出现在「可用」列表里');
});

test('排版：有登录链接时说清有效时间和「别发群里」', () => {
  const text = bridge.formatRemoteLink({
    port: 3300,
    host: '0.0.0.0',
    urls: [{ kind: 'tailnet', url: 'http://100.101.102.103:3300/', reachable: true }],
    login: { url: 'http://100.101.102.103:3300/?code=abc123', ttlSec: 300 }
  });
  assert.ok(text.includes('http://100.101.102.103:3300/?code=abc123'));
  assert.match(text, /5 分钟内有效/);
  assert.match(text, /别发到群里/);
});

test('排版：一条都连不上时给可行动的原因，别报一串死链接', () => {
  const text = bridge.formatRemoteLink({
    port: 3300,
    host: '127.0.0.1',
    urls: [{ kind: 'local', url: 'http://127.0.0.1:3300/', reachable: false }],
    login: null
  });
  assert.match(text, /没有可用的远控地址/);
  assert.ok(!text.includes('实测连得上'));
});

test('排版：公网隧道排在最前，并说清「手机流量能开 + 只读」', () => {
  const text = bridge.formatRemoteLink({
    port: 3300,
    host: '0.0.0.0',
    urls: [
      { kind: 'tunnel', url: 'https://abc-def.trycloudflare.com/', reachable: true, mode: 'quick' },
      { kind: 'lan', url: 'http://192.168.1.23:3300/', reachable: true }
    ],
    tunnel: { url: 'https://abc-def.trycloudflare.com/', running: true, mode: 'quick', permanent: false, error: '' },
    login: null
  });
  const tunAt = text.indexOf('公网隧道（手机流量）：');
  const lanAt = text.indexOf('局域网：');
  assert.ok(tunAt > 0 && lanAt > tunAt, '隧道要排在局域网前面');
  assert.match(text, /手机流量也能打开/);
  assert.match(text, /只能看和点审批/);
  assert.match(text, /快速隧道，地址会变/);
});

test('排版：隧道没开时说清去哪儿开，而不是沉默', () => {
  const text = bridge.formatRemoteLink({
    port: 3300,
    host: '0.0.0.0',
    urls: [{ kind: 'lan', url: 'http://192.168.1.23:3300/', reachable: true }],
    tunnel: { url: '', running: false, mode: 'quick', permanent: false, error: '' },
    login: null
  });
  assert.match(text, /公网那条（手机流量也能开的那种）现在没开/);
  assert.match(text, /「手机访问」里点「开启远程访问」/);
});

test('排版：隧道有地址但连不上时，提示可能被 Cloudflare 回收', () => {
  const text = bridge.formatRemoteLink({
    port: 3300,
    host: '0.0.0.0',
    urls: [
      { kind: 'tunnel', url: 'https://dead.trycloudflare.com/', reachable: false },
      { kind: 'lan', url: 'http://192.168.1.23:3300/', reachable: true }
    ],
    tunnel: { url: 'https://dead.trycloudflare.com/', running: true, mode: 'quick', permanent: false, error: '' },
    login: null
  });
  assert.match(text, /现在连不上/);
  assert.match(text, /回收/);
});

// ── 面板这一侧 ────────────────────────────────────────────────────────────
if (!panelReady) {
  test('SKIP 面板侧：这个仓库里的 stellar-manager 没有 lib/access-link.js（最小控制台）', () => {});
} else {
  const panel = await import(pathToFileURL(path.join(panelRoot, 'lib', 'access-link.js')).href);

  test('绑定：0.0.0.0 只开 IPv4，:: 才报 IPv6，绑回环时只报本机', () => {
    assert.equal(panel.binds('lan', '0.0.0.0'), true);
    assert.equal(panel.binds('tailnet', '0.0.0.0'), true);
    assert.equal(panel.binds('v6', '0.0.0.0'), false);
    assert.equal(panel.binds('v6', '::'), true);
    assert.equal(panel.binds('lan', '::'), true);
    assert.equal(panel.binds('local', '127.0.0.1'), true);
    assert.equal(panel.binds('lan', '127.0.0.1'), false);
    assert.equal(panel.binds('v6', '192.168.1.5'), false);
  });

  test('候选：tailnet 在前、本机最后；CGNAT 不会在局域网里重复出现；IPv4 绑定下没有 IPv6', () => {
    const nets = {
      tailnet: [{ name: 't', address: '100.101.102.103' }],
      lan: [{ name: 'w', address: '192.168.1.23' }, { name: 't', address: '100.101.102.103' }],
      v6: [{ name: 'w', address: '2409:8d30:d001:4194::1' }]
    };
    const list = panel.candidateLinks({ host: '0.0.0.0', port: 3300, nets });
    assert.deepEqual(list.map((it) => it.kind), ['tailnet', 'lan', 'local']);
    assert.equal(list[0].url, 'http://100.101.102.103:3300/');
    // 同一个 100.x 地址不会因为同时出现在 lanAddresses 里被当成局域网再报一遍
    assert.equal(list.filter((it) => it.address === '100.101.102.103').length, 1);
    const withV6 = panel.candidateLinks({ host: '::', port: 3300, nets });
    assert.deepEqual(withV6.map((it) => it.kind), ['tailnet', 'lan', 'v6', 'local']);
    assert.equal(withV6.find((it) => it.kind === 'v6').url, 'http://[2409:8d30:d001:4194::1]:3300/');
  });

  test('URL：IPv6 加方括号，IPv4 不加', () => {
    assert.equal(panel.urlOf('192.168.1.23', 3300), 'http://192.168.1.23:3300/');
    assert.equal(panel.urlOf('2409:8d30::1', 3300), 'http://[2409:8d30::1]:3300/');
  });

  test('实测：本机临时服务能连、关掉的端口连不上（真的开 socket，不靠猜）', async () => {
    const srv = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      assert.equal(await panel.probeTcp('127.0.0.1', port), true);
    } finally {
      await new Promise((r) => srv.close(r));
    }
    assert.equal(await panel.probeTcp('127.0.0.1', port, 400), false);
  });

  test('总表：探测结果决定可达性，best 按 tailnet→lan→v6→local 挑', async () => {
    const links = [
      { kind: 'tailnet', label: 'Tailscale', address: '100.1.2.3', url: 'http://100.1.2.3:3300/' },
      { kind: 'lan', label: '局域网', address: '192.168.1.23', url: 'http://192.168.1.23:3300/' },
      { kind: 'local', label: '本机', address: '127.0.0.1', url: 'http://127.0.0.1:3300/' }
    ];
    const info = await panel.buildRemoteLink({
      links,
      probe: async (address) => address !== '100.1.2.3'
    });
    assert.equal(info.opened, true);
    assert.equal(info.best, 'lan');
    assert.equal(info.urls.filter((it) => it.reachable).length, 2);
    assert.equal(info.login, null, '没要码就不能有凭据');
    assert.ok(!JSON.stringify(info).includes('code='));
  });

  test('总表：要码时才发一次性码，落在 best 那条地址上', async () => {
    const links = [{ kind: 'lan', label: '局域网', address: '192.168.1.23', url: 'http://192.168.1.23:3300/' }];
    const info = await panel.buildRemoteLink({ code: true, links, probe: async () => true });
    assert.ok(info.login && info.login.url.startsWith('http://192.168.1.23:3300/?code='));
    assert.equal(info.login.url.split('?code=')[1], info.login.code);
    assert.equal(info.login.via, 'lan');
    assert.ok(info.login.ttlSec > 0 && info.login.ttlSec <= 300);
  });

  test('总表：一条都连不上时不发码（没地方发）', async () => {
    const links = [{ kind: 'local', label: '本机', address: '127.0.0.1', url: 'http://127.0.0.1:3300/' }];
    const info = await panel.buildRemoteLink({ code: true, links, probe: async () => false });
    assert.equal(info.opened, false);
    assert.equal(info.login, null);
  });


  test('隧道：不管面板绑哪张网卡都要报出来，且排在候选第一位（https）', () => {
    const nets = { tailnet: [], lan: [{ name: 'w', address: '192.168.1.23' }], v6: [] };
    const list = panel.candidateLinks({
      host: '127.0.0.1', port: 3300, nets,
      tunnel: { url: 'https://abc-def.trycloudflare.com/', running: true, mode: 'quick', permanent: false }
    });
    assert.equal(list[0].kind, 'tunnel', '面板只绑回环时，隧道仍是唯一出门能开的那条');
    assert.equal(list[0].url, 'https://abc-def.trycloudflare.com/');
    assert.equal(list[0].https, true);
    // 没有隧道就给空，不塞占位地址（打不开的链接比没有更糟）
    assert.ok(!panel.candidateLinks({ host: '0.0.0.0', port: 3300, nets, tunnel: null }).some((it) => it.kind === 'tunnel'));
    assert.ok(!panel.candidateLinks({ host: '0.0.0.0', port: 3300, nets, tunnel: { url: '  ' } }).some((it) => it.kind === 'tunnel'));
  });

  test('隧道：探测打 443 而不是面板端口；可达时 best=tunnel 且码落在隧道上', async () => {
    const seen = [];
    const links = [
      { kind: 'tunnel', address: 'abc-def.trycloudflare.com', url: 'https://abc-def.trycloudflare.com/', https: true },
      { kind: 'lan', address: '192.168.1.23', url: 'http://192.168.1.23:3300/' }
    ];
    const info = await panel.buildRemoteLink({
      code: true, links,
      tunnel: { url: 'https://abc-def.trycloudflare.com/', running: true, mode: 'quick', permanent: false },
      probe: async (address, port) => { seen.push(address + ':' + port); return true }
    });
    assert.deepEqual(seen.sort(), ['192.168.1.23:3300', 'abc-def.trycloudflare.com:443'].sort());
    assert.equal(info.best, 'tunnel');
    assert.ok(info.login.url.startsWith('https://abc-def.trycloudflare.com/?code='));
    assert.equal(info.login.via, 'tunnel');
    assert.equal(info.tunnel.running, true);
  });
}
