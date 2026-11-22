/* 说话方式（「鱼八股」）：把写死在唤醒提示里的那句「反 AI 味」换成一份可编辑的文件。
 *
 * 为什么是「一处替换 + 一个文件」，不是「让她自己读文件」：
 *   - 桥接每次唤醒都拼提示词（src/bridge.js 的 antiAiLine），从这读 = 0 额外往返；
 *   - 让她调工具读 = 一次完整模型往返（实测 ≈ ¥0.04/次，见 docs/designs/2026-11-22-voice-style-module.md）。
 *
 * 谁写这个文件：只有控制台面板（stellar-manager）的 /api/voice-style 能写。
 * 她没有任何写配置的工具（工具面白名单 fail-closed），所以群友诱导不了。
 *
 * 数据形状（<DSH_HOME>/stellar/state/voice-style.json）：
 *   {
 *     "enabled": true,              // false = 只用内置兜底句（回到 2026-11-22 之前的行为）
 *     "stats": true,                // false = 不统计（统计只记数量，不记原文）
 *     "maxChars": 600,
 *     "principles": ["…", "…"],     // 「原则」段，主人可以改
 *     "entries": [{ "id": "ve_…", "from": "这句我记下了", "to": ["知道啦", "懂了"] }]
 *   }
 *
 * 兜底不只一层：文件坏/丢/空 → 内置原则；enabled=false → 内置那一整句。
 * 也就是说「删掉文件」= 回到今天的行为，不需要改代码、不需要重启。
 */

import fs from 'node:fs';
import path from 'node:path';

export const VOICE_FILE_NAME = 'voice-style.json';
export const VOICE_STATS_NAME = 'voice-stats.json';
export const VOICE_MAX_CHARS = 600;
export const VOICE_MAX_PRINCIPLES = 6;
export const VOICE_MAX_ENTRIES = 60;
export const VOICE_LINE_MAX = 120;

/** 2026-11-22 之前写死在 bridge.js:16113 的那一句——enabled=false 或面板没接管时用。 */
export const LEGACY_FALLBACK = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。';

/** 面板第一次打开、文件还没建时给的原则（措辞尽量贴回原来那 122 字，别偷换语义）。 */
export const DEFAULT_PRINCIPLES = [
  '你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐。',
  '不问「还有什么可以帮您」；不列举三点；不用破折号补说明。',
  '少用：一绝 / 真管用 / 保证 / 绝对 / 总之 / 换句话说。',
];

/** 注入块首行：写死优先级，否则一份词表会跟人格卡打架。 */
export const VOICE_HEAD = '【说话方式】（主人的偏好，改了措辞不改身份；与人格卡冲突时以人格卡为准）';

const SERVICE_WORDS = ['希望对你有帮助', '还有什么可以帮', '总之', '换句话说', '需要注意的是', '总的来说', '首先', '其次', '让我来帮你', '为你提供', '值得注意的是'];

let cache = { key: '', style: null };

