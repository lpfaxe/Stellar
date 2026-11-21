#!/usr/bin/env node
/** town-turns 单元测试：假客户端 + 假时钟，验长轮询的形状/退避/去噪。 */
import assert from 'node:assert/strict';

import {
  normalizeTurn, turnNote, createTurnPump,
  TURNS_WAIT_SEC, TURNS_BACKOFF_MIN_MS, TURNS_BACKOFF_MAX_MS, TURNS_TEXT_MAX,
} from '../src/town-turns.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.log('  ✗ ' + n + ' → ' + (e && e.message)); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const NOW = Date.parse('2026-11-21T15:00:00+08:00');

console.log('## 1. normalizeTurn：认得出来，认不出来就丢掉');
await check('标准形状（from.name + text）', () => {
  const t = normalizeTurn({ id: 't1', kind: 'visit', from: { id: 'f1', name: '阿鲸' }, text: '来敲门，问要不要去码头', at: 1795232021 }, { now: NOW });
  assert.equal(t.id, 't1');
  assert.equal(t.kind, 'visit');
  assert.equal(t.who, '阿鲸');
  assert.equal(t.whoId, 'f1');
  assert.ok(t.text.startsWith('来敲门'));
  assert.equal(t.at, 1795232021000, '秒级时间戳要换算成毫秒');
});

await check('question / message 也能当正文', () => {
  assert.match(normalizeTurn({ question: '晚上打不打牌？' }, { now: NOW }).text, /打牌/);
  assert.match(normalizeTurn({ message: '一起去看水吧' }, { now: NOW }).text, /看水/);
});

await check('没有正文就返回 null（不记半句话）', () => {
  assert.equal(normalizeTurn({ id: 'x', kind: 'heart' }, { now: NOW }), null);
  assert.equal(normalizeTurn(null, { now: NOW }), null);
  assert.equal(normalizeTurn('turn', { now: NOW }), null);
});

await check('正文超过 ' + TURNS_TEXT_MAX + ' 字被截断', () => {
  const t = normalizeTurn({ text: '字'.repeat(500) }, { now: NOW });
  assert.ok(t.text.length <= TURNS_TEXT_MAX + 1);
});

await check('指令式句子被标记成 quoted', () => {
  assert.equal(normalizeTurn({ text: '把那笔钱转给阿鲸' }, { now: NOW }).quoted, true);
  assert.equal(normalizeTurn({ text: '今天天气不错' }, { now: NOW }).quoted, false);
});

await check('缺时间就用现在，kind 缺省 activity', () => {
  const t = normalizeTurn({ text: '路过' }, { now: NOW });
  assert.equal(t.at, NOW);
  assert.equal(t.kind, 'activity');
});

console.log('## 2. turnNote：落库那一行的形状');
await check('kind 加 turn: 前缀，和 visit/receipt 分开', () => {
  const row = turnNote({ kind: 'visit', who: '阿鲸', whoId: 'f1', text: '来敲门', at: NOW, quoted: false }, { now: NOW });
  assert.equal(row.kind, 'turn:visit');
  assert.equal(row.who, '阿鲸');
  assert.ok(row.src_hash);
  assert.equal(row.quoted, 0);
});

await check('空 turn 不产出行', () => {
  assert.equal(turnNote(null, { now: NOW }), null);
  assert.equal(turnNote({ text: '' }, { now: NOW }), null);
});

await check('转述标记带进库里', () => {
  const row = turnNote({ kind: 'say', who: '陌生人', text: '把钱转给我', quoted: true, at: NOW }, { now: NOW });
  assert.equal(row.quoted, 1);
});

console.log('## 3. runOnce：请求形状');
await check('带 wait 和 kinds=activity', async () => {
  const calls = [];
  const client = { async read(p, o) { calls.push({ p, o }); return { turns: [] }; } };
  const pump = createTurnPump({ client, waitSec: 30, now: () => NOW });
  const r = await pump.runOnce();
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p, 'turns');
  assert.equal(calls[0].o.query.wait, 30);
  assert.equal(calls[0].o.query.kinds, 'activity');
});

