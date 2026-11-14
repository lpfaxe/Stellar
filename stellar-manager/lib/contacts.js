/* 通讯录：把 OneBot 的好友/群列表落成 friends.json，并允许面板改备注/关系。
 * 数据文件：%USERPROFILE%\.dsh\stellar\state\friends.json
 * 结构：{ version, updatedAt, syncedAt, source, people:[...], groups:[...] }
 * 手动字段（remark/relation/relationNote/type）在重新同步时按 uin/groupId 合并保留。 */
import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_CFG, FRIENDS_FILE, REPO } from './paths.js'
import { readJson, atomicWriteJson, appendAudit } from './util.js'
import { saveAccess } from './access.js'

const TYPES = new Set(['owner', 'friend', 'stranger', 'group'])
const DEFAULT_RELATION = { owner: '主人', friend: '认识', stranger: '陌生', group: '群' }

/* OneBot 的 get_friend_list 会把 SnowLuma 自己的设备槽位（我的电脑/我的手机/我的Pad）
 * 当成好友返回，这几个不是真人，永远不进通讯录，也不允许同步时加回来。 */
const HIDDEN_FRIEND_UINS = new Set(['2113929217', '2113929218', '2113929219'])

function bridgeConfig() {
  try { return JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8')) } catch { return {} }
}

function ownerQQ() {
  return String(bridgeConfig().ownerQQ || '').trim()
}

/** 机器人自己的号（state/self-identity.json），不进通讯录，免得把自己当陌生人。 */
function selfQQ() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPO, 'state', 'self-identity.json'), 'utf8'))
    return String(j.userId || '').trim()
  } catch { return '' }
}

function onebot() {
  const c = bridgeConfig()
  const snow = c.snowluma || {}
  return {
    base: String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: String(snow.accessToken || '').trim()
  }
}

async function onebotAction(action) {
  const { base, token } = onebot()
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  const r = await fetch(base + '/' + action, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(8000)
  })
  if (!r.ok) throw new Error(action + ' HTTP ' + r.status)
  const j = await r.json()
  if (j && j.status && j.status !== 'ok') throw new Error(action + ' retcode ' + j.retcode)
  return Array.isArray(j && j.data) ? j.data : []
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

function avatar(uin) {
  return 'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(uin) + '&s=100'
}

function emptyBook() {
  return { version: 1, updatedAt: new Date().toISOString(), syncedAt: 0, source: 'empty', people: [], groups: [] }
}

export function loadContacts() {
  const raw = readJson(FRIENDS_FILE, null)
  if (!raw || typeof raw !== 'object') return emptyBook()
  return {
    version: 1,
    updatedAt: raw.updatedAt || new Date(0).toISOString(),
    syncedAt: Number(raw.syncedAt) || 0,
    source: raw.source || 'file',
    people: Array.isArray(raw.people) ? raw.people : [],
    groups: Array.isArray(raw.groups) ? raw.groups : []
  }
}

