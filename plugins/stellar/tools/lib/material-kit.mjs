// material-kit.mjs —— 日报 / 说说的「素材包」（只读聚合）。
//
// 为什么要有这一层：日报靠 report digest 汇总日志，说说靠一句 pool list 找图 —— 两条路都只看得到
// 「自己今天干了什么」，看不到她记下的 B站见闻 / 好友爱看 / 聊天记忆 / 小镇，配图也只能临场想。
// 素材包把这几处收成一份文本，外加按权重排好的配图候选，两个出口共用同一套口径：
//   B站封面 6 : 小镇相册 4 : 网上搜图 1 : AI 生成 1 —— 后两者是兜底，一周最多用 1 次。
//
// 硬约束（改之前先读）：
// · 只读：不写库、不删图、不动索引。唯一读的日志是 qzone-log.jsonl，用来统计兜底图用量。
// · 不新增配置段：权重是模块常量。配置值已经有五个来源（tools DEFAULTS / bili.config.json /
//   stellar/config.json / 面板回退 / 桥接）—— 再多一处，就没人说得清哪个值真的生效。
// · 读不到就降级：某一段失败只记 warning，不能让日报/说说整体失败。
// · 聊天记忆只给「标题 + 跟谁 + 几条」，不给正文：说说是公开的，正文一进上下文就有被转述的风险。
import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME, STELLAR_DIR } from './state-paths.mjs'
import { POOL_ROOT, listImages } from './image-pool.mjs'
// 小镇素材的读取整块在 src/town-kit.js（小镇逻辑只住 town-* 文件，见 scripts/town-decoupling-lib.mjs）。
import { collectTownKit, listTownAlbum, townAlbumRoot } from '../../../../src/town-kit.js'

export const IMAGE_SOURCE_WEIGHTS = Object.freeze({
  biliCover: 6,
  townAlbum: 4,
  webSearch: 1,
  aiGenerate: 1,
})

export const IMAGE_SOURCE_LABELS = Object.freeze({
  biliCover: 'B站封面',
  townAlbum: '小镇相册',
  webSearch: '网上搜图',
  aiGenerate: 'AI 生成',
  other: '其它图片',
})

/** 兜底图（网图 / AI 生成）每周最多几次。说说的图应该来自她自己看过、玩过的东西。 */
export const FALLBACK_WEEKLY_MAX = 1
/** 回看天数：和小镇存档的 TTL 对齐（3 天）。 */
export const LOOKBACK_DAYS = 3

const DAY_MS = 24 * 60 * 60 * 1000
const ZONE_NOTE_LIMIT = 6
const ZONE_TEXT_MAX = 180
const CHAT_LIMIT = 8
const FACT_LIMIT = 6
const ALBUM_LIMIT = 8
const QZONE_LOG = path.join(STELLAR_DIR, 'state', 'qzone-log.jsonl')

/** 本地自然日的 YYYY-MM-DD（和见闻区 / 小镇存档的 day_key 同一口径）。 */
export function todayStr(at = Date.now()) {
  return new Date(at).toLocaleDateString('sv-SE')
}

/** 回看窗口（新 → 旧）。 */
export function dayList(day = todayStr(), n = LOOKBACK_DAYS) {
  const out = []
  const raw = String(day || '')
  // 用本地中午当锚点：直接 new Date('YYYY-MM-DD') 是 UTC 零点，东八区会被 format 成前一天。
  const base = new Date(raw + 'T12:00:00')
  const t = Number.isNaN(base.getTime()) ? new Date() : base
  const count = Math.max(1, Math.min(7, Number(n) || LOOKBACK_DAYS))
  for (let i = 0; i < count; i += 1) out.push(new Date(t.getTime() - i * DAY_MS).toLocaleDateString('sv-SE'))
  return out
}

/** MM-DD，给人看。 */
export function fmtDay(value) {
  const s = String(value || '')
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(5, 10)
  return s ? s.slice(0, 5) : '--'
}

function readJsonl(file, max = 0) {
  const out = []
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    // 日志是追加写的：断电/被杀可能留下半行，坏行跳过，不能整体抛。
    try { out.push(JSON.parse(t)) } catch { /* skip */ }
  }
  return max > 0 ? out.slice(-max) : out
}

function absKey(p) {
  const s = String(p || '').trim()
  if (!s) return ''
  try { return path.resolve(s).toLowerCase() } catch { return s.toLowerCase() }
}

function underDir(file, dir) {
  const f = absKey(file)
  const d = absKey(dir)
  if (!f || !d) return false
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep)
}

/** 小镇相册目录（唯一的路径口径；别的模块要判断「这张图是不是相册里的」就调它）。 */
export function albumRootFor(dshHome = DSH_HOME) {
  return townAlbumRoot(dshHome)
}

