/**
 * 记忆库（SQLite）：新记忆机制的存储层。
 *
 * 表结构在 memory-db-schema.sql；本文件负责连接、迁移与查询封装。
 *
 * 边界（别越界）：
 *  · 只装「启用之后的新对话」。旧档案（memory-card*.jsonl / memory-inbox.jsonl /
 *    vector-memory.jsonl）一个字节都不读、不改、不迁 —— 用户 2026-11-12 23:39 原话：
 *    「不对旧的记忆修改，直接建立新机制，存新记忆」。
 *  · 库文件跟着角色走：characters/<id>/memory/memory.db（与 activeMemoryPaths().dir 同目录）。
 *  · 每进程一个连接（bridge 与 worker 各一个），WAL + busy_timeout，多进程并发安全。
 *  · 写库失败**绝不抛出到消息链路上**：消息发不出去比少记一条严重得多 → 调用方用 safeAppend。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activeMemoryPaths } from './character-persona.js';

export const SCHEMA_VERSION = 3;
export const DB_FILE_NAME = 'memory.db';

const SCHEMA_FILE = new URL('./memory-db-schema.sql', import.meta.url);
const connections = new Map();

/** 库文件路径：优先跟随当前角色目录，取不到再退回全局 memory 目录。 */
export function resolveDbFile({ dir } = {}) {
  let base = dir || '';
  if (!base) {
    try { base = activeMemoryPaths().dir; } catch { base = ''; }
  }
  if (!base) {
    const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
    base = path.join(home, 'stellar', 'characters', 'deepseek', 'memory');
  }
  return path.join(base, DB_FILE_NAME);
}

/** 打开（或复用）连接；schema 在打开时补齐（全部 IF NOT EXISTS）。 */
export function openDb({ file } = {}) {
  const dbFile = file || resolveDbFile();
  const hit = connections.get(dbFile);
  if (hit) return hit;
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const ddl = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=3000');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(ddl);
  try {
    db.prepare('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('schema_version', String(SCHEMA_VERSION));
    db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)').run('engine', 'memorydb-v1');
  } catch {}
  connections.set(dbFile, db);
  return db;
}

export function closeDb({ file } = {}) {
  const dbFile = file || resolveDbFile();
  const db = connections.get(dbFile);
  if (!db) return false;
  try { db.close(); } catch {}
  connections.delete(dbFile);
  return true;
}

/** 本地日 key（YYYY-MM-DD）。切分与 2 天窗口都按它算，不用 UTC。 */
export function dayKey(at = Date.now()) {
  const d = new Date(Number(at) || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 会话 key → owner 软标签：私聊=对方 QQ，群=group:<群号>。 */
export function ownerIdForKey(conversationKey) {
  const k = String(conversationKey || '');
  if (k.startsWith('private:')) return k.slice(8);
  if (k.startsWith('group:')) return k;
  if (k.startsWith('owner:')) return k;
  return k || 'unknown';
}

/** 两字切分（FTS trigram 对 2 字中文返回空，用它做 LIKE 兜底）。 */
export function bigramsOf(text) {
  const clean = String(text || '').replace(/[\r\n\t]+/g, ' ').trim();
  const out = [];
  for (let i = 0; i < clean.length - 1; i += 1) {
    const pair = clean.slice(i, i + 2);
    if (pair.trim().length < 2) continue;
    out.push(pair);
  }
  return (' ' + out.join(' ') + ' ').trim();
}

function nowMs(at) { return Number.isFinite(Number(at)) ? Number(at) : Date.now(); }

const INSERT_CACHE = 'INSERT INTO cache_msg (conversation_key, owner_id, speaker_id, speaker_name, role, kind, text, quote_id, at, day_key, process_state, keep) '
  + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)";

/** 入站消息落缓冲（不判价值、不过滤 —— 过滤是旧 inbox 的语义，不是新 Cache 的）。 */
export function append(entry = {}) {
  const db = openDb(entry.db ? { file: entry.db } : {});
  const at = nowMs(entry.at);
  const conversationKey = String(entry.conversationKey || '');
  const info = db.prepare(INSERT_CACHE).run(
    conversationKey,
    String(entry.ownerId || ownerIdForKey(conversationKey)),
    String(entry.speakerId || ''),
    String(entry.speakerName || ''),
    String(entry.role || 'user'),
    String(entry.kind || 'text'),
    String(entry.text || ''),
    entry.quoteId == null ? null : Number(entry.quoteId),
    at,
    String(entry.dayKey || dayKey(at)),
    entry.keep ? 1 : 0,
  );
  return { id: Number(info.lastInsertRowid), at };
}

/** 出站消息落缓冲。没有这条，切出来的话题就全是「对方一个人在说话」。 */
export function appendSelf(entry = {}) {
  return append({ ...entry, role: 'self' });
}

/** 写库失败只记日志，绝不抛到消息链路。 */
export function safeAppend(entry, log) {
  try { return append(entry); } catch (error) {
    try { if (log) log('记忆库写入失败：' + (error && error.message ? error.message : error)); } catch {}
    return null;
  }
}

export function safeAppendSelf(entry, log) {
  return safeAppend({ ...entry, role: 'self' }, log);
}

/** 待切分的行（给 worker 用）。 */
export function pendingRows({ limit = 400, db } = {}) {
  const conn = db || openDb();
  return conn.prepare(
    "SELECT id, conversation_key AS ck, owner_id AS oid, speaker_id, speaker_name, role, kind, text, at, day_key "
    + "FROM cache_msg WHERE process_state = 'new' ORDER BY conversation_key, at LIMIT ?",
  ).all(Number(limit) || 400);
}

/** 纯代码切段：同会话内间隔 <= gapMs、条数 <= maxMsgs、字符 <= maxChars 算一段。 */
export function segmentRows(rows = [], { gapMs = 20 * 60 * 1000, maxMsgs = 60, maxChars = 6000 } = {}) {
  const segments = [];
  let cur = null;
  for (const row of rows) {
    const chars = String(row.text || '').length;
    const breaks = !cur
      || cur.ck !== row.ck
      || (row.at - cur.endedAt) > gapMs
      || cur.rows.length >= maxMsgs
      || (cur.chars + chars) > maxChars;
    if (breaks) {
      if (cur) segments.push(cur);
      cur = { ck: row.ck, oid: row.oid, startedAt: row.at, endedAt: row.at, chars: 0, rows: [] };
    }
    cur.rows.push(row);
    cur.chars += chars;
    if (row.at > cur.endedAt) cur.endedAt = row.at;
  }
  if (cur) segments.push(cur);
  return segments;
}

/** 话题 id：tp_20261113_0007（短、模型可读可写）。 */
export function makeTopicId(day, seq) {
  const compact = String(day || dayKey()).replace(/-/g, '');
  return 'tp_' + compact + '_' + String(seq).padStart(4, '0');
}

/**
 * 当天该 owner 的下一个话题序号。
 * 注意：话题 id 是 tp_<YYYYMMDD>_<seq>，**seq 在一天里全局唯一**（不含 owner），
 * 所以序号必须按「当天全部话题」算，不能只数同一个 owner 的；
 * 否则同一天第二个 owner 会拿到同样的 0001 撞 PRIMARY KEY（2026-11-13 实测踩到）。
 */
export function nextTopicSeq(db, ownerId, day) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM topic WHERE day_key = ?').get(String(day));
  return Number(row && row.n ? row.n : 0) + 1;
}

