/**
 * 重要事实（fact 表 + memory-facts.js 抽取）回归：全部在临时 fixture 里跑，不碰真实记忆目录。
 *
 * 覆盖：六类正则抽取（含第三人称守门）、upsert 去重与权重取高、privacy 过滤、
 *      formatFactsForModel 的 audience 分级（owner 三级 / other 只有 normal）、catalog.facts、
 *      updateFact 撞键、searchFacts 跨人、deleteFact。
 *
 * 跑法：node scripts/test-memory-facts.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-facts-'));
process.env.DSH_HOME = root;

const dbFile = path.join(root, 'fixture', 'memory.db');
const mod = await import('../src/memory-db.js');
const facts = await import('../src/memory-facts.js');
const { openDb, closeDb, upsertFact, listFacts, getFact, searchFacts, updateFact, deleteFact, factStats, formatFactsForModel, formatFactLine, catalog, insertTopic } = mod;

const OWNER = '1000000001';
const OTHER = '1000000003';
const db = openDb({ file: dbFile });

test.after(() => {
  try { closeDb({ file: dbFile }); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('fact 表建好了（SCHEMA_VERSION 3）', () => {
  assert.equal(mod.SCHEMA_VERSION, 3);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(names.includes('fact'), '缺少 fact 表');
});

test('抽取：生日是第一人称才算，第三人称不记到说话人头上', () => {
  const a = facts.extractFacts('我生日是1月1');
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'birthday');
  assert.equal(a[0].text, '生日是1月1日');
  assert.equal(a[0].privacy, 'private');
  assert.equal(a[0].weight, 5);
  assert.deepEqual(facts.extractFacts('他生日是1月1'), []);
  assert.deepEqual(facts.extractFacts('你生日是1月1'), []);
  assert.deepEqual(facts.extractFacts('朋友生日是1月1'), []);
  assert.equal(facts.extractFacts('1月1日是我的生日')[0].text, '生日是1月1日');
  assert.deepEqual(facts.extractFacts('生日是13月40日'), []);
});

test('抽取：忌口 / 过敏 / 喜好 / 地址 / 手机 / 称呼', () => {
  const dislike = facts.extractFacts('我不吃香菜');
  assert.equal(dislike[0].kind, 'dislike');
  assert.equal(dislike[0].text, '不吃香菜');
  assert.equal(dislike[0].privacy, 'private');
  // 「我喜欢吃辣」不能被记成「不吃辣」
  const like = facts.extractFacts('我最喜欢吃辣');
  assert.equal(like[0].kind, 'like');
  assert.ok(!like.some((f) => f.kind === 'dislike'));
  const allergy = facts.extractFacts('我对花生过敏');
  assert.equal(allergy[0].kind, 'allergy');
  assert.equal(allergy[0].text, '对花生过敏');
  assert.equal(allergy[0].weight, 5);
  const addr = facts.extractFacts('我住在杭州西湖区');
  assert.equal(addr[0].kind, 'address');
  assert.equal(addr[0].privacy, 'secret');
  const phone = facts.extractFacts('我手机是13800001111');
  assert.equal(phone[0].kind, 'contact');
  assert.equal(phone[0].privacy, 'secret');
  const nick = facts.extractFacts('叫我小土就行');
  assert.equal(nick[0].kind, 'nickname');
  // 没信息量的不收
  assert.deepEqual(facts.extractFacts('我喜欢你'), []);
  assert.equal(facts.looksFactful('嗯嗯'), false);
  assert.equal(facts.looksFactful('我生日是1月1'), true);
});

test('upsert 去重：同人同 kind 同 label 只留一条，权重取高', () => {
  const r1 = upsertFact({ db, ownerId: OWNER, kind: 'birthday', label: '生日', text: '生日是1月1日', privacy: 'private', weight: 5, source: 'auto' });
  assert.equal(r1.ok, true);
  const r2 = upsertFact({ db, ownerId: OWNER, kind: 'birthday', label: '生日', text: '生日是1月1日（农历五月）', privacy: 'private', weight: 3, source: 'auto' });
  assert.equal(r2.id, r1.id);
  const row = getFact(r1.id, { db });
  assert.equal(row.text, '生日是1月1日（农历五月）');
  assert.equal(row.weight, 5, '权重应该取更高的那个');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fact WHERE owner_id = ?').get(OWNER).n, 1);
});

test('privacy 过滤 + 空内容拒绝', () => {
  const r = upsertFact({ db, ownerId: OTHER, kind: 'contact', label: '联系方式', text: '手机 13800001111', privacy: 'secret', weight: 4 });
  assert.equal(r.ok, true);
  assert.deepEqual(listFacts({ ownerId: OTHER, privacy: 'normal', db }).map((f) => f.id), []);
  assert.equal(listFacts({ ownerId: OTHER, privacy: 'secret', db }).length, 1);
  assert.equal(listFacts({ ownerId: OTHER, db }).length, 1);
  const empty = upsertFact({ db, ownerId: OWNER, kind: 'note', label: '空', text: '   ' });
  assert.equal(empty.ok, false);
});

test('formatFactsForModel：owner 给三级，其他人只给 normal', () => {
  const rows = listFacts({ ownerId: OWNER, db });
  const own = formatFactsForModel(rows, { audience: 'owner', who: '主人' });
  assert.match(own, /生日是1月1日/);
  assert.match(own, /只在跟他本人说话时提/);
  const other = formatFactsForModel(rows, { audience: 'other', who: '主人' });
  assert.equal(other, '', 'private 级不该出现在别人面前');
  const normalOnly = formatFactsForModel([{ kind: 'like', kindLabel: '喜欢', text: '喜欢猫', privacy: 'normal' }], { audience: 'other' });
  assert.match(normalOnly, /喜欢猫/);
  assert.equal(formatFactsForModel([], { audience: 'owner' }), '');
});

test('formatFactLine 带 id / 隐私级 / 权重', () => {
  const row = listFacts({ ownerId: OWNER, db })[0];
  const line = formatFactLine(row);
  assert.match(line, new RegExp('#' + row.id));
  assert.match(line, /只本人对话/);
  assert.match(line, /权重 5/);
});

test('searchFacts：current 只查本人，all 才跨人', () => {
  assert.equal(searchFacts({ q: '1月1', ownerId: OTHER, db }).length, 0);
  assert.equal(searchFacts({ q: '1月1', ownerId: OWNER, db }).length, 1);
  assert.equal(searchFacts({ q: '1月1', ownerId: OWNER, scope: 'all', db }).length, 1);
  assert.equal(searchFacts({ q: '138', ownerId: OWNER, scope: 'all', db }).length, 1);
  assert.deepEqual(searchFacts({ q: '', ownerId: OWNER, db }), []);
});

test('updateFact 撞键要能报出来，不许静默覆盖', () => {
  const like = upsertFact({ db, ownerId: OWNER, kind: 'like', label: '喜欢', text: '喜欢猫', privacy: 'normal', weight: 3 });
  const bd = listFacts({ ownerId: OWNER, db }).find((f) => f.kind === 'birthday');
  const bad = updateFact(like.id, { kind: 'birthday', label: '生日', text: '喜欢猫' }, { db });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'duplicate');
  assert.equal(bad.existsId, bd.id);
  const good = updateFact(like.id, { text: '喜欢猫和咖啡' }, { db });
  assert.equal(good.ok, true);
  assert.equal(getFact(like.id, { db }).text, '喜欢猫和咖啡');
  const missing = updateFact(999999, { text: 'x' }, { db });
  assert.equal(missing.reason, 'not found');
});

test('catalog 带上事实条数（不然她不知道事实区存在）', () => {
  insertTopic({ db, topic: { id: 'tp_x', ownerId: OWNER, conversationKey: 'private:' + OWNER, dayKey: '2026-11-13', title: 't', summary: 's', tier: 'important', importance: 90, msgCount: 2, startedAt: Date.now() - 1000, endedAt: Date.now() }, rows: [] });
  const c = catalog({ ownerId: OWNER, db });
  assert.ok(c.facts && c.facts.total >= 1);
  const st = factStats({ ownerId: OWNER, db });
  assert.equal(st.total, c.facts.total);
});

test('deleteFact 真删', () => {
  const r = upsertFact({ db, ownerId: OWNER, kind: 'note', label: '临时的', text: '删我' });
  assert.equal(deleteFact(r.id, { db }).ok, true);
  assert.equal(getFact(r.id, { db }), null);
});
