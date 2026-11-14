import assert from 'node:assert/strict';
import { createEmptyCard, applyTierRetention, normalizeMemoryCardConfig } from '../src/memory-card.js';

function rec(id, opts = {}) {
  const o = Object.assign({ tier: 'L3', tierAt: '2026-11-10', createdAt: '2026-11-10T10:00:00+08:00', importance: 10, pinned: false, recallCount: 0 }, opts);
  return { id, text: 't', title: 't', tier: o.tier, tierAt: o.tierAt, createdAt: o.createdAt, importance: o.importance, pinned: o.pinned, anchor: o.pinned, clarity: 'clear', tags: [], recallCount: o.recallCount, lastSeenAt: o.createdAt };
}
function cardWith(records) {
  const card = createEmptyCard(Date.parse('2026-11-10T23:30:00+08:00'));
  card.records = records;
  return card;
}
const NOW = Date.parse('2026-11-10T23:30:00+08:00');
const cfg = normalizeMemoryCardConfig({});

// 1) L3 当天结束就删（连当天建的也删）；l3Days=1 时才活到第二天
{
  const card = cardWith([
    rec('today', { tierAt: '2026-11-10' }),
    rec('yday', { tierAt: '2026-11-09', createdAt: '2026-11-09T10:00:00+08:00' }),
  ]);
  assert.equal(applyTierRetention(card, cfg, NOW), 2);
  assert.equal(card.records.length, 0);

  const keepOne = cardWith([
    rec('today', { tierAt: '2026-11-10' }),
    rec('yday', { tierAt: '2026-11-09', createdAt: '2026-11-09T10:00:00+08:00' }),
  ]);
  assert.equal(applyTierRetention(keepOne, { ...cfg, tierRetention: { ...cfg.tierRetention, l3Days: 1 } }, NOW), 1);
  assert.deepEqual(keepOne.records.map((r) => r.id), ['today']);
}

// 2) L2：两天留、三天删
{
  const card = cardWith([
    rec('d2', { tier: 'L2', tierAt: '2026-11-08', createdAt: '2026-11-08T10:00:00+08:00' }),
    rec('d3', { tier: 'L2', tierAt: '2026-11-07', createdAt: '2026-11-07T10:00:00+08:00' }),
  ]);
  assert.equal(applyTierRetention(card, cfg, NOW), 1);
  assert.deepEqual(card.records.map((r) => r.id), ['d2']);
}

// 3) L1 永远不动
{
  const card = cardWith([rec('l1', { tier: 'L1', tierAt: '2026-10-01', createdAt: '2026-10-01T10:00:00+08:00' })]);
  assert.equal(applyTierRetention(card, cfg, NOW), 0);
  assert.equal(card.records.length, 1);
}

// 4) 钉住的 L3 不删
{
  const card = cardWith([rec('pin', { tierAt: '2026-11-01', createdAt: '2026-11-01T10:00:00+08:00', pinned: true })]);
  assert.equal(applyTierRetention(card, cfg, NOW), 0);
}

// 5) 没到点不跑
{
  const card = cardWith([rec('yday', { tierAt: '2026-11-09', createdAt: '2026-11-09T10:00:00+08:00' })]);
  assert.equal(applyTierRetention(card, cfg, Date.parse('2026-11-10T20:00:00+08:00')), 0);
  assert.equal(card.records.length, 1);
}

// 6) 同一天只跑一次
{
  const card = cardWith([rec('yday', { tierAt: '2026-11-09', createdAt: '2026-11-09T10:00:00+08:00' })]);
  assert.equal(applyTierRetention(card, cfg, NOW), 1);
  card.records.push(rec('late', { tierAt: '2026-11-09', createdAt: '2026-11-09T12:00:00+08:00' }));
  assert.equal(applyTierRetention(card, cfg, NOW + 60000), 0);
  assert.equal(card.records.length, 1);
}

// 7) 老记录没有 tier：先补层级；L3 的保留期 0 天，同一晚就删
{
  const card = cardWith([rec('legacy', { tier: '', tierAt: '', createdAt: '2026-01-01T10:00:00+08:00', importance: 5 })]);
  assert.equal(applyTierRetention(card, cfg, NOW), 1);
  assert.equal(card.records.length, 0);

  // L2 的老记录只补字段、当晚留着（ageDays=0 < 3）
  const l2card = cardWith([rec('legacyL2', { tier: '', tierAt: '', createdAt: '2026-01-01T10:00:00+08:00', importance: 55 })]);
  assert.equal(applyTierRetention(l2card, cfg, NOW), 0);
  assert.equal(l2card.records[0].tier, 'L2');
  assert.equal(l2card.records[0].tierAt, '2026-11-10');
}

// 8) 召回三次：升到 L1 并重置计时
{
  const card = cardWith([rec('hot', { tierAt: '2026-11-08', createdAt: '2026-11-08T10:00:00+08:00', recallCount: 3 })]);
  assert.equal(applyTierRetention(card, cfg, NOW), 0);
  assert.equal(card.records[0].tier, 'L1');
  assert.equal(card.records[0].tierAt, '2026-11-10');
}

// 9) 开关关掉就什么都不做
{
  const card = cardWith([rec('yday', { tierAt: '2026-11-09', createdAt: '2026-11-09T10:00:00+08:00' })]);
  assert.equal(applyTierRetention(card, { tierRetention: { enabled: false } }, NOW), 0);
  assert.equal(card.records.length, 1);
}

// 10) 存量老记录：第一晚 L3 就清掉，L2 三天后才清
{
  const card = cardWith([
    rec('legacy1', { tier: '', tierAt: '', createdAt: '2026-10-01T10:00:00+08:00', importance: 5 }),
    rec('legacy2', { tier: '', tierAt: '', createdAt: '2026-10-02T10:00:00+08:00', importance: 55 }),
  ]);
  assert.equal(applyTierRetention(card, cfg, NOW), 1);
  assert.deepEqual(card.records.map((r) => r.id), ['legacy2']);
  // 第三天晚上（11-13）才轮到 L2
  assert.equal(applyTierRetention(card, cfg, Date.parse('2026-11-12T23:30:00+08:00')), 0);
  assert.equal(applyTierRetention(card, cfg, Date.parse('2026-11-13T23:30:00+08:00')), 1);
  assert.equal(card.records.length, 0);
}

console.log('tier retention tests OK (10 cases)');
