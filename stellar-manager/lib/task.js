/* 强制休眠 / 立即唤醒 / 以主人身份发快捷指令。
 * 走桥接本机控制台（127.0.0.1:3100 + x-console-token），不直接碰状态文件，
 * 这样 socialV2 的定时器、暂停标记、唤醒流程都由桥接自己维护。 */
import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_CFG, BRIDGE_CONSOLE, REPO } from './paths.js'
import { readJson } from './util.js'

function config() {
  return readJson(BRIDGE_CFG, {}) || {}
}

function consoleToken() {
  const c = config()
  const t = String(c.consoleToken || '').trim()
  if (t) return t
  try {
    // 桥接没在 config.json 里配 consoleToken 时，会自己生成一个写到 <仓库>/state/console-token
    const alt = String(fs.readFileSync(path.join(REPO, 'state', 'console-token'), 'utf8')).trim()
    return alt
  } catch { return '' }
}

async function bridgeApi(path, { method = 'GET', body = null, timeout = 8000 } = {}) {
  const token = consoleToken()
  if (!token) throw new Error('桥接控制台令牌缺失（config.json consoleToken）')
  const res = await fetch(BRIDGE_CONSOLE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-console-token': token
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || ('桥接 HTTP ' + res.status))
  return data
}

export async function readTaskState() {
  const cfg = config()
  const ownerQQ = String(cfg.ownerQQ || '').trim()
  try {
    const data = await bridgeApi('/api/socialV2/activity')
    return { ok: true, paused: data.paused === true, ownerQQ, bridge: true }
  } catch (e) {
    return { ok: false, paused: null, ownerQQ, bridge: false, message: String(e && e.message || e) }
  }
}

/** 强制休眠 = 暂停二代 AI 的全部唤醒与等待；恢复 = 重新排定时器。 */
export async function setPaused(paused) {
  const r = await bridgeApi('/api/socialV2/activity', { method: 'POST', body: { paused: !!paused } })
  return { ok: true, paused: r.paused === true }
}

/** 立即唤醒主人会话（若当前是暂停状态，先恢复再唤醒）。 */
export async function wakeOwner() {
  const cfg = config()
  const owner = String(cfg.ownerQQ || '').trim()
  if (!owner) throw new Error('未配置 ownerQQ')
  const state = await readTaskState()
  if (state.ok && state.paused) await setPaused(false)
  const data = await bridgeApi('/api/socialV2/wake', { method: 'POST', body: { key: 'private:' + owner, reason: '面板立即唤醒' } })
  return { ok: true, key: data.key || ('private:' + owner), reason: data.reason || '' }
}

/** 以主人身份注入一句话（不出现在主人手机上，直接进入她的会话）。 */
export async function sendOwnerCommand(text) {
  const t = String(text || '').trim()
  if (!t) throw new Error('内容不能为空')
  if (t.length > 1500) throw new Error('太长（最多 1500 字）')
  const data = await bridgeApi('/api/socialV2/inject-owner', { method: 'POST', body: { text: t } })
  return { ok: true, key: data.key, accepted: data.accepted === true }
}
