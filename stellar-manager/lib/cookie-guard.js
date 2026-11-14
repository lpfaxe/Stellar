// DSH 桌面端 Cookie 清理守卫（2026-11-10）
//
// 已知问题：DSH 桌面版每次启动都会往 %APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies
// 里加一条登录 Cookie 且从不清理；启动约 72 次后累积的 Cookie 把请求头撑过 16KB，
// 服务端回 431，表现就是 "Web authentication failed"、软件打不开。
// 官方解法是删 Cookies 与 Cookies-journal —— 但登录态也会一起没。
//
// 这里做定向清理：只在 DSH 没运行时动手，先整库备份，然后只保留回环主机
// （127.0.0.1 / localhost / [::1]）最近使用的 N 条，其余删掉并 VACUUM，
// 结果写到 state/cookie-guard.json，面板「运行」页可以看。
//
// 用法：
//   node lib/cookie-guard.js             自动：超过阈值才清理
//   node lib/cookie-guard.js --check     只测量，不删
//   node lib/cookie-guard.js --force     不看阈值，清一次（仍然先备份）
//   node lib/cookie-guard.js --restore <备份文件>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.USERPROFILE || os.homedir()
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
const SURF = process.env.STELLAR_DATA_DIR || path.join(DSH_HOME, 'stellar')
const STATE_FILE = path.join(SURF, 'state', 'cookie-guard.json')
const BACKUP_DIR = path.join(SURF, 'state', 'cookie-backups')
const NET_DIR = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), '@deepseek-ai', 'dsh-desktop', 'Network')
const DB = path.join(NET_DIR, 'Cookies')

// 16KB 是硬上限；估算到 6KB 就清理，留一半余量。
const HEADER_LIMIT = 16384
const PRUNE_AT_BYTES = 6000
const KEEP_LOOPBACK = 8
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function nowIso() { return new Date().toISOString() }

function writeState(patch) {
  // 每次只写「最近一次」的结果：合并旧字段会让面板把上一轮的 deleted 当成这一轮的。
  const next = { ...patch, at: nowIso() }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, STATE_FILE)
  } catch {}
  return next
}

export function dbPath() { return DB }

export function exists() { try { return fs.statSync(DB).isFile() } catch { return false } }

async function openDb(file, { readonly = false } = {}) {
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(file, readonly ? { readOnly: true } : {})
}

/** 统计行数、回环行数与估算请求头字节（name + value + host + 分隔符）。 */
export function summarize(db) {
  // last_access_utc 是 1601 起的微秒数，node:sqlite 转 Number 会抛「too large」，统一 cast 成文本。
  const rows = db.prepare('select host_key, name, value, encrypted_value, cast(last_access_utc as text) as last_access_utc from cookies').all()
  let bytes = 0
  let loopback = 0
  const byHost = new Map()
  for (const r of rows) {
    const host = String(r.host_key || '')
    const valueLen = r.value ? String(r.value).length : (r.encrypted_value ? r.encrypted_value.length : 0)
    bytes += String(r.name || '').length + valueLen + host.length + 1
    byHost.set(host, (byHost.get(host) || 0) + 1)
    if (LOOPBACK.has(host)) loopback += 1
  }
  const hosts = [...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([host, n]) => ({ host, n }))
  let fileBytes = 0
  try { fileBytes = fs.statSync(DB).size } catch {}
  return { rows: rows.length, loopback, bytes, hosts, fileBytes }
}

function backup(file) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = nowIso().replace(/[:.]/g, '-')
  const dest = path.join(BACKUP_DIR, 'Cookies-' + stamp)
  fs.copyFileSync(file, dest)
  try {
    const all = fs.readdirSync(BACKUP_DIR).filter((n) => n.startsWith('Cookies-')).sort()
    for (const old of all.slice(0, Math.max(0, all.length - 10))) fs.unlinkSync(path.join(BACKUP_DIR, old))
  } catch {}
  return dest
}

/** 定向清理：只留回环主机最近使用的 keep 条。 */
export async function prune({ force = false, keep = KEEP_LOOPBACK } = {}) {
  if (!exists()) return writeState({ action: 'prune', skipped: 'no-cookie-db' })
  let db
  try {
    db = await openDb(DB)
  } catch (error) {
    // 最常见的失败是 DSH 还开着（WinError 32 / SQLITE_BUSY）：这时什么都不做才是对的。
    return writeState({ action: 'prune', skipped: 'locked', error: String(error && error.message || error) })
  }
  try {
    const before = summarize(db)
    if (!force && before.bytes < PRUNE_AT_BYTES) {
      db.close()
      return writeState({ action: 'check', skipped: 'below-threshold', threshold: PRUNE_AT_BYTES, limit: HEADER_LIMIT, before })
    }
    const dest = backup(DB)
    const loopbackRows = db.prepare('select rowid, host_key, cast(last_access_utc as text) as last_access_utc from cookies').all()
      .filter((r) => LOOPBACK.has(String(r.host_key || '')))
      .sort((a, b) => { const x = BigInt(a.last_access_utc || '0'); const y = BigInt(b.last_access_utc || '0'); return x === y ? 0 : x > y ? -1 : 1 })
    const drop = loopbackRows.slice(keep)
    let deleted = 0
    if (drop.length) {
      const del = db.prepare('delete from cookies where rowid = ?')
      for (const r of drop) { del.run(r.rowid); deleted += 1 }
    }
    try { db.exec('vacuum') } catch {}
    const after = summarize(db)
    db.close()
    return writeState({
      action: 'prune',
      backup: dest,
      threshold: PRUNE_AT_BYTES,
      limit: HEADER_LIMIT,
      keptLoopback: Math.min(keep, loopbackRows.length),
      deleted,
      before,
      after,
    })
  } catch (error) {
    try { db.close() } catch {}
    return writeState({ action: 'prune', skipped: 'error', error: String(error && error.message || error) })
  }
}

/** 只读检查（DSH 开着也能跑；文件锁住就返回 locked，不报错）。 */
export async function check() {
  if (!exists()) return writeState({ action: 'check', skipped: 'no-cookie-db' })
  let db
  try { db = await openDb(DB, { readonly: true }) } catch (error) {
    return writeState({ action: 'check', skipped: 'locked', error: String(error && error.message || error) })
  }
  try {
    const info = summarize(db)
    db.close()
    return writeState({ action: 'check', skipped: '', threshold: PRUNE_AT_BYTES, limit: HEADER_LIMIT, info })
  } catch (error) {
    try { db.close() } catch {}
    return writeState({ action: 'check', skipped: 'error', error: String(error && error.message || error) })
  }
}

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

/** 还原备份（DSH 必须先退出）。 */
export async function restore(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, message: '备份文件不存在' }
  if (!exists()) return { ok: false, message: '找不到 Cookies 数据库，先启动一次 DSH 再来' }
  try {
    fs.copyFileSync(file, DB)
    writeState({ action: 'restore', from: file })
    return { ok: true, message: '已还原，重新打开 DSH' }
  } catch (error) {
    return { ok: false, message: '还原失败：' + String(error && error.message || error) }
  }
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '') } catch { return false }
})()

if (isMain) {
  const argv = process.argv.slice(2)
  const target = argv.indexOf('--restore')
  const out = argv.includes('--check')
    ? await check()
    : target >= 0
      ? await restore(argv[target + 1])
      : await prune({ force: argv.includes('--force') })
  console.log(JSON.stringify(out, null, 2))
}
