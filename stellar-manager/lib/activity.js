/* 她此刻在做什么：综合 agent-state、最近工具调用、生物钟计划推断。
 * 只读，不上报、不触发任何动作；给控制台一个「现在」的短句。 */
import fs from 'node:fs'
import path from 'node:path'
import { AGENT_STATE_FILE, REPO, SURF } from './paths.js'
import { readJson, readTail, todayKey } from './util.js'
import { findWhale } from './util.js'
import { contactIndex, nameForKey, relationFor } from './people.js'

// 原来是写死的绝对路径：换个盘符/换台机器就静默读到空（面板只会显示「待机」）。
const CALL_FILE = path.join(REPO, 'state', 'tool-calls.jsonl')

// 规则表按「去掉 mcp__<server>__ 前缀之后的工具名」匹配：tool-calls.jsonl 里存的是
// mcp__snowluma__qq_send_message 这种全名。表里原来还留着一批 surfcore_* 旧工具名
// （surfcore 2026-11-12 就删了），所以几乎什么都落不到，只显示「在忙别的」。
const KIND_RULES = [
  // 小镇要排在前面：stellar_town_now / stellar_town_visit 这些不该被别的规则吃掉。
  [/^(stellar_town_|fishbowl_town_|town_)/, 'town', '在小镇里'],
  [/^qq_send_message$|^qq_send_image$|^qq_send_sticker$|^qq_send_poke$|^qq_send_group_message$|^qq_send_private_message$|^qq_send_face$|qq_get_message_images|qq_get_prompt|qq_mark_read|qq_close_conversation|qq_reply_and_finish/, 'chat', '回消息'],
  [/qq_wait_for_messages/, 'wait', '在等你说话'],
  [/qzone_post|qzone_react|qzone_delete_comment/, 'qzone', '在空间互动'],
  [/qzone_read|qzone/, 'qzone', '看 QQ 空间'],
  [/bili_post|dynamic_image|^dynamic$/, 'dynamic', '发 B 站动态'],
  [/bili_watch|bili_comments|bili_feed|bili_my|bili_history|bili_comment|bili_find|douyin_watch|bili|debrief|feed/, 'bili', '逛 B 站'],
  [/image_generate/, 'image', '画图'],
  [/report/, 'report', '写日报'],
  [/file_read|spill_read/, 'read', '读长文档'],
  [/web_search|web_fetch|read_page|x_search/, 'search', '查资料'],
  [/person_memory|contacts|memory_read|memory_search|memory_catalog|memory_topic|memory_fact/, 'memory', '翻记忆'],
  [/chat_history|outbox/, 'audit', '查聊天记录'],
  [/set_wake_config|wake_config/, 'wake', '在安排下次醒来'],
]

/** mcp__snowluma__stellar_town_now → stellar_town_now（其余原样返回）。 */
function toolBase(tool) {
  const t = String(tool || '')
  const m = /^mcp__[A-Za-z0-9_-]+__(.+)$/.exec(t)
  return m ? m[1] : t
}

function kindOf(tool) {
  const t = toolBase(tool)
  for (const [re, kind, label] of KIND_RULES) if (re.test(t)) return { kind, label }
  return { kind: 'other', label: '在忙别的' }
}

function parseArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(String(raw)) } catch { return {} }
}

function readRecentCalls(maxLines = 400) {
  let text = ''
  try { text = readTail(CALL_FILE, 512 * 1024) } catch { return [] }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (row.type !== 'call') continue
    const at = Date.parse(row.time || '') || 0
    if (!at) continue
    out.push({ at, tool: String(row.tool || ''), key: String(row.key || ''), args: parseArgs(row.args) })
  }
  out.sort((a, b) => a.at - b.at)
  return out.slice(-maxLines)
}