/** 图片来自哪一级来源。所有出口的「权重」都从这一个判定出发，别在别处再写一遍 if。 */
export function classifyImageSource(file, { albumRoot = '' } = {}) {
  if (underDir(file, POOL_ROOT)) return 'biliCover'
  if (albumRoot && underDir(file, albumRoot)) return 'townAlbum'
  return 'other'
}

/**
 * 记忆：B站见闻区 / 好友爱看见闻区 / 最近话题（聊天）/ 重要事实。
 * 聊天只取元信息（标题、参与者、条数）；事实跳过 privacy=secret。
 */
export async function collectMemory({ day = todayStr(), days = LOOKBACK_DAYS, db } = {}) {
  const out = { zones: { bili: [], qzone: [] }, chat: [], facts: [], warnings: [] }
  let mem = null
  try {
    mem = await import('../../../../src/memory-db.js')
  } catch (e) {
    out.warnings.push('记忆库模块加载失败：' + (e && e.message ? e.message : String(e)))
    return out
  }
  const window = dayList(day, days)
  for (const zone of ['bili', 'qzone']) {
    for (const d of window) {
      let rows = []
      try {
        rows = mem.listZoneNotes({ zone, day: d, limit: ZONE_NOTE_LIMIT, db }) || []
      } catch (e) {
        out.warnings.push('见闻区读取失败（' + zone + ' ' + d + '）：' + (e && e.message ? e.message : String(e)))
      }
      for (const r of rows) {
        out.zones[zone].push({
          day: r.day_key || d,
          text: String(r.text || '').slice(0, ZONE_TEXT_MAX),
          items: Array.isArray(r.items) ? r.items.slice(0, 6) : [],
        })
      }
    }
  }
  try {
    const rows = typeof mem.recentTopics === 'function'
      ? (mem.recentTopics({ days, limit: CHAT_LIMIT, db }) || [])
      : []
    for (const r of rows) {
      out.chat.push({
        day: r.day_key || '',
        // 标题里出现 5 位以上数字多半是 QQ 号/群号：说说是公开出口，先去干净再给人看。
        title: String(r.title || '').replace(/^\[[^\]]{0,40}\]?\s*/, '').replace(/\d{5,}/g, '').trim().slice(0, 80),
        people: String(r.people || '').replace(/\d{5,}/g, '').trim().slice(0, 40),
        scope: String(r.scope || ''),
        tier: String(r.tier || ''),
        msgs: Number(r.msg_count) || 0,
      })
    }
  } catch (e) {
    out.warnings.push('聊天记忆读取失败：' + (e && e.message ? e.message : String(e)))
  }
  try {
    const rows = mem.listFacts({ limit: FACT_LIMIT * 4, db }) || []
    for (const f of rows) {
      if (!f) continue
      if (String(f.privacy || '') === 'secret') continue
      out.facts.push({
        kind: String(f.kind || ''),
        label: String(f.label || '').slice(0, 40),
        text: String(f.text || '').slice(0, 120),
        privacy: String(f.privacy || 'normal'),
      })
      if (out.facts.length >= FACT_LIMIT) break
    }
  } catch (e) {
    out.warnings.push('重要事实读取失败：' + (e && e.message ? e.message : String(e)))
  }
  return out
}

/** 配图候选：今天的 B站封面池 + 小镇相册。池子跨天自动清空，所以「今天」就是唯一窗口。 */
export async function collectImageCandidates({ now = new Date(), dshHome = DSH_HOME, albumRoot = '' } = {}) {
  const out = { candidates: [], albumRoot: albumRoot || '', warnings: [] }
  let root = albumRoot || ''
  if (!root) {
    const guess = albumRootFor(dshHome)
    if (fs.existsSync(guess)) root = guess
  }
  out.albumRoot = root
  try {
    // listImages 返回 { dir, day, images }（不是数组）；池里的图都是「今天手边能用的图」，按封面级权重算。
    const res = listImages({ now }) || {}
    const items = Array.isArray(res.images) ? res.images : []
    for (const it of items) {
      const file = String(it && it.file ? it.file : '')
      if (!file || !fs.existsSync(file)) continue
      out.candidates.push({
        source: 'biliCover',
        path: file,
        weight: IMAGE_SOURCE_WEIGHTS.biliCover,
        caption: String((it && (it.caption || it.name)) || '').slice(0, 60),
        key: String((it && it.key) || ''),
        at: String((it && it.at) || ''),
      })
    }
  } catch (e) {
    out.warnings.push('B站封面池读取失败：' + (e && e.message ? e.message : String(e)))
  }
  if (root) {
    try {
      const a = await listTownAlbum(dshHome, { limit: ALBUM_LIMIT })
      for (const it of (a && a.items) || []) {
        if (!it || !it.path || it.thumbOnly || !fs.existsSync(it.path)) continue
        out.candidates.push({
          source: 'townAlbum',
          path: it.path,
          weight: IMAGE_SOURCE_WEIGHTS.townAlbum,
          caption: String(it.what || '').slice(0, 80),
          key: String(it.id || ''),
          at: String(it.created || ''),
        })
      }
    } catch (e) {
      out.warnings.push('小镇相册读取失败：' + (e && e.message ? e.message : String(e)))
    }
  }
  return out
}

