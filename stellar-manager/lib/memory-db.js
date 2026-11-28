/* 新记忆库（SQLite）：控制台的只读视图 + 三个写操作。
 *
 * 库文件与桥接共用一份：<DSH_HOME>/stellar/characters/<当前角色>/memory/memory.db（WAL）。
 * 边界：
 *   · 这里不做切分/打分判定，规则全在 stellar/src/memory-db.js 与 memory-worker.js；
 *   · 读一律 readOnly 打开，避免和桥接抢写锁；写只做「改 tier / 忘记一条 / 手动跑一次任务」；
 *   · 忘记 = 先导出到 memory-trash/forgot-<时间>.json 再删，误删可救。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { REPO, SURF } from './paths.js'
import { contactIndex, labelForKey, relationFor } from './people.js'

const DB_NAME = 'memory.db'
const MAX_LIMIT = 200
const TRASH_DIR = 'memory-trash'

function pad(n) { return String(n).padStart(2, '0') }
export function dayOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** 当前角色目录：characters/current.json 的 id 优先，取不到再按 memory.db 的 mtime 挑最新的一个。 */
function characterDir() {
  const base = path.join(SURF, 'characters')
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(base, 'current.json'), 'utf8'))
    if (cur && cur.id) {
      return { dir: path.join(base, String(cur.id), 'memory'), role: String(cur.id), name: String(cur.name || cur.id) }
    }
  } catch {}
  let best = null
  try {
    for (const role of fs.readdirSync(base)) {
      const dir = path.join(base, role, 'memory')
      const file = path.join(dir, DB_NAME)
      if (!fs.existsSync(file)) continue
      const mtime = fs.statSync(file).mtimeMs
      if (!best || mtime > best.mtime) best = { dir, role, name: role, mtime }
    }
  } catch {}
  if (best) return { dir: best.dir, role: best.role, name: best.name }
  return { dir: path.join(base, 'deepseek', 'memory'), role: 'deepseek', name: 'deepseek' }
}

export function memoryDbInfo() {
  const who = characterDir()
  const file = path.join(who.dir, DB_NAME)
  let bytes = 0
  let mtime = 0
  try { const st = fs.statSync(file); bytes = st.size; mtime = st.mtimeMs } catch {}
  return { file, dir: who.dir, role: who.role, name: who.name, exists: bytes > 0, bytes, mtime }
}

function openRead(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { db.exec('PRAGMA busy_timeout=2000') } catch {}
  return db
}

function openWrite(file) {
  const db = new DatabaseSync(file)
  try { db.exec('PRAGMA busy_timeout=3000') } catch {}
  return db
}

function safe(fn, dflt) { try { return fn() } catch { return dflt } }

function countOf(db, sql, ...args) {
  return safe(function () {
    const row = db.prepare(sql).get(...args)
    return row ? Number(Object.values(row)[0] || 0) : 0
  }, 0)
}

function readJobs(db) {
  const rows = safe(function () { return db.prepare('SELECT * FROM job_state').all() }, []) || []
  return rows.map(function (r) {
    let stats = {}
    try { stats = JSON.parse(r.stats || '{}') } catch {}
    return {
      name: String(r.name || ''),
      day: String(r.day_key || ''),
      state: String(r.state || ''),
      lastRunAt: Number(r.last_run_at) || 0,
      lastError: String(r.last_error || ''),
      stats,
    }
  })
}

/** 记忆区（2026-11-27 新记忆架构）：区域页不存正文，这里只实时统计。旧库没有这些表时返回空数组。 */
function readRegions(db) {
  const rows = safe(function () {
    return db.prepare(
      'SELECT r.code, r.name, r.description, r.sort,' +
      ' (SELECT COUNT(*) FROM topic t WHERE t.region_id = r.code) AS topics,' +
      ' (SELECT COUNT(*) FROM memory_subject s WHERE s.region_id = r.code) AS subjects,' +
      ' (SELECT COUNT(*) FROM memory_page p WHERE p.region_id = r.code) AS pages' +
      ' FROM memory_region r ORDER BY r.sort, r.code'
    ).all()
  }, []) || []
  return rows.map(function (r) {
    return {
      code: String(r.code || ''),
      name: String(r.name || r.code || ''),
      description: String(r.description || ''),
      topics: Number(r.topics) || 0,
      subjects: Number(r.subjects) || 0,
      pages: Number(r.pages) || 0,
    }
  })
}

function readPages(db, limit) {
  const rows = safe(function () {
    return db.prepare(
      'SELECT p.*, s.name AS subject_name, s.kind AS subject_kind, r.name AS region_name' +
      ' FROM memory_page p' +
      ' LEFT JOIN memory_subject s ON s.id = p.subject_id' +
      ' LEFT JOIN memory_region r ON r.code = p.region_id' +
      ' ORDER BY p.updated_at DESC LIMIT ?'
    ).all(Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 20)))
  }, []) || []
  return rows.map(function (r) {
    let links = []
    let sources = []
    try { links = JSON.parse(r.links || '[]') } catch {}
    try { sources = JSON.parse(r.sources || '[]') } catch {}
    return {
      id: String(r.id || ''),
      regionId: String(r.region_id || ''),
      regionName: String(r.region_name || ''),
      subjectId: String(r.subject_id || ''),
      subjectName: String(r.subject_name || ''),
      subjectKind: String(r.subject_kind || ''),
      title: String(r.title || ''),
      body: String(r.body || ''),
      links: Array.isArray(links) ? links : [],
      sources: Array.isArray(sources) ? sources : [],
      privacy: String(r.privacy || 'normal'),
      version: Number(r.version) || 1,
      updatedAt: Number(r.updated_at) || 0,
      updatedBy: String(r.updated_by || 'dream'),
    }
  })
}

