/**
 * 记忆库（memory-db.js）回归：不碰真实记忆目录，全部在临时 fixture 里跑。
 *
 * 覆盖：建库/schema、入站出站落盘、纯代码分段、双方硬约束、话题正文完整、
 *      catalog 只给标题、readTopic 读全文、FTS5 trigram 与 2 字 LIKE 兜底、
 *      profile/style/job_state、窗口删除（默认 D-3，important 永不删）+ trash 导出、
 *      群话题「人类只有她+主人」在私聊目录/检索里也能召回。
 *
 * 跑法：node scripts/test-memory-db.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memdb-'));
process.env.DSH_HOME = root;

const dbFile = path.join(root, 'fixture', 'memory.db');
const mod = await import('../src/memory-db.js');
const { openDb, listTopicParticipants, topicsForPerson, groupRoster, append, appendSelf, safeAppendSelf, pendingRows, segmentRows, insertTopic, insertFragment, readTopic, formatTopicForModel, catalog, formatCatalogForModel, search, formatSearchForModel, upsertProfile, listProfiles, insertStyleSlice, listStyleSlices, saveJobState, jobState, stats, pruneWindow, promoteTopic, dayKey, ownerIdForKey, bigramsOf, soloGroupTopicIds } = mod;

const worker = await import('../src/memory-worker.js');

const DAY = '2026-11-13';
const T0 = new Date('2026-11-13T10:00:00+08:00').getTime();
const db = openDb({ file: dbFile });

test.after(() => {
  try { mod.closeDb({ file: dbFile }); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('schema 建全了九类表与 FTS5', () => {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all().map((r) => r.name);
  for (const need of ['cache_msg', 'topic', 'topic_msg', 'fragment', 'profile', 'style_slice', 'search_doc', 'search_fts', 'job_state', 'meta']) {
    assert.ok(names.includes(need), '缺少表 ' + need);
  }
  assert.ok(names.includes('search_doc_ai') && names.includes('search_doc_ad'), '缺少 FTS 同步触发器');
  assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'engine'").get().v, 'memorydb-v1');
});

test('owner 软标签与本地日', () => {
  assert.equal(ownerIdForKey('private:1000000001'), '1000000001');
  assert.equal(ownerIdForKey('group:123456'), 'group:123456');
  assert.match(dayKey(T0), /^2026-11-13$/);
});

test('入站与出站都落缓存（双写是硬要求）', () => {
  append({ db: dbFile, conversationKey: 'private:1000000003', speakerId: '1000000003', speakerName: '测试员A', role: 'user', text: '帮我画一张绝区零挽昼的图', at: T0, dayKey: DAY });
  appendSelf({ db: dbFile, conversationKey: 'private:1000000003', speakerId: '1000000002', speakerName: '她', text: '行，那你想要什么角度', at: T0 + 60000, dayKey: DAY });
  const rows = db.prepare('SELECT role, text FROM cache_msg ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'self']);
  assert.equal(rows[0].owner_id || db.prepare('SELECT owner_id FROM cache_msg LIMIT 1').get().owner_id, '1000000003');
});

test('写库失败不抛（safeAppendSelf 返回 null）', () => {
  // 用一个**普通文件**占住目录名 → mkdirSync 必定失败（用不存在的目录反而会被递归创建，测不到失败路径）
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, 'not a dir', 'utf8');
  const bad = { conversationKey: 'private:1', role: 'self', text: 'x', db: path.join(blocker, 'memory.db') };
  let logged = '';
  const out = safeAppendSelf(bad, (msg) => { logged = String(msg); });
  assert.equal(out, null);
  assert.match(logged, /记忆库写入失败/);
});

test('纯代码分段：间隔/条数/字符三个断点', () => {
  const rows = [
    { id: 1, ck: 'k1', oid: 'o1', role: 'user', text: 'a'.repeat(10), at: T0, day_key: DAY },
    { id: 2, ck: 'k1', oid: 'o1', role: 'self', text: 'b'.repeat(10), at: T0 + 60000, day_key: DAY },
    { id: 3, ck: 'k1', oid: 'o1', role: 'user', text: 'c'.repeat(10), at: T0 + 60 * 60 * 1000, day_key: DAY },
    { id: 4, ck: 'k2', oid: 'o2', role: 'user', text: 'd', at: T0 + 60 * 60 * 1000 + 1000, day_key: DAY },
  ];
  const segs = segmentRows(rows, { gapMs: 20 * 60 * 1000, maxMsgs: 60, maxChars: 6000 });
  assert.equal(segs.length, 3);
  assert.deepEqual(segs.map((s) => s.rows.length), [2, 1, 1]);
});

test('硬约束：只有一边的话不建话题', () => {
  const solo = [
    { id: 11, ck: 'private:1', oid: '1', role: 'self', text: '在吗', at: T0, day_key: DAY },
    { id: 12, ck: 'private:1', oid: '1', role: 'self', text: '在吗在吗', at: T0 + 1000, day_key: DAY },
  ];
  const out = insertTopic({ db, rows: solo, topic: { ownerId: '1', conversationKey: 'private:1', dayKey: DAY, title: '独白' } });
  assert.equal(out.ok, false);
  assert.deepEqual(out.missing, ['user']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic').get().n, 0);
});

test('建话题：正文完整、cache 标 split、important 打 keep', () => {
  const rows = [
    { id: 101, ck: 'private:1000000001', oid: '1000000001', role: 'user', speaker_id: '1000000001', speaker_name: '主人', text: '以后叫我哥，别叫主人了', at: T0 + 2 * 3600 * 1000, day_key: DAY },
    { id: 102, ck: 'private:1000000001', oid: '1000000001', role: 'self', speaker_id: '1000000002', speaker_name: '她', text: '哥？行吧，那你别嫌我喊得生硬', at: T0 + 2 * 3600 * 1000 + 30000, day_key: DAY },
  ];
  for (const r of rows) {
    db.prepare('INSERT INTO cache_msg (id, conversation_key, owner_id, speaker_id, speaker_name, role, kind, text, at, day_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.ck, r.oid, r.speaker_id, r.speaker_name, r.role, 'text', r.text, r.at, r.day_key);
  }
  const out = insertTopic({
    db, rows,
    topic: { ownerId: '1000000001', conversationKey: 'private:1000000001', dayKey: DAY, title: '改口叫哥', summary: '主人要求改称呼，她答应了', importance: 85, facets: ['约定', '关系'] },
  });
  assert.equal(out.ok, true);
  assert.equal(out.tier, 'important');
  const saved = db.prepare('SELECT * FROM topic WHERE id = ?').get(out.id);
  assert.equal(saved.msg_count, 2);
  assert.equal(saved.promote_reason, 'score');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic_msg WHERE topic_id = ?').get(out.id).n, 2);
  const cache = db.prepare('SELECT process_state, keep FROM cache_msg WHERE id IN (101, 102)').all();
  assert.deepEqual(cache.map((r) => r.process_state), ['split', 'split']);
  assert.deepEqual(cache.map((r) => r.keep), [1, 1]);
  // 检索文档已写入
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM search_doc WHERE ref_type = 'topic'").get().n, 1);
});

test('读话题：双方都在，时间与身份都对', () => {
  const id = db.prepare("SELECT id FROM topic LIMIT 1").get().id;
  const data = readTopic(id, { full: true, db });
  const text = formatTopicForModel(data);
  assert.match(text, /【话题】改口叫哥/);
  // 群聊与私聊一律「名字(QQ)」—— 同名的人太多，光靠昵称分不清谁是谁。
  assert.match(text, /主人\(1000000001\): 以后叫我哥/);
  assert.match(text, /参与人：主人\(1000000001\)、她\(1000000002\)/);
  assert.match(text, /她\(你\): 哥？行吧/);
  assert.equal(data.total, 2);
  assert.equal(readTopic('tp_nope', { db }), null);
});

test('catalog 只给标题与条数（不给正文）', () => {
  insertFragment({ ownerId: '1000000001', day: DAY, text: '讨厌被叫「主人」，喜欢被叫哥', facet: '雷区', weight: 4, at: T0, db });
  const cat = catalog({ ownerId: '1000000001', db });
  assert.equal(cat.rows.length, 1);
  assert.equal(cat.fragments, 1);
  const text = formatCatalogForModel(cat);
  assert.match(text, /tp_\d{8}_\d{4} 改口叫哥/);
  assert.match(text, /另有 1 条零碎记忆/);
  assert.ok(!text.includes('哥？行吧'), '目录不能带正文');
  assert.ok(text.length <= 600);
});

test('检索：>=3 字走 FTS5 trigram，2 字走 bigrams LIKE 兜底', () => {
  const long = search({ q: '绝区零挽昼', ownerId: '1000000001', db });
  assert.equal(long.length, 0, '主人名下没有这条（应在测试员A名下）');
  const all = search({ q: '绝区零挽昼', scope: 'all', db });
  assert.equal(all.length, 0, '这条只进了 cache，还没建话题（切分前搜不到是正常的）');
  // 造一条带正文的零碎记忆来验检索
  insertFragment({ ownerId: '1000000003', day: DAY, text: '喜欢绝区零的挽昼，想要侧脸图', facet: '爱好', weight: 3, at: T0 + 5000, db });
  const hit3 = search({ q: '绝区零', ownerId: '1000000003', db });
  assert.ok(hit3.length >= 1, '3 字以上应该命中');
  const hit2 = search({ q: '挽昼', ownerId: '1000000003', db });
  assert.ok(hit2.length >= 1, '2 字应该走 LIKE 兜底命中');
  const miss = search({ q: '量子力学', ownerId: '1000000003', db });
  assert.equal(miss.length, 0);
  assert.match(formatSearchForModel(miss), /不记得/);
  const cross = search({ q: '挽昼', scope: 'all', db, currentOwner: '1000000001' });
  assert.ok(cross.length >= 1);
  assert.match(formatSearchForModel(cross, { currentOwner: '1000000001' }), /别转述具体内容/);
});

test('两字切分与 profile/style/job_state', () => {
  assert.equal(bigramsOf('火锅'), '火锅');
  assert.equal(bigramsOf('去吃火锅吧'), '去吃 吃火 火锅 锅吧', '4 个二字组，空格分隔给 LIKE 用');
  upsertProfile({ ownerId: '1000000003', persona: '二游党，爱看剧情，讨厌被催', detail: '对绝区零投入很深', tags: ['二游', '剧情'], confidence: 60, msgCount: 40, db });
  const prof = listProfiles({ db });
  assert.equal(prof.length, 1);
  assert.equal(prof[0].persona, '二游党，爱看剧情，讨厌被催');
  assert.equal(getProfilePersona(), '二游党，爱看剧情，讨厌被催');
  const slice = insertStyleSlice({ source: '一色伊吕波_AI角色设定.txt', part: 'PART4', kind: 'sample', tags: ['撒娇'], mood: '撒娇', text: '「哼，才不是为了你呢」', db });
  assert.equal(slice.ok, true);
  const dup = insertStyleSlice({ source: '一色伊吕波_AI角色设定.txt', part: 'PART4', kind: 'sample', tags: ['撒娇'], mood: '撒娇', text: '「哼，才不是为了你呢」', db });
  assert.equal(dup.duplicate, true, '同一条不能重复入库');
  assert.equal(listStyleSlices({ kind: 'sample', db }).length, 1);
  saveJobState('split', { dayKey: DAY, cursor: '120', state: 'idle', stats: { segments: 3 } }, { db });
  const job = jobState('split', { db });
  assert.equal(job.cursor, '120');
  assert.equal(JSON.parse(job.stats).segments, 3);
});

function getProfilePersona() {
  const row = db.prepare("SELECT persona FROM profile WHERE owner_id = '1000000003'").get();
  return row ? row.persona : '';
}

test('2 天窗口：删 daily、留 important、先导出 trash', async () => {
  const target = '2026-11-11';
  const rows = [
    { id: 201, ck: 'private:1000000001', oid: '1000000001', role: 'user', speaker_id: '1000000001', speaker_name: '主人', text: '今天早点睡', at: T0 - 2 * 86400000, day_key: target },
    { id: 202, ck: 'private:1000000001', oid: '1000000001', role: 'self', speaker_id: '1000000002', speaker_name: '她', text: '知道了，你也睡', at: T0 - 2 * 86400000 + 20000, day_key: target },
  ];
  for (const r of rows) {
    db.prepare('INSERT INTO cache_msg (id, conversation_key, owner_id, speaker_id, speaker_name, role, kind, text, at, day_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.ck, r.oid, r.speaker_id, r.speaker_name, r.role, 'text', r.text, r.at, r.day_key);
  }
  const daily = insertTopic({ db, rows, topic: { ownerId: '1000000001', conversationKey: 'private:1000000001', dayKey: target, title: '催睡觉', summary: '互相催睡', importance: 30 } });
  assert.equal(daily.tier, 'daily');
  const kept = db.prepare("SELECT * FROM topic WHERE tier = 'important'").all();
  assert.ok(kept.length >= 1);
  const out = pruneWindow({ targetDay: target, db });
  assert.equal(out.ok, true);
  assert.equal(out.deleted.topics, 1);
  assert.equal(out.deleted.cache, 2, 'cache 按 day_key 全删（keep=0 的那两条）');
  assert.ok(out.exported && fs.existsSync(out.exported), 'trash 必须落盘');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM topic WHERE day_key = ?").get(target).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM topic WHERE tier = 'important'").get().n, kept.length, 'important 一条都不能少');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM topic_msg WHERE topic_id = ?').get(daily.id).n, 0, '话题正文跟着删');
});

test('晋升与统计', () => {
  const id = db.prepare("SELECT id FROM topic WHERE tier = 'daily' LIMIT 1").get();
  if (id) assert.equal(promoteTopic(id.id, { reason: 'review', db }), true);
  const s = stats({ db });
  assert.ok(s.topics >= 1);
  assert.ok(s.cache >= 0);
  assert.equal(typeof s.dbBytes, 'number');
});

/* ── 见闻区（zone_note）：B站 / 好友爱看 ──────────────────────────────────────
 * 2026-11-13 主人加的：两个区不按话题切分，她自己看完写一段总结。
 * 这里锁住四件事：写入去重、zone 白名单、按天取、目录块要带上见闻提示。
 */
