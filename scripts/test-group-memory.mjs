/**
 * 群聊记忆（2026-11-15 主人要求）回归：旁观话题、参与人索引、按人检索、主人识别、@ 判定。
 *
 * 钉住五件事：
 *  ① 群里她没插话的一段也要能切成话题（否则「A 昨天在群里说了啥」永远查不到）；
 *  ② 旁观话题绝不进重要晋升（否则两天后库被群友闲聊塞满，且 important 永不删）；
 *  ③ 参与人索引与群名册要能按 QQ 查，名字要带号；
 *  ④ about 检索要把「跟这个人的私聊」和「他在群里参与的话题」一起捞出来；
 *  ⑤ 名册里主人/她不能靠昵称猜（群里可能有人昵称就叫主人）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memgroup-'));
process.env.DSH_HOME = root;

const db = await import('../src/memory-db.js');
const worker = await import('../src/memory-worker.js');

const DAY = '2026-11-13';
const T0 = Date.parse('2026-11-13T14:00:00+08:00');
const GKEY = 'group:1132808329';
const GOID = 'group:1132808329';
const OWNER = '1000000001';
const FRIEND = '1000000003';
const SELF = '1000000002';

function addGroup(speakerId, speakerName, role, text, at) {
  return db.append({
    conversationKey: GKEY,
    ownerId: GOID,
    speakerId,
    speakerName,
    role,
    kind: 'text',
    text,
    at,
  });
}

test.after(() => {
  try { db.closeDb(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('群里她没插话的一段 → 切成旁观话题，标题带上首句', () => {
  // 4 条 / 80 字是 worker 里的门槛，这里刚好过线
  addGroup(FRIEND, '测试员A', 'user', '周末有人去爬山吗，天气预报说这两天是晴天', T0);
  addGroup(OWNER, '示例主人', 'user', '我周六下午有空，可以一起去', T0 + 20000);
  addGroup(FRIEND, '测试员A', 'user', '那就定周六两点山脚下集合吧', T0 + 40000);
  addGroup(OWNER, '示例主人', 'user', '好，我带水和你上次说的那个零食', T0 + 60000);
  const res = worker.runSplit({ now: T0 + 120000 });
  assert.equal(res.ambient >= 1, true, '旁观段应该切出至少一个话题');
  const cat = db.catalog({ ownerId: GOID });
  assert.equal(cat.rows.length, 1);
  assert.equal(cat.rows[0].scope, 'ambient');
  assert.ok(cat.rows[0].title.includes('爬山'));
  // 参与人：两个真人都在，她不在（她没说话）
  const people = cat.rows[0].participants.map((p) => p.qq).sort();
  assert.deepEqual(people, [FRIEND, OWNER].sort());
});

test('旁观话题不进重要晋升，也不会被复核模型改写', () => {
  const cat = db.catalog({ ownerId: GOID });
  const id = cat.rows[0].id;
  assert.equal(db.promoteTopic(id), false, 'ambient 不能晋升');
  const row = db.openDb().prepare('SELECT tier FROM topic WHERE id = ?').get(id);
  assert.equal(row.tier, 'daily');
  const cand = worker.reviewCandidates({ targetDay: DAY });
  assert.equal(cand.topics.some((t) => t.id === id), false, '复核候选里不该出现旁观话题');
});

test('按人检索：他在群里的旁观话题查得到，群里也有名册', () => {
  const hit = db.topicsForPerson(FRIEND);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].scope, 'ambient');
  const roster = db.groupRoster(GOID);
  assert.deepEqual(roster.map((r) => r.qq).sort(), [FRIEND, OWNER].sort());
  // 名册里名字要能标出主人（靠 QQ 号判，不靠昵称）
  const cat = db.catalog({ ownerId: GOID });
  const text = db.formatCatalogForModel(cat, { ownerQQ: OWNER, selfId: SELF });
  assert.match(text, /主人/);
  assert.match(text, new RegExp(FRIEND));
  assert.match(text, /\[旁观\]/);
});

test('about 检索：私聊与群话题一起捞，无果才空', () => {
  // 先造一条「跟 A 的私聊话题」
  db.append({ conversationKey: 'private:' + FRIEND, ownerId: FRIEND, speakerId: FRIEND, speakerName: '测试员A', role: 'user', kind: 'text', text: '我下个月要搬家，东西多得要命', at: T0 + 3600000 });
  db.append({ conversationKey: 'private:' + FRIEND, ownerId: FRIEND, speakerId: SELF, speakerName: '', role: 'self', kind: 'text', text: '搬家最麻烦了，要不要我帮你列个清单', at: T0 + 3660000 });
  const split = worker.runSplit({ now: T0 + 3700000 });
  assert.ok(split.topics.length >= 1);
  const rows = db.search({ q: '搬家', ownerId: GOID, about: FRIEND, limit: 5 });
  const owners = rows.map((r) => r.owner_id);
  assert.ok(owners.includes(FRIEND), '应该捞到跟 A 的私聊话题');
  assert.ok(rows.some((r) => Array.isArray(r.participants)), '话题行要带参与人');
  const text = db.formatSearchForModel(rows, { currentOwner: GOID });
  assert.match(text, /测试员A/);
});

test('ownerIdForKey：私聊取号，群聊保留 group: 前缀', () => {
  assert.equal(db.ownerIdForKey('private:' + OWNER), OWNER);
  assert.equal(db.ownerIdForKey(GKEY), GKEY);
  assert.equal(db.ownerIdForKey('owner:internal'), 'owner:internal');
});