export function voiceStyleFile(dir) {
  return path.join(String(dir || ''), VOICE_FILE_NAME);
}
export function voiceStatsFile(dir) {
  return path.join(String(dir || ''), VOICE_STATS_NAME);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日期键（统计按「今天」重置；用本地时区，不用 UTC，免得 08:00 才换日）。 */
export function dayKeyOf(now = Date.now()) {
  const d = new Date(Number(now) || Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function asText(value, max = VOICE_LINE_MAX) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * 归一化：坏字段就地丢掉，不抛错（桥接每次唤醒都调它，不能在这里炸）。
 * 返回 { enabled, stats, maxChars, principles, entries, errors }。
 */
export function normalizeVoiceStyle(raw) {
  const errors = [];
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const enabled = src.enabled !== false;
  const stats = src.stats !== false;
  let maxChars = Number(src.maxChars);
  if (!Number.isFinite(maxChars) || maxChars < 120) maxChars = VOICE_MAX_CHARS;
  maxChars = Math.min(Math.max(Math.floor(maxChars), 120), 1200);

  const principles = [];
  for (const item of (Array.isArray(src.principles) ? src.principles : [])) {
    const line = asText(item);
    if (!line) continue;
    if (principles.length >= VOICE_MAX_PRINCIPLES) { errors.push('principles 超过 ' + VOICE_MAX_PRINCIPLES + ' 条，多的忽略'); break; }
    principles.push(line);
  }

  const entries = [];
  const seen = new Set();
  for (const item of (Array.isArray(src.entries) ? src.entries : [])) {
    const from = asText(item && item.from);
    if (!from) continue;
    const key = from.toLowerCase();
    if (seen.has(key)) { errors.push('词条重复，已忽略：' + from.slice(0, 20)); continue; }
    const toRaw = Array.isArray(item && item.to) ? item.to : [item && item.to];
    const to = [];
    for (const t of toRaw) {
      const one = asText(t);
      if (one && !to.includes(one)) to.push(one);
      if (to.length >= 4) break;
    }
    if (!to.length) { errors.push('词条没有改法，已忽略：' + from.slice(0, 20)); continue; }
    if (entries.length >= VOICE_MAX_ENTRIES) { errors.push('entries 超过 ' + VOICE_MAX_ENTRIES + ' 条，多的忽略'); break; }
    seen.add(key);
    entries.push({ id: asText(item && item.id, 40) || ('ve_' + entries.length), from, to });
  }

  return { enabled, stats, maxChars, principles, entries, errors };
}

/** 面板保存前的严格校验（与 normalize 不同：这里要告诉人「哪一行错」）。 */
export function validateVoiceStyle(raw) {
  const errors = [];
  const style = normalizeVoiceStyle(raw);
  if (!Array.isArray(raw && raw.principles) && raw && raw.principles != null) errors.push('principles 必须是数组');
  if (!Array.isArray(raw && raw.entries) && raw && raw.entries != null) errors.push('entries 必须是数组');
  for (const item of (Array.isArray(raw && raw.principles) ? raw.principles : [])) {
    const line = String(item == null ? '' : item);
    if (!line.trim()) continue;
    if (line.length > VOICE_LINE_MAX) errors.push('原则太长（' + line.length + ' 字，上限 ' + VOICE_LINE_MAX + '）');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) errors.push('原则里有控制字符');
  }
  for (const item of (Array.isArray(raw && raw.entries) ? raw.entries : [])) {
    const from = String((item && item.from) == null ? '' : item.from);
    if (!from.trim()) continue;
    if (from.length > 40) errors.push('「原句」太长（' + from.length + ' 字，上限 40）：' + from.slice(0, 16) + '…');
    const toList = Array.isArray(item && item.to) ? item.to : [item && item.to];
    if (!toList.some((t) => String(t == null ? '' : t).trim())) errors.push('「' + from.slice(0, 16) + '」没有填改法');
  }
  const rendered = renderVoiceStylePrompt(style, { maxChars: style.maxChars });
  if (rendered.chars > style.maxChars) errors.push('渲染后 ' + rendered.chars + ' 字，超过上限 ' + style.maxChars);
  return { ok: errors.length === 0, errors, style, rendered };
}

/**
 * 渲染成注入文本。超长按整行切，不会切半个字。
 * 返回 { text, chars, truncated, droppedLines }。
 */
export function renderVoiceStylePrompt(style, options) {
  const maxChars = (options && Number(options.maxChars)) || VOICE_MAX_CHARS;
  const s = (style && typeof style === 'object') ? style : normalizeVoiceStyle(null);
  if (s.enabled === false) {
    return { text: LEGACY_FALLBACK, chars: LEGACY_FALLBACK.length, truncated: false, droppedLines: 0 };
  }
  const principles = (Array.isArray(s.principles) ? s.principles : []).map((x) => asText(x)).filter(Boolean);
  const entries = (Array.isArray(s.entries) ? s.entries : []).filter((e) => e && asText(e.from) && Array.isArray(e.to) && e.to.length);
  const lines = [VOICE_HEAD];
  if (principles.length) {
    lines.push('原则：');
    for (const p of principles) lines.push('- ' + p);
  }
  if (entries.length) {
    lines.push('词条（你想说左边这句的时候，换成右边任一种说法）：');
    for (const e of entries) lines.push('- 「' + e.from + '」→ ' + e.to.join(' / '));
  }
  if (lines.length <= 1) {
    return renderVoiceStylePrompt({ enabled: true, principles: DEFAULT_PRINCIPLES, entries: [] }, { maxChars });
  }

  const limit = Math.min(Math.max(Number(maxChars) || VOICE_MAX_CHARS, 120), 1200);
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const line of lines) {
    const add = (kept.length ? 1 : 0) + line.length;
    if (used + add > limit) { dropped += 1; continue; }
    kept.push(line);
    used += add;
  }
  const text = kept.join('\n');
  return { text, chars: text.length, truncated: dropped > 0, droppedLines: dropped };
}

function readJsonSync(file, fsImpl) {
  try {
    const stat = fsImpl.statSync(file);
    if (!stat || !stat.size) return { ok: false, mtimeMs: 0, size: 0, error: '文件是空的' };
    if (stat.size > 256 * 1024) return { ok: false, mtimeMs: stat.mtimeMs, size: stat.size, error: '文件太大（>256KB）' };
    const raw = fsImpl.readFileSync(file, 'utf8');
    return { ok: true, data: JSON.parse(raw), mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    return { ok: false, mtimeMs: 0, size: 0, error: error && error.code === 'ENOENT' ? '文件不存在' : String((error && error.message) || error) };
  }
}

/**
 * 读文件 → 归一 → 渲染。桥接每次唤醒调一次；按 mtimeMs:size 缓存解析结果，
 * 所以「改了文件下一轮生效」不用重启，也不会每轮重解析。
 * source: 'file'（真的用了文件）| 'default'（没文件/解析失败，用内置原则）| 'fallback'（enabled=false）
 */
export function readVoiceStyle(options) {
  const opts = options || {};
  const fsImpl = opts.fsImpl || fs;
  const target = String(opts.file || '');
  const stat = (() => { try { return fsImpl.statSync(target); } catch (e) { return null; } })();
  const key = stat ? (target + ':' + stat.mtimeMs + ':' + stat.size) : (target + ':missing');
  if (cache.style && cache.key === key) return cache.style;

  const parsed = readJsonSync(target, fsImpl);
  let style;
  let source;
  let error = '';
  if (!parsed.ok) {
    style = normalizeVoiceStyle(null);
    source = 'default';
    error = parsed.error || '';
  } else {
    style = normalizeVoiceStyle(parsed.data);
    source = style.enabled === false ? 'fallback' : 'file';
    error = (style.errors && style.errors[0]) || '';
  }
  const rendered = renderVoiceStylePrompt(style, { maxChars: style.maxChars });
  const result = {
    file: target,
    style,
    source,
    error,
    mtimeMs: parsed.mtimeMs || 0,
    text: rendered.text,
    chars: rendered.chars,
    truncated: rendered.truncated,
    droppedLines: rendered.droppedLines,
  };
  cache = { key, style: result };
  return result;
}

/** 给桥接用的唯一入口：拿到「这一轮要注入的文本」。 */
export function voiceStylePrompt(options) {
  const r = readVoiceStyle(options);
  return Object.assign({}, r, {
    entries: r.style.entries.length,
    principles: r.style.principles.length,
    enabled: r.style.enabled !== false,
  });
}

export function resetVoiceStyleCache() {
  cache = { key: '', style: null };
}

/** 一条消息的「AI 味」指标。只数数量，不存原文（设置里能关）。 */
export function countVoiceTraits(text, style) {
  const s = String(text == null ? '' : text);
  let emDash = 0;
  const dash = s.match(/——|—/g);
  if (dash) emDash = dash.length;
  let enum3 = 0;
  const listMark = [/[1１][.、)）]/, /[2２][.、)）]/, /[3３][.、)）]/, /[①②③]/, /首先/, /其次/, /最后[，,]/];
  let hits = 0;
  for (const re of listMark) if (re.test(s)) hits += 1;
  if (hits >= 2) enum3 = 1;
  let serviceWord = 0;
  for (const w of SERVICE_WORDS) if (s.includes(w)) serviceWord += 1;
  let entryHit = 0;
  let entryFollow = 0;
  const entries = (style && Array.isArray(style.entries)) ? style.entries : [];
  for (const e of entries) {
    if (e && e.from && s.includes(e.from)) entryHit += 1;
    if (e && Array.isArray(e.to) && e.to.some((t) => t && s.includes(t))) entryFollow += 1;
  }
  return { chars: s.length, emDash, enum3, serviceWord, entryHit, entryFollow };
}

