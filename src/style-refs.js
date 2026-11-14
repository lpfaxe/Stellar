/**
 * 角色风格参考引擎（设计 §6，模块三）。
 *
 * 纯逻辑，无顶层 import、不碰 sqlite、不读文件：
 *  · scripts/index-style-refs.mjs 用 parseReferenceText() 把参考库切成切片；
 *  · src/memory-read.js 用 pickStyleSlices() + renderStyleRefBlock() 在唤醒时同步挑片；
 *  · 单元测试直接 import 本文件即可。
 *
 * 三条硬规则（设计 §6.2 / §6.3）：
 *  1. 注入块里**不出现参考角色的名字**（出现名字 = 模型开始扮演 TA）；
 *  2. 只在命中高情绪情境时注入，普通闲聊 0 成本；傲娇（嘴硬+心软同现）算高情绪；
 *  3. 2 片、总字符硬上限（默认 900），且不提供任何「查参考」的工具。
 */

/**
 * 参考库里的名字 → 中性称呼。名字一旦进提示词，模型就会开始扮演 TA；
 * 作品里的其他角色名同理（不然她会开始演「对方」）。长名必须排在短名前。
 */
const NAME_REPLACEMENTS = [
  [/一色彩羽|一色伊吕波/g, '参考对象'],
  [/由比滨结衣|由比滨|结衣/g, '旁人'],
  [/雪之下雪乃|小雪乃|雪乃/g, '旁人'],
  [/比企谷八幡|比企谷|八幡/g, '对方'],
  [/叶山隼人|叶山/g, '旁人'],
  [/三浦优美子|三浦/g, '旁人'],
  [/户冢彩加|户冢/g, '旁人'],
  [/材木座义辉|材木座/g, '旁人'],
  [/小町|小米/g, '旁人'],
  [/平冢静|平冢/g, '老师'],
  [/伊吕波|彩羽|一色/g, '参考对象'],
  [/我的青春恋爱物语果然有问题/g, '参考作品'],
];

// 参考库是「教材」，里面带着排版标记。这些标记进了提示词就是噪音：
// 模型会照着抄格式（`【原文】`）、或把「✗/○ 改」当成它要说的话。
const MARK_REPLACEMENTS = [
  [/[（(]?【原文】[）)]?/g, ''],
  [/[（(]?【拟写】[）)]?/g, ''],
  [/^\s*[×✗]\s*/gm, '别这样：'],
  [/^\s*[○◯]\s*改[：:]\s*/gm, '改成：'],
];

export function scrubStyleText(text) {
  let out = String(text || '');
  for (const [re, to] of NAME_REPLACEMENTS) out = out.replace(re, to);
  out = out.replace(/^\s*A\s*(?:[（(][^）)]{0,10}[）)])?\s*[：:]?\s*/gm, '');
  for (const [re, to] of MARK_REPLACEMENTS) out = out.replace(re, to);
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 情境标签词表：命中越多越像「高情绪」。没命中就是普通闲聊，不注入。 */
const TAG_RULES = [
  ['撒娇', /撒娇|呜哇|抱抱|亲亲|要嘛|哼哼|蹭|黏|好想|想你/g],
  ['生气', /生气|火大|烦死|讨厌|不爽|凭什么|气死|哼|不理你|凶/g],
  ['被夸', /夸|好看|漂亮|厉害|可爱|好棒|称赞|表扬/g],
  ['要安慰', /难过|委屈|伤心|郁闷|想哭|哭了|好累|撑不住|低落/g],
  ['尴尬', /尴尬|害羞|脸红|被看穿|拆穿|窘|社死|不好意思/g],
  ['抱怨', /抱怨|吐槽|又来了|总是|每次都是|烦|受不了/g],
  ['拒绝', /不行|不要|算了|拒绝|免谈|没可能|不想/g],
  ['道歉', /对不起|抱歉|道歉|是我错|原谅/g],
  ['暧昧', /喜欢|在意|想你|心动|关系|在一起|暧昧/g],
];

/** 这些标签算「高情绪」：只有它们才触发注入（抱怨/拒绝/道歉太常见，单独不触发）。 */
const HIGH_MOOD = new Set(['撒娇', '生气', '被夸', '要安慰', '尴尬', '暧昧', '傲娇']);

