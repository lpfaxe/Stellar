/* 她今天的任务清单（控制台）—— 把分散在七八个状态文件里的「今天该做的事」聚成一张打卡表。
 * 只读：所有数据都来自别处自己写的状态文件，这个模块不落盘、不改任何东西。
 * 为什么要它：看视频、刷动态、四类动态、说说、三连、日报分散在六张卡片里，
 * 主人想知道「今天她做完没」得逐张翻 —— 这里一次汇总，done / 半截 / 还没做 一眼看到。
 */
import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_CFG, CFG_FILE, REPORTS_FILE, SURF, TODOS_FILE } from './paths.js'
import { findWhale, localDay, readJson, todayKey, weekStartLocal } from './util.js'
import { findBiliDir } from './dynamics.js'
import { qzoneStats } from './report.js'

const PUB_DAY = path.join(SURF, 'state', 'qzone-public-day.json')
const QZONE_WATCH = path.join(SURF, 'state', 'qzone-watch.json')
const KIND_ORDER = ['best', 'game', 'anime', 'gaming']
const KIND_LABEL = { best: '最高分', game: '游戏区', anime: '动画区', gaming: '游戏实况' }
// 看几条由主人自己配（qzone.public.seenTarget，面板「她每天做什么」里能改），缺省 10。
const SEEN_TARGET_DEFAULT = 10

function readLines(file) {
  const out = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch (e) {}
    }
  } catch (e) {}
  return out
}

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function clock() {
  const d = new Date()
  const h = d.getHours() + d.getMinutes() / 60
  return { h: h, now: d }
}

function hhmm(iso) {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
}

/** 一个任务：state = done | partial | pending | off */
function task(key, label, hint) {
  return { key: key, label: label, hint: hint, state: 'pending', progress: null, at: '', detail: '', where: '' }
}

function watchStats(dir, day) {
  const rows = readLines(path.join(dir, 'watch-history.jsonl')).filter(function (r) { return r && localDay(r.at) === day })
  const bvids = {}
  let last = ''
  for (const r of rows) {
    const bv = String(r.bvid || '')
    if (bv) bvids[bv] = 1
    if (String(r.at || '') > last) last = String(r.at || '')
  }
  return { rows: rows.length, videos: Object.keys(bvids).length, last: last }
}

function weekWatchVideos(dir) {
  const since = weekStartLocal()
  const rows = readLines(path.join(dir, 'watch-history.jsonl')).filter(function (r) { return r && localDay(r.at) >= since })
  const bvids = {}
  for (const r of rows) { const bv = String(r.bvid || ''); if (bv) bvids[bv] = 1 }
  return Object.keys(bvids).length
}

