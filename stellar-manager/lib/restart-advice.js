/* 重启时机建议：重启 DSH 会让会话重新 seed，整段上下文按「未命中」重算一次。
 *
 * 结论来自 2026-11-09 的实测：每次面板重启 DSH 后的第一个请求，命中只有 7-10K，
 * 其余（上下文全额）都按 ¥1/百万 计费；不重启时正常对话步的命中率是 99.6%。
 * 所以「要不要现在重启」= 她现在是否在说话 + 上下文有多大 + 有没有未读。
 * 只读：agent-state.json / social-v2.json / token-usage.jsonl / config.json。
 */
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_STATE_FILE, REPO, SURF } from './paths.js'
import { readJson, readTail, todayKey } from './util.js'
import { ratesAt } from '../../src/model-prices.js'

// 未命中输入的单价**不写死**：从价目表按当前时刻取（高峰是空闲的 2 倍）。
// 以前这里是常量 1，等于把所有重启成本都按谷价估，高峰时段少算一半。
function missPriceNow(atMs = Date.now()) {
  try {
    return ratesAt('deepseek-flash', atMs).cacheMiss
  } catch {
    return null // 价目表读不出来就别编一个数（提示文案会写「单价未知」）
  }
}
const COLD_START_TOKENS = 30000 // 新会话第一条请求的冷启动量（实测 30-35K）
const TOKEN_USAGE = path.join(REPO, 'state', 'token-usage.jsonl')
const SESSIONS_FILE = path.join(REPO, 'state', 'sessions.json')
const SOCIAL_FILE = path.join(REPO, 'state', 'social-v2.json')
const REPO_CFG = path.join(REPO, 'config.json')
const RESTART_LOG = path.join(SURF, 'state', 'dsh-restart.log')

const STATE_LABEL = { ACTIVE: '正在回话', COOLDOWN: '刚说完话', LISTEN: '待机', SLEEP: '休眠' }

/** 每条 DSH 会话最后一个采样：上下文 = 命中 + 未命中（+ 写入）。 */
function latestUsageBySession() {
  const out = new Map()
  const tail = readTail(TOKEN_USAGE, 600000)
  for (const line of tail.split(/\r?\n/)) {
    if (!line) continue
    try {
      const o = JSON.parse(line)
      if (o.k !== 'turn' || !o.sid) continue
      const b = o.b || {}
      const tokens = Math.max(0, Number(b.cacheHit) || 0) + Math.max(0, Number(b.cacheMiss) || 0) + Math.max(0, Number(b.cacheWrite) || 0)
      if (!tokens) continue
      out.set(String(o.sid), { tokens, at: Number(o.time || o.t || o.at) || 0, turn: Number(o.turn) || 0 })
    } catch {}
  }
  return out
}

