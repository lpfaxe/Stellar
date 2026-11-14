/**
 * 记忆库的「读侧」薄封装（bridge 用）。
 *
 * 为什么单独一层（与 memory-cache.js 同一个理由）：
 *  · bridge.js 被 vm.runInNewContext 加载做审计；memory-db.js 顶层就 `import { DatabaseSync } from 'node:sqlite'`，
 *    静态 import 过来会把 sqlite 依赖一起带进沙箱，失败清单从「缺 normalizeHybridConfig」变成「缺 DatabaseSync」。
 *    所以这里只在**首次真的要用**时动态 import。
 *  · 唯一的静态 import 是 style-refs.js —— 纯函数、不碰 sqlite、不读文件，进沙箱无副作用。
 *  · buildWakePromptV2 是同步函数，不能 await 一个 import。于是做成 stale-while-revalidate：
 *    第一次读给空（唤醒里退回旧记忆卡），同时后台预热；之后每次读的都是上一次的缓存（默认 60 秒）。
 *    代价是「刚重启的第一条唤醒只有旧卡片」，换来的是唤醒路径永不阻塞、永不因为库坏而发不出消息。
 *
 * 边界：只读，不写。写入走 memory-cache.js（入站/出站双写）。
 * 开关：stellar/config.json 的 memory.engine === 'db' 才用；否则调用方根本不该调到这里。
 */
import * as STYLE from './style-refs.js';

let modPromise = null;
let lastErrorAt = 0;

function styleLogic() {
  return STYLE && typeof STYLE.pickStyleSlices === 'function' ? STYLE : null;
}

const CATALOG_TTL_MS = 60 * 1000;
const PERSONA_TTL_MS = 5 * 60 * 1000;
const STYLE_TTL_MS = 5 * 60 * 1000;
const catalogRecords = new Map();
// 重要事实（生日/忌口/约定）按「人 + 看的视角」缓存：同一份事实，私聊能给全三级、群聊只给 normal，
// 所以缓存键必须带 audience，否则群聊会读到上一轮私聊那份（会把 secret 念给群里）。
const factRecords = new Map();
const factInflight = new Map();
const FACT_TTL_MS = 60 * 1000;
const personaRecords = new Map();
const catalogInflight = new Map();
const personaInflight = new Map();
// 参考库切片是全局的（不按 owner 分），一份就够：50 条约 6KB，选片在内存里做。
let styleRecord = null;
let styleInflight = null;

function load() {
  if (!modPromise) {
    modPromise = import('./memory-db.js').catch((error) => {
      modPromise = null;
      throw error;
    });
  }
  return modPromise;
}

function noteError(error, log) {
  const now = Date.now();
  if (!log || now - lastErrorAt < 10 * 60 * 1000) return;
  lastErrorAt = now;
  try { log('记忆库读取失败（本轮回退旧记忆卡）：' + (error?.message ?? error)); } catch {}
}

function keyOf(ownerId) {
  return String(ownerId ?? '').trim();
}

/** 测试用：清掉缓存（连接本身由 memory-db.js 管）。 */
export function resetMemoryReadCache() {
  catalogRecords.clear();
  factRecords.clear();
  factInflight.clear();
  personaRecords.clear();
  catalogInflight.clear();
  personaInflight.clear();
  styleRecord = null;
  styleInflight = null;
}

/**
 * 后台预热目录（不等待）。同一 owner 并发只跑一次。
 * opts: { titles, maxChars, ttlMs, log }
 */