/**
 * 傲娇（tsundere）是**组合特征**，不是单个词：嘴硬 + 心软要出现在同一个「口气」里。
 * 单看「麻烦死了」是抱怨、单看「就是喜欢」是暧昧——都不是傲娇；两句凑一起才是。
 *
 * 判定规则：
 *  1. 先按 ，；。！？ 切成半句；
 *  2. 同一半句里既有嘴硬词又有心软词 → 命中；
 *  3. 跨半句时，**软半句必须以转折词开头**（但/不过/可是/其实/没办法）才算；
 *     「今天好烦。我挺喜欢你上次说的那个」不算——两句话之间没有转折关系。
 */
const TSUNDERE_WINDOW = 24;
const TSUNDERE_HARD = /麻烦|烦|讨厌|才不|才没有|算了|懒得|不理你|笨蛋|随便|哼|凶|不想/g;
const TSUNDERE_SOFT = /但|不过|可是|其实|没办法|无所谓|喜欢|在意|担心|心疼|舍不得|谢谢|还好|不讨厌/g;
const TSUNDERE_TURN = /^(但|不过|可是|其实|没办法|反正|话说)/;

function hardenedClauses(text) {
  const body = String(text || '');
  const out = [];
  const re = /[^，,；;。！!？?\n]+/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const t = m[0].trim();
    if (t) out.push(t);
  }
  return out;
}

function hasAny(re, text) {
  re.lastIndex = 0;
  return re.test(text);
}

/** 正负信号是否在同一个「口气」里（见上面的规则）。 */
export function detectTsundere(text) {
  const clauses = hardenedClauses(text);
  if (!clauses.length) return false;
  for (let i = 0; i < clauses.length; i += 1) {
    const clause = clauses[i];
    if (!hasAny(TSUNDERE_HARD, clause)) continue;
    if (hasAny(TSUNDERE_SOFT, clause)) return true;
    // 跨半句：只认「转折开头」的下一半句，且不再看更远
    const next = clauses[i + 1];
    if (next && TSUNDERE_TURN.test(next) && hasAny(TSUNDERE_SOFT, next)) return true;
  }
  return false;
}

export function tagsOfText(text) {
  const body = String(text || '');
  const hits = [];
  for (const [tag, re] of TAG_RULES) {
    re.lastIndex = 0;
    if (re.test(body)) hits.push(tag);
  }
  // 傲娇是组合判定，跑在单词榜之后；命中就补一个标签（不覆盖已有的抱怨/暧昧）。
  if (detectTsundere(body) && !hits.includes('傲娇')) hits.push('傲娇');
  return hits;
}

/**
 * 从对方这句话判断情境。返回 { tags, high }；high=false 表示不注入。
 * opts: { isGroup, addressed } —— 群聊没点名她时一律不注入（设计 §6.2）。
 */
export function detectStyleTags(text, opts = {}) {
  const tags = tagsOfText(text);
  if (opts.isGroup && !opts.addressed) return { tags, high: false, reason: 'group-unaddressed' };
  const high = tags.some((t) => HIGH_MOOD.has(t));
  if (!high) return { tags, high: false, reason: tags.length ? 'low-mood' : 'no-mood' };
  return { tags, high: true, reason: 'high-mood' };
}

function splitParts(text) {
  const body = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const rows = body.split('\n');
  const parts = [];
  let cur = null;
  for (const raw of rows) {
    const line = raw.replace(/\s+$/, '');
    const appendix = /^附[：:]/.test(line.trim());
    const m = appendix ? [null, '', line.trim()] : /^PART\s*(\d+)\s*(.*)$/i.exec(line.trim());
    if (m) {
      cur = { part: appendix ? 'APPENDIX' : 'PART' + m[1], title: String(m[2] || '').replace(/^[　\s]+/, '').trim(), rows: [] };
      parts.push(cur);
      continue;
    }
    if (cur) cur.rows.push(line);
  }
  return parts;
}

function pushSlice(out, item) {
  const text = scrubStyleText(String(item.text || '').replace(/\n{3,}/g, '\n\n').trim());
  if (!text) return;
  if (text.length > 800) return; // 设计 §6.1：>800 字的片不索引（注入反占预算）
  out.push({
    part: item.part,
    kind: item.kind,
    tags: Array.isArray(item.tags) && item.tags.length ? item.tags : tagsOfText(text),
    mood: String(item.mood || ''),
    text,
    chars: text.length,
  });
}

