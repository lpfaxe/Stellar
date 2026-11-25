/**
 * 「正在输入」观测 + 合并窗口的动态顺延（2026-11-25，主人 m08651：D1 直接上 C）。
 *
 * 三件事，全部是纯逻辑（零 I/O，方便直接测）：
 *  1. 认事件：SnowLuma 把 QQ 的输入状态翻成 OneBot 通知
 *     notice_type=notify / sub_type=input_status，带 user_id 与 event_type；
 *     event_type 语义：0=停手 / 1=打字 / 3=说话（3 在 QQ 里显示为「对方正在讲话」）。
 *  2. 算窗口：窗口到期时「对方还在打字」就再等一会儿，但**必须**有硬上限 ——
 *     否则对方把输入框开着去吃饭，她就永远不回（设计文档 §2 明确否掉了「无上限一直等」）。
 *  3. 记账：把事件压成一行 JSON 交给调用方 append；滚动留 7 天由 readTypingLog 负责。
 *
 * ⚠️ 这里只「看」，不碰消息：打字事件不进 unread、不升级唤醒原因、不产生额外计费。
 */

/** OneBot 通知里输入状态的 sub_type 取值。 */
export const INPUT_STATUS_SUB_TYPE = 'input_status';

/** event_type 语义（QQ 原生）。 */
export const INPUT_STATE = Object.freeze({
  STOP: 0,
  TYPING: 1,
  SPEAKING: 3
});

/** 默认值：首等 2 秒、打字时再等 2 秒、普通连发封顶 15 秒、打字中封顶 60 秒。 */
export const TYPING_DEFAULTS = Object.freeze({
  enabled: true,
  logEnabled: true,
  logKeepDays: 7,
  privateMs: 2000,
  extendMs: 2000,
  maxWindowMs: 15000,
  maxTypingMs: 60000
});

const DAY_MS = 24 * 60 * 60 * 1000;

const toInt = (value, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : fallback;
};

/** 配置收成一份（都夹在合理区间内，坏值一律回落默认，绝不抛错）。 */
export function normalizeTypingConfig(src = {}) {
  const s = src && typeof src === 'object' ? src : {};
  const days = Math.min(30, Math.max(1, toInt(s.logKeepDays, TYPING_DEFAULTS.logKeepDays)));
  return {
    enabled: s.enabled !== false,
    logEnabled: s.logEnabled !== false,
    logKeepDays: days,
    privateMs: Math.min(30000, Math.max(500, toInt(s.privateMs, TYPING_DEFAULTS.privateMs))),
    extendMs: Math.min(10000, Math.max(500, toInt(s.extendMs, TYPING_DEFAULTS.extendMs))),
    maxWindowMs: Math.min(120000, Math.max(2000, toInt(s.maxWindowMs, TYPING_DEFAULTS.maxWindowMs))),
    maxTypingMs: Math.min(300000, Math.max(5000, toInt(s.maxTypingMs, TYPING_DEFAULTS.maxTypingMs)))
  };
}

/**
 * 这条通知是不是「某人在第 key 个会话里打字」。
 *
 * 只认私聊：QQ 群没有这个推送，而且群里就算推了也说不清是谁 —— 群里一律返回 null。
 * 返回 { key, userId, state, typing } 或 null。
 */
export function typingEventOf(notice, owner = {}) {
  if (!notice || typeof notice !== 'object') return null;
  if (String(notice.post_type || '') !== 'notice') return null;
  if (String(notice.notice_type || '') !== 'notify') return null;
  if (String(notice.sub_type || '') !== INPUT_STATUS_SUB_TYPE) return null;
  // 群聊没有这个推送；就算有也不属于「某个人在跟你说话」，一律不认。
  if (notice.group_id !== undefined && notice.group_id !== null && String(notice.group_id) !== '') return null;
  const userId = String(notice.user_id ?? '').trim();
  if (!/^[1-9][0-9]{4,11}$/.test(userId)) return null;
  const self = String(notice.self_id ?? '').trim();
  if (self && self === userId) return null;
  const raw = notice.event_type ?? notice.eventType;
  const state = toInt(raw, -1);
  if (state !== INPUT_STATE.STOP && state !== INPUT_STATE.TYPING && state !== INPUT_STATE.SPEAKING) return null;
  const key = 'private:' + userId;
  const ownerId = String(owner.ownerQQ ?? '').trim();
  return {
    key,
    userId,
    state,
    typing: state !== INPUT_STATE.STOP,
    isOwner: Boolean(ownerId) && ownerId === userId
  };
}

/** 一行日志（调用方 append 到 typing-log.jsonl）。不写正文、不写 token。 */
export function typingLogLine(evt, now = Date.now()) {
  if (!evt) return null;
  return JSON.stringify({
    at: new Date(now).toISOString(),
    key: evt.key,
    state: evt.state,
    owner: evt.isOwner === true
  });
}