/** 拉 OneBot 好友/群，合并手工字段后落盘。force=false 时 5 分钟内不重复拉。 */
export async function syncContacts({ force = false } = {}) {
  const book = loadContacts()
  if (!force && book.people.length && Date.now() - Number(book.syncedAt || 0) < 5 * 60_000) return book
  const cfg = bridgeConfig()
  const owner = String(cfg.ownerQQ || '').trim()
  const allowPrivate = new Set((cfg.allow && cfg.allow.private || []).map(String))
  let friends = []
  let groups = []
  let error = ''
  try { friends = await onebotAction('get_friend_list') } catch (e) { error = String(e && e.message || e) }
  try { groups = await onebotAction('get_group_list') } catch (e) { error = error || String(e && e.message || e) }

  const oldPeople = new Map(book.people.map((p) => [String(p.uin), p]))
  const oldGroups = new Map(book.groups.map((g) => [String(g.groupId), g]))
  const self = selfQQ()
  const people = friends.filter((f) => {
    const uin = String(f.user_id || f.uin || '')
    return uin && uin !== self && !HIDDEN_FRIEND_UINS.has(uin)
  }).map((f) => {
    const uin = String(f.user_id || f.uin || '')
    const prev = oldPeople.get(uin) || {}
    const type = uin === owner ? 'owner' : (prev.type === 'friend' || prev.type === 'stranger' ? prev.type : (allowPrivate.has(uin) ? 'friend' : 'stranger'))
    return {
      uin,
      nickname: clean(f.nickname || f.card || prev.nickname, 40),
      remark: clean(prev.remark, 40),
      type,
      relation: clean(prev.relation, 40) || DEFAULT_RELATION[type],
      relationNote: clean(prev.relationNote, 200),
      avatar: avatar(uin),
      level: Number(f.level) || 0,
      longNick: clean(f.long_nick, 120),
      source: 'onebot',
      updatedAt: new Date().toISOString()
    }
  }).filter((p) => p.uin)
  const groupList = groups.map((g) => {
    const gid = String(g.group_id || g.groupId || '')
    const prev = oldGroups.get(gid) || {}
    return {
      groupId: gid,
      name: clean(g.group_name || g.name || prev.name, 60),
      remark: clean(prev.remark, 40),
      type: 'group',
      relation: clean(prev.relation, 40) || DEFAULT_RELATION.group,
      relationNote: clean(prev.relationNote, 200),
      memberCount: Number(g.member_count) || 0,
      avatar: 'https://p.qlogo.cn/gh/' + encodeURIComponent(gid) + '/' + encodeURIComponent(gid) + '/100',
      source: 'onebot',
      updatedAt: new Date().toISOString()
    }
  }).filter((g) => g.groupId)

  // 自动登记过的陌生人不在 OneBot 好友列表里，同步时不能把他们删掉（否则她刚认下的人又变陌生）。
  const seen = new Set(people.map((p) => p.uin))
  for (const p of book.people) {
    if (!seen.has(String(p.uin)) && p.source !== 'onebot') people.push(p)
  }
  book.people = people
  book.groups = groupList
  book.syncedAt = Date.now()
  book.updatedAt = new Date().toISOString()
  book.source = error && !people.length ? 'error' : 'onebot'
  atomicWriteJson(FRIENDS_FILE, book)
  if (error) book.error = error
  return book
}

/** 面板保存：只改手动字段，按 uin/groupId 合并；返回 diff 供审计。 */
export function saveContacts(payload, { by = 'panel', source = '' } = {}) {
  const book = loadContacts()
  const peopleIn = Array.isArray(payload && payload.people) ? payload.people : []
  const groupsIn = Array.isArray(payload && payload.groups) ? payload.groups : []
  const owner = ownerQQ()
  const diff = []

  const pMap = new Map(book.people.map((p) => [String(p.uin), p]))
  for (const item of peopleIn) {
    const uin = String(item && item.uin || '').trim()
    const prev = pMap.get(uin)
    if (!prev) continue
    const next = {
      remark: clean(item.remark, 40),
      relation: clean(item.relation, 40) || prev.relation,
      relationNote: clean(item.relationNote, 200)
    }
    if (prev.type !== 'owner' && uin !== owner && item.type && TYPES.has(String(item.type)) && String(item.type) !== 'group') next.type = String(item.type)
    const changed = Object.keys(next).filter((k) => String(prev[k] || '') !== String(next[k] || ''))
    if (!changed.length) continue
    diff.push({ kind: 'person', uin, before: Object.fromEntries(changed.map((k) => [k, prev[k] || ''])), after: Object.fromEntries(changed.map((k) => [k, next[k] || ''])) })
    Object.assign(prev, next, { updatedAt: new Date().toISOString() })
  }

  const gMap = new Map(book.groups.map((g) => [String(g.groupId), g]))
  for (const item of groupsIn) {
    const gid = String(item && (item.groupId || item.uin) || '').trim()
    const prev = gMap.get(gid)
    if (!prev) continue
    const next = { remark: clean(item.remark, 40), relation: clean(item.relation, 40) || prev.relation, relationNote: clean(item.relationNote, 200) }
    const changed = Object.keys(next).filter((k) => String(prev[k] || '') !== String(next[k] || ''))
    if (!changed.length) continue
    diff.push({ kind: 'group', groupId: gid, before: Object.fromEntries(changed.map((k) => [k, prev[k] || ''])), after: Object.fromEntries(changed.map((k) => [k, next[k] || ''])) })
    Object.assign(prev, next, { updatedAt: new Date().toISOString() })
  }

  if (diff.length) {
    book.updatedAt = new Date().toISOString()
    atomicWriteJson(FRIENDS_FILE, book)
    appendAudit('contact-save', { by, source, count: diff.length, diff })
  }
  return { book, diff }
}

