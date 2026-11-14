/* 待办审批：面板只做读写展示，状态机在插件仓库的 src/approvals.js（与 MCP/桥接共用同一份）。 */
import {
  approveApproval,
  expireApprovals,
  getApproval,
  listApprovals,
  rejectApproval,
  stats,
} from '../../src/approvals.js'

const STATUS_LABEL = {
  pending: '待批',
  approved: '已通过 · 等她执行',
  executing: '执行中',
  executed: '已执行',
  rejected: '已拒绝',
  expired: '已过期',
  failed: '执行失败',
}

function decorate(a, now) {
  const secondsLeft = Math.max(0, Math.round((Number(a.expiresAt) - now) / 1000))
  return {
    requestId: a.requestId,
    key: a.key,
    requester: a.requester || {},
    action: a.action,
    actionLabel: a.actionLabel,
    args: a.args,
    summary: a.summary,
    estimatedCost: a.estimatedCost,
    status: a.status,
    statusLabel: STATUS_LABEL[a.status] || a.status,
    createdAt: a.createdAt,
    expiresAt: a.expiresAt,
    secondsLeft,
    approvedAt: a.approvedAt,
    executedAt: a.executedAt,
    result: a.result,
    error: a.error,
  }
}

export function readApprovals({ status = '', limit = 30 } = {}) {
  const now = Date.now()
  try {
    expireApprovals(now)
    const all = listApprovals({ status: status || undefined, now })
    const pending = all.filter((a) => a.status === 'pending')
    return {
      ok: true,
      stats: stats(now),
      items: all.slice(-Math.max(1, Math.min(100, limit))).reverse().map((a) => decorate(a, now)),
      pending: pending.map((a) => decorate(a, now)),
      at: now,
    }
  } catch (e) {
    return { ok: false, message: String(e?.message || e), items: [], pending: [], stats: {} }
  }
}

export function actOnApproval(id, action, by = 'panel') {
  const key = String(id || '').trim()
  if (!key) return { ok: false, message: '缺少 requestId' }
  const act = String(action || '').trim()
  let r
  if (act === 'approve') r = approveApproval(key, by)
  else if (act === 'reject') r = rejectApproval(key, by)
  else return { ok: false, message: 'action 只能是 approve / reject' }
  const record = r?.approval || getApproval(key)
  return {
    ok: r?.ok === true,
    code: r?.code || '',
    message: r?.ok
      ? (act === 'approve' ? '已通过，她去执行了。' : '已拒绝，不会执行。')
      : (r?.message || '处理失败'),
    item: record ? decorate(record, Date.now()) : null,
    stats: (() => { try { return stats() } catch { return {} } })(),
  }
}
