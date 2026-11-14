#!/usr/bin/env node
// B站 vlog：把她今天看完视频之后的想法，做成一条带配音的视频，交主人审核后再发布。
//
// 三条设计原则（对应主人 m16352 的要求）：
//   1. **本地渲染**：画面 SVG → PNG → ffmpeg，配音是合成音（滴滴声，但带语气与停顿），
//      不调任何外部生成服务 → 内容本身零成本，成本只来自她写脚本那几轮对话。
//   2. **钱要有数**：每次生成前后记一次花费（按 token-usage.jsonl 真实价目算），
//      写进 vlog/cost.json，当日超过上限就拒绝生成（默认 5 元/天）。
//   3. **发布必须过主人**：render 只把成片放进队列；publish 默认只演练，
//      --go 才真正上传；控制台的「通过并发布」按钮就是带 --go 的这一次调用。
//
// 子命令：
//   node bili.mjs vlog plan                     看她今天该聊什么（读评分/观看/日记）
//   node bili.mjs vlog render [--date] [--out] [--rework <id>]  读 script-<date>.json 渲染成片并入队（--rework 表示这是重做的）
//   node bili.mjs vlog queue [--limit]          看审核队列
//   node bili.mjs vlog publish <id> [--go]      发布（不带 --go 只演练：上传但不投稿）
//   node bili.mjs vlog manual <id> --bvid BV…   自己传完了，把 BV 记回来（复盘要用）
//   node bili.mjs vlog reject <id> [--reason]   驳回（会标记成「待完成」，她得按原因重做）
//   node bili.mjs vlog fix [--all]              看有哪些被驳回需要重做的（含原因）
//   node bili.mjs vlog reflect [--id]           抓昨天那条的播放/点赞/评论，写复盘
//   node bili.mjs vlog cost                     今天花了多少、还剩多少
//   node bili.mjs vlog status                   汇总（队列/成本/开关）
//
// script-<date>.json 长这样（她自己写）：
//   { "title":"…", "desc":"…", "tags":["…"], "scenes":[{ "kind":"title|note|quote|list|fact|outro", "title":"…", "text":"…" }] }
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { biliState } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { renderVlog, MIN_SECONDS, MAX_SECONDS, MAX_SCENES } from '../lib/vlog-render.mjs'
import { checkScriptPrivacy, privacyRejectText } from '../lib/privacy-guard.mjs'
import { readCredentials, publishVlog, CREATIVE_URL } from '../lib/bili-upload.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..', '..')       // .../stellar
const STATE_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
const VLOG_DIR = biliState('vlog')
const QUEUE_FILE = path.join(VLOG_DIR, 'queue.json')
const COST_FILE = path.join(VLOG_DIR, 'cost.json')
const REFLECT_FILE = path.join(VLOG_DIR, 'reflect.jsonl')
const USAGE_FILE = path.join(ROOT, 'state', 'token-usage.jsonl')

const day = (d = new Date()) => d.toLocaleDateString('sv-SE')
const nowIso = () => new Date().toISOString()
const argOf = (argv, name, dflt = '') => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt }
const has = (argv, name) => argv.includes(name)
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return dflt } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, file)
}
const cfg = () => config()?.vlog || {}
const limits = () => ({ dailyCNY: num(cfg().dailyCostCNY, 5), minSeconds: num(cfg().minSeconds, MIN_SECONDS), maxSeconds: num(cfg().maxSeconds, MAX_SECONDS) })

// ── 花费账：按 token-usage.jsonl 的真实价目算，不估算 ─────────────────────────
let priceCache = null
async function priceModules() {
  if (priceCache) return priceCache
  const p = 'file:///' + path.join(ROOT, 'src', 'model-prices.js').replace(/\\/g, '/')
  const mod = await import(p)
  priceCache = mod
  return mod
}

