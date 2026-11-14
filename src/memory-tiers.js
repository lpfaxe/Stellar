/**
 * 记忆分层 + 混合检索（Memory Tiers v1）。
 *
 * 纯逻辑：零 I/O、零副作用。真正的读写/落盘在 memory-store.js，
 * 调度与注入在 bridge.js / plugins 侧。
 *
 * 分层：
 *   cache  最近 4-6 条上下文，只做「刚才聊到哪」，不进记忆库、不作答案源
 *   L1     一级：常驻（置顶 / 主人锚点 / 高重要度 / 被反复用到 / 用户点名要记）
 *   L2     二级：每 l2Days 天（默认 3）清空，清空前先做晋升判断
 *   L3     三级：每天清空，清空前先做晋升判断，剩下的压成一条「当日摘要」
 *
 * 检索：关键词 + 语义（外部传入向量分）+ 重要度 + 时间衰减 + 使用频次 + 会话过滤，
 * 低分不注入；注入只给「摘要 + 引用 ID」，原文按 ID 拉。
 */

export const MEMORY_TIERS = Object.freeze(['L1', 'L2', 'L3']);

export const TIER_LABELS = Object.freeze({ L1: '一级', L2: '二级', L3: '三级' });

export const DEFAULT_TIER_CONFIG = Object.freeze({
  enabled: true,
  topK: 4,
  minScore: 0.34,
  minKeyword: 0.14,
  maxInjectChars: 900,
  l1Importance: 70,
  l2Importance: 40,
  promoteScore: 0.58,
  dailyHour: 4,
  // 2026-11-11 主人要求：L2 改成「每三天」清一次（原来是每周一）。
  // weeklyWeekday 保留只为兼容旧配置，不再参与周期计算。
  l2Days: 3,
  weeklyWeekday: 1,
  summaryMaxChars: 90,
  digestMaxRecords: 12,
});

const DAY_MS = 24 * 60 * 60 * 1000;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value !== false && value !== 'false' && value !== 0 && value !== '0';
}

function timeOf(value, fallback = 0) {
  const t = Date.parse(String(value === undefined || value === null ? '' : value));
  return Number.isFinite(t) ? t : fallback;
}

export function normalizeTierConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: bool(src.enabled, DEFAULT_TIER_CONFIG.enabled),
    topK: clampInt(src.topK, DEFAULT_TIER_CONFIG.topK, 1, 12),
    minScore: clampNumber(src.minScore, DEFAULT_TIER_CONFIG.minScore, 0, 1),
    minKeyword: clampNumber(src.minKeyword, DEFAULT_TIER_CONFIG.minKeyword, 0, 1),
    maxInjectChars: clampInt(src.maxInjectChars, DEFAULT_TIER_CONFIG.maxInjectChars, 200, 4000),
    l1Importance: clampInt(src.l1Importance, DEFAULT_TIER_CONFIG.l1Importance, 1, 100),
    l2Importance: clampInt(src.l2Importance, DEFAULT_TIER_CONFIG.l2Importance, 1, 100),
    promoteScore: clampNumber(src.promoteScore, DEFAULT_TIER_CONFIG.promoteScore, 0, 1),
    dailyHour: clampInt(src.dailyHour, DEFAULT_TIER_CONFIG.dailyHour, 0, 23),
    l2Days: clampInt(src.l2Days, DEFAULT_TIER_CONFIG.l2Days, 1, 90),
    weeklyWeekday: clampInt(src.weeklyWeekday, DEFAULT_TIER_CONFIG.weeklyWeekday, 0, 6),
    summaryMaxChars: clampInt(src.summaryMaxChars, DEFAULT_TIER_CONFIG.summaryMaxChars, 20, 400),
    digestMaxRecords: clampInt(src.digestMaxRecords, DEFAULT_TIER_CONFIG.digestMaxRecords, 1, 50),
  };
}

export function memorySummary(record, maxChars = DEFAULT_TIER_CONFIG.summaryMaxChars) {
  const title = String(record && record.title ? record.title : '').trim();
  const text = String(record && record.text ? record.text : '').trim();
  const source = title || text.split(/[。！？\n]/)[0] || text;
  const clean = source.replace(/\s+/g, ' ').trim();
  return clean.length > maxChars ? clean.slice(0, maxChars) + '…' : clean;
}

