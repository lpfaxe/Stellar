/**
 * Stellar —— 让「她真的在镇上」的那条长轮询。
 *
 * 为什么必须有它：小镇的「连上」不是有访问码就算，而是要有程序一直挂着
 * `GET /turns?wait=…`。不挂 → `outside_state: not_connected`，`/lobby` 直接 409
 * （`TOWN_OUTSIDE_NOT_CONNECTED`），来访、牌局、收据这些事件根本不会产生，
 * 记忆层永远是空的。
 *
 * 原则（P2 的边界）：
 *  · **只连不看戏**：拿到 turn 只记一笔、最多叫醒她看一眼；绝不替她点头/花钱。
 *  · 一次只挂一条：进程里只允许一个 pump 在跑，断了按指数退避（并遵守 retry_after）。
 *  · 拿到什么都当数据：turn 里可能带陌生人写的句子，一律走 cleanText + quoted 标记。
 */
import { buildNoteRow, cleanText, looksLikeDirective } from './town-memory-pure.js'

/** 服务端最多挂多久（秒）。客户端超时必须比它长，否则永远读成 timeout。 */
export const TURNS_WAIT_SEC = 45
export const TURNS_BACKOFF_MIN_MS = 2000
export const TURNS_BACKOFF_MAX_MS = 5 * 60_000
export const TURNS_TEXT_MAX = 200

function pickText(raw) {
  const candidates = [raw.text, raw.question, raw.message, raw.prompt, raw.summary, raw.line, raw.topic]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return cleanText(c, TURNS_TEXT_MAX)
  }
  return ''
}

function pickWho(raw) {
  const from = raw.from && typeof raw.from === 'object' ? raw.from : null
  const name = (from && (from.name || from.nick || from.display_name)) || raw.from_name || raw.who || raw.name || ''
  const id = (from && (from.id || from.fish_id || from.fishId)) || raw.from_id || raw.who_id || raw.fish_id || ''
  return { who: cleanText(name, 20), whoId: String(id || '').trim() }
}

function toMs(v, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return dflt
  return n < 1e12 ? n * 1000 : n
}

/**
 * 把服务端给的 turn 收成我们能用的五六个字段。认不出来的字段一律忽略，
 * 认不出正文就返回 null（宁可不记，也不把半句话塞进她的记忆）。
 */
export function normalizeTurn(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const text = pickText(raw)
  if (!text) return null
  const { who, whoId } = pickWho(raw)
  const kind = cleanText(raw.kind || raw.type || 'activity', 24) || 'activity'
  const id = String(raw.id || raw.turn_id || raw.turnId || '').trim()
  return {
    id,
    kind,
    who,
    whoId,
    text,
    at: toMs(raw.at || raw.created_at || raw.createdAt || raw.time, now),
    quoted: looksLikeDirective(text),
  }
}

/** turn → town_note 的一行（kind 记成 turn:<kind>，和 visit/receipt 分开）。 */
export function turnNote(turn, { now = Date.now() } = {}) {
  if (!turn || !turn.text) return null
  return buildNoteRow({
    kind: 'turn:' + (turn.kind || 'activity'),
    who: turn.who,
    whoId: turn.whoId,
    text: turn.text,
    quoted: turn.quoted === true,
    at: turn.at || now,
  }, now)
}

/**
 * 长轮询泵。
 * @param {object} o
 * @param {{read:(p:string,o?:object)=>Promise<any>}} o.client  town-client（超时要 > wait）
 * @param {(turn:object)=>any} [o.onTurn]                        每个 turn 调一次
 * @param {()=>boolean} [o.enabled]                              每轮前看一眼还该不该连
 */
export function createTurnPump({
  client, onTurn, enabled, log, waitSec = TURNS_WAIT_SEC,
  baseBackoffMs = TURNS_BACKOFF_MIN_MS, maxBackoffMs = TURNS_BACKOFF_MAX_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
} = {}) {
  const wanted = Number(waitSec)
  const wait = Number.isFinite(wanted) ? Math.max(5, Math.min(110, wanted)) : TURNS_WAIT_SEC
  let running = false
  let loop = null
  let errors = 0
  let backoff = baseBackoffMs
  let connected = false
  let lastOkAt = 0
  let lastError = null
  let turnsSeen = 0

  async function runOnce() {
    const started = now()
    try {
      const res = await client.read('turns', { query: { wait, kinds: 'activity' } })
      const list = Array.isArray(res && res.turns) ? res.turns : []
      const turns = list.map((t) => normalizeTurn(t, { now: now() })).filter(Boolean)
      errors = 0
      backoff = baseBackoffMs
      connected = true
      lastOkAt = now()
      lastError = null
      for (const turn of turns) {
        turnsSeen += 1
        if (!onTurn) continue
        try { await onTurn(turn) } catch (err) {
          lastError = String((err && err.message) || err).slice(0, 160)
          if (log) log('[town] 处理镇上消息失败：' + lastError)
        }
      }
      return { ok: true, turns, ms: now() - started }
    } catch (err) {
      errors += 1
      connected = false
      lastError = String((err && err.message) || err).slice(0, 160)
      const retryAfter = Number(err && err.retryAfter) || 0
      const exp = baseBackoffMs * Math.pow(2, Math.min(errors - 1, 8))
      backoff = Math.min(maxBackoffMs, Math.max(exp, retryAfter > 0 ? retryAfter * 1000 : 0))
      return { ok: false, turns: [], ms: now() - started, backoffMs: backoff, code: (err && err.code) || 'error' }
    }
  }

  function start() {
    if (running) return
    running = true
    loop = (async () => {
      while (running) {
        if (typeof enabled === 'function' && !enabled()) { await sleep(60_000); continue }
        const r = await runOnce()
        if (!running) break
        if (!r.ok) { await sleep(r.backoffMs); continue }
        // 服务端没挂住（秒回空）就别热循环，给它两秒喘口气。
        if (!r.turns.length && r.ms < 1500) await sleep(2000)
      }
    })().catch(() => {}).finally(() => { running = false; loop = null })
  }

  function stop() {
    running = false
  }

  return {
    start,
    stop,
    runOnce,
    get running() { return running },
    stats: () => ({ running, wait, connected, lastOkAt, lastError, errors, backoffMs: backoff, turnsSeen }),
  }
}
