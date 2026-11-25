/* 「对方正在输入」观测（2026-11-25，主人 D6：「观测日志我怕忘了，麻烦加到控制台，7 天滚动」）。
 *
 * 数据只有一个来源：桥接写的 <REPO>/state/typing-log.jsonl（一行一个事件，只写 at/key/state/owner，
 * 没有正文也没有 token）。面板只读，不写这个文件。
 *
 * 统计口径与桥接共用同一份代码（动态 import src/typing-watch.js 的 summarizeTypingLog /
 * pruneTypingLog），不在面板里抄第二份 —— 抄一份就会出现「控制台说 12 次、她那边算 9 次」。
 *
 * 7 天滚动分两层：桥接每 6 小时物理裁一次文件；面板再按 keepDays 过滤一遍
 * （桥接没重启、或刚改过保留天数时，读到的也不会是陈年数据）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO } from './paths.js'

export const LOG_FILE = path.join(REPO, 'state', 'typing-log.jsonl')
const DEFAULT_KEEP_DAYS = 7
// 控制台最多渲染这么多行：7 天聊得再多也够看了，再多就是刷屏。
const MAX_ROWS = 200

let modPromise = null
function typingModule() {
  if (!modPromise) {
    const file = path.join(REPO, 'src', 'typing-watch.js')
    modPromise = import(pathToFileURL(file).href)
      .then((mod) => {
        if (!mod || typeof mod.summarizeTypingLog !== 'function') {
          throw new Error('src/typing-watch.js 缺 summarizeTypingLog')
        }
        return mod
      })
      .catch(() => { modPromise = null; return null })
  }
  return modPromise
}

function dayKeyOf(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * 读观测日志。永远不抛：文件不在就回空（新装的机器还没人给主人发过消息）。
 * 返回 { ok, file, exists, sizeBytes, keepDays, summary, rows, days }
 *   rows: 最近 MAX_ROWS 条（新→旧，已按 keepDays 过滤）
 *   days: 按天聚合 [{day, typing, stop, total}]（新→旧，最多 keepDays 天）
 */
export async function readTypingWatch({ now = Date.now(), keepDays = DEFAULT_KEEP_DAYS } = {}) {
  const base = {
    ok: true,
    file: LOG_FILE,
    exists: false,
    sizeBytes: 0,
    keepDays,
    summary: { total: 0, today: 0, typing: 0, stop: 0, lastAt: null, lastAgoMs: null, conversations: [] },
    rows: [],
    days: []
  }
  let text = ''
  try {
    const st = fs.statSync(LOG_FILE)
    if (!st.isFile()) return base
    base.exists = true
    base.sizeBytes = st.size
    text = fs.readFileSync(LOG_FILE, 'utf8')
  } catch {
    // 文件还没建：桥接这次改动还没跑到，或者从来没人给她发过消息。
    return base
  }
  const mod = await typingModule()
  if (!mod) {
    return { ...base, ok: false, message: '读不到仓库里的 src/typing-watch.js' }
  }
  // 桥接每 6 小时物理裁一次；这里再按保留天数过滤一遍，保证「7 天滚动」不依赖重启。
  const pruned = mod.pruneTypingLog(text, { now, keepDays })
  const entries = Array.isArray(pruned.entries) ? pruned.entries : []
  base.summary = mod.summarizeTypingLog(entries, { now })
  base.rows = entries.slice(0, MAX_ROWS).map((e) => ({
    at: e.at,
    agoMs: Number.isFinite(Date.parse(e.at)) ? Math.max(0, now - Date.parse(e.at)) : null,
    key: String(e.key || ''),
    who: String(e.key || '').replace(/^private:/, ''),
    state: Number(e.state),
    owner: e.owner === true
  }))
  const byDay = new Map()
  for (const e of entries) {
    const day = dayKeyOf(e.at)
    if (!day) continue
    if (!byDay.has(day)) byDay.set(day, { day, typing: 0, stop: 0, total: 0 })
    const row = byDay.get(day)
    row.total += 1
    if (Number(e.state) === 0) row.stop += 1
    else row.typing += 1
  }
  base.days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, keepDays)
  return base
}

/** 给人看的一句话（卡片标题旁边的 pill 用）。没有数据时说清「为什么空」，别只写 0。 */
export function typingHeadline(data) {
  if (!data || data.ok !== true) return '读不到观测数据'
  if (!data.exists) return '还没有记录（她这版还没重启，或者最近没人给她发消息）'
  const s = data.summary || {}
  if (!s.total) return '记录还在第一天（有消息才有数据）'
  const parts = [`今天 ${s.today || 0} 次`,
    `打字中 ${s.typing || 0} · 停手 ${s.stop || 0}`,
    `留 ${data.keepDays} 天`]
  return parts.join(' · ')
}
