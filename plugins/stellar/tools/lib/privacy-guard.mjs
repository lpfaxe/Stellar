/**
 * 隐私守门：出站文本（视频脚本、说说、动态、评论、私聊）在离开这台机器之前过一遍。
 *
 * 为什么放在工具层而不是只写进人设：人设是「请她别说」，这里是「说了也发不出去」。
 * 2026-11-10 的教训是介绍片第 5 幕把主人的生日和城市当示例数据写了进去，人设没拦住，
 * 因为那压根不是她「说」出来的，是脚本里直接渲染的。
 */
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const CONFIG_FILE = path.join(HOME, 'stellar', 'bili.config.json')
const FRIENDS_FILE = path.join(HOME, 'stellar', 'state', 'friends.json')

/** 主人自己的固定信息：一旦出现在公开场合就是泄露。 */
const OWNER_PATTERNS = [
  { re: /(?:生日|出生)[^\n。，]{0,8}?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g, why: '主人的生日' },
  { re: /\b\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, why: '具体日期（可能对应主人生日）' },
  { re: /(?:安徽|宣城|合肥|芜湖|蚌埠|阜阳)/g, why: '主人所在地区' },
  { re: /(?:住在|家住|老家在|户籍)[^\n。，]{0,12}/g, why: '住址描述' },
  { re: /\b1[3-9]\d{9}\b/g, why: '手机号' },
  { re: /\b\d{17}[\dXx]\b/g, why: '身份证号' },
]

/** 从配置里补：owner.name / realName / nickname 之类的真名不许出现在公开文本里。 */
function configTerms() {
  const out = []
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    const owner = cfg.owner || {}
    for (const v of [owner.name, owner.realName, owner.nickname]) {
      const s = String(v || '').trim()
      if (s.length >= 2) out.push({ re: new RegExp(s.replace(/[.*+?^${()|[\]\\]/g, '\\$&'), 'g'), why: '主人的真名/昵称' })
    }
  } catch {}
  return out
}

/**
 * 通讯录里其他人的身份信息：别人的 QQ 号、备注名、关系描述。
 * 这些一旦出现在公开场合（视频、说说、评论区）就是出卖朋友；私聊第三方时同样不该出现。
 */
function contactsTerms() {
  const out = []
  try {
    const raw = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'))
    const people = Array.isArray(raw) ? raw : (Array.isArray(raw.people) ? raw.people : [])
    for (const p of people) {
      const uin = String(p.uin || p.user_id || p.qq || '').trim()
      const names = [p.remark, p.nickname, p.name]
        .map((v) => String(v || '').trim())
        .filter((v) => v.length >= 2)
      if (!uin && !names.length) continue
      out.push({ uin, names, relation: String(p.relationNote || '').trim() })
    }
  } catch {}
  return out
}

/**
 * 检查一段文本。
 * @param {string} text
 * @param {{audience?: 'public'|'private'|'owner', allowPeople?: string[]}} opts
 *   audience=owner 表示只发给主人本人（此时不拦）；public 是视频/说说/动态/评论/群聊。
 * @returns {{ok: boolean, hits: Array<{why: string, text: string}>}}
 */
export function checkPrivacy(text, opts = {}) {
  const s = String(text || '')
  if (!s) return { ok: true, hits: [] }
  if (opts.audience === 'owner') return { ok: true, hits: [] }
  const hits = []
  for (const p of [...OWNER_PATTERNS, ...configTerms()]) {
    p.re.lastIndex = 0
    for (const m of s.matchAll(p.re)) {
      const got = String(m[0] || '').trim()
      if (!got) continue
      if (Array.isArray(opts.allowPeople) && opts.allowPeople.includes(got)) continue
      hits.push({ why: p.why, text: got.slice(0, 40) })
    }
  }
  // 通讯录：别人的 QQ 号到哪都不能随便报；别人的名字/关系只在公开内容（视频/说说/评论）里拦，
  // 私聊时提一句「我今天跟好友B聊天」不算泄密，拦了反而像审囚。
  const selfUin = String(opts.selfUin || '')
  const allow = new Set([selfUin, ...(Array.isArray(opts.allowPeople) ? opts.allowPeople : [])].filter(Boolean))
  for (const c of contactsTerms()) {
    if (!c.uin || allow.has(c.uin)) continue
    if (c.uin.length >= 5 && s.includes(c.uin)) {
      hits.push({ why: '通讯录里其他人的 QQ 号', text: c.uin })
      continue
    }
    if (opts.audience === 'public') {
      for (const n of c.names) {
        if (s.includes(n)) { hits.push({ why: '通讯录里其他人的名字/备注', text: n }); break }
      }
    }
  }
  return { ok: hits.length === 0, hits }
}

/** 给模型看的拒绝话术：不解释得太细，避免它学会绕过。 */
export function privacyRejectText(hits) {
  const all = hits || []
  const kinds = [...new Set(all.map((h) => h.why))].slice(0, 3).join('、')
  const onlyOthers = all.length > 0 && all.every((h) => String(h.why).startsWith('通讯录'))
  const head = onlyOthers
    ? '这段内容里带着通讯录里别人的信息（'
    : '这段内容里有主人的私人信息（'
  return head + (kinds || '敏感信息') + '），不能发出去。换个说法：只说感受和事，不要写他的生日、城市、住址、电话，也不要贴别人的 QQ 号。'
}

/**
 * 发布前守卫：命中就抛错，调用方直接失败即可（不要「自动打码后照发」——
 * 打码后的句子在视频里更奇怪，而且我们无法判断上下文是否已经绕过了检查）。
 */
export function guardPublish(text, opts = {}) {
  const r = checkPrivacy(text, opts)
  if (!r.ok) throw new Error(privacyRejectText(r.hits))
  return r
}

/** 视频脚本：把标题/简介/标签/所有场景文本拼成一段一起查。 */
export function checkScriptPrivacy(script) {
  if (!script || typeof script !== 'object') return { ok: true, hits: [] }
  const parts = [String(script.title || ''), String(script.desc || ''), (script.tags || []).join(' ')]
  for (const sc of script.scenes || []) {
    parts.push(String(sc.title || ''), String(sc.text || ''), String(sc.sub || ''), ...(Array.isArray(sc.items) ? sc.items : []))
  }
  return checkPrivacy(parts.join('\n'), { audience: 'public' })
}

/** 视频脚本的抛错版：plan/render/publish 三处都调它。 */
export function guardScript(script) {
  const r = checkScriptPrivacy(script)
  if (!r.ok) throw new Error(privacyRejectText(r.hits))
  return r
}
