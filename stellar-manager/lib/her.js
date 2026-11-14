/* 她的状态：agent-state + purpose 文件 */
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_STATE_FILE, SURF } from './paths.js'
import { readJson } from './util.js'

export const PURPOSE_FILE_HINT = 'purpose-outreach.json'

export function findPurposeFile() {
  const base = path.join(SURF, 'characters')
  const candidates = []
  try {
    for (const role of fs.readdirSync(base)) {
      const file = path.join(base, role, PURPOSE_FILE_HINT)
      if (fs.existsSync(file)) candidates.push({ file, role, mtime: fs.statSync(file).mtimeMs })
    }
  } catch {}
  const legacy = path.join(SURF, PURPOSE_FILE_HINT)
  if (fs.existsSync(legacy)) candidates.push({ file: legacy, role: '(default)', mtime: fs.statSync(legacy).mtimeMs })
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0] || null
}

/** 她的状态：在线/待机/休眠 + 最近情绪 + 正在惦记的事（从 bridge 状态机与目的引擎读，只读）。 */
export function buildHerStatus() {
  const raw = readJson(AGENT_STATE_FILE, null)
  const found = findPurposeFile()
  const purpose = found ? (readJson(found.file, null) || {}) : {}
  const conversations = Object.entries((raw && raw.conversations) || {}).map(([key, item]) => ({
    key,
    state: (item && item.state) || 'LISTEN',
    lastAt: Number(item && item.lastAt) || 0,
    activeSince: Number(item && item.activeSince) || 0,
    turns: Number(item && item.turns) || 0,
    reason: String((item && item.reason) || ''),
  })).sort((a, b) => {
    const pa = a.key.startsWith('private:') ? 0 : 1
    const pb = b.key.startsWith('private:') ? 0 : 1
    return (pa - pb) || (b.lastAt - a.lastAt)
  })
  const states = new Set(conversations.map((c) => c.state))
  let state = 'unknown'
  let label = '未知（还没收到过消息）'
  if (conversations.length) {
    if (states.has('ACTIVE')) { state = 'online'; label = '在线' }
    else if (states.has('COOLDOWN')) { state = 'online'; label = '在线 · 刚说完话' }
    else if (states.has('LISTEN')) { state = 'idle'; label = '在线 · 待机' }
    else if (states.has('SLEEP')) { state = 'sleep'; label = '休眠中' }
  }
  const primary = conversations[0] || null
  const pending = (Array.isArray(purpose.pending) ? purpose.pending : [])
    .filter((item) => item && item.text).slice(-3)
    .map((item) => ({ text: String(item.text).slice(0, 100), at: Number(item.at) || 0 }))
  const goals = (Array.isArray(purpose.goals) ? purpose.goals : [])
    .filter((item) => item && item.intent).slice(0, 3)
    .map((item) => ({
      intent: String(item.intent).slice(0, 100),
      owner: String(item.owner || ''),
      confidence: Number(item.confidence) || 0,
    }))
  return {
    ok: conversations.length > 0,
    state,
    label,
    key: primary ? primary.key : '',
    since: primary ? (primary.activeSince || primary.lastAt) : 0,
    lastActive: primary ? primary.lastAt : 0,
    turns: primary ? primary.turns : 0,
    counts: conversations.reduce((acc, item) => { acc[item.state] = (acc[item.state] || 0) + 1; return acc }, {}),
    conversations,
    seen: raw ? Object.keys(raw.seen || {}).length : 0,
    updatedAt: raw ? raw.updatedAt || '' : '',
    file: found ? found.file : '',
    emotion: {
      label: String(purpose.lastEmotionLabel || '').trim(),
      text: String(purpose.lastEmotionText || '').trim(),
      at: Number(purpose.lastEmotionAt) || 0,
    },
    purpose: {
      text: String(purpose.lastPurpose || '').slice(0, 120),
      at: Number(purpose.lastRunAt) || 0,
      pending,
      goals,
    },
  }
}

export function buildAgentState() {
  const raw = readJson(AGENT_STATE_FILE, null)
  if (!raw) return { ok: false, states: ['LISTEN', 'ACTIVE', 'COOLDOWN', 'SLEEP'], counts: {}, conversations: [], seen: 0 }
  const conversations = Object.entries(raw.conversations || {}).map(([key, item]) => ({
    key,
    state: (item && item.state) || 'LISTEN',
    lastAt: Number(item && item.lastAt) || 0,
    activeSince: Number(item && item.activeSince) || 0,
    turns: Number(item && item.turns) || 0,
    reason: (item && item.reason) || '',
  })).sort((a, b) => b.lastAt - a.lastAt)
  const counts = {}
  for (const item of conversations) counts[item.state] = (counts[item.state] || 0) + 1
  return { ok: true, states: ['LISTEN', 'ACTIVE', 'COOLDOWN', 'SLEEP'], counts, conversations, seen: Object.keys(raw.seen || {}).length, updatedAt: raw.updatedAt || '' }
}