/** 统计 (from,to) 之间的真实花费；只算 base 采样行（外部记录另算） */
export async function costBetween(from, to = Date.now()) {
  const { priceUsage } = await priceModules()
  let text = ''
  try { text = fs.readFileSync(USAGE_FILE, 'utf8') } catch { return { cost: 0, tokens: 0, rows: 0 } }
  let cost = 0, tokens = 0, rows = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r = null
    try { r = JSON.parse(line) } catch { continue }
    if (r.k !== 'base') continue
    const t = Number(r.t) || 0
    if (t < from || t >= to) continue
    const b = r.b || {}
    const buckets = { inputTokens: num(b.cacheMiss, 0), cacheReadTokens: num(b.cacheHit, 0), cacheWriteTokens: num(b.cacheWrite, 0), outputTokens: num(b.output, 0), reasoningTokens: num(b.reasoning, 0) }
    const p = priceUsage(buckets, { model: String(r.model || ''), at: t })
    cost += p.cost.total
    tokens += buckets.inputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
    rows += 1
  }
  return { cost, tokens, rows }
}

function costBook() { return readJson(COST_FILE, { days: {} }) }
function spentToday() { const d = day(); return num(costBook().days?.[d]?.cny, 0) }
function addCost(entry) {
  const book = costBook()
  const d = day()
  const cur = book.days[d] || { cny: 0, tokens: 0, items: [] }
  cur.cny = Number((cur.cny + num(entry.cny, 0)).toFixed(4))
  cur.tokens = num(cur.tokens, 0) + num(entry.tokens, 0)
  cur.items = [...(cur.items || []), { at: nowIso(), ...entry }].slice(-40)
  book.days[d] = cur
  // 只留 30 天
  const keep = Object.keys(book.days).sort().slice(-30)
  const trimmed = {}
  for (const k of keep) trimmed[k] = book.days[k]
  writeJson(COST_FILE, { days: trimmed })
  return cur
}

// ── 素材：今天看了什么、打了多少分、日记里写了什么 ──────────────────────────
function todayScores() {
  const all = readJson(biliState('scores.json'), {})
  const list = Array.isArray(all[day()]) ? all[day()] : []
  return [...list].sort((a, b) => Number(b.score) - Number(a.score))
}

function todayWatch() {
  const candidates = ['watch-history.json', 'watch.json', 'history.json']
  for (const name of candidates) {
    const file = biliState(name)
    const data = readJson(file, null)
    if (!data) continue
    const list = Array.isArray(data) ? data : (Array.isArray(data.entries) ? data.entries : [])
    const today = list.filter((e) => String(e?.at || e?.time || e?.watchedAt || '').startsWith(day()))
    if (today.length) return today
  }
  return []
}

function recentDiary(lines = 8) {
  const file = biliState('whale-diary.md')
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (!text) return ''
    return text.split('\n').slice(-lines).join('\n')
  } catch { return '' }
}

function brief() {
  const scores = todayScores().slice(0, 6)
  const watched = todayWatch()
  const cfgNow = cfg()
  return {
    date: day(),
    scores: scores.map((s) => ({ bv: s.bv, score: s.score, title: s.title || '', reason: s.reason || '' })),
    watchedCount: watched.length,
    watched: watched.slice(0, 8).map((w) => ({ bv: w.bv || w.bvid || '', title: w.title || '' })),
    diary: recentDiary(),
    rules: {
      minSeconds: limits().minSeconds, maxSeconds: limits().maxSeconds, maxScenes: MAX_SCENES,
      dailyCostCNY: limits().dailyCNY, spentToday: spentToday(),
      kinds: ['title', 'note', 'quote', 'list', 'fact', 'outro'],
    },
  }
}