export function warmCatalog(ownerId, opts = {}) {
  const id = keyOf(ownerId);
  if (!id) return Promise.resolve(null);
  const ttl = Math.max(5000, Number(opts.ttlMs) || CATALOG_TTL_MS);
  const hit = catalogRecords.get(id);
  if (hit && hit.ready && Date.now() - hit.at < ttl) return Promise.resolve(hit);
  if (catalogInflight.has(id)) return catalogInflight.get(id);
  const titles = Math.max(1, Math.min(20, Number(opts.titles) || 8));
  const maxChars = Math.max(200, Math.min(1200, Number(opts.maxChars) || 600));
  const task = load()
    .then((mod) => {
      const data = mod.catalog({ ownerId: id, limit: 50 });
      // 侧写单独一行放最前（设计 §7.2），所以这里不把 persona 拼进目录块。
      const text = mod.formatCatalogForModel({ ...data, persona: '' }, { titles, maxChars });
      const next = {
        ready: true,
        text: String(text || ''),
        fragments: Number(data.fragments) || 0,
        topics: Array.isArray(data.rows) ? data.rows.length : 0,
        persona: String(data.persona || ''),
        at: Date.now(),
        error: '',
      };
      catalogRecords.set(id, next);
      return next;
    })
    .catch((error) => {
      noteError(error, opts.log);
      const prev = catalogRecords.get(id);
      // 失败保留上一次的好结果（stale 比空更安全），没有就记一条失败占位。
      const next = prev && prev.ready
        ? { ...prev, error: String(error?.message ?? error) }
        : { ready: false, text: '', fragments: 0, topics: 0, persona: '', at: Date.now(), error: String(error?.message ?? error) };
      catalogRecords.set(id, next);
      return next;
    })
    .finally(() => { catalogInflight.delete(id); });
  catalogInflight.set(id, task);
  return task;
}

/** 同步读目录快照：{ ready, text, fragments, topics, persona, at, error } 或 null。 */
export function catalogSnapshot(ownerId) {
  return catalogRecords.get(keyOf(ownerId)) || null;
}

/** 事实缓存键：ownerId + audience（'owner' 主人视角 / 'self' 群聊里的自己）。 */
function factKeyOf(ownerId, audience) {
  return keyOf(ownerId) + '|' + (audience === 'self' ? 'self' : 'owner');
}

/**
 * 后台预热某人的重要事实（不等待）。同一键并发只跑一次。
 * opts: { audience, maxChars, ttlMs, who, log }
 */
export function warmFacts(ownerId, opts = {}) {
  const id = keyOf(ownerId);
  if (!id) return Promise.resolve(null);
  const audience = opts.audience === 'self' ? 'self' : 'owner';
  const cacheKey = factKeyOf(id, audience);
  const ttl = Math.max(5000, Number(opts.ttlMs) || FACT_TTL_MS);
  const hit = factRecords.get(cacheKey);
  if (hit && hit.ready && Date.now() - hit.at < ttl) return Promise.resolve(hit);
  if (factInflight.has(cacheKey)) return factInflight.get(cacheKey);
  const maxChars = Math.max(80, Math.min(1200, Number(opts.maxChars) || 360));
  const task = load()
    .then((mod) => {
      const rows = mod.listFacts({ ownerId: id, limit: 30 });
      const text = mod.formatFactsForModel(rows, { audience, maxChars, who: String(opts.who || '') });
      const next = {
        ready: true,
        text: String(text || ''),
        total: Array.isArray(rows) ? rows.length : 0,
        audience,
        at: Date.now(),
        error: '',
      };
      factRecords.set(cacheKey, next);
      return next;
    })
    .catch((error) => {
      noteError(error, opts.log);
      const prev = factRecords.get(cacheKey);
      const next = prev && prev.ready
        ? { ...prev, error: String(error?.message ?? error) }
        : { ready: false, text: '', total: 0, audience, at: Date.now(), error: String(error?.message ?? error) };
      factRecords.set(cacheKey, next);
      return next;
    })
    .finally(() => { factInflight.delete(cacheKey); });
  factInflight.set(cacheKey, task);
  return task;
}

/** 同步读事实快照：{ ready, text, total, audience, at, error } 或 null。 */
export function factSnapshot(ownerId, audience = 'owner') {
  return factRecords.get(factKeyOf(ownerId, audience)) || null;
}

