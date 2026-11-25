/* 公网来源也能重启 DSH —— 但只开「重启」这一个动作。
 *
 * 为什么需要开口：面板的写操作默认对公网（Cloudflare 隧道 / 公网 IPv6）一律 403
 * readonly-public。人不在家时，重启 DSH 是唯一「必须马上能做」的操作（改代码、卡住、
 * 界面打不开都要它），而它本身不读不写任何用户数据，只是把宿主进程关掉再拉起来。
 *
 * 所以这里不是放宽 requireWrite，而是在 /api/action 里给 restart-dsh 单独一条路：
 *   · 必须是已登录的会话（gate 先过）；
 *   · 必须同源或带 x-panel-request: panel（crossSite 先过）；
 *   · 只认 action === 'restart-dsh'，其余动作仍然 403；
 *   · 60 秒冷却（同一次重启的重复点击不报错，只提示还在进行中）；
 *   · 每次都要留一行审计（谁、从哪来、哪个 scope），日志里没有凭据。
 *
 * 为什么不做「一次性令牌」：重启不是凭据操作，冷却 + 审计给出的保护已经足够；
 * 加一层令牌只会让「人在外面、DSH 卡死」时更难用，而那时恰恰是它唯一的用途。
 */
import { appendAudit, logLine } from './util.js'

/** 允许公网来源执行的写动作白名单。加进来之前先问三句：它会改用户数据吗？会泄露凭据吗？被刷了会怎样？ */
export const REMOTE_ACTION_ALLOW = new Set(['restart-dsh'])

/** 同一个公网来源两次重启之间的最小间隔。 */
export const REMOTE_RESTART_GAP_MS = 60 * 1000

const lastByIp = new Map()

export function remoteActionAllowed(action) {
  return REMOTE_ACTION_ALLOW.has(String(action || ''))
}

/**
 * 公网来源的写请求能不能放行。
 * 返回 { ok:true } 或 { ok:false, code, message }；调用方负责 sendJson。
 */
export function remoteWriteDecision({ action, scope, ip = '', now = Date.now(), gapMs = REMOTE_RESTART_GAP_MS } = {}) {
  const act = String(action || '')
  if (String(scope || '') !== 'public') return { ok: true }
  if (!remoteActionAllowed(act)) {
    return {
      ok: false,
      code: 'readonly-public',
      message: '公网只能查看、审批和重启 DSH；改数据请在本机或同一 WiFi 下操作'
    }
  }
  const key = String(ip || 'unknown')
  // 没记录过 ≠ 上次在 epoch 0 点过：必须用「有没有这条记录」判断，
  // 否则 0 会被当成上一次的时间，第一次点就被自己的冷却挡住。
  const prev = lastByIp.get(key)
  if (prev != null && now - prev < gapMs) {
    const wait = Math.ceil((gapMs - (now - prev)) / 1000)
    return {
      ok: false,
      code: 'too-frequent',
      message: '刚从这里点过一次重启，' + wait + ' 秒后才能再点（正在重启的话等它回来）'
    }
  }
  return { ok: true, note: 'public-restart', ip: key }
}

/** 记下「这次公网重启真的发生了」，给下一次冷却用；同时写审计行。 */
export function noteRemoteWrite({ action, scope, ip = '', by = 'panel', ok = true, extra = {} } = {}) {
  const act = String(action || '')
  if (String(scope || '') !== 'public') return
  if (!remoteActionAllowed(act)) return
  const key = String(ip || 'unknown')
  if (ok) lastByIp.set(key, Date.now())
  try {
    appendAudit('remote-action', { action: act, by, ok: Boolean(ok), scope: 'public', ip: key, ...extra })
  } catch {}
  try {
    logLine('remote-action ' + act + ' from ' + key + ' -> ' + (ok ? 'ok' : 'rejected'))
  } catch {}
}

/** 测试与面板重启后复位用。 */
export function resetRemoteWriteState() {
  lastByIp.clear()
}
