/* 通用工具：读写 JSON、日志行、端口探测、跑子进程、回包/读请求体、进程存活 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { AUDIT_FILE, PANEL_LOG, SURF } from './paths.js'
import { hardenSensitiveFile } from '../../src/state-acl.mjs'

export function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return dflt }
}
export function logLine(msg) {
  try {
    fs.mkdirSync(path.dirname(PANEL_LOG), { recursive: true })
    fs.appendFileSync(PANEL_LOG, '[' + new Date().toISOString() + '] ' + msg + '\n')
  } catch {}
}
/**
 * 原子写 JSON：唯一临时文件 → fsync → rename。
 * 为什么不用固定 `.tmp`：面板和桥接可能同时写配置，固定名会互相踩（读到别人半截内容再 rename 覆盖）。
 * 为什么 fsync：Windows 上 rename 只保证目录项，不保证数据落盘；断电后可能留下 0 字节文件。
 */
export function atomicWriteJson(file, obj, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w', opts.mode || 0o600)
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    try { fs.fsyncSync(fd) } catch {}
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
  }
  try { fs.renameSync(tmp, file) } catch (error) {
    try { fs.unlinkSync(tmp) } catch {}
    throw error
  }
  // rename 出来的是新文件，DACL 从父目录继承 —— 敏感配置（bili.config.json / config.json /
  // panel-token.txt）必须写完立刻收紧，否则手工加固过的权限会被下一次保存悄悄冲掉。
  const hardened = hardenSensitiveFile(file)
  if (!hardened.ok) logLine('warn: 收紧 ' + path.basename(file) + ' ACL 失败：' + hardened.detail)
}

export function clampNum(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, n))
}

export function portOpen(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { try { socket.destroy() } catch {}; resolve(ok) }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs || 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code || 1) : 0, out: String(stdout || ''), err: String(stderr || '') })
    })
  })
}

export function findWhale() {
  const candidates = []
  const base = path.join(SURF, 'characters')
  try {
    for (const role of fs.readdirSync(base)) {
      const f = path.join(base, role, 'bili', 'whale-night.json')
      if (fs.existsSync(f)) candidates.push({ file: f, mtime: fs.statSync(f).mtimeMs })
    }
  } catch {}
  const legacy = path.join(SURF, 'bili', 'whale-night.json')
  if (fs.existsSync(legacy)) candidates.push({ file: legacy, mtime: fs.statSync(legacy).mtimeMs })
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (!candidates.length) return { file: null, state: null }
  return { file: candidates[0].file, state: readJson(candidates[0].file, null) }
}

/** 本地时区的「今天」键：sv-SE 恰好是 YYYY-MM-DD（不受时区/夏令时影响）。 */
export function todayKey(date = new Date()) {
  return date.toLocaleDateString('sv-SE')
}
/**
 * 任意时间表达 → 本地日期键；无效值返回空串。
 * 为什么不能只接受数字：qzone-log.jsonl 的 at 是 ISO 字符串（"2026-11-09T13:33:32.670Z"），
 * Number() 会得到 NaN → 返回空串 → 与 "2026-11-09" 比较恒 false，本周/今天的计数永远是 0。
 * 数字（含纯数字字符串）仍按毫秒时间戳处理，其余交给 Date 解析。
 */
export function localDay(when) {
  if (when === null || when === undefined || when === '') return ''
  let d
  if (typeof when === 'number') d = new Date(when)
  else if (typeof when === 'string' && /^\d+$/.test(when.trim())) d = new Date(Number(when.trim()))
  else d = new Date(when)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('sv-SE')
}

export function weekStartLocal() {
  const d = new Date()
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  return monday.toLocaleDateString('sv-SE')
}
export function appendAudit(action, detail = {}) {
  const line = { at: new Date().toISOString(), action, detail }
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(line) + '\n', { encoding: 'utf8', mode: 0o600 }) } catch {}
}

export function maskText(text, keep = 80) {
  const s = String(text ?? '')
  const clipped = s.length > keep ? s.slice(0, keep) + '…' : s
  return clipped.replace(/\b\d{7,}\b/g, (m) => m.slice(0, 2) + '***' + m.slice(-2))
}

export function readTail(file, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const text = buf.toString('utf8')
    // 从文件中间开始读时，第一行几乎肯定是半截：丢掉它，别把断行当成一条日志。
    if (start > 0) {
      const nl = text.indexOf('\n')
      return nl >= 0 ? text.slice(nl + 1) : ''
    }
    return text
  } catch { return '' }
}

export function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
export function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { if (raw.length < 2 * 1024 * 1024) raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  })
}