/** 后台预热某人的侧写（persona）。opts: { ttlMs, log } */
export function warmPersona(ownerId, opts = {}) {
  const id = keyOf(ownerId);
  if (!id) return Promise.resolve(null);
  const ttl = Math.max(10000, Number(opts.ttlMs) || PERSONA_TTL_MS);
  const hit = personaRecords.get(id);
  if (hit && hit.ready && Date.now() - hit.at < ttl) return Promise.resolve(hit);
  if (personaInflight.has(id)) return personaInflight.get(id);
  const task = load()
    .then((mod) => {
      const row = mod.getProfile(id);
      const next = {
        ready: true,
        persona: String(row?.persona || '').trim(),
        detail: String(row?.detail || '').trim(),
        source: String(row?.source || ''),
        at: Date.now(),
        error: '',
      };
      personaRecords.set(id, next);
      return next;
    })
    .catch((error) => {
      noteError(error, opts.log);
      const prev = personaRecords.get(id);
      const next = prev && prev.ready
        ? { ...prev, error: String(error?.message ?? error) }
        : { ready: false, persona: '', detail: '', source: '', at: Date.now(), error: String(error?.message ?? error) };
      personaRecords.set(id, next);
      return next;
    })
    .finally(() => { personaInflight.delete(id); });
  personaInflight.set(id, task);
  return task;
}

/** 同步读侧写快照：{ ready, persona, detail, source, at, error } 或 null。 */
export function personaSnapshot(ownerId) {
  return personaRecords.get(keyOf(ownerId)) || null;
}

/**
 * 后台预热参考库切片（不等待）。切片是全局的，只拉一次，TTL 5 分钟。
 * opts: { ttlMs, log }
 */
export function warmStyleSlices(opts = {}) {
  const ttl = Math.max(30000, Number(opts.ttlMs) || STYLE_TTL_MS);
  if (styleRecord && styleRecord.ready && Date.now() - styleRecord.at < ttl) return Promise.resolve(styleRecord);
  if (styleInflight) return styleInflight;
  styleInflight = load()
    .then((mod) => {
      const rows = typeof mod.listStyleSlicesAll === 'function' ? mod.listStyleSlicesAll() : [];
      const list = (Array.isArray(rows) ? rows : []).map((r) => ({
        id: Number(r.id),
        source: String(r.source || ''),
        part: String(r.part || ''),
        kind: String(r.kind || ''),
        tags: (() => { try { const v = JSON.parse(r.tags || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })(),
        mood: String(r.mood || ''),
        text: String(r.text || ''),
        chars: Number(r.chars) || String(r.text || '').length,
      }));
      styleRecord = { ready: true, slices: list, at: Date.now(), error: '' };
      return styleRecord;
    })
    .catch((error) => {
      noteError(error, opts.log);
      // 失败保留上一次的好结果（stale 比空更安全）。
      styleRecord = styleRecord && styleRecord.ready
        ? { ...styleRecord, error: String(error?.message ?? error) }
        : { ready: false, slices: [], at: Date.now(), error: String(error?.message ?? error) };
      return styleRecord;
    })
    .finally(() => { styleInflight = null; });
  return styleInflight;
}

/** 同步读参考库快照：{ ready, slices, at, error } 或 null。 */
export function styleSliceSnapshot() {
  return styleRecord;
}

/**
 * 按情境标签挑片并渲染（同步）。没有片返回空串 —— 调用方据此「不注入」。
 * 依赖 style-refs.js 是纯逻辑，没有库也能跑；但片来自 styleSliceSnapshot()。
 */
export function styleRefBlockFor(tags, opts = {}) {
  const rec = styleRecord;
  if (!rec || !rec.ready || !Array.isArray(rec.slices) || !rec.slices.length) return '';
  const mod = styleLogic();
  if (!mod) return '';
  const picks = mod.pickStyleSlices(rec.slices, { tags, maxSlices: opts.maxSlices || 2, maxChars: opts.maxChars || 900 });
  if (!picks.length) return '';
  return mod.renderStyleRefBlock(picks, { personaName: opts.personaName || '' });
}
