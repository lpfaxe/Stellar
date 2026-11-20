#!/usr/bin/env node
/**
 * 群聊续聊唤醒（src/wake-followup.js）的回归。
 *
 * 钉住四件事：
 *   ① 冷场（她很久没说话）不续聊 —— 否则群里没人搭理她时也会一直冒头；
 *   ② 窗口内按概率，注随机源后可确定断言；
 *   ③ 大群、probability=0（她明确要求别主动接话）一律不续聊；
 *   ④ 参数缺省用默认值，别让 config 少写一个字段就变成 0 概率。
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_FOLLOWUP_PROBABILITY,
  DEFAULT_FOLLOWUP_WINDOW_MS,
  followupSettings,
  shouldFollowupWake,
  shouldChimeIn,
  chimeSettings,
  DEFAULT_CHIME_PROBABILITY,
  DEFAULT_CHIME_MIN_GAP_MS,
  DEFAULT_SMALL_GROUP_MAX,
} from '../src/wake-followup.js';

const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);
const base = { kind: 'group', large: false, probability: 0.05, now: NOW, wakeCfg: {} };

// ① 她 5 分钟前说过话 → 窗口内，按注入的随机源判定
assert.equal(shouldFollowupWake({ ...base, lastReplyAt: NOW - 5 * 60 * 1000, random: () => 0.1 }), true);
assert.equal(shouldFollowupWake({ ...base, lastReplyAt: NOW - 5 * 60 * 1000, random: () => 0.99 }), false);

// ② 冷场：超过 10 分钟没说话就不续聊
assert.equal(shouldFollowupWake({ ...base, lastReplyAt: NOW - 11 * 60 * 1000, random: () => 0.01 }), false);
// 从没说过话
assert.equal(shouldFollowupWake({ ...base, lastReplyAt: 0, random: () => 0.01 }), false);

// ③ 大群 / 概率被关掉 / 私聊
assert.equal(shouldFollowupWake({ ...base, large: true, lastReplyAt: NOW - 1000, random: () => 0.01 }), false);
assert.equal(shouldFollowupWake({ ...base, probability: 0, lastReplyAt: NOW - 1000, random: () => 0.01 }), false);
assert.equal(shouldFollowupWake({ ...base, kind: 'private', lastReplyAt: NOW - 1000, random: () => 0.01 }), false);

// ④ 参数缺省与覆盖
const def = followupSettings({});
assert.equal(def.probability, DEFAULT_FOLLOWUP_PROBABILITY);
assert.equal(def.windowMs, DEFAULT_FOLLOWUP_WINDOW_MS);
const custom = followupSettings({ groupFollowupProbability: 0.2, groupFollowupWindowMs: 60000 });
assert.equal(custom.probability, 0.2);
assert.equal(custom.windowMs, 60000);
// 窗口可按配置收窄：2 分钟前说过话，窗口 60 秒 → 不续聊
assert.equal(
  shouldFollowupWake({ ...base, wakeCfg: { groupFollowupWindowMs: 60000 }, lastReplyAt: NOW - 120000, random: () => 0.01 }),
  false
);
// 概率超出 [0,1] 时夹住，不会因为写了 2 就必然触发
assert.equal(followupSettings({ groupFollowupProbability: 2 }).probability, 1);
assert.equal(followupSettings({ groupFollowupProbability: -1 }).probability, 0);


// ⑤ 小群插话：不要求她刚说过话，但要求群小 + 距上次唤醒够久
const chimeBase = { kind: 'group', large: false, memberCount: 3, lastWakeAt: 0, now: NOW, wakeCfg: {} };
assert.equal(shouldChimeIn({ ...chimeBase, random: () => 0.1 }), true);
// 距上次唤醒不到 2 分钟 → 不插话（防一个热闹群把她叫醒十几次）
assert.equal(shouldChimeIn({ ...chimeBase, lastWakeAt: NOW - 30 * 1000, random: () => 0.01 }), false);
assert.equal(shouldChimeIn({ ...chimeBase, lastWakeAt: NOW - DEFAULT_CHIME_MIN_GAP_MS - 1000, random: () => 0.01 }), true);
// 大群 / 人多的群 / 私聊都不插话
assert.equal(shouldChimeIn({ ...chimeBase, large: true, random: () => 0.01 }), false);
assert.equal(shouldChimeIn({ ...chimeBase, memberCount: DEFAULT_SMALL_GROUP_MAX + 1, random: () => 0.01 }), false);
assert.equal(shouldChimeIn({ ...chimeBase, kind: 'private', random: () => 0.01 }), false);
// 群人数未知（刚拉进去还没拿到群信息）按小群处理
assert.equal(shouldChimeIn({ ...chimeBase, memberCount: 0, random: () => 0.01 }), true);
// 参数缺省与覆盖
const chimeDef = chimeSettings({});
assert.equal(chimeDef.probability, DEFAULT_CHIME_PROBABILITY);
assert.equal(chimeDef.minGapMs, DEFAULT_CHIME_MIN_GAP_MS);
assert.equal(chimeDef.maxMembers, DEFAULT_SMALL_GROUP_MAX);
assert.equal(chimeSettings({ groupChimeProbability: 0 }).probability, 0);
assert.equal(shouldChimeIn({ ...chimeBase, wakeCfg: { groupChimeProbability: 0 }, random: () => 0.01 }), false);

console.log('wake-followup tests OK');
