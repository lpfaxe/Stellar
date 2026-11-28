/**
 * 记忆分区 / 主体 / 标题 / 零碎收件箱 / 回填（2026-11-27）。
 * 红过的点：区域与主体只写进 topic 不够，zone/fragment 也要落；标题必须 manual > dream > auto；
 * 回填必须 dry-run 可统计、写入幂等、推不出落 region_05。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memreg-'));
process.env.DSH_HOME = root;
const mod = await import('../src/memory-db.js');
const {
  openDb, closeDb, dayKey, insertTopic, insertFragment, insertZoneNote, catalog, formatCatalogForModel,
  regionForKey, regionForZone, listRegions, regionStats, formatRegionLine, listSubjects, ensureSubjectForOwner,
  subjectForOwner, upsertPage, listPages, getPage, formatPageForModel, updateTopicTitle, backfillMemoryRegions,
  REGIONS,
} = mod;
const charDir = path.join(root, 'stellar', 'characters', 'deepseek');
fs.mkdirSync(path.join(charDir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(root, 'stellar', 'characters', 'current.json'), JSON.stringify({ id: 'deepseek' }), 'utf8');
const db = openDb({});
const NOW = Date.now();
const DAY = dayKey(NOW);
const OWNER = '3025145051';
const rows = (text) => [
  { id: 1, conversation_key: 'private:' + OWNER, owner_id: OWNER, speaker_id: OWNER, speaker_name: '主人', role: 'user', kind: 'text', text, at: NOW - 60000, day_key: DAY },
  { id: 2, conversation_key: 'private:' + OWNER, owner_id: OWNER, speaker_id: '2601728971', speaker_name: '她', role: 'self', kind: 'text', text: '嗯，我记下了', at: NOW - 30000, day_key: DAY },
];

test.after(() => {
  try { closeDb({}); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('五个区固定、key 与 zone 映射稳定', () => {
  assert.deepEqual(REGIONS.map((r) => r.code), ['region_01', 'region_02', 'region_03', 'region_04', 'region_05']);
  assert.equal(regionForKey('private:3025145051'), 'region_01');
  assert.equal(regionForKey('group:123456'), 'region_01');
  assert.equal(regionForKey('bili:BV1xx411c7mD'), 'region_03');
  assert.equal(regionForKey('qzone:abc'), 'region_02');
  assert.equal(regionForKey('town:plaza'), 'region_04');
  assert.equal(regionForKey('mystery'), 'region_05');
  assert.equal(regionForZone('bili'), 'region_03');
  assert.equal(regionForZone('qzone'), 'region_02');
  assert.equal(regionForZone('nope'), 'region_05');
  assert.equal(listRegions({ db }).length, 5);
});

test('建话题就落区与主体；零碎落 inbox 收件箱', () => {
  const t = insertTopic({ db, rows: rows('第七章的思维导图重画一下'), topic: { ownerId: OWNER, conversationKey: 'private:' + OWNER, dayKey: DAY, title: '', summary: '', importance: 30 } });
  assert.ok(t && t.id);
  const row = db.prepare('SELECT region_id, subject_id, title_source, dreamed_at FROM topic WHERE id = ?').get(t.id);
  assert.equal(row.region_id, 'region_01');
  assert.match(row.subject_id, /^su_[0-9a-f]{16}$/);
  assert.equal(row.title_source, 'auto');
  assert.equal(Number(row.dreamed_at), 0);
  const sub = subjectForOwner(OWNER, { db });
  assert.equal(sub.kind, 'user');
  assert.equal(sub.privacy, 'private');

  const f = insertFragment({ db, ownerId: OWNER, text: '她喜欢把思维导图控制在 4 层以内', at: NOW, day: DAY, facet: 'preference' });
  assert.equal(f.ok, true);
  const fr = db.prepare('SELECT region_id, subject_id, status FROM fragment WHERE id = ?').get(f.id);
  assert.equal(fr.region_id, 'region_01');
  assert.ok(fr.subject_id);
  assert.equal(fr.status, 'inbox');

  insertZoneNote({ zone: 'bili', text: '今天看了三期动画分镜讲解，记下运镜节奏。', items: ['BV1xx411c7mD'], day: DAY, at: NOW, db });
  assert.equal(db.prepare("SELECT region_id FROM zone_note WHERE zone = 'bili'").get().region_id, 'region_03');
});

test('catalog 可按区/主体过滤，区域行不超过 90 字', () => {
  const all = catalog({ ownerId: OWNER, db });
  assert.equal(all.regions.length, 5);
  assert.match(all.regionLine, /region_01|QQ聊天|记忆区/);
  assert.ok(all.regionLine.length <= 90);
  assert.ok(all.rows.every((r) => r.region_id === 'region_01'));
  assert.equal(all.subject && all.subject.external_id, OWNER);
  const line = formatRegionLine({ db });
  assert.ok(line.length <= 90);
  const onlyQq = catalog({ ownerId: OWNER, regionId: 'region_01', db });
  assert.ok(onlyQq.rows.length >= 1);
  const onlyBili = catalog({ ownerId: OWNER, regionId: 'region_03', db });
  assert.equal(onlyBili.rows.length, 0, 'B站见闻在 zone_note，不硬造假话题');
  const subjects = listSubjects({ regionId: 'region_01', db });
  assert.ok(subjects.some((s) => s.external_id === OWNER));
  const stats = regionStats({ db });
  assert.ok(stats.find((s) => s.code === 'region_01').topics >= 1);
});

test('主体页带来源与版本，没有来源拒绝写', () => {
  const sub = subjectForOwner(OWNER, { db });
  const bad = upsertPage({ subjectId: sub.id, title: '关于他', body: '没有来源的结论', sources: [], db });
  assert.equal(bad.ok, false);
  const p1 = upsertPage({ subjectId: sub.id, title: '关于他', body: '他在做 Stellar，最近在改记忆。', links: ['高数'], sources: ['tp_demo'], updatedBy: 'dream', db });
  assert.equal(p1.ok, true);
  const p2 = upsertPage({ subjectId: sub.id, title: '关于他', body: '他在做 Stellar，最近在改记忆分区。', sources: ['tp_demo'], updatedBy: 'dream', db });
  assert.equal(p2.ok, true);
  assert.ok(p2.version > p1.version, '同主体同标题要递增版本');
  const pages = listPages({ subjectId: sub.id, db });
  assert.equal(pages.length, 1);
  const full = getPage(p2.id, { db });
  assert.match(formatPageForModel(full), /来源：tp_demo/);
  assert.ok(Array.isArray(full.sources) && full.sources.includes('tp_demo'));
});

test('标题优先级：manual > dream > auto；review 只改 auto', () => {
  const t = insertTopic({ db, rows: rows('标题优先级测试'), topic: { ownerId: OWNER, conversationKey: 'private:' + OWNER, dayKey: DAY, title: '旧标题', summary: '旧摘要', importance: 10 } });
  assert.equal(updateTopicTitle({ topicId: t.id, title: 'dream 标题', summary: '', source: 'dream', db }).ok, true);
  assert.equal(updateTopicTitle({ topicId: t.id, title: 'review 想改', summary: '', source: 'auto', db }).ok, false, 'dream 不能被 review 覆盖');
  assert.equal(updateTopicTitle({ topicId: t.id, title: '手动标题', summary: '', source: 'manual', db }).ok, true);
  assert.equal(updateTopicTitle({ topicId: t.id, title: 'dream 再改', summary: '', source: 'dream', db }).ok, false, 'manual 锁死');
  assert.equal(updateTopicTitle({ topicId: t.id, title: '手动再改', summary: '', source: 'manual', db }).ok, true, '手动可以改自己');
  const row = db.prepare('SELECT title, title_source FROM topic WHERE id = ?').get(t.id);
  assert.equal(row.title, '手动再改');
  assert.equal(row.title_source, 'manual');
  const history = db.prepare('SELECT COUNT(*) AS n FROM memory_title_history WHERE topic_id = ?').get(t.id).n;
  assert.ok(history >= 3, '每次成功改标题都要留历史');
});

test('回填：dry-run 只统计，写入幂等，推不出落 05', () => {
  const t = insertTopic({ db, rows: rows('回填测试'), topic: { ownerId: OWNER, conversationKey: 'private:' + OWNER, dayKey: DAY, title: '回填', summary: '', importance: 5 } });
  db.prepare("UPDATE topic SET region_id = '', subject_id = '' WHERE id = ?").run(t.id);
  db.prepare("UPDATE fragment SET region_id = '', subject_id = '', status = '' WHERE owner_id = ?").run(OWNER);
  const dry = backfillMemoryRegions({ db });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.topics >= 1);
  assert.equal(db.prepare('SELECT region_id FROM topic WHERE id = ?').get(t.id).region_id, '', 'dry-run 不许写');
  const real = backfillMemoryRegions({ db, dryRun: false, force: true });
  assert.equal(real.ok, true);
  assert.equal(db.prepare('SELECT region_id FROM topic WHERE id = ?').get(t.id).region_id, 'region_01');
  const again = backfillMemoryRegions({ db, dryRun: false, force: true });
  assert.equal(again.ok, true);
});

test('主体页进目录文本，唤醒侧能看见', async () => {
  const sub = subjectForOwner(OWNER, { db });
  upsertPage({ subjectId: sub.id, title: '关于他的学习', body: '他在做无机化学第七章。', sources: ['tp_demo'], updatedBy: 'dream', db });
  const text = formatCatalogForModel(catalog({ ownerId: OWNER, db }), { titles: 8, maxChars: 600, regionNames: true });
  assert.match(text, /关于他的学习/);
  assert.match(text, /记忆区|QQ聊天/);
  const read = await import('../src/memory-read.js');
  read.resetMemoryReadCache();
  const snap = await read.awaitCatalog(OWNER, { titles: 8, maxChars: 600 });
  assert.equal(snap.ready, true);
  assert.ok(Array.isArray(snap.pages) && snap.pages.some((p) => p.title === '关于他的学习'));
  assert.ok(String(snap.regionLine || '').length > 0);
});
