/* 鉴权：本机免口令、会话 Cookie、防爆破、防跨站、安全响应头、口令轮换 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { PANEL_ROOT, SURF } from './paths.js'
import { appendAudit, atomicWriteJson, logLine, readJson, sendJson, readBody } from './util.js'
import { loginPageHtml } from './login-page.js'
import { hardenSensitiveFile } from '../../src/state-acl.mjs'
import { isAllowedRemote, guardKey } from './remote-allow.js'

// 口令文件放运行时目录（<DSH_HOME>/stellar/panel-token.txt），不写进仓库目录：
// 仓库可能被 git 跟踪，一个误提交就把口令公开了。
const TOKEN_FILE = path.join(SURF, 'panel-token.txt')
const SESSION_FILE = path.join(SURF, 'state', 'panel-sessions.json')
const GUARD_FILE = path.join(SURF, 'state', 'panel-auth-guard.json')
const LOGIN_CODE_FILE = path.join(SURF, 'state', 'panel-login-codes.json')
const COOKIE_NAME = 'panel_sid'
// 会话 30 天（owner 2026-11-09：原来 365 天太长，改成一个月，过期用新码重新登一次）。
const SESSION_TTL_MS = 30 * 86400e3
// 一次性登录码：5 分钟有效、只能换一次 Cookie，避免把长期口令塞进链接。
const LOGIN_CODE_TTL_MS = 5 * 60e3
const MAX_SESSIONS = 50

// ── 口令：panel-token.txt 里那 8 位；轮换后旧 Cookie 全部作废 ───────────────
function makeToken() {
  return crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8).padEnd(8, 'x')
}
function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (/^[a-z0-9]{6,32}$/.test(t)) return t
  } catch {}
  const t = makeToken()
  try { fs.writeFileSync(TOKEN_FILE, t + '\n'); const h = hardenSensitiveFile(TOKEN_FILE); if (!h.ok) logLine('warn: 收紧 panel-token.txt ACL 失败：' + h.detail) } catch {}
  return t
}
let token = loadToken()
export function currentToken() { return token }
/** 设置自定义口令（本机专用）：主人自己记得住的那串，8–64 位。 */
export function setPassphrase(next) {
  const t = String(next || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{7,63}$/.test(t)) {
    return { ok: false, message: '口令要 8–64 位，只能用字母/数字/点/下划线/减号（不要空格和中文）' }
  }
  token = t
  try { fs.writeFileSync(TOKEN_FILE, t + '\n'); const h = hardenSensitiveFile(TOKEN_FILE); if (!h.ok) logLine('warn: 收紧 panel-token.txt ACL 失败：' + h.detail) } catch {}
  revokeAllSessions()
  logLine('passphrase set by owner')
  return { ok: true, message: '新口令已生效，其他设备需要用新口令重新登录', token: t }
}
export function rotateToken() {
  token = makeToken()
  try { fs.writeFileSync(TOKEN_FILE, token + '\n'); const h = hardenSensitiveFile(TOKEN_FILE); if (!h.ok) logLine('warn: 收紧 panel-token.txt ACL 失败：' + h.detail) } catch {}
  revokeAllSessions()
  logLine('token rotated')
  return token
}
function sameSecret(a, b) {
  const ab = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  if (ab.length !== bb.length) return false
  try { return crypto.timingSafeEqual(ab, bb) } catch { return false }
}

