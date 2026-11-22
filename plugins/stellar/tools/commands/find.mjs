// 按问题查一条视频的字幕：只回命中的几段，不把全文读进上下文。
//
// 为什么有它（2026-11-21，主人拍板 A+D）：
//   看一条视频的钱几乎全花在「每一步把 40 万 token 的上下文重发一遍」上，而字幕正文
//   500 字/分钟 —— 整篇读进来是几千 token + 一次工具往返，不读又只能猜。
//   这里读 debrief 建好的 digest（零网络、零模型），只回 2~3 个 75 秒窗口 + 覆盖率。
//
// 用法：
//   node bili.mjs find <BV>                     # 目录 + 覆盖率（十几行，看不出细节）
//   node bili.mjs find <BV> --q "这个快充头能充多快"   # 命中窗口（默认 3 段）
//   node bili.mjs find <BV> --at 6:10           # 那一段的原文
//   node bili.mjs find <BV> --q "…" --limit 2 --window 60 --ring 1
//
// 判据（D 的事实边界）：返回值一定带「字幕覆盖 x/全长」，有缺口就列出来 ——
// 让她能说「这段没字幕，不能确定」，而不是拿弹幕/评论脑补成台词。
import fs from 'node:fs'
import path from 'node:path'
import { shotsPath } from '../lib/shots-cache.mjs'
import {
  buildDigest,
  coverageText,
  hitsText,
  outlineText,
  parseSubtitleText,
  parseTimeRef,
  searchDigest,
  windowAt,
  formatClock
} from '../lib/subs-digest.mjs'

const argv = process.argv.slice(2)
const bvid = argv.find((a) => !a.startsWith('--'))
if (!bvid) {
  console.error('用法: node bili.mjs find <BV> [--q "问题"] [--at mm:ss] [--outline] [--limit 3] [--window 75] [--ring 0] [--json]')
  process.exit(2)
}
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const key = argv[i].slice(2)
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) opt[key] = true
  else { opt[key] = next; i += 1 }
}

const dir = shotsPath('subs')
const digestFile = path.join(dir, bvid + '-digest.json')
const legacyTxt = path.join(dir, bvid + '-debrief.txt')

function loadDigest() {
  try {
    const raw = JSON.parse(fs.readFileSync(digestFile, 'utf8'))
    if (raw && Array.isArray(raw.lines)) return { digest: raw, from: 'digest' }
  } catch {}
  // 自愈：只有老的 debrief.txt（或 digest 坏了）时就地补一份，省得让她重跑一遍联网 debrief
  try {
    const text = fs.readFileSync(legacyTxt, 'utf8')
    const lines = parseSubtitleText(text)
    if (!lines.length) return null
    const digest = buildDigest({ lines, durationSec: lines[lines.length - 1].to, bvid })
    try { fs.writeFileSync(digestFile, JSON.stringify(digest)) } catch {}
    return { digest, from: 'rebuilt' }
  } catch { return null }
}

const loaded = loadDigest()
if (!loaded) {
  console.error('还没有这条视频的字幕索引：先看一遍（会顺手建索引）\n' +
    '  node bili.mjs debrief ' + bvid + ' --no-frames\n' +
    '（找的是 ' + digestFile + '；没有官方字幕的视频建不出索引）')
  process.exit(4)
}
const { digest, from } = loaded
const winSec = Math.max(15, Math.min(600, Number(opt.window) || 75))
const limit = Math.max(1, Math.min(6, Number(opt.limit) || 3))
const ring = Math.max(0, Math.min(3, Number(opt.ring) || 0))
const head = bvid + '  ' + (digest.title || '（无标题）') + '  ' + formatClock(digest.durationSec) + (from === 'rebuilt' ? '  （索引是刚补的）' : '')

const wantJson = opt.json === true
let body = ''
let question = ''

if (typeof opt.q === 'string' && opt.q.trim()) {
  question = opt.q.trim()
  const res = searchDigest(digest, question, { limit, windowSec: winSec })
  body = hitsText(digest, res.hits)
  if (!res.hits.length) body += '\n（也可以先看目录：find ' + bvid + ' --outline）'
} else if (opt.at !== undefined) {
  const at = parseTimeRef(typeof opt.at === 'string' ? opt.at : '') ?? Number(opt.at)
  if (!Number.isFinite(at)) { console.error('--at 要写成 6:10 或 370（秒）'); process.exit(2) }
  const wins = windowAt(digest, at, { windowSec: winSec, ring })
  body = wins.length
    ? wins.map((w) => '[' + formatClock(w.from) + '-' + formatClock(w.to) + ']\n  ' + (w.text || '（这段没字幕）')).join('\n')
    : '（这段时间没有字幕）'
} else {
  body = outlineText(digest)
  body += '\n' + coverageText(digest).split('\n')[0]
  body += '\n问细节：find ' + bvid + ' --q "你的问题"（或 QQ 会话里的 stellar_bili_find；只回 2~3 段，别读字幕全文）'
}

if (wantJson) {
  console.log(JSON.stringify({ bvid, title: digest.title, durationSec: digest.durationSec, question, coverage: digest.coverage, text: body }))
  process.exit(0)
}

// 覆盖率只在有缺口时补一行，避免每次多花 token
const cov = digest.coverage || { gaps: [] }
const gapLine = (cov.gaps || []).length ? coverageText(digest).split('\n').slice(-1)[0] : ''
console.log(head)
console.log(body)
if (gapLine && typeof opt.q === 'string') console.log(gapLine)

const totalChars = head.length + body.length
if (totalChars > 2400) console.error('（输出 ' + totalChars + ' 字符，偏长了：把 --limit 调小，或用 --at 精确取一段）')
