/**
 * B站「醒来账」的回归：合并窗口 / 每趟预算 / 每日金额闸（2026-11-24 方案 A）。
 *
 * 为什么单列一条：
 *   · 合并窗口判错 = 她一天醒不来（主线卡死）或照旧一分钟醒三趟（白花钱），两头都是事故；
 *   · 缺省与「显式关掉」必须能区分：主人写 0 就是真关，绝不能被我静默改回 20（PITFALLS #313 的同类）；
 *   · 金额闸读账本失败要当成「没超」——宁可多花一次，也不能因为账本坏了整晚不醒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-wake-'));
process.env.DSH_HOME = root;
fs.mkdirSync(path.join(root, 'stellar'), { recursive: true });

const wb = await import('../plugins/stellar/lib/bili-wake-budget.js');

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

test('缺省三个旋钮：20 分钟 / 12 次 / ¥0.8', () => {
  const c = wb.wakeBudgetConfig({});
  assert.equal(c.mergeGapMin, 20);
  assert.equal(c.maxCallsPerTurn, 12);
  assert.equal(c.dailyCNY, 0.8);
});

test('显式 0 = 关掉（不是回落默认）', () => {
  const c = wb.wakeBudgetConfig({ wake: { mergeGapMin: 0, maxCallsPerTurn: 0 }, budget: { dailyCNY: 0 } });
  assert.equal(c.mergeGapMin, 0);
  assert.equal(c.maxCallsPerTurn, 0);
  assert.equal(c.dailyCNY, 0);
});

test('坏值回落默认，负数夹到 0', () => {
  const bad = wb.wakeBudgetConfig({ wake: { mergeGapMin: 'abc', maxCallsPerTurn: 'x' }, budget: { dailyCNY: 'nope' } });
  assert.equal(bad.mergeGapMin, 20);
  assert.equal(bad.maxCallsPerTurn, 12);
  assert.equal(bad.dailyCNY, 0.8);
  const neg = wb.wakeBudgetConfig({ wake: { mergeGapMin: -5 }, budget: { dailyCNY: -1 } });
  assert.equal(neg.mergeGapMin, 0);
  assert.equal(neg.dailyCNY, 0);
});

test('上一趟收工 5 分钟 → 压着（还剩约 15 分钟）', () => {
  const now = 1_800_000_000_000;
  const r = wb.shouldDeferWake({ now, lastTurnEndAt: now - 5 * 60_000, mergeGapMin: 20 });
  assert.equal(r.defer, true);
  assert.equal(r.reason, 'merge-window');
  assert.equal(r.waitMs, 15 * 60_000);
});

test('上一趟收工 25 分钟 → 放行', () => {
  const now = 1_800_000_000_000;
  const r = wb.shouldDeferWake({ now, lastTurnEndAt: now - 25 * 60_000, mergeGapMin: 20 });
  assert.equal(r.defer, false);
  assert.equal(r.reason, 'merge-window-passed');
});

test('从没跑过 / 时间戳是 0 → 放行（别让第一趟永远不醒）', () => {
  const r = wb.shouldDeferWake({ now: Date.now(), lastTurnEndAt: 0, mergeGapMin: 20 });
  assert.equal(r.defer, false);
  assert.equal(r.reason, 'no-previous-turn');
});

test('mergeGapMin=0 → 合并整个关掉', () => {
  const now = Date.now();
  const r = wb.shouldDeferWake({ now, lastTurnEndAt: now - 1000, mergeGapMin: 0 });
  assert.equal(r.defer, false);
  assert.equal(r.reason, 'merge-off');
});

test('urgent（主人本人回复 / 待办 / 驳回返工）绕过合并', () => {
  const now = Date.now();
  const r = wb.shouldDeferWake({ now, lastTurnEndAt: now - 60_000, mergeGapMin: 60, urgent: true });
  assert.equal(r.defer, false);
  assert.equal(r.reason, 'urgent');
});

test('lastTurnEndAt 只认 turn_end，且只认这个会话', () => {
  const file = path.join(root, 'telemetry.jsonl');
  const rows = [
    { kind: 'turn_start', sessionId: 's1', ts: 1000 },
    { kind: 'model_call', sessionId: 's1', ts: 1500 },
    { kind: 'turn_end', sessionId: 's1', ts: 2000 },
    { kind: 'turn_end', sessionId: 's2', ts: 9000 },
    { kind: 'turn_end', sessionId: 's1', ts: 3000 },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  assert.equal(wb.lastTurnEndAt(file, 's1'), 3000);
  assert.equal(wb.lastTurnEndAt(file, 's2'), 9000);
  assert.equal(wb.lastTurnEndAt(file, 'nobody'), 0);
});

test('telemetry 文件不存在 → 0（不抛）', () => {
  assert.equal(wb.lastTurnEndAt(path.join(root, 'nope.jsonl'), 's1'), 0);
});

test('今天的账：读到 bili.cost', () => {
  const today = new Date().toLocaleDateString('sv-SE');
  const file = path.join(root, 'stellar', 'token-usage-daily.json');
  fs.writeFileSync(file, JSON.stringify({ day: today, bili: { cost: 0.42, tokens: 123 } }), 'utf8');
  assert.equal(Math.round(wb.biliSpendToday(root) * 100) / 100, 0.42);
  const gate = wb.biliBudgetState(root, { budget: { dailyCNY: 0.8 } });
  assert.equal(gate.blocked, false);
  const tight = wb.biliBudgetState(root, { budget: { dailyCNY: 0.4 } });
  assert.equal(tight.blocked, true);
});

test('昨天的账不算今天（不然跨天第一趟就被拦）', () => {
  const file = path.join(root, 'stellar', 'token-usage-daily.json');
  fs.writeFileSync(file, JSON.stringify({ day: '2000-01-01', bili: { cost: 5 } }), 'utf8');
  assert.equal(wb.biliSpendToday(root), 0);
  assert.equal(wb.biliBudgetState(root, { budget: { dailyCNY: 0.8 } }).blocked, false);
});

test('账本坏了 → 当作没花（不能因为读不到钱就整晚不醒）', () => {
  const file = path.join(root, 'stellar', 'token-usage-daily.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(wb.biliSpendToday(root), 0);
  assert.equal(wb.biliBudgetState(root, { budget: { dailyCNY: 0.01 } }).blocked, false);
});

test('dailyCNY=0 → 金额闸整个关掉', () => {
  const today = new Date().toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(root, 'stellar', 'token-usage-daily.json'), JSON.stringify({ day: today, bili: { cost: 99 } }), 'utf8');
  assert.equal(wb.biliBudgetState(root, { budget: { dailyCNY: 0 } }).blocked, false);
});

test('预算提示行：两项都开 → 两句话都在', () => {
  const line = wb.budgetPromptLine({ wake: { maxCallsPerTurn: 12 }, budget: { dailyCNY: 0.8 } }, { spent: 0.35 });
  assert.match(line, /【本次预算】/);
  assert.match(line, /12 次工具调用/);
  assert.match(line, /¥0\.35 \/ 上限 ¥0\.80/);
});

test('预算提示行：两项都关 → 空串（别占地方）', () => {
  assert.equal(wb.budgetPromptLine({ wake: { maxCallsPerTurn: 0 }, budget: { dailyCNY: 0 } }, { spent: 1 }), '');
});

test('预算提示行：没有账本时不写金额那半句', () => {
  const line = wb.budgetPromptLine({ wake: { maxCallsPerTurn: 8 }, budget: { dailyCNY: 1 } }, { spent: null });
  assert.match(line, /8 次工具调用/);
  assert.equal(/已花/.test(line), false);
});
