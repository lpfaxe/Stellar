/* 她的记忆：记忆卡、分层、词汇本、表情包 */
import fs from 'node:fs'
import path from 'node:path'
import { MEMORY_REQUEST, SLANG_FILE, STICKER_FILE, SURF } from './paths.js'
import { appendAudit, atomicWriteJson, localDay, maskText, readJson, todayKey } from './util.js'
import { contactIndex, labelForKey, relationFor } from './people.js'

// ── 她的记忆 ──────────────────────────────────────────────────────────────────
// Stellar 的记忆分三层落盘（唯一真相在 memory-card.json，"容量"按 memory-card.md 的字数算）：
//   1. 衰减记忆卡  memory-card.json / .md / -prompt-*.md —— 日常注入用的那份，会模糊、会遗忘；
//   2. 全量存档    memory-card-full.jsonl + memory-card-full-stats.json —— 只增不删的永久档案；
//   3. 向量记忆    vector-memory.jsonl（+ vector-memory-index.json/.bin）—— 语义召回，需 Embedding 服务。
// 桥接只往 memory-inbox.jsonl 追加原始事件（最多 1MB 轮转），插件宿主每 10 分钟整理一次。
export const MEMORY_DEFAULTS = { maxRecords: 1000, importantMax: 1000, warnChars: 60000, fullMaxBytes: 10 * 1024 * 1024 * 1024, forgetAfterDays: 60, dailyHour: 4, minOwnerImportance: 65 }
export const INBOX_MAX_BYTES = 1024 * 1024

export function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()) } catch { return [] }
}
export function fileBytes(file) {
  try { return fs.statSync(file).size } catch { return 0 }
}
export function fileMtime(file) {
  try { return fs.statSync(file).mtime.toISOString() } catch { return '' }
}