function buildTasks() {
  const day = todayKey()
  const cfg = readJson(CFG_FILE, {}) || {}
  const bridge = readJson(BRIDGE_CFG, {}) || {}
  const bili = findBiliDir()
  const dir = bili.dir
  const role = bili.role
  const { h } = clock()
  const out = []

  // ① 醒来：生物钟计划几次、真醒了几次
  const nightCfg = cfg.night || {}
  const night = findWhale()
  const nstate = night && night.state ? night.state : null
  if (nightCfg.enabled === false) {
    const it = task('wake', '醒来（生物钟）', '生物钟关着')
    it.state = 'off'
    out.push(it)
  } else if (!nstate || nstate.date !== day) {
    const it = task('wake', '醒来（生物钟）', '今天还没有计划')
    it.detail = '调度器掷完骰子就会有计划'
    out.push(it)
  } else {
    const slots = Array.isArray(nstate.slots) ? nstate.slots : []
    const planned = slots.filter(function (s) { return s.action !== 'skip' })
    const fired = slots.filter(function (s) { return s.status === 'fired' })
    const it = task('wake', '醒来（生物钟）', '到点自己醒过来看看')
    it.progress = { have: fired.length, need: planned.length, unit: '次' }
    it.state = planned.length === 0 ? 'off' : fired.length >= planned.length ? 'done' : fired.length ? 'partial' : 'pending'
    it.at = fired.length ? String(fired[fired.length - 1].atText || '') : ''
    it.detail = fired.map(function (s) { return String(s.atText || '') }).filter(Boolean).join(' / ')
    out.push(it)
  }

  // ② 看 B站视频
  const target = num(nightCfg.videoTargetPerDay, 0)
  const weeklyMax = num(nightCfg.weeklyMax, 0)
  const ws = watchStats(dir, day)
  const weekVideos = weekWatchVideos(dir)
  const watch = task('watch', '看 B站视频', '刷视频、看懂内容')
  watch.progress = { have: ws.videos, need: target, unit: '条' }
  watch.state = target > 0 && ws.videos >= target ? 'done' : ws.videos > 0 ? 'partial' : 'pending'
  watch.at = ws.last
  watch.detail = '本周 ' + weekVideos + (weeklyMax > 0 ? ' / ' + weeklyMax : '') + (weeklyMax > 0 && weekVideos >= weeklyMax ? '（额度用完了）' : '')
  out.push(watch)

  // ③ 四类动态（8 / 12 / 16 / 20 四个时段各一条）
  const dynCfg = (cfg.dynamics && cfg.dynamics.kinds) || {}
  const daily = readJson(path.join(dir || '', 'daily-dynamic.json'), {}) || {}
  const kindsOn = KIND_ORDER.filter(function (k) { return dynCfg[k] && dynCfg[k].enabled !== false })
  const posted = kindsOn.filter(function (k) { return daily[k] && daily[k].date === day })
  const dyn = task('dynamics', '发 B站动态', '四个时段各一条：' + kindsOn.join(' / '))
  dyn.progress = { have: posted.length, need: kindsOn.length, unit: '条' }
  dyn.state = dynCfgEnabled(cfg) === false ? 'off' : kindsOn.length === 0 ? 'off' : posted.length >= kindsOn.length ? 'done' : posted.length ? 'partial' : 'pending'
  const dynLast = posted.length ? daily[posted[posted.length - 1]] : null
  dyn.at = dynLast ? String(dynLast.at || '') : ''
  dyn.detail = kindsOn.map(function (k) {
    const done = daily[k] && daily[k].date === day
    const slot = dynCfg[k] && dynCfg[k].slot !== undefined ? String(dynCfg[k].slot) + ':00 ' : ''
    return (done ? '✓ ' : '· ') + slot + KIND_LABEL[k]
  }).join('  ')
  out.push(dyn)

  // ④ 好友爱看：看 10 条 → 打分 → 前 3 赞 → 随机 3 评
  const pub = readJson(PUB_DAY, null)
  const pubItems = pub && pub.day === day && Array.isArray(pub.items) ? pub.items : []
  const qzPub = (bridge.qzone && bridge.qzone.public) || {}
  const qzPubBili = (cfg.qzone && cfg.qzone.public) || {}
  const seenNeed = num(qzPub.seenTarget, num(qzPubBili.seenTarget, SEEN_TARGET_DEFAULT))
  const likeNeed = num(qzPub.likeLimit, num(qzPubBili.likeLimit, 3))
  const cmtNeed = num(qzPub.commentLimit, num(qzPubBili.commentLimit, 3))
  const seen = pubItems.length
  const scored = pubItems.filter(function (r) { return r && r.score !== null && r.score !== undefined && r.score !== '' }).length
  const liked = pubItems.filter(function (r) { return r && r.liked }).length
  const commented = pubItems.filter(function (r) { return r && r.commentText }).length
  const qzp = task('qzone-public', '刷好友爱看', '看 ' + seenNeed + ' 条 → 打分 → 赞 ' + likeNeed + ' → 评 ' + cmtNeed)
  qzp.progress = { have: seen, need: seenNeed, unit: '条' }
  const pubDone = seen >= seenNeed && scored >= seenNeed && liked >= likeNeed && commented >= cmtNeed
  qzp.state = qzPub.enabled === false ? 'off' : pubDone ? 'done' : seen > 0 ? 'partial' : 'pending'
  qzp.at = pubItems.length ? String(pubItems[pubItems.length - 1].seenAt || '') : ''
  qzp.detail = '看 ' + seen + ' · 打分 ' + scored + ' · 赞 ' + liked + '/' + likeNeed + ' · 评 ' + commented + '/' + cmtNeed
  out.push(qzp)

  // ⑤ QQ空间说说（每周至少 weeklyMin 条）
  const qz = qzoneStats()
  const qzCfg = cfg.qzone || {}
  const qzBridge = bridge.qzone || {}
  const weekMin = num(qzCfg.weekly && qzCfg.weekly.min, 0)
  const qzTask = task('qzone-post', '发 QQ 空间说说', weekMin > 0 ? '每周至少 ' + weekMin + ' 条' : '有想说的就发')
  qzTask.progress = { have: qz.weekCount, need: weekMin, unit: '条' }
  qzTask.state = qzBridge.enabled === false || qzCfg.enabled === false ? 'off' : qz.todayCount > 0 ? 'done' : 'pending'
  qzTask.at = qz.last ? String(qz.last.at || '') : ''
  qzTask.detail = '本周 ' + qz.weekCount + (weekMin > 0 ? ' / ' + weekMin : '') + ' · 今日上限 ' + num(qzBridge.dailyLimit, 3)
  out.push(qzTask)

  // ⑥ 每日三连（22:30 自动跑，挑当天最高分那条）
  const triple = readJson(path.join(dir || '', 'triple.json'), {}) || {}
  const tripleCfg = cfg.triple || {}
  const tday = (triple.days && triple.days[day]) || null
  const tsk = task('triple', '每日三连', '给当天最高分那条点赞投币收藏')
  tsk.progress = null
  if (tripleCfg.enabled === false) tsk.state = 'off'
  else if (tday && tday.done) { tsk.state = 'done'; tsk.at = String(tday.at || '') }
  else tsk.state = 'pending'
  tsk.detail = tday && tday.done ? String(tday.title || '').slice(0, 40) : (tripleCfg.enabled === false ? '已关闭' : String(tripleCfg.time || '22:30') + ' 自动跑')
  tsk.where = String(tripleCfg.time || '22:30')
  out.push(tsk)

  // ⑦ 日报（23:30 自己写一条）
  const repCfg = cfg.report || {}
  const reports = readLines(REPORTS_FILE)
  let todayReport = null
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    if (reports[i] && reports[i].date === day) { todayReport = reports[i]; break }
  }
  const rp = task('report', '写日报', '今天看了什么、做了什么')
  rp.state = repCfg.enabled === false ? 'off' : todayReport ? 'done' : 'pending'
  rp.at = todayReport ? String(todayReport.at || '') : ''
  rp.detail = todayReport ? String(todayReport.text || '').split('\n').filter(Boolean)[0].slice(0, 60) : String(repCfg.time || '23:30') + ' 自动提醒'
  rp.where = String(repCfg.time || '23:30')
  out.push(rp)

  // ⑧ 日记 / 事件流（她自己的记录）
  const logs = readLines(path.join(dir || '', 'whale-log.jsonl')).filter(function (r) { return r && localDay(r.at) === day })
  const lg = task('diary', '记日记', '看过的、想过的记进事件流')
  lg.progress = { have: logs.length, need: 1, unit: '条' }
  lg.state = logs.length ? 'done' : 'pending'
  lg.at = logs.length ? String(logs[logs.length - 1].at || '') : ''
  lg.detail = logs.slice(-3).map(function (r) { return String(r.kind || 'event') }).join(' / ')
  out.push(lg)

  // ⑨ B站搭话额度（限额自主：今天的额度要花完）
  const quota = readJson(path.join(dir || '', 'quota.json'), {}) || {}
  const limits = cfg.limits || {}
  const taNeed = num(limits.taDaily, 0)
  const quotaLog = (Array.isArray(quota.log) ? quota.log : []).filter(function (r) { return r && localDay(r.at) === day })
  const taUsed = quotaLog.filter(function (r) { return r && r.ta === true }).length
  const cmtUsed = quotaLog.filter(function (r) { return r && r.type === 'comment' }).length
  const ta = task('ta', 'B站搭话', '主动去评论区说话（今日额度尽量用完）')
  ta.progress = { have: taUsed, need: taNeed, unit: '条' }
  ta.state = taNeed === 0 ? 'off' : taUsed >= taNeed ? 'done' : taUsed > 0 ? 'partial' : 'pending'
  ta.detail = '还发过 ' + cmtUsed + ' 条评论（含回别人）'
  out.push(ta)

  // ⑩ 空间监看（看主人的说说、有人评论她）
  const watchState = readJson(QZONE_WATCH, null)
  const qw = task('qzone-watch', '空间监看', '看主人发了什么、谁评论了她')
  if (qzCfg.watch === false) qw.state = 'off'
  else if (watchState && watchState.day === day) {
    qw.state = num(watchState.wakes, 0) > 0 ? 'done' : 'pending'
    qw.progress = { have: num(watchState.wakes, 0), need: 1, unit: '次' }
    qw.detail = '看过 ' + (Array.isArray(watchState.seenPosts) ? watchState.seenPosts.length : 0) + ' 条说说'
  } else {
    qw.state = 'pending'
    qw.detail = '今天还没轮到（每 ' + num(qzCfg.watchMin, 10) + ' 分钟看一次）'
  }
  out.push(qw)

  // ⑪ 记忆维护（日常整理 + 分层清理）
  const memFile = path.join(SURF, 'characters', role || 'deepseek', 'memory', 'memory-card.json')
  const card = readJson(memFile, null)
  const mt = task('memory', '记忆维护', '整理记忆卡、清当天的零碎')
  if (!card) { mt.state = 'off'; mt.detail = '没找到记忆卡' }
  else {
    const maint = String(card.lastMaintenanceAt || '')
    const tier = String(card.lastTierMaintenanceAt || '')
    const maintToday = localDay(maint) === day
    const tierToday = localDay(tier) === day
    mt.state = maintToday && tierToday ? 'done' : (maintToday || tierToday) ? 'partial' : 'pending'
    mt.at = maint
    mt.detail = '整理 ' + (maintToday ? '✓' : '·') + '  分层 ' + (tierToday ? '✓' : '·')
    mt.where = (Array.isArray(card.records) ? card.records.length : 0) + ' 条记忆'
  }
  out.push(mt)

  // ⑫ 每日 vlog（默认关着，开着才出现）
  const vlogCfg = cfg.vlog || {}
  if (vlogCfg.enabled !== false) {
    const vlogFile = path.join(dir || '', 'vlog-rework.json')
    const vr = readJson(vlogFile, null)
    const v1 = task('vlog', '每日 vlog', '自己剪一条 1~10 分钟的视频')
    v1.state = vr ? 'partial' : 'pending'
    v1.detail = vr ? '有待重做的' : '谷期里做'
    out.push(v1)
  }

  // ⑬ 待办：有没有到点还没提醒的
  const todos = readJson(TODOS_FILE, null)
  const items = todos && Array.isArray(todos.items) ? todos.items : Array.isArray(todos) ? todos : []
  const nowMs = Date.now()
  const overdue = items.filter(function (r) { return r && r.status === 'pending' && num(r.dueAt, 0) > 0 && num(r.dueAt, 0) <= nowMs })
  const pend = items.filter(function (r) { return r && r.status === 'pending' })
  const td = task('todos', '待办提醒', '到点先叫醒她，她再提醒委托人')
  td.state = overdue.length ? 'pending' : 'done'
  td.detail = overdue.length ? overdue.length + ' 条过期还没提醒' : (pend.length ? '还有 ' + pend.length + ' 条没到期' : '没有待办')
  out.push(td)

  return { day: day, role: role, items: out, hour: h }
}