test('见闻区：写入 / 同日去重 / 非法 zone 拒绝', () => {
  const first = mod.insertZoneNote({ zone: 'bili', text: '看了三期剪辑教学，前两期在讲素材整理，最后一期讲转场，学到个交叉淡化的小技巧。', items: ['BV1xx411c7mD'], day: DAY, at: T0, db });
  assert.equal(first.ok, true);
  assert.ok(first.id > 0);
  const dup = mod.insertZoneNote({ zone: 'bili', text: '看了三期剪辑教学，前两期在讲素材整理，最后一期讲转场，学到个交叉淡化的小技巧。', items: [], day: DAY, at: T0 + 1000, db });
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicated, true, '同一段话一天只留一条');
  assert.equal(dup.id, first.id);
  assert.equal(mod.insertZoneNote({ zone: 'nope', text: '不该写进去的一段话', day: DAY, db }).ok, false);
  const rows = mod.listZoneNotes({ zone: 'bili', db });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].items, ['BV1xx411c7mD']);
});

test('见闻区：两个区互不串、按天取、统计', () => {
  mod.insertZoneNote({ zone: 'qzone', text: '刷到一个卖旧相机的，配图是雪天窗台，拍了很久的那类照片，看着挺安静。', day: DAY, at: T0 + 2000, db });
  mod.insertZoneNote({ zone: 'bili', text: '昨天看的是开箱，没什么意思，看了十分钟就关了，不如去剪片子。', day: '2026-11-12', at: T0 - 86400000, db });
  assert.equal(mod.listZoneNotes({ zone: 'bili', db }).length, 2);
  assert.equal(mod.listZoneNotes({ zone: 'qzone', db }).length, 1);
  assert.equal(mod.listZoneNotes({ zone: 'bili', day: DAY, db }).length, 1, '按天取只回当天');
  const s = mod.zoneStats({ db });
  assert.equal(s.bili.total, 2);
  assert.equal(s.qzone.total, 1);
  assert.ok(s.bili.lastAt >= s.qzone.lastAt - 86400000);
  assert.match(mod.formatZoneNotesForModel(mod.listZoneNotes({ zone: 'bili', db }), { zone: 'bili' }), /B站/);
});

