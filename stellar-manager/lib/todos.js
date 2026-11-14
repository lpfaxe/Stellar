/* 她的待办事项：展示 + 控制台代她加/删。数据文件和插件仓库的 src/todos.js 是同一个
 * （%USERPROFILE%\.dsh\stellar\state\todos.json），两边都能写，改完下一分钟调度器就按新表跑。 */
import fs from 'node:fs'
import path from 'node:path'
import { TODOS_FILE } from './paths.js'

function norm(row) {
  if (!row || typeof row !== 'object') return null
  const id = String(row.id || '').trim()
  const text = String(row.text || '').replace(/[\r\n\t]+/g, ' ').trim()
  if (!id || !text) return null
  return {
    id,
    text,
    dueAt: Math.max(0, Number(row.dueAt) || 0),
    createdAt: Math.max(0, Number(row.createdAt) || 0),
    status: ['pending', 'done', 'cancelled'].includes(row.status) ? row.status : 'pending',
    key: String(row.key || ''),
    targetKey: String(row.targetKey || ''),
    targetName: String(row.targetName || ''),
    requester: row.requester && typeof row.requester === 'object' ? {
      userId: String(row.requester.userId || ''),
      nickname: String(row.requester.nickname || ''),
      groupName: String(row.requester.groupName || '')
    } : {},
    remindedAt: Math.max(0, Number(row.remindedAt) || 0),
    reminderCount: Math.max(0, Number(row.reminderCount) || 0),
    note: String(row.note || '')
  }
}

export function readTodos() {
  let items = []
  try {
    const raw = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : [])
  } catch { items = [] }
  items = items.map(norm).filter(Boolean)
  const now = Date.now()
  const pending = items.filter((it) => it.status === 'pending')
  const done = items.filter((it) => it.status === 'done').sort((a, b) => (b.dueAt || 0) - (a.dueAt || 0)).slice(0, 20)
  const overdue = pending.filter((it) => it.dueAt > 0 && it.dueAt <= now)
  const next = pending.filter((it) => it.dueAt > now).sort((a, b) => a.dueAt - b.dueAt)[0] || null
  return {
    ok: true,
    at: now,
    items: [...pending.sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity)), ...done],
    pending: pending.length,
    done: done.length,
    overdue: overdue.length,
    next,
    nextAt: next ? next.dueAt : 0
  }
}

// ── 写：控制台代她加 / 删一条 ────────────────────────────────────────────────
// 直接改 todos.json？不。这里读写的是「原始条目」，归一化只为展示 ——
// 回写时保留 createdBy/groupId 这类面板不认识的字段，否则一次保存就把她的记录洗白了。
function readRawItems() {
  try {
    const raw = JSON.parse(fs.readFileSync(TODOS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : [])
    return items.filter((it) => it && typeof it === 'object' && String(it.id || '').trim())
  } catch { return [] }
}

function writeRawItems(items) {
  fs.mkdirSync(path.dirname(TODOS_FILE), { recursive: true })
  const tmp = TODOS_FILE + '.tmp-' + process.pid
  const body = { version: 1, updatedAt: new Date().toISOString(), items }
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, TODOS_FILE)
}

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** 「提醒谁」：private:<QQ> / group:<群号>；owner 表示主人私聊（由面板传 ownerQQ 拼）。 */
function targetOf(input) {
  const key = String(input || '').trim()
  if (!key) return { key: '', name: '' }
  if (!/^(private|group):[0-9]{5,20}$/.test(key)) throw new Error('提醒对象要写成 private:<QQ 号> 或 group:<群号>')
  return { key, name: '' }
}

export function addTodoFromPanel(body = {}) {
  const text = cleanText(body.text, 300)
  if (!text) throw new Error('要写清楚提醒什么事')
  const dueAt = Math.max(0, Number(body.dueAt) || 0)
  if (!dueAt) throw new Error('要选一个提醒时间')
  if (dueAt <= Date.now() - 60_000) throw new Error('这个时间已经过去了，换一个')
  if (dueAt > Date.now() + 370 * 24 * 3600 * 1000) throw new Error('超过一年了，先记近期的事')
  const items = readRawItems()
  if (items.filter((it) => it.status === 'pending' || !it.status).length >= 200) throw new Error('待办太多了（上限 200 条），先清几条')
  const t = targetOf(body.targetKey)
  const row = {
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    dueAt,
    createdAt: Date.now(),
    createdBy: 'panel',
    requester: { userId: '', nickname: '', groupId: '', groupName: '' },
    key: '',
    targetKey: t.key,
    targetName: cleanText(body.targetName || '', 60),
    status: 'pending',
    remindedAt: 0,
    reminderCount: 0,
    doneAt: 0,
    note: cleanText(body.note || '', 300)
  }
  items.push(row)
  writeRawItems(items)
  return norm(row)
}

export function removeTodoFromPanel(id) {
  const want = String(id || '').trim()
  if (!want) throw new Error('缺 id')
  const items = readRawItems()
  const idx = items.findIndex((it) => String(it.id || '').trim() === want)
  if (idx < 0) throw new Error('没找到这条待办')
  const [gone] = items.splice(idx, 1)
  writeRawItems(items)
  return norm(gone)
}
