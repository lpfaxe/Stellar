#!/usr/bin/env node
/**
 * 一眼看全 B站 状态（只读）。
 *
 * 为什么要有它：她每趟醒来要跑十几次 bili.mjs（今天看了几条 / 额度剩多少 /
 *   冷却到没到 / 日记末几行 / 评分多少），每次都是一整个模型往返（约 ¥0.04）。
 *   合成一条命令后，一趟「查状态」只花一次调用。
 *
 * 数据源全部 import 现成 lib，**不自己重新解析**（避免出现第二份真相）：
 *   quota 计数口径与 commands/quota.mjs 的 status 分支一致；
 *   本周观看数来自 watch-history.mjs（按 bvid 去重、含 .1 轮转）；
 *   点赞数来自 fish-guard.mjs 的 daily 账。
 *
 * 纪律：除读文件外不写任何东西，也不发网络请求；输出里不出现 cookie/token/QQ 号。
 * 注册：tools/lib/cmd-map.mjs 的 status 键（bili.mjs 的 map 正在往那里抽，本文件不碰入口）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { biliState, biliStateDir, accountBili } from '../lib/state-paths.mjs'
import { config } from '../lib/config.mjs'
import { freeLimits } from '../lib/limits.mjs'
import { todayScores } from '../lib/scores.mjs'
import { readWatchHistory, countWatchThisWeek } from '../lib/watch-history.mjs'
import { loadFishGuardState, fishGuardStateSummary } from '../lib/fish-guard.mjs'

// accountBili 只 import 不读：账号级的 credentials.json 里是 cookie，
// 这条命令刻意不碰它 —— 状态里没有任何一项需要密钥才能算出来。
void accountBili

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) opt[argv[i].slice(2)] = true
  else { opt[argv[i].slice(2)] = next; i += 1 }
}

const clampInt = (value, fallback, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
const DIARY_LINES = clampInt(opt.diary, 8, 0, 40)
const SCORE_LINES = clampInt(opt.scores, 5, 0, 20)

const NOW = new Date()
const dateText = NOW.toLocaleDateString('sv-SE')
const timeText = NOW.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
const nowMs = NOW.getTime()
const dayOf = (at) => {
  const t = new Date(at)
  return Number.isFinite(t.getTime()) ? t.toLocaleDateString('sv-SE') : ''
}
const isToday = (x) => dayOf(x?.at) === dateText

/** 读 JSON；文件不存在 = 空，存在但坏了 = 标记 corrupt（不能默默当 0）。 */
function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return { value: fallback, corrupt: false }
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')), corrupt: false }
  } catch {
    return { value: fallback, corrupt: true }
  }
}

const cfg = config()
const L = freeLimits(cfg)
const capText = (n) => (Number(n) > 0 ? Number(n) : '不限')

// ── 今天：进度（看过 / 深读 / 记分 / 收藏 / 点赞 / 动态）──────────────
const hist = readWatchHistory({ days: 1, limit: 200, now: nowMs })
const watchedRows = (hist.items ?? []).filter(isToday)
const watchedToday = watchedRows.length
const deepToday = watchedRows.filter((x) => x.mode === 'full' || x.mode === 'frames').length
const scores = todayScores()
const scoreRows = scores.slice(0, SCORE_LINES)

const favState = readJsonSafe(biliState('favorites.json'), { items: [] })
const favToday = (Array.isArray(favState.value?.items) ? favState.value.items : []).filter(isToday).length

const likes = fishGuardStateSummary(loadFishGuardState(), cfg.fishGuard ?? {})

const dynState = readJsonSafe(biliState('daily-dynamic.json'), {})
const DYN_KINDS = ['best', 'game', 'anime', 'gaming']
const dynFlags = Object.fromEntries(DYN_KINDS.map((k) => [k, dynState.value?.[k]?.date === dateText]))
const dynDone = DYN_KINDS.filter((k) => dynFlags[k]).length

// ── 四本账：过滤条件逐字照 commands/quota.mjs:108-122，别另立语义 ─────────
const quotaState = readJsonSafe(biliState('quota.json'), { log: [] })
const log = Array.isArray(quotaState.value?.log) ? quotaState.value.log : []
const rowsToday = log.filter(isToday)
const isAutoComment = (x) => x?.type === 'comment' && !!x?.auto && !x?.share
// 普通评论 = 顶层、自主、非分享；回评 = 回找我的人（排除搭话与自己动态）；
// 搭话 = 带 ta；分享 = 任意带 share 的记录（与 quota status 完全一致）。
const isFree = (x) => isAutoComment(x) && !x?.reply
const isReply = (x) => isAutoComment(x) && !!x?.reply && !x?.ta && !x?.mine
const isTa = (x) => x?.type === 'comment' && !!x?.auto && !x?.share && !!x?.ta
const isMine = (x) => isAutoComment(x) && !!x?.reply && !!x?.mine
const usedFree = rowsToday.filter(isFree).length
const usedReply = rowsToday.filter(isReply).length
const usedTa = rowsToday.filter(isTa).length
const usedShare = rowsToday.filter((x) => !!x?.share).length
const mine = {
  best: rowsToday.filter((x) => isMine(x) && (x.mine === true || x.mine === 'best')).length,
  game: rowsToday.filter((x) => isMine(x) && x.mine === 'game').length,
  anime: rowsToday.filter((x) => isMine(x) && x.mine === 'anime').length,
  gaming: rowsToday.filter((x) => isMine(x) && x.mine === 'gaming').length,
}
const mineTotal = rowsToday.filter(isMine).length
const shareDaily = Number(cfg.quota?.shareDaily ?? 3)