export function tierOfRecord(record, cfg = DEFAULT_TIER_CONFIG) {
  const tier = String((record && record.tier) || '').toUpperCase();
  if (MEMORY_TIERS.indexOf(tier) >= 0) return tier;
  const tags = Array.isArray(record && record.tags) ? record.tags.map(function (t) { return String(t); }) : [];
  const importance = Number(record && record.importance) || 0;
  if (!record) return 'L3';
  if (record.pinned === true || record.anchor === true || record.firstMet === true) return 'L1';
  if (tags.indexOf('important') >= 0 || tags.indexOf('promise') >= 0 || tags.indexOf('conflict') >= 0) return 'L1';
  if (Number(record.recallCount) >= 3) return 'L1';
  if (importance >= (cfg.l1Importance || 70)) return 'L1';
  if (importance >= (cfg.l2Importance || 40) || Number(record.emotional) >= 8) return 'L2';
  if (tags.indexOf('owner') >= 0 || record.private === true) return 'L2';
  return 'L3';
}

export function assignTier(record, cfg = DEFAULT_TIER_CONFIG) {
  const next = tierOfRecord(record, cfg);
  if (record && record.tier === next) return record;
  return Object.assign({}, record, { tier: next });
}

const CJK_RE = /[\u3400-\u9fff]+/g;
const WORD_RE = /[a-z0-9_]{2,}/gi;

// 高频虚词/口头语：双边一起过滤，避免「你还记得…」和任何一句都因为「什么/你/我」撞上。
const STOP_TOKENS = new Set([
  '什么', '怎么', '为什', '哪个', '哪些', '可以', '知道', '知道吗', '觉得', '我们', '你们', '他们',
  '这个', '那个', '今天', '现在', '时候', '还是', '就是', '没有', '不是', '一样', '这样', '那样',
  '一个', '一起', '一下', '已经', '因为', '所以', '但是', '而且', '然后', '如果', '可能', '应该',
  'the', 'and', 'you', 'are', 'was', 'for', 'that', 'this', 'with', 'have', 'what', 'your',
]);

export function matchTokens(text) {
  const s = String(text === undefined || text === null ? '' : text).toLowerCase();
  const out = new Set();
  const cjk = s.match(CJK_RE) || [];
  for (const chunk of cjk) {
    for (let i = 0; i < chunk.length - 1; i += 1) {
      const token = chunk.slice(i, i + 2);
      if (!STOP_TOKENS.has(token)) out.add(token);
    }
    if (chunk.length === 1 && !STOP_TOKENS.has(chunk)) out.add(chunk);
  }
  const words = s.match(WORD_RE) || [];
  for (const word of words) if (!STOP_TOKENS.has(word)) out.add(word);
  return out;
}

export function overlapScore(queryTokens, textTokens) {
  const q = queryTokens instanceof Set ? queryTokens : new Set(queryTokens || []);
  const t = textTokens instanceof Set ? textTokens : new Set(textTokens || []);
  if (!q.size || !t.size) return 0;
  let hit = 0;
  for (const token of q) if (t.has(token)) hit += 1;
  return hit / q.size;
}

