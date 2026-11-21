#!/usr/bin/env node
/** town-collector 单元测试：假客户端 + 临时库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectTownOnce, createTownCollector, deriveImpressions } from '../src/town-collector.js';
import { openTownDb, closeTownDb, insertNote, listNotes, listImpressions, countNotes } from '../src/town-store.js';
import { buildNoteRow } from '../src/town-memory-pure.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.log('  ✗ ' + n + ' → ' + (e && e.message)); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const NOW = Date.parse('2026-11-21T15:00:00+08:00');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-collector-'));
const db = openTownDb({ dir });

const VISITS = [
  { id: 'v1', at: '2026-11-21T10:00:00+08:00', partner: { id: 'f1', name: '阿鲸' }, summary: '一起去了码头' },
  { id: 'v2', at: '2026-11-21T12:00:00+08:00', partner: { id: 'f1', name: '阿鲸' }, summary: '在码头坐着看水' },
  { id: 'v3', at: '2026-11-20T09:00:00+08:00', partner: { id: 'f2', name: '小满' }, summary: '打牌输给她' },
];
const RECEIPTS = [{ at: '2026-11-20T09:30:00+08:00', name: '小满', item: '请她喝奶茶', amount: 0.02 }];

function fakeClient(state = {}) {
  const calls = [];
  return {
    calls,
    async read(p, o) {
      calls.push({ path: p, opts: o });
      if (state.fail === p) throw Object.assign(new Error('boom'), { code: 'http_500' });
      if (p === 'visits') return { visits: VISITS };
      if (p === 'receipts') return { receipts: RECEIPTS };
      return {};
    },
  };
}

console.log('\n— 采集 —');
await check('首轮：只读两个端点', async () => {
  const c = fakeClient();
  const r = await collectTownOnce({ client: c, db, now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(c.calls.map((x) => x.path).sort(), ['receipts', 'visits']);
  assert.equal(r.added, 4, '3 条拜访 + 1 条请客');
  assert.equal(countNotes({ db }), 4);
});
await check('二轮：同数据全部去重', async () => {
  const r = await collectTownOnce({ client: fakeClient(), db, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.added, 0);
  assert.equal(countNotes({ db }), 4);
});
await check('落库内容被清洗、带 day', () => {
  const rows = listNotes({ db, limit: 10 });
  const v1 = rows.find((x) => x.visit_id === 'v1');
  assert.equal(v1.day, '2026-11-21');
  assert.equal(v1.kind, 'visit');
  assert.equal(v1.who, '阿鲸');
  assert.equal(v1.quoted, false);
  const rec = rows.find((x) => x.kind === 'receipt');
  assert.match(rec.text, /奶茶/);
  assert.match(rec.text, /0\.02/);
});
await check('印象：见过 2 次才记', () => {
  const imps = listImpressions({ db });
  const f1 = imps.find((i) => i.fish_id === 'f1');
  assert.ok(f1, '阿鲸应该有条印象');
  assert.match(f1.line, /见过 2 次/);
  assert.match(f1.line, /看水/);
  assert.ok(!imps.some((i) => i.fish_id === 'f2'), '只见过一次的不记');
});

console.log('\n— 失败面 —');
await check('端点 500 不抛、记 error、其余照采', async () => {
  const c = fakeClient({ fail: 'visits' });
  const r = await collectTownOnce({ client: c, db, now: NOW });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('visits')), r.errors.join('|'));
  assert.equal(r.added, 0);
  assert.equal(countNotes({ db }), 4, '已有数据不该被破坏');
});
await check('客户端整个炸掉也不抛', async () => {
  const c = { read() { throw new Error('network down'); } };
  const r = await collectTownOnce({ client: c, db, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

console.log('\n— TTL —');
await check('采集顺带删掉前天的整天', async () => {
  insertNote(buildNoteRow({ kind: 'visit', who: '旧友', text: '很久以前', at: Date.parse('2026-11-18T10:00:00+08:00') }, NOW), { db });
  insertNote(buildNoteRow({ kind: 'visit', who: '边界友', text: '前天', at: Date.parse('2026-11-19T10:00:00+08:00') }, NOW), { db });
  assert.equal(countNotes({ db }), 6);
  const r = await collectTownOnce({ client: fakeClient(), db, now: NOW });
  assert.equal(r.deleted, 1);
  assert.equal(countNotes({ db }), 5);
  assert.ok(listNotes({ db, limit: 20 }).some((n) => n.who === '边界友'), '前天（cutoff 当天）要留着');
  assert.ok(!listNotes({ db, limit: 20 }).some((n) => n.who === '旧友'));
});

console.log('\n— 调度器 —');
await check('busy 时重入被拒', async () => {
  const slow = { read: () => new Promise((r) => setTimeout(() => r({ visits: [], receipts: [] }), 50)) };
  const sched = createTownCollector({ client: slow, db, intervalMs: 100000 });
  const a = sched.runOnce(NOW);
  const b = await sched.runOnce(NOW);
  assert.equal(b.skipped, 'busy');
  await a;
});
await check('失败会累加计数、成功清零', async () => {
  const sched = createTownCollector({ client: { read() { throw new Error('x'); } }, db, intervalMs: 100000 });
  await sched.runOnce(NOW);
  assert.equal(sched.failures, 1);
  const sched2 = createTownCollector({ client: fakeClient(), db, intervalMs: 100000 });
  await sched2.runOnce(NOW);
  assert.equal(sched2.failures, 0);
  assert.ok(sched2.last && sched2.last.ok === true);
});

console.log('\n— deriveImpressions —');
await check('少于 2 次不出印象；名字缺就留空', () => {
  const out = deriveImpressions([
    { who: '甲', whoId: 'a', text: '玩', at: 1 },
    { who: '乙', whoId: 'b', text: '玩', at: 2 },
    { who: '乙', whoId: 'b', text: '又玩', at: 3 },
  ], { now: 10 });
  assert.equal(out.length, 1);
  assert.equal(out[0].fishId, 'b');
  assert.match(out[0].line, /又玩/);
});

closeTownDb({ file: path.join(dir, 'town.db') });
fs.rmSync(dir, { recursive: true, force: true });

console.log('\n' + (fail ? '❌ ' + fail + ' 失败 / ' + (pass + fail) + ' 条' : '✅ 全部通过 ' + pass + '/' + (pass + fail)));
process.exit(fail ? 1 : 0);