function cmdPlan(argv) {
  const b = brief()
  if (spentToday() >= limits().dailyCNY) {
    console.log('[vlog] 今天生成预算已用完（¥' + spentToday().toFixed(2) + ' / ¥' + limits().dailyCNY.toFixed(2) + '），今天不再生成。明天再来，或让主人在控制台调高上限。')
    process.exitCode = 3
    return
  }
  console.log(JSON.stringify(b, null, 2))
  console.log('\n-- 下一步 --')
  console.log('把想说的写成 ' + path.join(VLOG_DIR, 'script-' + day() + '.json') + '，然后跑：node bili.mjs vlog render')
  console.log('要求：场景 ' + limits().minSeconds + ' 秒以上（大概 12 个场景），最多 ' + MAX_SCENES + ' 个；每个场景 text 不超过 90 字。')
  console.log('只讲今天真的看过的东西，别编。标题像人话，别用「震惊」「必看」。')
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
function validateScript(s) {
  const problems = []
  if (!s || typeof s !== 'object') return ['脚本不是 JSON 对象']
  if (!String(s.title || '').trim()) problems.push('缺 title')
  if (!Array.isArray(s.scenes) || !s.scenes.length) problems.push('缺 scenes')
  else {
    if (s.scenes.length > MAX_SCENES) problems.push('场景太多（' + s.scenes.length + ' > ' + MAX_SCENES + '）')
    s.scenes.forEach((sc, i) => {
      const kinds = ['title', 'note', 'quote', 'list', 'fact', 'outro']
      if (!kinds.includes(String(sc.kind || 'note'))) problems.push('第 ' + (i + 1) + ' 个场景 kind 不认识：' + sc.kind)
      const text = String(sc.text || sc.title || '')
      if (!text.trim()) problems.push('第 ' + (i + 1) + ' 个场景没有文字')
      if (text.length > 160) problems.push('第 ' + (i + 1) + ' 个场景太长（' + text.length + ' 字），拆开说')
    })
  }
  return problems
}

async function cmdRender(argv) {
  const date = argOf(argv, '--date', day())
  if (spentToday() >= limits().dailyCNY) {
    console.log('[vlog] 今天生成预算已用完（¥' + spentToday().toFixed(2) + ' / ¥' + limits().dailyCNY.toFixed(2) + '），不渲染。')
    process.exitCode = 3
    return
  }
  const scriptFile = path.join(VLOG_DIR, 'script-' + date + '.json')
  const script = readJson(scriptFile, null)
  if (!script) { console.error('找不到脚本：' + scriptFile + '\n先跑 node bili.mjs vlog plan 看素材，再按模板写脚本。'); process.exitCode = 2; return }
  const problems = validateScript(script)
  if (problems.length) { console.error('脚本不合格：\n- ' + problems.join('\n- ')); process.exitCode = 4; return }

  // 隐私闸门：标题/简介/标签/全部场景文本一起查。命中直接拒，不渲染——
  // 2026-11-10 介绍片把主人生日与城市渲染进了成片，就是因为这里没有闸门。
  const privacy = checkScriptPrivacy(script)
  if (!privacy.ok) {
    console.error(privacyRejectText(privacy.hits) + '\n命中的是：' + privacy.hits.map((h) => h.why + '「' + h.text + '」').join('、'))
    process.exitCode = 8
    return
  }

  const workDir = path.join(VLOG_DIR, 'out', date + '-' + Date.now().toString(36))
  fs.mkdirSync(workDir, { recursive: true })
  const startedAt = Date.now()
  console.log('[vlog] 开始渲染 ' + script.scenes.length + ' 个场景…')
  let result
  try {
    result = await renderVlog({
      scenes: script.scenes,
      title: String(script.title || ''),
      audioLines: script.scenes.map((s) => ({ text: String(s.text || s.title || '') })),
      workDir,
    })
  } catch (error) {
    console.error('渲染失败：' + String(error?.message || error))
    process.exitCode = 5
    return
  }
  const spent = await costBetween(startedAt)
  const book = addCost({ kind: 'render', id: path.basename(workDir), cny: spent.cost, tokens: spent.tokens, seconds: result.seconds })
  console.log('[vlog] 成片 ' + result.seconds.toFixed(1) + 's · ' + (result.bytes / 1048576).toFixed(2) + 'MB · 渲染花费 ¥' + spent.cost.toFixed(4))

  if (result.seconds < limits().minSeconds) {
    console.error('成片只有 ' + result.seconds.toFixed(1) + ' 秒，低于 ' + limits().minSeconds + ' 秒下限：脚本要再多说几句（大概 ' + Math.ceil(limits().minSeconds / 5) + ' 个场景）。成片留在 ' + workDir + '，不放进审核队列。')
    process.exitCode = 6
    return
  }
  if (result.seconds > limits().maxSeconds) {
    console.error('成片 ' + result.seconds.toFixed(1) + ' 秒，超过 ' + limits().maxSeconds + ' 秒上限：删几个场景。成片留在 ' + workDir + '。')
    process.exitCode = 6
    return
  }

  const reworkId = argOf(argv, '--rework', '')
  const queue = readJson(QUEUE_FILE, { items: [] })
  const oldItem = reworkId ? (queue.items || []).find((x) => x.id === reworkId) : null
  if (reworkId && !oldItem) console.log('[vlog] 提示：找不到要返工的 ' + reworkId + '，这条按新视频处理。')
  const item = {
    id: 'vlog-' + date + '-' + Math.random().toString(36).slice(2, 6),
    date, title: String(script.title || ''), desc: String(script.desc || ''), tags: Array.isArray(script.tags) ? script.tags.slice(0, 10) : [],
    cover: result.cover, file: result.file, seconds: Number(result.seconds.toFixed(1)), bytes: result.bytes,
    scenes: script.scenes.length, createdAt: nowIso(), status: 'pending', costCNY: Number(spent.cost.toFixed(4)), creative: CREATIVE_URL,
    // 返工链：新条目指向旧条目，旧条目在下面标成已完成（面板上才会从「驳回」区消失）
    reworkOf: oldItem ? oldItem.id : '',
    revision: oldItem ? Number(oldItem.revision || 1) + 1 : 1,
  }
  queue.items = [item, ...(queue.items || [])].slice(0, 50)
  if (oldItem) {
    oldItem.fixState = 'done'
    oldItem.reworkedAt = nowIso()
    oldItem.supersededBy = item.id
    writeJson(QUEUE_FILE, queue)
    console.log('[vlog] 返工完成：' + oldItem.id + ' → ' + item.id + '（旧的已标成完成，不再占「待处理」）')
  }
  writeJson(QUEUE_FILE, queue)
  console.log('[vlog] 已入队待审核：' + item.id + '（控制台「她」页 → 待发布的视频）')
  console.log('今天生成累计 ¥' + book.cny.toFixed(2) + ' / ¥' + limits().dailyCNY.toFixed(2))
}

function cmdQueue(argv) {
  const limit = num(argOf(argv, '--limit', '10'), 10)
  const queue = readJson(QUEUE_FILE, { items: [] })
  const items = (queue.items || []).slice(0, limit)
  if (!items.length) { console.log('审核队列是空的。'); return }
  for (const it of items) {
    console.log('[' + it.status + '] ' + it.id + ' · ' + it.seconds + 's · ¥' + num(it.costCNY, 0).toFixed(3))
    console.log('  标题：' + it.title)
    console.log('  文件：' + it.file)
    if (it.bvid) console.log('  已发布：BV' + it.bvid)
    if (it.error) console.log('  上次失败：' + String(it.error).slice(0, 160))
    if (it.rejectReason) console.log('  驳回原因：' + it.rejectReason + (it.fixState === 'todo' ? '（待完成）' : ''))
  }
}

// ── 发布 ────────────────────────────────────────────────────────────────────
async function cmdPublish(argv) {
  const id = argv.find((a) => /^vlog-/.test(a)) || argOf(argv, '--id', '')
  const go = has(argv, '--go')
  const queue = readJson(QUEUE_FILE, { items: [] })
  const item = (queue.items || []).find((x) => x.id === id)
  if (!item) { console.error('队列里没有 ' + (id || '(没给 id)')); process.exitCode = 2; return }
  if (item.status === 'published') { console.log('这条已经发布过了：BV' + item.bvid); return }
  // 二次闸门：标题/简介/标签可能在控制台被改过，脚本场景也可能被改，发布前再查一次。
  const guard = checkScriptPrivacy({ title: item.title, desc: item.desc, tags: item.tags, scenes: readJson(path.join(VLOG_DIR, 'script-' + item.date + '.json'), {}).scenes || [] })
  if (!guard.ok) {
    console.error(privacyRejectText(guard.hits) + '\n命中的是：' + guard.hits.map((h) => h.why + '「' + h.text + '」').join('、'))
    process.exitCode = 8
    return
  }
  const cred = readCredentials()
  if (!cred.ok) { console.error('没有 B站 cookie（' + cred.file + '），无法发布。'); process.exitCode = 3; return }
  console.log('[vlog] ' + (go ? '正式发布' : '演练（上传但不投稿）') + '：' + item.title)
  try {
    const res = await publishVlog({
      file: item.file, cover: item.cover, title: item.title, desc: item.desc, tags: item.tags,
      tid: num(cfg().tid, 21), dry: !go, onLog: (m) => console.log('  ' + m),
    })
    item.status = go ? 'published' : 'dry'
    item.published = go ? { bvid: res.bvid, aid: res.aid, at: nowIso() } : item.published
    if (res.bvid) item.bvid = res.bvid
    item.error = ''
    item.logs = (res.logs || []).slice(-20)
    writeJson(QUEUE_FILE, queue)
    if (go && res.bvid) console.log('[vlog] 发布成功：https://www.bilibili.com/video/BV' + res.bvid)
    else console.log('[vlog] 演练结束，未投稿。确认无误后用 --go 真正发布，或去控制台点「通过并发布」。')
  } catch (error) {
    item.error = String(error?.message || error).slice(0, 500)
    // 失败要留证据：失败时间、试过几次、最后一次的原始输出，控制台要能照着排查
    item.status = 'failed'
    item.failAt = nowIso()
    item.attempts = Number(item.attempts || 0) + 1
    item.failLogs = (item.failLogs || []).concat([item.error]).slice(-5)
    writeJson(QUEUE_FILE, queue)
    console.error('[vlog] 发布失败：' + item.error)
    console.error('成片与文案都还在，可以去创作中心手动投：' + CREATIVE_URL)
    console.error('手动投完之后，跑 node bili.mjs vlog manual ' + item.id + ' --bvid BV… 记一下，第二天的复盘才能接上。')
    process.exitCode = 5
  }
}

// ── 手动发布登记：脚本上传不通时，主人在创作中心自己传，再把 BV 记回来 ──────
function cmdManual(argv) {
  const id = argv.find((a) => /^vlog-/.test(a)) || argOf(argv, '--id', '')
  const bvid = argOf(argv, '--bvid', '')
  const queue = readJson(QUEUE_FILE, { items: [] })
  const item = (queue.items || []).find((x) => x.id === id)
  if (!item) { console.error('队列里没有 ' + (id || '(没给 id)')); process.exitCode = 2; return }
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    console.error('要一个 BV 号（形如 BV1xx411c7mD），没给或格式不对：' + (bvid || '(空)'))
    process.exitCode = 2
    return
  }
  item.status = 'published'
  item.bvid = bvid
  item.published = { bvid, aid: 0, at: nowIso(), manual: true }
  item.error = ''
  item.decidedAt = nowIso()
  writeJson(QUEUE_FILE, queue)
  console.log('已登记为已发布（手动）：' + id + ' → https://www.bilibili.com/video/' + bvid)
}