// 找到最近还在写的那个角色的 memory 目录（多角色时以 memory-card.json 的 mtime 为准）
export function findMemoryDir() {
  const candidates = []
  const base = path.join(SURF, 'characters')
  try {
    for (const role of fs.readdirSync(base)) {
      const dir = path.join(base, role, 'memory')
      const card = path.join(dir, 'memory-card.json')
      if (fs.existsSync(card)) candidates.push({ dir, role, mtime: fs.statSync(card).mtimeMs })
    }
  } catch {}
  const legacy = path.join(SURF, 'memory')
  if (fs.existsSync(path.join(legacy, 'memory-card.json'))) {
    candidates.push({ dir: legacy, role: '(default)', mtime: fs.statSync(path.join(legacy, 'memory-card.json')).mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0] || { dir: null, role: '' }
}

export function lastPluginError(pattern) {
  try {
    const lines = fs.readFileSync(path.join(SURF, 'plugin.log'), 'utf8').split('\n').filter((l) => l.includes(pattern))
    const last = lines[lines.length - 1] || ''
    const m = /^\[(.+?)\]\s*(.*)$/.exec(last.trim())
    return m ? { at: m[1], text: m[2] } : (last ? { at: '', text: last.trim() } : null)
  } catch { return null }
}

export function buildMemory() {
  const found = findMemoryDir()
  const dir = found.dir
  const cfg = readJson(path.join(SURF, 'config.json'), {})
  const mc = Object.assign({}, MEMORY_DEFAULTS, cfg.memoryCard || {})
  const vmCfg = cfg.vectorMemory || {}
  const errors = []
  if (!dir) {
    return { ok: false, errors: ['没找到记忆目录（角色还没建记忆卡？）'], at: new Date().toISOString() }
  }

  const card = readJson(path.join(dir, 'memory-card.json'), null) || {}
  const stats = card.stats || {}
  const fullStats = readJson(path.join(dir, 'memory-card-full-stats.json'), null) || {}
  const records = Array.isArray(card.records) ? card.records : []
  const cardMdFile = path.join(dir, 'memory-card.md')
  let chars = 0
  try { chars = fs.readFileSync(cardMdFile, 'utf8').length } catch { chars = Number(fullStats.chars) || 0 }
  const warnChars = Number(mc.warnChars) || 60000
  const maxRecords = Number(mc.maxRecords) || 600
  const percent = warnChars > 0 ? Math.min(100, (chars / warnChars) * 100) : 0
  // 重要记忆制：importance >= 40、钉住、锚点、初次相遇算「重要」，最多保留 1000 条；
  // 不重要的（三级）先被淘汰，所以「长期记忆上限 600 条」的旧口径不再展示。
  const importantMax = Number(mc.importantMax) || 1000
  let important = 0
  for (const r of records) {
    const imp = Number(r.importance) || 0
    if (r && (r.pinned || r.anchor || r.firstMet || imp >= 40)) important += 1
  }

  // 全量存档：一行一条，只追加
  const fullRows = []
  for (const line of readLines(path.join(dir, 'memory-card-full.jsonl'))) {
    try { fullRows.push(JSON.parse(line)) } catch {}
  }
  const fullBytes = fileBytes(path.join(dir, 'memory-card-full.jsonl'))
  const fullMaxBytes = Number(mc.fullMaxBytes) || 10 * 1024 * 1024 * 1024
  const counts = { owner: 0, bili: 0, qq: 0, other: 0 }
  const kinds = {}
  const byDay = {}
  let pinned = 0
  let anchor = 0
  let sensitive = 0
  let firstAt = ''
  let lastAt = ''
  let todayCount = 0
  const today = todayKey()
  for (const r of fullRows) {
    const src = String(r.source || '')
    let bucketKey = 'other'
    if (String(r.platform || '').startsWith('bili') || src.startsWith('bili')) bucketKey = 'bili'
    else if (/^qq/.test(src) || String(r.platform || '') === 'qq') bucketKey = r.isSelf ? 'qq' : 'owner'
    counts[bucketKey] += 1
    const k = r.kind || 'unknown'
    kinds[k] = (kinds[k] || 0) + 1
    const created = String(r.createdAt || '')
    if (created) {
      if (!firstAt || created < firstAt) firstAt = created
      if (!lastAt || created > lastAt) lastAt = created
      const d = localDay(created)
      byDay[d] = (byDay[d] || 0) + 1
      if (d === today) todayCount += 1
    }
    if (r.pinned) pinned += 1
    if (r.anchor) anchor += 1
    if (r.sensitive) sensitive += 1
  }
  if (!fullRows.length) {
    for (const k of ['owner', 'bili', 'qq', 'other']) counts[k] = Number((stats.counts || {})[k]) || 0
  }

  // 向量记忆：记录在 vector-memory.jsonl，索引按 modelSpace 分文件存在 vector-memory-index/ 下
  // （旧版才是单文件 vector-memory-index.json/.bin，两种都要认，否则切了模型空间就显示 pending）。
  const vecRows = readLines(path.join(dir, 'vector-memory.jsonl')).length
  const indexJson = path.join(dir, 'vector-memory-index.json')
  const indexBin = path.join(dir, 'vector-memory-index.bin')
  const indexDir = path.join(dir, 'vector-memory-index')
  const vmEff = vmCfg.provider === 'cloud'
    ? { model: vmCfg.cloudModel || vmCfg.model, modelSpace: vmCfg.cloudModelSpace || vmCfg.modelSpace }
    : { model: vmCfg.model, modelSpace: vmCfg.modelSpace }
  let indexFile = ''
  try {
    const key = String(vmEff.modelSpace || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 72) || 'default'
    // 插件侧文件名是 <modelSpace 清洗后>-<sha1 前 10 位>.json，这里按前缀找最新的那一份。
    const hits = fs.readdirSync(indexDir).filter((f) => f.endsWith('.json') && f.startsWith(key.slice(0, 12))).sort()
    if (hits.length) indexFile = path.join(indexDir, hits[hits.length - 1])
  } catch {}
  const indexExists = Boolean(indexFile) || (fs.existsSync(indexJson) && fs.existsSync(indexBin))
  // 只有「比索引更新」的报错才算数：索引已经重建成功之后再挂着的旧报错会把
  // 状态卡刷成红色（2026-11-10 修：切到云端 embedding 后索引已 ready，界面还显示
  // 「Embedding 服务发现文件不存在」）。
  let vecError = lastPluginError('向量记忆整理失败')
  if (vecError && indexExists) {
    const errAt = Date.parse(vecError.at)
    const idxAt = Date.parse(fileMtime(indexFile || indexJson))
    if (Number.isFinite(errAt) && idxAt && errAt <= idxAt) vecError = null
  }
  const vecState = !vmCfg.enabled ? 'off' : (indexExists ? 'ready' : (vecRows > 0 ? 'pending' : 'empty'))

  // 收件箱：桥接/桌宠 append 的原始事件，满 1MB 轮转成 .1
  const inboxFiles = [path.join(dir, 'memory-inbox.jsonl'), path.join(dir, 'memory-inbox.jsonl.1')]
  let inboxLines = 0
  let inboxBytes = 0
  for (const f of inboxFiles) { inboxLines += readLines(f).length; inboxBytes += fileBytes(f) }

  // B站 那本记忆（角色目录下 bili/bili-memory.json，条目数）
  const charDir = path.dirname(dir)
  const biliMem = readJson(path.join(charDir, 'bili', 'bili-memory.json'), null)
  const biliEntries = biliMem && Array.isArray(biliMem.entries) ? biliMem.entries.length : 0

  // 磁盘占用
  const dirBytes = (d) => {
    let total = 0
    try { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const fp = path.join(d, f.name); total += f.isDirectory() ? dirBytes(fp) : fileBytes(fp) } } catch {}
    return total
  }
  const memDirBytes = dirBytes(dir)
  const biliDirBytes = dirBytes(path.join(charDir, 'bili'))
  const promptQq = fileBytes(path.join(dir, 'memory-card-prompt-qq.md'))
  const promptBili = fileBytes(path.join(dir, 'memory-card-prompt-bili.md'))

  const days = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-7).map(([d, n]) => ({ d, n }))
  const kindsSorted = Object.entries(kinds).sort((a, b) => b[1] - a[1])

  // 按人分开看：以 objectKey（private:/owner:/group:）分组，卡片和全量都算。
  const index = contactIndex()
  const groupMap = new Map()
  for (const r of records) {
    const raw = String(r.objectKey || r.conversationKey || '').trim()
    const pm = /^(?:private|owner|user):(\d{5,12})$/.exec(raw)
    const key = pm ? 'uin:' + pm[1] : raw
    const labelKey = pm ? 'private:' + pm[1] : raw
    let g = groupMap.get(key)
    if (!g) {
      g = { key, name: key ? labelForKey(index, labelKey) : '未归属', relation: key ? relationFor(index, labelKey) : '', kind: pm ? 'person' : (key.split(':')[0] || 'none'), count: 0, important: 0, chars: 0, lastAt: '', sample: [] }
      groupMap.set(key, g)
    }
    g.count += 1
    const imp = Number(r.importance) || 0
    if (r.pinned || r.anchor || r.firstMet || imp >= 40) g.important += 1
    const text = String(r.title || r.text || '')
    g.chars += text.length
    const created = String(r.createdAt || '')
    if (created && (!g.lastAt || created > g.lastAt)) g.lastAt = created
    g.sample.push({ id: r.id || '', title: maskText(text, 80), importance: imp, createdAt: created })
  }
  const groups = Array.from(groupMap.values()).map((g) => {
    g.sample.sort((a, b) => b.importance - a.importance)
    g.sample = g.sample.slice(0, 3)
    return g
  }).sort((a, b) => b.count - a.count)
  const groupTotal = groups.reduce((sum, g) => sum + g.count, 0)

  return {
    ok: true,
    at: new Date().toISOString(),
    role: found.role,
    dir,
    card: {
      records: records.length,
      maxRecords,
      recordPercent: maxRecords > 0 ? Math.min(100, (records.length / maxRecords) * 100) : 0,
      important,
      importantMax,
      importantPercent: importantMax > 0 ? Math.min(100, (important / importantMax) * 100) : 0,
      chars,
      warnChars,
      percent,
      updatedAt: card.updatedAt || fileMtime(path.join(dir, 'memory-card.json')),
      lastMaintenanceAt: card.lastMaintenanceAt || stats.lastMaintainAt || '',
      lastDecayDate: card.lastDecayDate || '',
      decayed: Number(stats.decayed) || 0,
      compacted: Number(stats.compacted) || 0,
      forgotten: Number(stats.forgotten) || 0,
      ingested: Number(stats.ingested) || records.length,
      pinned,
      anchor,
      sensitive
    },
    full: {
      records: fullRows.length || Number(fullStats.records) || 0,
      bytes: fullBytes,
      maxBytes: fullMaxBytes,
      maxRecords: Number(mc.fullMaxRecords) || 0,
      percentBytes: fullMaxBytes > 0 ? Math.min(100, (fullBytes / fullMaxBytes) * 100) : 0,
      lastArchiveAt: fullStats.lastArchiveAt || fileMtime(path.join(dir, 'memory-card-full.jsonl')),
      updatedAt: fullStats.updatedAt || ''
    },
    vector: {
      state: vecState,
      records: vecRows,
      maxRecords: Number(vmCfg.maxRecords) || 0,
      percent: Number(vmCfg.maxRecords) > 0 ? Math.min(100, (vecRows / Number(vmCfg.maxRecords)) * 100) : 0,
      enabled: vmCfg.enabled !== false,
      model: vmEff.model || '',
      modelSpace: vmEff.modelSpace || '',
      indexExists,
      indexFile,
      indexBytes: fileBytes(indexFile || indexJson) + (indexFile ? 0 : fileBytes(indexBin)),
      provider: vmCfg.provider || 'local',
      serviceUrl: vmCfg.serviceUrl || '',
      error: vecError,
      updatedAt: fileMtime(path.join(dir, 'vector-memory.jsonl'))
    },
    inbox: { lines: inboxLines, bytes: inboxBytes, maxBytes: INBOX_MAX_BYTES, percent: Math.min(100, (inboxBytes / INBOX_MAX_BYTES) * 100) },
    counts,
    groups,
    groupTotal,
    kinds: kindsSorted.map(([k, n]) => ({ k, n })),
    byDay: days,
    todayCount,
    range: { first: firstAt, last: lastAt },
    bili: { entries: biliEntries },
    disk: { memoryDir: memDirBytes, biliDir: biliDirBytes, promptQq, promptBili },
    rules: {
      dailyHour: Number(mc.dailyHour) || 4,
      forgetAfterDays: Number(mc.forgetAfterDays) || 60,
      minOwnerImportance: Number(mc.minOwnerImportance) || 65,
      // 分层保留（2026-11-10）：L3 当天结束删、L2 满三天删、L1 永久
      tierRetention: readTierRetention(mc && mc.tierRetention)
    },
    errors
  }
}

