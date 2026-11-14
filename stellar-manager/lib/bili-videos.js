/* 她今天刷的 B站视频（控制台模块）：
 * 文字来自观看历史 ~/.dsh/stellar/characters/<id>/bili/watch-history.jsonl（append-only，按 bvid 归并），
 * 封面来自今日图片池 ~/.dsh/stellar/image-pool/<本地日期>/（bili-watch / debrief 入池，origin=bili-cover、key=bvid）。
 * 图片每天清空（池子按日期分目录，跨天自动删），文字保留 → 卡片只显示标题/UP/时长，图没了就显示占位。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CFG_FILE, SURF } from './paths.js'

const CHARS = path.join(SURF, 'characters')
const POOL = path.join(SURF, 'image-pool')

export function videosDayKey(now = new Date()) {
  return now.toLocaleDateString('sv-SE')
}

// 今天打算看几条（night.videoTargetPerDay）——只用来画进度环，读不到就退回 40。
function videoTarget() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))
    const n = Number(cfg && cfg.night && cfg.night.videoTargetPerDay)
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 40
  } catch { return 40 }
}

// 角色目录可能有多个（每个角色一份 bili 状态）：取最近写过的那个，和 panel 其它模块口径一致。
function characterWatchFile() {
  let best = null
  try {
    for (const id of fs.readdirSync(CHARS)) {
      const file = path.join(CHARS, id, 'bili', 'watch-history.jsonl')
      try {
        const st = fs.statSync(file)
        if (!st.isFile()) continue
        if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs }
      } catch {}
    }
  } catch {}
  return best ? best.file : ''
}

function readRows(file) {
  const rows = []
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row && row.bvid) rows.push(row)
      } catch {}
    }
  } catch {}
  return rows
}

function localDay(value) {
  const t = new Date(value)
  return Number.isFinite(t.getTime()) ? t.toLocaleDateString('sv-SE') : ''
}

function poolDayDir(day) {
  return path.join(POOL, day)
}

// 今日池子里 origin=bili-cover 的图 → 按 key(bvid) 索引
function coverIndex(day) {
  const dir = poolDayDir(day)
  const map = new Map()
  let text = ''
  try { text = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8') } catch { return map }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row = null
    try { row = JSON.parse(line) } catch { continue }
    if (!row || row.origin !== 'bili-cover') continue
    const key = String(row.key || '')
    const file = String(row.file || '')
    if (!key || !file) continue
    try { if (!fs.statSync(file).isFile()) continue } catch { continue }
    map.set(key, { file, name: String(row.name || path.basename(file)), caption: String(row.caption || '') })
  }
  return map
}

const COVER_NAME_RE = /^[A-Za-z0-9_.\-]+\.(jpg|jpeg|png|webp|gif)$/i

/** 封面文件（只允许今日池子目录里的图片名，防穿越）。 */
export function biliCoverFile(day, name) {
  const safe = String(name || '')
  if (!COVER_NAME_RE.test(safe)) return null
  const file = path.join(poolDayDir(day), safe)
  try { return fs.statSync(file).isFile() ? file : null } catch { return null }
}

const MODE_LABEL = { meta: '扫了标题', full: '点进去看了', frames: '看了画面', memory: '看过' }

export function buildBiliVideos({ day = videosDayKey() } = {}) {
  const file = characterWatchFile()
  const rows = file ? readRows(file) : []
  const covers = coverIndex(day)
  const byBvid = new Map()
  for (const row of rows) {
    if (localDay(row.at) !== day) continue
    const bvid = String(row.bvid || '')
    if (!bvid) continue
    const prev = byBvid.get(bvid)
    const at = String(row.at || '')
    const rank = { meta: 1, memory: 2, frames: 3, full: 4 }
    const score = (rank[row.mode] || 1) * 1e13 + new Date(at).getTime()
    if (prev && prev._score >= score) { prev.visits += 1; continue }
    byBvid.set(bvid, { ...row, _score: score, visits: prev ? prev.visits + 1 : 1 })
  }
  const target = videoTarget()
  const items = [...byBvid.values()].sort((a, b) => new Date(b.at) - new Date(a.at)).map((row) => {
    const cover = covers.get(String(row.bvid))
    return {
      bvid: String(row.bvid)
      , aid: String(row.aid || '')
      , title: String(row.title || '')
      , up: String(row.up || '')
      , duration: Number(row.duration) || 0
      , mode: String(row.mode || 'meta')
      , modeLabel: MODE_LABEL[row.mode] || '看过'
      , at: String(row.at || '')
      , visits: row.visits || 1
      , cover: cover ? '/api/bili-videos/cover?name=' + encodeURIComponent(cover.name) : ''
      , hasCover: Boolean(cover)
    }
  })
  return {
    ok: true,
    day,
    file,
    items,
    counts: {
      total: items.length,
      covers: items.filter((e) => e.hasCover).length,
      full: items.filter((e) => e.mode === 'full' || e.mode === 'frames').length,
      target,
    },
  }
}

/** 手动删掉一条记录（只删当天的这些行；历史文件里别的天不动）。 */
export function deleteBiliVideo({ bvid, day = videosDayKey() } = {}) {
  const want = String(bvid || '')
  if (!/^BV[0-9A-Za-z]{10}$/.test(want)) return { ok: false, message: 'bvid 不合法' }
  const file = characterWatchFile()
  if (!file) return { ok: false, message: '找不到观看历史文件' }
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { return { ok: false, message: '读不到观看历史：' + String((e && e.message) || e) } }
  const kept = []
  let removed = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row = null
    try { row = JSON.parse(line) } catch { kept.push(line); continue }
    const hit = row && String(row.bvid) === want && localDay(row.at) === day
    if (hit) { removed += 1; continue }
    kept.push(line)
  }
  if (!removed) return { ok: false, message: '今天没有这条记录（可能已经被删或跨天了）' }
  try {
    fs.copyFileSync(file, file + '.bak-' + Date.now().toString(36))
    fs.writeFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8')
  } catch (e) {
    return { ok: false, message: '写回失败：' + String((e && e.message) || e) }
  }
  // 顺手把这支视频的封面也删掉（记录都没了，图留着没意义）
  const covers = coverIndex(day)
  const cover = covers.get(want)
  if (cover) { try { fs.rmSync(cover.file, { force: true }) } catch {} }
  return { ok: true, removed, day }
}

/** 清空今天的 B站封面图，标题等文字保留。 */
export function clearBiliCovers({ day = videosDayKey() } = {}) {
  const covers = coverIndex(day)
  let removed = 0
  for (const [, cover] of covers) {
    try { fs.rmSync(cover.file, { force: true }); removed += 1 } catch {}
  }
  return { ok: true, day, removed }
}