/** PART 2 / PART 3 / PART 5：按「规则 N｜」「数字｜」「◆ 小标题」切 rule。 */
function splitRules(part, rows, out) {
  const blocks = [];
  let cur = null;
  const headRe = /^(规则\s*\d+\s*[｜|]|\d+\s*[｜|]|◆\s*)/;
  for (const line of rows) {
    const t = line.trim();
    if (!t || /^[═─━]{5,}$/.test(t)) continue;
    if (headRe.test(t)) {
      if (cur) blocks.push(cur);
      cur = { head: t.replace(/[｜|]/g, '｜'), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);
  for (const b of blocks) {
    // 「◆ 情绪开关（输入 → 反应）」是设计里最值钱的一段：按「输入：」再切，
    // 这样 ×撒娇 / ×被夸 / ×被追问 各自成一条，选片才能按情境命中。
    if (/情绪开关/.test(b.head)) {
      let group = null;
      for (const line of b.body) {
        const t = line.trim();
        if (!t) continue;
        if (/^输入[：:]/.test(t)) {
          if (group) pushSlice(out, { part, kind: 'rule', text: group.join('\n') });
          group = [t];
          continue;
        }
        if (group) group.push(t);
      }
      if (group) pushSlice(out, { part, kind: 'rule', text: group.join('\n') });
      continue;
    }
    const body = b.body.join('\n').trim();
    if (!body) continue;
    pushSlice(out, { part, kind: 'rule', text: b.head + '\n' + body });
  }
}

/** PART 4：每个「■ 场景」切一条 sample，只留 A 的对白（最多 4 行、≤400 字）。 */
function splitSamples(part, rows, out) {
  const scenes = [];
  let cur = null;
  for (const line of rows) {
    const t = line.trim();
    if (!t || /^[═─━]{5,}$/.test(t)) continue;
    if (/^■/.test(t)) {
      if (cur) scenes.push(cur);
      cur = { title: t.replace(/^■\s*/, ''), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(t);
  }
  if (cur) scenes.push(cur);
  for (const s of scenes) {
    const inner = /独白|内心/.test(s.title);
    const aLines = s.lines.filter((l) => /^A[（(：:]/.test(l) || /^A\s*[：:]/.test(l));
    if (inner) {
      const bullets = s.lines.filter((l) => /^[・·]/.test(l)).slice(0, 5);
      if (bullets.length) pushSlice(out, { part, kind: 'rule', tags: ['内心'], mood: 'inner', text: '内心独白（只学语气，别照抄）\n' + bullets.join('\n') });
      continue;
    }
    const picked = aLines.slice(0, 4).join('\n');
    if (!picked) continue;
    pushSlice(out, { part, kind: 'sample', mood: s.title.split('｜')[0] || '', text: picked });
  }
}

/** PART 6：每条「✗」切一条 mistake（✗ 原句 + ○ 改法，成对才有意义）。 */
function splitMistakes(part, rows, out) {
  const blocks = [];
  let cur = null;
  for (const line of rows) {
    const t = line.trim();
    if (!t || /^[═─━]{5,}$/.test(t)) continue;
    if (/^✗/.test(t)) {
      if (cur) blocks.push(cur);
      cur = { head: t, body: [] };
      continue;
    }
    if (cur) cur.body.push(t);
  }
  if (cur) blocks.push(cur);
  for (const b of blocks) {
    const body = b.body.join('\n').trim();
    if (!body) continue;
    pushSlice(out, { part, kind: 'mistake', text: b.head + '\n' + body });
  }
}

/**
 * 把一份参考库正文切成切片。PART 1（角色档案）刻意不入库：
 * 那是「TA 是谁」，注入进来就会把她变成另一个人。
 */
export function parseReferenceText({ text, part: onlyPart = '' } = {}) {
  const out = [];
  const parts = splitParts(text);
  for (const p of parts) {
    if (onlyPart && p.part !== onlyPart) continue;
    const rows = p.rows;
    if (p.part === 'PART0') {
      const body = rows.filter((l) => !/^[═─━]{5,}$/.test(l.trim())).join('\n').trim();
      if (body) pushSlice(out, { part: p.part, kind: 'prompt', tags: ['全局'], text: body });
      continue;
    }
    if (p.part === 'PART1' || p.part === 'APPENDIX') continue;
    if (p.part === 'PART4') { splitSamples(p.part, rows, out); continue; }
    if (p.part === 'PART6') { splitMistakes(p.part, rows, out); continue; }
    splitRules(p.part, rows, out);
  }
  return out;
}

function tagScore(slice, tags) {
  const own = Array.isArray(slice.tags) ? slice.tags : [];
  let score = 0;
  for (const t of tags) if (own.includes(t)) score += 1;
  if (!score) return 0;
  // 同样命中时，优先「输入：→ 反应」这种正向演法；纯禁忌（◆ 禁忌 / 演崩）是兜底，
  // 它只会说「别这样」，对「这轮该怎么回」的指导价值低于演法本身。
  if (/输入[：:]/.test(slice.text)) score += 1;
  if (/禁忌|演崩/.test(slice.text)) score -= 1;
  return score;
}

/**
 * 从切片里挑 1 条 rule + 1 条 sample（设计 §6.2：命中高情绪时注入 2 片）。
 * 预算：总字符 ≤ maxChars，单条 ≤ 400 字符。返回 [{ kind, text, chars }]。
 */
export function pickStyleSlices(slices, { tags = [], maxSlices = 2, maxChars = 900 } = {}) {
  const all = (Array.isArray(slices) ? slices : []).filter((s) => s && s.text);
  if (!all.length || !tags.length) return [];
  const budget = Math.max(200, Number(maxChars) || 900);
  const want = Math.max(1, Math.min(3, Number(maxSlices) || 2));
  const scored = all
    .filter((s) => s.kind === 'rule' || s.kind === 'sample')
    .map((s) => ({ slice: s, score: tagScore(s, tags) }))
    .filter((x) => x.score > 0)
    .sort((a, b) =>
      (b.score - a.score) ||
      // 同一情境下优先「输入：→ 反应」这类正向演法，纯禁忌放后面当兜底。
      (Number(/输入[：:]/.test(a.slice.text)) ? 0 : 1) - (Number(/输入[：:]/.test(b.slice.text)) ? 0 : 1) ||
      (a.slice.chars - b.slice.chars));
  if (!scored.length) return [];
  const picks = [];
  const used = new Set();
  let left = budget;
  const take = (kinds) => {
    for (const x of scored) {
      if (used.has(x.slice.id ?? x.slice.text)) continue;
      if (!kinds.includes(x.slice.kind)) continue;
      if (x.slice.chars > 400) continue;
      if (x.slice.chars > left) continue;
      used.add(x.slice.id ?? x.slice.text);
      picks.push({ kind: x.slice.kind, text: x.slice.text, chars: x.slice.chars });
      left -= x.slice.chars;
      return true;
    }
    return false;
  };
  take(['rule']);
  if (picks.length < want) take(['sample']);
  while (picks.length < want && take(['rule', 'sample'])) {}
  return picks.slice(0, want);
}

/** 按设计 §6.3 渲染注入块；没有片就返回空串（调用方据此不注入）。 */
export function renderStyleRefBlock(picks, { personaName = '' } = {}) {
  const list = Array.isArray(picks) ? picks.filter((p) => p && p.text) : [];
  if (!list.length) return '';
  const who = String(personaName || '').trim() || '现在的你';
  const body = list.map((p) => (p.kind === 'sample' ? '（切片）' : '（参考）') + String(p.text).trim()).join('\n\n');
  return [
    '【参考报告】',
    body,
    '',
    '【重要提醒】你现在是' + who + '（保持你自身的核心设定）。',
    '请吸收上面报告里的「沟通技巧、情绪反馈方式、生动的用语习惯」，融合到你自己的性格中。',
    '不要直接背诵切片台词，也不要丢失你自己的身份，用你自己的声音去回应。',
    '',
  ].join('\n');
}

/**
 * 同一种情境连续出现时的节流状态机（设计 §6.2「别复读」）。
 * prev 是上一次的 { sig, count }；返回 { sig, count, skip }。
 * 同一组标签连续第 3 次起跳过，标签一变就重新计数。
 */
export function nextStyleStreak(prev, sig, limit = 3) {
  const record = prev && typeof prev === 'object' ? prev : null;
  const key = String(sig || '');
  const cap = Math.max(2, Number(limit) || 3);
  if (!key) return { sig: '', count: 0, skip: false };
  const count = record && record.sig === key ? Number(record.count || 0) + 1 : 1;
  return { sig: key, count, skip: count >= cap };
}
