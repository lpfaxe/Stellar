// 生物钟 C 模式：每窗至少 1 次、全天 ≤12、相邻至少 minGap、额外按质量分配。
// 纯逻辑；不读写真实状态、不叫醒。
import assert from 'node:assert/strict';
import {
  normalizeNightWindows, buildNightSchedule, nextPendingSlot, markScheduleSlot,
  qualityByWindow, minToHHMM, shouldWaitPendingSlot,
} from '../plugins/stellar/tools/lib/night-schedule.mjs';

const windows = [
  { start: '06:00', end: '08:00', wakes: 3 },
  { start: '10:00', end: '12:00', wakes: 3 },
  { start: '14:00', end: '16:00', wakes: 3 },
  { start: '18:00', end: '19:00', wakes: 3 },
  { start: '19:00', end: '20:00', wakes: 3 },
  { start: '20:00', end: '21:00', wakes: 3 },
  { start: '21:00', end: '22:00', wakes: 3 },
  { start: '22:00', end: '23:00', wakes: 3 },
  { start: '23:00', end: '24:00', wakes: 3 },
];

assert.equal(minToHHMM(630), '10:30');
assert.equal(normalizeNightWindows([{ start: '22:00', end: '02:00', wakes: 1 }])[0].wrap, true);

const built = buildNightSchedule({
  windows, maxWakes: 12, minGapMin: 20, skipChance: 0, nowMin: 0,
  quality: {}, random: () => 0.5,
});
assert.equal(built.slots.length, 12, '全天最多 12 次');
assert.equal(built.baseCount, 9, '9 个窗口至少 1 次');
assert.equal(built.extraCount, 3, '剩余 3 次加餐');
assert.equal(new Set(built.slots.map((s) => s.window)).size, 9, '每个窗口都要覆盖');
for (let i = 1; i < built.slots.length; i += 1) {
  assert.ok(built.slots[i].at - built.slots[i - 1].at >= 20, `相邻两次至少 20 分钟：${built.slots[i - 1].atText} → ${built.slots[i].atText}`);
}
// 每个窗口的 base 都在自己的 [start,end) 内
for (const slot of built.slots) {
  assert.ok(slot.at >= slot.start && slot.at < slot.end, `${slot.window} ${slot.atText} 越界`);
}

// 质量优先：10–12 时段历史分最高 → 它的加餐名额应该最多
const q = { '10:00–12:00': 18 };
const qualityBuilt = buildNightSchedule({
  windows, maxWakes: 12, minGapMin: 20, skipChance: 0, nowMin: 0,
  quality: q, random: () => 0.5,
});
const ten = qualityBuilt.slots.filter((s) => s.window === '10:00–12:00');
assert.equal(ten.length, 3, '高评分窗口应拿满 3 次');
assert.ok(qualityBuilt.slots.filter((s) => s.kind === 'extra').some((s) => s.window === '10:00–12:00'));

// skip 是“轻醒”，不结束全天；每个 base 仍然存在
const skipped = buildNightSchedule({
  windows, maxWakes: 12, minGapMin: 20, skipChance: 1, nowMin: 0,
  quality: {}, random: () => 0.5,
});
assert.ok(skipped.slots.every((s) => s.action === 'skip'));
assert.equal(new Set(skipped.slots.map((s) => s.window)).size, 9);

// 过期 slot → missed；窗口内已过点 → 改成现在叫醒
const schedule = {
  slots: [
    { id: 'a', window: 'w', start: 100, end: 120, at: 110, atText: '01:50', status: 'pending', action: 'wake' },
    { id: 'b', window: 'w2', start: 200, end: 220, at: 210, atText: '03:30', status: 'pending', action: 'wake' },
  ],
};
const early = nextPendingSlot(schedule, 115);
assert.equal(early.id, 'a');
assert.equal(early.late, true);
assert.equal(early.at, 116);
const afterA = nextPendingSlot(schedule, 130);
assert.equal(afterA.id, 'b');
const missed = nextPendingSlot(schedule, 300);
assert.equal(missed, null);
assert.equal(schedule.slots[1].status, 'missed');
markScheduleSlot(schedule, 'a', 'fired', 116);
assert.equal(schedule.slots[0].status, 'fired');

// 质量聚合：只算窗口内、最近 30 天
const scores = {
  '2026-10-23': [
    { at: '2026-10-23T10:30:00+08:00', score: 16 },
    { at: '2026-10-23T10:45:00+08:00', score: 18 },
    { at: '2026-10-23T18:30:00+08:00', score: 10 },
  ],
  '2026-01-01': [{ at: '2026-01-01T10:30:00+08:00', score: 20 }],
};
const qq = qualityByWindow(scores, normalizeNightWindows(windows), {
  now: new Date('2026-10-23T12:00:00+08:00').getTime(), days: 30,
});
assert.equal(qq['10:00–12:00'], 17);
assert.equal(qq['18:00–19:00'], 10);
assert.equal(qq['20:00–21:00'], undefined);