function readTierRetention(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const l2 = Number(src.l2Days)
  const l3 = Number(src.l3Days)
  const hour = Number(src.hour)
  return {
    enabled: src.enabled !== false,
    l2Days: Number.isFinite(l2) && l2 >= 0 ? Math.min(365, Math.round(l2)) : 3,
    l3Days: Number.isFinite(l3) && l3 >= 0 ? Math.min(365, Math.round(l3)) : 0,
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : 23
  }
}

export function tierOf(record) {
  if (!record) return 'L3'
  const tier = String(record.tier || '').toUpperCase()
  if (tier === 'L1' || tier === 'L2' || tier === 'L3') return tier
  if (record.pinned === true || record.anchor === true || record.firstMet === true) return 'L1'
  const importance = Number(record.importance) || 0
  if (importance >= 70) return 'L1'
  if (importance >= 40) return 'L2'
  return 'L3'
}

export function loadMemoryCardFile() {
  const found = findMemoryDir()
  if (!found.dir) return { role: '', dir: '', card: null }
  return { role: found.role, dir: found.dir, card: readJson(path.join(found.dir, 'memory-card.json'), null) }
}

export function buildMemoryTiers({ tier = '', q = '', object = '', limit = 20, offset = 0 } = {}) {
  const { role, dir, card } = loadMemoryCardFile()
  const records = card && Array.isArray(card.records) ? card.records : []
  const needle = String(q || '').trim().toLowerCase()
  const all = records.map((record) => ({
    id: String(record.id || ''),
    tier: tierOf(record),
    kind: record.kind || '',
    source: record.source || '',
    importance: Number(record.importance) || 0,
    createdAt: record.createdAt || '',
    summary: maskText(record.title || record.text || ''),
    objectKey: String(record.objectKey || record.conversationKey || ''),
    sensitive: record.sensitive === true,
    pinned: record.pinned === true,
  }))
  const filtered = all.filter((item) => {
    if (tier && item.tier !== tier) return false
    if (object) {
      const om = /^uin:(\d{5,12})$/.exec(object)
      const okey = String(item.objectKey || '')
      if (om) {
        if (!new RegExp('^(private|owner|user):' + om[1] + '$').test(okey)) return false
      } else if (okey !== object) return false
    }
    if (needle && !(item.summary + ' ' + item.kind + ' ' + item.id).toLowerCase().includes(needle)) return false
    return true
  }).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
  const counts = { L1: 0, L2: 0, L3: 0 }
  for (const item of all) counts[item.tier] += 1
  return { ok: true, role, dir, counts, object, total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) }
}