// ── 一次性登录码：?code= 只能换一次 Cookie，5 分钟后失效 ─────────────────
const loginCodes = new Map()
function codeHash(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex')
}
function loadLoginCodes() {
  const raw = readJson(LOGIN_CODE_FILE, null)
  const now = Date.now()
  for (const rec of (raw && Array.isArray(raw.codes) ? raw.codes : [])) {
    if (!rec || !/^[a-f0-9]{64}$/.test(String(rec.hash || ''))) continue
    if (Number(rec.expiresAt || 0) <= now) continue
    loginCodes.set(String(rec.hash), { expiresAt: Number(rec.expiresAt), usedAt: Number(rec.usedAt) || 0 })
  }
}
function saveLoginCodes() {
  try {
    fs.mkdirSync(path.dirname(LOGIN_CODE_FILE), { recursive: true })
    const now = Date.now()
    const codes = [...loginCodes].filter(([, r]) => r.expiresAt > now).map(([hash, r]) => ({ hash, expiresAt: r.expiresAt, usedAt: r.usedAt || 0 }))
    atomicWriteJson(LOGIN_CODE_FILE, { version: 1, codes })
  } catch {}
}
loadLoginCodes()
/** 发一个一次性登录码；只返回明文给当前已登录的页面，磁盘上只有 sha256。 */
export function issueLoginCode(ttlMs = LOGIN_CODE_TTL_MS) {
  const now = Date.now()
  const code = crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  const hash = codeHash(code)
  loginCodes.set(hash, { expiresAt: now + ttlMs, usedAt: 0 })
  saveLoginCodes()
  return { code, expiresAt: now + ttlMs }
}
/** 消费一次性码：过期/用过/不存在都返回 false；成功即写 usedAt，重放无效。 */
function consumeLoginCode(code) {
  const raw = String(code || '').trim().toLowerCase()
  if (!/^[a-z0-9]{8,32}$/.test(raw)) return false
  const hash = codeHash(raw)
  const rec = loginCodes.get(hash)
  const now = Date.now()
  if (!rec || rec.usedAt || rec.expiresAt <= now) {
    if (rec && rec.expiresAt <= now) { loginCodes.delete(hash); saveLoginCodes() }
    return false
  }
  rec.usedAt = now
  saveLoginCodes()
  return true
}
/**
 * 当前请求是否已经有面板凭据。**只认会话**（2026-11-16）。
 *
 * 以前这里是「本机免口令」：isLoopback(req) 为真就算已登录。后果是同一台电脑上
 * 任何账户/任何进程打 http://127.0.0.1:3300/api/status 都能拿到明文口令，
 * 拿到就能从公网隧道登录 —— 绑回环防的是外面，防不了本机别的用户（PITFALLS #208）。
 * 现在本机也要先换一个会话 Cookie：启动时的本机入口会带着 ?code= 打开一次，
 * 之后 30 天都免输入。
 */
export function isAuthed(req) {
  return validSession(req)
}
// ── 会话：随机 sid 存在 state/panel-sessions.json，面板重启不掉线 ──────────
const sessions = new Map()
function loadSessions() {
  const raw = readJson(SESSION_FILE, null)
  const list = raw && Array.isArray(raw.sessions) ? raw.sessions : []
  const now = Date.now()
  for (const s of list) {
    if (!s || !s.sid || !/^[a-f0-9]{32,64}$/.test(s.sid)) continue
    if (now - Number(s.last || s.created || 0) > SESSION_TTL_MS) continue
    sessions.set(s.sid, { created: Number(s.created || now), last: Number(s.last || now), ip: String(s.ip || ''), ua: String(s.ua || '').slice(0, 160) })
  }
}
function saveSessions() {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
    const sessionsArr = [...sessions].map(([sid, s]) => ({ sid, ...s })).slice(-MAX_SESSIONS)
    atomicWriteJson(SESSION_FILE, { version: 1, sessions: sessionsArr })
    // rename 出来的新文件会继承父目录的 DACL，加固必须放在写之后
    const h = hardenSensitiveFile(SESSION_FILE)
    if (h.ok === false) logLine('warn: 收紧 panel-sessions.json ACL 失败：' + h.detail)
  } catch {}
}
loadSessions()

// 已经存在的旧会话文件也收紧一次（进程启动时文件可能还是宽松 ACL）
try {
  if (fs.existsSync(SESSION_FILE)) {
    const h = hardenSensitiveFile(SESSION_FILE)
    if (h.ok === false) logLine('warn: 启动时收紧 panel-sessions.json ACL 失败：' + h.detail)
  }
} catch {}

