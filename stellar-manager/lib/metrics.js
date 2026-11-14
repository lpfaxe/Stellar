/* 运行指标 + 结构化事件：只放内存，重启清零；给 /api/metrics 和慢请求日志用。
 * 为什么不用 Prometheus 客户端：面板是零依赖、单进程的小服务，一个 Map 就够，
 * 少一个依赖就少一次 npm 升级带来的不确定性。 */
import fs from 'node:fs'
import path from 'node:path'
import { SURF } from './paths.js'

export const EVENTS_FILE = path.join(SURF, 'state', 'panel-events.jsonl')
const MAX_DURATIONS = 2000
export const SLOW_MS = 1200

const startedAt = Date.now()
const durations = []
const byStatus = new Map()
const byPath = new Map()
let total = 0
let errors = 0
let slow = 0

/** 只按路由归类：静态资源合成一条，避免把 /js/*.js 拆成几十个键。 */
export function normalizePath(pathname) {
  const s = String(pathname || '/')
  if (!s.startsWith('/api/')) return 'static'
  return s.split('?')[0]
}

export function recordRequest(pathname, status, ms) {
  const p = normalizePath(pathname)
  const dur = Math.max(0, Number(ms) || 0)
  const code = Number(status) || 0
  total += 1
  durations.push(dur)
  if (durations.length > MAX_DURATIONS) durations.splice(0, durations.length - MAX_DURATIONS)
  byStatus.set(code, (byStatus.get(code) || 0) + 1)
  byPath.set(p, (byPath.get(p) || 0) + 1)
  if (code >= 500) errors += 1
  if (dur >= SLOW_MS) {
    slow += 1
    logEvent('slow-request', { path: p, status: code, ms: Math.round(dur) })
  }
}

function percentile(sorted, q) {
  if (!sorted.length) return 0
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))])
}

export function metricsSnapshot() {
  const sorted = durations.slice().sort((a, b) => a - b)
  const topPaths = [...byPath]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([path, count]) => ({ path, count }))
  return {
    startedAt: new Date(startedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    pid: process.pid,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    requests: { total, errors, slow, byStatus: Object.fromEntries(byStatus), topPaths },
    latencyMs: {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.length ? Math.round(sorted[sorted.length - 1]) : 0,
      samples: sorted.length,
    },
  }
}

/** 单测用：把计数清零，不影响正在跑的请求。 */
export function resetMetrics() {
  durations.length = 0
  byStatus.clear()
  byPath.clear()
  total = 0
  errors = 0
  slow = 0
}

/** 结构化事件：一行一个 JSON，给「运行 → 日志 → 面板事件」看，也方便以后 grep。 */
export function logEvent(kind, fields = {}) {
  try {
    fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true })
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), kind, ...fields }) + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {}
}
