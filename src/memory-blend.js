// 记忆注入的混合策略（2026-11-10）
//
// 三种模式（memory.mode）：
//   narrative —— 只注入预渲染记忆卡（默认；钉住的事实每轮都在）
//   vector    —— 只注入按当前消息检索到的旧事（省上下文，但核心事实可能检索不到）
//   hybrid    —— 记忆卡照旧 + 向量只补日常漏项（带独立预算，超了先裁向量侧）
//
// 这个文件只放纯函数，方便单测与离线对比；bridge 只负责取数据后调 blendMemoryBlocks。

export const MEMORY_MODES = Object.freeze(['narrative', 'vector', 'hybrid']);
export const DEFAULT_MEMORY_MODE = 'narrative';

/** hybrid 的独立预算：向量侧默认只给 400 字 / topK 3，避免把记忆卡挤掉。 */
export const DEFAULT_HYBRID_CONFIG = Object.freeze({
  enabled: true,
  topK: 3,
  minScore: 0.4,
  injectMaxChars: 400,
  maxTotalChars: 3000,
});

function clampInt(value, def, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 未知值一律回落 narrative：配置写错不能让记忆整个消失。 */
export function normalizeMemoryMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return MEMORY_MODES.includes(text) ? text : DEFAULT_MEMORY_MODE;
}

export function normalizeHybridConfig(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    enabled: raw.enabled !== false,
    topK: clampInt(raw.topK, DEFAULT_HYBRID_CONFIG.topK, 1, 10),
    minScore: clampNumber(raw.minScore, DEFAULT_HYBRID_CONFIG.minScore, 0, 1),
    injectMaxChars: clampInt(raw.injectMaxChars, DEFAULT_HYBRID_CONFIG.injectMaxChars, 100, 2000),
    maxTotalChars: clampInt(raw.maxTotalChars, DEFAULT_HYBRID_CONFIG.maxTotalChars, 500, 20000),
  };
}

function dropLastLine(text) {
  const lines = String(text ?? '').split('\n');
  // 保留尾部说明行（以「（」开头的括号说明），只删中间条目
  const notes = [];
  while (lines.length && /^\s*[（(]/.test(lines[lines.length - 1])) notes.unshift(lines.pop());
  lines.pop();
  return [...lines, ...notes].join('\n').trim();
}

/**
 * 组装本轮注入的记忆块。
 * narrative 为空时 hybrid 退化成纯向量；vector 为空时退化成纯叙事（都不报错）。
 */
export function blendMemoryBlocks({
  mode = DEFAULT_MEMORY_MODE,
  narrative = '',
  vector = '',
  hybrid = DEFAULT_HYBRID_CONFIG,
} = {}) {
  const walk = normalizeMemoryMode(mode);
  const narr = String(narrative ?? '').trim();
  const vec = String(vector ?? '').trim();
  if (walk === 'vector') return vec;
  if (walk === 'narrative') return narr;
  const h = normalizeHybridConfig(hybrid);
  if (!h.enabled || !vec) return narr;
  if (!narr) return vec;
  let block = narr + '\n\n' + vec;
  // 超预算只裁向量侧（叙事侧是钉住的事实，优先级更高）。
  let body = vec;
  let guard = 0;
  while (block.length > h.maxTotalChars && body && guard < 60) {
    const trimmed = dropLastLine(body);
    if (trimmed === body) break;
    body = trimmed;
    block = narr + '\n\n' + body;
    guard += 1;
  }
  return block;
}

/** 供工具侧（qq_get_prompt）说明当前模式用。 */
export function memoryModeHint(mode) {
  switch (normalizeMemoryMode(mode)) {
    case 'vector':
      return '当前是向量记忆模式：提示词里注入的是按消息检索到的旧事，不在工具里返回整张记忆卡。';
    case 'hybrid':
      return '当前是混合记忆模式：提示词里既有记忆卡（钉住的事实），也有按这条消息检索到的旧事；工具里只返回记忆卡。';
    default:
      return '';
  }
}

export function hybridVectorOptions(hybrid = DEFAULT_HYBRID_CONFIG) {
  const h = normalizeHybridConfig(hybrid);
  return { topK: h.topK, minScore: h.minScore, injectMaxChars: h.injectMaxChars };
}