function cmdReject(argv) {
  const id = argv.find((a) => /^vlog-/.test(a)) || argOf(argv, '--id', '')
  const reason = argOf(argv, '--reason', '')
  const queue = readJson(QUEUE_FILE, { items: [] })
  const item = (queue.items || []).find((x) => x.id === id)
  if (!item) { console.error('队列里没有 ' + id); process.exitCode = 2; return }
  item.status = 'rejected'
  item.rejectReason = reason.slice(0, 200)
  item.decidedAt = nowIso()
  // 2026-11-10 owner 要求：驳回不是终点，是「待完成」——控制台把它挪进「驳回」区，
  // 调度器看到 fixState==='todo' 就会在她上线时叫她按原因重做（重做完标 done）。
  item.fixState = 'todo'
  item.rejectedAt = item.decidedAt
  writeJson(QUEUE_FILE, queue)
  console.log('已驳回：' + id + (reason ? '（原因：' + reason + '）' : ''))
  console.log('已标记为待完成：她会按这个原因重做一条（node bili.mjs vlog render --rework ' + id + '）。')
}

// ── 返工清单：被驳回、还没重做的那几条 ──────────────────────────────────
function cmdFix(argv) {
  const all = has(argv, '--all')
  const queue = readJson(QUEUE_FILE, { items: [] })
  const items = (queue.items || []).filter((x) => x.status === 'rejected' && (all || x.fixState !== 'done'))
  if (!items.length) { console.log('没有要返工的视频。'); return }
  for (const it of items) {
    const state = it.fixState === 'done' ? '已重做' : '待完成'
    console.log('[' + state + '] ' + it.id + ' · ' + it.seconds + 's · 驳回于 ' + String(it.rejectedAt || it.decidedAt || '').slice(0, 16))
    console.log('  标题：' + it.title)
    console.log('  驳回原因：' + (it.rejectReason || '（主人没写）'))
    if (it.supersededBy) console.log('  重做成了：' + it.supersededBy)
    const script = path.join(VLOG_DIR, 'script-' + it.date + '.json')
    if (fs.existsSync(script)) console.log('  原脚本：' + script)
  }
  console.log('');
  console.log('做法：按原因改 script-<date>.json → node bili.mjs vlog render --rework <id>（旧的会自动标成已重做）。')
}