// 峰时守卫：落在峰时的点往后顺到谷期；整窗在峰时则跳过这一趟（2026-11-09 周一：9–12、14–18 峰时）
const peakMinute = (m) => {
  const mm = ((m % 1440) + 1440) % 1440;
  return (mm >= 540 && mm < 720) || (mm >= 840 && mm < 1080);
};
const cheapWindows = [
  { start: '06:00', end: '09:00', wakes: 1 },
  { start: '12:00', end: '14:00', wakes: 1 },
  { start: '18:00', end: '21:00', wakes: 2 },
];
const guarded = buildNightSchedule({
  windows: cheapWindows, maxWakes: 6, minGapMin: 30, skipChance: 0, nowMin: 0,
  quality: {}, isPeakMinute: peakMinute, random: () => 0.5,
});
assert.equal(guarded.slots.length, 4, '谷期窗口照样排满');
for (const slot of guarded.slots) {
  assert.ok(!peakMinute(slot.at), '不该排在峰时：' + slot.atText);
}
const allPeak = buildNightSchedule({
  windows: [{ start: '14:00', end: '18:00', wakes: 2 }], maxWakes: 2, minGapMin: 30, skipChance: 0, nowMin: 0,
  quality: {}, isPeakMinute: peakMinute, random: () => 0.5,
});
assert.equal(allPeak.slots.length, 0, '整窗在峰时就不叫醒');
assert.ok(allPeak.warnings.some((w) => w.includes('峰时')), '要说明为什么没排');
// 跨午夜的谷期窗口：21:00–00:30 的 00:1x 属于第二天凌晨（谷期）
const midnight = buildNightSchedule({
  windows: [{ start: '23:00', end: '23:30', wakes: 1 }], maxWakes: 1, minGapMin: 10, skipChance: 0, nowMin: 0,
  quality: {}, isPeakMinute: peakMinute, random: () => 0.999,
});
assert.equal(midnight.slots.length, 1);
console.log('night schedule tests OK');
// ── 2026-11-11 回归：别把「今天已经醒过」当成「该重算下一趟」────────────────
// 线上真实故障：woke=true 且当前 slot 还没投递时，每个 tick 都调 night plan，
// plan 里的 nextPendingSlot 会把「已过点但还在窗口内」的 slot 改成 now+1，
// tick 每分钟跑一次 → 时间点一直往后挪，整晚一次没醒。
const TODAY = '2026-11-11';
const pendingState = () => ({ date: TODAY, action: 'wake', woke: true, fired: false, slotId: 's5', at: 1410, endAt: 1470 });

assert.equal(shouldWaitPendingSlot(pendingState(), TODAY, 1400), true, '还没到点：等它，别重算');
assert.equal(shouldWaitPendingSlot(pendingState(), TODAY, 1410), false, '到点了：必须放行去叫醒（否则永远醒不了）');
assert.equal(shouldWaitPendingSlot(pendingState(), TODAY, 1425), false, '已经过点：放行');
assert.equal(shouldWaitPendingSlot({ ...pendingState(), fired: true }, TODAY, 1400), false, '这一趟已经投递过：可以去算下一趟');
assert.equal(shouldWaitPendingSlot({ ...pendingState(), woke: false }, TODAY, 1400), false, '今天还没醒过：照旧重算');
assert.equal(shouldWaitPendingSlot({ ...pendingState(), date: '2026-11-10' }, TODAY, 1400), false, '跨天：照旧重算');
assert.equal(shouldWaitPendingSlot({ ...pendingState(), action: 'skip' }, TODAY, 1400), false, '轻醒那趟走自己的分支');
assert.equal(shouldWaitPendingSlot({ ...pendingState(), at: undefined }, TODAY, 1400), false, '没有 at：不阻塞');
assert.equal(shouldWaitPendingSlot(null, TODAY, 1400), false, '没状态：重算');

// 模拟 tick：到点之前时间点不许前移、也不许把叫醒挡掉
{
  const st = pendingState();
  const atBefore = st.at;
  let replans = 0;
  let fired = false;
  for (let now = 1395; now < 1415; now += 1) {
    if (shouldWaitPendingSlot(st, TODAY, now)) continue;
    if (now >= st.at) { fired = true; break; }
    replans += 1;
    st.at = now + 2;
  }
  assert.equal(replans, 0, '到点之前一次都不该重算（真实故障里这里重算了 7 次）');
  assert.equal(st.at, atBefore, '时间点不该被往前推');
  assert.equal(fired, true, '到点后必须真的走去叫醒，而不是被等待条件吃掉');
}