function fmtGap(ms) {
  const m = Math.max(0, Math.round(ms / 60000))
  if (m < 1) return '刚刚'
  if (m < 60) return m + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

function readStates() {
  const j = readJson(AGENT_STATE_FILE, null) || {}
  const convs = j.conversations && typeof j.conversations === 'object' ? j.conversations : {}
  const counts = { ACTIVE: 0, COOLDOWN: 0, LISTEN: 0, SLEEP: 0 }
  let top = null
  for (const [key, v] of Object.entries(convs)) {
    const st = String(v && v.state || '').toUpperCase()
    if (counts[st] != null) counts[st]++
    if (!top || Number(v.lastAt || 0) > Number(top.lastAt || 0)) top = { key, ...v, state: st }
  }
  return { top, counts, updatedAt: j.updatedAt || '' }
}

function nextWake() {
  const { state } = findWhale()
  if (!state || state.date !== todayKey()) return null
  const slots = Array.isArray(state.slots) ? state.slots : []
  if (state.fired || state.done) return null
  const pending = slots.filter((s) => s.status === 'pending' && s.action === 'wake')
  if (!pending.length) return null
  pending.sort((a, b) => Number(a.at) - Number(b.at))
  const s = pending[0]
  // s.at / nowMin() 都是“当天第几分钟”，相减就是分钟数（原来又 ×60，报成了秒）
  const mins = Math.round(Number(s.at) - nowMin())
  return {
    atText: s.atText || '',
    inMin: mins,
    window: s.window || '',
    maxVideos: Number(state.maxVideos) || 0,
    label: s.atText ? s.atText + ' 醒来' + (state.maxVideos ? '，看 ' + state.maxVideos + ' 条' : '') : '等下一次醒来',
  }
}

function nowMin() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

export function buildActivity({ turns = null, town = null } = {}) {
  const now = Date.now()
  const index = contactIndex()
  const calls = readRecentCalls()
  const last = calls[calls.length - 1] || null
  const states = readStates()
  const next = nextWake()
  let kind = 'idle'
  let label = '待机'
  let detail = '没什么动静，在等消息'
  let targetKey = ''
  let targetName = ''
  let at = 0
  let active = false

  if (last) {
    const k = kindOf(last.tool)
    kind = k.kind
    label = k.label
    at = last.at
    targetKey = String(last.args.key || last.args.target || last.key || '')
    targetName = targetKey ? nameForKey(index, targetKey) : ''
    const rel = targetKey ? relationFor(index, targetKey) : ''
    const gap = now - at
    active = gap < 4 * 60_000
    if (kind === 'chat' || kind === 'wait') {
      detail = targetName ? '跟 ' + targetName + (rel ? '（' + rel + '）' : '') : '在聊天里'
      if (kind === 'wait' && active) label = '在等你说话'
      else if (kind === 'chat' && active) label = '正在回消息'
      else if (kind === 'chat') label = '回消息'
    } else if (kind === 'bili') {
      detail = '刷视频、看评论'
    } else if (kind === 'qzone') {
      detail = targetName ? '在 ' + targetName + ' 的空间' : '看说说、评论和点赞'
    } else if (kind === 'dynamic') {
      detail = '在 B 站发动态'
    } else if (kind === 'image') {
      detail = '在生成图片'
    } else if (kind === 'report') {
      detail = '在写今天的日报'
    } else if (kind === 'read') {
      detail = '在读长文档'
    } else if (kind === 'search') {
      detail = '在查资料'
    } else if (kind === 'memory') {
      detail = '在翻长期记忆'
    } else if (kind === 'town') {
      detail = town && town.detail ? town.detail : '在小镇里逛'
    } else {
      detail = '刚做完一件事'
    }
  }

  // agent-state 比工具调用更「当下」：ACTIVE 说明这一轮还没收尾。
  const top = states.top
  if (top && top.state === 'ACTIVE' && (!last || now - Number(top.lastAt || 0) < 10 * 60_000)) {
    kind = 'chat'
    label = '正在聊天'
    targetKey = String(top.key || '')
    targetName = targetKey ? nameForKey(index, targetKey) : ''
    detail = targetName ? '跟 ' + targetName + ' 说话，这一轮还没收尾' : '这一轮还没收尾'
    at = Math.max(at, Number(top.lastAt || 0))
    active = true
  } else if (top && top.state === 'COOLDOWN' && (!last || now - Number(top.lastAt || 0) < 10 * 60_000)) {
    if (!last || kind === 'chat') {
      kind = 'chat'
      label = '刚回完消息'
      targetKey = String(top.key || '')
      targetName = targetKey ? nameForKey(index, targetKey) : ''
      detail = targetName ? '刚跟 ' + targetName + ' 聊完，在冷却' : '刚聊完，在冷却'
      at = Math.max(at, Number(top.lastAt || 0))
    }
  }

  if ((!last || now - at > 6 * 60_000) && top && top.state === 'SLEEP') {
    kind = 'sleep'
    label = '休眠中'
    detail = next ? (next.inMin > 0 ? '等 ' + next.atText + ' 醒来' : '计划的 ' + next.atText + ' 还没跑，等调度器补上') : '今天没有排计划了'
  } else if (!last && top && top.state === 'LISTEN') {
    kind = 'chat'
    label = '在线'
    detail = '在听，等你继续说'
  }

  // 小镇在场层（2026-11-22）：她人在镇里时，上面几层只会说「休眠中」/「待机」——
  // QQ 消息和工具调用都在 DSH 里，而小镇的回合跑在官方插件自己的会话里，工具日志里看不到。
  // 让位规则：刚动过手（60 秒内）就继续说动作；真正的未收尾回合（下面那一层）仍然压在最上面。
  if (town && town.inTown && town.fresh && (kind === 'sleep' || kind === 'idle' || now - at > 60_000)) {
    kind = 'town'
    label = '她正在小镇上'
    detail = town.detail || '在镇上'
    at = Math.max(at, town.at || 0)
    active = true
  }

  // DSH 遥测里「回合还没收尾」比工具调用日志更硬：工具调用只说明她动过手，
  // 回合没收尾才说明她现在还在跑（可能正卡在一条要跑五分钟的命令里）。
  // 这一层压在最上面，顺便把预计结束时间带给面板与「重启 DSH」的确认框。
  let turn = null
  if (turns && turns.herTop) {
    turn = turns.herTop
    kind = /B 站/.test(turn.label) ? 'bili' : /小镇/.test(turn.label) ? 'town' : 'chat'
    label = /^在/.test(turn.action) ? '正' + turn.action.slice(1) : '正在' + turn.action
    detail = turn.label + ' · 已 ' + turn.elapsedText + (turn.etaText ? '，' + turn.etaText : '')
    at = turn.since
    active = true
  }

  const recent = calls.slice(-6).reverse().map((c) => {
    const k = kindOf(c.tool)
    const key = String(c.args.key || c.args.target || c.key || '')
    return { at: c.at, label: k.label, kind: k.kind, targetName: key ? nameForKey(index, key) : '', ago: fmtGap(now - c.at) }
  })

  return {
    ok: true,
    at: now,
    kind,
    label,
    detail,
    active,
    targetKey,
    targetName,
    since: at || 0,
    ago: at ? fmtGap(now - at) : '',
    state: top ? top.state : '',
    counts: states.counts,
    updatedAt: states.updatedAt,
    next,
    turn,
    recent,
  }
}