export function memoryItem(id) {
  const { card } = loadMemoryCardFile()
  const records = card && Array.isArray(card.records) ? card.records : []
  const record = records.find((r) => String(r.id) === String(id))
  if (!record) return { ok: false, message: '没有这条记忆（可能已被遗忘）' }
  return { ok: true, item: { ...record, tier: tierOf(record), title: record.title || '', text: record.text || '' } }
}

export function queueMemoryForget(id) {
  const entry = { action: 'forget', id: String(id), at: new Date().toISOString(), by: 'panel' }
  fs.mkdirSync(path.dirname(MEMORY_REQUEST), { recursive: true })
  atomicWriteJson(MEMORY_REQUEST, entry)
  appendAudit('memory-forget', { id: String(id) })
  return { ok: true, message: '已排队：插件下一次整理（10 分钟内）会把这条移出记忆卡' }
}

export function entriesOf(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return []
  for (const key of ['entries', 'items', 'list', 'records', 'stickers', 'words']) {
    if (Array.isArray(raw[key])) return raw[key]
  }
  return []
}

export function buildLexicon({ q = '', limit = 20, offset = 0 } = {}) {
  const raw = readJson(SLANG_FILE, null)
  if (!raw) return { ok: false, message: '还没有词汇本（state/slang.json 不存在）', items: [], total: 0 }
  const needle = String(q || '').trim().toLowerCase()
  const items = entriesOf(raw).map((entry) => ({
    id: String(entry.id || ''),
    word: maskText(entry.content || entry.word || '', 40),
    meaning: maskText(entry.meaning || '', 80),
    risk: entry.risk || '',
    status: entry.status || '',
    source: entry.source || '',
    count: Number(entry.count) || 0,
    updatedAt: entry.updatedAt || entry.createdAt || '',
  }))
  const filtered = needle
    ? items.filter((item) => (item.word + ' ' + item.meaning).toLowerCase().includes(needle))
    : items
  filtered.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
  return { ok: true, total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) }
}