export function recencyScore(createdAt, now = Date.now(), halfLifeDays = 10) {
  const at = timeOf(createdAt, now);
  const ageDays = Math.max(0, (now - at) / DAY_MS);
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

export function scoreMemory({ record, queryTokens, vectorScore = null, now = Date.now(), cfg = DEFAULT_TIER_CONFIG } = {}) {
  const tags = Array.isArray(record && record.tags) ? record.tags.join(' ') : '';
  const text = String((record && record.title) || '') + ' ' + String((record && record.text) || '') + ' ' + String((record && record.detail) || '') + ' ' + String((record && record.botReply) || '') + ' ' + tags;
  const keyword = overlapScore(queryTokens, matchTokens(text));
  const semantic = Number.isFinite(vectorScore) ? Math.max(0, Math.min(1, vectorScore)) : keyword;
  const importance = Math.max(0, Math.min(1, (Number(record && record.importance) || 0) / 100));
  const recency = recencyScore((record && (record.lastSeenAt || record.createdAt)), now);
  const usage = Math.min(1, (Number(record && record.recallCount) || 0) / 5);
  const tier = tierOfRecord(record, cfg);
  const tierBoost = tier === 'L1' ? 0.14 : tier === 'L2' ? 0.05 : 0;
  const status = String((record && record.status) || 'active');
  const invalid = status !== 'active' || Boolean(record && record.forgotten === true);
  const score = invalid ? 0
    : 0.34 * keyword + 0.24 * semantic + 0.20 * importance + 0.12 * recency + 0.06 * usage + tierBoost;
  return { score: Math.min(1, score), parts: { keyword, semantic, importance, recency, usage, tierBoost }, tier, invalid };
}

export function visibleForKey(record, key = '') {
  const target = String(key || '').trim();
  const recordKey = String((record && record.conversationKey) || '');
  if (!target) return true;
  if (recordKey && recordKey !== target) return false;
  if (target.indexOf('group:') === 0) {
    return recordKey === target || Boolean(record && record.groupId && target.slice(6) === String(record.groupId));
  }
  if (target.indexOf('private:') === 0) {
    const userId = target.slice(8);
    if (recordKey === target) return true;
    if (record && record.scope === 'pet') return true;
    if (record && record.private === true && record.isOwner === true && !recordKey) return true;
    return false;
  }
  return true;
}

export function rankMemories({ records = [], query = '', vectorScores = null, key = '', now = Date.now(), cfg = DEFAULT_TIER_CONFIG, limit = null, sensitiveKeys = null } = {}) {
  const config = normalizeTierConfig(cfg);
  const topK = Math.max(1, Math.min(12, Number(limit) || config.topK));
  const queryTokens = matchTokens(query);
  if (!queryTokens.size) return [];
  const blocked = sensitiveKeys instanceof Set ? sensitiveKeys : new Set(sensitiveKeys || []);
  const scored = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.forgotten === true) continue;
    if (!visibleForKey(record, key)) continue;
    if (record.sensitive === true && key && !blocked.has(key)) continue;
    const vectorScore = vectorScores && typeof vectorScores === 'object' ? vectorScores[record.id] : null;
    const result = scoreMemory({ record, queryTokens, vectorScore, now, cfg: config });
    if (result.score < config.minScore) continue;
    // 相关性闸门：只有重要度没有词面/语义相关性的记录不注入（否则「最近聊过」会挤掉真正的答案）。
    const relevant = result.parts.keyword >= config.minKeyword
      || (Number.isFinite(vectorScore) && result.parts.semantic >= 0.5);
    if (!relevant) continue;
    scored.push(Object.assign({ record }, result));
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  const byTier = { L1: [], L2: [], L3: [] };
  for (const item of scored) byTier[item.tier].push(item);
  const picked = [];
  const seenSummary = new Set();
  for (const tier of MEMORY_TIERS) {
    for (const item of byTier[tier]) {
      if (picked.length >= topK) break;
      // 相同/相似记忆只留一条（提示词里去重，访问计数在 store 侧累加）。
      const fingerprint = memorySummary(item.record, 40).replace(/\s+/g, '');
      if (seenSummary.has(fingerprint)) continue;
      seenSummary.add(fingerprint);
      picked.push(item);
    }
    if (picked.length >= topK) break;
  }
  return picked.slice(0, topK);
}

export function renderRecallBlock(hits = [], { maxChars = DEFAULT_TIER_CONFIG.maxInjectChars, now = Date.now() } = {}) {
  if (!Array.isArray(hits) || !hits.length) return '';
  const lines = [];
  let used = 0;
  for (const hit of hits) {
    const record = (hit && hit.record) || hit;
    if (!record) continue;
    const summary = memorySummary(record);
    if (!summary) continue;
    const tier = (hit && hit.tier) || tierOfRecord(record);
    const when = shortWhen(record.createdAt, now);
    const line = '- [' + tier + '·' + when + '] ' + summary + '（id ' + record.id + '）';
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return '【相关记忆】\n' + lines.join('\n') + '\n要看某条的原文，用 stellar_memory_read 按 id 查；没被列出的记忆不要凭空补。';
}

export function shortWhen(value, now = Date.now()) {
  const at = timeOf(value, 0);
  if (!at) return '未知';
  const diff = Math.max(0, now - at);
  if (diff < 60 * 60 * 1000) return '刚才';
  if (diff < DAY_MS) return Math.floor(diff / 3600000) + '小时前';
  if (diff < 7 * DAY_MS) return Math.floor(diff / DAY_MS) + '天前';
  return new Date(at).toISOString().slice(0, 10);
}

function localParts(now) {
  const d = new Date(now);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay(), hour: d.getHours() };
}