function trashList(dir) {
  const out = []
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.json(i)?$/.test(name)) continue
      const st = fs.statSync(path.join(dir, name))
      out.push({ name, bytes: st.size, at: st.mtimeMs });
    }
  } catch {}
  return out.sort(function (a, b) { return b.at - a.at }).slice(0, 8)
}

// contactIndex() 返回 { byUin, byGroup }（Map）+ updatedAt，**没有 people 数组**。
// labelForKey / relationFor 要吃 byUin/byGroup，所以这里保留原结构，另外补 people/groups 数组给面板用。
function peopleIndex() {
  const idx = safe(function () { return contactIndex() }, null)
  if (!idx) return { byUin: new Map(), byGroup: new Map(), people: [], groups: [] }
  const people = idx.byUin ? Array.from(idx.byUin.values()).map(function (p) {
    return { ownerId: p.uin, label: p.name || p.nickname || p.uin, relation: p.relation || '', type: p.type || '' }
  }) : []
  const groups = idx.byGroup ? Array.from(idx.byGroup.values()).map(function (g) {
    return { ownerId: 'group:' + g.gid, label: g.name || g.gid, relation: g.relation || '群' }
  }) : []
  return { byUin: idx.byUin, byGroup: idx.byGroup, updatedAt: idx.updatedAt || '', people: people, groups: groups }
}
function ownerView(index, ownerId) {
  const id = String(ownerId || '')
  const key = id.indexOf(':') >= 0 ? id : ('private:' + id)
  return { ownerId: id, label: labelForKey(index, key), relation: relationFor(index, key) }
}