// ── 复盘：昨天的视频数据 ────────────────────────────────────────────────────
async function cmdReflect(argv) {
  const queue = readJson(QUEUE_FILE, { items: [] })
  const id = argOf(argv, '--id', '')
  const published = (queue.items || []).filter((x) => x.status === 'published' && (x.bvid || x.published?.bvid))
  const target = id ? published.find((x) => x.id === id) : published[0]
  if (!target) { console.log('还没有发布过的视频，没什么可复盘的。'); return }
  const bvid = target.bvid || target.published?.bvid
  const cred = readCredentials()
  const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', referer: 'https://www.bilibili.com/' }
  if (cred.sessdata) headers.cookie = 'SESSDATA=' + cred.sessdata
  const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { headers })
  const j = await r.json().catch(() => null)
  if (!j || Number(j.code) !== 0) { console.error('取不到稿件数据：' + (j ? j.code + ' ' + j.message : 'HTTP ' + r.status)); process.exitCode = 4; return }
  const st = j.data.stat || {}
  const dur = num(j.data.duration, 0)
  const aid = num(j.data.aid, 0)
  // 弹幕/评论不能只看条数：抓几条真的话回来，第二天照着改内容
  let samples = { comments: [], danmaku: [] }
  try {
    if (aid) {
      const { fetchComments } = await import('../lib/bili-comments.mjs')
      const got = await fetchComments({ aid, want: 8, sort: 'hot' })
      samples.comments = (got.list || []).slice(0, 6).map((c) => ({ like: num(c.like, 0), text: String(c.message || '').slice(0, 120) }))
    }
  } catch {}
  try {
    const dr = await fetch('https://api.bilibili.com/x/v1/dm/list.so?oid=' + (aid || '') + '&type=1', { headers })
    if (dr.ok) {
      const xml = await dr.text()
      samples.danmaku = Array.from(xml.matchAll(/<d[^>]*>([^<]{1,80})<\/d>/g)).slice(-200).map((m) => m[1]).slice(0, 20)
    }
  } catch {}
  const row = {
    at: nowIso(), id: target.id, bvid, title: target.title,
    view: num(st.view, 0), like: num(st.like, 0), coin: num(st.coin, 0), favorite: num(st.favorite, 0),
    danmaku: num(st.danmaku, 0), reply: num(st.reply, 0), share: num(st.share, 0),
    durationSec: dur,
    likeRate: dur ? Number(((num(st.like, 0) / Math.max(1, num(st.view, 1))) * 100).toFixed(2)) : 0,
    coinPerK: Number(((num(st.coin, 0) / Math.max(1, num(st.view, 1))) * 1000).toFixed(2)),
    favPerK: Number(((num(st.favorite, 0) / Math.max(1, num(st.view, 1))) * 1000).toFixed(2)),
    comments: samples.comments, danmaku: samples.danmaku,
  }
  fs.mkdirSync(VLOG_DIR, { recursive: true })
  fs.appendFileSync(REFLECT_FILE, JSON.stringify(row) + '\n')
  target.lastReflect = row
  writeJson(QUEUE_FILE, queue)
  console.log(JSON.stringify(row, null, 2))
  console.log('\n-- 怎么用 --')
  console.log('看完这些数字再决定下一条怎么改：播放低=标题封面不行；点赞低=内容不痛；评论少=没留话头；投币率=值不值；弹幕在骂哪一句，就改哪一句。')
}

