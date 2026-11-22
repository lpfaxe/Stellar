/* 她正在哪些会话里干活、干到哪一步、大概什么时候收尾。
 *
 * 数据源：<数据目录>/context-telemetry-plugin.jsonl（DSH 侧旁路记录，只读）。
 * 这里只回答两件事：①「她此刻在做什么」比工具调用日志更真的一层——有没有回合还没收尾；
 * ②「现在重启 DSH 会不会打断她」——正在跑就给出预计结束时间。
 *
 * 判定口径（2026-11-21 定）：
 * - turn_start 减去 turn_end > 0 就是「回合还没收尾」；
 * - 最后一次动静在 15 分钟内才算她真的还在跑（更久的多半是崩溃留下的幽灵回合，只提示不拦重启）；
 * - 回合里还有没回来的 tool_call 就是「正在跑工具」，否则是「在等模型」；
 * - 预计结束用同类耗时分位：同会话同工具样本 ≥3 用它的 p90，否则用全局同工具的 p90；
 *   等模型时用同预设回合耗时的 p50（从 turn_end.durationMs 学）。
 */
import path from 'node:path'
import { SURF } from './paths.js'
import { readTail } from './util.js'

const TELEMETRY = path.join(SURF, 'context-telemetry-plugin.jsonl')
const TAIL_BYTES = 4 * 1024 * 1024
const ACTIVE_MS = 15 * 60_000      // 15 分钟内有动静才算还在跑
const KEEP_MS = 24 * 3600_000      // 幽灵回合最多保留一天
const MIN_SAMPLES = 3

const TOOL_LABEL = [
  [/^qq_(send_message|reply_and_finish)$/, '回消息'],
  [/^qq_send_(image|sticker|poke|group_message)$/, '发消息'],
  [/^qq_(wait_for_messages|mark_read|close_conversation|get_)/, '看消息'],
  [/^stellar_town_/, '在小镇里'],
  [/^stellar_bili_/, '逛 B 站'],
  [/^stellar_qzone_/, '在空间互动'],
  [/^stellar_(memory|person)_/, '翻记忆'],
  [/^stellar_(file|spill)_/, '读长文档'],
  [/^(web_search|web_fetch|read_page|x_search)$/, '查资料'],
  [/^image_generate$/, '画图'],
  [/^pwsh$/, '跑一条命令'],
  [/^run_code$/, '写程序'],
  [/^(read|read_image)$/, '看文件'],
  [/^(grep|glob)$/, '找文件'],
  [/^(edit|write)$/, '改文件'],
  [/^task$/, '派子任务'],
]

/** 遥测里存的是全名（mcp__snowluma__qq_send_message）——去掉 mcp__<server>__ 再匹表，
 * 否则下面每一条 /^qq_/ /^stellar_/ 都命中不了，面板只会说「用 mcp__snowluma__…」。 */
function toolBase(tool) {
  const t = String(tool || '')
  const m = /^mcp__[A-Za-z0-9_-]+__(.+)$/.exec(t)
  return m ? m[1] : t
}

function actionLabel(tool) {
  const t = toolBase(tool)
  if (!t) return '在忙'
  for (const [re, label] of TOOL_LABEL) if (re.test(t)) return label
  return '用 ' + t
}

function sessionLabel(sid, preset) {
  const s = String(sid || '')
  if (/^bili-whale/.test(s)) return '刷 B 站'
  if (/^feed-whale/.test(s)) return '看好友爱看'
  if (/^town-whale/.test(s)) return '在小镇'
  if (/^qq-/.test(s)) return 'QQ'
  if (preset === 'bili-slim') return '刷 B 站'
  if (preset === 'qq-chat-v2' || preset === 'qq-chat') return 'QQ 会话'
  // town-act 是我们自己的影子会话；fishbowl-town 是官方插件自己开的回合（2026-11-22 加）
  if (preset === 'town-act' || preset === 'fishbowl-town') return '在小镇'
  if (preset === 'ptc') return '开发会话'
  return 'DSH 会话'
}

function pct(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[i]
}

function clock(ms) {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return hh + ':' + mm
}

function dur(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000))
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? m + ' 分 ' + r + ' 秒' : m + ' 分'
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
}

