/**
 * Stellar —— 鱼缸小镇的记忆层（独立库 town.db，不碰 memory.db）。
 *
 * 为什么要单独一个库：
 *  · TTL 3 天的小镇笔记**不能跟着 memory.db 一起被备份/迁移**，否则「3 天后删掉」只是假动作；
 *  · 小镇文本全程按「数据」对待（来源标签 + 不进 facts/topic/profile），单独放一处最好审。
 *
 * 三张表：
 *  · town_note       事件（visit/play/goto/say…），TTL 3 个日历日，src_hash 去重
 *  · town_impression 人物印象，一人一行，TTL 30 天，最多 20 人
 *  · town_day        每天一句感受，长期保留
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TOWN_DB_FILE = 'town.db';

const DDL = `
CREATE TABLE IF NOT EXISTS town_note (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       INTEGER NOT NULL,
  day      TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  who      TEXT    NOT NULL DEFAULT '',
  text     TEXT    NOT NULL,
  src_hash TEXT    NOT NULL UNIQUE,
  visit_id TEXT    NOT NULL DEFAULT '',
  quoted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_town_note_day ON town_note(day);
CREATE INDEX IF NOT EXISTS idx_town_note_who ON town_note(who);

CREATE TABLE IF NOT EXISTS town_impression (
  fish_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  line       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS town_day (
  day  TEXT PRIMARY KEY,
  line TEXT NOT NULL,
  at   INTEGER NOT NULL
);
`;

const connections = new Map();

/** 小镇数据的唯一目录：<DSH_HOME>/stellar/state/town/（调度器、MCP、测试共用同一个）。 */
export function townDirOf(dshHome) {
  const home = String(dshHome || process.env.DSH_HOME || '').trim();
  if (!home) throw new Error('town-store: 需要 dshHome 或 DSH_HOME');
  return path.join(home, 'stellar', 'state', 'town');
}

export function resolveTownDbFile({ dir } = {}) {
  const base = String(dir || '').trim()
    || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'stellar', 'characters', 'deepseek', 'memory') : '');
  if (!base) throw new Error('town-store: 需要 dir 或 DSH_HOME');
  return path.join(base, TOWN_DB_FILE);
}

export function openTownDb({ file, dir } = {}) {
  const target = file || resolveTownDbFile({ dir });
  const hit = connections.get(target);
  if (hit) return hit;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=3000');
  db.exec(DDL);
  connections.set(target, db);
  return db;
}

export function closeTownDb({ file } = {}) {
  if (!file) { for (const [k, db] of connections) { try { db.close(); } catch {} connections.delete(k); } return true; }
  const db = connections.get(file);
  if (!db) return false;
  try { db.close(); } catch {}
  connections.delete(file);
  return true;
}

/** 写一条事件；同 src_hash 直接忽略（轮询重复拉到同一条）。 */
export function insertNote(row = {}, { db: conn } = {}) {
  const db = conn || openTownDb();
  const r = {
    at: Number(row.at) || Date.now(),
    day: String(row.day || ''),
    kind: String(row.kind || 'note'),
    who: String(row.who || ''),
    text: String(row.text || ''),
    src_hash: String(row.src_hash || ''),
    visit_id: String(row.visit_id || ''),
    quoted: row.quoted ? 1 : 0,
  };
  if (!r.day || !r.text || !r.src_hash) return { inserted: false, reason: 'incomplete' };
  const info = db.prepare('INSERT OR IGNORE INTO town_note(at, day, kind, who, text, src_hash, visit_id, quoted) VALUES (?,?,?,?,?,?,?,?)')
    .run(r.at, r.day, r.kind, r.who, r.text, r.src_hash, r.visit_id, r.quoted);
  return { inserted: Number(info.changes) > 0 };
}