export function buildStickers({ q = '', limit = 24, offset = 0 } = {}) {
  const raw = readJson(STICKER_FILE, null)
  if (!raw) return { ok: false, message: '还没有表情包库（state/stickers.json 不存在）', items: [], total: 0 }
  const needle = String(q || '').trim().toLowerCase()
  const items = entriesOf(raw).map((entry) => ({
    no: String(entry.no || entry.id || ''),
    desc: maskText(entry.desc || entry.description || '', 40),
    emotion: entry.emotion || (Array.isArray(entry.tags) ? entry.tags[0] : '') || '',
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 6) : [],
    useCount: Number(entry.useCount || entry.usage_count) || 0,
    source: entry.source || '',
  }))
  const filtered = needle
    ? items.filter((item) => (item.desc + ' ' + item.emotion + ' ' + item.tags.join(' ')).toLowerCase().includes(needle))
    : items
  filtered.sort((a, b) => b.useCount - a.useCount)
  return { ok: true, total: filtered.length, offset, limit, items: filtered.slice(offset, offset + limit) }
}


// ── 记忆热修改（面板）──────────────────────────────────────────────────────
// 一次 saveMemoryCardOutputs 同时写 memory-card.json/.md 与 full 档案的修订，
// 解决“卡和全量存档不一致”的问题；调用方负责审计 diff。
import { addManualMemory, loadMemoryCard, resolveMemoryCardPaths, saveMemoryCardOutputs } from '../../src/memory-card.js'
import { BRIDGE_CFG } from './paths.js'