function writeJsonAtomicSync(file, obj, fsImpl) {
  const impl = fsImpl || fs;
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  impl.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  impl.renameSync(tmp, file);
}

function emptyStats(day) {
  return { day, messages: 0, chars: 0, emDash: 0, enum3: 0, serviceWord: 0, entryHit: 0, entryFollow: 0, updatedAt: '' };
}

/** 读今天的统计（面板用）。跨天自动归零，不写盘。 */
export function readVoiceStats(options) {
  const opts = options || {};
  const fsImpl = opts.fsImpl || fs;
  const now = Number(opts.now) || Date.now();
  const day = dayKeyOf(now);
  const parsed = readJsonSync(String(opts.file || ''), fsImpl);
  if (!parsed.ok || !parsed.data || typeof parsed.data !== 'object') return emptyStats(day);
  const d = parsed.data;
  if (String(d.day || '') !== day) return emptyStats(day);
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  return {
    day,
    messages: num(d.messages), chars: num(d.chars), emDash: num(d.emDash), enum3: num(d.enum3),
    serviceWord: num(d.serviceWord), entryHit: num(d.entryHit), entryFollow: num(d.entryFollow),
    updatedAt: String(d.updatedAt || ''),
  };
}

/**
 * 记一批刚发出去的文本（桥接在 sendMessagesV2 成功后调）。
 * 先看 voice-style.json 的 stats 开关；关着就直接返回 null。
 */
export function recordVoiceStats(messages, options) {
  const opts = options || {};
  const fsImpl = opts.fsImpl || fs;
  const now = Number(opts.now) || Date.now();
  try {
    const style = readVoiceStyle({ file: opts.styleFile, fsImpl });
    if (style.style.stats === false) return null;
    const list = (Array.isArray(messages) ? messages : [messages]).map((m) => String(m == null ? '' : m)).filter(Boolean);
    if (!list.length) return null;
    const day = dayKeyOf(now);
    const cur = readVoiceStats({ file: opts.statsFile, now, fsImpl });
    const next = Object.assign({}, cur, { day, updatedAt: new Date(now).toISOString() });
    for (const text of list) {
      const t = countVoiceTraits(text, style.style);
      next.messages += 1;
      next.chars += t.chars;
      next.emDash += t.emDash;
      next.enum3 += t.enum3;
      next.serviceWord += t.serviceWord;
      next.entryHit += t.entryHit;
      next.entryFollow += t.entryFollow;
    }
    writeJsonAtomicSync(String(opts.statsFile || ''), next, fsImpl);
    return next;
  } catch (error) {
    // 统计坏了绝不能影响发送：吞掉，下次再说。
    return null;
  }
}
