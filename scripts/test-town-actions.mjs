#!/usr/bin/env node
/**
 * town-budget + town-actions 单元测试：钱与次数这两道闸。
 * 跑法：node scripts/test-town-actions.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_TOWN_DAILY_CNY, DEFAULT_TOWN_SOFT_CNY, townSpendToday, townDailyCap, townSoftCap,
  townBudgetState, townSoftLine,
} from '../src/town-budget.js';
import {
  TOWN_ACTIONS, DEFAULT_ACTION_DAILY_MAX, DEFAULT_ACTION_MIN_GAP_MIN, actionStatePath,
  emptyActionState, readActionState, writeActionState, listActionsToday, actionGate, appendAction,
  settleAction, summarizeActions,
} from '../src/town-actions.js';

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const bad = (name, err) => { fail++; console.log('  ✗ ' + name + ' → ' + (err && err.message)); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'town-actions-'));
const home = path.join(TMP, 'home');
const stellarDir = path.join(home, 'stellar');
fs.mkdirSync(stellarDir, { recursive: true });
const day = '2026-11-21';

function writeUsage(usage, dayKey = day) {
  fs.writeFileSync(path.join(stellarDir, 'token-usage-daily.json'), JSON.stringify({ day: dayKey, at: Date.now(), source: 'test', ...usage }), 'utf8');
}

console.log('\n— 小镇的钱 —');

await check('没有用量文件时花销为 0，且不抛', () => {
  assert.equal(townSpendToday(home), 0);
  assert.equal(townSpendToday(''), 0);
});

await check('town.cost 被读出来（不是 cny 字段）', () => {
  writeUsage({ qq: { cost: 1, tokens: 1 }, bili: { cost: 0.5, tokens: 1 }, feed: { cost: 0, tokens: 0 }, town: { cost: 0.42, tokens: 100 }, other: { cost: 0, tokens: 0 }, total: { cost: 1.92, tokens: 3 } });
  assert.equal(townSpendToday(home), 0.42);
});

await check('旧文件（不是今天）算 0，避免把昨天的账当今天', () => {
  writeUsage({ town: { cost: 0.9, tokens: 1 } }, '2026-11-20');
  assert.equal(townSpendToday(home), 0);
});

await check('默认日上限 ¥1、软目标 ¥0.3', () => {
  assert.equal(DEFAULT_TOWN_DAILY_CNY, 1);
  assert.equal(DEFAULT_TOWN_SOFT_CNY, 0.3);
  assert.equal(townDailyCap({}), 1);
  assert.equal(townSoftCap({}), 0.3);
  assert.equal(townDailyCap({ dailyBudgetCNY: 0 }), 0, '0 表示不设上限');
  assert.equal(townDailyCap({ dailyBudgetCNY: 'x' }), 1, '坏值回落默认');
});

await check('花到上限才 blocked，差一点不算', () => {
  writeUsage({ town: { cost: 0.99, tokens: 1 } });
  assert.deepEqual(townBudgetState(home, {}), { blocked: false, spent: 0.99, cap: 1 });
  writeUsage({ town: { cost: 1, tokens: 1 } });
  assert.equal(townBudgetState(home, {}).blocked, true);
});

await check('软目标提示：没到不提示，到了给出金额', () => {
  writeUsage({ town: { cost: 0.1, tokens: 1 } });
  assert.equal(townSoftLine(home, {}), '');
  writeUsage({ town: { cost: 0.35, tokens: 1 } });
  const line = townSoftLine(home, {});
  assert.match(line, /软目标 ¥0\.30/);
  assert.match(line, /已花 ¥0\.35/);
});

console.log('\n— 动作账本 —');

const stateFile = actionStatePath(path.join(TMP, 'state'));

await check('动作只有 visit / play / goto 三种', () => {
  assert.deepEqual([...TOWN_ACTIONS], ['visit', 'play', 'goto']);
  assert.equal(DEFAULT_ACTION_DAILY_MAX, 3);
  assert.equal(DEFAULT_ACTION_MIN_GAP_MIN, 15);
});

await check('账本不存在时读成当天空账本', () => {
  const s = readActionState(stateFile, { today: day });
  assert.equal(s.date, day);
  assert.deepEqual(s.list, []);
});

await check('写进去能读回来；坏文件当空账本', () => {
  writeActionState(stateFile, { date: day, list: [{ at: 1, type: 'visit', target: '鱼丸·柚', ok: true }] });
  const s = readActionState(stateFile, { today: day });
  assert.equal(s.list.length, 1);
  fs.writeFileSync(stateFile, '{oops', 'utf8');
  assert.deepEqual(readActionState(stateFile, { today: day }).list, []);
});

await check('跨天自动重置（昨天的次数不算今天）', () => {
  writeActionState(stateFile, { date: '2026-11-20', list: [{ at: 1, type: 'play' }] });
  const s = readActionState(stateFile, { today: day });
  assert.equal(s.date, day);
  assert.deepEqual(s.list, []);
});

await check('闸门：预算花超 → budget，不做动作', () => {
  const gate = actionGate({ state: emptyActionState(day), today: day, budget: { blocked: true, spent: 1, cap: 1 } });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'budget');
  assert.match(gate.reason, /上限/);
});

await check('闸门：次数到顶 → cap', () => {
  const state = { date: day, list: [{ at: 1 }, { at: 2 }, { at: 3 }] };
  const gate = actionGate({ state, today: day, cap: 3, minGapMin: 0 });
  assert.equal(gate.code, 'cap');
  assert.match(gate.reason, /3 次/);
});

await check('闸门：间隔不够 → gap，并算出还剩几分钟', () => {
  const now = 1_000_000_000;
  const state = { date: day, list: [{ at: now - 5 * 60_000, type: 'play' }] };
  const gate = actionGate({ state, today: day, cap: 3, minGapMin: 15, now });
  assert.equal(gate.code, 'gap');
  assert.match(gate.reason, /10 分钟后/);
  const later = actionGate({ state, today: day, cap: 3, minGapMin: 15, now: now + 11 * 60_000 });
  assert.equal(later.ok, true);
});

await check('appendAction 追加并按日期归档', () => {
  let s = emptyActionState(day);
  s = appendAction(s, { at: 10, type: 'visit', target: '鱼丸·柚' }, { today: day });
  s = appendAction(s, { at: 20, type: 'play', ok: false, note: '桌子满了' }, { today: day });
  assert.equal(s.list.length, 2);
  assert.equal(s.list[1].ok, false);
  const next = appendAction(s, { at: 30, type: 'goto' }, { today: '2026-11-22' });
  assert.equal(next.date, '2026-11-22');
  assert.equal(next.list.length, 1);
});

await check('摘要：没动过 / 动过几次都说得出来', () => {
  assert.match(summarizeActions(emptyActionState(day), day), /还没/);
  const s = { date: day, list: [{ at: Date.now(), type: 'play', target: 'ddz' }] };
  assert.match(summarizeActions(s, day), /今天动过 1 次/);
  assert.match(summarizeActions(s, day), /play ddz/);
});

await check('listActionsToday 按时间正序', () => {
  const s = { date: day, list: [{ at: 30, type: 'goto' }, { at: 10, type: 'visit' }, { at: 20, type: 'play' }] };
  assert.deepEqual(listActionsToday(s, day).map((x) => x.type), ['visit', 'play', 'goto']);
});

await check('账本坏了就 fail-closed：先占名额，不能当没用过（S4）', () => {
  const file = path.join(TMP, 'corrupt.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  const s = readActionState(file, { today: day });
  assert.equal(s.corrupt, true);
  const gate = actionGate({ state: s, today: day, cap: 3, minGapMin: 0 });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'state');
  assert.match(gate.reason, /账本/);
  // 文件不存在 ≠ 坏：今天还没动过是正常的。
  const empty = readActionState(path.join(TMP, 'nope.json'), { today: day });
  assert.equal(empty.corrupt, undefined);
  assert.equal(actionGate({ state: empty, today: day, cap: 3, minGapMin: 0 }).ok, true);
});

await check('先占名额再联网：pending 也算次数，结果回来改成终态', () => {
  let s = emptyActionState(day);
  s = appendAction(s, { at: 100, type: 'visit', target: '鱼丸·柚', pending: true, note: '进行中' }, { today: day });
  assert.equal(s.list[0].pending, true);
  const blocked = actionGate({ state: s, today: day, cap: 1, minGapMin: 0 });
  assert.equal(blocked.code, 'cap', '占名额的那一笔必须算进次数');
  s = settleAction(s, 100, { ok: false, type: 'visit', target: '鱼丸·柚', note: '对方不在家' }, { today: day });
  assert.equal(s.list[0].pending, undefined);
  assert.equal(s.list[0].ok, false);
  assert.equal(s.list[0].note, '对方不在家');
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log('\n' + (fail ? '❌ ' + pass + ' 通过 / ' + fail + ' 失败' : '✅ 全部通过 ' + pass + '/' + pass));
process.exit(fail ? 1 : 0);