/**
 * 建话题（含正文）。硬约束在这里落地：段内必须同时有 user 与 self，否则不建。
 * 返回 { ok:true, id } 或 { ok:false, reason }。
 */
export function insertTopic({ topic = {}, rows = [], db: conn } = {}) {
  const db = conn || openDb();
  const roles = new Set(rows.map((r) => r.role));
  if (!roles.has('user') || !roles.has('self')) {
    return { ok: false, reason: 'segments must contain both sides', missing: ['user', 'self'].filter((r) => !roles.has(r)) };
  }
  const day = String(topic.dayKey || (rows[0] && rows[0].day_key) || dayKey());
  const ownerId = String(topic.ownerId || (rows[0] && rows[0].oid) || 'unknown');
  const conversationKey = String(topic.conversationKey || (rows[0] && rows[0].ck) || '');
  const startedAt = Number(topic.startedAt || (rows[0] && rows[0].at) || Date.now());
  const endedAt = Number(topic.endedAt || (rows[rows.length - 1] && rows[rows.length - 1].at) || startedAt);
  const importance = Math.max(0, Math.min(100, Number(topic.importance) || 0));
  const tier = String(topic.tier || (importance >= 80 ? 'important' : 'daily'));
  let id = String(topic.id || '');
  if (!id) {
    // 并发/同一天多 owner 都可能拿到同一个序号，撞了就往后再试一次。
    for (let attempt = 0; attempt < 50 && !id; attempt += 1) {
      const candidate = makeTopicId(day, nextTopicSeq(db, ownerId, day) + attempt);
      const taken = db.prepare('SELECT 1 FROM topic WHERE id = ?').get(candidate);
      if (!taken) id = candidate;
    }
    if (!id) return { ok: false, reason: 'cannot allocate topic id' };
  }
  const now = Date.now();
  const summarize = String(topic.title || '').slice(0, 24) || '（未命名话题）';
  db.exec('BEGIN');
  try {
    db.prepare(
      'INSERT INTO topic (id, owner_id, conversation_key, day_key, title, summary, tier, importance, facets, sentiment, msg_count, started_at, ended_at, promoted_at, promote_reason, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id, ownerId, conversationKey, day, summarize,
      String(topic.summary || '').slice(0, 120),
      tier, importance,
      JSON.stringify(Array.isArray(topic.facets) ? topic.facets : []),
      String(topic.sentiment || ''),
      rows.length, startedAt, endedAt,
      tier === 'important' ? now : null,
      tier === 'important' ? String(topic.promoteReason || 'score') : '',
      now,
    );
    const stmt = db.prepare('INSERT INTO topic_msg (topic_id, seq, role, speaker_id, speaker_name, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    rows.forEach((row, index) => {
      stmt.run(id, index + 1, String(row.role || 'user'), String(row.speaker_id || ''), String(row.speaker_name || ''), String(row.text || ''), Number(row.at) || now);
    });
    db.prepare("UPDATE cache_msg SET process_state = 'split', keep = ? WHERE id IN (" + rows.map(() => '?').join(',') + ')')
      .run(tier === 'important' ? 1 : 0, ...rows.map((r) => r.id));
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  // 检索正文要**去重**：标题本身就取自首条消息，摘要也常包含它，不去重的话搜出来是
  // 「在吗，晚上吃点啥 在吗，晚上吃点啥 在吗，晚上吃点啥 …」三遍（模型会以为记忆坏了）。
  const parts = [summarize, String(topic.summary || ''), ...rows.map((r) => String(r.text || '').trim())];
  const seen = new Set();
  const bodyParts = [];
  for (const part of parts) {
    const key = part.replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    bodyParts.push(key);
  }
  upsertSearchDoc({ refType: 'topic', refId: id, ownerId, at: endedAt, body: bodyParts.join(' '), db });
  return { ok: true, id, tier };
}

