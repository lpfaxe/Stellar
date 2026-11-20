// 主人的文件柜（写入侧）：纯逻辑 + 落盘，无网络、无外部依赖。
//
// 2026-11-20 主人要求：「让她能根据我的要求把文件存进文件柜」。
// 在那之前她只有 stellar_file_list / stellar_file_read —— 主人发来文档说「先存下」，
// 她只能空口答应「收好了」，柜子其实是空的。这里补上写入侧。
//
// 落盘约定**必须**和面板（stellar-manager/lib/files.js）一致，否则两边看到的柜子不一样：
//   · 目录：<dshHome>/stellar/files/
//   · 同名不覆盖：自动加「 (2)」「 (3)」；
//   · 追加 index.jsonl：{at: <epoch ms>, kind: 'add', name, bytes, by}；
//   · 单文件上限 512 MB（2026-11-20 主人要求从 40 MB 提到 512 MB）；
//   · 文件名允许中文，去掉路径分隔符与 Windows 保留字符，防目录穿越。
import fs from 'node:fs'
import path from 'node:path'

export const CABINET_MAX_BYTES = 512 * 1024 * 1024
export const CABINET_MAX_NAME = 120
export const CABINET_INDEX = 'index.jsonl'

const KIND_BY_EXT = {
  '.doc': 'word', '.docx': 'word', '.wps': 'word', '.rtf': 'word', '.odt': 'word',
  '.xls': 'excel', '.xlsx': 'excel', '.et': 'excel', '.csv': 'excel', '.ods': 'excel',
  '.ppt': 'ppt', '.pptx': 'ppt', '.dps': 'ppt', '.odp': 'ppt',
  '.pdf': 'pdf',
  '.txt': 'text', '.md': 'text', '.json': 'text', '.log': 'text',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.bmp': 'image',
  '.zip': 'archive', '.7z': 'archive', '.rar': 'archive',
}

export function kindOf(name) {
  return KIND_BY_EXT[path.extname(String(name || '')).toLowerCase()] || 'other'
}

/** 文件名清洗：允许中文，去掉路径分隔符与 Windows 保留字符，避免 ../ 之类穿越。 */
export function safeName(raw) {
  let s = String(raw || '').replace(/[\\/]+/g, '_')
  s = s.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim()
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!s) return ''
  if (s.length <= CABINET_MAX_NAME) return s
  const ext = path.extname(s)
  const stem = s.slice(0, s.length - ext.length).slice(0, Math.max(1, CABINET_MAX_NAME - ext.length))
  return stem + ext
}

export function cabinetDir(dshHome) {
  return path.join(String(dshHome || ''), 'stellar', 'files')
}

export function ensureCabinetDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/** 柜子里的文件名（隐藏文件与索引除外），按改动时间从新到旧。 */
export function listCabinetNames(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== CABINET_INDEX)
  } catch { return [] }
  const rows = []
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(dir, n))
      if (st.isFile()) rows.push({ name: n, bytes: st.size, at: st.mtimeMs, kind: kindOf(n) })
    } catch {}
  }
  rows.sort((a, b) => b.at - a.at)
  return rows
}

function appendIndex(dir, entry) {
  try {
    ensureCabinetDir(dir)
    fs.appendFileSync(path.join(dir, CABINET_INDEX), JSON.stringify({ at: Date.now(), ...entry }) + '\n', 'utf8')
  } catch {}
}

/**
 * 存一个文件进柜子：同名不覆盖（自动加「 (n)」），返回真正落盘的名字。
 * @param {string} dir 柜子目录（cabinetDir(dshHome)）
 * @param {string} rawName 期望的文件名
 * @param {Buffer|Uint8Array} content 内容
 * @param {{by?: string, note?: string}} options by=谁存的（owner / stellar），note=备注
 */
export function saveToCabinet(dir, rawName, content, { by = 'owner', note = '' } = {}) {
  const safe = safeName(rawName)
  if (!safe) return { ok: false, message: '文件名不合法（空名字或只有保留字符）' }
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '')
  if (!buf.length) return { ok: false, message: '文件是空的（0 字节）' }
  if (buf.length > CABINET_MAX_BYTES) {
    return { ok: false, message: '文件太大（' + humanBytes(buf.length) + '），文件柜上限 ' + humanBytes(CABINET_MAX_BYTES) }
  }
  ensureCabinetDir(dir)
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let final = safe
  let n = 1
  while (fs.existsSync(path.join(dir, final))) {
    n += 1
    if (n > 500) return { ok: false, message: '同名文件太多了（已经 500 个），先清一清再用' }
    final = stem + ' (' + n + ')' + ext
  }
  const target = path.join(dir, final)
  if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
    return { ok: false, message: '文件名不合法（跑出柜子目录了）' }
  }
  try {
    fs.writeFileSync(target, buf)
  } catch (error) {
    return { ok: false, message: '写入失败：' + String((error && error.message) || error) }
  }
  const entry = { kind: 'add', name: final, bytes: buf.length, by: String(by || 'owner') }
  if (note) entry.note = String(note).slice(0, 200)
  appendIndex(dir, entry)
  return { ok: true, name: final, bytes: buf.length, path: target, kind: kindOf(final) }
}

/** 人类可读的大小。 */
export function humanBytes(bytes) {
  const b = Number(bytes) || 0
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  if (b >= 1024) return Math.round(b / 1024) + ' KB'
  return b + ' B'
}
