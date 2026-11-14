// B站视频「分享卡片」配额账本（owner 2026-11-11 22:25 要求 3）。
//
// 规则：**每个收件人每天最多 3 条**，管理员（主人）不限。
// 为什么要落盘：她清醒时有概率自己分享，面板/主人也可能让她分享，
// 两处都要算同一本账；只放在内存里重启就清零，等于没限。
//
// 文件：~/.dsh/stellar/state/bili-share.json
//   { day: '2026-11-11', by: { '1000000003': 2 }, items: [{ at, uin, bvid, title }] }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SHARE_PER_PERSON_PER_DAY = 3

export function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'stellar', 'state')
}
export function shareFile() { return path.join(stateDir(), 'bili-share.json') }

const pad = (n) => String(n).padStart(2, '0')
export function localDay(now = Date.now()) {
  const d = new Date(now)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function emptyStore(day) { return { version: 1, day, by: {}, items: [] } }

export function readShareStore({ now = Date.now() } = {}) {
  const day = localDay(now)
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(shareFile(), 'utf8')) } catch {}
  if (!raw || raw.day !== day) return emptyStore(day)
  return {
    version: 1,
    day,
    by: raw.by && typeof raw.by === 'object' ? raw.by : {},
    items: Array.isArray(raw.items) ? raw.items.slice(-200) : [],
  }
}

export function writeShareStore(store) {
  const file = shareFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** 还能给这个人发几条。isAdmin=true 时返回 Infinity 语义（用 -1 表示不限）。 */
export function remainingFor(uin, { isAdmin = false, now = Date.now() } = {}) {
  if (isAdmin) return -1
  const store = readShareStore({ now })
  const used = Number(store.by[String(uin)] ?? 0) || 0
  return Math.max(0, SHARE_PER_PERSON_PER_DAY - used)
}

export function canShareTo(uin, { isAdmin = false, now = Date.now() } = {}) {
  const left = remainingFor(uin, { isAdmin, now })
  return { ok: left !== 0, left, limit: isAdmin ? 0 : SHARE_PER_PERSON_PER_DAY }
}

export function recordShare({ uin, bvid = '', title = '', now = Date.now() } = {}) {
  const store = readShareStore({ now })
  const keyOf = String(uin)
  store.by[keyOf] = (Number(store.by[keyOf] ?? 0) || 0) + 1
  store.items.push({ at: now, uin: keyOf, bvid: String(bvid || ''), title: String(title || '').slice(0, 120) })
  store.items = store.items.slice(-200)
  writeShareStore(store)
  return readShareStore({ now })
}

export function shareStats({ now = Date.now() } = {}) {
  const store = readShareStore({ now })
  return { day: store.day, by: store.by, items: store.items.slice(-20) }
}