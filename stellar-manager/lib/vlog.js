/* 每日 vlog：审核队列 + 花费 + 成片媒体（面板只读展示，写操作走 bili.mjs） */
import fs from 'node:fs'
import path from 'node:path'
import { SURF, CFG_FILE, BILI, REPO } from './paths.js'
import { readJson, atomicWriteJson, run, appendAudit, logLine } from './util.js'

const KINDS = new Set(['title', 'note', 'quote', 'list', 'fact', 'outro'])

/** 找最近在动的角色 vlog 目录（多角色时以 queue.json 的 mtime 为准） */
export function findVlogDir() {
  const base = path.join(SURF, 'characters')
  const found = []
  try {
    for (const role of fs.readdirSync(base)) {
      const dir = path.join(base, role, 'bili', 'vlog')
      if (!fs.existsSync(dir)) continue
      const q = path.join(dir, 'queue.json')
      found.push({ dir, role, mtime: fs.existsSync(q) ? fs.statSync(q).mtimeMs : 0 })
    }
  } catch {}
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0] || { dir: null, role: '', mtime: 0 }
}

const cfgOf = () => readJson(CFG_FILE, {})
const day = () => new Date().toLocaleDateString('sv-SE')

function publicItem(it, dir) {
  const file = String(it.file || '')
  return {
    id: String(it.id || ''),
    date: String(it.date || ''),
    status: String(it.status || 'pending'),
    title: String(it.title || ''),
    desc: String(it.desc || ''),
    tags: Array.isArray(it.tags) ? it.tags : [],
    seconds: Number(it.seconds || 0),
    bytes: Number(it.bytes || 0),
    scenes: Number(it.scenes || 0),
    costCNY: Number(it.costCNY || 0),
    createdAt: String(it.createdAt || ''),
    bvid: String(it.bvid || it.published?.bvid || ''),
    error: String(it.error || ''),
    rejectReason: String(it.rejectReason || ''),
    // 返工链（2026-11-10 owner 要求）：驳回=待完成，重做完标 done，面板据此分「待审核 / 驳回」两区
    fixState: String(it.fixState || ''),
    rejectedAt: String(it.rejectedAt || it.decidedAt || ''),
    reworkOf: String(it.reworkOf || ''),
    revision: Number(it.revision || 1),
    supersededBy: String(it.supersededBy || ''),
    creative: String(it.creative || 'https://member.bilibili.com/platform/upload/video/frame'),
    cover: it.cover ? '/api/vlog/cover?id=' + encodeURIComponent(String(it.id || '')) : '',
    video: file ? '/api/vlog/media?id=' + encodeURIComponent(String(it.id || '')) : '',
    reflect: it.lastReflect || null,
  }
}