test('见闻区：目录块自带「先查这两个区」的提示', () => {
  const text = mod.formatCatalogForModel(mod.catalog({ ownerId: '1000000001', db }), { titles: 8, maxChars: 600 });
  assert.match(text, /［见闻］/, '目录里要出现见闻行，否则她不知道有这两个区');
  assert.match(text, /stellar_memory_zone/);
});

test('见闻区：删一条 / 清空一个区', () => {
  const one = mod.listZoneNotes({ zone: 'bili', db })[0];
  assert.equal(mod.deleteZoneNote(one.id, { db }).deleted, 1);
  assert.equal(mod.listZoneNotes({ zone: 'bili', db }).length, 1);
  const out = mod.clearZoneNotes({ zone: 'qzone', db });
  assert.equal(out.deleted, 1);
  assert.equal(mod.listZoneNotes({ zone: 'qzone', db }).length, 0);
  assert.equal(mod.zoneStats({ db }).qzone.total, 0);
});

test('旁观话题：群里她没插话也要存下来，但绝不进重要晋升', () => {
  const rows = [
    { id: 201, ck: 'group:1132808329', oid: 'group:1132808329', role: 'user', speaker_id: '1000000003', speaker_name: '测试员A', text: '周末去爬山吗？', at: T0 + 5 * 3600 * 1000, day_key: DAY },
    { id: 202, ck: 'group:1132808329', oid: 'group:1132808329', role: 'user', speaker_id: '1000000001', speaker_name: '示例主人', text: '我周六有空', at: T0 + 5 * 3600 * 1000 + 20000, day_key: DAY },
  ];
  for (const r of rows) {
    db.prepare('INSERT INTO cache_msg (id, conversation_key, owner_id, speaker_id, speaker_name, role, kind, text, at, day_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.ck, r.oid, r.speaker_id, r.speaker_name, r.role, 'text', r.text, r.at, r.day_key);
  }
  // 不显式要求旁观 → 仍然拒绝（别人在她不在场时说话，不该冒充成她的经历）
  const refuse = insertTopic({ db, rows, topic: { ownerId: 'group:1132808329', conversationKey: 'group:1132808329', dayKey: DAY, title: '爬山' } });
  assert.equal(refuse.ok, false);
  // 显式 scope=ambient → 存下来，importance 被压到 0、tier 是 daily
  const ok = insertTopic({ db, rows, topic: { scope: 'ambient', ownerId: 'group:1132808329', conversationKey: 'group:1132808329', dayKey: DAY, title: '爬山', importance: 90 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.scope, 'ambient');
  const saved = db.prepare('SELECT scope, tier FROM topic WHERE id = ?').get(ok.id);
  assert.equal(saved.scope, 'ambient');
  assert.equal(saved.tier, 'daily');

  // 参与人索引：按人查得到这条旁观话题，群里也有名册
  const people = listTopicParticipants(ok.id, { db });
  assert.deepEqual(people.map((x) => x.qq).sort(), ['1000000001', '1000000003']); // 换成假号后字典序变了，按 new 排序写
  const forA = topicsForPerson('1000000003', { db });
  assert.ok(forA.some((t) => t.id === ok.id), '按人查应该能查到他在群里参与过的旁观话题');
  assert.ok(groupRoster('group:1132808329', { db }).some((r) => r.qq === '1000000003'));

  // 目录里必须带参与人与 [旁观] 标记，否则她分不清这是自己经历还是旁听
  const cat = catalog({ ownerId: 'group:1132808329', db });
  const hit = cat.rows.find((r) => r.id === ok.id);
  assert.ok(hit && hit.scope === 'ambient');
  assert.ok(Array.isArray(hit.participants) && hit.participants.length === 2);
  const text = formatCatalogForModel(cat, { titles: 8, maxChars: 600 });
  assert.match(text, /［群里的人］/);
  assert.match(text, /1000000003/);
  assert.match(text, /\[旁观\]/);
});

test('窗口默认留 3 天（D-3，2026-11-22 主人改）', () => {
  const now = new Date('2026-11-26T10:00:00+08:00').getTime();
  const due = worker.windowDue({ now, db });
  assert.equal(due.due, true);
  assert.equal(due.targetDay, '2026-11-23', '11-26 复核，清的是 ≤11-23（三天前）');
});

test('群话题「人类只有她+主人」私聊也能召回（2026-11-22）', () => {
  const day = '2026-11-22';
  const ck = 'group:1132808329';
  const ins = db.prepare('INSERT INTO cache_msg (id, conversation_key, owner_id, speaker_id, speaker_name, role, kind, text, at, day_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const rows = [
    { id: 9101, role: 'user', sid: '1000000001', name: '主人', text: '塔斯汀套餐', at: T0 + 600000 },
    { id: 9102, role: 'self', sid: '1000000002', name: '她', text: '塔斯汀啊，还成，比泡面强点', at: T0 + 608000 },
  ];
  for (const r of rows) ins.run(r.id, ck, ck, r.sid, r.name, r.role, 'text', r.text, r.at, day);
  const solo = insertTopic({
    db,
    rows: rows.map((r) => ({ id: r.id, ck, oid: ck, role: r.role, speaker_id: r.sid, speaker_name: r.name, text: r.text, at: r.at, day_key: day })),
    topic: { ownerId: ck, conversationKey: ck, dayKey: day, title: '塔斯汀套餐', summary: '塔斯汀套餐 / 还成', importance: 10 },
  });
  assert.equal(solo.ok, true);
  assert.ok(soloGroupTopicIds('1000000001', { db }).includes(solo.id), '私聊视角应认出这条群话题');
  const priv = catalog({ ownerId: '1000000001', db, limit: 50 });
  const hit = priv.rows.find((r) => r.id === solo.id);
  assert.ok(hit, '私聊目录里要有这条');
  assert.equal(hit.viaGroup, true);
  assert.match(formatCatalogForModel(priv, { titles: 20, maxChars: 4000 }), /塔斯汀套餐[\s\S]*〔群〕/);
  const grp = catalog({ ownerId: ck, db, limit: 50 });
  assert.ok(grp.rows.some((r) => r.id === solo.id), '群视角照旧看得到');
  const found = search({ q: '塔斯汀套餐', ownerId: '1000000001', db });
  assert.ok(found.some((r) => r.ref_id === solo.id), '私聊关键词检索也要能搜到');
  assert.match(formatSearchForModel(found, { currentOwner: '1000000001' }), /〔群〕/);
  assert.ok(!/别转述/.test(formatSearchForModel(found, { currentOwner: '1000000001' })), '自己说过的话不该标成别人的');
});

test('群里有别人的话题不会漏进私聊目录', () => {
  const priv = catalog({ ownerId: '1000000001', db, limit: 50 });
  const leaked = priv.rows.filter((r) => String(r.conversation_key || '').startsWith('group:') && r.scope === 'ambient');
  assert.equal(leaked.length, 0, '旁观话题属于群，不属于私聊');
});
