// 字幕「目录 + 命中窗口」：把一条视频的字幕压成一次能读完的索引。
//
// 背景（2026-11-21，主人拍板 A+D：更准确地知晓视频内容，但又要省 token）：
//   她看一条视频的钱几乎全花在「每一步都把 ~40 万 token 的上下文重发一遍」上；
//   而字幕正文（实测 500 字/分钟）以前只有两种极端用法 —— 要么完全不进上下文，
//   要么整篇 read 进来（16 分钟约 5,000 token，还要再多一次工具往返）。
//   这里给第三条路，全部零模型、零网络、零依赖：
//     1) 目录：每 5 分钟抽「首句 + 末句」（抽取式），60 分钟的视频也只有十来行；
//     2) 命中窗口：按问题做词法检索（CJK 二元/三元 + 拉丁词 + 时间引用），只回 2~3 个 75 秒窗口；
//     3) 覆盖率：哪几段根本没有字幕 —— 这是 D 的事实边界，让她能说「这段没字幕，不能确定」。
//
// 用法（由 debrief 建、find 读）：
//   debrief 落盘 <BV>-digest.json（只存 [秒, 正文] 数组 + 覆盖率）
//   find --q "问题" / --at mm:ss / --outline 读它算分，每次输出控制在 1,200 字符量级。

export const DIGEST_VERSION = 1
export const DEFAULT_WINDOW_SEC = 75          // 命中窗口长度：一个段子 / 一个知识点
export const DEFAULT_BLOCK_SEC = 300          // 目录块：5 分钟
export const DEFAULT_HIT_LIMIT = 3
export const MAX_HIT_CHARS = 220              // 单个窗口正文上限（超了从命中词附近截）
export const MAX_OUTLINE_LINES = 12
export const GAP_SEC = 20                     // 相邻字幕间隔超过它算「这段没字幕」

const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们',
  '这', '那', '这个', '那个', '什么', '怎么', '为什么', '可以', '就是', '还是',
  '但是', '因为', '所以', '然后', '如果', '已经', '一个', '时候', '现在', '这样',
  '那样', '不是', '没有', '知道', '觉得', '应该',
  'the', 'and', 'for', 'that', 'this', 'with', 'you', 'are', 'was', 'but', 'not'
])

const fmt = (s) => {
  const n = Math.max(0, Number(s) || 0)
  const h = Math.floor(n / 3600)
  const m = Math.floor((n % 3600) / 60)
  const sec = Math.floor(n % 60)
  return h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
    : String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0')
}

/** 「12:34」「1:02:03」「第 6 分钟」→ 秒；认不出回 null。 */
export function parseTimeRef(text) {
  const s = String(text ?? '')
  const hms = /(\d{1,2}):(\d{2}):(\d{2})/.exec(s)
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])
  const ms = /(\d{1,3}):(\d{2})/.exec(s)
  if (ms) return Number(ms[1]) * 60 + Number(ms[2])
  const cn = /第\s*(\d{1,3})\s*分/.exec(s)
  if (cn) return Number(cn[1]) * 60
  return null
}

/** 把 [mm:ss] 正文 / [hh:mm:ss] 正文 的文本切成 [{from, to, text}]；to 由下一行与字数推。 */
export function parseSubtitleText(text) {
  const rows = []
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/.exec(line)
    if (!m) continue
    const from = parseTimeRef(m[1])
    const content = m[2].replace(/\s+/g, ' ').trim()
    if (from == null || !content) continue
    rows.push({ from, to: from + 3, text: content })
  }
  rows.sort((a, b) => a.from - b.from)
  for (let i = 0; i < rows.length; i += 1) {
    const next = rows[i + 1]
    const natural = rows[i].from + Math.max(1, Math.min(12, Math.ceil(rows[i].text.length / 12)))
    rows[i].to = next ? Math.max(rows[i].from + 0.5, Math.min(next.from, natural)) : natural
  }
  return rows
}

