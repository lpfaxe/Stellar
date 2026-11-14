/* 日报：QQ空间计数、按日读报告、控制台点名请求 */
import fs from 'node:fs'
import path from 'node:path'
import { REPORTS_FILE, REPORT_REQ, SURF } from './paths.js'
import { localDay, logLine, todayKey, weekStartLocal } from './util.js'

export function qzoneStats() {
  const file = path.join(SURF, 'state', 'qzone-log.jsonl')
  const rows = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch {}
    }
  } catch {}
  const today = todayKey()
  const since = weekStartLocal()
  const posts = rows.filter((r) => r.kind === 'post')
  const day = (r) => localDay(r.at)
  const weekPosts = posts.filter((r) => day(r) >= since)
  return {
    todayCount: posts.filter((r) => day(r) === today).length,
    weekCount: weekPosts.length,
    last: weekPosts.length ? weekPosts[weekPosts.length - 1] : (posts.length ? posts[posts.length - 1] : null),
  }
}

export function readReports(days = 30) {
  const map = new Map()
  let rows = []
  try { rows = fs.readFileSync(REPORTS_FILE, 'utf8').split('\n').filter(Boolean) } catch {}
  for (const line of rows) {
    try {
      const r = JSON.parse(line)
      if (r && typeof r.date === 'string' && r.date) map.set(r.date, r)
    } catch {}
  }
  const since = localDay(Date.now() - (Math.max(1, days) - 1) * 86400000)
  return [...map.values()].filter((r) => r.date >= since).sort((a, b) => String(b.date).localeCompare(String(a.date)))
}

export async function actionReportRequest() {
  const now = new Date()
  fs.mkdirSync(path.dirname(REPORT_REQ), { recursive: true })
  fs.writeFileSync(REPORT_REQ, JSON.stringify({ at: now.toISOString(), by: 'panel' }))
  logLine('report requested from panel')
  return { ok: true, message: '已经通知她了 —— DSH 开着的话一分钟内会去写（她醒着、或下一个整分钟就会看到）' }
}

