#!/usr/bin/env node
/**
 * town-guard 单元测试：小镇超支熔断（判据 / 记录 / 告警去重 / 横幅）。
 * 跑法：node scripts/test-town-guard.mjs
 *
 * 注意：这里不只是读源码做静态断言，而是**真的调用**每个导出函数（PITFALLS #280）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GUARD_DEFAULTS, guardConfig, parseYuan, spendingTotals, evaluateGuard,
  guardFilePath, emptyGuard, readGuard, writeGuard, buildGuardRecord, guardBanner, shouldAlert,
} from '../src/town-guard.js';

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const bad = (name, err) => { fail++; console.log('  ✗ ' + name + ' → ' + (err && err.message)); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'town-guard-'));

// /spending 的真实形状（金额都是字符串，2026-11-21 实测）
const spend = (today, d7, d30, total) => ({ fish_id: 'x', currency: 'CNY', today: String(today), d7: String(d7), d30: String(d30), total: String(total), by_kind: {}, as_of: 1 });

console.log('\n— 警戒线配置 —');

await check('默认：开、日 ¥1.5、周 ¥6、超了停鱼', () => {
  const c = guardConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.dailyCNY, 1.5);
  assert.equal(c.weeklyCNY, 6);
  assert.equal(c.action, 'pause-fish');
  assert.equal(GUARD_DEFAULTS.dailyCNY, 1.5, '默认值别偷偷改小');
});

await check('可以改数，也可以关掉', () => {
  const c = guardConfig({ guard: { dailyCNY: 2.5, weeklyCNY: 9, enabled: false } });
  assert.equal(c.dailyCNY, 2.5);
  assert.equal(c.weeklyCNY, 9);
  assert.equal(c.enabled, false);
});

await check('坏值回落默认（不会静默变成不限）', () => {
  for (const badv of ['abc', null, undefined, -3, NaN]) {
    const c = guardConfig({ guard: { dailyCNY: badv } });
    assert.equal(c.dailyCNY, 1.5, '输入 ' + String(badv));
  }
});

await check('action 只认 alert / off / pause-fish', () => {
  assert.equal(guardConfig({ guard: { action: 'alert' } }).action, 'alert');
  assert.equal(guardConfig({ guard: { action: 'nonsense' } }).action, 'pause-fish');
});

console.log('\n— 金额解析 —');

await check('小镇的字符串金额能读成数字', () => {
  assert.equal(parseYuan('0.12'), 0.12);
  assert.equal(parseYuan('12'), 12);
  assert.equal(parseYuan('¥0.04'), 0.04);
  assert.equal(parseYuan(''), 0);
  assert.equal(parseYuan(null), 0);
  assert.equal(parseYuan('-1'), 0, '负数当 0');
});

await check('spendingTotals 缺字段当 0，不抛', () => {
  assert.deepEqual(spendingTotals(spend(0.12, 0.5, 1, 2)), { today: 0.12, d7: 0.5, d30: 1, total: 2 });
  assert.deepEqual(spendingTotals(null), { today: 0, d7: 0, d30: 0, total: 0 });
  assert.deepEqual(spendingTotals({ today: 'oops' }), { today: 0, d7: 0, d30: 0, total: 0 });
});

console.log('\n— 判定 —');

await check('没到线 → ok', () => {
  const v = evaluateGuard({ spending: spend(0.12, 0.5, 1, 2) });
  assert.equal(v.ok, true);
  assert.equal(v.code, 'ok');
  assert.equal(v.today, 0.12);
});

await check('今天超了 → daily，带上线与原因', () => {
  const v = evaluateGuard({ spending: spend(1.7, 2, 3, 4) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'daily');
  assert.equal(v.cap, 1.5);
  assert.equal(v.action, 'pause-fish');
  assert.match(v.reason, /今天在小镇花了 ¥1\.70/);
});

await check('周线也能单独触发', () => {
  const v = evaluateGuard({ spending: spend(0.2, 6.4, 6.4, 6.4) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'weekly');
  assert.equal(v.cap, 6);
  assert.match(v.reason, /近 7 天/);
});

await check('日线优先于周线（先说今天）', () => {
  const v = evaluateGuard({ spending: spend(2, 9, 9, 9) });
  assert.equal(v.code, 'daily');
});

await check('恰好等于警戒线也算超（>=，不是 >）', () => {
  assert.equal(evaluateGuard({ spending: spend(1.5, 0, 0, 1.5) }).ok, false);
});

await check('关掉之后一律 ok（code=off）', () => {
  const v = evaluateGuard({ spending: spend(99, 99, 99, 99), config: { guard: { enabled: false } } });
  assert.equal(v.ok, true);
  assert.equal(v.code, 'off');
});

await check('action=alert 时判定照旧，只是不暂停（由调用方决定）', () => {
  const v = evaluateGuard({ spending: spend(2, 2, 2, 2), config: { guard: { action: 'alert' } } });
  assert.equal(v.ok, false);
  assert.equal(v.action, 'alert');
});

await check('罚款线为 0 = 这一档不设限', () => {
  const v = evaluateGuard({ spending: spend(5, 0, 0, 5), config: { guard: { dailyCNY: 0 } } });
  assert.equal(v.ok, true);
});

console.log('\n— 记录与横幅 —');

await check('路径落在 state/town/guard.json', () => {
  const p = guardFilePath('C:/x/state/town');
  assert.match(p.replace(/\\/g, '/'), /state\/town\/guard\.json$/);
  assert.equal(guardFilePath(''), '');
});

await check('空记录不带告警', () => {
  const e = emptyGuard();
  assert.equal(e.paused, false);
  assert.equal(guardBanner(e), '');
});

await check('写进去能读回来（原子写）', () => {
  const file = path.join(TMP, 'guard.json');
  const rec = buildGuardRecord({ verdict: evaluateGuard({ spending: spend(2, 2, 2, 2) }), day: '2026-11-21', fishId: 'whale', paused: true });
  const w = writeGuard(file, rec);
  assert.equal(w.ok, true);
  assert.equal(fs.existsSync(file), true);
  const back = readGuard(file);
  assert.equal(back.paused, true);
  assert.equal(back.code, 'daily');
  assert.equal(back.day, '2026-11-21');
  assert.equal(back.fishId, 'whale');
  assert.match(back.banner, /超支熔断/);
  assert.match(back.banner, /重新打开/);
});

await check('文件不存在 / 坏 JSON → 当没告警（不把她永久关在外面）', () => {
  assert.equal(readGuard(path.join(TMP, 'nope.json')).paused, false);
  const badfile = path.join(TMP, 'broken.json');
  fs.writeFileSync(badfile, '{ not json', 'utf8');
  assert.equal(readGuard(badfile).paused, false);
});

await check('action=alert 时横幅说「没停她」', () => {
  const rec = buildGuardRecord({ verdict: evaluateGuard({ spending: spend(2, 2, 2, 2), config: { guard: { action: 'alert' } } }), day: '2026-11-21', paused: false });
  assert.equal(rec.paused, false);
  assert.match(rec.banner, /没有停她/);
});

await check('没超时记录里没有横幅', () => {
  const rec = buildGuardRecord({ verdict: evaluateGuard({ spending: spend(0.1, 0.1, 0.1, 0.1) }), day: '2026-11-21' });
  assert.equal(rec.banner, '');
  assert.equal(rec.reason, '');
});

await check('告警去重：同一天同一个 code 只记一次', () => {
  const a = { day: '2026-11-21', code: 'daily' };
  assert.equal(shouldAlert(null, a), true, '第一次要记');
  assert.equal(shouldAlert(a, { day: '2026-11-21', code: 'daily' }), false, '同一天同因不重复');
  assert.equal(shouldAlert(a, { day: '2026-11-22', code: 'daily' }), true, '换天要记');
  assert.equal(shouldAlert(a, { day: '2026-11-21', code: 'weekly' }), true, '换原因要记');
  assert.equal(shouldAlert({ day: '2026-11-21', code: 'ok' }, a), true, '上一次是 ok 要记');
});

await check('畸形输入不抛', () => {
  assert.equal(evaluateGuard().ok, true);
  assert.equal(evaluateGuard({ spending: 'x', config: 'y' }).ok, true);
  assert.equal(guardBanner(null), '');
  assert.equal(guardBanner({ code: 'weekly' }), '');
  assert.equal(shouldAlert(null, null), false, '没有新记录就没有告警');
  assert.equal(shouldAlert({}, {}), false, '空记录不算告警');
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (fail ? '❌ 失败 ' + fail : '🎉 小镇熔断：' + pass + ' 项通过'));
process.exit(fail ? 1 : 0);
