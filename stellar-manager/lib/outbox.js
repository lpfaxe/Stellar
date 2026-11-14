/* 发件箱：她发出去的所有消息（文本/图片）按行追加；面板倒序查看、按 QQ/群筛选。
 * 数据文件：%USERPROFILE%\.dsh\stellar\state\outbound-messages.jsonl
 * 每条：{id, at, kind:'private'|'group', target:'3025...'|'123456', text, image, messageId, source}
 * 历史回填：首次为空时从 stellar/state/tool-calls.jsonl 的 qq_send_message/qq_send_image 调用生成。 */
import fs from 'node:fs'
import path from 'node:path'
import { OUTBOUND_FILE, REPO, CHAT_AUDIT } from './paths.js'
import { readJson, appendAudit } from './util.js'

const TOOL_CALLS = path.join(REPO, 'state', 'tool-calls.jsonl')
const MAX_BYTES = 8 * 1024 * 1024

function ensureDir() {
  fs.mkdirSync(path.dirname(OUTBOUND_FILE), { recursive: true })
}

function readLines(file, maxBytes = MAX_BYTES) {
  try {
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - maxBytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    let text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text.split('\n').filter((l) => l.trim())
  } catch { return [] }
}

function safeJson(line) {
  try { return JSON.parse(line) } catch { return null }
}

export function normalizeTarget(target) {
  const s = String(target || '').trim()
  if (!s) return ''
  if (/^(private|group):\d+$/.test(s)) return s
  return s
}

export function readOutbox({ target = '', limit = 60, offset = 0, excludeTarget = '' } = {}) {
  const want = normalizeTarget(target)
  const exclude = normalizeTarget(excludeTarget).replace(/^(private|group):/, '')
  const wantNum = want.replace(/^(private|group):/, '')
  const lines = readLines(OUTBOUND_FILE)
  const items = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const e = safeJson(lines[i])
    if (!e || !e.at) continue
    if (exclude && String(e.target || '').replace(/^(private|group):/, '') === exclude) continue
    if (want) {
      const t = String(e.target || '')
      if (t !== want && t !== wantNum && !(wantNum && t.endsWith(':' + wantNum))) continue
    }
    items.push(e)
  }
  const total = items.length
  const start = Math.max(0, Number(offset) || 0)
  const n = Math.min(200, Math.max(1, Number(limit) || 60))
  return {
    ok: true,
    total,
    items: items.slice(start, start + n),
    targets: summariseTargets(items).filter((t) => !exclude || String(t.target || '').replace(/^(private|group):/, '') !== exclude),
    at: new Date().toISOString()
  }
}

function summariseTargets(items) {
  const map = new Map()
  for (const e of items) {
    const t = String(e.target || '')
    if (!t) continue
    const cur = map.get(t) || { target: t, kind: e.kind || '', count: 0, lastAt: '' }
    cur.count += 1
    if (!cur.lastAt || String(e.at) > cur.lastAt) { cur.lastAt = e.at; cur.kind = e.kind || cur.kind }
    map.set(t, cur)
  }
  return [...map.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 40)
}

export function appendOutbox(entry) {
  if (!entry || !entry.target) return false
  ensureDir()
  const at = entry.at || new Date().toISOString()
  const id = entry.id || ('out:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8))
  const line = JSON.stringify({
    id,
    at,
    kind: entry.kind === 'group' ? 'group' : 'private',
    target: String(entry.target),
    text: String(entry.text || '').slice(0, 4000),
    image: String(entry.image || ''),
    messageId: entry.messageId == null ? '' : String(entry.messageId),
    source: String(entry.source || 'bridge')
  })
  try { fs.appendFileSync(OUTBOUND_FILE, line + '\n', { encoding: 'utf8', mode: 0o600 }); return true } catch { return false }
}

/** 首次使用：把 tool-calls.jsonl 里已经发过的消息补进来（只补 call，不猜结果）。 */
export function seedOutboxFromToolCalls() {
  try {
    if (fs.existsSync(OUTBOUND_FILE) && fs.statSync(OUTBOUND_FILE).size > 0) return { seeded: 0 }
  } catch {}
  const known = new Set()
  for (const line of readLines(OUTBOUND_FILE)) {
    const e = safeJson(line)
    if (e && e.id) known.add(e.id)
  }
  const lines = readLines(TOOL_CALLS)
  const out = []
  lines.forEach((line, index) => {
    const e = safeJson(line)
    if (!e || e.type !== 'call') return
    const tool = String(e.tool || '')
    if (!tool.endsWith('qq_send_message') && !tool.endsWith('qq_send_image')) return
    let args = e.args
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = {} } }
    if (!args || typeof args !== 'object') return
    const key = String(args.key || e.key || '')
    const m = /^(private|group):(\d+)$/.exec(key)
    if (!m) return
    const id = 'toolcall:' + String(e.time || '') + ':' + index
    if (known.has(id)) return
    known.add(id)
    let text = ''
    if (Array.isArray(args.messages)) text = args.messages.map((x) => typeof x === 'string' ? x : (x && x.text) || '').filter(Boolean).join(' / ')
    else text = String(args.caption || args.text || '')
    out.push({
      id,
      at: String(e.time || new Date().toISOString()),
      kind: m[1],
      target: m[2],
      text,
      image: String(args.imagePath || ''),
      messageId: '',
      source: 'toolcall'
    })
  })
  if (!out.length) return { seeded: 0 }
  ensureDir()
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  fs.appendFileSync(OUTBOUND_FILE, out.map((e) => JSON.stringify(e)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
  appendAudit('outbox-seed', { count: out.length, from: 'tool-calls.jsonl' })
  return { seeded: out.length }
}

export function readChatAudit({ limit = 40 } = {}) {
  const lines = readLines(CHAT_AUDIT, 1024 * 1024)
  const items = []
  for (let i = lines.length - 1; i >= 0 && items.length < Math.min(100, Math.max(1, Number(limit) || 40)); i -= 1) {
    const e = safeJson(lines[i])
    if (e) items.push(e)
  }
  return items
}

export function appendChatAudit(entry) {
  ensureDir()
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  try { fs.appendFileSync(CHAT_AUDIT, line + '\n', { encoding: 'utf8', mode: 0o600 }); return true } catch { return false }
}

export function readChatAuditRaw() {
  return readJson(CHAT_AUDIT, null) // 保留给未来的结构化需求；现在只有 jsonl
}
