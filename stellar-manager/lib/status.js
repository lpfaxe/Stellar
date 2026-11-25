/* 总览：配置摘要、/api/status 汇总、快捷动作、日志、补丁 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { AUDIT_FILE, BILI, BRIDGE, BRIDGE_CFG, CFG_FILE, KEEPALIVE, LOGS, NODE, PORT, REPO, REPORT_REQ, SNOW, SURF } from './paths.js'
import { clampNum, findWhale, logLine, maskText, portOpen, readJson, readTail, run, todayKey } from './util.js'
import { qzoneStats, readReports } from './report.js'
import { buildHerStatus } from './her.js'
import { buildActivity } from './activity.js'
import { readTownPresence } from './town.js'
import { currentToken, lanAddresses, publicV6Addresses, tailnetAddresses } from './auth.js'
import { HOST } from './paths.js'

/** 面板只绑回环时，局域网/公网的地址都进不来，对外暴露面为零。 */
function hostIsLoopback() {
  const h = String(HOST || '').toLowerCase()
  return h === '127.0.0.1' || h === 'localhost' || h === '::1'
}
import { readAllow } from './remote-allow.js'
import { dshAvailable, readRestartState } from './dsh.js'
import { buildRestartAdvice } from './restart-advice.js'
import { buildTurns } from './turns.js'
import { readState as readCookieGuardState } from './cookie-guard.js'
import { ensureTunnel } from './tunnel.js'
import { isPeakAt, resolvePriceTable } from '../../src/model-prices.js'
import { approvalStatus } from '../../plugins/stellar/lib/image-budget.js'
import { readStop, setStop } from '../../plugins/stellar/lib/emergency-stop.js'

// ── /api/status 缓存 ─────────────────────────────────────────────────────
// buildStatus 每次要跑 tasklist + PowerShell 查计划任务、读一堆文件，几百毫秒。
// 手机常亮轮询 + 电脑页面 + 隧道，重复调用很浪费：1.2 秒内复用同一份结果，
// 同一时刻只跑一次（并发合并）。任何写操作调 invalidateStatus() 让它立刻重算。
const STATUS_TTL_MS = 1200
let statusCache = { at: 0, data: null, gen: 0 }
let statusInflight = null
let statusGen = 0
let cacheHits = 0
let cacheMisses = 0
let cacheCoalesced = 0

export function statusCacheStats() {
  const lookups = cacheHits + cacheMisses + cacheCoalesced
  return {
    ttlMs: STATUS_TTL_MS,
    hits: cacheHits,
    misses: cacheMisses,
    coalesced: cacheCoalesced,
    hitRate: lookups ? Math.round((cacheHits / lookups) * 1000) / 1000 : 0,
    inflight: Boolean(statusInflight),
  }
}

export function invalidateStatus() {
  statusGen += 1
  statusCache = { at: 0, data: null, gen: statusGen }
}

// 峰时（价格 ×2）：北京时间工作日 9–12、14–18；周末与法定节假日全天谷期。
const peakAt = (atMs) => { try { return isPeakAt(Number(atMs) || Date.now()) } catch { return false } }
const slotPeak = (date, atText) => {
  if (!date || !atText) return false
  const ms = new Date(date + 'T' + atText + ':00+08:00').getTime()
  return Number.isFinite(ms) ? peakAt(ms) : false
}

export function summarizeConfig(cfg) {
  return {
    night: cfg.night || {},
    qzone: cfg.qzone || {},
    dynamics: cfg.dynamics || {},
    interact: cfg.interact || {},
    share: cfg.share || {},
    listen: cfg.listen || {},
    fishGuard: cfg.fishGuard || {},
    quota: cfg.quota || {},
    limits: cfg.limits || {},
    report: cfg.report || {},
  }
}

export async function buildStatus({ fresh = false } = {}) {
  const now = Date.now()
  if (!fresh && statusCache.data && now - statusCache.at < STATUS_TTL_MS) {
    cacheHits += 1
    return statusCache.data
  }
  if (statusInflight) {
    cacheCoalesced += 1
    return statusInflight
  }
  cacheMisses += 1
  const gen = statusGen
  statusInflight = collectStatus()
    .then((data) => {
      // 期间发生过写操作（gen 变了）就不要把旧快照塞回缓存，下一次重新算。
      if (gen === statusGen) statusCache = { at: Date.now(), data, gen }
      return data
    })
    .finally(() => { statusInflight = null })
  return statusInflight
}