export function nextDailyReset(now = Date.now(), cfg = DEFAULT_TIER_CONFIG) {
  const config = normalizeTierConfig(cfg);
  const p = localParts(now);
  const target = new Date(p.year, p.month, p.day, config.dailyHour, 0, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime();
}

export function nextWeeklyReset(now = Date.now(), cfg = DEFAULT_TIER_CONFIG) {
  const config = normalizeTierConfig(cfg);
  const target = new Date(now);
  target.setHours(config.dailyHour, 0, 0, 0);
  const delta = (config.weeklyWeekday - target.getDay() + 7) % 7;
  target.setDate(target.getDate() + delta);
  if (target.getTime() <= now) target.setDate(target.getDate() + 7);
  return target.getTime();
}

/** 本地日索引（以 localDailyHour 为日界）：用来做「每 N 天」的固定窗口，不受星期与时区偏移影响。 */
function localDayIndex(now, config) {
  const d = new Date(now);
  if (d.getHours() < config.dailyHour) d.setDate(d.getDate() - 1);
  const midnight = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.floor(midnight / DAY_MS);
}

/** L2 的滚动窗口序号：从 epoch 起每 l2Days 天一个窗口（l2Days=3 → 0/1/2 三组轮流）。 */
function l2WindowIndex(now, config) {
  return Math.floor(localDayIndex(now, config) / Math.max(1, config.l2Days));
}

export function cycleKey(tier, now = Date.now(), cfg = DEFAULT_TIER_CONFIG) {
  const config = normalizeTierConfig(cfg);
  if (tier === 'L3') return 'd:' + new Date(now).toISOString().slice(0, 10);
  if (tier === 'L2') return 'e:' + l2WindowIndex(now, config) + 'x' + config.l2Days;
  return '';
}

export function promotionVerdict(record, { now = Date.now(), cfg = DEFAULT_TIER_CONFIG } = {}) {
  const config = normalizeTierConfig(cfg);
  const tags = Array.isArray(record && record.tags) ? record.tags.map(function (t) { return String(t); }) : [];
  const importance = Number(record && record.importance) || 0;
  const recalls = Number(record && record.recallCount) || 0;
  const emotional = Number(record && record.emotional) || 0;
  if (record && (record.pinned === true || record.anchor === true || record.firstMet === true)) {
    return { promote: true, to: 'L1', reason: 'anchor' };
  }
  if (tags.indexOf('important') >= 0 || tags.indexOf('promise') >= 0 || tags.indexOf('conflict') >= 0 || tags.indexOf('preference') >= 0) {
    return { promote: true, to: importance >= config.l1Importance ? 'L1' : 'L2', reason: 'tag' };
  }
  if (tags.indexOf('owner') >= 0 && (importance >= 45 || emotional >= 6 || recalls >= 2)) {
    return { promote: true, to: 'L2', reason: 'owner' };
  }
  if (importance >= config.l1Importance) return { promote: true, to: 'L1', reason: 'importance' };
  if (importance >= config.l2Importance && recalls >= 1) return { promote: true, to: 'L2', reason: 'importance' };
  if (recalls >= 2) return { promote: true, to: 'L2', reason: 'recalled' };
  return { promote: false, to: '', reason: '' };
}

/** 当前周期的起点（本地 04:00 / 周一 04:00）：周期开始之后新建的记录不参与本轮清空。 */
export function cycleStart(tier, now = Date.now(), cfg = DEFAULT_TIER_CONFIG) {
  const config = normalizeTierConfig(cfg);
  const d = new Date(now);
  if (tier === 'L3') {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), config.dailyHour, 0, 0, 0);
    if (start.getTime() > now) start.setDate(start.getDate() - 1);
    return start.getTime();
  }
  if (tier === 'L2') {
    // 窗口起点 = 当前窗口最早那天的 localDailyHour；用「日索引差 × 一天」回推，避免 DST 偏移。
    const idx = localDayIndex(now, config);
    const windowStartIdx = l2WindowIndex(now, config) * Math.max(1, config.l2Days);
    const back = idx - windowStartIdx;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), config.dailyHour, 0, 0, 0);
    if (start.getTime() > now) start.setDate(start.getDate() - 1);
    start.setDate(start.getDate() - back);
    return start.getTime();
  }
  return 0;
}