// ── 本周：观看数 / 上限（配置没写或 <=0 = 不限）──────────────────────
const weekWatched = countWatchThisWeek({ now: nowMs })
const weeklyMax = Number(cfg.night?.weeklyMax ?? 0)
const weekUnlimited = !(weeklyMax > 0)
const weekRemaining = weekUnlimited ? null : Math.max(0, weeklyMax - weekWatched)

// ── 冷却：按账本里**该类型最后一条**的 at 算，和 free-gate 的分钟数同一来源 ──
function lastOf(rows) {
  let best = null
  let bestT = -Infinity
  for (const row of rows) {
    const t = new Date(row?.at).getTime()
    if (Number.isFinite(t) && t > bestT) { bestT = t; best = row }
  }
  return best
}
function cooldownOf(rows, minutes) {
  const last = lastOf(rows)
  if (!last?.at) return { state: 'none', lastAt: null, waitMin: 0, minutes }
  const t = new Date(last.at).getTime()
  if (!Number.isFinite(t)) return { state: 'unknown', lastAt: null, waitMin: 0, minutes }
  if (!(Number(minutes) > 0)) return { state: 'free', lastAt: last.at, waitMin: 0, minutes: 0 }
  // ceil 与 free-gate 的提示一致：还差 1 分钟时绝不显示「已过」。
  const waitMin = Math.ceil((Number(minutes) * 60_000 - (Date.now() - t)) / 60_000)
  return waitMin > 0
    ? { state: 'wait', lastAt: last.at, waitMin, minutes: Number(minutes) }
    : { state: 'free', lastAt: last.at, waitMin: 0, minutes: Number(minutes) }
}
// 全局闸：free-gate 里任意两条**自主发言**之间都要隔 globalMin（分享不算）。
const cdGlobal = cooldownOf(log.filter(isAutoComment), L.globalMin)
const cdComment = cooldownOf(log.filter(isFree), L.globalMin)
const cdTa = cooldownOf(log.filter(isTa), L.globalMin)
// 分钟数写成人看的：1440 分钟 → 24 小时（同一条楼默认就是一天一次）。
const minutesText = (n) => (n >= 120 && n % 60 === 0 ? `${n / 60} 小时` : `${n} 分钟`)
const cooldownText = (label, c) => {
  if (c.state === 'none') return `${label}：今天还没`
  if (c.state === 'unknown') return `${label}：—`
  if (c.state === 'wait') return `${label}：还差 ${minutesText(c.waitMin)}`
  return `${label}：已过`
}

// ── 日记：只读末尾 N 行（不解析、不重组，避免编造她没写过的内容）─────────
function tailLines(file, n) {
  if (!(n > 0)) return []
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-n)
}
const diaryPublic = tailLines(biliState('whale-diary.md'), DIARY_LINES)
const diaryPrivate = tailLines(biliState('whale-diary-private.md'), DIARY_LINES)

// ── 提醒：启动测试没跑过 → 直接告诉她下一步命令 ────────────────────────
const reminders = []
if (!fs.existsSync(path.join(biliStateDir(), 'selftest-passed.json'))) {
  reminders.push('还没跑启动测试：node bili.mjs selftest')
}
if (quotaState.corrupt) reminders.push('quota.json 不是合法 JSON —— 评论类只能按 0 计，先修账本')

