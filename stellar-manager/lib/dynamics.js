/* 她的 B 站动态：四类动态 + 分享型，数据来自角色的 bili/daily-dynamic.json */
import fs from 'node:fs'
import path from 'node:path'
import { SURF } from './paths.js'
import { readJson } from './util.js'

const KIND_LABEL = { game: '游戏区', anime: '动画区', gaming: '游戏实况', best: '最高分视频', share: '视频分享' }
const LABEL_HINT = { game: '游戏区动态', anime: '动画区动态', gaming: '游戏区动态', best: '最高分视频动态', share: '分享型动态' }

// 找最近在写的角色 bili 目录（多角色时以 daily-dynamic.json 的 mtime 为准）
export function findBiliDir() {
  const base = path.join(SURF, 'characters')
  const candidates = []
  try {
    for (const role of fs.readdirSync(base)) {
      const dir = path.join(base, role, 'bili')
      const file = path.join(dir, 'daily-dynamic.json')
      if (fs.existsSync(file)) candidates.push({ dir, role, file, mtime: fs.statSync(file).mtimeMs })
    }
  } catch {}
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0] || { dir: null, role: '', file: null }
}

function readWhaleExcerpts(dir) {
  const map = new Map()
  try {
    const lines = fs.readFileSync(path.join(dir, 'whale-log.jsonl'), 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let row = null
      try { row = JSON.parse(line) } catch { continue }
      if (!row || row.kind !== 'daily-dynamic') continue
      const note = String(row.note || '')
      const idx = note.indexOf('动态：')
      if (idx < 0) continue
      const at = String(row.at || '')
      const excerpt = note.slice(idx + 3).trim()
      if (at && excerpt) map.set(at.slice(0, 16), excerpt)
    }
  } catch {}
  return map
}

export function buildDynamics(limit = 12) {
  const found = findBiliDir()
  const state = found.file ? readJson(found.file, {}) : {}
  const excerpts = found.dir ? readWhaleExcerpts(found.dir) : new Map()
  const items = []
  for (const [key, rec] of Object.entries(state || {})) {
    if (!rec || typeof rec !== 'object') continue
    const dynId = String(rec.dynId || '')
    const at = String(rec.at || '')
    if (!at) continue
    const kind = String(rec.kind || key || '')
    const text = String(rec.text || '').trim()
    const excerpt = text ? '' : (excerpts.get(at.slice(0, 16)) || '')
    items.push({
      key,
      kind,
      kindLabel: LABEL_HINT[kind] || KIND_LABEL[kind] || '动态',
      at,
      atText: String(rec.atText || ''),
      bvid: String(rec.bvid || ''),
      dynId,
      chars: Number(rec.chars) || 0,
      text,
      excerpt,
      image: rec.image ? String(rec.image) : '',
      card: rec.card === true,
      url: dynId ? ('https://t.bilibili.com/' + dynId) : (rec.bvid ? ('https://www.bilibili.com/video/' + rec.bvid) : '')
    })
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  const today = new Date().toLocaleDateString('sv-SE')
  return {
    ok: true,
    role: found.role || '',
    dir: found.dir || '',
    file: found.file || '',
    todayCount: items.filter((x) => String(x.at).startsWith(today)).length,
    total: items.length,
    lastAt: items[0] ? items[0].at : '',
    lastKind: items[0] ? items[0].kind : '',
    items: items.slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
  }
}
