#!/usr/bin/env node
/**
 * town-client 单元测试：全用注入的假 fetch，不联网、不读真实 settings。
 * 跑法：node scripts/test-town-client.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TOWN_HOSTS, ACT_PATHS, MAX_BODY_BYTES, TownError, redactCode,
  normalizeBaseUrl, readTownSettings, createTownClient, makeReader,
} from '../src/town-client.js';

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const bad = (name, err) => { fail++; console.log('  ✗ ' + name + ' → ' + (err && err.message)); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

function jsonRes(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function fakeFetch(fn) { const calls = []; const f = async (url, opts) => { calls.push({ url, opts }); return fn(url, opts); }; f.calls = calls; return f; }

console.log('\n— 地址白名单 —');

await check('https + 白名单域名通过', () => {
  assert.equal(normalizeBaseUrl('https://fishbowltown.com/town/api/outside'), 'https://fishbowltown.com/town/api/outside');
  assert.equal(normalizeBaseUrl('https://fish.bside-moon.cn/town/api/outside/'), 'https://fish.bside-moon.cn/town/api/outside');
});
await check('http 被拒', () => assert.throws(() => normalizeBaseUrl('http://fishbowltown.com/town/api/outside'), /https/));
await check('别的域名被拒', () => assert.throws(() => normalizeBaseUrl('https://evil.example.com/town/api/outside'), /白名单/));
await check('带端口被拒', () => assert.throws(() => normalizeBaseUrl('https://fishbowltown.com:8443/town/api/outside'), /端口/));
await check('带凭据被拒', () => assert.throws(() => normalizeBaseUrl('https://a:b@fishbowltown.com/town/api/outside'), /凭据/));
await check('路径不在 /town/api/ 下被拒', () => assert.throws(() => normalizeBaseUrl('https://fishbowltown.com/api'), /town\/api/));

console.log('\n— 访问码脱敏 —');

await check('redactCode 抹掉 fbo_', () => {
  assert.equal(redactCode('Bearer fbo_abcdef123456'), 'Bearer fbo_***');
  assert.equal(redactCode('no code here'), 'no code here');
  assert.ok(!redactCode(new Error('boom fbo_zzzzzzzz').message).includes('fbo_zzzzzzzz'));
});

console.log('\n— 请求形态 —');

await check('带上 Bearer 与 GET', async () => {
  const f = fakeFetch(() => jsonRes({ ok: 1 }));
  const c = createTownClient({ code: 'fbo_test', fetchImpl: f, minGapMs: 0 });
  const data = await c.read('status');
  assert.deepEqual(data, { ok: 1 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.method, 'GET');
  assert.equal(f.calls[0].opts.headers.authorization, 'Bearer fbo_test');
  assert.equal(f.calls[0].opts.redirect, 'manual');
  assert.equal(f.calls[0].url, 'https://fishbowltown.com/town/api/outside/status');
});
await check('query 参数编码', async () => {
  const f = fakeFetch(() => jsonRes({}));
  const c = createTownClient({ code: 'k', fetchImpl: f, minGapMs: 0 });
  await c.read('visits', { query: { limit: 30, before: '' } });
  assert.equal(f.calls[0].url, 'https://fishbowltown.com/town/api/outside/visits?limit=30');
});
await check('act 走 POST + JSON body', async () => {
  const f = fakeFetch(() => jsonRes({}));
  const c = createTownClient({ code: 'k', fetchImpl: f, minGapMs: 0 });
  await c.act('visit', { fish_id: 7 });
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(f.calls[0].opts.body, JSON.stringify({ fish_id: 7 }));
  assert.equal(f.calls[0].opts.headers['content-type'], 'application/json');
});
await check('act 只允许白名单动作', async () => {
  const c = createTownClient({ code: 'k', fetchImpl: fakeFetch(() => jsonRes({})), minGapMs: 0 });
  for (const p of ACT_PATHS) await c.act(p, {});
  await assert.rejects(() => c.act('signup_cancel', {}), (e) => e instanceof TownError && e.code === 'bad_action');
});

console.log('\n— 错误面 —');

await check('3xx 直接报错不跟随', async () => {
  const c = createTownClient({ code: 'k', fetchImpl: fakeFetch(() => jsonRes('', { status: 302 })), minGapMs: 0 });
  await assert.rejects(() => c.read('status'), (e) => e.code === 'redirect');
});
await check('401 → auth', async () => {
  const c = createTownClient({ code: 'k', fetchImpl: fakeFetch(() => jsonRes({ error: 'bad token' }, { status: 401 })), minGapMs: 0 });
  await assert.rejects(() => c.read('status'), (e) => e.code === 'auth' && e.status === 401);
});
await check('429 → rate_limited 带 retryAfter', async () => {
  const c = createTownClient({ code: 'k', fetchImpl: fakeFetch(() => jsonRes({}, { status: 429, headers: { 'retry-after': '30' } })), minGapMs: 0 });
  await assert.rejects(() => c.read('status'), (e) => e.code === 'rate_limited' && e.retryAfter === 30);
});
await check('非 JSON 被拒', async () => {
  const c = createTownClient({ code: 'k', fetchImpl: fakeFetch(() => jsonRes('<html>')), minGapMs: 0 });
  await assert.rejects(() => c.read('status'), (e) => e.code === 'bad_json');
});
await check('超大响应被拒', async () => {
  const big = 'x'.repeat(MAX_BODY_BYTES + 10);
  const c = createTownClient({ code: 'k', fetchImpl: fakeFetch(() => jsonRes(JSON.stringify({ big }))), minGapMs: 0 });
  await assert.rejects(() => c.read('status'), (e) => e.code === 'too_large');
});
await check('超时 → timeout', async () => {
  const f = fakeFetch((url, opts) => new Promise((_, rej) => {
    opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
  }));
  const c = createTownClient({ code: 'k', fetchImpl: f, timeoutMs: 30, minGapMs: 0 });
  await assert.rejects(() => c.read('status'), (e) => e.code === 'timeout');
});
await check('网络错误里的码被打码', async () => {
  const c = createTownClient({ code: 'fbo_secret_value', fetchImpl: fakeFetch(() => { throw new Error('ECONN: fbo_secret_value leaked'); }), minGapMs: 0 });
  await assert.rejects(() => c.read('status'), (e) => e.code === 'network' && !e.message.includes('fbo_secret_value'));
});
await check('无码直接抛', () => assert.throws(() => createTownClient({ code: '' }), (e) => e.code === 'no_code'));

console.log('\n— settings 读取 —');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'town-client-'));
await check('没有文件回 null', () => assert.equal(readTownSettings(tmp), null));
await check('读到 fish[0] 且不吞码', () => {
  fs.mkdirSync(path.join(tmp, 'fishbowl-town'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'fishbowl-town', 'settings.json'), JSON.stringify({
    baseUrl: 'https://fishbowltown.com/town/api/outside',
    fish: [
      { id: 'a', code: 'fbo_first', persona: 'p1', chatSid: 'town-whale', alsoSids: ['qq:1'], enabled: true },
      { id: 'b', code: 'fbo_second', persona: 'p2', enabled: true },
      { id: 'c', code: 'fbo_off', persona: 'p3', enabled: false },
    ],
  }));
  const a = readTownSettings(tmp);
  assert.equal(a.fishId, 'a');
  assert.equal(a.code, 'fbo_first');
  assert.deepEqual(a.alsoSids, ['qq:1']);
  assert.equal(readTownSettings(tmp, { fishId: 'b' }).code, 'fbo_second');
  assert.equal(readTownSettings(tmp, { fishId: 'c' }), null, '禁用的鱼不该被选中');
});
await check('坏 JSON 回 null 不抛', () => {
  fs.writeFileSync(path.join(tmp, 'fishbowl-town', 'settings.json'), '{broken');
  assert.equal(readTownSettings(tmp), null);
});
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n— reader 端点 —');

await check('makeReader 打出正确路径', async () => {
  const f = fakeFetch(() => jsonRes({}));
  const r = makeReader(createTownClient({ code: 'k', fetchImpl: f, minGapMs: 0 }));
  await r.status(); await r.bonds(); await r.lobby(); await r.visits(5); await r.visit('abc');
  await r.week(3); await r.receipts(9); await r.spending();
  const urls = f.calls.map((c) => c.url.replace('https://fishbowltown.com/town/api/outside', ''));
  assert.deepEqual(urls, ['/status', '/bonds', '/lobby', '/visits?limit=5', '/visits/abc', '/week?days=3', '/receipts?limit=9', '/spending']);
});

console.log('\n' + (fail ? '❌ ' + fail + ' 失败 / ' + (pass + fail) + ' 条' : '✅ 全部通过 ' + pass + '/' + (pass + fail)));
process.exit(fail ? 1 : 0);