export function sessionCount() { return sessions.size }
export function sessionInfo() {
  const now = Date.now()
  return [...sessions.values()].map((s) => ({ created: s.created, last: s.last, ip: s.ip, ua: s.ua, active: now - s.last < 86400e3 }))
}
function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '')
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}
function isSecureReq(req) {
  if (String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') return true
  if (req.headers['cf-ray']) return true
  return /trycloudflare\.com$/i.test(String(req.headers.host || ''))
}
function cookieHeader(sid, req) {
  return COOKIE_NAME + '=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + (isSecureReq(req) ? '; Secure' : '')
}
function clearCookieHeader(req) {
  return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (isSecureReq(req) ? '; Secure' : '')
}
function newSid() { return crypto.randomBytes(24).toString('hex') }
function createSession(req) {
  const now = Date.now()
  let sid = newSid()
  while (sessions.has(sid)) sid = newSid()
  sessions.set(sid, { created: now, last: now, ip: String((req.socket && req.socket.remoteAddress) || ''), ua: String(req.headers['user-agent'] || '') })
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions].sort((a, b) => a[1].last - b[1].last)[0]
    if (!oldest) break
    sessions.delete(oldest[0])
  }
  saveSessions()
  return sid
}
export function revokeSession(req) {
  const sid = cookieOf(req, COOKIE_NAME)
  if (sid && sessions.delete(sid)) saveSessions()
}
export function revokeAllSessions() {
  sessions.clear()
  saveSessions()
}
function validSession(req) {
  const sid = cookieOf(req, COOKIE_NAME)
  if (!sid || !/^[a-f0-9]{32,64}$/.test(sid)) return false
  const rec = sessions.get(sid)
  if (!rec) return false
  const now = Date.now()
  if (now - rec.last > SESSION_TTL_MS) { sessions.delete(sid); saveSessions(); return false }
  rec.last = now
  saveSessions()
  return true
}

// ── 本机判定：隧道也是从 127.0.0.1 进来的，所以必须同时看 Host 与代理头 ────
export function isLoopback(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '')
  if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return false
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for'] || req.headers['cdn-loop']) return false
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}
export function clientIp(req) {
  // 云隧道（cloudflared）转发进来时 socket 端全是 127.0.0.1，
  // 直接用 socket 地址会让所有人共用一个防爆破桶：外人连错几次就能把主人锁在门外，
  // 反过来主人在外连错也会封掉所有访客。优先信代理头，再退回收发地址。
  const h = req.headers || {}
  const cf = String(h['cf-connecting-ip'] || '').trim()
  if (cf && /^[0-9a-fA-Fa-f:.]{2,64}$/.test(cf)) return cf
  const xff = String(h['x-forwarded-for'] || '').split(',')[0].trim()
  if (xff && /^[0-9a-fA-Fa-f:.]{2,64}$/.test(xff)) return xff
  return String((req.socket && req.socket.remoteAddress) || '')
}
/** Tailscale 地址（100.64.0.0/10）：装了 Tailscale 就等于有一条不走公网的固定入口。 */
export function tailnetAddresses() {
  const out = []
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue
        const m = /^(\d{1,3})\.(\d{1,3})\./.exec(a.address)
        if (!m) continue
        const first = Number(m[1]); const second = Number(m[2])
        // 100.64–100.127 是 CGNAT 段，Tailscale 就落在这里
        if (first === 100 && second >= 64 && second <= 127) out.push({ name, address: a.address })
      }
    }
  } catch {}
  return out
}
/** 本机全局 IPv6（手机在 4G/5G 下能直接访问的那种地址）。 */
export function publicV6Addresses() {
  const out = []
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it.family !== 'IPv6' || it.internal) continue
        if (!isGlobalV6(it.address)) continue
        out.push({ name, address: it.address, netmask: it.netmask || '' })
      }
    }
  } catch {}
  return out
}

export function lanAddresses() {
  const out = []
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address })
      }
    }
  } catch {}
  return out
}

