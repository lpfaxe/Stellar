/**
 * 记忆库 P1：复核（晋升 + 改写 + 清理）与侧写生成的回归。
 *
 * 这些路径要调模型，所以用**假 ask**（返回固定 JSON）驱动 worker，
 * 不碰网络、不花钱；重点是三条硬规则：
 *   1) 复核失败（模型报错 / 返回非 JSON）→ 一条都不删；
 *   2) promote 只能命中当天列出的 id（模型瞎编的 id 一律忽略）；
 *   3) source='manual' 的侧写不被自动覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-review-'));
process.env.DSH_HOME = root;
const memoryDir = path.join(root, 'stellar', 'characters', 'deepseek', 'memory');
fs.mkdirSync(memoryDir, { recursive: true });
fs.writeFileSync(path.join(root, 'stellar', 'characters', 'current.json'), JSON.stringify({ id: 'deepseek' }), 'utf8');

const db = await import('../src/memory-db.js');
const worker = await import('../src/memory-worker.js');

const D1 = '2026-11-11';
const D2 = '2026-11-12';

function add(role, text, at, extra = {}) {
  return db.append({
    conversationKey: extra.key || 'private:111',
    ownerId: extra.ownerId || '111',
    speakerId: role === 'self' ? '1000000002' : (extra.ownerId || '111'),
    speakerName: role === 'self' ? '' : '阿星',
    role,
    kind: 'text',
    text,
    at,
    day: extra.day || D2,
  });
}

test.after(() => {
  try { db.closeDb(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('复核：晋升只认当天列出的 id', async () => {
  const base = Date.parse(D2 + 'T10:00:00');
  add('user', '记住我叫阿星', base);
  add('self', '好，阿星', base + 60000);
  worker.runSplit({});
  const topics = db.listTopicsLite ? [] : null;
  const rows = db.catalog({ ownerId: '111' }).rows;
  assert.ok(rows.length >= 1, '应切出至少一个话题');
  const target = rows[0].id;

  const cand = worker.reviewCandidates({ targetDay: D2 });
  assert.ok(cand.topics.some((t) => t.id === target), '候选里应有该话题');

  const ask = async () => JSON.stringify({
    promote: [target, 'tp_不存在_20261112_0099', '#99999'],
    rewrite: [{ id: target, title: '阿星自报家门', summary: '他让她记住名字' }],
    reason: '称呼',
  });
  const res = await worker.runReview({ targetDay: D2, ask, force: true, log: () => {} });
  assert.equal(res.promoted, 1, '只应晋升一个（不存在的 id 被忽略）');
  assert.deepEqual(res.promotedIds, [target]);
  const row = db.readTopic(target, { full: true }).topic;
  assert.equal(row.tier, 'important');
  assert.equal(row.promote_reason, 'review');
  assert.equal(row.title, '阿星自报家门');
});

test('复核失败：模型不给 JSON 时一条都不删', async () => {
  const base = Date.parse(D1 + 'T09:00:00');
  add('user', '明天考试', base, { ownerId: '222', key: 'private:222', day: D1 });
  add('self', '加油', base + 60000, { ownerId: '222', key: 'private:222', day: D1 });
  worker.runSplit({});
  const before = db.catalog({ ownerId: '222' }).rows.length;
  assert.ok(before >= 1);

  const ask = async () => '我觉得这条挺重要的（不是 JSON）';
  const res = await worker.runReview({ targetDay: D1, ask, force: true, log: () => {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'model-returned-non-json');
  const after = db.catalog({ ownerId: '222' }).rows.length;
  assert.equal(after, before, '解析失败必须整批保留');
});

test('复核：没有模型通道时不删，只记 pending', async () => {
  const res = await worker.runReview({ targetDay: D1, ask: null, force: true, log: () => {} });
  assert.equal(res.skipped, 'model-unavailable');
});

test('侧写：手改过的不被自动覆盖', async () => {
  db.upsertProfile({ ownerId: '111', persona: '我自己写的', source: 'manual' });
  const cands = worker.profileCandidates({});
  assert.equal(cands.some((c) => c.ownerId === '111'), false, 'manual 不应进候选');
  const ask = async () => JSON.stringify({ persona: '自动写的', detail: '', tags: [] });
  await worker.runProfiles({ ask, log: () => {} });
  assert.equal(db.getProfile('111').persona, '我自己写的');
});

test('侧写：自动写会落库并带 edited_by=worker', async () => {
  const base = Date.parse(D2 + 'T11:00:00');
  add('user', '我最喜欢玩原神', base, { ownerId: '333', key: 'private:333' });
  add('self', '又是个二游玩家', base + 60000, { ownerId: '333', key: 'private:333' });
  worker.runSplit({});
  const ask = async () => JSON.stringify({ persona: '二游玩家，说话直接', detail: '喜欢原神', tags: ['游戏'] });
  const res = await worker.runProfiles({ ask, log: () => {} });
  assert.ok(res.written >= 1, '应写入至少一份侧写');
  const row = db.getProfile('333');
  assert.equal(row.persona, '二游玩家，说话直接');
  assert.equal(row.edited_by, 'worker');
  assert.equal(row.source, 'auto');
});
