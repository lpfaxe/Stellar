// web-images.mjs —— 「她自己上网找的图」的专用目录（owner 2026-11-11 22:25 要求）。
//
// 为什么不能塞进 image-pool：那个池子是**当天素材**（B站封面 / 空间截图），
// 拿去做配图；主人要的是「她自己找的、能单独删、能看记录」的另一格抽屉。
// 所以目录另开：<DSH_HOME>/stellar/web-images/<YYYY-MM-DD>/，两个约束：
//   · 每天清空（读取时顺手删旧日期目录，不需要定时器）；
//   · 每天最多 30 张（硬拦，不靠提醒）；
//   · 每次增删都往 index.jsonl 追加一行 → 控制台能显示「她自己删了哪张」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const MAX_PER_DAY = 30
const MAX_BYTES = 12 * 1024 * 1024

function home() { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }
export function rootDir() { return path.join(home(), 'stellar', 'web-images') }
export const WEB_IMAGES_ROOT = rootDir()

const pad = (n) => String(n).padStart(2, '0')
export function dayKey(now = Date.now()) {
  const d = new Date(now)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
export function dayDir(now = Date.now()) { return path.join(rootDir(), dayKey(now)) }
function indexFile(now = Date.now()) { return path.join(dayDir(now), 'index.jsonl') }

/** 只删「形如日期」且不是今天的目录 —— 别的文件（包括主人自己放的）一律不碰。 */
export function pruneDays({ now = Date.now(), keep } = {}) {
  const root = rootDir()
  const today = dayKey(now)
  const keepDay = keep || today
  let removed = 0
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue
    if (e.name === keepDay) continue
    try { fs.rmSync(path.join(root, e.name), { recursive: true, force: true }); removed += 1 } catch {}
  }
  return removed
}

function appendIndex(entry, now = Date.now()) {
  try {
    fs.mkdirSync(dayDir(now), { recursive: true })
    fs.appendFileSync(indexFile(now), JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8')
  } catch {}
}

/** 读今天的索引（只保留仍存在的文件）。 */
export function readIndex({ now = Date.now() } = {}) {
  const file = indexFile(now)
  let rows = []
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
  return rows
}

/**
 * 存一张（src 已经下载在临时目录）。
 * @returns {{ok:boolean, file?:string, name?:string, bytes?:number, reason?:string}}
 */
export function addWebImage(srcFile, meta = {}, { now = Date.now() } = {}) {
  pruneDays({ now })
  let stat = null
  try { stat = fs.statSync(srcFile) } catch { return { ok: false, reason: '源文件不见了' } }
  if (!stat.isFile()) return { ok: false, reason: '不是文件' }
  if (stat.size > MAX_BYTES) return { ok: false, reason: '图太大（超过 12MB）' }
  const dir = dayDir(now)
  fs.mkdirSync(dir, { recursive: true })
  const today = listWebImages({ now }).images
  if (today.length >= MAX_PER_DAY) {
    return { ok: false, reason: '今天的图已经放满 ' + MAX_PER_DAY + ' 张了（明天会清空）' }
  }
  const ext = (path.extname(srcFile) || '.jpg').toLowerCase()
  const base = String(meta.query || meta.origin || 'web').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 20) || 'web'
  const name = base + '-' + dayKey(now).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex') + ext
  const dest = path.join(dir, name)
  try { fs.copyFileSync(srcFile, dest) } catch (e) { return { ok: false, reason: '复制失败：' + (e?.message ?? e) } }
  appendIndex({
    kind: 'add',
    name,
    bytes: stat.size,
    source: String(meta.source || 'web'),
    query: String(meta.query || '').slice(0, 120),
    title: String(meta.title || '').slice(0, 200),
    page: String(meta.page || '').slice(0, 300),
    url: String(meta.url || '').slice(0, 500),
    by: String(meta.by || 'her'),
  }, now)
  return { ok: true, file: dest, name, bytes: stat.size }
}

/** 今天有哪些图（索引 + 目录里没被索引的兜底）。 */
export function listWebImages({ now = Date.now() } = {}) {
  pruneDays({ now })
  const day = dayKey(now)
  const dir = dayDir(now)
  const rows = readIndex({ now })
  const deleted = new Set(rows.filter((r) => r.kind === 'delete').map((r) => String(r.name)))
  const indexed = new Map()
  for (const r of rows) {
    if (r.kind !== 'add' || !r.name) continue
    indexed.set(String(r.name), r)
  }
  let files = []
  try { files = fs.readdirSync(dir).filter((n) => /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(n)) } catch {}
  const images = files.filter((n) => !deleted.has(n)).map((n) => {
    const meta = indexed.get(n) || {}
    let bytes = 0
    try { bytes = fs.statSync(path.join(dir, n)).size } catch {}
    return {
      name: n,
      bytes,
      title: String(meta.title || ''),
      query: String(meta.query || ''),
      source: String(meta.source || ''),
      page: String(meta.page || ''),
      url: String(meta.url || ''),
      at: Number(meta.at) || 0,
      by: String(meta.by || ''),
    }
  }).sort((a, b) => (b.at || 0) - (a.at || 0))
  const deletes = rows.filter((r) => r.kind === 'delete').slice(-20).reverse()
  return { day, dir, images, deletes, max: MAX_PER_DAY }
}

/** 删一张（她会删 → 留记录；主人删 → 同样留记录）。 */
export function deleteWebImage(name, { by = 'owner', now = Date.now() } = {}) {
  const safe = String(name || '')
  if (!/^[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp|gif|avif)$/i.test(safe)) return { ok: false, reason: '文件名不合法' }
  const dir = dayDir(now)
  const file = path.join(dir, safe)
  if (!fs.existsSync(file)) return { ok: false, reason: '这张已经不在了（可能跨天清空了）' }
  try { fs.rmSync(file, { force: true }) } catch (e) { return { ok: false, reason: '删除失败：' + (e?.message ?? e) } }
  appendIndex({ kind: 'delete', name: safe, by: String(by || 'owner') }, now)
  return { ok: true, name: safe }
}

/** 清空今天（图片删掉，索引留档 → 控制台还能看到「什么时候清过」）。 */
export function clearWebImages({ by = 'owner', now = Date.now() } = {}) {
  const day = dayKey(now)
  const list = listWebImages({ now }).images
  let removed = 0
  for (const it of list) {
    const r = deleteWebImage(it.name, { by, now })
    if (r.ok) removed += 1
  }
  appendIndex({ kind: 'clear', by: String(by || 'owner'), removed, day }, now)
  return { ok: true, day, removed }
}

export function webImageFile(name, { now = Date.now() } = {}) {
  const safe = String(name || '')
  if (!/^[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp|gif|avif)$/i.test(safe)) return null
  const file = path.join(dayDir(now), safe)
  try { return fs.statSync(file).isFile() ? file : null } catch { return null }
}