// preload.mjs —— 两阶段找图：先预加载一批候选，再从联系表里挑最终要存的几张。
//
// 为什么分两阶段：一次搜 100 条候选、下载 20–30 张原图，直接全存会吃掉每天
// 30 张的额度（也浪费磁盘）；但只按标题排序又看不出「图里到底是什么」。
// 折中：候选图先落在 <DSH_HOME>/stellar/webimg-preload/<session>/，拼一张
// 带编号的联系表给模型看；模型用 pick 选 1–5 张，才真正写进 web-images。
//
// 约束：
//   · 预加载目录 TTL 1 小时、最多 10 个，create 前清理；
//   · 联系表用 System.Drawing 拼（不引新依赖），4 列，每格 360×300；
//   · 只有 pick 成功才消耗每天 30 张额度；预加载失败不写 web-images。
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { addWebImage, dayDir, listWebImages, MAX_PER_DAY } from '../web-images.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const SCRIPT = path.join(HERE, 'contact-sheet.ps1')
export const PRELOAD_MIN = 30
export const PRELOAD_MAX = 100
export const PRELOAD_TTL_MS = 60 * 60 * 1000
export const PRELOAD_MAX_DIRS = 10
export const PICK_MAX = 5

export function preloadRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'stellar', 'webimg-preload')
}

export function clampPreload(value) {
  const n = Math.floor(Number(value) || 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.max(PRELOAD_MIN, Math.min(PRELOAD_MAX, n))
}

function safeSession(session) {
  return /^p-[A-Za-z0-9-]{8,80}$/.test(String(session || '')) ? String(session) : ''
}

/** 清过期 / 超量的预加载目录；keep 是本次刚建的，不删。 */
export function cleanupPreloads({ now = Date.now(), keep = '' } = {}) {
  const root = preloadRoot()
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return { removed: 0, kept: 0 } }
  const dirs = entries.filter((e) => e.isDirectory() && safeSession(e.name)).map((e) => {
    const dir = path.join(root, e.name)
    let mtime = 0
    try { mtime = fs.statSync(dir).mtimeMs } catch {}
    return { name: e.name, dir, mtime }
  }).sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (let i = 0; i < dirs.length; i += 1) {
    const d = dirs[i]
    if (d.name === keep) continue
    const expired = now - d.mtime > PRELOAD_TTL_MS
    const overflow = i >= PRELOAD_MAX_DIRS
    if (!expired && !overflow) continue
    try { fs.rmSync(d.dir, { recursive: true, force: true }); removed += 1 } catch {}
  }
  return { removed, kept: Math.max(0, dirs.length - removed) }
}

function writeManifest(dir, manifest) {
  const file = path.join(dir, 'manifest.json')
  const tmp = file + '.tmp-' + process.pid
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest, null, 2), 'utf8')
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
  return file
}

export function readPreload(session) {
  const name = safeSession(session)
  if (!name) return null
  const dir = path.join(preloadRoot(), name)
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    if (!manifest || !Array.isArray(manifest.items)) return null
    return { dir, manifest }
  } catch { return null }
}

function buildContactSheet(dir, items) {
  if (!fs.existsSync(PS) || !fs.existsSync(SCRIPT)) return { ok: false, file: '', error: '没有可用的 PowerShell' }
  const manifestFile = path.join(dir, 'sheet.json')
  const outFile = path.join(dir, 'sheet.jpg')
  const payload = { items: items.map((it) => ({ index: it.index, file: path.win32.normalize(it.file) })) }
  try { fs.writeFileSync(manifestFile, JSON.stringify(payload), 'utf8') } catch (e) { return { ok: false, file: '', error: '写联系表清单失败：' + (e?.message ?? e) } }
  const run = spawnSync(PS, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT,
    '-Manifest', path.win32.normalize(manifestFile),
    '-OutPath', path.win32.normalize(outFile)
  ], { timeout: 45000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return { ok: true, file: outFile, error: '' }
  return { ok: false, file: '', error: run.error?.code === 'ETIMEDOUT' ? '拼联系表超时' : '拼联系表失败' }
}

/**
 * 建立一次预加载会话。items 里的 file 是临时下载文件；复制进会话目录后由调用方清理。
 * @returns {{ok:boolean, session:string, dir:string, sheet:string, items:Array, stats:object, error?:string}}
 */
export function createPreload({ query = '', mode = 'photo', engine = '', items = [], stats = {} } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.file && fs.existsSync(it.file))
  if (!list.length) return { ok: false, session: '', dir: '', sheet: '', items: [], stats, error: '没有可预加载的候选图' }
  cleanupPreloads()
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const session = 'p-' + stamp + '-' + crypto.randomBytes(3).toString('hex')
  const dir = path.join(preloadRoot(), session)
  fs.mkdirSync(dir, { recursive: true })
  const manifestItems = []
  let i = 0
  for (const it of list) {
    i += 1
    const ext = (path.extname(it.file) || '.jpg').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg'
    const file = path.join(dir, 'c' + String(i).padStart(2, '0') + ext)
    try { fs.copyFileSync(it.file, file) } catch { i -= 1; continue }
    let bytes = Number(it.bytes) || 0
    try { bytes = fs.statSync(file).size } catch {}
    manifestItems.push({
      index: manifestItems.length + 1,
      file,
      width: Number(it.width) || 0,
      height: Number(it.height) || 0,
      bytes,
      title: String(it.title || '').slice(0, 200),
      page: String(it.page || '').slice(0, 300),
      url: String(it.url || '').slice(0, 500),
      score: Number(it.score) || 0,
      verified: Boolean(it.ocrVerified || it.verified),
      ocr: it.ocrVerified ? { name: it.ocrName || '', strength: it.ocrStrength || '' } : undefined
    })
    if (manifestItems.length >= PRELOAD_MAX) break
  }
  if (!manifestItems.length) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    return { ok: false, session: '', dir: '', sheet: '', items: [], stats, error: '候选图复制失败' }
  }
  const sheet = buildContactSheet(dir, manifestItems)
  const manifest = {
    version: 1,
    session,
    query: String(query || '').slice(0, 120),
    mode: String(mode || 'photo'),
    engine: String(engine || ''),
    createdAt: Date.now(),
    sheet: sheet.ok ? sheet.file : '',
    items: manifestItems,
    stats: { ...stats, copied: manifestItems.length }
  }
  writeManifest(dir, manifest)
  return {
    ok: true,
    session,
    dir,
    sheet: manifest.sheet,
    items: manifestItems,
    stats: manifest.stats,
    error: sheet.ok ? '' : (sheet.error || '联系表没拼出来')
  }
}