async function collectStatus() {
  const cfg = readJson(CFG_FILE, {})
  const whale = findWhale()
  const st = whale.state || {}
  const slots = Array.isArray(st.slots) ? st.slots : []
  const ports = {}
  for (const p of [5099, 3000, 3001, 3100]) ports[p] = await portOpen(p)
  const dsh = await run('tasklist', ['/NH'], { timeoutMs: 20000 })
  const taskCmd = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $i = Get-ScheduledTaskInfo -TaskName 'Stellar Keepalive' -ErrorAction Stop; [string]$i.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') + '|' + [string]$i.LastTaskResult"
  // 不加 -ExecutionPolicy Bypass：本机实测带它会挂到超时（30 秒），不带是 0.8 秒。
  // 只读一条计划任务信息用不到改执行策略；加 -NonInteractive 防止等输入。
  const task = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', taskCmd], { timeoutMs: 8000 })
  const taskParts = String(task.out || '').trim().split('|')
  const dshUp = /DeepSeek Harness/i.test(dsh.out || '')
  // 她还有没有回合没收尾（真在跑什么、大概什么时候结束）：从 DSH 遥测尾部现算，读一次给两处用。
  const turns = buildTurns()
  // 她人在不在小镇：只读 status.json（调度器 10 分钟写一次），面板自己绝不联网。
  const town = readTownPresence()
  const lastRun = taskParts[0] || ''
  const lastResult = taskParts[1] || ''
  return {
    now: new Date().toISOString(),
    panelPort: PORT,
    ports,
    snowluma: ports[5099], bridge: ports[3100], onebot: ports[3000] || ports[3001],
    dshRunning: dshUp,
    dsh: { running: dshUp, supported: dshAvailable(), exe: 'D:/dsh/DeepSeek Harness.exe', restart: readRestartState() },
    // 重启时机建议：重启 DSH = 会话重新 seed，整段上下文按未命中重算（见 lib/restart-advice.js）
    restartAdvice: buildRestartAdvice({ dshRunning: dshUp, turns }),
    keepalive: { configured: fs.existsSync(KEEPALIVE), lastRun: lastRun.trim(), lastResult: lastResult.trim() },
    // DSH 桌面端 Cookie 守卫（431 坑）：只在 DSH 退出时清理，这里只读状态
    cookieGuard: readCookieGuardState(),
    config: summarizeConfig(cfg),
    qzone: qzoneStats(),
    report: (() => {
      const today = todayKey()
      const items = readReports(7)
      const latest = items[0] || null
      return { today: today, hasToday: items.some((r) => r.date === today), latestDate: latest ? latest.date : '', count7: items.length, pending: fs.existsSync(REPORT_REQ) }
    })(),
    whale: {
      file: whale.file,
      date: st.date || '',
      action: st.action || '',
      atText: st.atText || '',
      window: st.window || '',
      wakes: Number(st.wakes || 0),
      watched: Number(st.watchWakes || 0),
      cap: Number(st.cap || cfg.night?.maxWakesPerDay || 0),
      maxVideos: Number(st.maxVideos || cfg.night?.maxVideos || 0),
      slots: slots.map((s) => ({ id: s.id, atText: s.atText, window: s.window, action: s.action, status: s.status, kind: s.kind, peak: slotPeak(st.date, s.atText) })),
      wakeSlots: slots.filter((s) => s.action === 'wake').length,
      doneWakes: slots.filter((s) => s.action === 'wake' && s.status === 'fired').length,
      perWake: slots.filter((s) => s.action === 'wake').length ? Math.max(1, Math.round((cfg.night?.videoTargetPerDay || 40) / slots.filter((s) => s.action === 'wake').length)) : 0,
    },
    // 现在是不是价格谷期（生物钟只在谷期叫醒）
    // 倍数从价目表取（内置 2，但 config.json 的 pricing.peakMultiplier 可以改）
    pricing: (() => {
      const peak = peakAt(Date.now())
      let mult = 1
      try { mult = Number(resolvePriceTable(readJson(BRIDGE_CFG, {})?.pricing).peakMultiplier) || 1 } catch { mult = 1 }
      return { peak, multiplier: mult, label: peak ? '峰时 ×' + mult : '谷期 ×1' }
    })(),
    her: buildHerStatus(),
    activity: buildActivity({ turns, town }),
    // 在场快照（inTown / ageMs / detail）：面板与「重启时机」都能直接读，不用再拼一次
    townPresence: town,
    turns,
    // 紧急停止 + 生图额度（2026-11-11 owner 拍板：手动停、**不再自动恢复**；生图 3 张/天）
    stop: readStop(),
    imageBudget: approvalStatus(),
    configMtime: (() => { try { return fs.statSync(CFG_FILE).mtimeMs } catch { return 0 } })(),
    paths: { repo: REPO, stellar: SURF, config: CFG_FILE },
    access: {
      urls: lanAddresses().map((a) => 'http://' + a.address + ':' + PORT + '/'),
      // 装了 Tailscale 才会非空：这是不走公网的固定入口，比隧道 URL 稳。
      tailnetUrls: tailnetAddresses().map((a) => 'http://' + a.address + ':' + PORT + '/'),
      // 公网 IPv6 直连：只有面板确实绑在非回环地址上时才可达。
      // 默认 HOST=127.0.0.1（见 lib/paths.js），这时报地址等于骗人——手机上打不开的链接比没有链接更糟。
      v6Urls: hostIsLoopback() ? [] : publicV6Addresses().map((a) => 'http://[' + a.address + ']:' + PORT + '/'),
      remoteAllow: { prefixes: readAllow().prefixes, writable: readAllow().prefixes.length > 0 },
      token: currentToken(),
      port: PORT,
      tunnel: ensureTunnel(),
    },
  }
}

