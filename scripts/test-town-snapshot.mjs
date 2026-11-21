#!/usr/bin/env node
// test-town-snapshot.mjs —— 给控制台看的那份 state/town/status.json（2026-11-21）。
//
// 钉住：结构稳定、缺块不抛、绝不含访问码、面板要的字段都在（在线/余额/记忆计数/今天动过几次/预算）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSnapshot, writeTownSnapshot, redactSnapshot, SNAPSHOT_VERSION } from '../src/town-snapshot.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('✅ ' + n); };
const bad = (n, e) => { fail++; console.error('❌ ' + n + ' → ' + (e && e.message)); };
async function check(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'town-snap-'));
const day = new Date().toLocaleDateString('sv-SE');

const status = {
  state: 'ready', town_name: 'Fugu', piggy_yuan: '20.00', fish_id: '70aa0e2f29e8',
  outside_state: 'in_town', badge: '外来',
  card: { name: 'Fugu' },
  turns: { prefs: { games: ['ddz', 'mj'], signup: 'normal', take_visits: true, visit_others: true } }
};

await check('基本结构：版本/时间/在线/余额/小镇名', () => {
  const s = buildSnapshot({ now: Date.now(), status });
  assert.equal(s.version, SNAPSHOT_VERSION);
  assert.equal(s.ok, true);
  assert.equal(s.status.online, true);
  assert.equal(s.status.piggyYuan, 20);
  assert.equal(s.status.townName, 'Fugu');
  assert.equal(s.status.fishId, '70aa0e2f29e8');
  assert.deepEqual(s.status.games, ['ddz', 'mj']);
});

await check('关了 / 不在镇里就不是 online', () => {
  assert.equal(buildSnapshot({ status: { outside_state: 'not_connected' } }).status.online, false);
  assert.equal(buildSnapshot({ status: null }).status.online, false);
});

await check('关系 / 花费 / 大厅都认得（缺了留空，不抛）', () => {
  const s = buildSnapshot({
    status,
    bonds: { friends: [{ name: '鱼丸·柚' }, { name: '阿鲸' }], couple: [{ name: '小满' }] },
    spending: { today: '0.02', d7: '0.10', recent: { lines: [] } },
    lobby: { tables: [{ name: '打牌桌' }] },
  });
  assert.deepEqual(s.bonds.friends, ['鱼丸·柚', '阿鲸']);
  assert.deepEqual(s.bonds.couple, ['小满']);
  assert.equal(s.spending.today, 0.02);
  assert.equal(s.lobby.tables, 1);
  const bare = buildSnapshot({});
  assert.deepEqual(bare.bonds.friends, []);
  assert.equal(bare.lobby.tables, 0);
});

await check('记忆计数 / 今天动过几次 / 预算都在', () => {
  const s = buildSnapshot({
    status,
    stats: { notes: 3, impressions: 2, dayLines: 1, days: 1 },
    actions: { date: day, list: [{ at: 1, type: 'visit', target: '阿鲸', ok: true }] },
    budget: { spent: 0.02, cap: 1, blocked: false },
  });
  assert.equal(s.memory.notes, 3);
  assert.equal(s.actions.today, 1);
  assert.match(s.actions.summary, /动过 1 次/);
  assert.equal(s.budget.spent, 0.02);
  assert.equal(s.budget.cap, 1);
  assert.equal(s.budget.blocked, false);
});

await check('错误会被带出来（面板要显示为什么读不到）', () => {
  const s = buildSnapshot({ status, errors: ['lobby: TOWN_OUTSIDE_NOT_CONNECTED 409'] });
  assert.equal(s.ok, false);
  assert.equal(s.errors.length, 1);
});

await check('打码：快照里绝不出现访问码', () => {
  const dirty = { a: 'code=fbo_abcdef123456', nested: { b: ['fbo_zzzzzz'] } };
  const out = redactSnapshot(dirty);
  assert.ok(!JSON.stringify(out).includes('fbo_abcdef123456'));
  assert.ok(JSON.stringify(out).includes('fbo_***'));
});

await check('写盘：原子落盘 + 内容是 JSON + 带 recall 一句', async () => {
  const dir = path.join(TMP, 'state', 'town');
  const calls = [];
  const fake = {
    read(name, opts) {
      calls.push([name, opts]);
      if (name === 'status') return Promise.resolve({ ...status, outside_state: 'in_town' });
      if (name === 'lobby') return Promise.reject(Object.assign(new Error('没连上'), { code: 'TOWN_OUTSIDE_NOT_CONNECTED' }));
      return Promise.resolve({});
    },
  };
  const r = await writeTownSnapshot({ dir, client: fake, now: Date.now(), actionsFile: path.join(dir, 'actions.json'), townConfig: {} });
  assert.equal(r.ok, true);
  const text = fs.readFileSync(path.join(dir, 'status.json'), 'utf8');
  const snap = JSON.parse(text);
  assert.equal(snap.status.online, true);
  assert.ok(snap.errors.some((e) => e.includes('lobby')), '502/409 之类被记下来但整体仍写得出去');
  assert.ok(calls.some(([n]) => n === 'lobby'));
  assert.equal(typeof snap.recall, 'string');
  assert.ok(!text.includes('fbo_'));
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '没有留下半截临时文件');
});

await check('预算读的是数据目录里的 town 桶（不重复拼 stellar）', async () => {
  const base = path.join(TMP, 'usage');
  const dir = path.join(base, 'stellar', 'state', 'town');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(base, 'stellar', 'token-usage-daily.json'), JSON.stringify({
    day, at: Date.now(), source: 'test',
    qq: { cost: 1, tokens: 1 }, bili: { cost: 0, tokens: 0 }, feed: { cost: 0, tokens: 0 },
    town: { cost: 0.42, tokens: 1000 }, other: { cost: 0, tokens: 0 },
    total: { cost: 1.42, tokens: 1001 },
  }));
  const fake = { read: (name) => Promise.resolve(name === 'status' ? { ...status } : {}) };
  await writeTownSnapshot({ dir, client: fake, now: Date.now(), townConfig: {} });
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(snap.budget.spent, 0.42, '面板上的「今天花费」必须是真的');
  assert.equal(snap.budget.cap, 1);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(fail ? '\n❌ 小镇快照：' + pass + ' 通过 / ' + fail + ' 失败' : '\n🎉 小镇快照：' + pass + ' 项通过');
process.exit(fail ? 1 : 0);
