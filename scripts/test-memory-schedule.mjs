/**
 * 记忆库定时点的回归：复核窗口 / 侧写时间必须能被 config.json 的 memory 段覆盖。
 *
 * 为什么单列一条：这台机器 0 点后断电断网、早上 6 点才恢复供电，
 * 原来写死的 00:05 复核等于永远不跑。窗口判定一旦退回硬编码，
 * 面板改时间也不生效，而且不会报错——只会安静地永远不执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-sched-'));
process.env.DSH_HOME = root;
const memoryDir = path.join(root, 'stellar', 'characters', 'deepseek', 'memory');
fs.mkdirSync(memoryDir, { recursive: true });
fs.writeFileSync(path.join(root, 'stellar', 'characters', 'current.json'), JSON.stringify({ id: 'deepseek' }), 'utf8');

const db = await import('../src/memory-db.js');
const worker = await import('../src/memory-worker.js');
const timer = await import('../plugins/stellar/lib/memory-db-timer.js');

const at = (iso) => Date.parse(iso);

test.after(() => {
  try { db.closeDb(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('默认未到 06:30 不跑复核', () => {
  const r = worker.windowDue({ now: at('2026-11-13T06:29:00') });
  assert.equal(r.due, false);
  assert.equal(r.reason, 'too-early');
});

test('默认 06:30 到点就跑复核', () => {
  const r = worker.windowDue({ now: at('2026-11-13T06:30:00') });
  assert.equal(r.due, true);
  assert.equal(r.targetDay, '2026-11-10');   // D-3：2026-11-22 主人把 daily 话题保留期改成 3 天
});

test('window.days 覆盖默认保留天数（配 2 就回 D-2）', () => {
  assert.equal(worker.windowDue({ now: at('2026-11-13T06:30:00'), window: { days: 2 } }).targetDay, '2026-11-11');
  assert.equal(worker.windowDue({ now: at('2026-11-13T06:30:00'), window: { days: 3 } }).targetDay, '2026-11-10');
  assert.equal(worker.windowDue({ now: at('2026-11-13T06:30:00'), window: { days: 99 } }).targetDay, '2026-11-10'); // 越界回落 3
});

test('config 覆盖窗口：把复核挪到 09:15 后，09:14 仍不跑', () => {
  const win = { hour: 9, minute: 15 };
  assert.equal(worker.windowDue({ now: at('2026-11-13T09:14:00'), window: win }).due, false);
  assert.equal(worker.windowDue({ now: at('2026-11-13T09:15:00'), window: win }).due, true);
});

test('scheduleOf 读 memory.window / memory.profile', () => {
  const s = timer.scheduleOf({ memory: { window: { hour: 6, minute: 30 }, profile: { hour: 7, minute: 5 } } });
  assert.deepEqual(s.window, { hour: 6, minute: 30, days: 3 });   // 默认 3（与 WINDOW_DAYS 同源）
  assert.deepEqual(s.profile, { hour: 7, minute: 5 });
  // config 里显式写 days 就按它来（这台机器目前是 3；想留 2 天就写 2）
  const s2 = timer.scheduleOf({ memory: { window: { hour: 6, minute: 30, days: 2 } } });
  assert.equal(s2.window.days, 2);
});

test('scheduleOf 缺配置时给 06:30 / 07:00 兜底', () => {
  const s = timer.scheduleOf({});
  assert.equal(s.window.hour, 6);
  assert.equal(s.window.minute, 30);
  assert.equal(s.profile.hour, 7);
  assert.equal(s.profile.minute, 0);
});

test('scheduleOf 拒绝越界值（hour 24 / minute 99 都要回到兜底）', () => {
  const s = timer.scheduleOf({ memory: { window: { hour: 24, minute: 99 }, profile: { hour: -1, minute: 61 } } });
  assert.equal(s.window.hour, 6);
  assert.equal(s.window.minute, 30);
  assert.equal(s.profile.hour, 7);
  assert.equal(s.profile.minute, 0);
});