/**
 * 这一次该等多久（滑动窗口）。
 *
 * 语义（主人 m08651 的原话：等约 2 秒，对方还在打字就继续等）：
 *   · 基准 = 「最后一条消息」+ privateMs —— 每来一条新消息就把到期时间往后推；
 *   · 对方还在打字时 = 「最后一条打字事件」+ extendMs；
 *   · 绝对上限：普通连发从第一次排窗口起最多 maxWindowMs（15 秒），
 *     打字中可以放宽到 maxTypingMs（60 秒），但两者都**不会**无限等。
 *
 * 三道闸（设计文档 §2「必须有这三道闸，否则她会永远不回」）：
 *   ① 硬上限：不管对方打没打完，到点必发；
 *   ② 只认同一个人同一条会话 —— 由调用方保证（事件按 key 过滤后才传进来）；
 *   ③ 打字事件不算新消息 —— 由调用方保证（不进 unread、不升级唤醒原因）。
 *
 * 入参：
 *   - firstAt      第一次排窗口的时间（算绝对上限的起点）
 *   - lastAt       最后一条**消息**的时间（0 则用 firstAt）
 *   - lastTypingAt 最近一次「还在打字」事件的时间（0 = 没打过字）
 *   - typingNow    此刻对方是否仍在打字（最近一条输入事件是 typing/speaking）
 *   - cfg          normalizeTypingConfig 的产物
 * 返回 { delayMs, reason, deadline } —— delayMs<=0 表示立刻发。
 */
export function nextWindowDelay({ firstAt = 0, lastAt = 0, lastTypingAt = 0, typingNow = false, now = Date.now(), cfg = TYPING_DEFAULTS } = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : TYPING_DEFAULTS;
  const start = toInt(firstAt, 0) || now;
  const base = Math.max(0, toInt(c.privateMs, TYPING_DEFAULTS.privateMs));
  const extend = Math.max(0, toInt(c.extendMs, TYPING_DEFAULTS.extendMs));
  const hardWindow = Math.max(base, toInt(c.maxWindowMs, TYPING_DEFAULTS.maxWindowMs));
  const hardTyping = Math.max(hardWindow, toInt(c.maxTypingMs, TYPING_DEFAULTS.maxTypingMs));
  const lastMsgAt = toInt(lastAt, 0) || start;
  const windowDeadline = Math.min(lastMsgAt + base, start + hardWindow);
  if (!typingNow) {
    const delay = windowDeadline - now;
    return { delayMs: delay > 0 ? delay : 0, reason: delay > 0 ? 'window' : 'window-expired', deadline: windowDeadline };
  }
  // 对方还在打字：推到「最后一条打字事件 + extend」，但不许越过 start + hardTyping。
  const lastTyping = toInt(lastTypingAt, 0) || now;
  const typingDeadline = Math.min(Math.max(lastTyping + extend, windowDeadline), start + hardTyping);
  const delay = typingDeadline - now;
  return { delayMs: delay > 0 ? delay : 0, reason: delay > 0 ? 'typing' : 'typing-expired', deadline: typingDeadline };
}

/**
 * 读日志并滚动：只保留最近 keepDays 天，返回解析后的条目（新→旧）。
 * 纯函数（输入是原始文本），文件读写留给调用方。
 * 返回 { lines, kept, dropped, entries }。
 */
export function pruneTypingLog(text, { now = Date.now(), keepDays = TYPING_DEFAULTS.logKeepDays } = {}) {
  const cutoff = now - Math.max(1, toInt(keepDays, TYPING_DEFAULTS.logKeepDays)) * DAY_MS;
  const raw = String(text ?? '').split('\n');
  const kept = [];
  const entries = [];
  let dropped = 0;
  for (const line of raw) {
    const s = line.trim();
    if (!s) continue;
    let item = null;
    try { item = JSON.parse(s); } catch { item = null; }
    const at = Date.parse(String(item && item.at ? item.at : ''));
    if (!Number.isFinite(at) || at < cutoff) { dropped += 1; continue; }
    kept.push(s);
    entries.push(item);
  }
  entries.reverse();
  return { lines: kept, kept: kept.length, dropped, entries };
}

/** 统计：今天几次、最近一次多久前、哪些会话。给控制台那张卡用。 */
export function summarizeTypingLog(entries, { now = Date.now() } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const since = dayStart.getTime();
  let today = 0;
  let typing = 0;
  let stop = 0;
  let lastAt = 0;
  const byKey = new Map();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const at = Date.parse(String(e.at ?? ''));
    if (!Number.isFinite(at)) continue;
    if (at >= since) today += 1;
    if (Number(e.state) === INPUT_STATE.STOP) stop += 1;
    else typing += 1;
    if (at > lastAt) lastAt = at;
    const k = String(e.key ?? '');
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  return {
    total: list.length,
    today,
    typing,
    stop,
    lastAt,
    lastAgoMs: lastAt ? Math.max(0, now - lastAt) : 0,
    conversations: [...byKey.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
  };
}
