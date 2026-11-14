/**
 * 记忆仓库（Memory Store v1）：分层记忆的读写、原子落盘、清空/晋升、Top-K 检索。
 *
 * 设计约束：
 *   · 原文与全量存档沿用 src/memory-card.js（不清空、不重写档案，只追加）；
 *   · 写入用「临时文件 + rename」，维护用文件锁，避免插件与桥接互相覆盖；
 *   · 检索只做内存内打分（记录量级 ~200-2000，无需外部向量库）；
 *   · 纯同步读路径（提示词构建不能 await），异步只用在维护。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  archiveDecayedToFull,
  createEmptyCard,
  loadMemoryCard,
  normalizeMemoryCardConfig,
  resolveMemoryCardPaths,
} from './memory-card.js';
import {
  assignTier,
  buildDigestRecord,
  normalizeTierConfig,
  planTierMaintenance,
  rankMemories,
  renderRecallBlock,
  tierOfRecord,
} from './memory-tiers.js';

const LOCK_STALE_MS = 30_000;

export function storePaths(memoryDir) {
  return resolveMemoryCardPaths(memoryDir);
}

export function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now().toString(36));
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 文件锁：拿不到就重试；超过 stale 的锁视为崩溃残留，直接清掉。 */
export async function withFileLock(file, fn, { timeoutMs = 8000, staleMs = LOCK_STALE_MS } = {}) {
  const lock = file + '.lock';
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lock);
          if (Date.now() - stat.mtimeMs > staleMs) { fs.rmSync(lock, { force: true }); continue; }
        } catch {}
        if (Date.now() > deadline) throw new Error('memory-store: lock timeout');
        await sleep(30);
        continue;
      }
      throw error;
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.rmSync(lock, { force: true }); } catch {}
  }
}

/** 读卡（同步、只读，供提示词构建用）；不存在给空卡。 */
export function loadCardForRead(memoryDir) {
  const paths = storePaths(memoryDir);
  return loadMemoryCard(paths) || createEmptyCard();
}

export function saveCard(memoryDir, card, { config = {}, now = Date.now() } = {}) {
  const paths = storePaths(memoryDir);
  const cfg = normalizeMemoryCardConfig(config);
  const next = Object.assign({}, card, { updatedAt: new Date(now).toISOString() });
  next.records = (Array.isArray(card.records) ? card.records : []).map((record) => assignTier(record, cfg));
  writeJsonAtomic(paths.json, next);
  return next;
}

/**
 * 分层维护：三级每日、二级每周；清空前先归档原文、先判晋升。
 * 返回 { promoted, cleared, digest, kept }，方便控制台展示与日志。
 */
export async function runTierMaintenance({ memoryDir, config = {}, tierConfig = {}, now = Date.now(), forceClear = '' } = {}) {
  const paths = storePaths(memoryDir);
  const cfg = normalizeMemoryCardConfig(config);
  const tc = normalizeTierConfig(tierConfig);
  return withFileLock(paths.json, async () => {
    const card = loadMemoryCard(paths) || createEmptyCard(now);
    card.records = (Array.isArray(card.records) ? card.records : []).map((record) => assignTier(record, cfg));
    // forceClear 来自控制台的「立即清空」按钮；自动维护永远不传，走正常周期闸门。
    const plan = planTierMaintenance({ records: card.records, now, cfg: tc, forceClear });
    if (!plan.promote.length && !plan.clear.length) {
      return { promoted: [], cleared: [], digest: null, kept: card.records.length };
    }
    // 清空前把还没进全量档案的原文追加进去（append-only，不重写档案）。
    if (plan.clear.length) {
      try { archiveDecayedToFull(paths, card, cfg, now); } catch {}
    }
    const promoteMap = new Map(plan.promote.map((item) => [item.id, item]));
    const clearSet = new Set(plan.clear.map((item) => item.id));
    const cleared = [];
    const kept = [];
    for (const record of card.records) {
      const promote = promoteMap.get(record.id);
      if (promote) {
        record.tier = promote.to;
        record.clearedCycle = '';
        record.promotedAt = new Date(now).toISOString();
        record.promotedReason = promote.reason;
        kept.push(record);
        continue;
      }
      if (clearSet.has(record.id)) { cleared.push(record); continue; }
      kept.push(record);
    }
    let digest = null;
    const groups = { L2: [], L3: [] };
    for (const record of cleared) {
      const tier = tierOfRecord(record, tc);
      const bucket = tier === 'L2' ? groups.L2 : groups.L3;
      bucket.push(record);
    }
    for (const tier of ['L2', 'L3']) {
      const built = buildDigestRecord(groups[tier], { tier, now, cfg: tc });
      if (built) { kept.push(built); digest = built; }
    }
    card.records = kept;
    card.lastTierMaintenanceAt = new Date(now).toISOString();
    card.tierCycles = plan.cycles;
    saveCard(memoryDir, card, { config, now });
    return {
      promoted: plan.promote,
      cleared: cleared.map((record) => ({ id: record.id, tier: tierOfRecord(record, tc), summary: String(record.title || record.text || '').slice(0, 60) })),
      digest: digest ? { id: digest.id, text: digest.text } : null,
      kept: card.records.length,
    };
  });
}

// ── 读路径：给提示词构建用的同步检索（带 mtime 缓存） ──────────────────────

const cardCache = new Map();

function cachedCard(memoryDir) {
  const paths = storePaths(memoryDir);
  let sig = 'missing';
  try {
    const stat = fs.statSync(paths.json);
    sig = stat.mtimeMs + ':' + stat.size;
  } catch {}
  const hit = cardCache.get(paths.json);
  if (hit && hit.sig === sig) return hit.card;
  const card = loadMemoryCard(paths) || createEmptyCard();
  card.records = (Array.isArray(card.records) ? card.records : []).map((record) => assignTier(record));
  cardCache.set(paths.json, { sig, card });
  return card;
}

export function invalidateCardCache(memoryDir) {
  const paths = storePaths(memoryDir);
  cardCache.delete(paths.json);
}

/**
 * 按当前消息检索 Top-K 记忆并渲染成注入块。
 * 返回 '' 表示没有足够相关的记忆（调用方可以退回旧的预渲染块）。
 */
export function recallBlockForPrompt({ memoryDir, key = '', query = '', tierConfig = {}, now = Date.now() } = {}) {
  const tc = normalizeTierConfig(tierConfig);
  if (tc.enabled === false) return { block: '', hits: [] };
  const text = String(query || '').trim();
  if (text.length < 2) return { block: '', hits: [] };
  const card = cachedCard(memoryDir);
  const hits = rankMemories({ records: card.records, query: text, key, now, cfg: tc });
  if (!hits.length) return { block: '', hits: [] };
  // 访问计数与最后访问时间：只在内存里累加，落盘交给下一次维护，避免每轮写盘。
  for (const hit of hits) {
    const record = hit.record;
    record.recallCount = (Number(record.recallCount) || 0) + 1;
    record.lastSeenAt = new Date(now).toISOString();
  }
  return { block: renderRecallBlock(hits, { maxChars: tc.maxInjectChars, now }), hits };
}

/** 按 id 拉原文（控制台 / 工具用）。 */
export function memoryById({ memoryDir, id }) {
  const card = cachedCard(memoryDir);
  return card.records.find((record) => String(record.id) === String(id)) || null;
}

export function listByTier({ memoryDir, tier = '', limit = 50 } = {}) {
  const card = cachedCard(memoryDir);
  const want = String(tier || '').toUpperCase();
  return card.records
    .filter((record) => (want ? tierOfRecord(record) === want : true))
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
}