function cmdCost() {
  const book = costBook()
  const d = day()
  const today = book.days?.[d] || { cny: 0, tokens: 0, items: [] }
  const limit = limits().dailyCNY
  console.log(JSON.stringify({
    date: d, spentCNY: Number(num(today.cny, 0).toFixed(4)), limitCNY: limit,
    leftCNY: Number(Math.max(0, limit - num(today.cny, 0)).toFixed(4)),
    tokens: num(today.tokens, 0), renders: (today.items || []).length,
    days: Object.entries(book.days || {}).slice(-7).map(([k, v]) => ({ date: k, cny: Number(num(v.cny, 0).toFixed(3)) })),
  }, null, 2))
}

function cmdStatus() {
  const queue = readJson(QUEUE_FILE, { items: [] })
  const items = queue.items || []
  console.log(JSON.stringify({
    dir: VLOG_DIR,
    enabled: cfg().enabled !== false,
    window: cfg().window || '12:00-14:00',
    today: day(),
    pending: items.filter((x) => x.status === 'pending').length,
    published: items.filter((x) => x.status === 'published').length,
    failed: items.filter((x) => x.status === 'failed').length,
    spentCNY: Number(spentToday().toFixed(4)),
    limitCNY: limits().dailyCNY,
    latest: items.slice(0, 3).map((x) => ({ id: x.id, status: x.status, title: x.title, seconds: x.seconds, bvid: x.bvid || '' })),
  }, null, 2))
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const sub = argv[0] || 'status'
const rest = argv.slice(1)
const run = async () => {
  if (sub === 'plan') return cmdPlan(rest)
  if (sub === 'render') return await cmdRender(rest)
  if (sub === 'queue' || sub === 'list') return cmdQueue(rest)
  if (sub === 'publish') return await cmdPublish(rest)
  if (sub === 'manual') return cmdManual(rest)
  if (sub === 'reject') return cmdReject(rest)
  if (sub === 'fix') return cmdFix(rest)
  if (sub === 'reflect') return await cmdReflect(rest)
  if (sub === 'cost') return cmdCost()
  if (sub === 'status') return cmdStatus()
  console.error('未知子命令：' + sub + '\n可用：plan / render / queue / publish / manual / reject / fix / reflect / cost / status')
  process.exitCode = 2
}
await run()