/** 读遥测尾部并按会话归并。任何一步坏掉都不抛：面板不能因为一行 JSON 崩。 */
export function buildTurns({ now = Date.now() } = {}) {
  let text = ''
  try { text = readTail(TELEMETRY, TAIL_BYTES) } catch { return { ok: false, at: now, busy: false, count: 0, sessions: [], line: '', note: '没有遥测文件' } }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] !== '{') continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (!o || !o.kind || !o.sessionId) continue
    const ts = Number(o.ts)
    if (!ts) continue
    rows.push(o)
  }
  rows.sort((a, b) => Number(a.ts) - Number(b.ts))

  const byToolGlobal = new Map()
  const byToolSession = new Map()
  const turnDurByPreset = new Map()
  const sess = new Map()

  const ensure = (sid, preset) => {
    let s = sess.get(sid)
    if (!s) {
      s = { id: sid, preset: preset || '', starts: 0, ends: 0, lastTs: 0, lastKind: '', open: new Map(), turn: 0, turnStartTs: 0, modelCalls: 0, toolCalls: 0 }
      sess.set(sid, s)
    } else if (preset && !s.preset) s.preset = preset
    return s
  }

  for (const o of rows) {
    const s = ensure(String(o.sessionId), String(o.agentPreset || ''))
    const ts = Number(o.ts)
    if (ts > s.lastTs) { s.lastTs = ts; s.lastKind = String(o.kind) }
    if (o.kind === 'turn_start') { s.starts++; s.turnStartTs = ts; s.turn = Number(o.turn) || s.turn }
    else if (o.kind === 'turn_end') {
      s.ends++
      const dms = Number(o.durationMs)
      if (dms > 0) {
        const key = s.preset || 'other'
        if (!turnDurByPreset.has(key)) turnDurByPreset.set(key, [])
        turnDurByPreset.get(key).push(dms)
      }
    } else if (o.kind === 'model_call') { s.modelCalls++ }
    else if (o.kind === 'tool_call') {
      s.toolCalls++
      const cid = String(o.callId || '')
      if (cid) s.open.set(cid, { tool: String(o.tool || ''), ts })
    } else if (o.kind === 'tool_result') {
      const cid = String(o.callId || '')
      s.open.delete(cid)
      const tool = String(o.tool || '')
      const dms = Number(o.durationMs)
      if (tool && dms > 0) {
        if (!byToolGlobal.has(tool)) byToolGlobal.set(tool, [])
        byToolGlobal.get(tool).push(dms)
        const k = s.id + '|' + tool
        if (!byToolSession.has(k)) byToolSession.set(k, [])
        byToolSession.get(k).push(dms)
      }
    }
  }

  const sessions = []
  for (const s of sess.values()) {
    if (s.starts - s.ends <= 0) continue
    const idle = now - s.lastTs
    if (idle > KEEP_MS) continue
    const active = idle <= ACTIVE_MS
    let phase = 'model'
    let tool = ''
    let since = s.lastTs
    if (s.open.size) {
      phase = 'tool'
      // 取最新的那个：更早还没回话的调用通常是上次退出/崩溃留下的幽灵，永远等不到 result，
      // 拿它算「已经跑了 4 小时」会把整块面板读歪。
      let best = null
      for (const call of s.open.values()) if (!best || call.ts > best.ts) best = call
      if (best) { tool = best.tool; since = best.ts }
    } else if (s.turnStartTs) since = Math.max(s.turnStartTs, s.lastTs)
    const elapsed = Math.max(0, now - since)
    let etaAt = 0
    let etaBasis = ''
    let etaSlow = false
    let etaOver = false
    if (phase === 'tool' && tool) {
      const own = (byToolSession.get(s.id + '|' + tool) || []).slice().sort((a, b) => a - b)
      const all = (byToolGlobal.get(tool) || []).slice().sort((a, b) => a - b)
      const use = own.length >= MIN_SAMPLES ? own : all.length >= MIN_SAMPLES ? all : null
      if (use) {
        const median = pct(use, 0.5)
        const worst = use[use.length - 1]
        // 慢命令（比如按节奏 sleep 的批处理）会远超中位数，所以分三档说人话：
        // 还没到中位 → 给个常见的结束点；超过中位但没到最久 → 拿「这个会话见过的最久」兜底；再久就是可能卡住。
        if (elapsed <= median) etaAt = since + median
        else if (elapsed <= worst) { etaAt = since + worst; etaSlow = true }
        else { etaOver = true; etaSlow = true }
        etaBasis = (own.length >= MIN_SAMPLES ? '这个会话' : '历史上') + '同样的工具通常 ' + dur(median) + '，见过最久 ' + dur(worst)
      }
    } else {
      const own = (turnDurByPreset.get(s.preset || 'other') || []).slice().sort((a, b) => a - b)
      if (own.length >= MIN_SAMPLES && s.turnStartTs) {
        etaAt = s.turnStartTs + pct(own, 0.5)
        etaBasis = '这一轮通常 ' + dur(pct(own, 0.5)) + ' 收尾'
      }
    }
    sessions.push({
      // 主人自己在这台机器上开的开发会话（ptc）也占着回合，但要跟「她在干活」分开显示：
      // 面板上问的是「她此刻在做什么」，把主人的对话算进去会读成「她正在写程序」。
      mine: s.preset === 'ptc',
      id: s.id,
      label: sessionLabel(s.id, s.preset),
      preset: s.preset,
      phase,
      tool,
      action: phase === 'tool' ? actionLabel(tool) : '在想下一步',
      since,
      elapsedMs: elapsed,
      elapsedText: dur(elapsed),
      etaAt: etaAt || 0,
      etaText: etaOver ? '已经比见过的还久，可能卡住' : etaAt ? (etaSlow ? '最晚 ' + clock(etaAt) + ' 前结束' : '预计 ' + clock(etaAt) + ' 前结束') : '',
      startedText: clock(since),
      overdue: etaOver,
      active,
      stale: !active,
      lastAt: s.lastTs,
      idleText: dur(idle),
      turns: s.starts - s.ends,
      basis: etaBasis,
    })
  }
  sessions.sort((a, b) => b.lastAt - a.lastAt)
  const live = sessions.filter((s) => s.active)
  const her = live.filter((s) => !s.mine)
  const top = her[0] || null
  let line = ''
  if (top) {
    line = top.label + '：' + top.action
    if (top.phase === 'tool') line += '（已 ' + top.elapsedText + (top.etaText ? '，' + top.etaText : '') + '）'
    else line += '（' + top.elapsedText + ' 没出新动作' + (top.etaText ? '，' + top.etaText : '') + '）'
  }
  return {
    ok: true,
    at: now,
    busy: live.length > 0,
    count: live.length,
    herCount: her.length,
    mineCount: live.length - her.length,
    sessions,
    top,
    herTop: top,
    line,
    note: live.length ? '' : sessions.length ? '有回合没收尾，但已经十几分钟没动静（多半是上次退出留下的）' : '',
  }
}
