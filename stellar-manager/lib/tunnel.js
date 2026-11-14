/* 远程访问：cloudflared 快速隧道 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CLOUDFLARED, PORT, SURF, TUNNEL_FILE, TUNNEL_LOG } from './paths.js'
import { logLine, readJson } from './util.js'
import { hardenSensitiveFile } from '../../src/state-acl.mjs'

// ── 远程访问：cloudflared 快速隧道 ─────────────────────────────────────────
// cloudflared 用 detached 方式起，输出写到 state/cloudflared.log：
// 这样面板/DSH 重启时隧道进程还在，公网地址也不会变；面板只负责“看日志 + 兜底重启”。
export const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
// 两种远程方式：
//   quick  = Cloudflare 快速隧道，地址每次变，只适合临时看一眼；
//   named  = 自己账号里的命名隧道（cloudflared tunnel run --token），域名固定，能配 Access。
// token 单独存一个文件（并收紧 ACL），不跟 url 混在 panel-tunnel.json 里。
export const TUNNEL_TOKEN_FILE = path.join(SURF, 'state', 'cloudflare-tunnel-token.txt')
export const tunnel = { enabled: false, url: '', at: 0, pid: 0, error: '', mode: 'quick', hostname: '', token: '' }

export function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function tunnelState() {
  return {
    enabled: tunnel.enabled,
    // 命名隧道没在跑时也可以给出固定入口（域名是 Cloudflare 侧配的，不依赖进程）
    url: tunnel.url || (tunnel.mode === 'named' && tunnel.hostname ? 'https://' + tunnel.hostname : ''),
    running: pidAlive(tunnel.pid),
    error: tunnel.error,
    at: tunnel.at,
    pid: tunnel.pid,
    mode: tunnel.mode === 'named' ? 'named' : 'quick',
    hostname: tunnel.hostname || '',
    hasToken: Boolean(tunnel.token),
    // 「固定地址」= 命名隧道；快速隧道重启就换 URL，长连着用不靠谱。
    permanent: tunnel.mode === 'named' && Boolean(tunnel.hostname),
    binary: fs.existsSync(CLOUDFLARED),
    binaryPath: CLOUDFLARED,
    log: TUNNEL_LOG,
  }
}

function loadTunnelToken() {
  try { return String(fs.readFileSync(TUNNEL_TOKEN_FILE, 'utf8') || '').trim() } catch { return '' }
}

/** 保存命名隧道配置：token 写单独文件并收紧 ACL，hostname 进 panel-tunnel.json。 */
export function setNamedTunnel({ token, hostname } = {}) {
  const t = String(token || '').trim()
  const h = String(hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (t && t.length < 40) return { ok: false, message: '这条 token 太短了，cloudflared 的隧道 token 一般有上百个字符，复制完整的' }
  if (t && !/^[A-Za-z0-9+/=_.-]{40,}$/.test(t)) return { ok: false, message: 'token 里出现了不认识的字符，重新从 Cloudflare Zero Trust 面板复制一次' }
  if (h && !/^[a-z0-9][a-z0-9.-]{3,80}\.[a-z]{2,}$/.test(h)) return { ok: false, message: '域名要写成 panel.example.com 这样（不带 http:// 和结尾斜杠）' }
  // 第一次配命名隧道必须有 token（没有 token 就只能用快速隧道，别静默改模式）
  if (!t && !tunnel.token) return { ok: false, message: '先把隧道 token 填上（第一次配置必须有它），只想用临时地址就用快速隧道' }
  if (t) {
    try {
      fs.mkdirSync(path.dirname(TUNNEL_TOKEN_FILE), { recursive: true })
      fs.writeFileSync(TUNNEL_TOKEN_FILE, t + '\n', { mode: 0o600 })
      const hr = hardenSensitiveFile(TUNNEL_TOKEN_FILE)
      if (!hr.ok) logLine('warn: 收紧隧道 token ACL 失败（' + (hr.detail || '') + '）')
    } catch (error) {
      return { ok: false, message: 'token 存不进去：' + String((error && error.message) || error) }
    }
    tunnel.token = t
    tunnel.mode = 'named'
  }
  if (hostname !== undefined) tunnel.hostname = h
  if (!t && !tunnel.token) tunnel.mode = 'quick'
  saveTunnelState()
  logLine('tunnel config mode=' + tunnel.mode + ' host=' + (tunnel.hostname || '-') + ' token=' + (tunnel.token ? 'set' : 'none'))
  return { ok: true, message: tunnel.mode === 'named' ? '命名隧道配置已保存，点「开启远程访问」换过去' : '已切回快速隧道', tunnel: tunnelState() }
}

/** 切回快速隧道（清掉 token 与固定域名）。 */
export function clearNamedTunnel() {
  tunnel.token = ''
  tunnel.mode = 'quick'
  tunnel.hostname = ''
  try { fs.rmSync(TUNNEL_TOKEN_FILE, { force: true }) } catch {}
  saveTunnelState()
  return { ok: true, message: '已切回快速隧道（地址每次重启会变）', tunnel: tunnelState() }
}

export function saveTunnelState() {
  try {
    fs.mkdirSync(path.dirname(TUNNEL_FILE), { recursive: true })
    fs.writeFileSync(TUNNEL_FILE, JSON.stringify({ enabled: tunnel.enabled, url: tunnel.url, at: tunnel.at, pid: tunnel.pid, mode: tunnel.mode, hostname: tunnel.hostname }, null, 2) + '\n')
  } catch {}
}

export function readTunnelLogUrl() {
  try {
    const size = fs.statSync(TUNNEL_LOG).size
    const start = Math.max(0, size - 200 * 1024)
    const fd = fs.openSync(TUNNEL_LOG, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const text = buf.toString()
    const all = text.match(new RegExp(TUNNEL_RE.source, 'gi'))
    return all && all.length ? all[all.length - 1] : ''
  } catch { return '' }
}

export function spawnTunnel() {
  try {
    fs.mkdirSync(path.dirname(TUNNEL_LOG), { recursive: true })
    if (fs.existsSync(TUNNEL_LOG) && fs.statSync(TUNNEL_LOG).size > 2 * 1024 * 1024) fs.truncateSync(TUNNEL_LOG, 0)
    const fd = fs.openSync(TUNNEL_LOG, 'a')
    // 命名隧道：cloudflared tunnel run --token xxx（路由在 Cloudflare 侧配好，指到 127.0.0.1:3300）
    // 快速隧道：cloudflared tunnel --url http://127.0.0.1:3300（地址每次变）
    if (tunnel.mode === 'named' && !tunnel.token) {
      tunnel.error = '命名隧道的 token 不在（看 state/cloudflare-tunnel-token.txt），先重新填一次'
      logLine('tunnel spawn skipped: named mode without token')
      return false
    }
    const named = tunnel.mode === 'named' && tunnel.token
    const args = named
      ? ['tunnel', '--no-autoupdate', 'run', '--token', tunnel.token]
      : ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:' + PORT]
    const child = spawn(CLOUDFLARED, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    try { fs.closeSync(fd) } catch {}
    tunnel.pid = child.pid || 0
    tunnel.url = named && tunnel.hostname ? 'https://' + tunnel.hostname : ''
    tunnel.at = Date.now()
    tunnel.error = ''
    saveTunnelState()
    logLine('tunnel spawn pid=' + tunnel.pid + ' mode=' + (named ? 'named' : 'quick') + ' port=' + PORT)
    return true
  } catch (error) {
    tunnel.error = String((error && error.message) || error)
    logLine('tunnel spawn failed ' + tunnel.error)
    return false
  }
}

export function startTunnel() {
  if (!fs.existsSync(CLOUDFLARED)) {
    tunnel.error = '缺 cloudflared.exe'
    return { ok: false, message: '还没有 cloudflared.exe（' + CLOUDFLARED + '）', tunnel: tunnelState() }
  }
  tunnel.enabled = true
  if (!pidAlive(tunnel.pid)) {
    // 起不来就别回 ok（否则面板显示「已开启」但根本没有通道）
    if (!spawnTunnel()) return { ok: false, message: tunnel.error || '隧道没起来', tunnel: tunnelState() }
  } else if (!tunnel.url) tunnel.url = tunnel.mode === 'named' && tunnel.hostname ? 'https://' + tunnel.hostname : readTunnelLogUrl()
  return { ok: true, message: '隧道已开启，十几秒后这里会出现公网地址', tunnel: tunnelState() }
}

/** 快速隧道的地址是 cloudflared 打印在日志里的；重启后必须重新读，否则面板一直显示上一轮的旧地址。 */
export function refreshTunnelUrl() {
  if (tunnel.mode !== 'quick') return tunnel.url;
  const fresh = readTunnelLogUrl()
  if (fresh && fresh !== tunnel.url) {
    tunnel.url = fresh
    saveTunnelState()
    logLine('tunnel url updated ' + fresh)
    notifyOwnerUrl(fresh).catch(() => {})
  }
  return tunnel.url
}

/** 快速隧道会被 Cloudflare 回收（日志里是 Unauthorized: Tunnel not found）——那种地址打不开，要重开一条并换地址。 */
function tunnelLogTail(bytes = 64 * 1024) {
  try {
    const size = fs.statSync(TUNNEL_LOG).size
    const start = Math.max(0, size - bytes)
    const fd = fs.openSync(TUNNEL_LOG, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString()
  } catch { return '' }
}



/** 地址变了就私聊发给主人（走桥接控制台 /api/notify/owner，不允许带 agent 令牌）。 */
async function notifyOwnerUrl(url) {
  if (!url) return { ok: false, message: '没有地址' }
  try {
    const { BRIDGE_CONSOLE, BRIDGE_CFG } = await import('./paths.js')
    const cfg = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'))
    const token = String(cfg.consoleToken || '').trim()
    if (!token) return { ok: false, message: '桥接配置里没有 consoleToken' }
    const res = await fetch(BRIDGE_CONSOLE + '/api/notify/owner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({
        title: '面板地址变了',
        message: '新的公网地址（旧的已经失效）：' + url + String.fromCharCode(10) +
          '手机直接点开，输 8 位口令；地址会变，认准这条最新的。'
      }),
      signal: AbortSignal.timeout(10000)
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) return { ok: false, message: data.error || ('HTTP ' + res.status) }
    logLine('tunnel url pushed to owner')
    return { ok: true }
  } catch (error) {
    logLine('tunnel url push failed ' + String((error && error.message) || error))
    return { ok: false, message: String((error && error.message) || error) }
  }
}
export function stopTunnel() {
  tunnel.enabled = false
  if (pidAlive(tunnel.pid)) {
    try { spawn('taskkill.exe', ['/PID', String(tunnel.pid), '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
  tunnel.pid = 0
  tunnel.url = ''
  tunnel.error = ''
  saveTunnelState()
  logLine('tunnel stop')
  return { ok: true, message: '已关闭远程访问', tunnel: tunnelState() }
}

let lastEnsureAt = 0
const ENSURE_INTERVAL_MS = 30 * 1000

/**
 * 面板每次拉状态都会调它（30 秒节流），回当前状态。
 * 三件事：进程还在不在；快速隧道地址有没有被 Cloudflare 回收；地址要不要按日志更新。
 * 为什么要有「回收」这一条：quick tunnel 会被服务端吊销，日志里是
 * "Unauthorized: Tunnel not found"，此时 cloudflared 还活着、面板还显示旧地址，
 * 手机打开就是一个打不开的域名 —— 必须换一条新的并换地址。
 * 这里不做 DNS 探测：手机打不开未必是本地的问题，但 Tunnel not found 一定是。
 */
export function ensureTunnel() {
  if (!tunnel.enabled) return tunnelState()
  const now = Date.now()
  if (now - lastEnsureAt < ENSURE_INTERVAL_MS) return tunnelState()
  lastEnsureAt = now
  if (!pidAlive(tunnel.pid)) {
    if (tunnel.pid) logLine('tunnel process gone, restart')
    tunnel.pid = 0
    tunnel.url = ''
    if (fs.existsSync(CLOUDFLARED)) {
      if (spawnTunnel()) setTimeout(() => refreshTunnelUrl(), 9000).unref?.()
    }
    return tunnelState()
  }
  if (tunnel.mode === 'quick') {
    const tail = tunnelLogTail()
    const fresh = readTunnelLogUrl()
    const revoked = /Unauthorized: Tunnel not found/i.test(tail.slice(-4000))
    const recovered = fresh && fresh !== tunnel.url && /Registered tunnel connection/i.test(tail.slice(-2000))
    if (revoked && !recovered) {
      logLine('快速隧道被回收（Tunnel not found），换一条新的')
      try { spawn('taskkill.exe', ['/PID', String(tunnel.pid), '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
      tunnel.pid = 0
      tunnel.url = ''
      if (spawnTunnel()) setTimeout(() => refreshTunnelUrl(), 9000).unref?.()
      return tunnelState()
    }
    refreshTunnelUrl()
  }
  return tunnelState()
}

export function resumeTunnel() {
  const st = readJson(TUNNEL_FILE, null)
  if (!st || !st.enabled) return
  tunnel.enabled = true
  tunnel.pid = Number(st.pid || 0)
  tunnel.url = String(st.url || '')
  tunnel.at = Number(st.at || 0)
  tunnel.mode = String(st.mode || 'quick') === 'named' ? 'named' : 'quick'
  tunnel.hostname = String(st.hostname || '')
  tunnel.token = loadTunnelToken()
  if (!pidAlive(tunnel.pid)) { tunnel.pid = 0; tunnel.url = '' }
  ensureTunnel()
  if (!tunnel.url) { const u = readTunnelLogUrl(); if (u) { tunnel.url = u; saveTunnelState() } }
  logLine('tunnel resume url=' + (tunnel.url || '(waiting)') + ' pid=' + tunnel.pid)
}

