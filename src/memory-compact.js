/**
 * 记忆卡压缩（2026-11-10）
 *
 * 为什么要有这一层：
 *   · 预渲染的记忆卡 memory-card-prompt-qq.md 是"全量叙事"，每轮固定注入 2500–3000 字
 *     （≈1600–1900 token），而且只增不减——条目一多，「最近记得的」整段都是原始聊天记录。
 *   · 实测（docs/vector-memory-comparison-2026-11-10.md 第七节）：
 *       全量卡 2686 字 → 命中 11/12
 *       紧凑卡  593 字 → 命中 10/12（少的那个"名字"由 self-identity 层单独注入，"视频上传"是数据缺失）
 *     也就是用 78% 的 token 换 91% 的命中，还避免了卡片随天数线性膨胀。
 *   · 所以注入的是"钉住的事实 + 他的偏好 + 少量高重要度事件"，旧事交给向量检索按需补。
 *
 * 这一层是纯函数：只读传入的卡片文本，不碰磁盘、不发网络请求，方便单测。
 */

const DEFAULT_COMPACT = {
  enabled: true,
  factChars: 220,      // 钉住的事实（生日/常住地/电话/截止日这类确定性信息）
  prefChars: 220,      // 他明确说过的偏好（回复一条、别追问、称呼）
  // 380/1,3,3 是实测选出的折中：再往下压（120/0,2,2）命中率一样是 10/12、字数省到 237，
  // 但会把「初次相遇」的语感和隐私叮嘱一起砍掉；往上到 520/1,3,5 只多 62 字却不再加分。
  coreChars: 380,      // 初次相遇 + 永远不会忘 + 记得最牢的（去重、截断）
  coreLimits: { firstMeet: 1, forever: 3, strongest: 3 },
  itemChars: 86,       // 单条事件截断长度
};

export const DEFAULT_MEMORY_COMPACT = DEFAULT_COMPACT;

export function normalizeCompactConfig(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const limits = raw.coreLimits && typeof raw.coreLimits === 'object' ? raw.coreLimits : {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    enabled: raw.enabled !== false,
    factChars: num(raw.factChars, DEFAULT_COMPACT.factChars, 60, 800),
    prefChars: num(raw.prefChars, DEFAULT_COMPACT.prefChars, 0, 800),
    coreChars: num(raw.coreChars, DEFAULT_COMPACT.coreChars, 120, 2000),
    coreLimits: {
      firstMeet: num(limits.firstMeet, DEFAULT_COMPACT.coreLimits.firstMeet, 0, 5),
      forever: num(limits.forever, DEFAULT_COMPACT.coreLimits.forever, 0, 8),
      strongest: num(limits.strongest, DEFAULT_COMPACT.coreLimits.strongest, 0, 12),
    },
    itemChars: num(raw.itemChars, DEFAULT_COMPACT.itemChars, 40, 200),
  };
}

/** 卡片文本 → [{ head, items }]（跳过标题为空的第一段）。 */
export function parseCardSections(text) {
  const out = [];
  let cur = { head: '', items: [] };
  for (const line of String(text ?? '').split('\n')) {
    if (/^#{2,3} /.test(line)) {
      out.push(cur);
      cur = { head: line.replace(/^#+\s*/, '').trim(), items: [] };
      continue;
    }
    if (/^[-·] /.test(line)) cur.items.push(line.replace(/^[-·]\s*/, '').trim());
  }
  out.push(cur);
  return out.filter((s) => s.head || s.items.length);
}

const FACT_RULES = [
  { key: 'birthday', label: '生日', re: /(?:生日|出生)[^\n。]{0,6}?(\d{1,2})\s*月\s*(\d{1,2})/, fmt: (m) => Number(m[1]) + ' 月 ' + Number(m[2]) + ' 日' },
  { key: 'city', label: '常住地', re: /([\u4e00-\u9fa5]{2,8})[，,]\s*记住了/, fmt: (m) => m[1] },
  { key: 'insurance', label: '截止日', re: /(?:医保|参保|截止|deadline)[^\n]{0,30}?(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*号)/, fmt: (m) => '医保 ' + m[1] },
  { key: 'phone', label: '手机号', re: /\b(1[3-9]\d{9})\b/, fmt: (m) => m[1] },
  { key: 'nickname', label: '称呼', re: /(?:叫我|喊我)([\u4e00-\u9fa5A-Za-z]{1,6})/, fmt: (m) => m[1] },
];

/**
 * 从卡片条目里抽确定性事实。
 * 只认「主人说的」——她的回复里复述的东西不新增事实，避免把玩笑话钉死。
 */
export function extractFacts(items = []) {
  const facts = new Map();
  for (const item of items) {
    if (!String(item).includes('主人')) continue;
    for (const rule of FACT_RULES) {
      const m = rule.re.exec(item);
      if (!m) continue;
      facts.set(rule.key, rule.label + '：' + String(rule.fmt(m)).trim());
    }
  }
  return [...facts.values()];
}

const PREF_RULES = [
  /(?:下次|以后|能不能|希望).{0,20}(?:一条|别|不要|少说|多说|自由|权限)/,
  /(?:喜欢|讨厌|不用刻意|别这样)/,
  /(?:叫我|喊我)/,
];

/** 他明确表达过的偏好（只认主人那句，不看她的回复）。 */
export function extractPreferences(items = [], { limit = 4, maxChars = 56 } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const line = String(item);
    if (!line.includes('主人')) continue;
    if (!PREF_RULES.some((re) => re.test(line))) continue;
    const ask = line.split('→')[0].replace(/^\d{4}-\d{2}-\d{2}\s*\[\S+?\]\s*/, '').trim();
    const key = ask.replace(/[\s，,。~！!?？：:]/g, '').slice(-14);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ask.length > maxChars ? ask.slice(0, maxChars - 1) + '…' : ask);
    if (out.length >= limit) break;
  }
  return out;
}