function todayRestartCount() {
  try {
    const today = todayKey()
    const lines = fs.readFileSync(RESTART_LOG, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    return lines.filter((l) => l.includes('restart requested') && l.includes(today)).length
  } catch { return 0 }
}

function fmtK(n) {
  return n >= 1000 ? Math.round(n / 1000) + 'K' : String(n)
}

function fmtYuan(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—（单价未知）'
  const v = Number(n) || 0
  return v >= 1 ? '¥' + v.toFixed(2) : '¥' + v.toFixed(3)
}

/** 现在适不适合重启 DSH；不适合就给出最划算的时机。 */
export function buildRestartAdvice({ dshRunning = true, turns = null } = {}) {
  const now = Date.now()
  const sessions = readJson(SESSIONS_FILE, {}) || {}
  const map = sessions.sessions || {}
  const keys = Object.keys(map)
  const key = keys.find((k) => k.startsWith('private:')) || keys[0] || ''
  const sid = key ? String(map[key]) : ''
  const usage = latestUsageBySession()
  const mine = (sid && usage.get(sid)) || null
  let primary = mine
  if (!primary && usage.size) {
    for (const item of usage.values()) if (!primary || item.at > primary.at) primary = item
  }
  const contextTokens = primary ? primary.tokens : 0
  const agent = readJson(AGENT_STATE_FILE, {}) || {}
  const conv = (agent.conversations || {})[key] || {}
  const herState = String(conv.state || '')
  const lastAt = Number(conv.lastAt) || 0
  const ageSec = lastAt ? Math.max(0, Math.round((now - lastAt) / 1000)) : null
  const cooldownUntil = Number(conv.cooldownUntil) || 0
  const cooldownLeft = cooldownUntil > now ? Math.round((cooldownUntil - now) / 1000) : 0
  const social = readJson(SOCIAL_FILE, {}) || {}
  const sc = (social.conversations || {})[key] || {}
  const unread = Array.isArray(sc.unread) ? sc.unread.length : 0
  const repoCfg = readJson(REPO_CFG, {}) || {}
  const rolloverTokens = Number(repoCfg?.socialV2?.context?.rolloverContextTokens) || 0
  const missPrice = missPriceNow(now)
  const costNow = missPrice === null ? null : (contextTokens / 1e6) * missPrice
  const costAfterRoll = missPrice === null ? null : (COLD_START_TOKENS / 1e6) * missPrice
  const restarts = todayRestartCount()

  // 她还有没有回合没收尾：来自 DSH 遥测（lib/turns.js）。这比 agent-state 的 ACTIVE 更硬——
  // B站、小镇这些会话不走 QQ 那套状态机，agent-state 里看不见它们，
  // 于是面板以前会在她正跑 B站 的时候说「她空闲着，现在切最稳」（2026-11-21 就是栽在这上面）。
  const liveTurns = turns && turns.busy ? (turns.sessions || []).filter((x) => x.active) : []
  // 先报「她」的会话（B站、小镇、QQ），没有才退到主人自己这台开发会话。
  const turnTop = liveTurns.find((x) => !x.mine) || liveTurns[0] || null
  let turnWaitSec = 0
  if (turnTop) {
    const eta = Number(turnTop.etaAt) || 0
    turnWaitSec = eta ? Math.max(30, Math.round((eta - now) / 1000)) : Math.max(30, 120 - Math.round(turnTop.elapsedMs / 1000))
  }

  const reasons = []
  let level = 'ok'
  let bestInSec = 0
  if (!dshRunning) {
    level = 'off'
  } else if (turnTop) {
    level = 'busy'
    bestInSec = turnWaitSec
    reasons.push(turnTop.mine
      ? '你这边还有一轮没跑完：开发会话 · ' + turnTop.action + '（已 ' + turnTop.elapsedText + (turnTop.etaText ? '，' + turnTop.etaText : '') + '），现在重启会打断它'
      : '她还在跑：' + turnTop.label + ' · ' + turnTop.action + '（已 ' + turnTop.elapsedText + (turnTop.etaText ? '，' + turnTop.etaText : '') + '），现在重启会把这一轮打断')
    const others = liveTurns.filter((x) => x !== turnTop)
    if (others.length) reasons.push('另外还有 ' + others.length + ' 个会话没收尾（' + others.map((x) => x.label + (x.mine ? '·主人这边' : '')).join('、') + '）')
  } else if (herState === 'ACTIVE') {
    level = 'busy'
    bestInSec = Math.max(30, 120 - (ageSec || 0))
    reasons.push('她正在处理一轮对话，重启会把这一轮打断')
  } else if (unread > 0) {
    level = 'wait'
    bestInSec = 120
    reasons.push('有 ' + unread + ' 条消息没读，重启后要重新排队送达')
  } else if (cooldownLeft > 20) {
    level = 'wait'
    bestInSec = Math.round(cooldownLeft)
    reasons.push('她' + Math.round((ageSec || 0) / 60) + ' 分钟前刚说完话，冷却还剩 ' + Math.round(cooldownLeft) + ' 秒')
  } else {
    reasons.push(herState === 'SLEEP' ? '她在休眠，现在切不影响任何对话' : '她空闲，没有未读，现在切最稳')
  }

  if (contextTokens > 0) {
    reasons.push('当前上下文 ' + fmtK(contextTokens) + ' tokens：重启后第一个请求要全额按未命中重算')
    if (rolloverTokens > 0 && contextTokens > rolloverTokens * 0.8) {
      reasons.push('已经接近滚动线 ' + fmtK(rolloverTokens) + '，等它自己换一段新会话（约 30K）后再重启，只要 ' + fmtYuan(costAfterRoll))
    }
  }
  if (level === 'ok' && contextTokens > 0 && contextTokens <= 60000) reasons.push('上下文不大，现在重启就是便宜的时候（约 ' + fmtYuan(costNow) + '）')
  if (restarts > 0) reasons.push('今天已经重启 ' + restarts + ' 次，每次都是一整段上下文重算')

  const label = STATE_LABEL[herState] || '状态未知'
  const ago = ageSec == null ? '' : ageSec < 60 ? '刚刚' : ageSec < 3600 ? Math.round(ageSec / 60) + ' 分钟前' : Math.round(ageSec / 3600) + ' 小时前'
  // 有回合没收尾时，正文第一句必须说「那个回合」，不能再拿 QQ 状态机的 herState 说话——
  // 否则会出现「现在别重启」配「她休眠（2 小时前）」的自相矛盾（2026-11-21 截图里就是这句）。
  const turnPart = turnTop
    ? (turnTop.mine
        ? '你这边还有一轮没跑完（开发会话，已 ' + turnTop.elapsedText + (turnTop.etaText ? '，' + turnTop.etaText : '') + '）'
        : '她还在跑：' + turnTop.label + ' · ' + turnTop.action + '（已 ' + turnTop.elapsedText + (turnTop.etaText ? '，' + turnTop.etaText : '') + '）')
    : ''
  const statePart = turnPart || (level === 'ok' ? ('她空闲着' + (ago ? '（' + ago + '刚收尾）' : '')) : ('她' + label + (ago ? '（' + ago + '）' : '')))
  const detail = statePart + '，未读 ' + unread + ' 条；当前上下文 ' + (contextTokens ? fmtK(contextTokens) : '—') + '，重启一次约 ' + fmtYuan(costNow) + '。'

  let headline = '现在适合重启'
  if (level === 'off') headline = 'DSH 没在运行，直接启动就行'
  else if (level === 'busy') headline = turnTop ? (turnTop.mine ? '现在别重启：你这边还有一轮没跑完' : '现在别重启：她的会话还在跑') : '现在别重启：她正在回话'
  else if (level === 'wait') headline = '可以再等一会儿再重启'
  else if (contextTokens > 100000) headline = '能重启，但上下文偏大，等一下更省'

  const bestAt = bestInSec > 0 ? new Date(now + bestInSec * 1000).toISOString() : new Date(now).toISOString()
  let bestText = '最佳时机：现在'
  if (level === 'off') bestText = '直接点「启动」即可，不涉及重算'
  else if (bestInSec > 0) bestText = '最佳时机：约 ' + (bestInSec >= 60 ? Math.round(bestInSec / 60) + ' 分钟后' : bestInSec + ' 秒后') + '（' + new Date(now + bestInSec * 1000).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) + '）'
  else if (level === 'ok' && contextTokens > 100000) bestText = '最佳时机：等她换过会话之后（约 30K 时再重启）'

  return {
    ok: true,
    level,
    suitable: level === 'ok',
    headline,
    detail,
    bestAt,
    bestInSec,
    bestText,
    contextTokens,
    contextText: contextTokens ? fmtK(contextTokens) : '—',
    costYuan: costNow === null ? null : Number(costNow.toFixed(3)),
    cheapCostYuan: costAfterRoll === null ? null : Number(costAfterRoll.toFixed(3)),
    priceNote: '按价目表当前档位估算未命中输入成本',
    rolloverTokens,
    unread,
    todayRestarts: restarts,
    her: { state: herState, label, ageSec, cooldownLeft },
    turns: { busy: liveTurns.length > 0, count: liveTurns.length, top: turnTop },
    reasons,
  }
}