// ── 防爆破：按 IP 记账，失败越多锁越久；成功清零；落盘防重启绕过 ──────────
function loadGuard() {
  const raw = readJson(GUARD_FILE, null)
  const map = new Map()
  if (raw && typeof raw === 'object') {
    for (const [ip, rec] of Object.entries(raw.ips || {})) {
      if (!rec) continue
      map.set(ip, { fails: Number(rec.fails) || 0, until: Number(rec.until) || 0, at: Number(rec.at) || 0 })
    }
  }
  return map
}
const guard = loadGuard()
let guardTimer = null
function saveGuardSoon() {
  if (guardTimer) return
  guardTimer = setTimeout(() => {
    guardTimer = null
    try {
      const now = Date.now()
      const ips = {}
      for (const [ip, rec] of guard) {
        if (now - rec.at > 7 * 86400e3) continue
        ips[ip] = rec
      }
      fs.mkdirSync(path.dirname(GUARD_FILE), { recursive: true })
      atomicWriteJson(GUARD_FILE, { version: 1, ips })
    } catch {}
  }, 800)
  if (guardTimer.unref) guardTimer.unref()
}
export function loginBlocked(ip) {
  const rec = guard.get(ip)
  if (!rec || !rec.until) return 0
  const left = rec.until - Date.now()
  return left > 0 ? left : 0
}
export function loginFailed(ip) {
  const now = Date.now()
  const rec = guard.get(ip) || { fails: 0, until: 0, at: now }
  rec.fails += 1
  rec.at = now
  let lockMs = 0
  if (rec.fails >= 15) lockMs = 30 * 60e3
  else if (rec.fails >= 10) lockMs = 5 * 60e3
  else if (rec.fails >= 5) lockMs = 60e3
  if (lockMs) rec.until = now + lockMs
  guard.set(ip, rec)
  saveGuardSoon()
  return { fails: rec.fails, lockMs }
}
export function loginSucceeded(ip) {
  if (guard.delete(ip)) saveGuardSoon()
}

// ── 登录失败审计：内存留最近 20 条给 /api/security，同时写审计日志 ──────────
// 只记 IP / 次数 / 锁定时长，不记用户输入的口令（那是秘密，永远不落盘）。
const recentFails = []
const RECENT_FAILS_MAX = 20
let lastBlockAudit = 0
function noteLoginFail(ip, fails, lockMs) {
  const rec = { at: new Date().toISOString(), ip, fails, lockMs }
  recentFails.push(rec)
  while (recentFails.length > RECENT_FAILS_MAX) recentFails.shift()
  appendAudit('login-fail', rec)
}
export function securitySnapshot() {
  const now = Date.now()
  let locked = 0
  let pendingFails = 0
  for (const rec of guard.values()) {
    if (rec.until > now) locked += 1
    // 注意：这是「还在记账、没被成功登录清掉」的失败次数，不是历史总量；
    // 历史看 recent / 审计日志（login-fail）里的时间线。
    if (now - rec.at < 86400e3) pendingFails += rec.fails
  }
  return { pendingFails, locked, recent: recentFails.slice(-10) }
}

// ── 防跨站：改数据的请求必须同源，或明确带 x-panel-request 头 ──────────────
export function crossSite(req) {
  const origin = String(req.headers.origin || '')
  const host = String(req.headers.host || '')
  if (origin) {
    try { return new URL(origin).host === host ? '' : '来源不对，拒绝跨站请求' } catch { return '来源不对，拒绝跨站请求' }
  }
  const site = String(req.headers['sec-fetch-site'] || '')
  if (site && site !== 'same-origin' && site !== 'none') return '跨站请求被拒'
  if (String(req.headers['x-panel-request'] || '') === 'panel') return ''
  return site ? '' : '缺少防跨站标记'
}

// ── 安全响应头：不管哪种响应都加 ──────────────────────────────────────────
export function applySecurity(res) {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()')
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data: https://q1.qlogo.cn https://p.qlogo.cn; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
}