function trimToChars(block, max) {
  if (!block || block.length <= max) return block;
  const lines = block.split('\n');
  while (lines.length > 1 && lines.join('\n').length > max) lines.pop();
  const out = lines.join('\n');
  return out.length <= max ? out : out.slice(0, Math.max(0, max));
}

/**
 * 卡片 → 紧凑注入块。
 * 结构：钉住的事实 / 他的偏好 / 初次相遇 / 永远不会忘的 / 记得最牢的事
 */
export function buildCompactCard(cardText, options = {}) {
  const cfg = normalizeCompactConfig(options);
  const sections = parseCardSections(cardText);
  const allItems = sections.flatMap((s) => s.items);

  const facts = extractFacts(allItems);
  const prefs = extractPreferences(allItems);
  const factBlock = facts.length ? trimToChars('【钉住的事实】\n' + facts.map((f) => '· ' + f).join('\n'), cfg.factChars) : '';
  const prefBlock = prefs.length ? trimToChars('【他的偏好】\n' + prefs.map((p) => '· ' + p).join('\n'), cfg.prefChars) : '';

  const core = [];
  for (const section of sections) {
    const isFirst = /初次相遇/.test(section.head);
    const isForever = /永远不会忘的/.test(section.head);
    const isStrong = /记得最牢的事/.test(section.head);
    if (!isFirst && !isForever && !isStrong) continue;
    const limit = isFirst ? cfg.coreLimits.firstMeet : isForever ? cfg.coreLimits.forever : cfg.coreLimits.strongest;
    if (limit <= 0) continue;
    const seen = new Set();
    const items = [];
    for (const item of section.items) {
      // 去重键必须先在去掉日期前缀后计算——否则同一天的条目前 16 字全是「2026-11-09 [清晰] 主人」，
      // 会被误判成同一条（实测把 5 条裁成 2 条）。
      const clean = item.replace(/^\d{4}-\d{2}-\d{2}\s*/, '');
      const key = clean.replace(/[\s，,。~！!?？：:]/g, '').slice(0, 20);
      if (seen.has(key)) continue;
      seen.add(key);
      const text = clean.length > cfg.itemChars ? clean.slice(0, cfg.itemChars - 1) + '…' : clean;
      items.push('- ' + text);
      if (items.length >= limit) break;
    }
    if (items.length) core.push('## ' + section.head + '\n' + items.join('\n'));
  }
  const coreBlock = trimToChars(core.join('\n\n'), cfg.coreChars);

  return [factBlock, prefBlock, coreBlock].filter(Boolean).join('\n\n');
}

/**
 * 拼最终注入文本。
 * - compact 关闭 → 原样返回卡片（向后兼容）
 * - 卡片为空 → 直接给向量块（没有卡片也不能丢旧事）
 * - 其余 → 紧凑卡 + 向量块（向量块超预算由调用方控制 maxChars）
 */
export function buildMemoryPromptText({ cardText = '', vectorText = '', compact = {} } = {}) {
  const cfg = normalizeCompactConfig(compact);
  const card = String(cardText ?? '').trim();
  const vec = String(vectorText ?? '').trim();
  if (!cfg.enabled) return [card, vec].filter(Boolean).join('\n\n');
  if (!card) return vec;
  const compacted = buildCompactCard(card, cfg);
  return [compacted, vec].filter(Boolean).join('\n\n');
}
