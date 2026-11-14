/**
 * 记忆注入读侧（src/memory-read.js）回归：不碰真实记忆目录，全部在临时 fixture 里跑。
 *
 * 为什么要单测这一层：唤醒提示词是同步函数，读库只能在后台预热 + 同步读缓存（stale-while-revalidate）。
 * 这条链上的三个坑都很难在真机上复现，只能在这里钉住：
 *   ① 第一次读必须返回空（不能阻塞唤醒）；
 *   ② 预热成功之后要能同步拿到目录文本（含话题 id 与「查法」那一行）；
 *   ③ 库坏掉时保留上一次的好结果，不能把唤醒里的记忆整块抹掉。
 *
 * 跑法：node scripts/test-memory-inject.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memread-'));
process.env.DSH_HOME = root;

// 角色目录必须存在，否则 activeMemoryPaths() 会退回 legacy 目录。
const charDir = path.join(root, 'stellar', 'characters', 'deepseek');
fs.mkdirSync(path.join(charDir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(root, 'stellar', 'characters', 'current.json'), JSON.stringify({ id: 'deepseek', name: 'DeepSeek恶魔娘' }), 'utf8');

const read = await import('../src/memory-read.js');
const db = await import('../src/memory-db.js');

const DAY = '2026-11-13';
const T0 = new Date('2026-11-13T10:00:00+08:00').getTime();
const OWNER = '1000000001';

test.after(() => {
  try { db.closeDb({}); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('第一次读必须返回空（唤醒不能等库）', () => {
  assert.equal(read.catalogSnapshot(OWNER), null);
  assert.equal(read.personaSnapshot(OWNER), null);
});

test('预热之后能同步拿到目录：话题 id + 查法一行，且不含正文', async () => {
  const conn = db.openDb({});
  // 先落两条缓存消息拿到真实 id：insertTopic 会把对应 cache_msg 标成 split。
  const cacheUser = db.append({ conversationKey: 'private:' + OWNER, speakerId: OWNER, speakerName: '示例主人', role: 'user', text: '你说我们算什么关系', at: T0, dayKey: DAY });
  const cacheSelf = db.appendSelf({ conversationKey: 'private:' + OWNER, speakerId: '1000000002', speakerName: '她', text: '这个问题我先不接', at: T0 + 60000, dayKey: DAY });
  db.insertTopic({
    db: conn,
    topic: { id: 'tp_20261113_0001', ownerId: OWNER, day: DAY, title: '主人问 AI 剪片子 / 关系话题', summary: '她借着 AI 能自己剪片子的话题问我们算什么关系', tier: 'daily', importance: 40, startedAt: T0, endedAt: T0 + 600000, msgCount: 2 },
    rows: [
      { id: cacheUser.id, role: 'user', speaker_id: OWNER, speaker_name: '示例主人', text: '你说我们算什么关系', at: T0 },
      { id: cacheSelf.id, role: 'self', speaker_id: '1000000002', speaker_name: '她', text: '这个问题我先不接', at: T0 + 60000 },
    ],
  });
  db.upsertProfile({ ownerId: OWNER, persona: '喜欢被叫主人，讨厌长文，回复要短', db: conn });
  await read.warmCatalog(OWNER, { titles: 8, maxChars: 600 });
  const snap = read.catalogSnapshot(OWNER);
  assert.ok(snap && snap.ready, '预热后应当 ready');
  assert.match(snap.text, /tp_20261113_0001/);
  assert.match(snap.text, /主人问 AI 剪片子/);
  assert.match(snap.text, /stellar_memory_catalog/);
  assert.ok(!snap.text.includes('这个问题我先不接'), '目录不能带正文');
  assert.ok(snap.text.length <= 600);
});

test('侧写单独可取（不混进目录块）', async () => {
  await read.warmPersona(OWNER);
  const snap = read.personaSnapshot(OWNER);
  assert.ok(snap && snap.ready);
  assert.match(snap.persona, /讨厌长文/);
  const cat = read.catalogSnapshot(OWNER);
  assert.ok(!cat.text.includes('讨厌长文'), '侧写要单独一行注入，不能塞进目录');
});

test('TTL 内重复预热复用缓存（不发第二次查询）', async () => {
  const first = read.catalogSnapshot(OWNER);
  const again = await read.warmCatalog(OWNER, { ttlMs: 60000 });
  assert.equal(again.at, first.at, 'TTL 内应当直接复用上一次结果');
});

test('库坏掉时保留上一次的好结果（不能把记忆抹掉）', async () => {
  const before = read.catalogSnapshot(OWNER);
  db.closeDb({});
  // 把库文件换成目录 → 再打开必定失败
  const dbFile = db.resolveDbFile({});
  try { fs.rmSync(dbFile, { force: true }); } catch {}
  fs.mkdirSync(dbFile, { recursive: true });
  // TTL 下限是 5 秒，真等太慢；把时钟往前推，让缓存过期但不整点跨越。
  const realNow = Date.now;
  const shift = 10 * 60 * 1000;
  Date.now = () => realNow() + shift;
  try {
    await read.warmCatalog(OWNER, { log: () => {} });
  } finally {
    Date.now = realNow;
  }
  const after = read.catalogSnapshot(OWNER);
  assert.ok(after && after.ready, '应当仍标记为可用（stale）');
  assert.equal(after.text, before.text, 'stale 内容必须与上一次一致');
  assert.ok(after.error, '要记下失败原因，便于排查');
});
