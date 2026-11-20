// 主人的文件柜：她和我聊天时用得到的文档/图片放在一个固定目录里（owner 2026-11-20 要的）。
// 目的不是给她自动灌内容——恰恰相反：她自己不会主动读，只有主人问起、或她说要看某个文件时
// 才用 stellar_file_list / stellar_file_read 现查现读，避免每轮把这些文件塞进上下文烧 token。
// 目录：~/.dsh/stellar/files/（跨天保留，不自动清空；与 image-pool / web-images 分开）。
import fs from 'node:fs'
import path from 'node:path'
import { SURF } from './paths.js'

const ROOT = path.join(SURF, 'files')
const INDEX = path.join(ROOT, 'index.jsonl')
const MAX_NAME = 120
const MAX_BYTES = 512 * 1024 * 1024 // 2026-11-20 主人要求：40 MB → 512 MB

const KIND_BY_EXT = {
  '.doc': 'word', '.docx': 'word', '.wps': 'word', '.rtf': 'word', '.odt': 'word',
  '.xls': 'excel', '.xlsx': 'excel', '.et': 'excel', '.csv': 'excel', '.ods': 'excel',
  '.ppt': 'ppt', '.pptx': 'ppt', '.dps': 'ppt', '.odp': 'ppt',
  '.pdf': 'pdf',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.log': 'text',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.bmp': 'image',
  '.zip': 'archive', '.7z': 'archive', '.rar': 'archive',
}

/** 文件名清洗：允许中文，去掉路径分隔符与 Windows 保留字符，避免 ../ 之类穿越。 */
export function safeName(raw) {
  let s = String(raw || '').replace(/[\\/]+/g, '_')
  s = s.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim()
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!s) return ''
  if (s.length <= MAX_NAME) return s
  const ext = path.extname(s)
  const stem = s.slice(0, s.length - ext.length).slice(0, Math.max(1, MAX_NAME - ext.length))
  return stem + ext
}

export function filesDir() {
  try { fs.mkdirSync(ROOT, { recursive: true }) } catch {}
  return ROOT
}

export function filePath(name) {
  const safe = safeName(name)
  if (!safe) return null
  const file = path.join(ROOT, safe)
  if (!file.startsWith(ROOT + path.sep)) return null
  try { return fs.statSync(file).isFile() ? file : null } catch { return null }
}

export function kindOf(name) { return KIND_BY_EXT[path.extname(String(name || '')).toLowerCase()] || 'other' }

