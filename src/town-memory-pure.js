/**
 * Stellar —— 鱼缸小镇记忆：纯逻辑层（不碰网络、不碰数据库、不写盘）。
 *
 * 为什么单独一层：小镇数据是**外部不可信输入**，先在这里做清洗、判重、截断，
 * 落库与渲染都只吃这一层的输出，避免把原始 JSON 直接塞进提示词。
 *
 * 时间口径：一律按 Asia/Shanghai 的**日历日**。保留今天 + 昨天 + 前天（3 个日历日），
 * 04:00 的清理任务删掉「< 前天」的整天。人物印象单独 30 天 / 最多 20 人。
 */
import { createHash } from 'node:crypto';

export const TZ = 'Asia/Shanghai';
export const NOTE_TTL_DAYS = 3;
export const IMPRESSION_TTL_DAYS = 30;
export const IMPRESSION_MAX = 20;
export const RECALL_MAX_CHARS = 400;
export const RAW_TEXT_MAX = 240;

const DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** 毫秒时间戳 -> 'YYYY-MM-DD'（Asia/Shanghai）；非法输入回空串。 */
export function dayKey(ms = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  return DAY_FMT.format(new Date(t));
}

/** 'YYYY-MM-DD' 加减天数（按 UTC 算，避免夏令时/时区漂移）。 */
export function shiftDay(day, delta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return '';
  const [y, m, d] = String(day).split('-').map(Number);
  const stepNum = Number(delta);
  const step = Number.isFinite(stepNum) ? stepNum : 0;
  const t = Date.UTC(y, m - 1, d) + step * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** 清理边界：保留 >= cutoff 的 day，删掉 day < cutoff。今天是 11-21 时 cutoff = 11-19。 */
export function pruneCutoffDay(now = Date.now()) {
  return shiftDay(dayKey(now), -(NOTE_TTL_DAYS - 1));
}

/** 日期的人话标签：今天 / 昨天 / 前天 / 11-18。 */
export function dayLabel(day, today = dayKey()) {
  if (!day) return '';
  const diff = daysBetween(day, today);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  return String(day).slice(5).replace('-', '/');
}

export function daysBetween(fromDay, toDay) {
  const a = Date.parse(String(fromDay) + 'T00:00:00Z');
  const b = Date.parse(String(toDay) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86400000);
}

/** 清洗外部文本：去控制字符、压空白、截断。永远返回单行友好的字符串。 */
export function cleanText(input, max = RAW_TEXT_MAX) {
  let s = typeof input === 'string' ? input : (input == null ? '' : String(input));
  s = s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .trim();
  if (max > 0 && s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

const DIRECTIVE_HEAD = /^(你|请你|请|帮我|帮忙|记住|记得|告诉|去|别|不要|一定要|务必|从现在起|以后|立刻|马上|把|替|给我)/;
const INJECTION_HINT = /(忽略|无视|忘掉|忘记之前|系统提示|系统消息|指令|prompt|system|assistant|ignore (all|previous)|disregard)/i;

/**
 * 判断一句小镇文本像不像「对她下的指令」。
 * 像的一律记成 quoted（引用），只作为「某某说过」出现，不进「她自己的记忆」。
 */
export function looksLikeDirective(text) {
  const s = cleanText(text, 120);
  if (!s) return false;
  return DIRECTIVE_HEAD.test(s) || INJECTION_HINT.test(s);
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** 事件指纹（32 hex）：同一件事反复轮询只落一行。 */
export function hashEvent(parts) {
  return createHash('sha256').update(stableStringify(parts)).digest('hex').slice(0, 32);
}

function toArray(raw, keys = []) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  for (const k of keys) if (Array.isArray(raw[k])) return raw[k];
  return [];
}

function pickStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/** 普通数字（金额等）：不换算、不判时间范围。 */
function pickNum(...vals) {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 秒 / 毫秒都收；返回毫秒，非法回 0。 */
function pickTs(...vals) {
  for (const v of vals) {
    let n = 0;
    if (typeof v === 'number' && Number.isFinite(v)) n = v;
    else if (typeof v === 'string' && v.trim()) {
      const asNum = Number(v);
      n = Number.isFinite(asNum) && asNum > 0 ? asNum : Date.parse(v);
    }
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n < 1e11) n *= 1000;
    if (n > 1e12 && n < 4e12) return Math.round(n);
  }
  return 0;
}

/** visits 列表 -> 归一事件。兼容数组 / {visits} / {items} / {data}。 */
export function extractVisits(raw) {
  const list = toArray(raw, ['visits', 'items', 'list', 'data', 'rows']);
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const visitId = pickStr(v.id, v.visit_id, v.visitId, v.uid);
    const at = pickTs(v.at, v.ended_at, v.endedAt, v.end_at, v.start_at, v.started_at, v.created_at, v.createdAt, v.time);
    const partner = (v.partner && typeof v.partner === 'object') ? v.partner
      : (v.with && typeof v.with === 'object') ? v.with
      : (v.fish && typeof v.fish === 'object') ? v.fish : {};
    const who = pickStr(partner.name, partner.nickname, partner.display_name, v.partner_name, v.partnerName, v.with_name, v.guest_name);
    const whoId = pickStr(partner.id, partner.fish_id, v.partner_id, v.partnerId, v.with_id);
    let text = pickStr(v.summary, v.note, v.remark, v.desc, v.text);
    if (!text && Array.isArray(v.lines)) {
      text = v.lines.map((l) => cleanText(typeof l === 'string' ? l : (l && l.text), 80)).filter(Boolean).join('；');
    }
    if (!text && Array.isArray(v.messages)) {
      text = v.messages.map((m) => cleanText(m && (m.text || m.content), 80)).filter(Boolean).slice(-4).join('；');
    }
    if (!visitId && !who && !text) continue;
    out.push({ visitId, who, whoId, at, text: cleanText(text, RAW_TEXT_MAX) });
  }
  return out;
}

/** receipts（请客/消费记录）-> 归一事件。 */
export function extractReceipts(raw) {
  const list = toArray(raw, ['receipts', 'items', 'list', 'data', 'rows']);
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const at = pickTs(r.at, r.created_at, r.createdAt, r.time, r.ts);
    const who = pickStr(r.name, r.partner_name, (r.partner && r.partner.name), r.to_name, r.to && r.to.name);
    const text = pickStr(r.text, r.desc, r.note, r.summary, r.item, r.title);
    const amount = pickNum(r.amount, r.cost, r.price, r.value);
    if (!at && !who && !text) continue;
    out.push({ at, who, text: cleanText(text, RAW_TEXT_MAX), amount });
  }
  return out;
}

/** bonds（心上鱼 / 关系）-> 归一关系。 */
export function extractBonds(raw) {
  const list = toArray(raw, ['bonds', 'items', 'list', 'data', 'rows']);
  const out = [];
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const id = pickStr(b.id, b.fish_id, b.fishId, b.uid);
    const name = pickStr(b.name, b.nickname, b.display_name, (b.fish && b.fish.name));
    const relation = pickStr(b.relation, b.kind, b.type, b.status, b.label);
    const note = cleanText(pickStr(b.note, b.desc, b.summary), 80);
    if (!id && !name) continue;
    out.push({ id, name: cleanText(name, 40), relation: cleanText(relation, 20), note });
  }
  return out;
}

