// town-kit.js —— 日报 / 说说要的那几段「小镇素材」（2026-11-25）。
//
// 为什么单独一个文件：素材包（plugins/stellar/tools/lib/material-kit.mjs）是通用聚合器，
// 小镇只是它的一个来源；而「小镇能不能整块删掉」的契约（scripts/town-decoupling-lib.mjs）
// 要求小镇逻辑只能住在 town-* 文件里。所以读 town.db / 小镇相册的代码放这里，
// material-kit 只留两行接线（import + 调用）。删小镇时这个文件一起删。
//
// 只读：不写库、不动相册索引。读不到就返回 warnings，让调用方降级，不能把日报拖挂。
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const LOOKBACK_DAYS = 3
const ALBUM_LIMIT = 8
const RECALL_MAX = 1200

function msg(e) {
  return e && e.message ? e.message : String(e)
}

// 三个模块都动态 import：顶层 import node:sqlite 会让测试沙箱缺 DatabaseSync。
let storeMod = null
let pureMod = null
let albumMod = null
function loadModule(kind, file, onLoad) {
  const holder = { store: () => storeMod, pure: () => pureMod, album: () => albumMod }
  if (holder[kind]()) return Promise.resolve(holder[kind]())
  const p = import(pathToFileURL(file).href).then((m) => { onLoad(m); return m }).catch((error) => { onLoad(null); throw error })
  onLoad(null, p)
  return p
}

function loadStore() {
  return loadModule('store', path.join(SRC_DIR, 'town-store.js'), (m, pending) => {
    if (m) storeMod = m
    else if (!pending) storeMod = null
  })
}

function loadPure() {
  return loadModule('pure', path.join(SRC_DIR, 'town-memory-pure.js'), (m, pending) => {
    if (m) pureMod = m
    else if (!pending) pureMod = null
  })
}

function loadAlbum() {
  return loadModule('album', path.join(SRC_DIR, 'town-album.js'), (m, pending) => {
    if (m) albumMod = m
    else if (!pending) albumMod = null
  })
}

function localDayKey(at = Date.now()) {
  return new Date(at).toLocaleDateString('sv-SE')
}

function localShift(day, n) {
  const base = new Date(String(day) + 'T12:00:00')
  const t = Number.isNaN(base.getTime()) ? Date.now() : base.getTime()
  return new Date(t + n * 86400000).toLocaleDateString('sv-SE')
}

/** 小镇相册目录（唯一路径口径；别的模块判断「这张图是不是相册里的」就调它）。 */
export function townAlbumRoot(dshHome = DSH_HOME) {
  return path.join(dshHome, 'stellar', 'state', 'town', 'album')
}

/** 相册索引（读不到就是还没同步过）。 */
export async function listTownAlbum(dshHome = DSH_HOME, { limit = ALBUM_LIMIT } = {}) {
  const album = await loadAlbum()
  return album.listAlbum(dshHome, { limit })
}

/**
 * 小镇存档 + 相册索引。
 * · 存档只留最近 `days` 个自然日（town.db 的 TTL 是 3 天，更早的读不到是正常的）；
 * · recall 是 renderRecall 排好版的现成正文（人看 / 提示词共用一份口径）。
 */
export async function collectTownKit({ day = '', days = LOOKBACK_DAYS, dshHome = DSH_HOME, maxChars = RECALL_MAX } = {}) {
  const out = {
    recall: '', notes: 0, impressions: [], dayLines: [],
    album: { ok: false, total: 0, dir: '', items: [] }, warnings: [],
  }
  let store = null
  let pure = null
  try { store = await loadStore() } catch (e) { out.warnings.push('小镇存档模块加载失败：' + msg(e)) }
  try { pure = await loadPure() } catch (e) { out.warnings.push('小镇存档排版模块加载失败：' + msg(e)) }

  const today = String(day || (pure && typeof pure.dayKey === 'function' ? pure.dayKey(Date.now()) : localDayKey()))
  const shift = pure && typeof pure.shiftDay === 'function' ? pure.shiftDay : localShift
  const window = []
  const count = Math.max(1, Math.min(7, Number(days) || LOOKBACK_DAYS))
  for (let i = 0; i < count; i += 1) {
    const d = shift(today, -i)
    if (d) window.push(d)
  }

  if (store) {
    try {
      const db = store.openTownDb({ dir: store.townDirOf(dshHome) })
      const notes = store.listNotes({ days: window, limit: 60, db }) || []
      out.notes = notes.length
      out.impressions = store.listImpressions({ limit: 6, db }) || []
      out.dayLines = store.listDayLines({ limit: 3, db }) || []
      if (pure && typeof pure.renderRecall === 'function') {
        out.recall = pure.renderRecall({ notes, impressions: out.impressions, days: window, today, maxChars })
      }
    } catch (e) {
      out.warnings.push('小镇存档读取失败：' + msg(e))
    } finally {
      try { store.closeTownDb() } catch { /* 连接共享，关不掉不算错 */ }
    }
  }

  try {
    const a = await listTownAlbum(dshHome)
    if (a && a.ok) out.album = { ok: true, total: a.total, dir: a.dir, items: a.items || [] }
    else out.warnings.push('小镇相册还没同步过（目录不存在）')
  } catch (e) {
    out.warnings.push('小镇相册读取失败：' + msg(e))
  }
  return out
}
