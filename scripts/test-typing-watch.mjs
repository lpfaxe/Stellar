/**
 * 「正在输入」观测 + 滑动合并窗口（2026-11-25，主人 m08651）。
 *
 * 断言的是三件事：
 *   ① 只认私聊的 input_status 通知，其它 notify（拍一拍）与群事件一律不认；
 *   ② 窗口是滑动的：又来一条就顺延，但绝不越过硬上限（普通 15 秒 / 打字中 60 秒）；
 *   ③ 日志按天滚动，统计只数今天、只输出枚举（不写正文）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function load(name) {
  return import(pathToFileURL(path.join(ROOT, name)).href);
}

const T = await load('src/typing-watch.js');
const W = await load('src/wake-batch.js');

// ── 1. 认事件 ───────────────────────────────────────────────────────────
test('typingEventOf：只认私聊的 input_status', async () => {
  const owner = { ownerQQ: '3025145051' };
  const evt = T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    user_id: 3025145051, self_id: 2601728971, event_type: 1
  }, owner);
  assert.equal(evt.key, 'private:3025145051');
  assert.equal(evt.userId, '3025145051');
  assert.equal(evt.state, 1);
  assert.equal(evt.typing, true);
  assert.equal(evt.isOwner, true);

  // 停止输入
  const stop = T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    user_id: '3025145051', event_type: 0
  }, owner);
  assert.equal(stop.typing, false);
  assert.equal(stop.state, T.INPUT_STATE.STOP);

  // 说话中（event_type=3）也算「还没说完」
  const speaking = T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    user_id: '3025145051', event_type: 3
  }, owner);
  assert.equal(speaking.typing, true);

  // eventType 驼峰也认（不同运行时字段名不一样）
  const camel = T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    user_id: '3025145051', eventType: 1
  }, owner);
  assert.equal(camel.state, 1);
});

test('typingEventOf：拍一拍、群事件、自己发的、坏值全部不认', async () => {
  const owner = { ownerQQ: '3025145051' };
  // 拍一拍：同类 notify 但不是我们的事
  assert.equal(T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 3025145051
  }, owner), null);
  // 群聊没有这个推送；就算有也不该当成「某个人在跟你说话」
  assert.equal(T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    group_id: 1132808329, user_id: 3025145051, event_type: 1
  }, owner), null);
  // 不是 notify
  assert.equal(T.typingEventOf({
    post_type: 'notice', notice_type: 'group_upload', user_id: 3025145051, event_type: 1
  }, owner), null);
  // 自己
  assert.equal(T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    user_id: 2601728971, self_id: 2601728971, event_type: 1
  }, owner), null);
  // 不认识的 event_type
  assert.equal(T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    user_id: 3025145051, event_type: 9
  }, owner), null);
  // 脏 user_id
  assert.equal(T.typingEventOf({
    post_type: 'notice', notice_type: 'notify', sub_type: 'input_status',
    user_id: 'abc', event_type: 1
  }, owner), null);
  // 空对象 / null
  assert.equal(T.typingEventOf(null, owner), null);
  assert.equal(T.typingEventOf({}, owner), null);
});

// ── 2. 配置归一 ─────────────────────────────────────────────────────────
test('normalizeTypingConfig：坏值一律回落默认，不抛错', async () => {
  const d = T.normalizeTypingConfig({});
  assert.equal(d.enabled, true);
  assert.equal(d.logKeepDays, 7);
  assert.equal(d.privateMs, 2000);
  assert.equal(d.extendMs, 2000);
  assert.equal(d.maxWindowMs, 15000);
  assert.equal(d.maxTypingMs, 60000);
  // 关掉只认显式 false
  assert.equal(T.normalizeTypingConfig({ enabled: false }).enabled, false);
  assert.equal(T.normalizeTypingConfig({ enabled: 0 }).enabled, true);
  // 越界夹紧
  const clamp = T.normalizeTypingConfig({ privateMs: 1, extendMs: 999999, maxWindowMs: 1, maxTypingMs: 1, logKeepDays: 999 });
  assert.ok(clamp.privateMs >= 500);
  assert.ok(clamp.extendMs <= 10000);
  assert.ok(clamp.maxWindowMs >= 2000);
  assert.ok(clamp.maxTypingMs >= 5000);
  assert.ok(clamp.logKeepDays <= 30);
  // 乱传也不炸
  assert.doesNotThrow(() => T.normalizeTypingConfig(null));
  assert.doesNotThrow(() => T.normalizeTypingConfig('nope'));
});

// ── 3. 滑动窗口 ─────────────────────────────────────────────────────────
test('nextWindowDelay：又来一条就顺延，但不越过 15 秒上限', async () => {
  const cfg = T.normalizeTypingConfig({});
  const t0 = 1_000_000;
  // 第一条：2 秒后发
  let plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0, now: t0, cfg });
  assert.equal(plan.delayMs, 2000);
  assert.equal(plan.reason, 'window');
  // 第 1.9 秒又来一条：从这一条重新数 2 秒（而不是 0.1 秒后就发）
  plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0 + 1900, now: t0 + 1900, cfg });
  assert.equal(plan.delayMs, 2000);
  // 一直有人说话：最后停在 firstAt + 15000
  plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0 + 14900, now: t0 + 14900, cfg });
  assert.equal(plan.delayMs, 100);
  assert.equal(plan.deadline, t0 + 15000);
  // 已经超过上限：马上发
  plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0 + 20000, now: t0 + 20000, cfg });
  assert.equal(plan.delayMs, 0);
  assert.equal(plan.reason, 'window-expired');
});

test('nextWindowDelay：对方在打字时继续等，但 60 秒必发', async () => {
  const cfg = T.normalizeTypingConfig({});
  const t0 = 1_000_000;
  // 1 秒时对方开始打字：推到「最后一条打字事件 + 2 秒」
  let plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0, lastTypingAt: t0 + 1000, typingNow: true, now: t0 + 1000, cfg });
  assert.equal(plan.reason, 'typing');
  assert.equal(plan.delayMs, 2000);
  // 对方持续打字到第 59 秒：还能等，但只到 t0+60000
  plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0, lastTypingAt: t0 + 59000, typingNow: true, now: t0 + 59000, cfg });
  assert.equal(plan.deadline, t0 + 60000);
  assert.equal(plan.delayMs, 1000);
  // 打完第 60 秒后还在打：也立刻发（硬上限）
  plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0, lastTypingAt: t0 + 61000, typingNow: true, now: t0 + 61000, cfg });
  assert.equal(plan.delayMs, 0);
  assert.equal(plan.reason, 'typing-expired');
  // 停手了：回到普通窗口（但普通窗口早过期，于是立刻发）
  plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0, lastTypingAt: t0 + 5000, typingNow: false, now: t0 + 5000, cfg });
  assert.equal(plan.delayMs, 0);
  assert.equal(plan.reason, 'window-expired');
});

test('nextWindowDelay：打字中的截止不会比普通窗口更早', async () => {
  const cfg = T.normalizeTypingConfig({ privateMs: 2000, extendMs: 2000 });
  const t0 = 1_000_000;
  // 第 1.5 秒开始打字：普通窗口本来 t0+2000 到期，打字把它推到 t0+3500
  const plan = T.nextWindowDelay({ firstAt: t0, lastAt: t0, lastTypingAt: t0 + 1500, typingNow: true, now: t0 + 1500, cfg });
  assert.ok(plan.deadline >= t0 + 3500);
});

// ── 4. 日志滚动与统计 ───────────────────────────────────────────────────
test('typingLogLine：只写枚举，不写正文也不写 token', async () => {
  const line = T.typingLogLine({ key: 'private:3025145051', state: 1, isOwner: true }, 1_700_000_000_000);
  const obj = JSON.parse(line);
  assert.deepEqual(Object.keys(obj).sort(), ['at', 'key', 'owner', 'state']);
  assert.equal(obj.key, 'private:3025145051');
  assert.equal(obj.state, 1);
  assert.equal(obj.owner, true);
  assert.ok(!/token|SESSDATA|message/i.test(line));
  assert.equal(T.typingLogLine(null), null);
});

test('pruneTypingLog：只留最近 7 天，坏行丢掉', async () => {
  const now = Date.parse('2026-11-25T12:00:00.000Z');
  const keepOld = now - 3 * 86400_000;
  const dropOld = now - 8 * 86400_000;
  const text = [
    JSON.stringify({ at: new Date(dropOld).toISOString(), key: 'private:1', state: 1 }),
    JSON.stringify({ at: new Date(keepOld).toISOString(), key: 'private:2', state: 1 }),
    'not json at all',
    JSON.stringify({ at: new Date(now).toISOString(), key: 'private:3', state: 0 }),
    ''
  ].join('\n');
  const pruned = T.pruneTypingLog(text, { now, keepDays: 7 });
  assert.equal(pruned.kept, 2);
  assert.equal(pruned.dropped, 2);
  // 新→旧
  assert.equal(pruned.entries[0].key, 'private:3');
  assert.equal(pruned.entries[1].key, 'private:2');
  // 传空文本不炸
  assert.deepEqual(T.pruneTypingLog('', { now }).kept, 0);
});

test('summarizeTypingLog：今天、最近、按会话分', async () => {
  const now = Date.parse('2026-11-25T12:00:00.000Z');
  const entries = [
    { at: new Date(now).toISOString(), key: 'private:1', state: 1 },
    { at: new Date(now - 60_000).toISOString(), key: 'private:1', state: 0 },
    { at: new Date(now - 86400_000).toISOString(), key: 'private:2', state: 1 }
  ];
  const s = T.summarizeTypingLog(entries, { now });
  assert.equal(s.total, 3);
  assert.ok(s.today >= 1);
  assert.equal(s.typing, 2);
  assert.equal(s.stop, 1);
  assert.equal(s.conversations[0].key, 'private:1');
  assert.equal(s.conversations[0].count, 2);
  assert.equal(T.summarizeTypingLog(null, { now }).total, 0);
});

// ── 5. 与合并窗口的接线 ─────────────────────────────────────────────────
test('wake-batch：私聊基准降到 2 秒，且导出判定帮手', async () => {
  assert.equal(W.DEFAULT_BATCH_WINDOWS.privateMs, 2000);
  assert.equal(W.isDirectReason('atMention'), true);
  assert.equal(W.isDirectReason('keyword:鲸鱼'), false);
  assert.equal(W.isPrivateKey('private:3025145051'), true);
  assert.equal(W.isPrivateKey('group:1132808329'), false);
  // 被点名仍然 3 秒（滑动窗口不参与）
  assert.equal(W.batchWindowFor('group:1', 'atMention', {}), 3000);
  assert.equal(W.batchWindowFor('private:1', 'private', {}), 2000);
  assert.equal(W.batchWindowFor('group:1', 'keyword:x', {}), 6000);
});