export function actionStop({ active, by = 'panel', reason = '' } = {}) {
  const state = setStop({ active: active !== false, by, reason })
  logLine(active !== false ? 'emergency stop ON' : 'emergency stop OFF')
  return { ok: true, stop: state }
}

export function actionKeepalive() {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', KEEPALIVE, '-Force'], { timeoutMs: 180000 })
}

export async function actionStartSnowluma() {
  if (await portOpen(5099)) return { ok: true, message: 'SnowLuma 已经在运行（5099 在听）' }
  spawn('cmd.exe', ['/c', 'start', '', '/min', path.join(SNOW, 'launcher.bat')], { cwd: SNOW, detached: true, stdio: 'ignore', windowsHide: true }).unref()
  logLine('start snowluma')
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await portOpen(5099)) return { ok: true, message: 'SnowLuma 已启动（5099 在听）' }
  }
  return { ok: false, message: 'SnowLuma 启动超时，稍后看 keepalive.log' }
}

// SnowLuma 单实例：清掉多余/挂掉的 launcher 链（node.exe / cmd.exe），保留真正占着 5099 的那套
export async function actionCleanSnowluma() {
  const guard = path.join(SURF, 'snowluma-guard.ps1')
  if (!fs.existsSync(guard)) return { ok: false, message: '找不到单实例守护脚本：' + guard }
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guard, '-Json'], { timeoutMs: 120000 })
  logLine('snowluma guard exit=' + r.code)
  let j = null
  try {
    const line = String(r.out || '').trim().split('\n').filter(Boolean).pop()
    j = JSON.parse(line)
  } catch {}
  if (!j) return { ok: r.code === 0, message: ((r.out || '') + (r.err || '')).slice(-2000) || '清理脚本没返回结果，看 snowluma-guard.log' }
  const killed = Array.isArray(j.killedList) ? j.killedList : []
  const port = Number(j.port5099 || 0)
  const head = port ? '现在只剩一套（5099 属于 pid ' + port + '）' : '5099 现在没有监听'
  return {
    ok: true,
    killed: killed.length,
    port5099: port,
    started: j.started === true,
    message: killed.length ? '清掉了 ' + killed.length + ' 个多余/挂掉的进程：' + killed.join('、') + '。' + head : '没有多余的实例，' + head,
  }
}
export async function actionStartBridge() {
  if (await portOpen(3100)) return { ok: true, message: '桥接已经在运行（3100 在听）' }
  const child = spawn(NODE, [BRIDGE], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await portOpen(3100)) return { ok: true, message: '桥接已启动（3100 在听）' }
  }
  return { ok: false, message: '桥接启动超时，看 state/bridge.log' }
}

export async function actionQzone(body) {
  const text = String(body.text || '').trim()
  if (!text) return { ok: false, message: '正文不能为空' }
  if (text.length > 900) return { ok: false, message: '正文最多 900 字' }
  const args = [BILI, 'qzone', 'post', '--text', text, '--right', String(body.right || 4)]
  if (body.image) args.push('--image', String(body.image))
  args.push(body.go === true ? '--go' : '--dry')
  const r = await run(NODE, args, { cwd: path.join(REPO, 'plugins', 'stellar', 'tools'), timeoutMs: 180000 })
  logLine('qzone post ' + (body.go === true ? 'go' : 'dry') + ' exit=' + r.code)
  return { ok: r.code === 0, message: (r.out + r.err).slice(-4000) }
}

export async function actionReplan() {
  const whale = findWhale()
  if (whale.file) { try { fs.rmSync(whale.file, { force: true }) } catch {} }
  const r = await run(NODE, [BILI, 'night', 'plan'], { cwd: path.join(REPO, 'plugins', 'stellar', 'tools'), timeoutMs: 120000 })
  logLine('night replan exit=' + r.code)
  return { ok: r.code === 0, message: (r.out + r.err).slice(-4000) }
}