function memoryCardConfig() {
  const c = readJson(path.join(SURF, 'config.json'), {}) || {}
  return c.memoryCard || {}
}

function memoryOwnerQQ() {
  const c = readJson(BRIDGE_CFG, {}) || {}
  return String(c.ownerQQ || '').replace(/[^\d]/g, '')
}

function pickPatch(record, patch) {
  const before = {}
  const after = {}
  const set = (key, value) => {
    if (String(record[key] ?? '') === String(value ?? '')) return
    before[key] = record[key]
    record[key] = value
    after[key] = value
  }
  if (patch.title !== undefined) set('title', String(patch.title).trim().slice(0, 80))
  if (patch.text !== undefined) {
    const text = String(patch.text).trim().slice(0, 1200)
    if (!text) throw new Error('正文不能为空')
    set('text', text)
  }
  if (patch.importance !== undefined) {
    const n = Math.round(Number(patch.importance))
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error('重要度必须是 1–100')
    set('importance', n)
  }
  for (const key of ['pinned', 'anchor', 'sensitive']) {
    if (patch[key] !== undefined) set(key, patch[key] === true)
  }
  if (patch.tags !== undefined) {
    const tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，\s]+/))
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
    set('tags', [...new Set(tags.map((t) => t.slice(0, 20)))])
  }
  return { before, after }
}

/** 编辑一条记忆：只允许白名单字段，落盘时 card + full 一起更新。 */
export function updateMemoryItem(id, patch = {}) {
  const found = loadMemoryCardFile()
  if (!found) throw new Error('找不到记忆卡')
  const paths = resolveMemoryCardPaths(found.dir)
  const card = loadMemoryCard(paths)
  if (!card) throw new Error('记忆卡解析失败')
  const record = card.records.find((r) => String(r.id) === String(id))
  if (!record) throw new Error('没有这条记忆（可能已经被压缩/遗忘）')
  const diff = pickPatch(record, patch || {})
  if (!Object.keys(diff.after).length) return { role: found.role, id, changed: false, before: {}, after: {} }
  record.updatedAt = new Date().toISOString()
  card.updatedAt = record.updatedAt
  const ownerQQ = memoryOwnerQQ()
  saveMemoryCardOutputs(paths, card, memoryCardConfig(), Date.now(), ownerQQ ? { ownerQQ, ownerPrivateKey: 'private:' + ownerQQ } : {})
  return { role: found.role, id, changed: true, before: diff.before, after: diff.after, record }
}

