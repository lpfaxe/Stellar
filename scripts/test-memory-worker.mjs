/**
 * 记忆库切分器（memory-worker.js）回归：全在临时 DSH_HOME 里跑。
 *
 * 钉住四件事（都是设计里写明、一旦违反就会悄悄坏掉的）：
 *  ① 双方都说过话才建话题（单边独白不能变成「话题」）；
 *  ② 单边段先 held、挂满 2 小时才 dropped（不是立刻丢，否则对方隔一会儿再回就拼不上了）；
 *  ③ 够长的单边独白降级成零碎记忆（fragment），而不是直接消失；
 *  ④ 窗口清理只动 D-2 且不碰 important。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memworker-'));
process.env.DSH_HOME = root;

const db = await import('../src/memory-db.js');
const worker = await import('../src/memory-worker.js');

const HOUR = 60 * 60 * 1000;
const base = Date.parse('2026-11-13T10:00:00+08:00');

function add(role, text, at, extra = {}) {
  return db.append({
    conversationKey: 'private:1000000003',
    ownerId: '1000000003',
    speakerId: role === 'self' ? '1000000002' : '1000000003',
    speakerName: role === 'self' ? '' : '测试员A',
    role,
    kind: 'text',
    text,
    at,
    ...extra,
  });
}

test.after(() => {
  try { db.closeDb(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('双方交替的一段 → 建一个话题，标题取首条用户消息', () => {
  add('user', '帮我看看这张图里是什么', base);
  add('self', '我瞧瞧…像个卡通人物', base + 60000);
  add('user', '对，就是那个', base + 120000);
  const res = worker.runSplit({});
  assert.equal(res.topics.length, 1);
  const list = db.catalog({ ownerId: '1000000003' });
  assert.equal(list.rows.length, 1);
  assert.ok(list.rows[0].title.includes('帮我看看'));
  const read = db.readTopic(list.rows[0].id, { full: true });
  assert.equal(read.rows.length, 3);
  assert.deepEqual(read.rows.map((r) => r.role), ['user', 'self', 'user']);
});

test('单边独白（够长）→ 零碎记忆，不建话题', () => {
  const t2 = base + 3 * HOUR;
  for (let i = 0; i < 3; i += 1) add('user', '我就是随便说说今天天气不错外面太阳很大懒得动', t2 + i * 1000);
  const before = db.catalog({ ownerId: '1000000003' }).rows.length;
  const res = worker.runSplit({});
  assert.equal(res.topics.length, 0, '只有一方说话不能建话题');
  assert.equal(res.fragments, 1);
  assert.equal(db.catalog({ ownerId: '1000000003' }).rows.length, before);
});

test('太短的单边段先 held，不会立刻丢', () => {
  const t3 = base + 6 * HOUR;
  add('user', '在吗', t3);
  // 必须显式给 now：夹具时间钉在 2026-11-13 16:00，而 runSplit() 默认用真机时间。
  // 不传就等于「几小时后再跑一次」，held 会因为挂满 2 小时被 drop（2026-11-13 18 点后
  // 这组用例开始假失败，就是踩了这个）。
  const res = worker.runSplit({ now: t3 + 1000 });
  assert.ok(res.held >= 1);
  const rows = db.heldRows();
  assert.ok(rows.some((r) => r.text === '在吗'), '短句必须留在 held 里等对方回');
});

test('held 的行在对方回话后能并进话题（跨轮次补充）', () => {
  const t4 = base + 6 * HOUR + 60000;
  add('self', '在的', t4);
  add('user', '问你个事', t4 + 30000);
  const res = worker.runSplit({ now: t4 + 60000 });
  assert.equal(res.topics.length, 1);
  const id = res.topics[0];
  const read = db.readTopic(id, { full: true });
  assert.ok(read.rows.some((r) => r.text === '在吗'), '之前 held 的那句要能并进来');
  assert.ok(read.rows.some((r) => r.text === '在的'));
});

test('挂满 2 小时的单边段才 dropped', () => {
  const t5 = base + 20 * HOUR;
  add('user', '嗯', t5);
  worker.runSplit({});
  assert.ok(db.heldRows().some((r) => r.text === '嗯'));
  // 时间推进 3 小时后：同一批 held 应该被丢掉
  const res = worker.runSplit({ now: t5 + 3 * HOUR });
  assert.ok(res.dropped >= 1, '挂太久的要清掉，否则每轮都被重新读到');
});

test('窗口清理只动 D-2，且不碰 important', async () => {
  const D2 = Date.parse('2026-11-11T10:00:00+08:00');
  add('user', '两天前的旧对话内容', D2);
  add('self', '两天前的回复内容', D2 + 60000);
  worker.runSplit({});
  const all = db.catalog({ ownerId: '1000000003' });
  const oldTopic = all.rows.find((t) => t.day_key === '2026-11-11');
  if (oldTopic) db.promoteTopic(oldTopic.id, { reason: 'manual' });

  const res = worker.runWindow({ now: base + 24 * HOUR, force: true, targetDay: '2026-11-11', trashDir: path.join(root, 'trash') });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'trash', '2026-11-11.jsonl')), '删之前必须先导出');

  const after = db.catalog({ ownerId: '1000000003' });
  assert.ok(after.rows.every((t) => t.day_key !== '2026-11-11' || t.tier === 'important'),
    'D-2 的日常话题要清掉，important 必须留着');
});
