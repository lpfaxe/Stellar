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

// 2026-11-19 修：原来硬编码 2026-11-11 / 2026-11-12，而 profileCandidates() 只取
// 「最近 7 天」（ended_at >= Date.now() - 7d）。日期一滑出窗口，侧写用例全部返回空候选，
// 复核用例不走窗口所以照过 —— 看起来像回归、其实是测试自己的时间在漂。改成相对今天算。
function dayOffset(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const D1 = dayOffset(2); // 前天
const D2 = dayOffset(1); // 昨天

function add(role, text, at, extra = {}) {
  return db.append({
    conversationKey: extra.key || 'private:111',
    ownerId: extra.ownerId || '111',
    speakerId: role === 'self' ? '2601728971' : (extra.ownerId || '111'),
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

test('侧写：输出被截断时仍能抠出 persona（2026-11-16 回归）', () => {
  // 真实故障形态：maxTokens 不够，JSON 停在 detail 中间，没有收尾的 }
  const truncated = '{"persona":"一个爱折腾抢票脚本的人","detail":"聊抢票脚本（票约10秒售罄，15号还有一场';
  const parsed = worker.parseProfileJson(truncated);
  assert.equal(parsed.partial, true, '应判为截断兜底');
  assert.equal(parsed.obj.persona, '一个爱折腾抢票脚本的人');
  assert.equal(parsed.obj.detail, undefined, '截断时不要硬编 detail');
  // 带代码围栏 + 前后废话的完整 JSON 仍要整段解析
  const fenced = String.fromCharCode(96, 96, 96) + 'json' + String.fromCharCode(10) + '{"persona":"阿星","detail":"喜欢原神","tags":["游戏"]}' + String.fromCharCode(10) + String.fromCharCode(96, 96, 96);
  const full = worker.parseProfileJson(fenced);
  assert.equal(full.partial, false);
  assert.equal(full.obj.persona, '阿星');
  assert.deepEqual(full.obj.tags, ['游戏']);
  // 完全不是 JSON：两头都不认
  assert.deepEqual(worker.parseProfileJson('我觉得这个人挺有意思的'), { obj: null, partial: false });
});

test('侧写：第一遍拿不到 JSON 会用关思考的模式重试一次', async () => {
  const base = Date.parse(D2 + 'T12:00:00');
  add('user', '我在写一个抢票脚本', base, { ownerId: '444', key: 'private:444' });
  add('self', '先拿不重要的场次练手', base + 60000, { ownerId: '444', key: 'private:444' });
  worker.runSplit({});
  const calls = [];
  const ask = async (args) => {
    calls.push({ maxTokens: args.maxTokens, reasoningEffort: args.reasoningEffort, user: args.user });
    if (calls.length === 1) return '先说结论：这个人挺能折腾的（没给 JSON）';
    return JSON.stringify({ persona: '爱折腾抢票脚本的人', detail: '写抢票脚本，先练手再上正赛', tags: ['技术'] });
  };
  const res = await worker.runProfiles({ ask, log: () => {} });
  const row = db.getProfile('444');
  assert.equal(row.persona, '爱折腾抢票脚本的人', '重试后应写进去');
  assert.equal(res.errors.some((e) => e.includes('444')), false);
  assert.equal(calls.length >= 2, true, '应至少调用两次');
  assert.equal(calls[0].maxTokens, 1200, '第一遍预算要比原来的 500 宽');
  assert.equal(calls[1].reasoningEffort, 'off', '第二遍关掉思考，把预算全给输出');
  assert.match(calls[1].user, /只输出一行 JSON/, '第二遍要再压一次格式');
});

test('侧写：两遍都不是 JSON 时错误里带原文片段，便于定位', async () => {
  const ask = async () => '这个人很好（永远不给 JSON）';
  const res = await worker.runProfiles({ ask, log: () => {} });
  assert.equal(res.ok, false);
  assert.equal(res.errors.some((e) => e.includes('原文：')), true, '错误要带原文片段');
});

test('侧写：第一遍只给了 detail 没有 persona，也要重试', async () => {
  const base = Date.parse(D2 + 'T13:00:00');
  add('user', '我周末都在家', base, { ownerId: '555', key: 'private:555' });
  add('self', '那正好休息', base + 60000, { ownerId: '555', key: 'private:555' });
  worker.runSplit({});
  // runProfiles 会把所有候选都过一遍，所以只统计「这条」候选的调用次数。
  const mine = [];
  const ask = async (args) => {
    const user = String((args && args.user) || '');
    if (!user.includes('我周末都在家')) return JSON.stringify({ persona: '别人的侧写', detail: '', tags: [] });
    mine.push(1);
    if (mine.length === 1) return JSON.stringify({ detail: '周末都在家', tags: ['宅'] });
    return JSON.stringify({ persona: '周末爱待在家的人', detail: '周末都在家', tags: ['宅'] });
  };
  await worker.runProfiles({ ask, log: () => {} });
  assert.equal(mine.length, 2, '缺 persona 要再试一次');
  assert.equal(db.getProfile('555').persona, '周末爱待在家的人');
});

test('侧写：零碎不能被截成 60 字（生日被砍成 6月2 的回归）', async () => {
  // 真实故障：fragment 也按 maxChars=60 截，于是「生日是6月29日」变成「生日是6月2」，
  // 模型照着写出「6月2日生日」。标题可以短，零碎必须完整。
  const base = Date.parse(D2 + 'T08:00:00');
  const long = 'hello？ 把你记忆全清真不好意思 已经给你装上新记忆系统了 我是你的主人 生日是6月29日 目前在安徽宣城读大一';
  add('user', long, base, { ownerId: '666', key: 'private:666' });
  add('user', '明天要考试', base + 3600000, { ownerId: '666', key: 'private:666' });
  add('self', '那早点睡', base + 3660000, { ownerId: '666', key: 'private:666' });
  worker.runSplit({});
  const cand = worker.profileCandidates({}).find((c) => c.ownerId === '666');
  assert.ok(cand, '应有候选');
  const joined = cand.frags.join(' / ');
  assert.ok(joined.includes('生日是6月29日'), '完整日期必须保留：' + joined);
  assert.ok(!/生日是6月2[^9]/.test(joined), '不允许出现被砍断的 6月2');
  const prompt = worker.buildProfilePrompt(cand);
  assert.ok(prompt.includes('不要补全、不要猜数字和日期'), '提示词要提醒断口');
});
