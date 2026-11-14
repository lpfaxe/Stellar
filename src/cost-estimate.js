// 花费预估：把「这件事大概要烧多少 token」换算成人民币，并对照今天的额度。
//
// 为什么要单独一个模块：两个地方要用同一套口径 ——
//   1) QQ 会话里的 MCP 工具 stellar_cost（她接到大任务先估一遍再请示主人）；
//   2) 鲸鱼会话的命令行 node bili.mjs cost。
// 口径必须和账本（token-budget.js）+ 价目表（model-prices.js）一致，
// 否则她会报一个和结算对不上的数字。
import { DEFAULT_PRICE_TABLE, priceUsage, ratesAt, totalTokensOf } from './model-prices.js';
import { formatCny, readBudget, readDailyUsage, stellarDir } from './token-budget.js';

export { formatCny } from './token-budget.js';

export const COST_MODEL_DEFAULT = 'deepseek-flash';

/**
 * 常见任务的 token 体量（经验值，按 2026-11 的实测账单估的）。
 * contextTokens 是「每一轮都要重发的那段上下文」，outputTokens 是整件事的产出。
 */
export const TASK_PRESETS = Object.freeze({
  'chat-turn': { label: '一轮普通聊天', contextTokens: 12000, outputTokens: 500, turns: 1 },
  'qzone-post': { label: '发一条说说（配图+文案）', contextTokens: 24000, outputTokens: 1500, turns: 2 },
  'bili-watch': { label: '看一条 B 站视频（文字+抽帧）', contextTokens: 60000, outputTokens: 3000, turns: 2 },
  'bili-watch-deep': { label: '细看一条视频（多轮抽帧/字幕）', contextTokens: 180000, outputTokens: 8000, turns: 4 },
  'web-research': { label: '一次联网调研（抓 5~10 个页面）', contextTokens: 300000, outputTokens: 10000, turns: 6 },
  'code-task': { label: '读代码并改一处（含验证）', contextTokens: 150000, outputTokens: 6000, turns: 4 },
  'long-article': { label: '写一篇长文/报告', contextTokens: 250000, outputTokens: 20000, turns: 5 }
});

const clampRatio = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(0.99, Math.max(0, n));
};

/**
 * 估算一件任务的成本。
 * @param {object} opts
 * @param {string} [opts.preset]        TASK_PRESETS 的键
 * @param {string} [opts.model]         模型 id（默认 deepseek-flash）
 * @param {number} [opts.contextTokens] 每轮上下文 token
 * @param {number} [opts.outputTokens]  总产出 token
 * @param {number} [opts.turns]         轮数（默认 1）
 * @param {number} [opts.cacheHitRatio] 上下文里缓存命中的比例（默认 0.85，多轮对话天然偏高）
 * @param {number} [opts.at]            计价时刻（默认现在，用来自动判峰谷）
 */
export function estimateTask(opts = {}) {
  const preset = opts.preset ? TASK_PRESETS[opts.preset] : null;
  const at = Number.isFinite(Number(opts.at)) ? Number(opts.at) : Date.now();
  const model = String(opts.model ?? COST_MODEL_DEFAULT).trim() || COST_MODEL_DEFAULT;
  const turns = Math.max(1, Math.round(Number(opts.turns ?? preset?.turns ?? 1) || 1));
  const contextTokens = Math.max(0, Math.round(Number(opts.contextTokens ?? preset?.contextTokens ?? 0) || 0));
  const outputTokens = Math.max(0, Math.round(Number(opts.outputTokens ?? preset?.outputTokens ?? 0) || 0));
  const hitRatio = clampRatio(opts.cacheHitRatio, 0.85);
  const inputTotal = contextTokens * turns;
  const buckets = {
    cacheHit: Math.round(inputTotal * hitRatio),
    cacheMiss: Math.round(inputTotal * (1 - hitRatio)),
    cacheWrite: 0,
    output: outputTokens,
    reasoning: 0
  };
  const { rates, cost } = priceUsage(buckets, { model, at, table: DEFAULT_PRICE_TABLE });
  return {
    label: preset?.label ?? (opts.label ? String(opts.label) : '自定义任务'),
    model: rates.model,
    modelLabel: rates.label,
    tier: rates.tier,
    tierLabel: rates.tierLabel,
    turns,
    contextTokens,
    outputTokens,
    tokens: totalTokensOf(buckets),
    buckets,
    cny: cost.total,
    cost
  };
}