/** 覆盖率：字幕没讲到的时间段（含片头/片尾）。 */
export function coverageOf(lines, durationSec) {
  const rows = Array.isArray(lines) ? lines : []
  const dur = Math.max(0, Number(durationSec) || 0)
  const gaps = []
  if (!rows.length) {
    if (dur > GAP_SEC) gaps.push({ from: 0, to: dur })
    return { gaps, coveredSec: 0, ratio: 0, lines: 0 }
  }
  const push = (from, to) => {
    if (to - from > GAP_SEC) gaps.push({ from: Math.round(from), to: Math.round(to) })
  }
  push(0, rows[0].from)
  for (let i = 1; i < rows.length; i += 1) push(rows[i - 1].to, rows[i].from)
  const tailStart = rows[rows.length - 1].to
  if (dur > tailStart) push(tailStart, dur)
  const coveredSec = Math.max(0, (dur || tailStart) - gaps.reduce((n, g) => n + (g.to - g.from), 0))
  return { gaps, coveredSec, ratio: dur ? coveredSec / dur : 0, lines: rows.length }
}

/** 建 digest：只存 [秒, 正文] 与覆盖率，窗口/目录都在读的时候现算（单一事实来源）。 */
export function buildDigest({ lines, durationSec, title = '', bvid = '' } = {}) {
  const rows = Array.isArray(lines) ? lines : []
  const dur = Math.max(0, Number(durationSec) || (rows.length ? rows[rows.length - 1].to : 0))
  const coverage = coverageOf(rows, dur)
  return {
    v: DIGEST_VERSION,
    bvid: String(bvid || ''),
    title: String(title || ''),
    durationSec: Math.round(dur),
    builtAt: new Date().toISOString(),
    lines: rows.map((l) => [Math.round(Number(l.from) || 0), String(l.text || '')]),
    coverage: { gaps: coverage.gaps, coveredSec: Math.round(coverage.coveredSec) }
  }
}

/** 窗口化：定长窗口，按行的起始时间归位（正文不跨窗口复制）。 */
export function windowsOf(digest, { sec = DEFAULT_WINDOW_SEC } = {}) {
  const rows = (digest?.lines ?? []).map(([from, text]) => ({ from: Number(from) || 0, text: String(text || '') }))
  const win = Math.max(15, Number(sec) || DEFAULT_WINDOW_SEC)
  // 窗口只铺到「全长 or 最后一句开始 + 1 秒」—— 结尾的空白交给 coverageOf 报缺口，
  // 别为了兜最后一句凭空多铺一个空窗口（16 分钟会变成 14 个窗口、目录也多一段）。
  const dur = Math.max(Number(digest?.durationSec) || 0, rows.length ? rows[rows.length - 1].from + 1 : 0)
  const count = Math.max(1, Math.ceil(dur / win))
  const out = []
  for (let i = 0; i < count; i += 1) {
    const from = i * win
    const to = Math.min(dur, from + win)
    const body = []
    for (const r of rows) {
      if (r.from < from || r.from >= to) continue
      if (body.length && body[body.length - 1] === r.text) continue
      body.push(r.text)
    }
    out.push({ i, from, to, text: body.join(' ') })
  }
  return out
}

/** 目录：每 blockSec 秒一段，取该段第一句和最后一句（抽取式，不改写、不调模型）。 */
export function outlineOf(digest, { blockSec = DEFAULT_BLOCK_SEC } = {}) {
  const rows = (digest?.lines ?? []).map(([from, text]) => ({ from: Number(from) || 0, text: String(text || '') }))
  if (!rows.length) return []
  const dur = Math.max(Number(digest?.durationSec) || 0, rows[rows.length - 1].from)
  let block = Math.max(60, Number(blockSec) || DEFAULT_BLOCK_SEC)
  const blocksAt = (b) => Math.max(1, Math.ceil(dur / b))
  while (blocksAt(block) > MAX_OUTLINE_LINES) block *= 2
  const out = []
  const n = blocksAt(block)
  for (let i = 0; i < n; i += 1) {
    const from = i * block
    const to = Math.min(dur, from + block)
    const inBlock = rows.filter((r) => r.from >= from && r.from < to)
    if (!inBlock.length) { out.push({ from, to, first: '', last: '', lines: 0 }); continue }
    const clip = (s, max) => (s.length > max ? s.slice(0, max) + '…' : s)
    out.push({ from, to, first: clip(inBlock[0].text, 60), last: clip(inBlock[inBlock.length - 1].text, 60), lines: inBlock.length })
  }
  return out
}