function readIndex() {
  try {
    return fs.readFileSync(INDEX, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

function appendIndex(entry) {
  try {
    filesDir()
    fs.appendFileSync(INDEX, JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8')
  } catch {}
}

export function listFiles() {
  filesDir()
  const rows = readIndex()
  const added = new Map()
  for (const r of rows) if (r.kind === 'add' && r.name) added.set(String(r.name), r)
  let names = []
  try { names = fs.readdirSync(ROOT).filter((n) => !n.startsWith('.') && n !== 'index.jsonl') } catch {}
  const items = []
  for (const n of names) {
    const file = path.join(ROOT, n)
    let st = null
    try { st = fs.statSync(file) } catch { continue }
    if (!st.isFile()) continue
    const mark = added.get(n) || {}
    items.push({
      name: n,
      bytes: st.size,
      at: st.mtimeMs,
      kind: kindOf(n),
      by: String(mark.by || ''),
    })
  }
  items.sort((a, b) => b.at - a.at)
  const log = rows.filter((r) => r.kind === 'add' || r.kind === 'delete')
    .slice(-30).reverse()
    .map((r) => ({ kind: r.kind, name: String(r.name || ''), by: String(r.by || ''), at: Number(r.at) || 0 }))
  return {
    dir: ROOT,
    count: items.length,
    bytes: items.reduce((sum, it) => sum + it.bytes, 0),
    items,
    log,
  }
}

// 人类可读大小：<1 MB 用 B/KB（小文件别显示成「0.0 MB」）。
export function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

function mbText(bytes) { return (Number(bytes) / 1048576).toFixed(1) + ' MB' }

/** 挑一个没被占用的落盘名（同名不覆盖：加 (2)(3)）。 */
function pickName(safe) {
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let final = safe
  let n = 1
  while (fs.existsSync(path.join(ROOT, final))) {
    n += 1
    if (n > 500) return { error: '同名文件太多了，先清一清' }
    final = stem + ' (' + n + ')' + ext
  }
  return { final }
}

/** 同名不覆盖：自动加 (2)(3)，返回真正落盘的名字。 */
export function saveFile(name, buffer, { by = 'owner' } = {}) {
  const safe = safeName(name)
  if (!safe) return { ok: false, message: '文件名不合法' }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'base64')
  if (!buf.length) return { ok: false, message: '文件是空的' }
  if (buf.length > MAX_BYTES) return { ok: false, message: '文件太大（' + mbText(buf.length) + '），文件柜上限 ' + mbText(MAX_BYTES) }
  filesDir()
  const picked = pickName(safe)
  if (picked.error) return { ok: false, message: picked.error }
  const final = picked.final
  const file = path.join(ROOT, final)
  try { fs.writeFileSync(file, buf) } catch (e) { return { ok: false, message: '写入失败：' + String(e && e.message || e) } }
  appendIndex({ kind: 'add', name: final, bytes: buf.length, by: String(by || 'owner') })
  return { ok: true, name: final, bytes: buf.length }
}

/**
 * 删文件：先 rmSync，没删干净再 unlinkSync 补一刀。
 * 本机实测过 rmSync(force) 会「返回成功但文件还在」（部分沙箱/杀毒拦截时），
 * 所以柜子的删除都走这里，别只看返回值。
 */
export function removeFileHard(p) {
  try { fs.rmSync(p, { force: true }) } catch {}
  let alive = true
  try { alive = fs.existsSync(p) } catch { alive = false }
  if (!alive) return true
  try { fs.unlinkSync(p) } catch {}
  try { return !fs.existsSync(p) } catch { return true }
}

/**
 * 把已经落好的临时文件搬进柜子（大文件走这条：不经过 base64，省一倍内存）。
 * tempPath 必须和柜子同盘（面板上传时就写在柜子目录里的 .incoming-*），这样能直接 rename。
 */
export function saveFileFromPath(name, tempPath, { by = 'owner' } = {}) {
  const drop = () => removeFileHard(tempPath)
  const safe = safeName(name)
  if (!safe) { drop(); return { ok: false, message: '文件名不合法' } }
  let st = null
  try { st = fs.statSync(tempPath) } catch { return { ok: false, message: '临时文件不见了' } }
  if (!st.isFile()) { drop(); return { ok: false, message: '临时文件不见了' } }
  if (!st.size) { drop(); return { ok: false, message: '文件是空的' } }
  if (st.size > MAX_BYTES) { drop(); return { ok: false, message: '文件太大（' + mbText(st.size) + '），文件柜上限 ' + mbText(MAX_BYTES) } }
  filesDir()
  const picked = pickName(safe)
  if (picked.error) { drop(); return { ok: false, message: picked.error } }
  const final = picked.final
  const file = path.join(ROOT, final)
  try {
    fs.renameSync(tempPath, file)
  } catch {
    try { fs.copyFileSync(tempPath, file); removeFileHard(tempPath) } catch (e) {
      drop(); return { ok: false, message: '写入失败：' + String(e && e.message || e) }
    }
  }
  appendIndex({ kind: 'add', name: final, bytes: st.size, by: String(by || 'owner') })
  return { ok: true, name: final, bytes: st.size }
}

/**
 * 流式收一份大文件进柜子：边收边写柜子目录里的 .incoming-*，收完 rename 进去。
 * 不拼大 Buffer、不 base64 —— 512 MB 也扛得住；超限就把临时文件删掉。
 */
export async function saveStream(name, stream, { by = 'owner', maxBytes = MAX_BYTES } = {}) {
  const dir = filesDir()
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_BYTES
  const tmp = path.join(dir, '.incoming-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2))
  const declared = Number((stream && stream.headers && stream.headers['content-length']) || 0)
  if (declared > limit) {
    try { if (typeof stream.resume === 'function') stream.resume() } catch {}
    return { ok: false, message: '文件太大（' + sizeText(declared) + '），文件柜上限 ' + sizeText(limit) }
  }
  const out = fs.createWriteStream(tmp)
  let size = 0
  let overflow = false
  let broken = false
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    stream.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { overflow = true; return }
      if (!overflow) out.write(chunk)
    })
    stream.on('end', () => { out.end(finish) })
    stream.on('aborted', () => { broken = true; try { out.destroy() } catch {} ; finish() })
    stream.on('error', () => { broken = true; try { out.destroy() } catch {} ; finish() })
    out.on('error', () => { broken = true; finish() })
  })
  // 流没关干净时删不动（Windows 上文件还被句柄占着），先等 close 再清理。
  if (overflow || broken) {
    await new Promise((resolve) => {
      if (out.closed) return resolve()
      out.once('close', resolve)
      const t = setTimeout(resolve, 2000)
      if (t.unref) t.unref()
    })
  }
  if (overflow) {
    removeFileHard(tmp)
    return { ok: false, message: '文件太大（超过 ' + sizeText(limit) + '），没存' }
  }
  // 断了的上传不能当完整文件存（半截 PDF 比没有更坑）。
  if (broken || (declared > 0 && size !== declared)) {
    removeFileHard(tmp)
    return { ok: false, message: broken ? '上传中断了，没存' : '上传不完整（收到 ' + sizeText(size) + '，应为 ' + sizeText(declared) + '），没存' }
  }
  return saveFileFromPath(name, tmp, { by })
}

export function deleteFile(name, { by = 'owner' } = {}) {
  const file = filePath(name)
  if (!file) return { ok: false, message: '这个文件已经不在了' }
  const base = path.basename(file)
  if (!removeFileHard(file)) return { ok: false, message: '删除失败：文件被别的程序占用着' }
  appendIndex({ kind: 'delete', name: base, by: String(by || 'owner') })
  return { ok: true, name: base }
}

export const FILES_MAX_BYTES = MAX_BYTES