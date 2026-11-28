/**
 * 做梦（memory-worker.js runDream）：读原文 → 改标题/写主体页/路由零碎 → 打 dreamed_at。
 * 硬规则：模型坏/JSON 坏时一个字都不写；没做梦的 daily 话题 prune 必须留着缓存。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-dream-'));
process.env.DSH_HOME = root;
const charDir = path.join(root, 'stellar', 'characters', 'deepseek');
fs.mkdirSync(path.join(charDir, 'memory'), { recursive: true });
fs.writeFileSync(path.join(root, 'stellar', 'characters', 'current.json'), JSON.stringify({ id: 'deepseek' }), 'utf8');

const dbmod = await import('../src/memory-db.js');
const worker = await import('../src/memory-worker.js');
const db = dbmod.openDb({});
const NOW = Date.now();
const DAY = dbmod.dayKey(NOW);
const OWNER = '3025145051';
let seq = 0;
function makeTopic(title, text, opts = {}) {
  seq += 1;
  const rows = [
    { id: 100 + seq * 2, conversation_key: 'private:' + OWNER, owner_id: OWNER, speaker_id: OWNER, speaker_name: '主人', role: 'user', kind: 'text', text, at: NOW - 120000 + seq * 1000, day_key: DAY },
    { id: 101 + seq * 2, conversation_key: 'private:' + OWNER, owner_id: OWNER, speaker_id: '2601728971', speaker_name: '她', role: 'self', kind: 'text', text: '好，我记下了', at: NOW - 60000 + seq * 1000, day_key: DAY },
  ];
  return dbmod.insertTopic({ db, rows, topic: { ownerId: OWNER, conversationKey: 'private:' + OWNER, dayKey: opts.dayKey || DAY, title, summary: '', importance: opts.importance || 10 } });
}

test.after(() => {
  try { dbmod.closeDb({}); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

test('候选只读最近未整理的原文；零碎带 inbox', () => {
  const t = makeTopic('旧标题', '第七章的思维导图要按 4 层重画，他说上次那版太挤。');
  const f = dbmod.insertFragment({ db, ownerId: OWNER, text: '他喜欢 4 层以内的思维导图', at: NOW, day: DAY, facet: 'preference' });
  const cand = worker.dreamCandidates({ now: NOW, db, days: 3 });
  const hit = cand.topics.find((x) => x.id === t.id);
  assert.ok(hit, '新话题必须进候选');
  assert.match(hit.text, /第七章的思维导图/);
  assert.match(hit.text, /她：好，我记下了/);
  assert.ok(cand.fragments.some((x) => x.id === f.id && x.status === 'inbox'), JSON.stringify({ f, frags: cand.fragments }));
  assert.ok(worker.dreamBacklog({ targetDay: DAY, db }) >= 1);
  const prompt = worker.buildDreamPrompt(cand);
  assert.match(prompt, /标题要一眼看出/);
  assert.match(prompt, /pages 是「对这个人/);
});

test('模型给出 JSON：改标题/写页/路由零碎/打 dreamed_at', async () => {
  const t = makeTopic('改名前的标题', '他说明天要交无机化学第七章的导图，先做 7.1 到 7.3。');
  const f = dbmod.insertFragment({ db, ownerId: OWNER, text: '他明天要交第七章导图', at: NOW, day: DAY, facet: 'plan' });
  let seen = '';
  const ask = async (args) => {
    seen = args.user;
    return JSON.stringify({
      topics: [{ id: t.id, title: '第七章导图要交了', summary: '他明天交无机化学第七章导图，先做 7.1–7.3。' }],
      pages: [{ topic: t.id, title: '关于第七章导图', body: '他明天要交无机化学第七章导图，范围先做 7.1–7.3。', links: ['无机化学'] }],
      fragments: [{ id: f.id, status: 'promoted', note: 'fact:近期任务' }],
      reason: '整理第七章任务',
    });
  };
  const res = await worker.runDream({ now: NOW, db, ask, force: true });
  assert.equal(res.ok, true);
  assert.equal(res.renamed, 1);
  assert.equal(res.pages, 1);
  assert.equal(res.fragments, 1);
  assert.match(seen, /第七章导图要交了|第七章/);
  const row = db.prepare('SELECT title, summary, dreamed_at, title_source FROM topic WHERE id = ?').get(t.id);
  assert.equal(row.title, '第七章导图要交了');
  assert.match(row.summary, /7\.1/);
  assert.ok(Number(row.dreamed_at) > 0);
  assert.equal(row.title_source, 'dream');
  const sub = dbmod.subjectForOwner(OWNER, { db });
  const pages = dbmod.listPages({ subjectId: sub.id, db });
  assert.ok(pages.some((p) => p.title === '关于第七章导图'));
  const fr = db.prepare('SELECT status, routed_to FROM fragment WHERE id = ?').get(f.id);
  assert.equal(fr.status, 'promoted');
  assert.match(String(fr.routed_to), /fact/);
  const js = dbmod.jobState('dream', { db });
  assert.equal(js.state, 'done');
});

test('模型坏 / JSON 坏：不写标题、不打 dreamed_at、prune 被拦', async () => {
  const t = makeTopic('不能改的标题', '这段原文必须留着，等下一次做梦再整理。');
  const before = db.prepare('SELECT title, dreamed_at FROM topic WHERE id = ?').get(t.id);
  const res = await worker.runDream({ now: NOW + 1000, db, ask: async () => '这不是 JSON', force: true });
  assert.equal(res.ok, false);
  const after = db.prepare('SELECT title, dreamed_at FROM topic WHERE id = ?').get(t.id);
  assert.equal(after.title, before.title);
  assert.equal(Number(after.dreamed_at), 0);
  assert.equal(dbmod.jobState('dream', { db }).state, 'failed');
  const review = await worker.runReview({ now: NOW + 2000, db, force: true, targetDay: DAY, ask: async () => JSON.stringify({ promote: [], reason: 'test' }) });
  assert.ok(Array.isArray(review.errors) && review.errors.some((e) => e.startsWith('prune-deferred')), '还有没做梦的话题时必须拦住 prune');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM topic WHERE id = ?').get(t.id).n === 1);
});

test('做梦不改 manual 标题', async () => {
  const t = makeTopic('旧标题', '手动锁标题的测试原文，说明天再说。');
  dbmod.updateTopicTitle({ topicId: t.id, title: '主人手动定的标题', summary: '', source: 'manual', db });
  const res = await worker.runDream({ now: NOW + 3000, db, ask: async () => JSON.stringify({ topics: [{ id: t.id, title: 'dream 想改', summary: '' }], pages: [], fragments: [], reason: '' }), force: true });
  assert.equal(res.renamed, 0);
  assert.equal(db.prepare('SELECT title FROM topic WHERE id = ?').get(t.id).title, '主人手动定的标题');
});

test('当天做过一次就不再重复做（白天新话题留到明天）', () => {
  makeTopic('白天新话题', '这条是 06:30 之后才出现的，今天不该再触发一次做梦。');
  const due = worker.dreamDue({ now: NOW + 4000, db });
  assert.equal(due.due, false);
  assert.equal(due.reason, 'done-today');
  assert.ok(worker.dreamBacklog({ targetDay: DAY, db }) >= 1);
});