/**
 * 最近发过的说说：用来避开「上周刚配过的同一张图」，并统计兜底图本周用了几次。
 * 只认 qzone.mjs 写的新字段（imagePaths / imageSources）；老日志没有这两列，按「没配图」处理。
 */
export function readRecentPosts({ logFile = QZONE_LOG, days = 30, now = Date.now() } = {}) {
  const rows = readJsonl(logFile)
  const used = new Set()
  const since = now - days * DAY_MS
  const weekSince = now - 7 * DAY_MS
  let fallbackThisWeek = 0
  for (const r of rows) {
    if (!r || r.kind !== 'post') continue
    const at = Date.parse(String(r.at || ''))
    if (!Number.isFinite(at)) continue
    const paths = Array.isArray(r.imagePaths) ? r.imagePaths : []
    if (at >= since) for (const p of paths) { const k = absKey(p); if (k) used.add(k) }
    if (at >= weekSince) {
      const srcs = Array.isArray(r.imageSources) ? r.imageSources : []
      if (srcs.some((s) => s === 'webSearch' || s === 'aiGenerate' || s === 'other')) fallbackThisWeek += 1
    }
  }
  return { usedPaths: Array.from(used), fallbackThisWeek }
}

/**
 * 加权选图。关键词命中 ×4（她写的是「猫咪」就该优先 caption 里有「猫咪」的那张），
 * 否则按来源权重抽：封面 6 : 相册 4（本地），兜底来源不在这里抽 —— 它们是「本地什么都没有」时才走的另一条路。
 * rng 可注入，测试里用固定序列验证权重分布。
 */
export function pickImage(candidates, { keyword = '', exclude = [], rng = Math.random, weights = IMAGE_SOURCE_WEIGHTS } = {}) {
  const kw = String(keyword || '').trim().toLowerCase()
  const skip = new Set((exclude || []).map(absKey).filter(Boolean))
  const pool = (candidates || []).filter((c) => c && c.path && !skip.has(absKey(c.path)))
  if (!pool.length) return { ok: false, reason: 'no-local', considered: 0 }
  const scored = pool.map((c) => {
    const base = Number(weights[c.source]) || 1
    const hit = !!kw && String(c.caption || '').toLowerCase().includes(kw)
    return { c, weight: hit ? base * 4 : base, hit }
  })
  const total = scored.reduce((sum, s) => sum + s.weight, 0)
  let roll = rng() * total
  let chosen = scored[scored.length - 1]
  for (const s of scored) {
    roll -= s.weight
    if (roll <= 0) { chosen = s; break }
  }
  return {
    ok: true,
    source: chosen.c.source,
    path: chosen.c.path,
    caption: chosen.c.caption,
    weight: chosen.weight,
    keywordHit: chosen.hit,
    considered: scored.length,
    totalWeight: total,
  }
}

/** 一次把素材包收齐（两个出口都只用这一个入口，别各收各的）。 */
export async function buildKit({ day = todayStr(), now = Date.now(), days = LOOKBACK_DAYS, dshHome = DSH_HOME, audience = 'report' } = {}) {
  const mem = await collectMemory({ day, days })
  const town = await collectTownKit({ day, dshHome, days })
  const images = await collectImageCandidates({ now: new Date(now), dshHome, albumRoot: town.album.dir || '' })
  const recent = readRecentPosts({ now })
  const excluded = new Set(recent.usedPaths)
  const fresh = images.candidates.filter((c) => !excluded.has(absKey(c.path)))
  return {
    day,
    days: dayList(day, days),
    audience,
    builtAt: now,
    zones: mem.zones,
    chat: mem.chat,
    facts: mem.facts,
    town,
    images: { candidates: fresh, poolTotal: images.candidates.length, usedRecently: images.candidates.length - fresh.length },
    recent,
    warnings: mem.warnings.concat(town.warnings, images.warnings),
  }
}

