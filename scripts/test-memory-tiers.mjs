/**
 * 分层记忆 + 状态机的最小回归（node scripts/test-memory-tiers.mjs）。
 * 不碰真实记忆卡：全部在临时目录里跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import {
  cycleKey, cycleStart, normalizeTierConfig, planTierMaintenance, rankMemories, renderRecallBlock, tierOfRecord,
} from '../src/memory-tiers.js';
import { createAgentState } from '../src/agent-state.js';
import { runTierMaintenance, recallBlockForPrompt, storePaths, loadCardForRead, saveCard as saveStoreCard } from '../src/memory-store.js';
import { createEmptyCard } from '../src/memory-card.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-tiers-'));
const now = Date.now();
const day = 24 * 60 * 60 * 1000;

function rec(id, over = {}) {
  return {
    id,
    kind: 'owner',
    title: '',
    text: '',
    importance: 50,
    createdAt: new Date(now).toISOString(),
    ...over,
  };
}

// 1) 检索闸门：只有「最近聊过」没有词面相关性时不该注入
const records = [
  rec('coffee', { text: '主人喜欢喝冰美式', importance: 80, tier: 'L1' }),
  rec('noise', { text: '你能明白我在做什么吗', importance: 90, tier: 'L1' }),
  rec('video', { text: '主人说这个视频好看，让我抽帧看看', importance: 60, tier: 'L2' }),
];
const hits = rankMemories({ records, query: '我喜欢喝什么', key: '' });
assert.ok(hits.length >= 1, 'coffee 应命中');
assert.strictEqual(hits[0].record.id, 'coffee');
assert.ok(!hits.some((hit) => hit.record.id === 'noise'), '虚词撞车的噪声不该命中');
assert.ok(renderRecallBlock(hits).includes('id coffee'));

// 2) 层级：新记录不在本周期被清空；旧 L3 清空后压成摘要
const weekAgo = new Date(now - 8 * day).toISOString();
const planNew = planTierMaintenance({ records: [rec('fresh', { tier: 'L3' })], now });
assert.strictEqual(planNew.clear.length, 0, '本周期新建的记录不该被清');
const planOld = planTierMaintenance({ records: [rec('old', { tier: 'L3', createdAt: weekAgo })], now });
assert.strictEqual(planOld.clear.length, 1);

// 3) 清空 + 归档 + digest（真文件、带锁）
const paths = storePaths(dir);
const card = createEmptyCard(now);
card.records = [
  rec('old-l3', { tier: 'L3', createdAt: weekAgo, text: '上周三在群里提过一句想学吉他' }),
  rec('keep-l1', { tier: 'L1', text: '主人喜欢喝冰美式', importance: 90 }),
];
saveStoreCard(dir, card, { now });
const result = await runTierMaintenance({ memoryDir: dir, now });
assert.ok(result.cleared.some((item) => item.id === 'old-l3'), '旧 L3 应被清空');
assert.ok(result.digest && result.digest.text, '应生成当日摘要');
const after = loadCardForRead(dir);
assert.ok(!after.records.some((item) => item.id === 'old-l3'), '清空的记录不应留在卡里');
assert.ok(after.records.some((item) => item.id === 'keep-l1'), 'L1 记录必须保留');
const archived = fs.readFileSync(paths.fullJsonl, 'utf8');
assert.ok(archived.includes('old-l3'), '清空前必须先进全量存档');
const recall = recallBlockForPrompt({ memoryDir: dir, key: '', query: '我喜欢喝什么' });
assert.ok(recall.block.includes('冰美式'), '检索应能命中 L1 偏好');

// 4) 状态机：幂等 + 8 分钟空闲进 SLEEP + 再收到消息回 ACTIVE
const stateFile = path.join(dir, 'agent-state.json');
const agent = createAgentState({ file: stateFile, idleMs: 8 * 60 * 1000, now: () => now });
assert.strictEqual(agent.claim('private:1', 'm-1'), true);
assert.strictEqual(agent.claim('private:1', 'm-1'), false, '同一条消息只能认领一次');
agent.touch('private:1');
assert.strictEqual(agent.status().conversations[0].state, 'ACTIVE');
agent.endTurn('private:1');
assert.strictEqual(agent.status().conversations[0].state, 'COOLDOWN');
agent.flush();

const later = createAgentState({ file: stateFile, idleMs: 8 * 60 * 1000, now: () => now + 9 * 60 * 1000 });
later.sweep();
const swept = later.status().conversations.find((item) => item.key === 'private:1');
assert.strictEqual(swept.state, 'SLEEP', '8 分钟无对话应进 SLEEP');

later.stop();

// 5) 周期键
assert.ok(cycleKey('L3', now).startsWith('d:'));
assert.ok(cycleKey('L2', now).startsWith('e:'), 'L2 周期键改成每 N 天窗口（2026-11-11 主人要求三天一清）');
// 3 天窗口：同一窗口内相邻两天必须是同一个键，跨过窗口才换键
const dayMs = 24 * 60 * 60 * 1000;
const winStart = cycleStart('L2', now);
const keys = [0, 1, 2].map((i) => cycleKey('L2', winStart + i * dayMs));
assert.strictEqual(new Set(keys).size, 1, '同一个 3 天窗口内周期键必须一致');
assert.notStrictEqual(cycleKey('L2', winStart), cycleKey('L2', winStart + 3 * dayMs), '第 4 天必须换窗口');
const t0 = winStart;
assert.notStrictEqual(cycleKey('L2', t0), cycleKey('L2', t0 + 7 * dayMs), '跨窗口必须换键');
assert.strictEqual(normalizeTierConfig({}).l2Days, 3, 'L2 默认三天');
assert.strictEqual(cycleStart('L2', t0) <= t0, true, 'L2 周期起点不能晚于当前时间');
assert.strictEqual(tierOfRecord(rec('x', { pinned: true })), 'L1');

fs.rmSync(dir, { recursive: true, force: true });
console.log('memory tiers + agent state tests OK');
