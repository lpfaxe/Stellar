/**
 * 记忆库视图：给插件设置页「记忆」页签用的**只读**聚合。
 *
 * 为什么单独一个文件：
 *  · 插件进程与桥接是两个进程，桥接负责写，这里只读（WAL 多进程读安全，openDb 里的 DDL 是 IF NOT EXISTS）。
 *  · 不在 src/memory-db.js 里加导出：那个模块被 vm 加载器逐行剥离后再 bind，多加一个导出会让一批测试静默炸（PITFALLS #183）。
 *  · 这里只做「看得见」，所有写操作（清空/删除/改事实）都留在 3300 面板与 stellar_memory_* 工具，避免两个写入口打架。
 */
import {
  catalog, dayKey, factStats, jobState, listFacts, listProfiles, listZoneNotes,
  openDb, stats, zoneStats,
} from '../../../src/memory-db.js';

const TOPIC_LIMIT = 12;
const FACT_LIMIT = 12;
const ZONE_LIMIT = 6;

function recentTopics(db, ownerId) {
  const who = String(ownerId || '').trim();
  const sql = who
    ? 'SELECT id, owner_id, title, summary, tier, importance, msg_count, ended_at, day_key FROM topic WHERE owner_id = ? ORDER BY (tier = ' + "'important'" + ') DESC, ended_at DESC LIMIT ?'
    : 'SELECT id, owner_id, title, summary, tier, importance, msg_count, ended_at, day_key FROM topic ORDER BY (tier = ' + "'important'" + ') DESC, ended_at DESC LIMIT ?';
  try {
    return (who ? db.prepare(sql).all(who, TOPIC_LIMIT) : db.prepare(sql).all(TOPIC_LIMIT)).map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      title: String(r.title || '').slice(0, 80),
      summary: String(r.summary || '').slice(0, 160),
      tier: r.tier || 'daily',
      importance: Number(r.importance) || 0,
      msgCount: Number(r.msg_count) || 0,
      endedAt: Number(r.ended_at) || 0,
      day: r.day_key || '',
    }));
  } catch { return []; }
}

function jobBrief(name) {
  try {
    const row = jobState(name);
    if (!row) return { name, state: 'pending', day: '', lastRunAt: 0, error: '', stats: null };
    let st = null;
    try { st = row.stats ? JSON.parse(row.stats) : null; } catch { st = null; }
    return {
      name,
      state: row.state || 'idle',
      day: row.day_key || '',
      lastRunAt: Number(row.last_run_at) || 0,
      error: String(row.last_error || '').slice(0, 200),
      stats: st,
    };
  } catch (e) {
    return { name, state: 'error', day: '', lastRunAt: 0, error: String(e?.message || e).slice(0, 200), stats: null };
  }
}

/**
 * 一次取齐设置页要显示的东西。任何一步失败都不该让整个页签空白 —— 逐段 try。
 *
 * @param {{ ownerId?: string, zone?: string }} opts ownerId 只影响话题、事实、侧写的筛选
 */
export function memoryDbOverview({ ownerId = '', zone = 'bili' } = {}) {
  const db = openDb();
  const today = dayKey(Date.now());
  const who = String(ownerId || '').trim();

  let counts = { cache: 0, cacheNew: 0, topics: 0, important: 0, fragments: 0, profiles: 0, styleSlices: 0, facts: 0, zones: 0 };
  try { counts = { ...counts, ...stats({ db }) }; } catch {}

  let facts = { total: 0, normal: 0, private: 0, secret: 0 };
  try { facts = { ...facts, ...factStats({ ownerId: who, db }) }; } catch {}

  let zones = {};
  try { zones = zoneStats({ day: today, db }); } catch {}

  let profiles = [];
  try {
    profiles = listProfiles({ db }).map((r) => ({
      ownerId: r.owner_id,
      persona: String(r.persona || '').slice(0, 120),
      detail: String(r.detail || '').slice(0, 200),
      tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })(),
      source: r.source || '',
      msgCount: Number(r.msg_count) || 0,
      updatedAt: Number(r.updated_at) || 0,
      editedBy: r.edited_by || '',
    })).slice(0, 8);
  } catch {}

  let factRows = [];
  try {
    // 注意：listFacts 已经做过 camelCase 转换（ownerId/day/at/updatedAt），
    // 而 listProfiles / listZoneNotes 返回的是原始列名 —— 这里两种都兼容，别再踩一次。
    factRows = listFacts({ ownerId: who, limit: FACT_LIMIT, db }).map((r) => ({
      id: Number(r.id) || 0,
      ownerId: r.ownerId || r.owner_id || '',
      kind: r.kind || 'note',
      label: String(r.label || '').slice(0, 40),
      text: String(r.text || '').slice(0, 120),
      privacy: r.privacy || 'private',
      weight: Number(r.weight) || 0,
      source: r.source || '',
    }));
  } catch {}

  let zoneRows = [];
  try {
    zoneRows = listZoneNotes({ zone, limit: ZONE_LIMIT, db }).map((r) => ({
      id: Number(r.id) || 0,
      zone: r.zone,
      day: r.day_key || '',
      text: String(r.text || '').slice(0, 160),
      items: (() => { try { return JSON.parse(r.items || '[]'); } catch { return []; } })(),
      at: Number(r.at) || 0,
    }));
  } catch {}

  let catalogRow = { rows: [], fragments: 0, persona: '', zones: null, facts };
  try { catalogRow = catalog({ ownerId: who, limit: 8, db }) || catalogRow; } catch {}

  return {
    ok: true,
    day: today,
    counts,
    facts,
    zones,
    zone,
    topics: recentTopics(db, who),
    factRows,
    zoneRows,
    profiles,
    catalog: {
      topics: (catalogRow.rows || []).length,
      fragments: Number(catalogRow.fragments) || 0,
    },
    jobs: [jobBrief('split'), jobBrief('window'), jobBrief('profile')],
  };
}

export const MEMORY_DB_ZONES = ['bili', 'qzone'];