// 只读文件尾巴：bridge.log / keepalive.log 能长到几十 MB，整读会卡住事件循环。
// readTail 会丢掉开头那半行，避免把截断的 JSON/时间戳显示出来。
export function readLog(name, lines) {
  const file = LOGS[name]
  if (!file) return ''
  if (!fs.existsSync(file)) return '(日志还没生成：' + file + ')'
  const all = readTail(file, 512 * 1024).split('\n')
  if (all.length && all[all.length - 1] === '') all.pop()
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

export function applyPatch(cfg, body) {
  const night = body.night || {}
  if (night.windows && Array.isArray(night.windows)) {
    const wins = night.windows
      .filter((w) => w && w.start && w.end)
      .slice(0, 8)
      .map((w) => ({ start: String(w.start), end: String(w.end), wakes: clampNum(w.wakes, 0, 4, 1) }))
    if (wins.length) cfg.night.windows = wins
  }
  for (const key of ['maxWakesPerDay', 'videoTargetPerDay', 'maxVideos', 'minGapMin']) {
    if (night[key] !== undefined) {
      const max = key === 'videoTargetPerDay' ? 200 : (key === 'maxVideos' ? 30 : (key === 'minGapMin' ? 240 : 12))
      cfg.night[key] = clampNum(night[key], 0, max, cfg.night[key])
    }
  }
  if (night.skipChance !== undefined) cfg.night.skipChance = clampNum(night.skipChance, 0, 1, 0.05)
  if (night.frames !== undefined) cfg.night.frames = String(night.frames) === 'auto' ? 'auto' : 'none'
  const qz = body.qzone || {}
  if (qz.enabled !== undefined) cfg.qzone.enabled = Boolean(qz.enabled)
  if (qz.time !== undefined && /^\d{1,2}:\d{2}$/.test(String(qz.time))) cfg.qzone.time = String(qz.time)
  if (qz.dailyLimit !== undefined) cfg.qzone.dailyLimit = clampNum(qz.dailyLimit, 1, 10, 2)
  if (qz.watch !== undefined) cfg.qzone.watch = Boolean(qz.watch)
  if (qz.weekly && qz.weekly.min !== undefined) cfg.qzone.weekly = { enabled: true, min: clampNum(qz.weekly.min, 1, 21, 7) }
  const toggles = body.toggles || {}
  if (toggles.dynamics !== undefined) cfg.dynamics.enabled = Boolean(toggles.dynamics)
  if (toggles.interact !== undefined) cfg.interact.enabled = Boolean(toggles.interact)
  if (toggles.share !== undefined) cfg.share.enabled = Boolean(toggles.share)
  if (toggles.fishGuard !== undefined) cfg.fishGuard.enabled = Boolean(toggles.fishGuard)
  return cfg
}

export const JSONL_SOURCES = {
  events: path.join(SURF, 'state', 'panel-events.jsonl'),
  toolcalls: path.join(REPO, 'state', 'tool-calls.jsonl'),
  qzone: path.join(SURF, 'state', 'qzone-log.jsonl'),
  reports: path.join(SURF, 'state', 'reports.jsonl'),
  telemetry: path.join(REPO, 'state', 'context-telemetry-bridge.jsonl'),
  audit: AUDIT_FILE,
}
export const JSONL_LABELS = { events: '面板事件', toolcalls: '工具调用', qzone: '空间操作', reports: '日报', telemetry: '上下文遥测', audit: '操作审计' }

export function buildJsonlLog({ name = 'toolcalls', type = '', q = '', limit = 50, offset = 0 } = {}) {
  const file = JSONL_SOURCES[name]
  if (!file) return { ok: false, message: '不支持的日志：' + name }
  const lines = readTail(file).split('\n').filter((line) => line.trim())
  const needle = String(q || '').trim().toLowerCase()
  const items = []
  let total = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry
    try { entry = JSON.parse(lines[i]) } catch { continue }
    const kind = String(entry.type || entry.k || entry.kind || entry.action || '')
    if (type && kind !== type) continue
    const flat = JSON.stringify(entry)
    if (needle && !flat.toLowerCase().includes(needle)) continue
    total += 1
    if (items.length >= offset + limit) continue
    items.push({ at: entry.time || entry.at || entry.t || '', kind, text: maskText(describeEvent(entry), 400) })
  }
  return { ok: true, name, label: JSONL_LABELS[name] || name, total, offset, limit, items }
}

export function describeEvent(entry) {
  if (!entry || typeof entry !== 'object') return String(entry)
  if (entry.tool) {
    const args = entry.args && typeof entry.args === 'object' ? Object.keys(entry.args).join(',') : ''
    return entry.tool + (args ? ' (' + args + ')' : '') + (entry.ok === false ? ' [失败]' : '')
  }
  if (entry.text) return String(entry.text)
  if (entry.payload) return JSON.stringify(entry.payload)
  const clone = { ...entry }
  for (const key of ['time', 'at', 't', 'type', 'k', 'kind']) delete clone[key]
  return JSON.stringify(clone)
}

/** 日 / 周 / 月预聚合：从 token 账本按天累加（价目用面板里显示的那三档单价）。 */
