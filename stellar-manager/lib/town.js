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

// ── 相册镜像（2026-11-22）─────────────────────────────────────────────
// 照片是她在小镇拍的/请人画的，调度器采集时镜像到 state/town/album/（详见 stellar/src/town-album.js）。
// 面板只读这一份：不联网、不看访问码。可见性按会话范围分：
//   本机 → 原图；局域网 → 只有缩略图（原图是她的照片，别在共享 WiFi 上摊开）；公网 → 一律 403。
export const ALBUM_DIR = path.join(TOWN_DIR, 'album')
const ALBUM_INDEX = path.join(ALBUM_DIR, 'index.json')
const ALBUM_FILE_RE = /^al_[0-9a-f]{16}(?:\.thumb)?\.(?:png|jpg|webp|gif)$/

function readAlbumIndex() {
  const data = readJsonSafe(ALBUM_INDEX, null)
  const items = (data && typeof data.items === 'object' && data.items) ? data.items : {}
  return { at: String((data && data.at) || ''), items }
}

/** 相册清单（只列文件真的还在的条目）。 */
export function listTownAlbum() {
  const idx = readAlbumIndex()
  const items = []
  let bytes = 0
  for (const [id, item] of Object.entries(idx.items)) {
    if (!item || typeof item !== 'object') continue
    const file = String(item.file || '')
    if (!ALBUM_FILE_RE.test(file)) continue
    const abs = path.join(ALBUM_DIR, file)
    let size = 0
    try { size = fs.statSync(abs).size } catch { continue }
    if (!size) continue
    const thumb = String(item.thumb || '')
    const hasThumb = Boolean(thumb) && ALBUM_FILE_RE.test(thumb) && fs.existsSync(path.join(ALBUM_DIR, thumb))
    bytes += size
    items.push({
      id: String(id),
      kind: String(item.kind || 'photo'),
      what: String(item.what || ''),
      with: Array.isArray(item.with) ? item.with.map(String) : [],
      occasion: String(item.occasion || ''),
      created: String(item.created || ''),
      file,
      thumb: hasThumb ? thumb : (item.thumbOnly ? file : ''),
      bytes: size,
      thumbOnly: !!item.thumbOnly,
    })
  }
  items.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
  return { ok: true, dir: ALBUM_DIR, total: items.length, bytes, at: idx.at, items }
}

/** 文件名 → 绝对路径（只认相册目录里、名字过正则的文件）。 */
export function townAlbumFile(name) {
  const base = path.basename(String(name || ''))
  if (!ALBUM_FILE_RE.test(base)) return ''
  const abs = path.join(ALBUM_DIR, base)
  try {
    const real = fs.realpathSync(abs)
    if (!real.startsWith(fs.realpathSync(ALBUM_DIR) + path.sep)) return ''
    return fs.statSync(real).isFile() ? real : ''
  } catch { return '' }
}

/** 局域网会话能看的那一版：有缩略图给缩略图，缩略图本身就是文件时给文件。 */
export function townAlbumThumb(name) {
  const base = path.basename(String(name || ''))
  if (/\.thumb\./.test(base)) return townAlbumFile(base)
  const idx = readAlbumIndex()
  for (const item of Object.values(idx.items)) {
    if (!item || typeof item !== 'object') continue
    if (String(item.file || '') !== base) continue
    if (item.thumbOnly) return townAlbumFile(base)
    return townAlbumFile(String(item.thumb || ''))
  }
  return ''
}

function countTable(db, sql) {
  try { return Number(db.prepare(sql).get().c) || 0 } catch { return 0 }
}

/** 「她人在不在小镇」——只读 status.json（调度器采集时顺手写），不联网、不碰访问码。
 *
 * 快照超过 15 分钟就当作「不知道」：采集 tick 是 10 分钟一次（town-jobs.js），15 分钟＝
 * 允许丢一轮。这样面板不会在显示一个两小时前的状态、也不会在她真在镇里时还说「休眠中」。 */
export function readTownPresence({ now = Date.now(), freshMs = 15 * 60_000 } = {}) {
  const snap = readJsonSafe(STATUS_FILE, null)
  if (!snap) return { inTown: false, at: 0, ageMs: Infinity, fresh: false, tables: 0, townName: '', todayCNY: 0, outsideState: '', detail: '' }
  const outsideState = String((snap.status && snap.status.outsideState) || snap.outsideState || snap.outside_state || '')
  const at = Number(snap.at || 0) || 0
  const ageMs = at ? Math.max(0, now - at) : Infinity
  const inTown = outsideState === 'in_town'
  const tables = Number((snap.lobby && snap.lobby.tables) || 0) || 0
  const townName = String((snap.status && (snap.status.townName || snap.status.name)) || snap.townName || '')
  const todayCNY = Number((snap.spending && snap.spending.today) || 0) || 0
  const mins = ageMs === Infinity ? 0 : Math.max(1, Math.round(ageMs / 60000))
  const detail = inTown
    ? '在 ' + (townName || '小镇') + ' 里 · 大厅 ' + tables + ' 桌' +
      (todayCNY > 0 ? ' · 今天在小镇花了 ¥' + todayCNY.toFixed(2) : '') +
      (mins ? ' · 快照 ' + mins + ' 分钟前' : '')
    : ''
  return { inTown, at, ageMs, fresh: ageMs <= freshMs, tables, townName, todayCNY, outsideState, detail }
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