export function buildMemoryDb() {
  const info = memoryDbInfo()
  const base = {
    ok: true,
    info,
    stats: { cache: 0, cacheNew: 0, topics: 0, important: 0, fragments: 0, profiles: 0, styleSlices: 0 },
    jobs: [],
    queued: pendingRequests(),
    owners: [],
    regions: [],
    pages: [],
    trash: [],
    at: new Date().toISOString(),
  }
  if (!info.exists) {
    base.empty = true
    base.queued = pendingRequests()
    base.zones = zoneStats()
    base.facts = factStats()
    base.message = '库还没有写入任何东西（创建于空表）'
    return base
  }
  let db = null
  try {
    db = openRead(info.file)
    base.stats = {
      cache: countOf(db, 'SELECT COUNT(*) FROM cache_msg'),
      cacheNew: countOf(db, "SELECT COUNT(*) FROM cache_msg WHERE process_state = 'new'"),
      topics: countOf(db, 'SELECT COUNT(*) FROM topic'),
      important: countOf(db, "SELECT COUNT(*) FROM topic WHERE tier = 'important'"),
      fragments: countOf(db, 'SELECT COUNT(*) FROM fragment'),
      profiles: countOf(db, 'SELECT COUNT(*) FROM profile'),
      styleSlices: countOf(db, 'SELECT COUNT(*) FROM style_slice WHERE enabled = 1'),
      todayCache: countOf(db, 'SELECT COUNT(*) FROM cache_msg WHERE day_key = ?', dayOf()),
      todayTopics: countOf(db, 'SELECT COUNT(*) FROM topic WHERE day_key = ?', dayOf()),
      subjects: countOf(db, 'SELECT COUNT(*) FROM memory_subject'),
      pages: countOf(db, 'SELECT COUNT(*) FROM memory_page'),
    }
    base.jobs = readJobs(db)
    base.regions = readRegions(db)
    base.pages = readPages(db, 24)
    const index = peopleIndex()
    const rows = safe(function () {
      return db.prepare('SELECT owner_id, COUNT(*) AS n FROM topic GROUP BY owner_id ORDER BY n DESC').all()
    }, []) || [];
    base.owners = rows.map(function (r) {
      const v = ownerView(index, r.owner_id)
      return { ownerId: v.ownerId, label: v.label, relation: v.relation, topics: Number(r.n) || 0 };
    });
    base.queued = pendingRequests()
    base.trash = trashList(path.join(info.dir, TRASH_DIR))
    base.trashDir = path.join(info.dir, TRASH_DIR)
    base.day = dayOf()
    base.zones = zoneStats()
    base.facts = factStats()
  } catch (e) {
    base.ok = false
    base.message = '读库失败：' + String(e && e.message || e)
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
  return base
}

export function listTopics(opts = {}) {
  const info = memoryDbInfo()
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(opts.limit) || 20))
  const offset = Math.max(0, Number(opts.offset) || 0)
  const where = []
  const args = []
  if (opts.owner) { where.push('owner_id = ?'); args.push(String(opts.owner)) }
  if (opts.tier === 'important' || opts.tier === 'daily') { where.push('tier = ?'); args.push(opts.tier) }
  if (opts.region) { where.push('region_id = ?'); args.push(String(opts.region)) }
  if (opts.day) { where.push('day_key = ?'); args.push(String(opts.day)) }
  const q = String(opts.q || '').trim().slice(0, 40)
  if (q) { where.push('(title LIKE ? OR summary LIKE ?)'); args.push('%' + q + '%', '%' + q + '%') }
  if (!info.exists) return { ok: true, total: 0, offset, limit, items: [], q, empty: true }
  let db = null
  try {
    db = openRead(info.file)
    const clause = where.length ? (' WHERE ' + where.join(' AND ')) : ''
    const total = countOf(db, 'SELECT COUNT(*) FROM topic' + clause, ...args)
    const rows = db.prepare('SELECT * FROM topic' + clause + ' ORDER BY ended_at DESC LIMIT ? OFFSET ?').all(...args, limit, offset);
    const index = peopleIndex()
    const regionNames = new Map((safe(function () { return db.prepare('SELECT code, name FROM memory_region').all() }, []) || []).map(function (x) { return [String(x.code), String(x.name)] }))
    const items = rows.map(function (r) {
      const v = ownerView(index, r.owner_id)
      let facets = []
      try { facets = JSON.parse(r.facets || '[]') } catch {}
      return {
        id: String(r.id),
        title: String(r.title || ''),
        summary: String(r.summary || ''),
        tier: String(r.tier || 'daily'),
        importance: Number(r.importance) || 0,
        facets: Array.isArray(facets) ? facets : [],
        sentiment: String(r.sentiment || ''),
        msgCount: Number(r.msg_count) || 0,
        startedAt: Number(r.started_at) || 0,
        endedAt: Number(r.ended_at) || 0,
        day: String(r.day_key || ''),
        regionId: String(r.region_id || ''),
        regionName: regionNames.get(String(r.region_id || '')) || '',
        titleSource: String(r.title_source || 'auto'),
        ownerId: v.ownerId,
        ownerLabel: v.label,
        relation: v.relation,
      }
    });
    return { ok: true, total, offset, limit, q, items, day: dayOf() }
  } catch (e) {
    return { ok: false, total: 0, offset, limit, items: [], message: '读库失败：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

export function readTopicDetail(id) {
  const topicId = String(id || '').trim()
  if (!topicId) return { ok: false, message: '缺少话题 id' }
  const info = memoryDbInfo()
  if (!info.exists) return { ok: false, message: '库还是空的' }
  let db = null
  try {
    db = openRead(info.file)
    const t = db.prepare('SELECT * FROM topic WHERE id = ?').get(topicId)
    if (!t) return { ok: false, message: '这条话题已经不在了（可能被 2 天窗口清掉了）' }
    const msgs = db.prepare('SELECT role, speaker_id, speaker_name, text, at, seq FROM topic_msg WHERE topic_id = ? ORDER BY seq').all(topicId);
    const index = peopleIndex()
    const v = ownerView(index, t.owner_id)
    let facets = []
    try { facets = JSON.parse(t.facets || '[]') } catch {}
    return {
      ok: true,
      topic: {
        id: String(t.id),
        title: String(t.title || ''),
        summary: String(t.summary || ''),
        tier: String(t.tier || 'daily'),
        importance: Number(t.importance) || 0,
        facets: Array.isArray(facets) ? facets : [],
        sentiment: String(t.sentiment || ''),
        day: String(t.day_key || ''),
        startedAt: Number(t.started_at) || 0,
        endedAt: Number(t.ended_at) || 0,
        promoteReason: String(t.promote_reason || ''),
        ownerId: v.ownerId,
        ownerLabel: v.label,
        relation: v.relation,
      },
      messages: msgs.map(function (m) {
        return {
          role: String(m.role || ''),
          name: String(m.speaker_name || ''),
          speakerId: String(m.speaker_id || ''),
          text: String(m.text || ''),
          at: Number(m.at) || 0,
        }
      }),
    }
  } catch (e) {
    return { ok: false, message: '读库失败：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

export function listFragments(opts = {}) {
  const info = memoryDbInfo()
  if (!info.exists) return { ok: true, total: 0, items: [], groups: [], empty: true }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(opts.limit) || 60))
  const where = []
  const args = []
  if (opts.owner) { where.push('owner_id = ?'); args.push(String(opts.owner)) }
  if (opts.tier === 'important' || opts.tier === 'daily') { where.push('tier = ?'); args.push(opts.tier) }
  if (opts.day) { where.push('day_key = ?'); args.push(String(opts.day)) }
  let db = null
  try {
    db = openRead(info.file)
    const clause = where.length ? (' WHERE ' + where.join(' AND ')) : ''
    const total = countOf(db, 'SELECT COUNT(*) FROM fragment' + clause, ...args)
    const important = countOf(db, "SELECT COUNT(*) FROM fragment WHERE tier = 'important'" + (where.length ? ' AND ' + where.join(' AND ') : ''), ...args)
    const rows = db.prepare('SELECT * FROM fragment' + clause + ' ORDER BY at DESC LIMIT ?').all(...args, limit);
    const index = peopleIndex()
    const items = rows.map(function (r) {
      const v = ownerView(index, r.owner_id)
      return {
        id: Number(r.id),
        text: String(r.text || ''),
        facet: String(r.facet || ''),
        weight: Number(r.weight) || 0,
        tier: String(r.tier || 'daily'),
        day: String(r.day_key || ''),
        topicId: String(r.topic_id || ''),
        at: Number(r.at) || 0,
        ownerId: v.ownerId,
        ownerLabel: v.label,
      }
    });
    const byFacet = {}
    for (const it of items) byFacet[it.facet || '未分类'] = (byFacet[it.facet || '未分类'] || 0) + 1;
    return {
      ok: true, total, important,
      items,
      groups: Object.keys(byFacet).map(function (k) { return { facet: k, count: byFacet[k] } }),
    }
  } catch (e) {
    return { ok: false, total: 0, items: [], message: '读库失败：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

/** 手动改 tier：topic 或 fragment。important 永不参与 2 天窗口删除，所以这是个「钉住」动作。 */
export function setMemoryTier({ type, id, tier } = {}) {
  const kind = String(type || '').trim()
  const next = String(tier || '').trim()
  if (kind !== 'topic' && kind !== 'fragment') return { ok: false, message: 'type 只能是 topic 或 fragment' }
  if (next !== 'important' && next !== 'daily') return { ok: false, message: 'tier 只能是 important 或 daily' }
  const info = memoryDbInfo()
  if (!info.exists) return { ok: false, message: '库还是空的' }
  let db = null
  try {
    db = openWrite(info.file)
    if (kind === 'topic') {
      const row = db.prepare('SELECT title FROM topic WHERE id = ?').get(String(id || ''))
      if (!row) return { ok: false, message: '没找到这条话题' }
      db.prepare('UPDATE topic SET tier = ?, promoted_at = ?, promote_reason = ? WHERE id = ?')
        .run(next, next === 'important' ? Date.now() : null, next === 'important' ? 'panel' : '', String(id));
      return { ok: true, type: 'topic', id: String(id), tier: next, title: String(row.title || '') }
    }
    const fragId = Number(id)
    if (!Number.isFinite(fragId)) return { ok: false, message: 'fragment 的 id 必须是数字' }
    const row = db.prepare('SELECT text FROM fragment WHERE id = ?').get(fragId)
    if (!row) return { ok: false, message: '没找到这条零碎记忆' }
    db.prepare('UPDATE fragment SET tier = ?, promoted_at = ? WHERE id = ?').run(next, next === 'important' ? Date.now() : null, fragId);
    return { ok: true, type: 'fragment', id: fragId, tier: next, text: String(row.text || '') }
  } catch (e) {
    return { ok: false, message: '改不动：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

/** 忘记一条：先整条导出到 memory-trash/forgot-<时间>.json，再删正文/检索/主行。 */
export function forgetMemory({ type, id } = {}) {
  const kind = String(type || '').trim()
  if (kind !== 'topic' && kind !== 'fragment') return { ok: false, message: 'type 只能是 topic 或 fragment' }
  const info = memoryDbInfo()
  if (!info.exists) return { ok: false, message: '库还是空的' }
  let db = null
  try {
    db = openWrite(info.file)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(info.dir, TRASH_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, 'forgot-' + stamp + '.json');
    if (kind === 'topic') {
      const row = db.prepare('SELECT * FROM topic WHERE id = ?').get(String(id || ''));
      if (!row) return { ok: false, message: '没找到这条话题' }
      const msgs = db.prepare('SELECT * FROM topic_msg WHERE topic_id = ? ORDER BY seq').all(String(id));
      fs.writeFileSync(out, JSON.stringify({ kind: 'topic', at: Date.now(), row, messages: msgs }, null, 2), 'utf8');
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM topic_msg WHERE topic_id = ?').run(String(id));
        db.prepare("DELETE FROM search_doc WHERE ref_type = 'topic' AND ref_id = ?").run(String(id));
        db.prepare('DELETE FROM topic WHERE id = ?').run(String(id));
        db.exec('COMMIT')
      } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
      return { ok: true, type: 'topic', id: String(id), title: String(row.title || ''), exported: out }
    }
    const fragId = Number(id)
    if (!Number.isFinite(fragId)) return { ok: false, message: 'fragment 的 id 必须是数字' }
    const row = db.prepare('SELECT * FROM fragment WHERE id = ?').get(fragId)
    if (!row) return { ok: false, message: '没找到这条零碎记忆' }
    fs.writeFileSync(out, JSON.stringify({ kind: 'fragment', at: Date.now(), row }, null, 2), 'utf8');
    db.exec('BEGIN')
    try {
      db.prepare("DELETE FROM search_doc WHERE ref_type = 'fragment' AND ref_id = ?").run(String(fragId));
      db.prepare('DELETE FROM fragment WHERE id = ?').run(fragId);
      db.exec('COMMIT')
    } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
    return { ok: true, type: 'fragment', id: fragId, text: String(row.text || ''), exported: out }
  } catch (e) {
    return { ok: false, message: '删不动：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

/** 手动跑一次后台作业。复用 stellar 那边的 worker，不在面板里重写判定。
 *
 *  split 是纯 SQLite，面板能当场跑；
 *  review（含原来的 window 清理）与 profile 要调模型，模型通道只在 DSH 插件里，
 *  所以这两个**只写请求文件排队**，由插件的定时器下一跳取走 —— 面板不假装已跑完。
 */
export async function runMemoryJob({ job } = {}) {
  const name = String(job || 'split').trim()
  const info = memoryDbInfo();
  if (name === 'review' || name === 'window') {
    const queued = requestMemoryJob({ job: 'review' })
    return { ...queued, job: 'review', note: '复核会先晋升重要的，再删前天的日常条目' }
  }
  if (name === 'profile') {
    const queued = requestMemoryJob({ job: 'profile' })
    return { ...queued, job: 'profile' }
  }
  if (name !== 'split') {
    return { ok: false, message: 'job 只能是 split / review / profile' }
  }
  const workerFile = path.join(REPO, 'src', 'memory-worker.js');
  if (!fs.existsSync(workerFile)) return { ok: false, message: '找不到 memory-worker.js：' + workerFile };
  const { pathToFileURL } = await import('node:url');
  let db = null;
  try {
    const worker = await import(pathToFileURL(workerFile).href);
    db = openWrite(info.file);
    const log = function () {};
    if (name === 'split') {
      const r = await worker.runSplit({ db, log });
      return { ok: true, job: 'split', result: r };
    }
    // 走到这里只剩 split 之外的历史分支；window 现在统一走排队（复核后清理）
    const r = await worker.runWindow({ db, log });
    return { ok: true, job: 'window', result: r, note: '未经复核的清理，只在手动传 window 时走到' };
  } catch (e) {
    return { ok: false, message: '跑失败了：' + String(e && e.message || e) };
  } finally {
    if (db) safe(function () { db.close() }, null);
  }
}

export function listProfiles() {
  const info = memoryDbInfo();
  const index = peopleIndex();
  if (!info.exists) return { ok: true, items: [], people: index.people || [] };
  let db = null;
  try {
    db = openRead(info.file);
    const rows = db.prepare('SELECT * FROM profile ORDER BY updated_at DESC').all();
    const items = rows.map(function (r) {
      const v = ownerView(index, r.owner_id);
      let tags = [];
      try { tags = JSON.parse(r.tags || '[]') } catch {}
      return {
        ownerId: v.ownerId,
        label: v.label,
        relation: v.relation,
        persona: String(r.persona || ''),
        detail: String(r.detail || ''),
        tags: Array.isArray(tags) ? tags : [],
        source: String(r.source || 'auto'),
        confidence: Number(r.confidence) || 0,
        msgCount: Number(r.msg_count) || 0,
        updatedAt: Number(r.updated_at) || 0,
        editedBy: String(r.edited_by || ''),
      };
    });
    return { ok: true, items, people: index.people || [] };
  } catch (e) {
    return { ok: false, items: [], message: '读库失败：' + String(e && e.message || e) };
  } finally {
    if (db) safe(function () { db.close() }, null);
  }
}

/** 手改侧写：source 记 manual，下面的自动复核不会再覆盖它（worker 侧按 source 判断）。 */
export function saveProfile({ ownerId, persona, detail, tags } = {}) {
  const id = String(ownerId || '').trim();
  if (!id) return { ok: false, message: '缺少 ownerId' };
  const who = String(persona || '').trim().slice(0, 50);
  if (!who) return { ok: false, message: '侧写不能是空的（最多 50 字）' };
  const info = memoryDbInfo();
  let db = null;
  try {
    db = openWrite(info.file);
    const old = safe(function () { return db.prepare('SELECT persona FROM profile WHERE owner_id = ?').get(id) }, null);
    const list = Array.isArray(tags) ? tags.slice(0, 8) : String(tags || '').split(/[\s,，、]+/).filter(Boolean).slice(0, 8);
    db.prepare('INSERT INTO profile(owner_id, persona, detail, tags, source, confidence, msg_count, updated_at, edited_by) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET persona=excluded.persona, detail=excluded.detail, tags=excluded.tags, source=excluded.source, updated_at=excluded.updated_at, edited_by=excluded.edited_by')
      .run(id, who, String(detail || '').trim().slice(0, 200), JSON.stringify(list), 'manual', 100, 0, Date.now(), 'panel');
    return { ok: true, ownerId: id, before: String(old && old.persona || ''), after: who };
  } catch (e) {
    return { ok: false, message: '存不进去：' + String(e && e.message || e) };
  } finally {
    if (db) safe(function () { db.close() }, null);
  }
}

export function listStyleRefs() {
  const info = memoryDbInfo();
  if (!info.exists) return { ok: true, sources: [], total: 0 };
  let db = null;
  try {
    db = openRead(info.file);
    const rows = db.prepare('SELECT * FROM style_slice ORDER BY source, part, id').all();
    const bySource = {};
    for (const r of rows) {
      const source = String(r.source || '参考库');
      bySource[source] = bySource[source] || { source, enabled: 0, total: 0, slices: [] };
      let tags = [];
      try { tags = JSON.parse(r.tags || '[]') } catch {}
      const item = {
        id: Number(r.id),
        part: String(r.part || ''),
        kind: String(r.kind || ''),
        tags: Array.isArray(tags) ? tags : [],
        mood: String(r.mood || ''),
        chars: Number(r.chars) || 0,
        enabled: Number(r.enabled) === 1,
        preview: String(r.text || '').replace(/\s+/g, ' ').slice(0, 60),
      };
      bySource[source].slices.push(item);
      bySource[source].total += 1;
      if (item.enabled) bySource[source].enabled += 1;
    }
    const list = Object.keys(bySource).map(function (k) { return bySource[k] });
    return { ok: true, sources: list, total: rows.length };
  } catch (e) {
    return { ok: false, sources: [], message: '读库失败：' + String(e && e.message || e) };
  } finally {
    if (db) safe(function () { db.close() }, null);
  }
}

export function setStyleRefEnabled({ id, source, enabled } = {}) {
  const flag = enabled ? 1 : 0;
  const info = memoryDbInfo();
  let db = null;
  try {
    db = openWrite(info.file);
    if (id !== undefined && id !== null && String(id) !== '') {
      const num = Number(id);
      if (!Number.isFinite(num)) return { ok: false, message: 'id 必须是数字' };
      const row = db.prepare('SELECT id, source, part, kind FROM style_slice WHERE id = ?').get(num);
      const r = db.prepare('UPDATE style_slice SET enabled = ? WHERE id = ?').run(flag, num);
      return { ok: true, changed: Number(r.changes || 0), id: num, source: row ? row.source : '', part: row ? row.part : '', kind: row ? row.kind : '', enabled: Boolean(flag) };
    }
    const src = String(source || '').trim();
    if (!src) return { ok: false, message: '要么给 id，要么给 source' };
    const r = db.prepare('UPDATE style_slice SET enabled = ? WHERE source = ?').run(flag, src);
    return { ok: true, changed: Number(r.changes || 0), source: src, enabled: Boolean(flag) };
  } catch (e) {
    return { ok: false, message: '改不动：' + String(e && e.message || e) };
  } finally {
    if (db) safe(function () { db.close() }, null);
  }
}

/**
 * 复核与侧写要调模型，而模型通道只在 DSH 插件里（ctx.get('llm')）。
 * 面板不假装「已经跑完」，只写一个请求文件，插件的定时器下一跳（≤10 分钟）取走执行。
 * 请求文件在 <SURF>/state/ 下，超过 40 分钟视为过期、直接丢弃。
 */
const REQUEST_NAMES = {
  review: 'memory-review-request.json',
  profile: 'memory-profile-request.json',
}

export function requestMemoryJob({ job } = {}) {
  const key = String(job || '').trim()
  const name = REQUEST_NAMES[key]
  if (!name) return { ok: false, code: 'UNKNOWN_JOB', message: '只有 review / profile 需要排队（split、window 能立即跑）' }
  const dir = path.join(SURF, 'state')
  const file = path.join(dir, name)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ job: key, at: Date.now(), by: 'panel' }) + '\n', 'utf8')
    return {
      ok: true, queued: true, job: key, file,
      message: '已排进队列：她那边每 10 分钟检查一次，成功后会写进「记忆库」卡的作业状态里。',
    }
  } catch (e) {
    return { ok: false, code: 'QUEUE_FAILED', message: '排队失败：' + String((e && e.message) || e) }
  }
}

/** 队列里有没有待办（卡片上要显示「复核已排队」）。 */
export function pendingRequests() {
  const dir = path.join(SURF, 'state')
  const out = []
  for (const [job, name] of Object.entries(REQUEST_NAMES)) {
    const file = path.join(dir, name)
    try {
      if (!fs.existsSync(file)) continue
      const st = fs.statSync(file)
      if (Date.now() - Number(st.mtimeMs || 0) > 40 * 60 * 1000) continue
      out.push({ job, at: Number(st.mtimeMs || 0) })
    } catch {}
  }
  return out
}

/* ── 见闻区（2026-11-13 主人加的）：B站 / QQ好友爱看 ───────────────────────────
 *
 * 这两个区不按话题切分：她自己看完写一段总结，一行一条（zone_note 表，由
 * stellar/src/memory-db.js 建表与写入）。面板这边只做两件事：看、删。
 * 删之前照旧导出到 memory-trash/，误删能救回来。
 */
export const ZONE_LABELS = { bili: 'B站', qzone: '好友爱看' }

function zoneOfName(name) {
  const z = String(name || '').trim()
  return z === 'bili' || z === 'qzone' ? z : ''
}

/** 两个区的条数/今天条数；表还没建（老库）就回 0，不报错。 */
export function zoneStats() {
  const info = memoryDbInfo()
  const out = { bili: { total: 0, today: 0, lastAt: 0 }, qzone: { total: 0, today: 0, lastAt: 0 } }
  if (!info.exists) return out
  let db = null
  try {
    db = openRead(info.file)
    for (const zone of ['bili', 'qzone']) {
      out[zone].total = countOf(db, 'SELECT COUNT(*) FROM zone_note WHERE zone = ?', zone)
      out[zone].today = countOf(db, 'SELECT COUNT(*) FROM zone_note WHERE zone = ? AND day_key = ?', zone, dayOf())
      const row = safe(function () { return db.prepare('SELECT MAX(at) AS t FROM zone_note WHERE zone = ?').get(zone) }, null)
      out[zone].lastAt = Number(row && row.t) || 0
    }
  } catch { /* 表不存在就当空 */ } finally {
    if (db) safe(function () { db.close() }, null)
  }
  return out
}

/** 某个区的条目（新→旧）。day 不传 = 最近 limit 条。 */
export function listZoneNotes(opts = {}) {
  const zone = zoneOfName(opts.zone)
  if (!zone) return { ok: false, message: 'zone 只能是 bili 或 qzone', rows: [] }
  const info = memoryDbInfo()
  if (!info.exists) return { ok: true, zone, label: ZONE_LABELS[zone], rows: [], total: 0 }
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(opts.limit) || 20))
  const day = String(opts.day || '').trim()
  let db = null
  try {
    db = openRead(info.file)
    const rows = safe(function () {
      if (day) return db.prepare('SELECT id, zone, day_key, text, items, source, at FROM zone_note WHERE zone = ? AND day_key = ? ORDER BY at DESC LIMIT ?').all(zone, day, limit)
      return db.prepare('SELECT id, zone, day_key, text, items, source, at FROM zone_note WHERE zone = ? ORDER BY at DESC LIMIT ?').all(zone, limit)
    }, []) || []
    const total = countOf(db, 'SELECT COUNT(*) FROM zone_note WHERE zone = ?', zone)
    return {
      ok: true,
      zone,
      label: ZONE_LABELS[zone],
      day,
      total,
      rows: rows.map(function (r) {
        let items = []
        try { items = JSON.parse(String(r.items || '[]')) } catch {}
        return {
          id: Number(r.id) || 0,
          zone: String(r.zone || zone),
          day: String(r.day_key || ''),
          text: String(r.text || ''),
          items: Array.isArray(items) ? items.slice(0, 20) : [],
          source: String(r.source || ''),
          at: Number(r.at) || 0
        }
      })
    }
  } catch (e) {
    // 老库还没有这张表：不算错误，返回空列表（前端会显示「还没有」）。
    const msg = String(e && e.message || e)
    if (/no such table/i.test(msg)) return { ok: true, zone, label: ZONE_LABELS[zone], rows: [], total: 0, missing: true }
    return { ok: false, message: '读见闻失败：' + msg, rows: [] }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

/** 删一条见闻（先导出去 trash）。她自己在聊天里也能删，那条会留一条 source=tool 的记录。 */
export function deleteZoneNote({ id } = {}) {
  const target = Number(id)
  if (!Number.isFinite(target) || target <= 0) return { ok: false, message: 'id 不对' }
  const info = memoryDbInfo()
  if (!info.exists) return { ok: false, message: '库还是空的' }
  let db = null
  try {
    db = openWrite(info.file)
    const row = safe(function () { return db.prepare('SELECT * FROM zone_note WHERE id = ?').get(target) }, null)
    if (!row) return { ok: false, message: '没找到这条见闻' }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(info.dir, TRASH_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, 'zone-' + stamp + '.json')
    fs.writeFileSync(out, JSON.stringify({ kind: 'zone_note', at: Date.now(), row }, null, 2), 'utf8')
    db.exec('BEGIN')
    try { db.prepare('DELETE FROM zone_note WHERE id = ?').run(target); db.exec('COMMIT') }
    catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
    return { ok: true, id: target, zone: String(row.zone || ''), exported: out }
  } catch (e) {
    return { ok: false, message: '删不动：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

/** 清空一个区（可只清某天）。整区清空前把剩下的都导出去 trash。 */
export function clearZoneNotes({ zone, day } = {}) {
  const z = zoneOfName(zone)
  if (!z) return { ok: false, message: 'zone 只能是 bili 或 qzone' }
  const info = memoryDbInfo()
  if (!info.exists) return { ok: false, message: '库还是空的' }
  const d = String(day || '').trim()
  let db = null
  try {
    db = openWrite(info.file)
    const rows = safe(function () {
      if (d) return db.prepare('SELECT * FROM zone_note WHERE zone = ? AND day_key = ?').all(z, d)
      return db.prepare('SELECT * FROM zone_note WHERE zone = ?').all(z)
    }, []) || []
    if (!rows.length) return { ok: true, zone: z, deleted: 0 }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(info.dir, TRASH_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, 'zone-clear-' + stamp + '.json')
    fs.writeFileSync(out, JSON.stringify({ kind: 'zone_note_clear', at: Date.now(), zone: z, day: d, rows }, null, 2), 'utf8')
    db.exec('BEGIN')
    try {
      if (d) db.prepare('DELETE FROM zone_note WHERE zone = ? AND day_key = ?').run(z, d)
      else db.prepare('DELETE FROM zone_note WHERE zone = ?').run(z)
      db.exec('COMMIT')
    } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
    return { ok: true, zone: z, deleted: rows.length, exported: out }
  } catch (e) {
    return { ok: false, message: '清不动：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

/* ── 重要事实（2026-11-13 主人加的）：生日/忌口/联系方式这类按人对号存 ───────────
 *
 * 表 fact 由 stellar/src/memory-db.js 建（SCHEMA_VERSION 3）。她那边只读，按说话人裁隐私；
 * 面板这边是主人手写的入口：新增、改、删。privacy=secret 的条目只在她本人私聊与面板可见。
 */
export const FACT_KINDS = {
  birthday: '生日', anniversary: '纪念日', like: '喜欢', dislike: '不喜欢',
  allergy: '忌口/过敏', contact: '联系方式', address: '地址', nickname: '称呼',
  promise: '约定', identity: '身份', note: '其他',
}
export const FACT_PRIVACY = { normal: '公开', private: '私密', secret: '机密' }
const FACT_PRIVACY_RANK = { normal: 1, private: 2, secret: 3 }

function normalizeFact(row, index) {
  const v = ownerView(index, row.owner_id)
  const kind = String(row.kind || 'note')
  const privacy = String(row.privacy || 'private')
  return {
    id: Number(row.id) || 0,
    ownerId: String(row.owner_id || ''),
    ownerLabel: v.label,
    relation: v.relation,
    kind: kind,
    kindLabel: FACT_KINDS[kind] || '其他',
    label: String(row.label || ''),
    text: String(row.text || ''),
    privacy: privacy,
    privacyLabel: FACT_PRIVACY[privacy] || '私密',
    weight: Number(row.weight) || 0,
    source: String(row.source || 'manual'),
    day: String(row.day_key || ''),
    at: Number(row.at) || 0,
    updatedAt: Number(row.updated_at) || 0
  }
}

export function listFacts(opts = {}) {
  const info = memoryDbInfo()
  const owner = String(opts.owner || '').trim()
  const privacy = String(opts.privacy || '').trim()
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(opts.limit) || 50))
  if (!info.exists) return { ok: true, rows: [], total: 0, empty: true, stats: factStats() }
  let db = null
  try {
    db = openRead(info.file)
    const where = []
    const args = []
    if (owner) { where.push('owner_id = ?'); args.push(owner) }
    if (FACT_PRIVACY_RANK[privacy]) { where.push('privacy = ?'); args.push(privacy) }
    const clause = where.length ? (' WHERE ' + where.join(' AND ')) : ''
    const sql = 'SELECT * FROM fact' + clause + ' ORDER BY weight DESC, updated_at DESC LIMIT ?'
    const rows = safe(function () { return db.prepare(sql).all(...args, limit) }, []) || []
    const total = countOf(db, 'SELECT COUNT(*) FROM fact' + clause, ...args)
    const index = peopleIndex()
    return { ok: true, total: total, rows: rows.map(function (r) { return normalizeFact(r, index) }), stats: factStats() }
  } catch (e) {
    const msg = String(e && e.message || e)
    if (/no such table/i.test(msg)) return { ok: true, rows: [], total: 0, missing: true, stats: factStats() }
    return { ok: false, message: '读事实失败：' + msg, rows: [] }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

export function factStats() {
  const info = memoryDbInfo()
  const out = { total: 0, secret: 0, today: 0, owners: 0 }
  if (!info.exists) return out
  let db = null
  try {
    db = openRead(info.file)
    out.total = countOf(db, 'SELECT COUNT(*) FROM fact')
    out.secret = countOf(db, "SELECT COUNT(*) FROM fact WHERE privacy = 'secret'")
    out.today = countOf(db, 'SELECT COUNT(*) FROM fact WHERE day_key = ?', dayOf())
    out.owners = countOf(db, 'SELECT COUNT(DISTINCT owner_id) FROM fact')
  } catch {} finally {
    if (db) safe(function () { db.close() }, null)
  }
  return out
}

export function saveFact(input = {}) {
  const info = memoryDbInfo()
  if (!info.exists) return { ok: false, message: '库还是空的' }
  const id = Number(input.id) || 0
  const text = String(input.text || '').trim().slice(0, 400)
  if (!text) return { ok: false, message: '内容不能为空' }
  const kind = FACT_KINDS[String(input.kind || 'note')] ? String(input.kind || 'note') : 'note'
  const privacy = FACT_PRIVACY_RANK[String(input.privacy || '')] ? String(input.privacy) : 'private'
  const weight = Math.max(1, Math.min(9, Number(input.weight) || (privacy === 'secret' ? 5 : 3)))
  let db = null
  try {
    db = openWrite(info.file)
    const now = Date.now()
    const dir = path.join(info.dir, TRASH_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    if (id) {
      const row = safe(function () { return db.prepare('SELECT * FROM fact WHERE id = ?').get(id) }, null)
      if (!row) return { ok: false, message: '没找到这条事实' }
      const label = String(input.label || row.label || '').trim().slice(0, 40)
      const owner = String(input.ownerId || row.owner_id || '').trim()
      fs.writeFileSync(path.join(dir, 'fact-edit-' + stamp + '.json'), JSON.stringify({ kind: 'fact_edit', at: now, before: row }, null, 2), 'utf8')
      db.exec('BEGIN')
      try {
        db.prepare('UPDATE fact SET owner_id = ?, kind = ?, label = ?, text = ?, privacy = ?, weight = ?, source = ?, updated_at = ? WHERE id = ?')
          .run(owner, kind, label, text, privacy, weight, 'manual', now, id)
        db.exec('COMMIT')
      } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
      return { ok: true, id: id, updated: true }
    }
    const owner = String(input.ownerId || '').trim()
    if (!owner) return { ok: false, message: '得说这是谁的（数字 QQ 或 group:群号）' }
    const label = String(input.label || '').trim().slice(0, 40) || (FACT_KINDS[kind] + '-' + dayOf())
    const exist = safe(function () { return db.prepare('SELECT * FROM fact WHERE owner_id = ? AND kind = ? AND label = ?').get(owner, kind, label) }, null)
    if (exist) {
      db.exec('BEGIN')
      try {
        db.prepare('UPDATE fact SET text = ?, privacy = ?, weight = MAX(weight, ?), source = ?, updated_at = ? WHERE id = ?')
          .run(text, privacy, weight, 'manual', now, exist.id)
        db.exec('COMMIT')
      } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
      return { ok: true, id: Number(exist.id), updated: true, merged: true }
    }
    db.exec('BEGIN')
    let newId = 0
    try {
      const r = db.prepare('INSERT INTO fact (owner_id, kind, label, text, privacy, weight, source, day_key, at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(owner, kind, label, text, privacy, weight, 'manual', dayOf(), now, now)
      newId = Number(r.lastInsertRowid) || 0
      db.exec('COMMIT')
    } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
    return { ok: true, id: newId, created: true }
  } catch (e) {
    const msg = String(e && e.message || e)
    if (/no such table/i.test(msg)) return { ok: false, message: '库还没有 fact 表：重启一次桥接就会建好' }
    if (/UNIQUE/i.test(msg)) return { ok: false, message: '跟上一条撞了：同一个人 + 同一个 label 只能有一条' }
    return { ok: false, message: '存不动：' + msg }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}

export function deleteFact({ id } = {}) {
  const target = Number(id)
  if (!Number.isFinite(target) || target <= 0) return { ok: false, message: 'id 不对' }
  const info = memoryDbInfo()
  if (!info.exists) return { ok: false, message: '库还是空的' }
  let db = null
  try {
    db = openWrite(info.file)
    const row = safe(function () { return db.prepare('SELECT * FROM fact WHERE id = ?').get(target) }, null)
    if (!row) return { ok: false, message: '没找到这条事实' }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(info.dir, TRASH_DIR)
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, 'fact-' + stamp + '.json')
    fs.writeFileSync(out, JSON.stringify({ kind: 'fact', at: Date.now(), row: row }, null, 2), 'utf8')
    db.exec('BEGIN')
    try { db.prepare('DELETE FROM fact WHERE id = ?').run(target); db.exec('COMMIT') }
    catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
    return { ok: true, id: target, exported: out }
  } catch (e) {
    return { ok: false, message: '删不动：' + String(e && e.message || e) }
  } finally {
    if (db) safe(function () { db.close() }, null)
  }
}