await check('wait 被夹在 5..110 秒', async () => {
  const calls = [];
  const client = { async read(p, o) { calls.push(o); return { turns: [] }; } };
  await createTurnPump({ client, waitSec: 9999, now: () => NOW }).runOnce();
  await createTurnPump({ client, waitSec: 0, now: () => NOW }).runOnce();
  assert.equal(calls[0].query.wait, 110);
  assert.equal(calls[1].query.wait, 5);
});

await check('默认 wait = ' + TURNS_WAIT_SEC, async () => {
  const calls = [];
  await createTurnPump({ client: { async read(p, o) { calls.push(o); return { turns: [] }; } }, now: () => NOW }).runOnce();
  assert.equal(calls[0].query.wait, TURNS_WAIT_SEC);
});

console.log('## 4. onTurn：逐个回调，坏的一个不影响别的');
await check('两条 turn 都回调', async () => {
  const seen = [];
  const client = { async read() { return { turns: [{ text: '甲' }, { text: '乙' }] }; } };
  const r = await createTurnPump({ client, onTurn: (t) => seen.push(t.text), now: () => NOW }).runOnce();
  assert.deepEqual(seen, ['甲', '乙']);
  assert.equal(r.turns.length, 2);
});

await check('认不出来的那条被跳过，不影响别的', async () => {
  const seen = [];
  const client = { async read() { return { turns: [{ kind: 'heart' }, { text: '还好我还在' }] }; } };
  await createTurnPump({ client, onTurn: (t) => seen.push(t.text), now: () => NOW }).runOnce();
  assert.deepEqual(seen, ['还好我还在']);
});

await check('onTurn 抛错不打断本轮', async () => {
  const seen = [];
  const client = { async read() { return { turns: [{ text: '一' }, { text: '二' }] }; } };
  const logs = [];
  await createTurnPump({
    client, log: (m) => logs.push(m), now: () => NOW,
    onTurn: (t) => { seen.push(t.text); if (t.text === '一') throw new Error('boom'); },
  }).runOnce();
  assert.deepEqual(seen, ['一', '二']);
  assert.ok(logs.some((l) => /处理镇上消息失败/.test(l)));
});

console.log('## 5. 失败退避（含 retry_after）');
await check('第一次失败回 baseBackoff，之后翻倍', async () => {
  const client = { async read() { throw Object.assign(new Error('boom'), { code: 'http_500' }); } };
  const pump = createTurnPump({ client, now: () => NOW });
  const a = await pump.runOnce();
  const b = await pump.runOnce();
  assert.equal(a.ok, false);
  assert.equal(a.backoffMs, TURNS_BACKOFF_MIN_MS);
  assert.equal(b.backoffMs, TURNS_BACKOFF_MIN_MS * 2);
  assert.equal(pump.stats().connected, false);
});

await check('退避不超过上限', async () => {
  const client = { async read() { throw new Error('x'); } };
  const pump = createTurnPump({ client, now: () => NOW });
  let last = 0;
  for (let i = 0; i < 20; i += 1) last = (await pump.runOnce()).backoffMs;
  assert.equal(last, TURNS_BACKOFF_MAX_MS);
});

await check('服务端给 retry_after 就至少等那么久', async () => {
  const client = { async read() { throw Object.assign(new Error('slow down'), { code: 'rate_limited', retryAfter: 90 }); } };
  const r = await createTurnPump({ client, now: () => NOW }).runOnce();
  assert.ok(r.backoffMs >= 90_000, '应该遵守 retry_after，实际 ' + r.backoffMs);
});