export function buildVlog({ limit = 20 } = {}) {
  const found = findVlogDir()
  const cfg = cfgOf()
  const V = cfg.vlog || {}
  if (!found.dir) {
    return {
      ok: true, dir: null, role: found.role || '', today: day(),
      enabled: V.enabled !== false, window: String(V.window || '12:00-14:00'),
      dailyCostCNY: Number(V.dailyCostCNY || 5), autoPublish: V.autoPublish === true,
      cost: { todayCNY: 0, limitCNY: Number(V.dailyCostCNY || 5), leftCNY: Number(V.dailyCostCNY || 5), tokens: 0, renders: 0 },
      counts: { pending: 0, published: 0, rejected: 0, pendingTodo: 0, reworkDone: 0, failed: 0, total: 0 },
      live: null, items: [],
    }
  }
  const queue = readJson(path.join(found.dir, 'queue.json'), { items: [] })
  const items = (queue.items || []).map((it) => publicItem(it, found.dir))
  const cost = readJson(path.join(found.dir, 'cost.json'), { days: {} })
  const today = day()
  const todayCost = cost.days?.[today] || { cny: 0, tokens: 0, items: [] }
  const live = readJson(path.join(found.dir, '..', 'vlog-live.json'), null)
  const limitCNY = Number(V.dailyCostNY ?? V.dailyCostCNY ?? 5)
  return {
    ok: true, dir: found.dir, role: found.role, today,
    enabled: V.enabled !== false, window: String(V.window || '12:00-14:00'),
    dailyCostCNY: limitCNY, autoPublish: V.autoPublish === true,
    cost: {
      todayCNY: Number(Number(todayCost.cny || 0).toFixed(4)),
      limitCNY, leftCNY: Number(Math.max(0, limitCNY - Number(todayCost.cny || 0)).toFixed(4)),
      tokens: Number(todayCost.tokens || 0), renders: (todayCost.items || []).length,
    },
    counts: {
      pending: items.filter((x) => x.status === 'pending').length,
      published: items.filter((x) => x.status === 'published').length,
      rejected: items.filter((x) => x.status === 'rejected').length,
      // 被驳回但还没重做的（面板「驳回」区要显示的），和已经重做掉的
      pendingTodo: items.filter((x) => x.status === 'rejected' && x.fixState !== 'done').length,
      reworkDone: items.filter((x) => x.status === 'rejected' && x.fixState === 'done').length,
      failed: items.filter((x) => x.status === 'failed').length,
      total: items.length,
    },
    live: live && live.day === today ? live : null,
    items: items.slice(0, Math.max(1, Math.min(50, limit))),
  }
}

function queueFile() {
  const found = findVlogDir()
  if (!found.dir) throw new Error('还没有做过视频（找不到 vlog 目录）')
  return { file: path.join(found.dir, 'queue.json'), dir: found.dir }
}

/** 只允许读队列里登记的成片/封面，路径必须落在 vlog/out 下（防目录穿越） */
export function vlogMedia(id, kind = 'video') {
  const { dir } = queueFile()
  const queue = readJson(path.join(dir, 'queue.json'), { items: [] })
  const it = (queue.items || []).find((x) => String(x.id) === String(id))
  if (!it) return null
  const file = kind === 'cover' ? String(it.cover || '') : String(it.file || '')
  if (!file) return null
  const outRoot = path.resolve(dir, 'out')
  const real = (() => { try { return fs.realpathSync(file) } catch { return '' } })()
  if (!real || !(real === outRoot || real.startsWith(outRoot + path.sep))) return null
  if (!fs.existsSync(real)) return null
  return { file: real, stamp: fs.statSync(real).mtime.toISOString() }
}

/**
 * 面板上的操作。发布一定要带 confirm（前端二次确认 + 这里再挡一道），
 * 因为一次投稿在 B站那边是不可撤销的。
 */
