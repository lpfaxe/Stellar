/* 今天的花费：桥接账本 + 官方价目表折算 */
import path from 'node:path'
import { CFG_FILE, REPO, SURF } from './paths.js'
import { readJson, todayKey, weekStartLocal } from './util.js'
import { contactIndex, labelForKey, nameForKey, relationFor, personOf } from './people.js'

// ── 今天的花费 ────────────────────────────────────────────────────────────────
// 数据来源分两层，缺一层也能降级显示：
//   1. 桥接控制台 API（127.0.0.1:3100，需 x-console-token）：QQ 会话的逐轮明细、分时、
//      峰谷档位与价目表；它只覆盖桥接自己投递的模型回合。
//   2. 插件按天落盘的分类账（~/.dsh/stellar/token-usage-{state,daily}.json）：把花费
//      分成 qq / bili / other 三类，B站会话（刷视频、发动态、写日报）只在这里有数。
// 金额口径与桥接一致：按 DeepSeek 官方价目表折算，高峰时段单价 ×2。
export const COST_CATEGORIES = [
  { key: 'qq', label: 'QQ 聊天', hint: '跟你说话、发图、看空间' },
  { key: 'bili', label: 'B站', hint: '刷视频 / 发动态 / 写日报' },
  { key: 'other', label: '其他', hint: '人格卡拆分等杂项' }
]

