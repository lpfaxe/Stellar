/**
 * Stellar —— 小镇采集器：把小镇的只读端点变成 town_note 里的几行事件。
 *
 * 原则：
 *  · **只读**。这里绝不调用 visit/play/goto（动作在影子会话里，走限额闸）。
 *  · 采集失败不许影响任何东西：消息、调度、提示词都不该因为小镇 502 出问题 → 一律返回对象，绝不抛。
 *  · 重复轮询不会重复落库：靠 town_note.src_hash 唯一 + INSERT OR IGNORE。
 *  · 每轮采集顺带做 TTL：删 < 前天 的整天，印象过 30 天或超 20 人淘汰。
 */
import { makeReader } from './town-client.js';
import {
  extractVisits, extractReceipts, buildNoteRow, pruneCutoffDay, dayKey, cleanText, looksLikeDirective,
  IMPRESSION_MAX,
} from './town-memory-pure.js';
import {
  openTownDb, insertNote, pruneNotes, upsertImpression, pruneImpressions, townStats,
} from './town-store.js';

/**
 * 从 3 天内的事件里攒人物印象：同一个人至少碰见 2 次才记，一人一行覆盖。
 * 只写「见过几次 + 最近那次在做什么」，不评价、不推断性格。
 */
function deriveImpressions(notes, { now = Date.now(), min = 2 } = {}) {
  const byId = new Map();
  for (const n of notes) {
    const id = String(n.who_id || n.whoId || n.who || '').trim();
    if (!id) continue;
    const hit = byId.get(id) || { id, name: cleanText(n.who, 20), count: 0, last: null };
    hit.count += 1;
    if (!hit.last || Number(n.at) >= Number(hit.last.at)) hit.last = n;
    if (!hit.name) hit.name = cleanText(n.who, 20);
    byId.set(id, hit);
  }
  const out = [];
  for (const v of byId.values()) {
    if (v.count < min) continue;
    // 指令式句子（转述来的）不进印象：印象会活 30 天，不能把陌生人的话当她的记忆。
    const tail = v.last && v.last.text && !v.last.quoted ? '；上次：' + cleanText(v.last.text, 40) : '';
    out.push({ fishId: v.id, name: v.name, line: `见过 ${v.count} 次${tail}`, at: Number(v.last && v.last.at) || now });
  }
  return out;
}

export async function collectTownOnce({ client, db, now = Date.now(), withImpressions = true } = {}) {
  const conn = db || openTownDb();
  const nowMs = Number(now) || Date.now();
  const result = { ok: true, added: 0, skipped: 0, deleted: 0, impressions: 0, errors: [], stats: null };
  const reader = makeReader(client);

  const pull = async (name, fn) => {
    try { return await fn(); } catch (err) {
      result.errors.push(name + ': ' + String((err && err.code) || '') + ' ' + String((err && err.message) || err).slice(0, 120));
      return null;
    }
  };

  const visitsRaw = await pull('visits', () => reader.visits(20));
  const receiptsRaw = await pull('receipts', () => reader.receipts(20));

  const events = [];
  for (const v of extractVisits(visitsRaw)) {
    if (!v.text && !v.who) { result.skipped += 1; continue; }
    const visitText = v.text || '和' + (v.who || '谁') + '一起待了一会儿';
    events.push({ kind: 'visit', who: v.who, whoId: v.whoId, text: visitText, at: v.at, visitId: v.visitId, quoted: looksLikeDirective(visitText) });
  }
  for (const r of extractReceipts(receiptsRaw)) {
    if (!r.text && !r.who) { result.skipped += 1; continue; }
    const money = r.amount > 0 ? `（${r.amount}）` : '';
    const recText = (r.text || '请客') + money;
    events.push({ kind: 'receipt', who: r.who, text: recText, at: r.at, quoted: looksLikeDirective(recText) });
  }

  const rows = [];
  for (const ev of events) {
    const row = buildNoteRow(ev, nowMs);
    if (!row.day || !row.text) { result.skipped += 1; continue; }
    rows.push(row);
    const r = insertNote(row, { db: conn });
    if (r.inserted) result.added += 1; else result.skipped += 1;
  }

  if (withImpressions) {
    try {
      for (const imp of deriveImpressions(events, { now: nowMs })) {
        if (upsertImpression(imp, { db: conn }).ok) result.impressions += 1;
      }
    } catch (err) { result.errors.push('impressions: ' + String((err && err.message) || err).slice(0, 120)); }
  }

  try {
    const cutoff = pruneCutoffDay(nowMs);
    result.deleted = pruneNotes(cutoff, { db: conn }).deleted;
    pruneImpressions({ beforeMs: nowMs - 30 * 86400000, max: IMPRESSION_MAX, db: conn });
  } catch (err) { result.errors.push('prune: ' + String((err && err.message) || err).slice(0, 120)); }

  try { result.stats = townStats({ db: conn }); } catch {}
  result.ok = result.errors.length === 0;
  return result;
}

/** 采集调度：最小间隔（默认 10 分钟），失败退避（连续失败时翻倍，最多 1 小时）。 */
export function createTownCollector({ client, db, intervalMs = 10 * 60 * 1000, log } = {}) {
  let timer = null, running = false, failures = 0, last = null;
  const backoff = () => Math.min(60 * 60 * 1000, intervalMs * Math.pow(2, Math.max(0, failures - 1)));

  async function runOnce(now = Date.now()) {
    if (running) return { ok: false, skipped: 'busy' };
    running = true;
    try {
      const r = await collectTownOnce({ client, db, now });
      if (r.ok) failures = 0; else failures += 1;
      last = { at: Date.now(), ...r };
      if (typeof log === 'function') {
        log('[town] collected +' + r.added + ' -' + r.deleted + ' imp=' + r.impressions + (r.errors.length ? ' errors=' + r.errors.join(' | ') : ''));
      }
      return r;
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    get last() { return last; },
    get failures() { return failures; },
    start() {
      if (timer) return;
      const loop = async () => {
        await runOnce().catch(() => {});
        timer = setTimeout(loop, failures ? backoff() : intervalMs);
      };
      loop();
    },
    stop() { if (timer) clearTimeout(timer); timer = null; },
  };
}

export { deriveImpressions, dayKey };