// ── 登录 / 登出 ───────────────────────────────────────────────────────────
// ── 全局失败节流：口令只有 8 位，公网上换 IP 就能把「每 IP 阶梯锁」绕成无限次 ──
// 只对 public 来源计数（局域网与回环不受影响），10 分钟内累计 20 次失败就全局锁 10 分钟。
// 代价是别人可以用 20 次失败把这扇门挡住（DoS），但那扇门本来就不该被这样敲；
// 主人在家里/局域网不受影响。计数器放内存，重启清零。
const GLOBAL_FAIL_WINDOW_MS = 10 * 60e3
const GLOBAL_FAIL_MAX = 20
const GLOBAL_LOCK_MS = 10 * 60e3
const globalFail = { count: 0, firstAt: 0, until: 0 }
function globalWait() {
  const left = globalFail.until - Date.now()
  return left > 0 ? left : 0
}
function globalFailed() {
  const now = Date.now()
  if (now - globalFail.firstAt > GLOBAL_FAIL_WINDOW_MS) { globalFail.count = 0; globalFail.firstAt = now }
  if (!globalFail.firstAt) globalFail.firstAt = now
  globalFail.count += 1
  if (globalFail.count >= GLOBAL_FAIL_MAX) {
    globalFail.until = now + GLOBAL_LOCK_MS
    globalFail.count = 0
    globalFail.firstAt = now
    logLine('warn: 登录失败次数过多，全局锁定 ' + Math.round(GLOBAL_LOCK_MS / 1000) + ' 秒')
    appendAudit('login-global-lock', { ms: GLOBAL_LOCK_MS })
    return true
  }
  return false
}

export async function handleLogin(req, res) {
  const ip = clientIp(req)
  const bucket = guardKey(ip)
  if (requestScope(req) === 'public') {
    const gw = globalWait()
    if (gw) {
      if (Date.now() - lastBlockAudit > 60e3) {
        lastBlockAudit = Date.now()
        appendAudit('login-global-blocked', { ip, waitMs: gw })
      }
      return sendJson(res, 429, { ok: false, message: '这段时间试错太多了，等 ' + Math.ceil(gw / 1000) + ' 秒再试' })
    }
  }
  const wait = loginBlocked(bucket)
  if (wait) {
    // 锁定期间反复点「进入」会刷屏，同一分钟只记一次。
    if (Date.now() - lastBlockAudit > 60e3) {
      lastBlockAudit = Date.now()
      appendAudit('login-blocked', { ip, waitMs: wait })
    }
    return sendJson(res, 429, { ok: false, message: '试太多次了，等 ' + Math.ceil(wait / 1000) + ' 秒再试' })
  }
  const body = await readBody(req)
  const code = String(body && body.code || '').trim().toLowerCase()
  if (code && sameSecret(code, token)) {
    loginSucceeded(bucket)
    const sid = createSession(req)
    res.setHeader('set-cookie', cookieHeader(sid, req))
    logLine('login ok ip=' + ip)
    appendAudit('login-ok', { ip })
    return sendJson(res, 200, { ok: true })
  }
  const r = loginFailed(bucket)
  if (requestScope(req) === 'public') globalFailed()
  logLine('login FAIL ip=' + ip + ' fails=' + r.fails)
  noteLoginFail(ip, r.fails, r.lockMs)
  const msg = r.lockMs ? '口令不对，已锁 ' + Math.round(r.lockMs / 1000) + ' 秒' : '口令不对，看看电脑上 panel-token.txt'
  return sendJson(res, 401, { ok: false, message: msg })
}
export function handleLogout(req, res) {
  revokeSession(req)
  res.setHeader('set-cookie', clearCookieHeader(req))
  return sendJson(res, 200, { ok: true })
}