// ── --json：字段名与下面各段一一对应，方便宿主/测试直接取 ───────────────
if (opt.json) {
  const payload = {
    ok: true,
    generatedAt: NOW.toISOString(),
    date: dateText,
    time: `${dateText} ${timeText}`,
    today: {
      watched: watchedToday,
      deep: deepToday,
      scored: scores.length,
      favorites: favToday,
      likes: { daily: likes.dailyLikes, max: likes.maxLikesPerDay },
      dynamics: { ...dynFlags, done: dynDone, total: DYN_KINDS.length },
      comments: {
        free: usedFree,
        reply: usedReply,
        ta: usedTa,
        mine,
        mineTotal,
        share: usedShare,
        total: rowsToday.length,
      },
    },
    caps: {
      daily: L.daily,
      replyDaily: L.replyDaily,
      taDaily: L.taDaily,
      mineDaily: L.mineDaily,
      minePerPerson: L.minePerPerson,
      shareDaily,
      globalMin: L.globalMin,
      perThreadMin: L.perThreadMin,
    },
    week: { watched: weekWatched, max: weekUnlimited ? 0 : weeklyMax, unlimited: weekUnlimited, remaining: weekRemaining },
    cooldown: {
      global: cdGlobal,
      comment: cdComment,
      ta: cdTa,
      likes: { daily: likes.dailyLikes, max: likes.maxLikesPerDay, cooldown: false },
      share: { daily: usedShare, max: shareDaily },
    },
    scores: scoreRows.map((s, i) => ({
      score: Number(s.score) || 0,
      bv: String(s.bv ?? ''),
      title: String(s.title ?? ''),
      reason: String(s.reason ?? ''),
      at: s.at ?? null,
      best: i === 0,
    })),
    diary: {
      lines: DIARY_LINES,
      public: diaryPublic ?? [],
      private: diaryPrivate ?? [],
      publicMissing: diaryPublic === null,
      privateMissing: diaryPrivate === null,
    },
    reminders,
  }
  console.log(JSON.stringify(payload, null, 2))
  process.exit(0)
}

// ── 纯文本 ────────────────────────────────────────────────────────
const out = []
out.push(`== B站 状态 · ${dateText} ${timeText} ==`)
out.push(`【今天】看过 ${watchedToday} 条（深读 ${deepToday}）· 记分 ${scores.length} · 收藏 ${favToday} · 点赞 ${likes.dailyLikes}/${likes.maxLikesPerDay} · 动态 ${dynDone}/${DYN_KINDS.length}`)
out.push(`  四本账：普通评论 ${usedFree}/${capText(L.daily)} · 回评 ${usedReply}/${capText(L.replyDaily)} · 搭话 ${usedTa}/${capText(L.taDaily)} · 动态回复 ${mineTotal}（best ${mine.best} · game ${mine.game} · anime ${mine.anime} · gaming ${mine.gaming}，每类 ${capText(L.mineDaily)}/天）· 分享 ${usedShare}/${shareDaily}`)
out.push(`【本周】看过 ${weekWatched}/${weekUnlimited ? '不限' : weeklyMax}${weekUnlimited ? '' : `（还剩 ${weekRemaining} 条）`}`)
out.push(`【冷却】${cooldownText('全局', cdGlobal)} ｜ ${cooldownText('普通评论', cdComment)} ｜ ${cooldownText('搭话', cdTa)} ｜ 点赞：今天已赞 ${likes.dailyLikes}/${likes.maxLikesPerDay}（不设冷却） ｜ 分享：今天 ${usedShare}/${shareDaily}`)
// 上面三个冷却只按 globalMin 算（跨类型的那道闸）。真正要动手评某一条时，
// free-gate 还按「同一个视频 / 同一个 UP / 同一条楼」各卡一次 —— 这里照实提示，
// 免得她看到「已过」就以为可以随便评。
const extraGates = []
if (L.perVideoMin > 0) extraGates.push(`同一视频 ${minutesText(L.perVideoMin)}`)
if (L.perUpMin > 0) extraGates.push(`同一 UP ${minutesText(L.perUpMin)}`)
if (L.perThreadMin > 0) extraGates.push(`同一条楼 ${minutesText(L.perThreadMin)}`)
if (extraGates.length) out.push(`  另外按对象算：${extraGates.join(' · ')}（从"上次评过那一条"起算）`)
out.push(`【评分】${scores.length} 条${scores.length ? `（最高 ${scores[0].score}/20）` : ''}`)
if (!scoreRows.length) out.push('  （今天还没打分）')
for (const [i, s] of scoreRows.entries()) {
  const title = String(s.title || s.reason || '').slice(0, 40)
  out.push(`  ${i === 0 ? '★ ' : '  '}${Number(s.score) || 0}/20  ${s.bv || '—'}  ${title}`)
}
if (scores.length > scoreRows.length) out.push(`  …还有 ${scores.length - scoreRows.length} 条（--scores N 可调）`)
if (DIARY_LINES > 0) {
  for (const [label, lines] of [['公开', diaryPublic], ['私密', diaryPrivate]]) {
    out.push(`【日记·${label}末 ${DIARY_LINES} 行】`)
    if (lines === null) out.push('（还没有）')
    else if (!lines.length) out.push('（空）')
    else for (const line of lines) out.push('  ' + line.slice(0, 300))
  }
}
for (const reminder of reminders) out.push(reminder)

// 硬性上限：一条命令的输出不能把上下文吃光。超了就在行边界截断并给出更短的用法。
const LIMIT = 4500
const NOTE = '…（已截断，用 --diary 0 --scores 3 看更短的）'
let text = out.join('\n')
if (text.length > LIMIT) {
  const budget = LIMIT - NOTE.length - 1
  let cut = text.slice(0, budget)
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) cut = cut.slice(0, nl)
  text = cut + '\n' + NOTE
}
console.log(text)