function dynCfgEnabled(cfg) {
  return cfg && cfg.dynamics && cfg.dynamics.enabled === false ? false : undefined
}

const STATE_RANK = { pending: 0, partial: 1, done: 2, off: 3 }

export function buildDailyTasks() {
  let built
  try { built = buildTasks() } catch (e) {
    return { ok: false, at: Date.now(), day: todayKey(), items: [], counts: { total: 0, done: 0, partial: 0, pending: 0, off: 0 }, message: String(e && e.message || e) }
  }
  const itemList = built.items.slice().sort(function (a, b) {
    const d = (STATE_RANK[a.state] === undefined ? 9 : STATE_RANK[a.state]) - (STATE_RANK[b.state] === undefined ? 9 : STATE_RANK[b.state])
    return d
  })
  const counts = { total: itemList.length, done: 0, partial: 0, pending: 0, off: 0 }
  for (const it of itemList) { if (counts[it.state] === undefined) counts[it.state] = 0; counts[it.state] += 1 }
  return {
    ok: true,
    at: Date.now(),
    day: built.day,
    role: built.role || '',
    items: itemList,
    counts: counts,
    headline: counts.done + ' / ' + (counts.total - counts.off) + ' 做完' + (counts.pending ? '，' + counts.pending + ' 件还没动' : '') + (counts.partial ? '，' + counts.partial + ' 件做了一半' : '')
  }
}