/** 第一次打开面板时自动建一份（OneBot 不在线就留空壳，不报错）。 */
export async function ensureContacts() {
  const book = loadContacts()
  if (!book.people.length && !book.groups.length) {
    try { return await syncContacts({ force: true }) } catch { return book }
  }
  if (!Number(book.syncedAt)) {
    syncContacts({ force: false }).catch(() => {})
  }
  return book
}

/** 当前私聊白名单（读桥接配置，归一化成字符串数组）。 */
export function loadAllowPrivate() {
  const cfg = bridgeConfig()
  const list = Array.isArray(cfg.allow && cfg.allow.private) ? cfg.allow.private : []
  return list.map(String)
}

/**
 * 通讯录里一键「加进/移出私聊白名单」。
 * 2026-11-11 主人要求：白名单不要再手填 QQ 号，直接从通讯录里点。
 * 走 lib/access.js 的 saveAccess（它会让桥接 normalizeAllowlist 并内存热更新），
 * 再把 friends.json 里这个人的 type 同步成 friend / stranger，面板显示才一致。
 */
export async function setContactAllow({ uin, allow }, { by = 'panel', source = '' } = {}) {
  const id = String(uin || '').trim()
  if (!/^\d{5,20}$/.test(id)) throw new Error('QQ 号不对：' + id)
  const cfg = bridgeConfig()
  const owner = String(cfg.ownerQQ || '').trim()
  const groups = Array.isArray(cfg.allow && cfg.allow.groups) ? cfg.allow.groups.map(Number) : []
  const deny = {
    users: Array.isArray(cfg.deny && cfg.deny.users) ? cfg.deny.users.map(Number) : [],
    private: Array.isArray(cfg.deny && cfg.deny.private) ? cfg.deny.private.map(Number) : [],
    groups: Array.isArray(cfg.deny && cfg.deny.groups) ? cfg.deny.groups.map(Number) : []
  }
  const cur = loadAllowPrivate()
  const has = cur.includes(id)
  const want = allow !== false
  if (want === has) return { ok: true, changed: false, uin: id, allowPrivate: cur, bridgeWarnings: [] }
  const next = want ? cur.concat([id]) : cur.filter((x) => x !== id)
  const r = await saveAccess({ ownerQQ: owner || null, allow: { private: next, groups }, deny })
  const allowPrivate = (Array.isArray(r.allow && r.allow.private) ? r.allow.private : next).map(String)

  // friends.json 的 type 跟着白名单走（owner 永远不改）
  const book = loadContacts()
  const person = book.people.find((p) => String(p.uin) === id)
  let typeChanged = false
  if (person && person.type !== 'owner') {
    const nextType = want ? 'friend' : 'stranger'
    if (person.type !== nextType) {
      person.type = nextType
      person.updatedAt = new Date().toISOString()
      typeChanged = true
    }
  }
  if (typeChanged) {
    book.updatedAt = new Date().toISOString()
    atomicWriteJson(FRIENDS_FILE, book)
  }
  appendAudit('contact-allow', { by, source, uin: id, allow: want, changed: true })
  return { ok: true, changed: true, uin: id, allow: want, allowPrivate, type: person ? person.type : null, bridgeWarnings: r.warnings || [] }
}