/** 面板新增一条手动记忆（走 addManualMemory，再统一落盘）。 */
export function addMemoryItem({ text, title = '', importance = 60, tags = [] } = {}) {
  const body = String(text || '').trim()
  if (!body) throw new Error('正文不能为空')
  if (body.length > 1200) throw new Error('正文最多 1200 字')
  const found = loadMemoryCardFile()
  if (!found) throw new Error('找不到记忆卡')
  const paths = resolveMemoryCardPaths(found.dir)
  const card = loadMemoryCard(paths)
  if (!card) throw new Error('记忆卡解析失败')
  const n = Math.round(Number(importance))
  const result = addManualMemory(card, {
    text: body,
    title: String(title || '').trim().slice(0, 80),
    importance: Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 60,
    scope: 'qq',
    tags: Array.isArray(tags) ? tags : []
  }, memoryCardConfig(), Date.now())
  if (!result || !result.record) throw new Error('这条记忆没有写进去（可能是重复内容）')
  const ownerQQ = memoryOwnerQQ()
  saveMemoryCardOutputs(paths, card, memoryCardConfig(), Date.now(), ownerQQ ? { ownerQQ, ownerPrivateKey: 'private:' + ownerQQ } : {})
  return { role: found.role, added: result.added, record: result.record }
}

/** 从文件尾部读一段（JSONL 可能很大，日志页只需要最近的部分）。 */

// ── 手动清空分层记忆（2026-11-11 主人要求：「加一个手动清的按钮」）──────────────
// 为什么面板自己动手：插件没有 memory 相关的 HTTP 路由，而真正干活的是 stellar/src/memory-store.js
// 里的 runTierMaintenance（带跨进程文件锁 + 清空前归档原文 + 先判晋升）。这里直接按同一份源码跑一次，
// 然后用 saveMemoryCardOutputs 重刷提示词文件 —— 否则要等插件下一个 10 分钟 tick 才会消失。
const MEMORY_SRC = new URL('../../src/', import.meta.url)

function tierConfigFromDisk() {
  const cfg = readJson(path.join(SURF, 'config.json'), {})
  const mc = cfg && cfg.memoryCard && typeof cfg.memoryCard === 'object' ? cfg.memoryCard : {}
  const tiers = mc.tiers && typeof mc.tiers === 'object' ? mc.tiers : {}
  return { card: mc, tiers }
}

export async function clearMemoryTier({ tier = 'L3', confirm = false, now = Date.now() } = {}) {
  const want = String(tier || '').toUpperCase()
  if (want !== 'L2' && want !== 'L3' && want !== 'BOTH') return { ok: false, message: 'tier 只能是 L2 / L3 / BOTH（L1 永不自动清，也不给手动清）' }
  if (confirm !== true) return { ok: false, message: '要清空分层记忆必须带 confirm:true（二次确认）' }
  const found = findMemoryDir()
  if (!found.dir) return { ok: false, message: '没找到记忆目录（角色还没建记忆卡？）' }
  const { card: cardCfg, tiers } = tierConfigFromDisk()
  const store = await import(new URL('memory-store.js', MEMORY_SRC).href)
  const cardMod = await import(new URL('memory-card.js', MEMORY_SRC).href)
  // 提示词文件在 memory-card 模块里是按 paths 结构写的；storePaths 给的就是同一套路径。
  const paths = store.storePaths(found.dir)
  const result = await store.runTierMaintenance({
    memoryDir: found.dir,
    config: cardCfg,
    tierConfig: tiers,
    now,
    forceClear: want === 'BOTH' ? 'both' : want,
  })
  let refreshed = false
  try {
    const card = cardMod.loadMemoryCard(paths)
    if (card) { cardMod.saveMemoryCardOutputs(paths, card, cardCfg, now); refreshed = true }
  } catch (e) { refreshed = String(e && e.message || e) }
  return {
    ok: true,
    dir: found.dir,
    tier: want,
    promoted: result.promoted || [],
    cleared: result.cleared || [],
    digest: result.digest || null,
    kept: result.kept,
    refreshed,
    at: new Date(now).toISOString(),
  }
}