export async function vlogAction(body = {}) {
  const id = String(body.id || '')
  const action = String(body.action || '')
  if (!id) throw new Error('缺少 id')
  const { file } = queueFile()
  const queue = readJson(file, { items: [] })
  const it = (queue.items || []).find((x) => String(x.id) === String(id))
  if (!it) throw new Error('队列里没有这条')
  const node = process.execPath
  const cwd = path.join(REPO, 'plugins', 'stellar', 'tools')

  if (action === 'reject') {
    const reason = String(body.reason || '').slice(0, 200)
    const r = await run(node, [BILI, 'vlog', 'reject', id, ...(reason ? ['--reason', reason] : [])], { cwd, timeout: 60_000 })
    const ok = r.code === 0
    appendAudit('vlog-reject', { id, reason, ok })
    return { ok: ok, message: ok ? '已驳回' : ('驳回失败：' + String(r.err || r.out).slice(0, 200)) }
  }

  if (action === 'save') {
    const next = { ...it }
    if (body.title != null) next.title = String(body.title).slice(0, 80)
    if (body.desc != null) next.desc = String(body.desc).slice(0, 2000)
    if (Array.isArray(body.tags)) next.tags = body.tags.map((t) => String(t).slice(0, 20)).filter(Boolean).slice(0, 10)
    queue.items = queue.items.map((x) => (String(x.id) === id ? next : x))
    atomicWriteJson(file, queue)
    appendAudit('vlog-save', { id, title: next.title })
    return { ok: true, message: '已保存文案（还没发布）' }
  }

  if (action === 'publish') {
    if (body.confirm !== true) throw new Error('发布要带 confirm:true（二次确认）')
    if (it.status === 'published') return { ok: true, message: '这条已经发布过了：BV' + (it.bvid || it.published?.bvid || '') }
    const args = [BILI, 'vlog', 'publish', id]
    if (body.dry !== true) args.push('--go')
    const r = await run(node, args, { cwd, timeout: 15 * 60_000 })
    const ok = r.code === 0
    appendAudit('vlog-publish', { id, dry: body.dry === true, ok })
    logLine('vlog publish ' + id + ' (dry=' + (body.dry === true) + ') ok=' + ok)
    const text = String(r.out || '') + '\n' + String(r.err || '')
    const bv = (text.match(/BV[0-9A-Za-z]{10}/) || [''])[0]
    return {
      ok: ok, message: ok
        ? (body.dry === true ? '演练完成：视频已上传但没投稿（B站那边看不到）' : ('已提交：' + (bv || '见创作中心')))
        : ('发布失败：' + text.trim().split('\n').slice(-3).join(' ').slice(0, 300)),
      output: text.trim().slice(-1500),
    }
  }

  if (action === 'manual') {
    // 脚本上传不通时（B站 upos 会对部分账号/网络直接 400），主人在创作中心自己传，
    // 再把 BV 记回来：这样第二天的复盘、收益追踪还能接上。
    const bvid = String(body.bvid || '').trim()
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('要一个 BV 号（形如 BV1xx411c7mD）')
    const r = await run(node, [BILI, 'vlog', 'manual', id, '--bvid', bvid], { cwd, timeout: 60_000 })
    const ok = r.code === 0
    appendAudit('vlog-manual', { id, bvid, ok })
    return { ok: ok, message: ok ? ('已登记：https://www.bilibili.com/video/' + bvid) : ('登记失败：' + String(r.err || r.out).slice(0, 200)) }
  }

  if (action === 'rework-done') {
    // 她决定不重做（或者换了题），把这条从「驳回」区摘掉，不用非得再出一条
    it.fixState = 'done'
    it.reworkedAt = new Date().toISOString()
    it.reworkedNote = String(body.note || '').slice(0, 200)
    atomicWriteJson(file, queue)
    appendAudit('vlog-rework-done', { id, note: it.reworkedNote })
    return { ok: true, message: '已标记完成' }
  }

  if (action === 'fix-request') {
    // 让「现在处理」：写请求文件，调度器下一分钟唤醒她
    const target = body.fixId ? queue.items.find((x) => String(x.id) === String(body.fixId)) : null
    const req = {
      at: new Date().toISOString(),
      atMs: Date.now(),
      by: 'panel',
      id: target ? String(target.id) : '',
      reason: target ? String(target.rejectReason || '') : '',
    }
    atomicWriteJson(path.join(SURF, 'state', 'vlog-fix-request.json'), req)
    appendAudit('vlog-fix-request', { id: req.id, reason: req.reason })
    logLine('vlog fix request ' + (req.id || '(any)'))
    return { ok: true, message: '已叫她处理——她下一分钟收到，写脚本重做完会回到「待审核」' }
  }

  if (action === 'retry') {
    const r = await run(node, [BILI, 'vlog', 'publish', id, '--go'], { cwd, timeout: 15 * 60_000 })
    const ok = r.code === 0
    return { ok: ok, message: ok ? '重试已提交' : ('重试失败：' + String(r.err || r.out).slice(-200)) }
  }

  throw new Error('不认识的操作：' + action)
}

/** 她的脚本文档（面板只读展示：让她知道自己写了什么，也方便主人判断） */
export function vlogScript(date) {
  const { dir } = (() => { try { return queueFile() } catch { return { dir: '' } } })()
  if (!dir) return null
  const file = path.join(dir, 'script-' + (date || day()) + '.json')
  return readJson(file, null)
}