const flat = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** 切词：拉丁词整词 + CJK 二元/三元。返回 [{t, w}]（同词取最大权重）。 */
export function tokenize(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase()
  const bag = new Map()
  const put = (t, w) => {
    if (!t || STOP.has(t)) return
    const cur = bag.get(t)
    if (!cur || cur.w < w) bag.set(t, { t, w })
  }
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_+.#-]{1,}/g)) put(m[0].replace(/[._-]+$/, ''), 1.2)
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    for (let i = 0; i + 2 <= run.length; i += 1) put(run.slice(i, i + 2), 1)
    for (let i = 0; i + 3 <= run.length; i += 1) put(run.slice(i, i + 3), 1.5)
  }
  return [...bag.values()]
}

/**
 * 检索：返回按分数降序的窗口。
 * 打分 = 命中词权重和 + 整句命中加分 + 时间引用命中加分；分数 < minScore 不算命中。
 */
export function searchDigest(digest, question, { limit = DEFAULT_HIT_LIMIT, minScore = 1, windowSec = DEFAULT_WINDOW_SEC } = {}) {
  const wins = windowsOf(digest, { sec: windowSec })
  const flatWins = wins.map((w) => flat(w.text))
  const total = wins.length
  const qt = tokenize(question)
  const phrase = flat(question)
  const timeRef = parseTimeRef(question)
  // 文档频率：满片都有的词（「然后」「我们」）要打折，只在 1 个窗口出现的词才值钱。
  // 没有这一步时，一句「快充 充电多久」会把 13 个窗口打成同分（实测）。
  const df = new Map()
  for (const f of flatWins) for (const tk of qt) if (f.includes(tk.t)) df.set(tk.t, (df.get(tk.t) || 0) + 1)
  const hits = []
  for (let i = 0; i < wins.length; i += 1) {
    const w = wins[i]
    const wf = flatWins[i]
    if (!wf) continue
    let score = 0
    const matched = []
    for (const tk of qt) {
      if (!wf.includes(tk.t)) continue
      const n = df.get(tk.t) || 0
      score += tk.w * Math.log(1 + total / (1 + n))
      matched.push(tk.t)
    }
    // 展示用命中词：被三元覆盖的二元不再重复列出（「快充」「个快充」只留后者）
    for (let i = matched.length - 1; i >= 0; i -= 1) {
      const a = matched[i]
      for (let j = 0; j < matched.length; j += 1) {
        if (i !== j && matched[j].length > a.length && matched[j].includes(a)) { matched.splice(i, 1); break }
      }
    }
    matched.length = Math.min(matched.length, 6)
    if (phrase.length >= 4 && wf.includes(phrase)) score += 5
    if (timeRef != null && timeRef >= w.from && timeRef < w.to) { score += 4; matched.push('时间:' + fmt(timeRef)) }
    if (score >= minScore) hits.push({ ...w, score: Math.round(score * 10) / 10, matched })
  }
  hits.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length || a.from - b.from)
  return { hits: hits.slice(0, Math.max(1, Number(limit) || DEFAULT_HIT_LIMIT)), total: hits.length, hasTimeRef: timeRef != null }
}

/** 命中窗口的正文：超长就从第一个命中词附近截，别把无关的前半段塞进来。 */
export function hitSnippet(hit, maxChars = MAX_HIT_CHARS) {
  const text = String(hit?.text ?? '').trim()
  if (text.length <= maxChars) return text
  const words = (hit?.matched ?? []).filter((m) => !m.startsWith('时间:'))
  let at = -1
  for (const t of words) { const i = text.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i }
  let start = at > 40 ? Math.max(0, at - 40) : 0
  // 退到最近的句读，别从半个词/半句话开始（实测截断后开头会是「…句：然后…」）
  if (start > 0) {
    for (let i = start; i > Math.max(0, start - 30); i -= 1) {
      if ('。！？；，、,.!?;'.includes(text[i])) { start = i + 1; break }
    }
    while (start < text.length && text[start] === ' ') start += 1
  }
  const lead = start > 0 ? '…' : ''
  const tail = start + maxChars < text.length ? '…' : ''
  // 省略号也算进预算：调用方按 maxChars 排版面，多两个字符就会换行
  const budget = Math.max(20, maxChars - lead.length - tail.length)
  const body = text.slice(start, start + budget)
  return lead + body + (start + budget < text.length ? '…' : '')
}

