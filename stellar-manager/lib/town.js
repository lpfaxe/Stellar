/* 鱼缸小镇（只读页）：她自己的日子 —— 最近三天的事件、印象、每天一句，外加一份状态快照。
 *
 * 两个数据源，都由调度器那一侧产出：
 *   1) state/town/status.json —— 在线/余额/关系/今天动过几次/预算（调度器每 10 分钟采集时顺手写）
 *   2) state/town/town.db      —— town_note（3 天 TTL）/ town_impression（30 天）/ town_day（长期）
 * 这里**只读**：不开写连接、不联网、不碰访问码。想看/改「进不进小镇」用能力开关（town.enabled）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { SURF, REPO, DSH_HOME } from './paths.js'

export const TOWN_DIR = path.join(SURF, 'state', 'town')
const STATUS_FILE = path.join(TOWN_DIR, 'status.json')
const GUARD_FILE = path.join(TOWN_DIR, 'guard.json')
const DB_FILE = path.join(TOWN_DIR, 'town.db')

// 官方插件（dsh-fishbowl-town）那点事都收在仓库的 src/town-plugin.js 里 —— 面板不自己再写一份，
// 免得两处判断不一致。仓库文件不在就当没有（面板照样能看，只是开关只能写我们这一半）。
let pluginModPromise = null
function pluginModule() {
  if (!pluginModPromise) {
    const file = path.join(REPO, 'src', 'town-plugin.js')
    pluginModPromise = import(pathToFileURL(file).href)
      .then((mod) => {
        if (!mod || typeof mod.pluginStatus !== 'function') throw new Error('src/town-plugin.js 里没有 pluginStatus')
        return mod
      })
      .catch(() => { pluginModPromise = null; return null })
  }
  return pluginModPromise
}

/** 插件在场不在场（读文件，不联网、不看访问码）。仓库文件缺失就回 null。 */
export async function townPluginStatus() {
  const mod = await pluginModule()
  if (!mod) return null
  try { return mod.pluginStatus({ dshHome: DSH_HOME }) } catch { return null }
}

/** 面板那个「进镇」开关的另一半：插件里这条鱼开/关。 */
export async function setTownPluginEnabled(on) {
  const mod = await pluginModule()
  if (!mod) return { ok: false, skipped: true, reason: '仓库里没有 src/town-plugin.js' }
  try { return mod.setPluginEnabled(DSH_HOME, Boolean(on)) } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

function readJsonSafe(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return dflt }
}

function openRead(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try { db.exec('PRAGMA busy_timeout=2000') } catch {}
  return db
}

/** 最近三天的事件（TTL 由调度器删，这里只按天倒序取）。 */
export function listTownNotes({ limit = 80 } = {}) {
  if (!fs.existsSync(DB_FILE)) return { ok: false, notes: [], reason: '还没有 town.db（她还没进过镇，或者小镇关着）' }
  let db = null
  try {
    db = openRead(DB_FILE)
    const rows = db.prepare('SELECT at, day, kind, who, text, quoted, visit_id FROM town_note ORDER BY at DESC LIMIT ?').all(Math.max(1, Math.min(200, Number(limit) || 80)))
    return {
      ok: true,
      notes: rows.map((r) => ({
        at: Number(r.at) || 0,
        day: String(r.day || ''),
        kind: String(r.kind || ''),
        who: String(r.who || ''),
        text: String(r.text || ''),
        quoted: Number(r.quoted) === 1,
        visitId: String(r.visit_id || ''),
      })),
    }
  } catch (e) {
    return { ok: false, notes: [], reason: String(e && e.message || e) }
  } finally { try { db?.close() } catch {} }
}

export function listTownImpressions() {
  if (!fs.existsSync(DB_FILE)) return []
  let db = null
  try {
    db = openRead(DB_FILE)
    const rows = db.prepare('SELECT fish_id, name, line, updated_at FROM town_impression ORDER BY updated_at DESC LIMIT 20').all()
    return rows.map((r) => ({ fishId: String(r.fish_id || ''), name: String(r.name || ''), line: String(r.line || ''), updatedAt: Number(r.updated_at) || 0 }))
  } catch { return [] } finally { try { db?.close() } catch {} }
}

export function listTownDays({ limit = 14 } = {}) {
  if (!fs.existsSync(DB_FILE)) return []
  let db = null
  try {
    db = openRead(DB_FILE)
    const rows = db.prepare('SELECT day, line, at FROM town_day ORDER BY day DESC LIMIT ?').all(Math.max(1, Math.min(60, Number(limit) || 14)))
    return rows.map((r) => ({ day: String(r.day || ''), line: String(r.line || ''), at: Number(r.at) || 0 }))
  } catch { return [] } finally { try { db?.close() } catch {} }
}

function countTable(db, sql) {
  try { return Number(db.prepare(sql).get().c) || 0 } catch { return 0 }
}

/** 面板用的整页数据：一次读完，缺哪块都不抛。 */
export function buildTown() {
  const snapshot = readJsonSafe(STATUS_FILE, null)
  const notes = listTownNotes({ limit: 80 })
  const impressions = listTownImpressions()
  const days = listTownDays({ limit: 14 })
  let counts = { notes: 0, impressions: impressions.length, days: days.length }
  if (fs.existsSync(DB_FILE)) {
    let db = null
    try {
      db = openRead(DB_FILE)
      counts = {
        notes: countTable(db, 'SELECT COUNT(*) AS c FROM town_note'),
        impressions: countTable(db, 'SELECT COUNT(*) AS c FROM town_impression'),
        days: countTable(db, 'SELECT COUNT(*) AS c FROM town_day'),
      }
    } catch {} finally { try { db?.close() } catch {} }
  }
  return {
    ok: true,
    dir: TOWN_DIR,
    hasDb: fs.existsSync(DB_FILE),
    hasSnapshot: Boolean(snapshot),
    snapshot,
    // 超支熔断的记录（src/town-guard.js 写的）；快照里也有一份，文件更新一些
    guard: readJsonSafe(GUARD_FILE, null) || (snapshot && snapshot.guard) || null,
    counts,
    notes: notes.notes,
    notesReason: notes.ok ? '' : notes.reason,
    impressions,
    days,
    at: Date.now(),
  }
}
