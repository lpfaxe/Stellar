/* 夜间电源：把「晚上不用她」变成一条可撤销的计划任务（睡 / 休眠 + 早上唤醒）。
 *
 * 为什么不是「只停机器人」：停机器人后主机仍在跑，风扇、Wi-Fi、Windows 更新照旧；
 * 主人要的是整台电脑省电，所以这里调度的是一天两次的电源动作：
 *   23:50  睡眠（rundll32 SetSuspendState）
 *   06:05  唤醒（计划任务 + WakeToRun，跑一次 cmd /c exit 就够）
 *
 * 安全边界：
 * - 这是面板写操作，公网隧道来源会被 requireWrite 判 403（与现有「公网只读」一致）。
 * - 休眠在这台机器上默认没启用（HibernateEnabled=0），所以默认只给睡眠；
 *   选休眠会先查注册表，没开就明确拒绝，不偷偷打开休眠。
 * - 测试用 STELLAR_POWER_DRY=1：只写 plan 文件，不碰真实计划任务、不真的睡。
 */
import fs from 'node:fs'
import path from 'node:path'
import { SURF } from './paths.js'
import { atomicWriteJson, logLine, readJson, run } from './util.js'

export const PLAN_FILE = path.join(SURF, 'state', 'power-plan.json')
export const SLEEP_TASK = 'Stellar Night Sleep'
// 专用的唤醒任务名：机器上原本就有一条「Stellar Morning Wake」06:00 保活任务（断电恢复用），
// 这里绝不覆盖/删除它；关掉夜间电源时只清掉我们自己建的两条。
export const WAKE_TASK = 'Stellar Night Wake'
export const NOW_TASK = 'Stellar Power Now'
export const DEFAULT_PLAN = Object.freeze({
  version: 1,
  enabled: false,
  sleepAt: '23:50',
  wakeAt: '06:05',
  mode: 'sleep',
  updatedAt: '',
  updatedBy: ''
})
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function dryRun() {
  return process.env.STELLAR_POWER_DRY === '1'
}

export function normalizeTime(value, fallback) {
  const s = String(value || '').trim()
  if (!TIME_RE.test(s)) return fallback
  return s
}

export function normalizePlan(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  return {
    version: 1,
    enabled: r.enabled === true,
    sleepAt: normalizeTime(r.sleepAt, DEFAULT_PLAN.sleepAt),
    wakeAt: normalizeTime(r.wakeAt, DEFAULT_PLAN.wakeAt),
    mode: r.mode === 'hibernate' ? 'hibernate' : 'sleep',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : ''
  }
}

export function readPowerPlan() {
  return normalizePlan(readJson(PLAN_FILE, DEFAULT_PLAN))
}

/** 本地时区的下一次 HH:mm；已过就顺延到明天。返回 Date。 */
export function nextTimeAt(hhmm, from = new Date()) {
  const [h, m] = String(hhmm || DEFAULT_PLAN.sleepAt).split(':').map(Number)
  const d = new Date(from.getTime())
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= from.getTime() + 1000) d.setDate(d.getDate() + 1)
  return d
}

/** 今晚的睡眠与明早的唤醒：唤醒若不在睡眠之后，顺延一天。 */
export function nextRuns(plan, from = new Date()) {
  const p = normalizePlan(plan)
  const sleep = nextTimeAt(p.sleepAt, from)
  let wake = nextTimeAt(p.wakeAt, sleep)
  if (wake.getTime() <= sleep.getTime()) wake = new Date(wake.getTime() + 86400000)
  return { sleepAt: sleep.toISOString(), wakeAt: wake.toISOString() }
}

async function hibernateEnabled() {
  if (dryRun()) return false
  try {
    const r = await run('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Power', '/v', 'HibernateEnabled'], { timeoutMs: 8000 })
    if (r.code !== 0) return false
    return /HibernateEnabled\s+REG_DWORD\s+0x1/i.test(r.out)
  } catch { return false }
}

async function taskExists(name) {
  if (dryRun()) return false
  const r = await run('schtasks.exe', ['/query', '/tn', name], { timeoutMs: 12000 })
  return r.code === 0
}

async function createTask(name, hhmm, tr, { wake = false } = {}) {
  if (dryRun()) return { ok: true, dryRun: true }
  const r = await run('schtasks.exe', ['/create', '/tn', name, '/tr', tr, '/sc', 'daily', '/st', hhmm, '/f'], { timeoutMs: 20000 })
  if (r.code !== 0) {
    throw new Error('注册计划任务「' + name + '」失败：' + String(r.err || r.out || ('exit ' + r.code)).trim())
  }
  const extra = wake ? ' -WakeToRun' : ''
  const ps = '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable' + extra + '; Set-ScheduledTask -TaskName \'' + name + '\' -Settings $s | Out-Null'
  const p = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 30000 })
  if (p.code !== 0) {
    await deleteTask(name)
    throw new Error('设置计划任务「' + name + '」失败：' + String(p.err || p.out || ('exit ' + p.code)).trim())
  }
  return { ok: true }
}

async function deleteTask(name) {
  if (dryRun()) return { ok: true, dryRun: true }
  if (!(await taskExists(name))) return { ok: true, missing: true }
  const r = await run('schtasks.exe', ['/delete', '/tn', name, '/f'], { timeoutMs: 12000 })
  if (r.code === 0) return { ok: true }
  return { ok: false, detail: String(r.err || r.out || ('exit ' + r.code)).trim() }
}

