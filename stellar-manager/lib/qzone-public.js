/* 今天刷的公开动态（好友爱看）：只读 stellar/tools/commands/qzone.mjs 写的账本
 * 文件：STATE_DIR/qzone-public-day.json（只存当天，跨天由脚本重置）
 * 之前刷的旧记录没有账本，退回读 qzone-log.jsonl 的 public-like / public-comment 补一条「动作」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SURF } from './paths.js'
import { readJson } from './util.js'

const DAY_FILE = path.join(SURF, 'state', 'qzone-public-day.json')
const LOG_FILE = path.join(SURF, 'state', 'qzone-log.jsonl')
const CFG_FILE = path.join(SURF, 'bili.config.json')
// 她看动态时截下来的图：<SURF>/state/qzone-public-shots/<本地日期>/<feedid>-<n>.jpg
const SHOTS_ROOT = path.join(SURF, 'state', 'qzone-public-shots')

function todayKey() {
  return new Date().toLocaleDateString('sv-SE')
}

function readLogRows() {
  const rows = []
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row = null
      try { row = JSON.parse(line) } catch { continue }
      if (row) rows.push(row)
    }
  } catch {}
  return rows
}

function limits() {
  try {
    const cfg = readJson(CFG_FILE, {})
    const pub = cfg.qzone && cfg.qzone.public ? cfg.qzone.public : {}
    return {
      seenTarget: Math.max(1, Math.min(30, Number(pub.seenTarget ?? 10) || 10)),
      likeLimit: Number(pub.likeLimit ?? 3) || 3,
      commentLimit: Number(pub.commentLimit ?? 3) || 3,
      time: String(pub.time ?? '20:30'),
      enabled: pub.enabled !== false,
    }
  } catch {
    return { seenTarget: 10, likeLimit: 3, commentLimit: 3, time: '20:30', enabled: true }
  }
}

function shotDir(day) {
  return path.join(SHOTS_ROOT, day)
}

function shotExists(day, name) {
  if (!/^[0-9a-f]{6,24}-\d{1,2}\.(jpg|jpeg|png|webp|gif)$/i.test(String(name || ''))) return false
  try { return fs.statSync(path.join(shotDir(day), name)).isFile() } catch { return false }
}

export function qzoneShotFile(day, name) {
  if (!shotExists(day, name)) return null
  return path.join(shotDir(day), name)
}

// 「每天清空截图，之后只留文字」：删今日目录里的图，账本（文字）一个字都不动。
export function clearQzoneShots({ day = todayKey() } = {}) {
  let removed = 0
  let dirs = 0
  try {
    const dir = shotDir(day)
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(name)) continue
      try { fs.rmSync(path.join(dir, name), { force: true }); removed += 1 } catch {}
    }
    dirs = 1
  } catch {}
  return { ok: true, day, removed, dirs }
}

export function buildQzonePublic() {
  const day = todayKey()
  const raw = readJson(DAY_FILE, {})
  const fresh = raw && raw.day === day && Array.isArray(raw.items)
  const items = fresh ? raw.items.filter((e) => e && e.id) : []

  // 账本里没有的动作（账本上线前记的，或写账本失败时）从活动日志补一条，至少别让她白刷
  const rows = readLogRows().filter((e) => {
    if (!e || !e.feedId) return false
    if (e.kind !== 'public-like' && e.kind !== 'public-comment') return false
    const at = String(e.at || '')
    return at && new Date(at).toLocaleDateString('sv-SE') === day
  })
  const seen = new Set(items.map((e) => String(e.id)))
  for (const e of rows) {
    const id = String(e.feedId)
    const hit = items.find((x) => String(x.id).startsWith(id.slice(0, 8)))
    if (hit) {
      if (e.kind === 'public-like' && !hit.likeAt) hit.likeAt = String(e.at || '')
      if (e.kind === 'public-comment') {
        if (!hit.commentAt) hit.commentAt = String(e.at || '')
        if (!hit.commentText && e.text) hit.commentText = String(e.text)
      }
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    items.push({
      id,
      short: id.slice(0, 8),
      nick: String(e.nick || ''),
      text: String(e.text || ''),
      pictures: 0,
      likes: 0,
      comments: 0,
      liked: e.kind === 'public-like',
      order: 99,
      score: null,
      note: '',
      likeAt: e.kind === 'public-like' ? String(e.at || '') : '',
      commentText: e.kind === 'public-comment' ? String(e.text || '') : '',
      commentAt: e.kind === 'public-comment' ? String(e.at || '') : '',
      fromLog: true,
    })
  }

  // 截图 → 前端可用的 URL（只认当天目录里真实存在的文件；跨天目录早被脚本删了）
  let shotTotal = 0
  for (const e of items) {
    const names = Array.isArray(e.shots) ? e.shots.filter((n) => shotExists(day, n)) : []
    e.scanShots = names.map((n) => '/api/qzone-public/shot?name=' + encodeURIComponent(n))
    e.shotCount = names.length
    shotTotal += names.length
  }

  const lim = limits()
  const scored = items.filter((e) => e.score != null)
  const liked = items.filter((e) => e.likeAt)
  const commented = items.filter((e) => e.commentAt)
  const avg = scored.length ? Math.round(scored.reduce((s, e) => s + Number(e.score || 0), 0) / scored.length) : 0

  return {
    ok: true,
    day,
    file: DAY_FILE,
    hasLedger: fresh,
    limits: lim,
    items,
    counts: {
      seen: items.length,
      scored: scored.length,
      liked: liked.length,
      commented: commented.length,
      avgScore: avg,
      topScore: scored.length ? Math.max(...scored.map((e) => Number(e.score) || 0)) : 0,
      shots: shotTotal,
    },
  }
}