export function localMidnight() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export async function bridgeApi(pathname, timeoutMs = 8000) {
  const cfg = readJson(path.join(REPO, 'config.json'), {})
  const token = String(cfg.consoleToken || readJson(CFG_FILE, {}).consoleToken || '')
  try {
    const res = await fetch('http://127.0.0.1:3100' + pathname, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
    return await res.json()
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

export function bucketsSum(a, b) {
  const get = (o, k) => Number(o && o[k]) || 0
  return {
    cacheMiss: get(a, 'cacheMiss') + get(b, 'cacheMiss'),
    cacheHit: get(a, 'cacheHit') + get(b, 'cacheHit'),
    cacheWrite: get(a, 'cacheWrite') + get(b, 'cacheWrite'),
    output: get(a, 'output') + get(b, 'output'),
    reasoning: get(a, 'reasoning') + get(b, 'reasoning')
  }
}
export function bucketsTotal(b) {
  const x = b || {}
  return (x.cacheMiss || 0) + (x.cacheHit || 0) + (x.cacheWrite || 0) + (x.output || 0)
}
export function bucketHitRate(b) {
  const x = b || {}
  const input = (x.cacheHit || 0) + (x.cacheMiss || 0) + (x.cacheWrite || 0)
  return input > 0 ? (x.cacheHit || 0) / input : 0
}

export function costAmount(v) { return Number(v) || 0 }

export async function buildCost() {
  const today = todayKey()
  const dayStart = localMidnight()
  const state = readJson(path.join(SURF, 'state', 'token-usage-state.json'), null)
    || readJson(path.join(SURF, 'token-usage-state.json'), {}) || {}
  const [dailyRaw, summaryRaw, seriesRaw] = await Promise.all([
    bridgeApi('/api/tokens/daily'),
    bridgeApi('/api/tokens/summary?limit=50'),
    bridgeApi('/api/tokens/series?hours=24')
  ])
  const errors = []
  if (!dailyRaw.ok) errors.push('桥接接口不可用（' + (dailyRaw.error || '未知错误') + '）')
  // 分类账以插件落盘文件为准（桥接在插件账本过期时会退回自己的账本，只剩 qq/bili 两类）。
  const pluginDaily = readJson(path.join(SURF, 'token-usage-daily.json'), null)
    || readJson(path.join(SURF, 'state', 'token-usage-daily.json'), null)
  // 2026-11-11 修：这里原来只要快照的 day 是今天就直接用它，不看 at —— 插件采集器被剥掉后
  // 快照冻结在 08:47，面板就把「QQ 今天的 67 万 token」显示成 0，6.27M 全算进 B站。
  // 现在按新鲜度排优先级：桥接接口已经做过合并（QQ 走它自己的账本、B站走插件快照），
  // 所以桥接可用时以它为准；桥接挂了再看插件快照新不新鲜，最后才用冻结快照兜底并标 stale。
  const pluginAt = Number(pluginDaily && pluginDaily.at) || 0
  const pluginFresh = !!(pluginDaily && pluginDaily.day === today && pluginAt > 0 && Date.now() - pluginAt < 10 * 60 * 1000)
  const bridgeUsage = (dailyRaw.ok && dailyRaw.usage && dailyRaw.usage.day === today) ? dailyRaw.usage : null
  const usageSrc = bridgeUsage
    || (pluginFresh ? pluginDaily : null)
    || (pluginDaily && pluginDaily.day === today ? { ...pluginDaily, stale: true } : null)
  const daily = usageSrc ? {
    day: usageSrc.day || '',
    at: Number(usageSrc.at) || 0,
    source: usageSrc.source || '',
    stale: !!usageSrc.stale,
    sessions: usageSrc.sessions || {},
    qq: { cost: costAmount(usageSrc.qq && usageSrc.qq.cost), tokens: Number(usageSrc.qq && usageSrc.qq.tokens) || 0 },
    bili: { cost: costAmount(usageSrc.bili && usageSrc.bili.cost), tokens: Number(usageSrc.bili && usageSrc.bili.tokens) || 0 },
    other: { cost: costAmount(usageSrc.other && usageSrc.other.cost), tokens: Number(usageSrc.other && usageSrc.other.tokens) || 0 }
  } : null

  const cats = COST_CATEGORIES.map((c) => {
    const v = (daily && daily[c.key]) || (state.categories && state.categories[c.key]) || { cost: 0, tokens: 0 }
    return { key: c.key, label: c.label, hint: c.hint, cost: costAmount(v.cost), tokens: Number(v.tokens) || 0 }
  })
  const totalCost = cats.reduce((sum, c) => sum + c.cost, 0)
  const totalTokens = cats.reduce((sum, c) => sum + c.tokens, 0)
  for (const c of cats) c.share = totalCost > 0 ? c.cost / totalCost : 0

  const limits = (dailyRaw.ok && dailyRaw.limits) || readJson(path.join(SURF, 'token-budget.json'), {}).limits || {}
  const limitCny = Number(limits.total && limits.total.cny)
  const budget = {
    limitCny: Number.isFinite(limitCny) && limitCny > 0 ? limitCny : null,
    gateBlocked: !!(dailyRaw.ok && dailyRaw.gate && dailyRaw.gate.blocked),
    gateHits: (dailyRaw.ok && dailyRaw.gate && dailyRaw.gate.hits) || []
  }
  budget.share = budget.limitCny ? totalCost / budget.limitCny : 0
  budget.remaining = budget.limitCny ? Math.max(0, budget.limitCny - totalCost) : null

  // 会话明细：QQ 走桥接账本（有轮数、步数），B站 / 其他走插件分类账。
  const summary = summaryRaw.ok ? summaryRaw : null
  const index = contactIndex()
  const sessions = []
  for (const conv of (summary && Array.isArray(summary.conversations) ? summary.conversations : [])) {
    const b = conv.todayBuckets || conv.buckets || {}
    const ck = String(conv.key || '')
    const person = ck.startsWith('private:') ? personOf(index, ck.slice(8)) : null
    sessions.push({
      id: conv.key,
      kind: 'qq',
      category: 'qq',
      label: ck.startsWith('private:') || ck.startsWith('group:') ? 'QQ 聊天 · ' + labelForKey(index, ck) : 'QQ 聊天 · ' + ck,
      hint: person && person.relation ? person.relation : '你跟她说话、她发图、看空间',
      cost: costAmount(conv.todayCost === undefined ? conv.cost : conv.todayCost),
      tokens: Number(conv.todayTokens) || bucketsTotal(b),
      turns: Number(conv.turns) || 0,
      steps: Number(conv.steps) || 0,
      cacheHitRate: bucketHitRate(b),
      models: Array.isArray(conv.models) ? conv.models : [],
      lastAt: Number(conv.lastAt) || 0
    })
  }
  const stSessions = state.sessions && typeof state.sessions === 'object' ? state.sessions : {}
  for (const [sid, s] of Object.entries(stSessions)) {
    if (!s || s.category === 'qq') continue
    const isBili = s.category === 'bili'
    sessions.push({
      id: sid,
      kind: isBili ? 'bili' : 'other',
      category: isBili ? 'bili' : 'other',
      label: isBili ? 'B站 · ' + (s.preset || '鲸鱼会话') : (s.title || sid),
      hint: isBili ? '看视频、发动态、写日报都在这个会话里' : '人格卡拆分等后台任务',
      cost: costAmount(s.dayCost),
      tokens: Number(s.dayTokens) || bucketsTotal(s.seen),
      turns: 0,
      steps: 0,
      cacheHitRate: bucketHitRate(s.seen),
      models: s.model ? [s.model] : [],
      lastAt: Number(s.lastSeenAt) || 0
    })
  }
  sessions.sort((a, b) => b.cost - a.cost)
  for (const s of sessions) s.share = totalCost > 0 ? s.cost / totalCost : 0

  // 和谁聊的：把 QQ 会话按联系人聚成一行，给控制台直接看「钱花在谁身上」。
  const peers = sessions
    .filter((s) => s.category === 'qq' && /^(private|group):/.test(String(s.id || '')))
    .map((s) => {
      const key = String(s.id)
      const uin = key.startsWith('private:') ? key.slice(8) : ''
      const p = uin ? personOf(index, uin) : null
      return {
        key,
        name: nameForKey(index, key),
        relation: relationFor(index, key),
        avatar: p ? p.avatar : '',
        cost: s.cost,
        tokens: s.tokens,
        turns: s.turns,
        steps: s.steps,
        cacheHitRate: s.cacheHitRate,
        lastAt: s.lastAt,
      }
    })
    .sort((a, b) => b.cost - a.cost)
  const peerQqCost = peers.reduce((sum, p) => sum + p.cost, 0)
  for (const p of peers) p.share = peerQqCost > 0 ? p.cost / peerQqCost : 0
  const peerTotal = {
    count: peers.length,
    cost: peerQqCost,
    tokens: peers.reduce((sum, p) => sum + p.tokens, 0),
    turns: peers.reduce((sum, p) => sum + p.turns, 0),
  }

  // 钱的构成：把 token 桶按当前生效档位折算回金额，再等比例校准到总账金额。
  let buckets = { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0 }
  if (summary && summary.totals) buckets = bucketsSum(buckets, summary.totals.todayBuckets || summary.totals.buckets || {})
  for (const s of Object.values(stSessions)) {
    if (!s || s.category === 'qq') continue
    buckets = bucketsSum(buckets, s.seen || {})
  }
  const rates = (summary && summary.nowTier) || { unit: 1000000, cacheHit: 0.02, cacheMiss: 1, cacheWrite: 1, output: 4, tierLabel: '空闲时段', symbol: '¥' }
  const unit = Number(rates.unit) || 1000000
  const bucketRows = [
    { key: 'cacheHit', label: '输入 · 缓存命中', tokens: buckets.cacheHit, cost: (buckets.cacheHit / unit) * rates.cacheHit },
    { key: 'cacheMiss', label: '输入 · 缓存未命中', tokens: buckets.cacheMiss, cost: (buckets.cacheMiss / unit) * rates.cacheMiss }
  ]
  if (buckets.cacheWrite > 0) bucketRows.push({ key: 'cacheWrite', label: '输入 · 缓存写入', tokens: buckets.cacheWrite, cost: (buckets.cacheWrite / unit) * rates.cacheWrite })
  bucketRows.push({ key: 'output', label: '输出 · 她打的字', tokens: buckets.output, cost: (buckets.output / unit) * rates.output })
  const pricedSum = bucketRows.reduce((sum, r) => sum + r.cost, 0)
  const scale = pricedSum > 0 && totalCost > 0 ? totalCost / pricedSum : 1
  const tokenSum = bucketsTotal(buckets)
  for (const r of bucketRows) {
    r.cost = r.cost * scale
    r.share = totalCost > 0 ? r.cost / totalCost : (tokenSum > 0 ? r.tokens / tokenSum : 0)
  }
  const hitRow = bucketRows[0]
  const cache = {
    hitTokens: buckets.cacheHit || 0,
    hitRate: bucketHitRate(buckets),
    actualCost: hitRow.cost,
    missCost: ((buckets.cacheHit || 0) / unit) * rates.cacheMiss
  }
  cache.saved = Math.max(0, cache.missCost - cache.actualCost)

  // 分时：桥接账本按 30 分钟一格，只覆盖 QQ 会话；B站花费没有分时明细。
  const hourly = Array.from({ length: 24 }, (_, h) => ({ h, cost: 0, tokens: 0 }))
  const seriesBuckets = seriesRaw.ok && Array.isArray(seriesRaw.buckets) ? seriesRaw.buckets : []
  let seriesCost = 0
  for (const b of seriesBuckets) {
    const t = Number(b.t)
    if (!Number.isFinite(t) || t < dayStart) continue
    const h = new Date(t).getHours()
    hourly[h].cost += costAmount(b.cost)
    hourly[h].tokens += Number(b.tokens) || 0
    seriesCost += costAmount(b.cost)
  }
  const busiest = hourly.reduce((best, cur) => (cur.cost > (best ? best.cost : -1) ? cur : best), null)
  const totals = (summary && summary.totals) || null

  return {
    ok: true,
    date: today,
    updatedAt: new Date().toISOString(),
    ledger: {
      day: daily ? daily.day : (state.day || ''),
      at: daily ? daily.at : Number(state.updatedAt) || 0,
      source: (daily && daily.source) || '',
      stale: !!(daily && daily.stale),
      stateDay: state.day || '',
      pluginAt,
      pluginFresh,
      pluginDay: (pluginDaily && pluginDaily.day) || ''
    },
    totals: { cost: totalCost, tokens: totalTokens },
    categories: cats,
    budget,
    sessions,
    peers,
    peerTotal,
    buckets: bucketRows,
    cache,
    hourly,
    busiest: busiest && busiest.cost > 0 ? busiest : null,
    seriesCost,
    perf: totals ? {
      turns: Number(totals.turns) || 0,
      steps: Number(totals.steps) || 0,
      avgCostPerTurn: costAmount(totals.avgCostPerTurn),
      avgCostPerStep: costAmount(totals.avgCostPerStep)
    } : null,
    prices: {
      version: (summary && summary.priceVersion) || '',
      tierLabel: rates.tierLabel || '',
      symbol: rates.symbol || '¥',
      peakMultiplier: (summary && summary.priceTable && summary.priceTable.peakMultiplier) || 2,
      peakWindows: (summary && summary.priceTable && summary.priceTable.peakWindows) || [[9, 12], [14, 18]],
      rates
    },
    errors
  }
}


/** 账本时间窗（今天 / 本周 / 本月，本地时区）：给 /api/cost 附上，方便前端以后做切换。
 *  注：这里只给窗口边界，不重复求和 —— 金额口径统一走 buildCost()。 */
export function buildUsageRanges() {
  const today = todayKey()
  return [
    { key: 'today', label: '今天', from: today, to: today },
    { key: 'week', label: '本周', from: weekStartLocal(), to: today },
    { key: 'month', label: '本月', from: today.slice(0, 8) + '01', to: today },
  ]
}
