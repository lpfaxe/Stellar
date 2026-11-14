// 面板侧「她自己上网找的图」：只读今天目录 + 删除/清空两个写操作。
// 目录与索引由插件侧 tools/lib/web-images.mjs 定义（~/.dsh/stellar/web-images/<日期>/）。
// 这里不重复实现 30 张上限之类的规则 —— 面板只展示和删，判定回插件那份。
import fs from 'node:fs'
import path from 'node:path'
import { SURF } from './paths.js'

const ROOT = path.join(SURF, 'web-images')
export const WEB_IMAGES_MAX = 30
const NAME_RE = /^[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp|gif|avif)$/i

const pad = (n) => String(n).padStart(2, '0')
export function webDay(now = Date.now()) {
  const d = new Date(now)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

export function webDir(day = webDay()) { return path.join(ROOT, day) }
export function webImageFile(name, day = webDay()) {
  const safe = String(name || '')
  if (!NAME_RE.test(safe)) return null
  const file = path.join(webDir(day), safe)
  try { return fs.statSync(file).isFile() ? file : null } catch { return null }
}

function readIndex(day) {
  try {
    return fs.readFileSync(path.join(webDir(day), 'index.jsonl'), 'utf8')
      .split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

export function buildWebImages({ day = webDay() } = {}) {
  const dir = webDir(day)
  const rows = readIndex(day)
  const deleted = new Set(rows.filter((r) => r.kind === 'delete').map((r) => String(r.name || '')))
  const meta = new Map()
  for (const r of rows) if (r.kind === 'add' && r.name) meta.set(String(r.name), r)
  let files = []
  try { files = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)) } catch {}
  const items = files.filter((n) => !deleted.has(n)).map((n) => {
    const m = meta.get(n) || {}
    let bytes = 0
    try { bytes = fs.statSync(path.join(dir, n)).size } catch {}
    return {
      name: n,
      bytes,
      title: String(m.title || ''),
      query: String(m.query || ''),
      source: String(m.source || ''),
      page: String(m.url || ''),
      at: Number(m.at) || 0,
      by: String(m.by || ''),
      src: '/api/web-images/file?name=' + encodeURIComponent(n),
    }
  }).sort((a, b) => (b.at || 0) - (a.at || 0))
  const deletes = rows.filter((r) => r.kind === 'delete').slice(-30).reverse().map((r) => ({
    name: String(r.name || ''), at: Number(r.at) || 0, by: String(r.by || ''),
  }))
  const clears = rows.filter((r) => r.kind === 'clear').slice(-10).reverse().map((r) => ({
    at: Number(r.at) || 0, by: String(r.by || ''), removed: Number(r.removed) || 0,
  }))
  return {
    ok: true,
    day,
    dir,
    max: WEB_IMAGES_MAX,
    count: items.length,
    bytes: items.reduce((sum, it) => sum + (Number(it.bytes) || 0), 0),
    items,
    deletes,
    clears,
  }
}

function appendIndex(day, entry) {
  try {
    fs.mkdirSync(webDir(day), { recursive: true })
    fs.appendFileSync(path.join(webDir(day), 'index.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8')
  } catch {}
}

export function deleteWebImage(name, { day = webDay(), by = 'owner' } = {}) {
  const file = webImageFile(name, day)
  if (!file) return { ok: false, message: '这张已经不在了（可能跨天清空了）' }
  try { fs.rmSync(file, { force: true }) } catch (e) { return { ok: false, message: '删除失败：' + String(e?.message ?? e) } }
  appendIndex(day, { kind: 'delete', name: String(name), by: String(by || 'owner') })
  return { ok: true, name: String(name), day }
}

export function clearWebImages({ day = webDay(), by = 'owner' } = {}) {
  const data = buildWebImages({ day })
  let removed = 0
  for (const it of data.items) {
    const r = deleteWebImage(it.name, { day, by })
    if (r.ok) removed += 1
  }
  appendIndex(day, { kind: 'clear', by: String(by || 'owner'), removed, day })
  return { ok: true, day, removed }
}