/**
 * 从预加载会话里挑 1–5 张存进今天的网图目录。只有这一步消耗 30 张/天额度。
 * @returns {{ok:boolean, items:Array, code?:string, error?:string, hint?:string, count:number, max:number}}
 */
export function pickPreload(session, picks = []) {
  const got = readPreload(session)
  if (!got) return { ok: false, code: 'PRELOAD_EXPIRED', items: [], error: '这个预加载会话已经过期了（1 小时）', hint: '重新搜一次，拿新的 session 再挑。', count: listWebImages().images.length, max: MAX_PER_DAY }
  const { dir, manifest } = got
  const wanted = [...new Set((Array.isArray(picks) ? picks : []).map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 1))]
  if (!wanted.length) return { ok: false, code: 'BAD_PICKS', items: [], error: '没给要存哪几张', hint: 'picks 写联系表上的编号，比如 [1,4,7]，最多 ' + PICK_MAX + ' 张。', count: listWebImages().images.length, max: MAX_PER_DAY }
  if (wanted.length > PICK_MAX) return { ok: false, code: 'BAD_PICKS', items: [], error: '一次最多存 ' + PICK_MAX + ' 张', hint: '分两次挑，或者少存几张。', count: listWebImages().images.length, max: MAX_PER_DAY }
  const missing = wanted.filter((n) => !manifest.items.some((it) => it.index === n))
  if (missing.length) return { ok: false, code: 'BAD_PICKS', items: [], error: '联系表里没有编号 ' + missing.join('、'), hint: '编号从 1 到 ' + manifest.items.length + '，看联系表上的 #01 这种标签。', count: listWebImages().images.length, max: MAX_PER_DAY }
  const room = Math.max(0, MAX_PER_DAY - listWebImages().images.length)
  if (room < wanted.length) return { ok: false, code: 'DAILY_LIMIT', items: [], error: '今天只剩 ' + room + ' 张额度，选不了 ' + wanted.length + ' 张', hint: '少挑几张，或明天再存；预加载会话可以继续放着（1 小时内有效）。', count: listWebImages().images.length, max: MAX_PER_DAY }
  const saved = []
  const notes = []
  for (const n of wanted) {
    const it = manifest.items.find((x) => x.index === n)
    const added = addWebImage(it.file, {
      origin: manifest.mode === 'product' ? 'product' : 'web',
      source: (manifest.engine || 'preload') + '-preload',
      query: manifest.query,
      title: it.title || manifest.query,
      page: it.page || '',
      url: it.url || '',
      by: 'her'
    })
    if (!added.ok) { notes.push('#' + n + ' 没存下：' + (added.reason || '未知原因')); continue }
    saved.push({
      name: added.name,
      file: added.file,
      bytes: added.bytes,
      width: it.width || 0,
      height: it.height || 0,
      title: it.title || '',
      page: it.page || '',
      url: it.url || '',
      source: (manifest.engine || 'preload') + '-preload',
      verified: Boolean(it.verified),
      ocr: it.verified ? it.ocr : undefined
    })
  }
  if (!saved.length) {
    return { ok: false, code: 'SAVE_FAILED', items: [], error: '挑中的图一张都没存下来：' + (notes.join('；') || '未知原因'), hint: '检查今天的 30 张额度，或换几张再试。', count: listWebImages().images.length, max: MAX_PER_DAY }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  return {
    ok: true,
    items: saved,
    notes,
    count: listWebImages().images.length,
    max: MAX_PER_DAY,
    dir: dayDir()
  }
}

export function preloadStatus() {
  const root = preloadRoot()
  let names = []
  try { names = fs.readdirSync(root).filter((n) => safeSession(n)) } catch {}
  return { root, count: names.length, max: PRELOAD_MAX_DIRS, ttlMs: PRELOAD_TTL_MS }
}
