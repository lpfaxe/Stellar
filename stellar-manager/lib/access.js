/* 谁能跟她说上话：白名单 / 黑名单（读写桥接配置，保存走桥接控制台 API 做热更新 + 归一化） */
import fs from 'node:fs'
import { ACCESS_AUDIT, BRIDGE_CFG } from './paths.js'
import { portOpen, readJson, readTail } from './util.js'

const LIST_LABEL = {
  'allow.private': '私聊白名单',
  'allow.groups': '群白名单',
  'deny.users': '拒绝名单（人）',
  'deny.private': '私聊黑名单',
  'deny.groups': '群黑名单'
}

function normIds(value, label) {
  if (value === undefined || value === null) return undefined
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,，、;；]+/)
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const s = String(item ?? '').trim()
    if (!s) continue
    if (!/^\d{5,20}$/.test(s)) throw new Error(label + ' 里的「' + s + '」不是 QQ 号（只能填数字）')
    if (s.length > 15) throw new Error(label + ' 里的「' + s + '」太长了，QQ 号不会超过 15 位')
    if (seen.has(s)) continue
    seen.add(s)
    out.push(Number(s))
    if (out.length > 200) throw new Error(label + ' 最多 200 个，先删一些')
  }
  return out
}

export function recentBlocked(limit = 10) {
  if (!fs.existsSync(ACCESS_AUDIT)) return []
  try {
    const lines = readTail(ACCESS_AUDIT, 96 * 1024).split('\n').filter((x) => x.trim())
    const out = []
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const e = JSON.parse(lines[i])
        out.push({
          at: e.at || '',
          reason: String(e.reason || 'blocked'),
          key: String(e.key || ''),
          userId: String(e.userId || ''),
        })
      } catch {}
    }
    return out
  } catch {
    return []
  }
}

export async function readAccess() {
  const cfg = readJson(BRIDGE_CFG, {})
  return {
    ok: true,
    ownerQQ: cfg.ownerQQ || cfg.admin?.qq || null,
    allow: {
      private: Array.isArray(cfg.allow?.private) ? cfg.allow.private : [],
      groups: Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [],
    },
    deny: {
      users: Array.isArray(cfg.deny?.users) ? cfg.deny.users : [],
      private: Array.isArray(cfg.deny?.private) ? cfg.deny.private : [],
      groups: Array.isArray(cfg.deny?.groups) ? cfg.deny.groups : [],
    },
    allowAllWhenEmpty: cfg.allowAllWhenEmpty === true,
    bridgeOnline: await portOpen(3100),
    blocked: recentBlocked(10),
    updatedAt: (() => { try { return fs.statSync(BRIDGE_CFG).mtimeMs } catch { return 0 } })(),
  }
}

/**
 * 保存白名单/黑名单。
 * 不直接写文件：走桥接的 POST /api/whitelist，让它做 normalizeAllowlist（补主人私聊、
 * 去掉机器人自己）和内存热更新，避免面板与桥接两份状态。
 */
export async function saveAccess(body = {}) {
  const cfg = readJson(BRIDGE_CFG, {})
  const ownerQQ = body.ownerQQ !== undefined && body.ownerQQ !== null
    ? String(body.ownerQQ).trim()
    : String(cfg.ownerQQ || cfg.admin?.qq || '').trim()
  if (ownerQQ && !/^\d{5,20}$/.test(ownerQQ)) throw new Error('管理员 QQ 只能是数字')

  const allow = {
    private: normIds(body.allow?.private, LIST_LABEL['allow.private']) ?? (Array.isArray(cfg.allow?.private) ? cfg.allow.private : []),
    groups: normIds(body.allow?.groups, LIST_LABEL['allow.groups']) ?? (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : []),
  }
  const deny = {
    users: normIds(body.deny?.users, LIST_LABEL['deny.users']) ?? (Array.isArray(cfg.deny?.users) ? cfg.deny.users : []),
    private: normIds(body.deny?.private, LIST_LABEL['deny.private']) ?? (Array.isArray(cfg.deny?.private) ? cfg.deny.private : []),
    groups: normIds(body.deny?.groups, LIST_LABEL['deny.groups']) ?? (Array.isArray(cfg.deny?.groups) ? cfg.deny.groups : []),
  }

  // 主人 2026-11-09 要求：管理员进拒绝名单必须报错拦下，不能只写日志。
  if (ownerQQ && deny.users.map(String).includes(ownerQQ)) {
    throw new Error('管理员 QQ ' + ownerQQ + ' 不能放进「拒绝名单（人）」——那样审批、私聊、管理命令都会失效。先从拒绝名单移除。')
  }

  const token = String(cfg.consoleToken || '').trim()
  if (!token) throw new Error('桥接配置里没有 consoleToken，面板没法安全地改名单')
  if (!(await portOpen(3100))) throw new Error('桥接没在跑（3100 没监听），这次没保存；先点「启动桥接」再试')

  let res
  try {
    res = await fetch('http://127.0.0.1:3100/api/whitelist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ allow, deny, ownerQQ: ownerQQ || null }),
      signal: AbortSignal.timeout(12000),
    })
  } catch (e) {
    throw new Error('连不上桥接：' + (e?.message || e))
  }
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && (data.error || data.message)) || ('桥接返回 HTTP ' + res.status))
  }
  return {
    ok: true,
    ownerQQ: data.ownerQQ ?? ownerQQ ?? null,
    allow: data.allow || allow,
    deny: data.deny || deny,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    bridgeOnline: true,
    blocked: recentBlocked(10),
  }
}
