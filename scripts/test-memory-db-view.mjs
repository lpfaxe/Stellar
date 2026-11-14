/**
 * 记忆库视图（插件设置页用）回归：只读聚合必须能落库读、字段齐全、坏库不抛。
 *
 * 钉住四件事：
 *  1. 真实路径（DSH_HOME fixture 里的 characters/<id>/memory/memory.db）能被 openDb 找到并建表；
 *  2. overview 的 counts / facts / zones / topics / jobs 五个区块都在，缺表也不能抛；
 *  3. 写进去的事实/见闻/侧写能被读出来（含 privacy 与 zone 过滤）；
 *  4. 库文件不存在时也是 ok:true + 全零，而不是 500 —— 设置页不能因为「还没聊过」就白屏。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-dbview-'));
const memDir = path.join(root, 'stellar', 'characters', 'deepseek', 'memory');
fs.mkdirSync(memDir, { recursive: true });
fs.mkdirSync(path.join(root, 'stellar', 'state'), { recursive: true });
// 角色目录：readCurrentCharacter() 找不到会回退旧布局，所以这里两个都建上。
fs.writeFileSync(path.join(root, 'stellar', 'characters', 'deepseek', 'character.json'), JSON.stringify({ id: 'deepseek', name: '测试角色' }), 'utf8');
process.env.DSH_HOME = root;
process.env.USERPROFILE = root;

const dbMod = await import('../src/memory-db.js');
const view = await import('../plugins/stellar/lib/memory-db-view.js');

test('空库也能出完整结构（设置页不能白屏）', () => {
  const o = view.memoryDbOverview({});
  assert.equal(o.ok, true);
  assert.ok(o.counts, '缺 counts');
  assert.ok(o.facts, '缺 facts');
  assert.ok(o.zones && o.zones.bili && o.zones.qzone, '缺 zones');
  assert.ok(Array.isArray(o.topics), 'topics 不是数组');
  assert.ok(Array.isArray(o.factRows), 'factRows 不是数组');
  assert.ok(Array.isArray(o.zoneRows), 'zoneRows 不是数组');
  assert.ok(Array.isArray(o.profiles), 'profiles 不是数组');
  assert.equal(o.topics.length, 0);
  assert.equal(o.facts.total, 0);
  assert.ok(o.jobs.length >= 3, 'jobs 缺项');
  assert.ok(o.jobs.every((j) => typeof j.state === 'string'), 'job.state 不是字符串');
});

test('写进去的事实 / 见闻 / 侧写能被读出来', () => {
  dbMod.upsertFact({ ownerId: '1000000001', kind: 'birthday', label: '生日', text: '生日是1月1日', privacy: 'private', weight: 5, source: 'manual' });
  dbMod.upsertFact({ ownerId: '1000000005', kind: 'like', label: '喜欢', text: '喜欢吃辣', privacy: 'normal', weight: 3, source: 'manual' });
  dbMod.insertZoneNote({ zone: 'bili', text: '看了一个讲记忆系统的视频，讨论的是切分规则', items: ['BV1xx411c7mD'] });
  dbMod.insertZoneNote({ zone: 'qzone', text: '好友爱看刷到一条猫图，点赞了' });
  dbMod.upsertProfile({ ownerId: '1000000001', persona: '说话直接，爱吐槽', detail: '在意被记住细节', tags: ['直接'] });

  const o = view.memoryDbOverview({});
  assert.equal(o.facts.total, 2, '事实条数不对');
  assert.equal(o.catalog.topics, 0, 'catalog.topics 不该把 facts 算进去');
  assert.equal(o.facts.private, 1);
  assert.equal(o.facts.normal, 1);
  assert.equal(o.factRows.length, 2);
  assert.ok(o.factRows.every((f) => f.ownerId && f.text && f.privacy), '事实字段缺失');
  assert.equal(o.zones.bili.total, 1);
  assert.equal(o.zones.qzone.total, 1);
  assert.equal(o.zone, 'bili');
  assert.ok(o.zoneRows.every((r) => r.zone === 'bili'), 'zone 过滤没生效');
  assert.equal(o.profiles.length, 1);
  assert.equal(o.profiles[0].persona, '说话直接，爱吐槽');
  assert.deepEqual(o.profiles[0].tags, ['直接']);
});

test('按 owner 过滤只影响话题/事实，不影响全局计数', () => {
  const mine = view.memoryDbOverview({ ownerId: '1000000001' });
  assert.equal(mine.facts.total, 1, 'owner 过滤后事实条数不对');
  assert.equal(mine.factRows[0].ownerId, '1000000001');
  const all = view.memoryDbOverview({});
  assert.equal(all.facts.total, 2, '全局事实条数不对');
});

test('zone 参数切到 qzone 只回 qzone 的见闻', () => {
  const o = view.memoryDbOverview({ zone: 'qzone' });
  assert.equal(o.zone, 'qzone');
  assert.equal(o.zoneRows.length, 1);
  assert.equal(o.zoneRows[0].zone, 'qzone');
});

test('DSH_HOME 指向空目录时也不抛（库还没建）', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-dbview-empty-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = empty;
  try {
    dbMod.closeDb();
    const o = view.memoryDbOverview({});
    assert.equal(o.ok, true);
    assert.equal(o.counts.cache, 0);
  } finally {
    process.env.DSH_HOME = prev;
    dbMod.closeDb();
  }
});

test.after(() => {
  try { dbMod.closeDb(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
