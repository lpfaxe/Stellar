/**
 * 群聊「续聊」判定：她最近在这个群说过话，接下来的普通消息就不该按冷概率（默认 0.05）处理。
 *
 * 为什么需要：reserved2 的群聊只认「被点名 / 叫名字 / 提问 / 关键词 / 概率」。
 * 前四个都要消息里带线索，最后一个是 5% 的冷随机 —— 于是有人在群里跟她接着聊、
 * 只是没 @ 她，她就像装死。实测（2026-11-15 测试群）主人问「不@就不回消息吗？」，
 * 那条既没 @ 也没问号，直接落在 5% 里被丢掉。
 *
 * 判定只看三件事，都是本地免费的：
 *   ① 她在这个群最近说过话（lastAiReplyAt 在窗口内）
 *   ② 这条不是「她在跟别人说话」（调用方已经把 direct 排除了）
 *   ③ 不是大群（大群里 70% 接话等于刷屏）
 *
 * 纯逻辑，零 I/O，方便单测。
 */

export const DEFAULT_FOLLOWUP_PROBABILITY = 0.6;
export const DEFAULT_FOLLOWUP_WINDOW_MS = 10 * 60 * 1000;

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 从 socialV2.wake 读续聊参数；没配就用默认值。 */
export function followupSettings(wake = {}) {
  const src = wake && typeof wake === 'object' ? wake : {};
  const windowMs = Number(src.groupFollowupWindowMs);
  return {
    probability: clamp01(src.groupFollowupProbability, DEFAULT_FOLLOWUP_PROBABILITY),
    windowMs: Number.isFinite(windowMs) && windowMs >= 0 ? windowMs : DEFAULT_FOLLOWUP_WINDOW_MS,
  };
}

/**
 * 该不该按「续聊」给这次唤醒开绿灯。
 *
 * @param {object} opts
 * @param {string} opts.kind       会话类型（只有 group 才走这里）
 * @param {boolean} opts.large     是否大群
 * @param {number} opts.probability 会话自己的冷概率；为 0 表示她明确要求「不主动接话」，续聊也一并关掉
 * @param {number} opts.lastReplyAt 她上次在这个会话发言的时间戳
 * @param {number} opts.now
 * @param {object} opts.wakeCfg     socialV2.wake
 * @param {() => number} [opts.random] 注入随机源，测试用
 */
export function shouldFollowupWake({ kind, large, probability, lastReplyAt, now, wakeCfg, random = Math.random }) {
  if (kind !== 'group' || large) return false;
  if (!(Number(probability) > 0)) return false;
  const { probability: p, windowMs } = followupSettings(wakeCfg);
  if (!(p > 0)) return false;
  const last = Number(lastReplyAt) || 0;
  if (!(last > 0)) return false;
  const t = Number(now) || Date.now();
  if (t - last > windowMs) return false;
  return random() < p;
}

export const DEFAULT_CHIME_PROBABILITY = 0.5;
export const DEFAULT_CHIME_MIN_GAP_MS = 120000;
export const DEFAULT_SMALL_GROUP_MAX = 12;

/** 小群插话参数：群里人不多的时候，她该像个群友一样会接话，而不是只有被 @ 才开口。 */
export function chimeSettings(wake = {}) {
  const src = wake && typeof wake === 'object' ? wake : {};
  const maxMembers = Number(src.smallGroupMaxMembers);
  const gapMs = Number(src.groupChimeMinGapMs);
  return {
    probability: clamp01(src.groupChimeProbability, DEFAULT_CHIME_PROBABILITY),
    minGapMs: Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : DEFAULT_CHIME_MIN_GAP_MS,
    maxMembers: Number.isFinite(maxMembers) && maxMembers > 0 ? Math.round(maxMembers) : DEFAULT_SMALL_GROUP_MAX,
  };
}

/**
 * 该不该在小群里「顺口接一句」。
 *
 * 与续聊的区别：续聊要求她刚说过话；插话不要求，但要求①群小②距上次唤醒够久，
 * 否则一个 20 条的群聊会把她叫醒十几次。
 *
 * @param {object} opts
 * @param {string} opts.kind
 * @param {boolean} opts.large        大群直接排除（人多的地方不插话）
 * @param {number} opts.memberCount   群人数；0/未知时按小群处理（刚拉进去还没拿到群信息）
 * @param {number} opts.lastWakeAt    上次唤醒时间戳（含概率唤醒），用来算最小间隔
 * @param {number} opts.now
 * @param {object} opts.wakeCfg
 * @param {() => number} [opts.random]
 */
export function shouldChimeIn({ kind, large, memberCount, lastWakeAt, now, wakeCfg, random = Math.random }) {
  if (kind !== 'group' || large) return false;
  const { probability, minGapMs, maxMembers } = chimeSettings(wakeCfg);
  if (!(probability > 0)) return false;
  const members = Number(memberCount) || 0;
  if (members > maxMembers) return false;
  const last = Number(lastWakeAt) || 0;
  const t = Number(now) || Date.now();
  if (last > 0 && t - last < minGapMs) return false;
  return random() < probability;
}