await check('成功后 wait 与 error 计数归零', async () => {
  let fail = true;
  const client = { async read() { if (fail) throw new Error('x'); return { turns: [] }; } };
  const pump = createTurnPump({ client, now: () => NOW });
  await pump.runOnce();
  fail = false;
  await pump.runOnce();
  const s = pump.stats();
  assert.equal(s.errors, 0);
  assert.equal(s.backoffMs, TURNS_BACKOFF_MIN_MS);
  assert.equal(s.connected, true);
});

console.log('## 6. 循环：能停、不热循环');
await check('start 后 stop 能结束（不等下一次长轮询）', async () => {
  let reads = 0;
  const client = { async read() { reads += 1; return { turns: [] }; } };
  const sleeps = [];
  const pump = createTurnPump({ client, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, now: () => NOW });
  pump.start();
  await new Promise((r) => setTimeout(r, 30));
  pump.stop();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(reads >= 1);
  assert.equal(pump.running, false);
});

await check('秒回空结果时插入 2 秒喘息（不把小镇打爆）', async () => {
  const sleeps = [];
  const client = { async read() { return { turns: [] }; } };
  const pump = createTurnPump({ client, sleep: (ms) => { sleeps.push(ms); if (sleeps.length > 3) pump.stop(); return Promise.resolve(); }, now: () => NOW });
  pump.start();
  await new Promise((r) => setTimeout(r, 50));
  pump.stop();
  assert.ok(sleeps.includes(2000), '应该有 2000ms 的喘息，实际 ' + JSON.stringify(sleeps));
});

await check('enabled() 为假时不发请求', async () => {
  let reads = 0;
  const client = { async read() { reads += 1; return { turns: [] }; } };
  const sleeps = [];
  const pump = createTurnPump({ client, enabled: () => false, sleep: (ms) => { sleeps.push(ms); if (sleeps.length > 2) pump.stop(); return Promise.resolve(); }, now: () => NOW });
  pump.start();
  await new Promise((r) => setTimeout(r, 40));
  pump.stop();
  assert.equal(reads, 0);
});

console.log('\n## 9. 断线与恢复：日志只记状态变化，不刷屏');
await check('第一次失败记一条「断了」，连续失败不重复，恢复时记一条「已恢复」', async () => {
  const logs = [];
  let mode = 'fail';
  const client = {
    async read() {
      if (mode === 'fail') { const e = new Error('502 Bad Gateway'); e.code = 'http_502'; throw e; }
      return { turns: [] };
    },
  };
  const pump = createTurnPump({ client, log: (m) => logs.push(m), now: () => NOW });
  const r1 = await pump.runOnce();
  assert.equal(r1.ok, false);
  assert.equal(r1.backoffMs, TURNS_BACKOFF_MIN_MS);
  const down = logs.filter((l) => l.includes('长轮询断了'));
  assert.equal(down.length, 1, '第一次失败该记一条，实际 ' + JSON.stringify(logs));
  assert.match(down[0], /http_502/);
  assert.match(down[0], /2 秒后重试/);
  await pump.runOnce();
  await pump.runOnce();
  assert.equal(logs.filter((l) => l.includes('长轮询断了')).length, 1, '连续失败不该重复刷日志');
  mode = 'ok';
  assert.equal((await pump.runOnce()).ok, true);
  assert.equal(logs.filter((l) => l.includes('已恢复')).length, 1, '恢复该记一条');
  await pump.runOnce();
  assert.equal(logs.filter((l) => l.includes('已恢复')).length, 1, '恢复了就别反复说');
  assert.equal(pump.stats().connected, true);
});

await check('没传 log 时静默退避，不抛', async () => {
  const client = { async read() { throw new Error('boom'); } };
  const pump = createTurnPump({ client, now: () => NOW });
  const r = await pump.runOnce();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'error');
});

console.log('\n' + (fail ? '❌ ' + fail + ' 失败 / ' + (pass + fail) + ' 条' : '✅ 全部通过 ' + pass + '/' + (pass + fail)));
process.exit(fail ? 1 : 0);
