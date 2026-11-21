#!/usr/bin/env node
/** town-store 单元测试：临时目录建库，跑完删掉（不碰真实 memory 目录）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openTownDb, closeTownDb, resolveTownDbFile, insertNote, pruneNotes, listNotes,
  countNotes, upsertImpression, listImpressions, pruneImpressions,
  setDayLine, listDayLines, townStats,
} from '../src/town-store.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, e) => { fail++; console.log('  ✗ ' + n + ' → ' + (e && e.message)); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-store-'));
const db = openTownDb({ dir });
const note = (over = {}) => ({ at: Date.parse('2026-11-21T09:00:00+08:00'), day: '2026-11-21', kind: 'visit', who: '阿鲸', text: '和阿鲸去了码头', src_hash: 'h1', ...over });

console.log('\n— 库文件 —');
await check('库落在 dir/town.db', () => {
  assert.equal(resolveTownDbFile({ dir }), path.join(dir, 'town.db'));
  assert.ok(fs.existsSync(path.join(dir, 'town.db')));
});
await check('同一 dir 复用连接', () => assert.equal(openTownDb({ dir }), db));

console.log('\n— 事件 —');
await check('插入一条', () => assert.equal(insertNote(note(), { db }).inserted, true));
await check('同 src_hash 去重', () => assert.equal(insertNote(note({ text: '改了字但指纹一样' }), { db }).inserted, false));
await check('缺字段不插', () => assert.equal(insertNote({ day: '2026-11-21', text: '' }, { db }).inserted, false));
await check('quoted 落成布尔', () => {
  insertNote(note({ src_hash: 'h2', who: '镇长', text: '「今天你请客」', quoted: 1 }), { db });
  const rows = listNotes({ db });
  assert.equal(rows.find((r) => r.src_hash === 'h2').quoted, true);
  assert.equal(rows.find((r) => r.src_hash === 'h1').quoted, false);
});
await check('按天过滤', () => {
  insertNote(note({ day: '2026-11-20', src_hash: 'h3' }), { db });
  assert.equal(listNotes({ days: ['2026-11-21'], db }).length, 2);
  assert.equal(listNotes({ days: ['2026-11-20'], db }).length, 1);
});
await check('关键词搜 text/who', () => {
  assert.equal(listNotes({ q: '码头', db }).length, 2, 'h1 与 h3 正文都含「码头」');
  assert.equal(listNotes({ q: '镇长', db }).length, 1);
  assert.equal(listNotes({ q: '不存在', db }).length, 0);
});
await check('limit 生效', () => assert.equal(listNotes({ limit: 1, db }).length, 1));
await check('countNotes', () => assert.equal(countNotes({ db }), 3));

console.log('\n— TTL —');
await check('cutoff 前的整天被删', () => {
  assert.equal(pruneNotes('2026-11-21', { db }).deleted, 1);
  assert.equal(countNotes({ db }), 2);
});
await check('非法 cutoff 不动库', () => {
  assert.equal(pruneNotes('2026-1-1', { db }).deleted, 0);
  assert.equal(pruneNotes('', { db }).deleted, 0);
  assert.equal(countNotes({ db }), 2);
});
await check('cutoff 当天不许删', () => {
  assert.equal(pruneNotes('2026-11-21', { db }).deleted, 0);
  assert.equal(countNotes({ db }), 2);
});

console.log('\n— 印象 —');
await check('写一条', () => assert.equal(upsertImpression({ fishId: 'f1', name: '阿鲸', line: '爱打牌，输了会哼哼', at: 1000 }, { db }).ok, true));
await check('同 fishId 覆盖而不是追加', () => {
  upsertImpression({ fishId: 'f1', name: '阿鲸', line: '爱打牌，输了会哼哼，还爱喝奶茶', at: 2000 }, { db });
  const rows = listImpressions({ db });
  assert.equal(rows.length, 1);
  assert.match(rows[0].line, /奶茶/);
});
await check('缺 id/line 不写', () => {
  assert.equal(upsertImpression({ fishId: '', line: 'x' }, { db }).ok, false);
  assert.equal(upsertImpression({ fishId: 'f1', line: '  ' }, { db }).ok, false);
  assert.equal(listImpressions({ db }).length, 1);
});
await check('最多 20 人，淘汰最旧', () => {
  for (let i = 0; i < 25; i++) upsertImpression({ fishId: 'g' + i, name: 'g' + i, line: 'line' + i, at: 20000 + i }, { db });
  const r = pruneImpressions({ max: 20, db });
  assert.ok(r.deleted >= 5, 'deleted=' + r.deleted);
  const rows = listImpressions({ db });
  assert.equal(rows.length, 20);
  assert.ok(!rows.some((x) => x.fish_id === 'g0'), '最旧那条应被淘汰');
  assert.ok(rows.some((x) => x.fish_id === 'g24'), '最新那条要留着');
});
await check('按时间淘汰过期', () => {
  const r = pruneImpressions({ beforeMs: 20010, max: 20, db });
  assert.ok(r.deleted >= 5, 'deleted=' + r.deleted);
  assert.ok(!listImpressions({ db }).some((x) => x.fish_id === 'g9'), 'g9 早于 cutoff 应被删');
  assert.ok(listImpressions({ db }).some((x) => x.fish_id === 'g10'), 'g10 晚于 cutoff 应留着');
});

console.log('\n— 每日一句 —');
await check('写与覆盖', () => {
  assert.equal(setDayLine({ day: '2026-11-21', line: '今天风很大', at: 1 }, { db }).ok, true);
  assert.equal(setDayLine({ day: '2026-11-21', line: '今天风很大，但很好玩', at: 2 }, { db }).ok, true);
  const rows = listDayLines({ db });
  assert.equal(rows.length, 1);
  assert.match(rows[0].line, /很好玩/);
});
await check('坏日期不写', () => {
  assert.equal(setDayLine({ day: '11/21', line: 'x' }, { db }).ok, false);
  assert.equal(setDayLine({ day: '2026-11-22', line: '' }, { db }).ok, false);
});

console.log('\n— 统计 —');
await check('townStats 三个计数', () => {
  const s = townStats({ db });
  assert.equal(s.notes, 2);
  assert.equal(s.days, 1);
  assert.ok(s.impressions >= 1);
});

console.log('\n— 关闭 —');
await check('closeTownDb 可关闭且幂等', () => {
  assert.equal(closeTownDb({ file: path.join(dir, 'town.db') }), true);
  assert.equal(closeTownDb({ file: path.join(dir, 'town.db') }), false);
});
await check('重开能读回数据', () => {
  const db2 = openTownDb({ dir });
  assert.equal(countNotes({ db: db2 }), 2);
  closeTownDb({ file: path.join(dir, 'town.db') });
});
fs.rmSync(dir, { recursive: true, force: true });

console.log('\n' + (fail ? '❌ ' + fail + ' 失败 / ' + (pass + fail) + ' 条' : '✅ 全部通过 ' + pass + '/' + (pass + fail)));
process.exit(fail ? 1 : 0);