/** 检索文档 upsert（同一 ref 只留一条，靠 (ref_type, ref_id) 删旧插新）。 */
export function upsertSearchDoc({ refType, refId, ownerId, body, at, db: conn } = {}) {
  const db = conn || openDb();
  const text = String(body || '').slice(0, 4000);
  db.prepare("DELETE FROM search_doc WHERE ref_type = ? AND ref_id = ?").run(String(refType), String(refId));
  db.prepare('INSERT INTO search_doc (ref_type, ref_id, owner_id, body, bigrams, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(refType), String(refId), String(ownerId || 'unknown'), text, bigramsOf(text), Number(at) || Date.now());
}

/** 零碎记忆（一句话事实）。 */
export function insertFragment({ ownerId, day, text, facet = '', weight = 1, topicId = null, at = Date.now(), db: conn } = {}) {
  const db = conn || openDb();
  const body = String(text || '').slice(0, 120);
  if (!body) return { ok: false, reason: 'empty' };
  const info = db.prepare('INSERT INTO fragment (owner_id, day_key, text, facet, weight, tier, topic_id, at, promoted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
    .run(String(ownerId || 'unknown'), String(day || dayKey(at)), body, String(facet || ''), Math.max(1, Math.min(5, Number(weight) || 1)), 'daily', topicId ? String(topicId) : null, Number(at) || Date.now());
  const id = Number(info.lastInsertRowid);
  upsertSearchDoc({ refType: 'fragment', refId: String(id), ownerId, body, at, db });
  return { ok: true, id };
}

// ── 见闻区（B站 / QQ好友爱看）──────────────────────────────────────────────
//
// 为什么单独一张表、不塞进 fragment / topic：
//  · fragment 会参与切分、晋升、目录注入，语义是「聊天里对方说的零碎」；
//  · 见闻是「她自己刷到的东西」，不属于任何对话对象，也不该按话题切分；
//  · 主人 2026-11-13 的要求是「这两个区内不按话题分类，让她自己精简总结写进去」。
// 所以：独立表 + 独立检索入口（stellar_memory_zone），owner_id 固定 self。
// 刻意不写 search_doc：见闻是外来的「看到什么」，混进对话记忆的全文检索会污染
// 「对方提过的事」这类查询（scope=current 本来就搜不到 self，scope=all 又会被它挤占）。
export const ZONES = ['bili', 'qzone'];

export function normalizeZone(zone) {
  const z = String(zone || '').trim().toLowerCase();
  return ZONES.includes(z) ? z : '';
}

/** 写一条见闻（她自己写的精简总结）。同一天同一 zone 同文本只保留一条（更新 at）。 */
export function insertZoneNote({ zone, text, day, items = [], source = 'tool', at = Date.now(), db: conn } = {}) {
  const db = conn || openDb();
  const z = normalizeZone(zone);
  if (!z) return { ok: false, reason: 'bad-zone' };
  const body = String(text || '').replace(/\s+$/g, '').slice(0, 400);
  if (!body) return { ok: false, reason: 'empty' };
  const when = Number(at) || Date.now();
  const dayKeyText = String(day || dayKey(when));
  const itemsJson = JSON.stringify((Array.isArray(items) ? items : []).slice(0, 20).map((x) => String(x || '').slice(0, 80)));
  const dup = db.prepare('SELECT id FROM zone_note WHERE zone = ? AND day_key = ? AND text = ?').get(z, dayKeyText, body);
  if (dup) {
    db.prepare('UPDATE zone_note SET at = ? WHERE id = ?').run(when, dup.id);
    return { ok: true, id: Number(dup.id), duplicated: true };
  }
  const info = db.prepare('INSERT INTO zone_note (zone, owner_id, day_key, text, items, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(z, 'self', dayKeyText, body, itemsJson, String(source || 'tool'), when);
  return { ok: true, id: Number(info.lastInsertRowid), duplicated: false };
}

/** 列见闻：zone 必填；day 为空 = 最近 limit 条；q 为空不过滤。 */
export function listZoneNotes({ zone, day = '', q = '', limit = 20, db: conn } = {}) {
  const db = conn || openDb();
  const z = normalizeZone(zone);
  if (!z) return [];
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  const args = [z];
  let sql = 'SELECT id, zone, day_key, text, items, source, at FROM zone_note WHERE zone = ?';
  if (day) { sql += ' AND day_key = ?'; args.push(String(day)); }
  const query = String(q || '').trim();
  if (query) { sql += ' AND (text LIKE ? OR items LIKE ?)'; args.push('%' + query + '%', '%' + query + '%'); }
  sql += ' ORDER BY at DESC LIMIT ?';
  args.push(n);
  let rows = [];
  try { rows = db.prepare(sql).all(...args); } catch { return []; }
  // items 在库里是 JSON 字符串；在这里就解析好，免得每个调用方各写一遍
  // （MCP 工具、面板、测试都吃同一个形状）。
  return rows.map((r) => {
    let items = [];
    try { items = JSON.parse(String(r.items || '[]')); } catch {}
    return { ...r, items: Array.isArray(items) ? items : [] };
  });
}

/** 搜见闻（同 list，但按关键词命中数排序会让 LLM 更稳 → 这里按时间即可，短列表）。 */
export function searchZoneNotes({ zone, q = '', day = '', limit = 8, db: conn } = {}) {
  const query = String(q || '').trim();
  if (!query) return listZoneNotes({ zone, day, limit, db: conn });
  return listZoneNotes({ zone, day, q: query, limit, db: conn });
}

/** 各 zone 的条数 + 今天条数（目录注入与面板用）。 */
export function zoneStats({ day = '', db: conn } = {}) {
  const db = conn || openDb();
  const today = String(day || dayKey(Date.now()));
  const out = {};
  for (const z of ZONES) {
    const one = (sql, ...args) => { try { const row = db.prepare(sql).get(...args); return row ? Number(Object.values(row)[0] || 0) : 0; } catch { return 0; } };
    out[z] = {
      total: one('SELECT COUNT(*) FROM zone_note WHERE zone = ?', z),
      today: one('SELECT COUNT(*) FROM zone_note WHERE zone = ? AND day_key = ?', z, today),
      lastAt: one('SELECT MAX(at) FROM zone_note WHERE zone = ?', z),
    };
  }
  return out;
}

export const ZONE_LABELS = { bili: 'B站', qzone: '好友爱看' };

/** 删一条（面板「忘记」与她自己删用）。返回 { ok, deleted }。 */
export function deleteZoneNote(id, { db: conn } = {}) {
  const db = conn || openDb();
  const num = Number(id);
  if (!Number.isFinite(num) || num <= 0) return { ok: false, reason: 'bad-id' };
  const info = db.prepare('DELETE FROM zone_note WHERE id = ?').run(num);
  return { ok: true, deleted: Number(info.changes || 0) };
}

/** 清空一个 zone（可按 day 限定）。返回 { ok, deleted }。 */
export function clearZoneNotes({ zone, day = '', db: conn } = {}) {
  const db = conn || openDb();
  const z = normalizeZone(zone);
  if (!z) return { ok: false, reason: 'bad-zone' };
  const info = day
    ? db.prepare('DELETE FROM zone_note WHERE zone = ? AND day_key = ?').run(z, String(day))
    : db.prepare('DELETE FROM zone_note WHERE zone = ?').run(z);
  return { ok: true, deleted: Number(info.changes || 0) };
}

/** 渲染成给她看的文本（工具返回值）。 */
export function formatZoneNotesForModel(rows, { zone, day = '', empty = '' } = {}) {
  const z = normalizeZone(zone);
  const label = ZONE_LABELS[z] || z;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return empty || ('「' + label + '」记忆里' + (day ? ' ' + day + ' ' : '最近') + '没有内容。翻过什么就写一条进来（stellar_memory_zone action=write zone=' + (z || 'bili') + ' text="…"），没看过就直说没看。');
  }
  const out = ['［' + label + '］' + (day ? day + ' · ' : '') + list.length + ' 条（新→旧）'];
  for (const row of list) {
    const when = String(row.day_key || '').slice(5);
    const body = String(row.text || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
    let items = [];
    try { items = JSON.parse(row.items || '[]'); } catch {}
    const extra = Array.isArray(items) && items.length ? '  〔' + items.slice(0, 8).join(' / ') + '〕' : '';
    out.push('· #' + row.id + ' ' + when + '  ' + body + extra);
  }
  return out.join('\n');
}

/**
 * 批量改 cache_msg 的处理状态（切分器用）。
 * state: 'split' | 'held' | 'dropped' | 'fragment' | 'new'
 *
 * 为什么需要它：单边段（只有一方说话）不建话题，但也不能一直留在 'new' 里 —— 否则
 * 每一轮都重复读到它们。held 表示「先挂着等对方回」，dropped 表示「挂满 2 小时也不要了」。
 */
export function markRows(ids = [], state = 'split', { keep, db: conn } = {}) {
  const list = (Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!list.length) return { ok: false, updated: 0 };
  const db = conn || openDb();
  const keepSql = keep === undefined ? '' : ', keep = ?';
  const args = keep === undefined ? [] : [keep === true || keep === 1 ? 1 : 0];
  const info = db.prepare('UPDATE cache_msg SET process_state = ?' + keepSql + ' WHERE id IN (' + list.map(() => '?').join(',') + ')')
    .run(String(state), ...args, ...list);
  return { ok: true, updated: Number(info.changes || 0) };
}

/** 把挂太久的单边段清掉（holdMs 默认 2 小时）。返回清掉的条数。 */
export function dropStaleHeld({ holdMs = 2 * 60 * 60 * 1000, now = Date.now(), db: conn } = {}) {
  const db = conn || openDb();
  const info = db.prepare("UPDATE cache_msg SET process_state = 'dropped' WHERE process_state = 'held' AND at < ?")
    .run(Number(now) - Number(holdMs));
  return { ok: true, dropped: Number(info.changes || 0) };
}

/** held 的行（下一轮切分时要重新试着并进新段）。 */
export function heldRows({ limit = 200, db } = {}) {
  const conn = db || openDb();
  return conn.prepare(
    "SELECT id, conversation_key AS ck, owner_id AS oid, speaker_id, speaker_name, role, kind, text, at, day_key "
    + "FROM cache_msg WHERE process_state = 'held' ORDER BY conversation_key, at LIMIT ?",
  ).all(Number(limit) || 200);
}


/** 读一个话题（summary + 正文；正文来自 topic_msg，2 天前的也能读）。 */
export function readTopic(topicId, { full = false, maxChars = 2000, db: conn } = {}) {
  const db = conn || openDb();
  const head = db.prepare('SELECT * FROM topic WHERE id = ?').get(String(topicId));
  if (!head) return null;
  const rows = db.prepare('SELECT seq, role, speaker_id, speaker_name, text, at FROM topic_msg WHERE topic_id = ? ORDER BY seq').all(String(topicId));
  let sent = 0;
  const kept = [];
  const wantAll = full === true || rows.length <= 20;
  for (const row of rows) {
    const len = String(row.text || '').length;
    if (!wantAll && sent + len > Number(maxChars)) break;
    kept.push(row);
    sent += len;
  }
  return { topic: head, rows: kept, total: rows.length, truncated: kept.length < rows.length };
}

/** 把话题渲染成给模型看的文本（双方都在，身份明确）。 */
export function formatTopicForModel(data, { maxChars = 2000 } = {}) {
  if (!data) return '没有这个 id 的话题。';
  const t = data.topic;
  const when = new Date(Number(t.started_at)).toLocaleString('zh-CN', { hour12: false });
  const head = '【话题】' + t.title + '  (' + when + ', ' + (t.tier === 'important' ? '重要 ' + t.importance : '日常') + ')';
  const lines = [head];
  if (t.summary) lines.push('摘要：' + t.summary);
  const tags = (() => { try { return JSON.parse(t.facets || '[]'); } catch { return []; } })();
  if (tags.length) lines.push('标签：' + tags.join('/'));
  lines.push('');
  let used = 0;
  for (const row of data.rows) {
    const clock = new Date(Number(row.at)).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const who = row.role === 'self' ? '她(你)' : (row.speaker_name || (row.speaker_id ? 'QQ' + row.speaker_id : '对方'));
    const text = String(row.text || '');
    if (used + text.length > Number(maxChars)) { lines.push('…（后面还有 ' + (data.total - data.rows.indexOf(row)) + ' 条没显示，需要就说「继续」）'); break; }
    lines.push(clock + ' ' + who + ': ' + text);
    used += text.length;
  }
  if (!data.rows.length) lines.push('（这个话题没有正文）');
  if (data.truncated && data.total > data.rows.length) lines.push('（共 ' + data.total + ' 条，这里给了 ' + data.rows.length + ' 条）');
  return lines.join('\n');
}

/** 目录：当前对象的话题标题（important 优先，再按结束时间倒序）。 */
export function catalog({ ownerId, limit = 20, db: conn } = {}) {
  const db = conn || openDb();
  const n = Math.max(1, Math.min(50, Number(limit) || 20));
  const rows = db.prepare(
    "SELECT id, title, tier, importance, ended_at, day_key FROM topic WHERE owner_id = ? "
    + "ORDER BY (tier = 'important') DESC, ended_at DESC LIMIT ?",
  ).all(String(ownerId || ''), n);
  const fragRow = db.prepare("SELECT COUNT(*) AS n FROM fragment WHERE owner_id = ?").get(String(ownerId || ''));
  const profile = db.prepare('SELECT persona FROM profile WHERE owner_id = ?').get(String(ownerId || ''));
  let zones = null;
  try { zones = zoneStats({ db }); } catch {}
  // 事实条数一起带上：目录里要显示「另有 N 条重要事实」，否则她不知道事实区存在。
  let facts = null;
  try { facts = factStats({ ownerId, db }); } catch {}
  return { rows, fragments: Number(fragRow && fragRow.n ? fragRow.n : 0), persona: profile ? String(profile.persona || '') : '', zones, facts };
}

/** 目录渲染成注入块（目标 ≈450 字符，只给标题，不给正文）。 */
export function formatCatalogForModel(data, { titles = 8, maxChars = 600 } = {}) {
  if (!data) return '';
  const list = (data.rows || []).slice(0, Math.max(1, Math.min(20, Number(titles) || 8)));
  const lines = [];
  if (data.persona) lines.push('［侧写］' + data.persona);
  if (list.length) {
    lines.push('［记忆·目录］只给标题，细节要自己查（查过再说，别编）：');
    for (const row of list) {
      const when = String(row.day_key || '').slice(5);
      const mark = row.tier === 'important' ? '  [重要]' : '';
      lines.push('· ' + row.id + ' ' + row.title + '  (' + when + ')' + mark);
    }
    if (data.fragments > 0) lines.push('· 另有 ' + data.fragments + ' 条零碎记忆（爱好/雷区/习惯），想找用 stellar_memory_search');
    // 按人分类（2026-11-13 主人的要求）：先确认问的是谁的事，再决定查谁。
    // 不加这句时她会拿当前对话对象的记忆去答别人的问题（或反过来把别人的事当自己的）。
    lines.push('查法：先确认问的是谁的事 —— 问本人就查本人（ownerId 用当前对话对象的号）；问别人的，先按那个人的号查，查到别人的事只给结论、别转述细节。stellar_memory_catalog 看全目录 → stellar_memory_topic 读某条 → stellar_memory_search 搜关键词。都没有就说「不记得」，别硬凑。');
    const zoneLine = formatZoneCatalogLine(data.zones);
    if (zoneLine) lines.push(zoneLine);
    const factN = Number(data.facts && data.facts.total) || 0;
    if (factN > 0) lines.push('· 另有 ' + factN + ' 条重要事实（生日/忌口/约定这类，已经按对象记着），要改就在面板「记忆」里改');
  } else if (data.persona) {
    lines.push('（还没有记下任何话题；对方提过的事要自己查证，别编。）');
  }
  let out = lines.join('\n');
  if (out.length > Number(maxChars)) out = out.slice(0, Number(maxChars)) + '…';
  return out;
}

/** 见闻区的目录行（B站 / 好友爱看 各有多少条、今天有没有）。没有内容就不出这一行。 */
export function formatZoneCatalogLine(zones) {
  if (!zones || typeof zones !== 'object') return '';
  const parts = [];
  for (const z of ZONES) {
    const info = zones[z] || {};
    const total = Number(info.total) || 0;
    if (total <= 0) continue;
    const today = Number(info.today) || 0;
    parts.push((ZONE_LABELS[z] || z) + ' ' + total + ' 条' + (today ? '（今天 ' + today + '）' : ''));
  }
  if (!parts.length) return '';
  return '［见闻］' + parts.join(' / ') + '：问「今天看了什么/刷到什么」先调 stellar_memory_zone(action=list) 走这两个区，别拿聊天记忆凑。';
}

/** 全文检索：>=3 字走 FTS5 trigram；<3 字走 bigrams LIKE 兜底。 */
export function search({ q, ownerId, scope = 'current', limit = 5, db: conn } = {}) {
  const db = conn || openDb();
  const query = String(q || '').trim();
  if (!query) return [];
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  const cross = String(scope) === 'all';
  const rows = [];
  const push = (row) => { if (rows.length < n && row) rows.push(row); };
  if (query.length >= 3) {
    const sql = 'SELECT d.ref_type, d.ref_id, d.owner_id, d.body, d.at FROM search_fts f JOIN search_doc d ON d.id = f.rowid '
      + 'WHERE search_fts MATCH ?' + (cross ? '' : ' AND d.owner_id = ?') + ' ORDER BY d.at DESC LIMIT ?';
    const args = cross ? [query, n] : [query, String(ownerId || ''), n];
    try { for (const row of db.prepare(sql).all(...args)) push(row); } catch {}
  }
  if (!rows.length) {
    const like = '%' + query + '%';
    const sql = 'SELECT ref_type, ref_id, owner_id, body, at FROM search_doc '
      + 'WHERE (body LIKE ? OR bigrams LIKE ?)' + (cross ? '' : ' AND owner_id = ?') + ' ORDER BY at DESC LIMIT ?';
    const args = cross ? [like, '%' + query + '%', n] : [like, '%' + query + '%', String(ownerId || ''), n];
    try { for (const row of db.prepare(sql).all(...args)) push(row); } catch {}
  }
  return rows;
}

/** 检索结果渲染成文本（跨 owner 时要标归属）。 */
export function formatSearchForModel(rows, { currentOwner } = {}) {
  if (!rows || !rows.length) return '没搜到相关记忆（就是不记得，别编）。';
  const out = [];
  for (const row of rows) {
    const clock = new Date(Number(row.at)).toLocaleDateString('zh-CN');
    const kind = row.ref_type === 'topic' ? '话题' : (row.ref_type === 'fragment' ? '零碎' : (row.ref_type === 'fact' ? '事实' : '侧写'));
    const body = String(row.body || '').replace(/[\r\n]+/g, ' ').slice(0, 80);
    const own = currentOwner && String(row.owner_id) !== String(currentOwner) ? '  (属于 ' + row.owner_id + '，别转述具体内容)' : '';
    out.push('[' + kind + '] ' + body + '  (' + clock + ')' + own + (row.ref_type === 'topic' ? '  → ' + row.ref_id : ''));
  }
  return out.join('\n');
}

/** 人物侧写（<=50 字注入；<=200 字 detail 只给人看）。 */
export function upsertProfile({ ownerId, persona, detail = '', tags = [], source = 'auto', confidence = 0, msgCount = 0, editedBy = '', db: conn } = {}) {
  const db = conn || openDb();
  const text = String(persona || '').slice(0, 50);
  if (!text) return { ok: false, reason: 'empty' };
  db.prepare(
    'INSERT INTO profile (owner_id, persona, detail, tags, source, confidence, msg_count, updated_at, edited_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(owner_id) DO UPDATE SET persona = excluded.persona, detail = excluded.detail, tags = excluded.tags, source = excluded.source, '
    + 'confidence = excluded.confidence, msg_count = excluded.msg_count, updated_at = excluded.updated_at, edited_by = excluded.edited_by',
  ).run(String(ownerId), text, String(detail || '').slice(0, 200), JSON.stringify(Array.isArray(tags) ? tags : []), String(source || 'auto'), Math.max(0, Math.min(100, Number(confidence) || 0)), Number(msgCount) || 0, Date.now(), String(editedBy || ''));
  upsertSearchDoc({ refType: 'profile', refId: String(ownerId), ownerId, body: text + ' ' + String(detail || ''), at: Date.now(), db });
  return { ok: true, ownerId, persona: text };
}

export function listProfiles({ db: conn } = {}) {
  const db = conn || openDb();
  return db.prepare('SELECT owner_id, persona, detail, tags, source, confidence, msg_count, updated_at, edited_by FROM profile ORDER BY updated_at DESC').all();
}

export function getProfile(ownerId, { db: conn } = {}) {
  const db = conn || openDb();
  return db.prepare('SELECT * FROM profile WHERE owner_id = ?').get(String(ownerId || '')) || null;
}

/** 角色风格参考切片（模块三）：写入（同一 source+part+text 不重复插）。 */
export function insertStyleSlice({ source, part, kind, tags = [], mood = '', text, db: conn } = {}) {
  const db = conn || openDb();
  const body = String(text || '').trim();
  if (!body) return { ok: false, reason: 'empty' };
  const dup = db.prepare('SELECT id FROM style_slice WHERE source = ? AND part = ? AND text = ?').get(String(source), String(part), body);
  if (dup) return { ok: true, id: Number(dup.id), duplicate: true };
  const info = db.prepare('INSERT INTO style_slice (source, part, kind, tags, mood, text, chars, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(String(source), String(part), String(kind || 'sample'), JSON.stringify(Array.isArray(tags) ? tags : []), String(mood || ''), body, body.length);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** 全量启用切片（读侧薄层预热用：一次拉进内存，唤醒时同步挑选）。 */
export function listStyleSlicesAll({ db: conn } = {}) {
  const db = conn || openDb();
  return db.prepare('SELECT id, source, part, kind, tags, mood, text, chars FROM style_slice WHERE enabled = 1 ORDER BY kind, id').all();
}

export function listStyleSlices({ kind, tags, limit = 8, db: conn } = {}) {
  const db = conn || openDb();
  const where = ['enabled = 1'];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(String(kind)); }
  args.push(Math.max(1, Math.min(50, Number(limit) || 8)));
  return db.prepare('SELECT id, source, part, kind, tags, mood, text, chars, enabled FROM style_slice WHERE ' + where.join(' AND ') + ' ORDER BY id LIMIT ?').all(...args);
}

export function setStyleSliceEnabled(id, enabled, { db: conn } = {}) {
  const db = conn || openDb();
  db.prepare('UPDATE style_slice SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id));
  return { ok: true, id: Number(id), enabled: enabled ? 1 : 0 };
}

export function listStyleSlicesBySource(source, { db: conn } = {}) {
  const db = conn || openDb();
  return db.prepare('SELECT id, source, part, kind, tags, mood, text, chars, enabled FROM style_slice WHERE source = ? ORDER BY id').all(String(source));
}

export function deleteStyleSlicesBySource(source, { db: conn } = {}) {
  const db = conn || openDb();
  const info = db.prepare('DELETE FROM style_slice WHERE source = ?').run(String(source));
  return { ok: true, source: String(source), removed: Number(info.changes || 0) };
}

/** 任务台账。 */
export function jobState(name, { db: conn } = {}) {
  const db = conn || openDb();
  return db.prepare('SELECT * FROM job_state WHERE name = ?').get(String(name)) || null;
}

export function saveJobState(name, patch = {}, { db: conn } = {}) {
  const db = conn || openDb();
  const cur = jobState(name, { db }) || {};
  const next = {
    day_key: patch.dayKey != null ? String(patch.dayKey) : String(cur.day_key || ''),
    cursor: patch.cursor != null ? String(patch.cursor) : String(cur.cursor || ''),
    state: patch.state != null ? String(patch.state) : String(cur.state || 'idle'),
    last_run_at: patch.lastRunAt != null ? Number(patch.lastRunAt) : Number(cur.last_run_at || 0),
    last_error: patch.lastError != null ? String(patch.lastError) : String(cur.last_error || ''),
    stats: JSON.stringify(patch.stats != null ? patch.stats : (() => { try { return JSON.parse(cur.stats || '{}'); } catch { return {}; } })()),
  };
  db.prepare('INSERT INTO job_state (name, day_key, cursor, state, last_run_at, last_error, stats) VALUES (?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(name) DO UPDATE SET day_key = excluded.day_key, cursor = excluded.cursor, state = excluded.state, '
    + 'last_run_at = excluded.last_run_at, last_error = excluded.last_error, stats = excluded.stats')
    .run(String(name), next.day_key, next.cursor, next.state, next.last_run_at, next.last_error, next.stats);
  return next;
}

/** 概览数字（控制台用）。 */
export function stats({ db: conn } = {}) {
  const db = conn || openDb();
  const one = (sql) => { try { const row = db.prepare(sql).get(); return row ? Number(Object.values(row)[0] || 0) : 0; } catch { return 0; } };
  return {
    cache: one('SELECT COUNT(*) FROM cache_msg'),
    cacheNew: one("SELECT COUNT(*) FROM cache_msg WHERE process_state = 'new'"),
    topics: one('SELECT COUNT(*) FROM topic'),
    important: one("SELECT COUNT(*) FROM topic WHERE tier = 'important'"),
    fragments: one('SELECT COUNT(*) FROM fragment'),
    profiles: one('SELECT COUNT(*) FROM profile'),
    styleSlices: one('SELECT COUNT(*) FROM style_slice'),
    dbBytes: (() => { try { return fs.statSync(resolveDbFile()).size; } catch { return 0; } })(),
  };
}

/**
 * 2 天窗口：删 D-2 的 daily（important 永不参与删除）。
 * 删之前先把要删的东西导出 JSONL 到 trashDir（默认 <db 同目录>/memory-trash），误删可救。
 * 返回 { ok, day, deleted, promoted, exported }。
 */
export function pruneWindow({ targetDay, trashDir, db: conn } = {}) {
  const db = conn || openDb();
  const day = String(targetDay || '');
  if (!day) return { ok: false, reason: 'targetDay required' };
  const topics = db.prepare("SELECT * FROM topic WHERE day_key = ? AND tier = 'daily'").all(day);
  const frags = db.prepare("SELECT * FROM fragment WHERE day_key = ? AND tier = 'daily'").all(day);
  const caches = db.prepare('SELECT * FROM cache_msg WHERE day_key = ? AND keep = 0').all(day);
  const dir = trashDir || path.join(path.dirname(resolveDbFile()), 'memory-trash');
  let exported = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    exported = path.join(dir, day + '.jsonl');
    const lines = [];
    for (const row of topics) lines.push(JSON.stringify({ kind: 'topic', row }));
    for (const row of frags) lines.push(JSON.stringify({ kind: 'fragment', row }));
    for (const row of caches) lines.push(JSON.stringify({ kind: 'cache_msg', row }));
    fs.writeFileSync(exported, lines.join('\n') + '\n', 'utf8');
  } catch { exported = ''; }
  db.exec('BEGIN');
  try {
    for (const t of topics) {
      db.prepare('DELETE FROM topic_msg WHERE topic_id = ?').run(t.id);
      db.prepare("DELETE FROM search_doc WHERE ref_type = 'topic' AND ref_id = ?").run(t.id);
      db.prepare('DELETE FROM topic WHERE id = ?').run(t.id);
    }
    for (const f of frags) {
      db.prepare("DELETE FROM search_doc WHERE ref_type = 'fragment' AND ref_id = ?").run(String(f.id));
      db.prepare('DELETE FROM fragment WHERE id = ?').run(f.id);
    }
    const delCache = db.prepare('DELETE FROM cache_msg WHERE day_key = ? AND keep = 0').run(day);
    db.exec('COMMIT');
    return { ok: true, day, deleted: { topics: topics.length, fragments: frags.length, cache: Number(delCache.changes || 0) }, promoted: 0, exported };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    return { ok: false, reason: error && error.message ? error.message : String(error), day };
  }
}

/** 强制晋升一个话题（复核 / 手工）。 */
export function promoteTopic(topicId, { reason = 'review', db: conn } = {}) {
  const db = conn || openDb();
  const info = db.prepare("UPDATE topic SET tier = 'important', promoted_at = ?, promote_reason = ? WHERE id = ?")
    .run(Date.now(), String(reason), String(topicId));
  return Number(info.changes || 0) > 0;
}

/** 旧库探针：只读，用来确认「旧档案未被我碰过」。 */
export function legacyProbe({ dir } = {}) {
  const base = dir || (() => { try { return activeMemoryPaths().dir; } catch { return ''; } })();
  if (!base) return { ok: false };
  const file = path.join(base, 'memory-card-full.jsonl');
  try {
    const st = fs.statSync(file);
    return { ok: true, file, bytes: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return { ok: false, file };
  }
}

// ── 人物事实（fact）────────────────────────────────────────────────────────
//
// 主人 2026-11-13 19:34 的要求（原话）：「重要记忆区不再局限于话题，把关于生日等私人信息
// 单独存入，提高权重。尤其注意隐私问题」。
//
// 三条硬规则（不靠模型自觉）：
//  1. 事实**不随话题走**：话题要双方发言、两天窗口会清，事实一直留着（只有人能删）。
//  2. 事实**按人归属**：owner_id 是「这条事实属于谁」。A 的生日挂在 A 名下，不是挂在
//     「当前会话」名下 —— 这样 A 问自己生日、B 问「A 生日什么时候」都能按对象查到。
//  3. 事实**带隐私级**：normal 群里也能用；private 只跟本人对话时用；secret 只本人私聊
//     与面板可见。注入与检索都按级过滤，不靠名字里有没有「生日」去猜。
//
// 为什么另建表而不是塞 fragment：fragment 会被 promoteWindow 两天清、被目录当零碎条数统计，
// 且没有 privacy 维度。事实的寿命与可见性都和它不同，混在一起必然两头都不对。
export const FACT_KINDS = ['birthday', 'anniversary', 'like', 'dislike', 'allergy', 'contact', 'address', 'nickname', 'promise', 'identity', 'note'];
export const FACT_KIND_LABELS = {
  birthday: '生日', anniversary: '纪念日', like: '喜欢', dislike: '不吃/讨厌', allergy: '过敏',
  contact: '联系方式', address: '地址', nickname: '称呼', promise: '约定', identity: '身份', note: '其它',
};
export const FACT_PRIVACY = ['normal', 'private', 'secret'];
export const FACT_PRIVACY_LABELS = { normal: '可公开用', private: '只本人对话', secret: '只本人与面板' };

export function normalizeFactKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase();
  return FACT_KINDS.includes(k) ? k : 'note';
}

export function normalizeFactPrivacy(privacy) {
  const v = String(privacy ?? '').trim().toLowerCase();
  return FACT_PRIVACY.includes(v) ? v : 'private';
}

/**
 * 写一条事实（按 owner+kind+label 去重）。
 *
 * 同一个人反复说「我生日是1月1」时不能堆行：后说的覆盖先说的（生日被改口也能纠正），
 * 但 weight 只升不降（说得多说明重要）。source 记录来源，面板上能看出是自动抽的还是人改的。
 */
export function upsertFact(entry = {}) {
  const db = entry.db && typeof entry.db === 'object' && entry.db.prepare ? entry.db : openDb();
  const ownerId = String(entry.ownerId || entry.owner_id || 'unknown');
  const kind = normalizeFactKind(entry.kind);
  const label = String(entry.label || FACT_KIND_LABELS[kind] || '其它').trim().slice(0, 24) || '其它';
  const text = String(entry.text || '').trim().slice(0, 200);
  if (!text) return { ok: false, reason: 'empty text' };
  const privacy = normalizeFactPrivacy(entry.privacy);
  const weight = Math.max(1, Math.min(5, Number(entry.weight) || 3));
  const source = String(entry.source || 'manual').slice(0, 20);
  const at = Number(entry.at) || Date.now();
  const day = String(entry.dayKey || entry.day_key || dayKey(at));
  const now = Date.now();
  const existed = db.prepare('SELECT id FROM fact WHERE owner_id = ? AND kind = ? AND label = ?').get(ownerId, kind, label);
  db.prepare(
    'INSERT INTO fact (owner_id, kind, label, text, privacy, weight, source, day_key, at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(owner_id, kind, label) DO UPDATE SET text = excluded.text, privacy = excluded.privacy, '
    + 'weight = MAX(fact.weight, excluded.weight), source = excluded.source, updated_at = excluded.updated_at',
  ).run(ownerId, kind, label, text, privacy, weight, source, day, at, now);
  const row = db.prepare('SELECT id FROM fact WHERE owner_id = ? AND kind = ? AND label = ?').get(ownerId, kind, label);
  const id = Number(row && row.id) || 0;
  if (id) upsertSearchDoc({ refType: 'fact', refId: String(id), ownerId, body: label + '：' + text, at, db });
  return { ok: true, id, created: !existed, duplicated: Boolean(existed) };
}

function factRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id) || 0,
    ownerId: String(row.owner_id || ''),
    kind: String(row.kind || 'note'),
    kindLabel: FACT_KIND_LABELS[String(row.kind || 'note')] || '其它',
    label: String(row.label || ''),
    text: String(row.text || ''),
    privacy: normalizeFactPrivacy(row.privacy),
    privacyLabel: FACT_PRIVACY_LABELS[normalizeFactPrivacy(row.privacy)],
    weight: Number(row.weight) || 3,
    source: String(row.source || ''),
    day: String(row.day_key || ''),
    at: Number(row.at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

/** 某人（或全库）的事实列表：权重高的在前，同权重按最近更新。 */
export function listFacts({ ownerId = '', limit = 40, privacy = '', db: conn } = {}) {
  const db = conn || openDb();
  const n = Math.max(1, Math.min(200, Number(limit) || 40));
  const who = String(ownerId || '').trim();
  const want = String(privacy || '').trim();
  const rows = want
    ? db.prepare('SELECT * FROM fact WHERE owner_id = ? AND privacy = ? ORDER BY weight DESC, updated_at DESC LIMIT ?').all(who, normalizeFactPrivacy(want), n)
    : (who
      ? db.prepare('SELECT * FROM fact WHERE owner_id = ? ORDER BY weight DESC, updated_at DESC LIMIT ?').all(who, n)
      : db.prepare('SELECT * FROM fact ORDER BY updated_at DESC LIMIT ?').all(n));
  return rows.map(factRow);
}

export function getFact(id, { db: conn } = {}) {
  const db = conn || openDb();
  const row = db.prepare('SELECT * FROM fact WHERE id = ?').get(Number(id) || 0);
  return factRow(row);
}

/** 按关键词搜事实（label/text 都搜，不受 FTS 的 3 字限制）。 */
export function searchFacts({ q = '', ownerId = '', scope = 'current', limit = 10, db: conn } = {}) {
  const db = conn || openDb();
  const query = String(q || '').trim();
  if (!query) return [];
  const n = Math.max(1, Math.min(50, Number(limit) || 10));
  const like = '%' + query + '%';
  const cross = String(scope) === 'all';
  const rows = cross
    ? db.prepare('SELECT * FROM fact WHERE (label LIKE ? OR text LIKE ?) ORDER BY weight DESC, updated_at DESC LIMIT ?').all(like, like, n)
    : db.prepare('SELECT * FROM fact WHERE owner_id = ? AND (label LIKE ? OR text LIKE ?) ORDER BY weight DESC, updated_at DESC LIMIT ?').all(String(ownerId || ''), like, like, n);
  return rows.map(factRow);
}

/** 改一条事实（面板/MCP 共用）。只允许改这几个字段，owner/kind/label 改了就换去重键，谨慎。 */
export function updateFact(id, patch = {}, { db: conn } = {}) {
  const db = conn || openDb();
  const row = db.prepare('SELECT * FROM fact WHERE id = ?').get(Number(id) || 0);
  if (!row) return { ok: false, reason: 'not found' };
  const next = {
    kind: normalizeFactKind(patch.kind ?? row.kind),
    label: patch.label == null ? String(row.label) : String(patch.label).trim().slice(0, 24),
    text: patch.text == null ? String(row.text) : String(patch.text).trim().slice(0, 200),
    privacy: normalizeFactPrivacy(patch.privacy ?? row.privacy),
    weight: Math.max(1, Math.min(5, Number(patch.weight ?? row.weight) || 3)),
    ownerId: patch.ownerId == null ? String(row.owner_id) : String(patch.ownerId),
  };
  if (!next.text) return { ok: false, reason: 'empty text' };
  if (!next.label) next.label = FACT_KIND_LABELS[next.kind] || '其它';
  const dup = db.prepare('SELECT id FROM fact WHERE owner_id = ? AND kind = ? AND label = ? AND id <> ?')
    .get(next.ownerId, next.kind, next.label, Number(id));
  if (dup) return { ok: false, reason: 'duplicate', existsId: Number(dup.id) };
  db.prepare('UPDATE fact SET owner_id = ?, kind = ?, label = ?, text = ?, privacy = ?, weight = ?, source = ?, updated_at = ? WHERE id = ?')
    .run(next.ownerId, next.kind, next.label, next.text, next.privacy, next.weight, String(patch.source || row.source || 'manual'), Date.now(), Number(id));
  upsertSearchDoc({ refType: 'fact', refId: String(id), ownerId: next.ownerId, body: next.label + '：' + next.text, at: Number(row.at) || Date.now() });
  return { ok: true, id: Number(id) };
}

export function deleteFact(id, { db: conn } = {}) {
  const db = conn || openDb();
  const n = Number(id) || 0;
  const row = db.prepare('SELECT * FROM fact WHERE id = ?').get(n);
  if (!row) return { ok: false, reason: 'not found' };
  db.prepare('DELETE FROM fact WHERE id = ?').run(n);
  db.prepare("DELETE FROM search_doc WHERE ref_type = 'fact' AND ref_id = ?").run(String(n));
  return { ok: true, row: factRow(row) };
}

/** 事实条数（面板与目录用）：某人多少条、其中几级隐私。 */
export function factStats({ ownerId = '', db: conn } = {}) {
  const db = conn || openDb();
  const who = String(ownerId || '').trim();
  const rows = who
    ? db.prepare('SELECT privacy, COUNT(*) AS n FROM fact WHERE owner_id = ? GROUP BY privacy').all(who)
    : db.prepare('SELECT privacy, COUNT(*) AS n FROM fact GROUP BY privacy').all();
  const out = { total: 0, normal: 0, private: 0, secret: 0 };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    out.total += n;
    const p = normalizeFactPrivacy(r.privacy);
    out[p] = (out[p] || 0) + n;
  }
  if (who) {
    const last = db.prepare('SELECT MAX(updated_at) AS t FROM fact WHERE owner_id = ?').get(who);
    out.lastAt = Number(last && last.t) || 0;
  }
  return out;
}

/**
 * 注入块：把「这个人的重要事实」压成几行（默认 ≤360 字）。
 *
 * 为什么单独一块而不是塞进目录：事实的高权重就是「不用查也知道」——生日、忌口、
 * 雷区这些，每轮都该在眼前。目录（标题）是「有事可查」，两者语义不同。
 *
 * audience 决定可见级：
 *  · 'owner'（本人私聊/面板）：三级全给；
 *  · 'self'（她在群里/跟别人提这个人）：只给 normal；
 *  · 群聊里提到当前说话人时也走 'self'。
 */
export function formatFactsForModel(facts, { audience = 'self', maxChars = 360, who = '' } = {}) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return '';
  // 三种视角：owner=正在跟本人说话（三级全给）；self=群聊里只给可公开用的；
  // other=主人在问别人（别人的 private/secret 一律不进上下文，要看细节去面板）。
  // 为什么 other 比 owner 严：私事只对本人说，主人跨人问也一样 —— 否则「A 的生日」会被念出来。
  const allow = audience === 'owner' ? ['normal', 'private', 'secret'] : ['normal'];
  const shown = list.filter((f) => allow.includes(f.privacy));
  if (!shown.length) return '';
  const head = who ? '［重要事实·' + who + '］' : '［重要事实］';
  const lines = [];
  for (const f of shown) {
    const mark = f.privacy === 'normal' ? '' : (f.privacy === 'secret' ? '（别外传）' : '（只在跟他本人说话时提）');
    lines.push('· ' + (f.kindLabel || '其它') + '：' + f.text + mark);
    if (lines.join(String.fromCharCode(10)).length > maxChars) break;
  }
  let out = head + lines.join('｜') + '。';
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…';
  return out;
}

/** 一条事实渲染成文本（工具返回 / 面板详情）。 */
export function formatFactLine(f) {
  if (!f) return '';
  const when = new Date(Number(f.updatedAt) || Number(f.at) || Date.now()).toLocaleDateString('zh-CN');
  return '#' + f.id + ' [' + (f.kindLabel || '其它') + '] ' + f.text + '（' + (f.privacyLabel || '') + '，权重 ' + f.weight + '，' + when + '，' + (f.source || '') + '）';
}
