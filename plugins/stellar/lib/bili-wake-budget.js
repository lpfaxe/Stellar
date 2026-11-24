/**
 * Stellar —— B站 的「醒来账」：合并窗口 + 每趟预算 + 每日金额闸（2026-11-24）。
 *
 * 为什么单独一个文件：
 *   ① 这三个数字（合并多少分钟 / 一趟最多几次调用 / 一天最多多少钱）必须只有**一处**真相。
 *      PITFALLS #313 的教训：同一个业务数字散在三处，改了一处另两处还在说老话。
 *   ② 它们全是纯函数，好单测 —— 调度器里那一坨 async 没法直接测。
 *
 * 数字从哪来（2026-11-24 实测，取自 context-telemetry-plugin.jsonl 复算）：
 *   · 每趟醒来的第一次调用 = 底价 ¥0.0083（底座 67K token 全付 hit）；
 *   · 一趟平均 13.6–16.7 次调用，长尾那几趟吃掉 76% 的钱；
 *   · 「上一趟收工不到 20 分钟又醒」占 30–51% 的钱 —— 合并它能省 39%。
 *
 * 边界（重要）：本模块只**算**，不做任何 IO 决策；读账本失败一律当 0 / 不拦。
 *   「今天没花到上限」比「因为账本坏了整晚不醒」安全得多。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 上一趟收工后多少分钟内不新开趟（0 = 关掉合并）。 */
export const DEFAULT_MERGE_GAP_MIN = 20;
/** 一趟最多几次工具调用（0 = 不限）。 */
export const DEFAULT_MAX_CALLS_PER_TURN = 12;
/** 一天最多花多少钱（元；0 = 不限）。 */
export const DEFAULT_DAILY_CNY = 0.8;

function num(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 把配置里的三个旋钮归一。
 * 缺省（键不存在）= 默认值；显式 0 或负数 = **关掉那一项**（不是回落默认）。
 * 这个区别很重要：主人说「别合并」时写 0 就该真的关，而不是被静默改回 20。
 */
export function wakeBudgetConfig(cfg = {}) {
  const wake = cfg && typeof cfg.wake === 'object' && cfg.wake ? cfg.wake : {};
  const budget = cfg && typeof cfg.budget === 'object' && cfg.budget ? cfg.budget : {};
  const mergeGapMin = Math.max(0, num(wake.mergeGapMin, DEFAULT_MERGE_GAP_MIN));
  const maxCallsPerTurn = Math.max(0, Math.floor(num(wake.maxCallsPerTurn, DEFAULT_MAX_CALLS_PER_TURN)));
  const dailyCNY = Math.max(0, num(budget.dailyCNY, DEFAULT_DAILY_CNY));
  return { mergeGapMin, maxCallsPerTurn, dailyCNY };
}

/**
 * 次生叫醒（监听命中 / 空间互动 / 直播间 / 轻醒 / 找人聊 / vlog）要不要先压着。
 *
 * @param {object} args
 * @param {number} args.now           当前毫秒
 * @param {number} args.lastTurnEndAt 上一趟 turn_end 的时刻（0/NaN = 没跑过）
 * @param {number} args.mergeGapMin   合并窗口（0 = 关掉合并）
 * @param {string} args.reason        叫醒原因（只用于日志）
 * @param {boolean} args.urgent       true = 绕过合并（主人本人回复 / 待办 / 驳回返工）
 * @returns {{defer: boolean, waitMs: number, reason: string}}
 */
export function shouldDeferWake({ now = Date.now(), lastTurnEndAt = 0, mergeGapMin = DEFAULT_MERGE_GAP_MIN, reason = '', urgent = false } = {}) {
  const gap = Math.max(0, num(mergeGapMin, DEFAULT_MERGE_GAP_MIN));
  if (urgent) return { defer: false, waitMs: 0, reason: 'urgent' };
  if (!gap) return { defer: false, waitMs: 0, reason: 'merge-off' };
  const end = num(lastTurnEndAt, 0);
  if (!end || end <= 0) return { defer: false, waitMs: 0, reason: 'no-previous-turn' };
  const elapsed = now - end;
  // 上一趟还没收尾（elapsed < 0）= 正在跑，别叠第二趟（由调用方的 waking/busy 标志负责）
  if (elapsed < 0) return { defer: false, waitMs: 0, reason: 'no-previous-turn' };
  const limit = gap * 60_000;
  if (elapsed >= limit) return { defer: false, waitMs: 0, reason: 'merge-window-passed' };
  return { defer: true, waitMs: limit - elapsed, reason: 'merge-window' };
}

/**
 * 从 context-telemetry 里读「这个会话最后一次 turn_end 是什么时候」。
 * 只读文件尾部（256KB），坏行跳过，永不抛。
 */
export function lastTurnEndAt(file, sessionId, { tailBytes = 256 * 1024 } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return 0;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, Math.max(4096, tailBytes));
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    if (st.size > len) lines.shift(); // 第一行可能被截断
    let at = 0;
    for (const line of lines) {
      if (!line || line.indexOf(sid) < 0) continue;
      let row = null;
      try { row = JSON.parse(line); } catch { continue; }
      if (String(row && row.sessionId) !== sid) continue;
      if (row.kind !== 'turn_end') continue;
      const ts = Number(row.ts);
      if (Number.isFinite(ts) && ts > at) at = ts;
    }
    return at;
  } catch { return 0; }
}

/** 今天 B站 花了多少（元）。读不到当 0。 */
export function biliSpendToday(dshHome) {
  try {
    const home = String(dshHome === undefined || dshHome === null ? process.env.DSH_HOME || '' : dshHome).trim();
    if (!home) return 0;
    const file = path.join(home, 'stellar', 'token-usage-daily.json');
    const daily = JSON.parse(fs.readFileSync(file, 'utf8'));
    const today = new Date().toLocaleDateString('sv-SE');
    if (String(daily.day || '') && String(daily.day) !== today) return 0; // 昨天的账不算今天
    const bili = (daily && daily.bili) || {};
    return Math.max(0, Number(bili.cost ?? bili.cny ?? 0) || 0);
  } catch { return 0; }
}

/** 今天的钱花到上限没有。返回 { blocked, spent, cap }。 */
export function biliBudgetState(dshHome, cfg = {}) {
  const spent = biliSpendToday(dshHome);
  const cap = wakeBudgetConfig(cfg).dailyCNY;
  return { blocked: cap > 0 && spent >= cap, spent, cap };
}

/**
 * 拼给她的那一行预算提示（空串 = 两项都关了，别占地方）。
 * 放在唤醒提示里，是**软的**：靠她自己收工，不是硬拦。
 */
export function budgetPromptLine(cfg = {}, { spent = null } = {}) {
  const { maxCallsPerTurn, dailyCNY } = wakeBudgetConfig(cfg);
  const parts = [];
  if (maxCallsPerTurn > 0) {
    parts.push(`本次最多 ${maxCallsPerTurn} 次工具调用 —— 到数就收工写日记，剩下的留给下一趟（不要为了凑完清单硬撑）`);
  }
  if (dailyCNY > 0 && spent !== null && Number.isFinite(Number(spent))) {
    parts.push(`今天 B站 已花 ¥${Number(spent).toFixed(2)} / 上限 ¥${dailyCNY.toFixed(2)}（到上限今天不再醒）`);
  }
  if (!parts.length) return '';
  return `【本次预算】${parts.join('；')}`;
}