/** 用「字数」粗估 token：中文约 1 字 ≈ 0.7 token，英文/代码约 4 字符 ≈ 1 token。 */
export function charsToTokens(chars, kind = 'zh') {
  const n = Math.max(0, Number(chars) || 0);
  return Math.round(kind === 'code' ? n / 4 : n / 1.4);
}

/** 今天的额度快照：已花多少、还剩多少、峰谷。 */
export function budgetSnapshot({ dir = stellarDir(), at = Date.now() } = {}) {
  const limits = readBudget(dir);
  const usage = readDailyUsage(dir);
  const remaining = {};
  for (const scope of ['qq', 'bili', 'other', 'total']) {
    const limit = limits?.[scope]?.cny;
    const used = Number(usage?.[scope]?.cost) || 0;
    const hasLimit = Number.isFinite(limit) && limit > 0;
    remaining[scope] = {
      limitCny: hasLimit ? limit : null,
      usedCny: used,
      leftCny: hasLimit ? Math.max(0, limit - used) : null
    };
  }
  const rates = ratesAt(COST_MODEL_DEFAULT, at);
  return { day: usage.day, at, usage, limits, remaining, rates };
}

/** 「≈ 9.0 万 token ≈ ¥0.12（高峰时段）」 */
export function formatEstimate(est) {
  const wan = est.tokens / 10000;
  const size = wan >= 1 ? wan.toFixed(1) + ' 万 token' : est.tokens + ' token';
  // 小额（几分钱以内）保留 4 位，否则 ¥0.00 会让人以为不要钱
  const money = est.cny < 0.01 ? '¥' + est.cny.toFixed(4) : formatCny(est.cny);
  return '≈ ' + size + ' ≈ ' + money + '（' + est.tierLabel + '）';
}

/** 一句话汇报今天的花费。 */
export function formatSnapshot(snap) {
  const t = snap.remaining.total;
  const head = t.limitCny == null
    ? '今天已花 ' + formatCny(t.usedCny) + '（没设上限）'
    : '今天已花 ' + formatCny(t.usedCny) + ' / 上限 ' + formatCny(t.limitCny) + '，还剩 ' + formatCny(t.leftCny);
  const peakNote = snap.rates.tier === 'peak' ? '（单价 ×2）' : '';
  return head + '；现在是' + snap.rates.tierLabel + peakNote;
}

/**
 * 给 agent 看的判断：overBudget = 这一件事就可能超出今天剩余额度；
 * heavy = 会吃掉剩余额度的一半以上，值得先请示。
 */
export const ASK_THRESHOLD_CNY = 0.05;

export function advise(est, snap) {
  const left = snap.remaining.total.leftCny;
  const overBudget = left != null && est.cny > left;
  const heavy = left != null ? est.cny >= left * 0.5 : est.cny >= 1;
  // 主人 2026-11-08 定的请示线：预计超过 ¥0.05 就先报价，别自己做主。
  const needsAsk = overBudget || heavy || est.cny >= ASK_THRESHOLD_CNY;
  return { overBudget, heavy, needsAsk, leftCny: left };
}

export function describePlan(est, snap) {
  const a = advise(est, snap);
  const lines = [
    '任务：' + est.label,
    '预估：' + formatEstimate(est) + '（' + est.tokens + ' token = 上下文 ' + est.contextTokens + '×' + est.turns + ' 轮 + 产出 ' + est.outputTokens + '）',
    formatSnapshot(snap)
  ];
  if (a.overBudget) lines.push('⚠ 这一件事就可能超出今天剩下的额度：先说清楚，别硬上。');
  else if (a.heavy) lines.push('⚠ 这件事要花掉今天剩下额度的一半以上：先请示，报了价再动。');
  else if (a.needsAsk) lines.push('⚠ 超过主人定的 ¥0.05 请示线：先把这个估价报给他，等他同意再动。');
  else lines.push('额度够用，而且不到 ¥0.05，可以直接做。');
  return lines.join('\n');
}