export function planTierMaintenance({ records = [], now = Date.now(), cfg = DEFAULT_TIER_CONFIG, forceClear = '' } = {}) {
  const config = normalizeTierConfig(cfg);
  // forceClear='L3'/'L2'/'both'：控制台「立即清空」按钮用。跳过周期闸门（同一个周期只清一次、
  // 本周期新建的记录先留着），但仍然先跑晋升判断、仍然永远保留 L1 —— 手动清不等于删库。
  const force = forceClear === 'both' ? ['L2', 'L3'] : (forceClear === 'L2' || forceClear === 'L3' ? [forceClear] : []);
  const promote = [];
  const clear = [];
  const keep = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.forgotten === true || record.status === 'superseded') continue;
    const tier = tierOfRecord(record, config);
    if (tier === 'L1') { keep.push(record); continue; }
    const forced = force.indexOf(tier) >= 0;
    if (!forced) {
      const currentCycle = cycleKey(tier, now, config);
      if (String(record.clearedCycle || '') === currentCycle) { keep.push(record); continue; }
      // 本周期内新写进来的记录先留着（否则「刚记住就被清」）。
      if (timeOf(record.createdAt, 0) >= cycleStart(tier, now, config)) { keep.push(record); continue; }
    }
    const verdict = promotionVerdict(record, { now, cfg: config });
    if (verdict.promote) {
      promote.push({ id: record.id, tier, to: verdict.to, reason: verdict.reason });
      keep.push(record);
    } else {
      clear.push({ id: record.id, tier });
    }
  }
  return { promote, clear, keep, cycles: { daily: cycleKey('L3', now, config), weekly: cycleKey('L2', now, config), l2Days: config.l2Days } };
}

export function buildDigestRecord(records = [], { tier = 'L3', now = Date.now(), cfg = DEFAULT_TIER_CONFIG } = {}) {
  const config = normalizeTierConfig(cfg);
  if (!Array.isArray(records) || !records.length) return null;
  const list = records.slice(0, config.digestMaxRecords);
  const lines = list.map(function (record) { return memorySummary(record, 40); }).filter(Boolean);
  if (!lines.length) return null;
  const label = tier === 'L3' ? '今日零碎' : '近三天零碎';
  const text = label + '：' + lines.join('；') + (records.length > list.length ? '（另 ' + (records.length - list.length) + ' 条）' : '');
  const stamp = new Date(now).toISOString();
  return {
    id: 'digest_' + tier.toLowerCase() + '_' + stamp.slice(0, 10).replace(/-/g, '') + '_' + Math.random().toString(36).slice(2, 8),
    source: 'digest',
    sourceId: '',
    platform: 'shared',
    scope: 'shared',
    kind: 'digest',
    title: label,
    text: text.slice(0, 1200),
    detail: '',
    tags: ['digest', tier.toLowerCase()],
    importance: 30,
    importanceReasons: ['digest'],
    emotional: 0,
    pinned: false,
    anchor: false,
    clarity: 'clear',
    createdAt: stamp,
    lastSeenAt: stamp,
    decaySteps: 0,
    recallCount: 0,
    tier: 'L3',
    status: 'active',
    clearedCycle: cycleKey('L3', now, config),
  };
}

export function findSuperseded(record, records = [], { now = Date.now() } = {}) {
  const tags = Array.isArray(record && record.tags) ? record.tags.map(function (t) { return String(t); }) : [];
  if (tags.indexOf('preference') < 0) return [];
  const subject = matchTokens((record && (record.title || record.text)) || '');
  const out = [];
  for (const other of Array.isArray(records) ? records : []) {
    if (!other || other.id === record.id) continue;
    const otherTags = Array.isArray(other.tags) ? other.tags.map(function (t) { return String(t); }) : [];
    if (otherTags.indexOf('preference') < 0) continue;
    const overlap = overlapScore(subject, matchTokens(other.title || other.text || ''));
    if (overlap >= 0.6 && timeOf(other.createdAt, 0) < timeOf(record.createdAt, now)) out.push(other.id);
  }
  return out;
}