// ── 来源分级：公网隧道只读，本机/局域网可写 ────────────────────────────────
// 这是比“登录口令”更强的一道闸：手机在外面通过 trycloudflare 打开时，即使口令
// 泄漏，也只能看和点审批，改不了通讯录/记忆/配置，也不能强制唤醒。
function isPrivateIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '')
  if (!s) return false
  if (s === '::1') return true
  if (s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(s)
  if (!m) return false
  const a = Number(m[1]); const b = Number(m[2])
  if (a === 10) return true
  if (a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  // 100.64.0.0/10 = CGNAT 段，Tailscale 把设备放在这里。
  // 它由 Tailscale 自己认证过（每台设备都登了同一个账号），不是公网可路由地址，
  // 所以按「内网」算：手机在 4G 下走 tailnet 也能写，不用退回只读。
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** 全局可路由的 IPv6（不是回环、不是链路本地、不是 ULA）：这类地址等于「从公网来的」。 */
function isGlobalV6(ip) {
  const s = String(ip || '').trim().toLowerCase()
  if (!s.includes(':')) return false
  if (s === '::1') return false
  if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return false
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(s)) return false
  return true
}

/** 请求来源：local（本机回环） / lan（局域网私网 IP） / public（Cloudflare 隧道或公网）。 */
export function requestScope(req) {
  const h = (req && req.headers) || {}
  const host = String(h.host || '').toLowerCase().split(':')[0]
  const proto = String(h['x-forwarded-proto'] || '').toLowerCase()
  if (h['cf-ray'] || h['cf-connecting-ip'] || h['cdn-loop'] || h['x-forwarded-for'] || proto === 'https' || host.endsWith('trycloudflare.com')) return 'public'
  if (isLoopback(req)) return 'local'
  const ip = String((req && req.socket && req.socket.remoteAddress) || '')
  // 面板能通过公网 IPv6 直接打开：这类地址默认仍是 public（只读），
  // 只有本机白名单里登记过的前缀（家里的 /64、手机运营商 /64）才升权成 lan。
  if (isGlobalV6(ip)) return isAllowedRemote(ip) ? 'lan' : 'public'
  return isPrivateIp(ip) ? 'lan' : 'public'
}

/** 只有本机/局域网能改数据；公网隧道一律只读。 */
export function canWrite(req) {
  return requestScope(req) !== 'public'
}

/** 写接口守卫：公网直接 403，返回 false 时调用方必须 return。 */
export function requireWrite(req, res) {
  if (canWrite(req)) return true
  sendJson(res, 403, {
    ok: false,
    code: 'readonly-public',
    message: '公网隧道只能查看和审批；改数据请在本机或同一 WiFi 下操作'
  })
  return false
}

/**
 * 统一鉴权：所有请求都要有会话；带 ?code= 的换成 Cookie 后重定向；否则给登录页 / 401。
 *
 * 本机不再是法外之地（PITFALLS #208）。两条换取会话的路：
 *   · ?code=<一次性登录码>：面板里点「复制带口令的登录链接」发出去的那种，5 分钟、只能换一次；
 *   · ?code=<原始口令> **且请求来自本机**：本机入口用，避免本机每次还要手输。
 *     只允许本机用，是因为原始口令进了 URL 就会留在浏览器历史/代理日志里，
 *     外面那扇门必须走一次性码。
 */
export function gate(req, res, url) {
  if (validSession(req)) return true
  const qCode = String(url.searchParams.get('code') || '').toLowerCase()
  const rawTokenOk = qCode && isLoopback(req) && sameSecret(qCode, token)
  if (rawTokenOk || (qCode && consumeLoginCode(qCode))) {
    const sid = createSession(req)
    res.setHeader('set-cookie', cookieHeader(sid, req))
    const clean = new URL(url.toString())
    clean.searchParams.delete('code')
    res.writeHead(302, { location: clean.pathname + (clean.search || '') })
    res.end()
    return false
  }
  if (url.pathname === '/login.css' || url.pathname === '/login.js') return true
  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { ok: false, message: '需要口令：刷新页面重新输入' })
    return false
  }
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(loginPageHtml())
  return false
}