/** 目录文本（debrief 与 find --outline 共用）。 */
export function outlineText(digest, { blockSec = DEFAULT_BLOCK_SEC, maxChars = 2000 } = {}) {
  const rows = outlineOf(digest, { blockSec })
  if (!rows.length) return '（没有字幕，出不了目录）'
  const head = '目录（全长 ' + fmt(digest.durationSec) + '，' + rows.length + ' 段，每段首句 + 末句）'
  const body = rows.map((r) => {
    const range = fmt(r.from) + '-' + fmt(r.to)
    if (!r.lines) return range + ' | （这段没字幕）'
    return range + ' | ' + r.first + (r.first === r.last ? '' : '  …  ' + r.last)
  })
  let out = [head, ...body].join('\n')
  if (out.length > maxChars) {
    out = [head, ...rows.map((r) => fmt(r.from) + '-' + fmt(r.to) + ' | ' + (r.lines ? '有字幕' : '（没字幕）'))].join('\n')
  }
  return out
}

/** 覆盖率文本（D 的事实边界：说得出「哪段没字幕」）。 */
export function coverageText(digest) {
  const cov = digest?.coverage ?? { gaps: [], coveredSec: 0 }
  const dur = Number(digest?.durationSec) || 0
  const lines = (digest?.lines ?? []).length
  if (!lines) return '字幕覆盖：0 / ' + fmt(dur) + '（这条视频没有官方字幕 —— 只能靠弹幕/评论/画面，别编台词）'
  const pct = Math.round((Number(cov.coveredSec) / Math.max(1, dur)) * 100)
  const head = '字幕覆盖 ' + fmt(cov.coveredSec) + ' / ' + fmt(dur) + '（' + pct + '%，' + lines + ' 行）'
  const gaps = (cov.gaps ?? []).slice(0, 6).map((g) => fmt(g.from) + '-' + fmt(g.to))
  return gaps.length
    ? head + '\n没字幕的段：' + gaps.join('、') + ((cov.gaps ?? []).length > 6 ? ' …' : '')
    : head
}

/** 命中结果文本：每段一行时间戳 + 分数 + 命中词，下面是正文。 */
export function hitsText(digest, hits, { maxChars = MAX_HIT_CHARS } = {}) {
  if (!hits.length) return '没有命中（换个说法，或者看目录找时间点，再 find --at mm:ss）。'
  const lines = ['命中 ' + hits.length + ' 段（按相关度；字幕全文没读进上下文）：']
  for (const h of hits) {
    const why = h.matched.length ? '命中 ' + h.matched.join(' ') : '整句命中'
    lines.push('[' + fmt(h.from) + '-' + fmt(h.to) + '] 分 ' + h.score + '｜' + why)
    lines.push('  ' + hitSnippet(h, maxChars))
  }
  return lines.join('\n')
}

/** 某个时间点所在的窗口（--at），ring 可以往两边扩。 */
export function windowAt(digest, atSec, { windowSec = DEFAULT_WINDOW_SEC, ring = 0 } = {}) {
  const wins = windowsOf(digest, { sec: windowSec })
  if (!wins.length) return []
  const at = Math.max(0, Number(atSec) || 0)
  const idx = wins.findIndex((w) => at >= w.from && at < w.to)
  const center = idx >= 0 ? idx : Math.max(0, Math.min(wins.length - 1, Math.floor(at / windowSec)))
  const from = Math.max(0, center - ring)
  const to = Math.min(wins.length - 1, center + ring)
  return wins.slice(from, to + 1)
}

export const formatClock = fmt
