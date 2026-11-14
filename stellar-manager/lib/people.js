/* 通讯录索引：把 friends.json 变成按 QQ/群号查名字的小工具。
 * 只读、无缓存（文件很小）；面板每个请求最多读一两次，避免与通讯录保存抢锁。 */
import { FRIENDS_FILE } from './paths.js'
import { readJson } from './util.js'

export function contactIndex() {
  const raw = readJson(FRIENDS_FILE, null) || {}
  const people = Array.isArray(raw.people) ? raw.people : []
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  const byUin = new Map()
  for (const p of people) {
    const uin = String(p.uin || p.userId || '').trim()
    if (!uin) continue
    byUin.set(uin, {
      uin,
      name: String(p.remark || p.nickname || uin).trim(),
      nickname: String(p.nickname || '').trim(),
      remark: String(p.remark || '').trim(),
      relation: String(p.relation || '').trim(),
      relationNote: String(p.relationNote || '').trim(),
      type: String(p.type || 'stranger'),
      avatar: String(p.avatar || ''),
    })
  }
  const byGroup = new Map()
  for (const g of groups) {
    const gid = String(g.groupId || g.group_id || g.uin || '').trim()
    if (!gid) continue
    byGroup.set(gid, {
      gid,
      name: String(g.name || g.groupName || gid).trim(),
      relation: String(g.relation || '群').trim(),
    })
  }
  return { byUin, byGroup, updatedAt: raw.updatedAt || '' }
}

export function personOf(index, uin) {
  return (index && index.byUin.get(String(uin || ''))) || null
}

export function groupOf(index, gid) {
  return (index && index.byGroup.get(String(gid || ''))) || null
}

function fallbackName(uin) {
  return uin ? 'QQ ' + uin : '未登记'
}

/** 会话 key → 给人看的名字：private:<uin> / owner:<uin> / group:<gid> / user:<uin>。 */
export function nameForKey(index, key) {
  const k = String(key || '')
  if (!k) return '未归属'
  if (k.startsWith('private:')) {
    const uin = k.slice(8)
    const p = personOf(index, uin)
    return p && p.name ? p.name : fallbackName(uin)
  }
  if (k.startsWith('owner:')) {
    const uin = k.slice(6)
    const p = personOf(index, uin)
    return (p && p.name ? p.name : fallbackName(uin)) + '（主人）'
  }
  if (k.startsWith('group:')) {
    const gid = k.slice(6)
    const g = groupOf(index, gid)
    return '群 ' + (g && g.name ? g.name : gid)
  }
  if (k.startsWith('user:')) return nameForKey(index, 'private:' + k.slice(5))
  return k
}

export function labelForKey(index, key) {
  const k = String(key || '')
  if (k.startsWith('private:')) return '私聊 ' + nameForKey(index, k)
  if (k.startsWith('owner:')) return '主人 ' + nameForKey(index, k)
  if (k.startsWith('group:')) return nameForKey(index, k)
  if (k.startsWith('user:')) return '用户 ' + nameForKey(index, k)
  return k || '未归属'
}

export function relationFor(index, key) {
  const k = String(key || '')
  if (k.startsWith('private:') || k.startsWith('owner:') || k.startsWith('user:')) {
    const p = personOf(index, k.replace(/^(private|owner|user):/, ''))
    return p ? (p.relation || (p.type === 'owner' ? '主人' : '')) : ''
  }
  if (k.startsWith('group:')) {
    const g = groupOf(index, k.slice(6))
    return g ? (g.relation || '群') : '群'
  }
  return ''
}