/** 记忆段（日报直接用它；说说也用它，但会去掉「她记得的事」）。 */
export function renderMemoryLines(kit, { audience = (kit && kit.audience) || 'report' } = {}) {
  const k = kit || {}
  const lines = []
  const zones = k.zones || { bili: [], qzone: [] }
  const bili = zones.bili || []
  const qzone = zones.qzone || []
  // 说说是公开出口：条数更少、每条更短（够她借个话题就行），不给理由让模型自己「再想想」。
  const cap = audience === 'qzone' ? 6 : 8
  const cut = (text) => (audience === 'qzone' ? String(text).slice(0, 140) : String(text))
  lines.push('■ B站见闻（她看完视频记下的）')
  if (!bili.length) lines.push('- 这三天没记')
  for (const n of bili.slice(0, cap)) lines.push('- ' + fmtDay(n.day) + '：' + cut(n.text))
  lines.push('■ 好友爱看（她看过的别人的公开动态）')
  if (!qzone.length) lines.push('- 这三天没记')
  for (const n of qzone.slice(0, cap)) lines.push('- ' + fmtDay(n.day) + '：' + cut(n.text))
  lines.push('■ 聊天记忆（只给标题和跟谁，不是原文）')
  const chat = k.chat || []
  if (!chat.length) lines.push('- 这三天没有落库的话题')
  for (const c of chat.slice(0, CHAT_LIMIT)) {
    const who = c.people ? '跟 ' + c.people : '（一个人）'
    lines.push('- ' + fmtDay(c.day) + ' ' + who + '：' + (c.title || '（没标题）') + (c.msgs ? '（' + c.msgs + ' 条）' : ''))
  }
  if (audience === 'qzone') {
    lines.push('  · 说说是公开发出去的：只能借「聊过什么、什么感觉」，不许复述内容、不许提对方的号或真名。')
  } else if (k.facts && k.facts.length) {
    lines.push('■ 她记得的事（用得着才提一句，别硬塞）')
    for (const f of k.facts.slice(0, FACT_LIMIT)) {
      const label = f.label || f.kind || '记着'
      const tail = f.privacy === 'private' ? '（私事，群里别提）' : ''
      lines.push('- ' + label + '：' + f.text + tail)
    }
  }
  const t = k.town || {}
  lines.push('■ 小镇')
  if (t.recall) for (const line of String(t.recall).split('\n')) if (line.trim()) lines.push('  ' + line.trim())
  const dayLine = (t.dayLines || []).find((d) => d && d.day === k.day) || (t.dayLines || [])[0]
  if (dayLine) lines.push('  · 她给小镇留的那句（' + fmtDay(dayLine.day) + '）：' + String(dayLine.line || '').slice(0, 120))
  lines.push('  · 相册 ' + ((t.album && t.album.total) || 0) + ' 张')
  return lines
}

/** 配图段：本地候选（带权重与路径）+ 兜底额度。 */
export function renderImageLines(kit) {
  const k = kit || {}
  const cands = (k.images && k.images.candidates) || []
  const recent = k.recent || {}
  const lines = []
  lines.push('■ 配图候选（权重：B站封面 6 / 小镇相册 4 / 兜底 1）')
  if (!cands.length) lines.push('- 今天本地没有能用的图（封面池空、相册也空）')
  for (const c of cands.filter((x) => x.source === 'biliCover').slice(0, 8)) {
    lines.push('- [B站封面·6] ' + c.path + (c.caption ? ' —— ' + c.caption : ''))
  }
  for (const c of cands.filter((x) => x.source === 'townAlbum').slice(0, 8)) {
    lines.push('- [小镇相册·4] ' + c.path + (c.caption ? ' —— ' + c.caption : ''))
  }
  const used = Number(recent.fallbackThisWeek) || 0
  const left = Math.max(0, FALLBACK_WEEKLY_MAX - used)
  lines.push('- [兜底·1] 网上搜图 / AI 生成：本周已用 ' + used + '/' + FALLBACK_WEEKLY_MAX
    + (left > 0 ? '（本地图都不贴合才用，且只用一张）' : '（额度用完，今天只能用本地图）'))
  lines.push('- 选图：node bili.mjs material --for qzone --pick --kw "<文案关键词>"，拿到路径直接 --image')
  return lines
}

/** 完整素材包文本。 */
export function renderKit(kit, { audience = (kit && kit.audience) || 'report' } = {}) {
  const k = kit || {}
  const days = k.days || []
  const lines = []
  lines.push('【素材包 · ' + (k.day || todayStr()) + '（回看 ' + days.length + ' 天：' + days.join(' / ') + '）】')
  lines.push('')
  lines.push(...renderMemoryLines(k, { audience }))
  lines.push('')
  lines.push(...renderImageLines(k))
  const warns = k.warnings || []
  if (warns.length) {
    lines.push('')
    lines.push('■ 读取时的问题（照实说，别编）')
    for (const w of warns.slice(0, 5)) lines.push('- ' + w)
  }
  return lines.join('\n')
}