function taskCommand(mode) {
  const win = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const dir = path.join(win, 'System32')
  if (mode === 'wake') return path.join(dir, 'cmd.exe') + ' /c exit'
  if (mode === 'hibernate') return path.join(dir, 'shutdown.exe') + ' /h'
  return path.join(dir, 'rundll32.exe') + ' powrprof.dll,SetSuspendState 0,1,0'
}

export async function powerStatus() {
  const plan = readPowerPlan()
  const [hib, sleepTask, wakeTask] = await Promise.all([hibernateEnabled(), taskExists(SLEEP_TASK), taskExists(WAKE_TASK)])
  return {
    ok: true,
    plan,
    capabilities: { sleep: true, hibernate: hib, defaultMode: hib ? 'hibernate' : 'sleep' },
    tasks: {
      sleep: { name: SLEEP_TASK, registered: sleepTask },
      wake: { name: WAKE_TASK, registered: wakeTask }
    },
    next: plan.enabled ? nextRuns(plan) : null,
    dryRun: dryRun()
  }
}

export async function savePowerPlan(input = {}, { by = 'panel' } = {}) {
  const current = readPowerPlan()
  const raw = { ...current, ...input }
  const plan = normalizePlan(raw)
  if (!TIME_RE.test(String(raw.sleepAt || '').trim())) throw new Error('睡眠时间要写成 HH:MM（例如 23:50）')
  if (!TIME_RE.test(String(raw.wakeAt || '').trim())) throw new Error('唤醒时间要写成 HH:MM（例如 06:05）')
  if (plan.sleepAt === plan.wakeAt) throw new Error('睡眠和唤醒不能是同一分钟')
  if (plan.enabled && plan.mode === 'hibernate' && !(await hibernateEnabled())) {
    throw new Error('这台电脑的休眠没启用（HibernateEnabled=0）。先选择「睡眠」，或以管理员运行 powercfg /hibernate on')
  }

  if (plan.enabled) {
    // 先建唤醒、再建睡眠：反过来一旦唤醒任务失败，机器会在「今晚会睡、明早不会醒」的状态。
    await createTask(WAKE_TASK, plan.wakeAt, taskCommand('wake'), { wake: true })
    await createTask(SLEEP_TASK, plan.sleepAt, taskCommand(plan.mode), { wake: false })
  } else {
    // 先删睡眠：删不掉就直接报错，绝不能让「已经点了关闭」的机器照旧每晚睡下去。
    const goneSleep = await deleteTask(SLEEP_TASK)
    if (!goneSleep.ok) throw new Error('删除睡眠计划任务失败：' + (goneSleep.detail || '未知错误'))
    const goneWake = await deleteTask(WAKE_TASK)
    if (!goneWake.ok) throw new Error('删除唤醒计划任务失败：' + (goneWake.detail || '未知错误'))
  }

  const out = { ...plan, updatedAt: new Date().toISOString(), updatedBy: String(by) }
  atomicWriteJson(PLAN_FILE, out)
  logLine('power-plan ' + (out.enabled ? 'enabled' : 'disabled') + ' sleep=' + out.sleepAt + ' wake=' + out.wakeAt + ' mode=' + out.mode + ' by=' + out.updatedBy)
  return powerStatus()
}

/** 立即睡 / 休眠：面板先回包，3 秒后由一次性计划任务执行（进程自己睡下去就发不出响应了）。 */
export async function sleepNow({ mode = 'sleep', by = 'panel' } = {}) {
  const m = mode === 'hibernate' ? 'hibernate' : 'sleep'
  if (m === 'hibernate' && !(await hibernateEnabled())) {
    throw new Error('这台电脑的休眠没启用（HibernateEnabled=0）。先选择「睡眠」，或以管理员运行 powercfg /hibernate on')
  }
  if (dryRun()) {
    logLine('power-now dry-run mode=' + m + ' by=' + by)
    return { ok: true, dryRun: true, mode: m }
  }
  const cmdFile = path.join(SURF, 'state', 'power-now.cmd')
  const line = taskCommand(m)
  fs.mkdirSync(path.dirname(cmdFile), { recursive: true })
  fs.writeFileSync(cmdFile, '@echo off\r\ntimeout /t 3 /nobreak >nul\r\n' + line + '\r\n', 'ascii')
  const at = new Date(Date.now() + 2 * 60000)
  const clock = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0')
  const r = await run('schtasks.exe', ['/create', '/tn', NOW_TASK, '/tr', cmdFile, '/sc', 'once', '/st', clock, '/f'], { timeoutMs: 20000 })
  if (r.code !== 0) throw new Error('安排「现在睡眠」失败：' + String(r.err || r.out || ('exit ' + r.code)).trim())
  const ps = '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; Set-ScheduledTask -TaskName \'' + NOW_TASK + '\' -Settings $s | Out-Null'
  const p = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 30000 })
  if (p.code !== 0) {
    await deleteTask(NOW_TASK)
    throw new Error('设置「现在睡眠」失败：' + String(p.err || p.out || ('exit ' + p.code)).trim())
  }
  const started = await run('schtasks.exe', ['/run', '/tn', NOW_TASK], { timeoutMs: 12000 })
  if (started.code !== 0) {
    await deleteTask(NOW_TASK)
    throw new Error('启动「现在睡眠」失败：' + String(started.err || started.out || ('exit ' + started.code)).trim())
  }
  logLine('power-now mode=' + m + ' by=' + by)
  const timer = setTimeout(() => { deleteTask(NOW_TASK).catch(() => {}) }, 120000)
  if (timer.unref) timer.unref()
  return { ok: true, mode: m, delayMs: 3000 }
}