/**
 * 一条归一事件 -> 待落库的 town_note 行。
 * src_hash 用 [kind, who, text, visitId || day] —— 同一访客同一天重复轮询只会得到同一个指纹。
 */
export function buildNoteRow(input = {}, now = Date.now()) {
  const kind = cleanText(input.kind || 'visit', 16) || 'visit';
  const who = cleanText(input.who, 40);
  const text = cleanText(input.text, RAW_TEXT_MAX);
  const at = pickTs(input.at) || Number(now) || Date.now();
  const day = dayKey(at);
  const visitId = cleanText(input.visitId, 64);
  const quoted = input.quoted != null ? (input.quoted ? 1 : 0) : (looksLikeDirective(text) ? 1 : 0);
  return {
    at,
    day,
    kind,
    who,
    text,
    visit_id: visitId,
    quoted,
    src_hash: hashEvent([kind, who, text, visitId || day]),
  };
}

/**
 * 渲染 recall 正文（≤ maxChars，默认 400）。
 * 数据不足时明确说「记不清」，不给模型留编造空间。
 */
export function renderRecall({ notes = [], impressions = [], days = [], today = dayKey(), maxChars = RECALL_MAX_CHARS } = {}) {
  const rows = Array.isArray(notes) ? notes.filter((n) => n && cleanText(n.text, 1)) : [];
  const imps = Array.isArray(impressions) ? impressions.filter((i) => i && (cleanText(i.name, 1) || cleanText(i.line, 1))) : [];
  const dayList = (Array.isArray(days) && days.length ? days : [...new Set(rows.map((n) => n.day))])
    .filter((d) => d && daysBetween(d, today) >= 0 && daysBetween(d, today) < NOTE_TTL_DAYS)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

  const lines = [];
  for (const day of dayList) {
    const items = rows.filter((n) => n.day === day);
    if (!items.length) continue;
    const parts = items.slice(-4).map((n) => {
      const who = cleanText(n.who, 20);
      const body = cleanText(n.text, 90);
      const q = Number(n.quoted) ? '（转述）' : '';
      return who ? `${who}：${body}${q}` : `${body}${q}`;
    });
    lines.push(`${dayLabel(day, today)}（${String(day).slice(5)}）：${parts.join('；')}`);
  }
  if (imps.length) {
    const seg = imps.slice(0, 4).map((i) => {
      const name = cleanText(i.name, 20);
      const line = cleanText(i.line || i.note, 40);
      return name ? `${name}——${line}` : line;
    }).filter(Boolean);
    if (seg.length) lines.push('印象：' + seg.join('；'));
  }

  const head = `【小镇记忆 · ${NOTE_TTL_DAYS} 天内】`;
  if (!lines.length) return `${head}这三天没有留下记录，记不清了。别编。`;

  let out = head + '\n' + lines.join('\n');
  while (out.length > maxChars && lines.length > 1) {
    lines.pop();
    out = head + '\n' + lines.join('\n');
  }
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

/** 印象行是否该被淘汰（>30 天）。 */
export function impressionExpired(updatedAt, now = Date.now()) {
  const t = Number(updatedAt) || 0;
  if (!t) return true;
  return (Number(now) - t) > IMPRESSION_TTL_DAYS * 86400000;
}