/** 删掉 day 早于 cutoffDay 的笔记（TTL 到点）。 */
export function pruneNotes(cutoffDay, { db: conn } = {}) {
  const db = conn || openTownDb();
  const day = String(cutoffDay || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { deleted: 0 };
  const info = db.prepare('DELETE FROM town_note WHERE day < ?').run(day);
  return { deleted: Number(info.changes) || 0 };
}

export function listNotes({ days = [], q = '', limit = 60, db: conn } = {}) {
  const db = conn || openTownDb();
  const where = [];
  const args = [];
  if (Array.isArray(days) && days.length) { where.push('day IN (' + days.map(() => '?').join(',') + ')'); args.push(...days); }
  const kw = String(q || '').trim();
  if (kw) { where.push('(text LIKE ? OR who LIKE ?)'); args.push('%' + kw + '%', '%' + kw + '%'); }
  const sql = 'SELECT * FROM town_note' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY at DESC LIMIT ?';
  args.push(Math.max(1, Math.min(500, Number(limit) || 60)));
  return db.prepare(sql).all(...args).map((n) => ({ ...n, quoted: !!n.quoted }));
}

export function countNotes({ db: conn } = {}) {
  const db = conn || openTownDb();
  return Number(db.prepare('SELECT COUNT(*) AS c FROM town_note').get().c) || 0;
}

/** 人物印象：一人一行，后写的覆盖。 */
export function upsertImpression({ fishId, name = '', line, at = Date.now() } = {}, { db: conn } = {}) {
  const db = conn || openTownDb();
  const id = String(fishId || '').trim();
  const text = String(line || '').trim();
  if (!id || !text) return { ok: false };
  db.prepare('INSERT INTO town_impression(fish_id, name, line, updated_at) VALUES (?,?,?,?) ON CONFLICT(fish_id) DO UPDATE SET name=excluded.name, line=excluded.line, updated_at=excluded.updated_at')
    .run(id, String(name || ''), text, Number(at) || Date.now());
  return { ok: true };
}

export function listImpressions({ limit = 20, db: conn } = {}) {
  const db = conn || openTownDb();
  return db.prepare('SELECT * FROM town_impression ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(20, Number(limit) || 20)));
}

/** 删过期的印象，并把总数压到 max 以内（留最近的）。 */
export function pruneImpressions({ beforeMs, max = 20, db: conn } = {}) {
  const db = conn || openTownDb();
  let deleted = 0;
  if (Number.isFinite(Number(beforeMs)) && Number(beforeMs) > 0) {
    deleted += Number(db.prepare('DELETE FROM town_impression WHERE updated_at < ?').run(Number(beforeMs)).changes) || 0;
  }
  const over = Number(db.prepare('SELECT COUNT(*) AS c FROM town_impression').get().c) - max;
  if (over > 0) {
    const rows = db.prepare('SELECT fish_id FROM town_impression ORDER BY updated_at ASC LIMIT ?').all(over);
    const del = db.prepare('DELETE FROM town_impression WHERE fish_id = ?');
    for (const r of rows) deleted += Number(del.run(r.fish_id).changes) || 0;
  }
  return { deleted };
}

export function setDayLine({ day, line, at = Date.now() } = {}, { db: conn } = {}) {
  const db = conn || openTownDb();
  const d = String(day || '');
  const text = String(line || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !text) return { ok: false };
  db.prepare('INSERT INTO town_day(day, line, at) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET line=excluded.line, at=excluded.at')
    .run(d, text, Number(at) || Date.now());
  return { ok: true };
}

export function listDayLines({ limit = 14, db: conn } = {}) {
  const db = conn || openTownDb();
  return db.prepare('SELECT * FROM town_day ORDER BY day DESC LIMIT ?').all(Math.max(1, Math.min(90, Number(limit) || 14)));
}

export function townStats({ db: conn } = {}) {
  const db = conn || openTownDb();
  const one = (sql) => { try { return Number(db.prepare(sql).get().c) || 0; } catch { return 0; } };
  return {
    notes: one('SELECT COUNT(*) AS c FROM town_note'),
    impressions: one('SELECT COUNT(*) AS c FROM town_impression'),
    days: one('SELECT COUNT(*) AS c FROM town_day'),
  };
}
