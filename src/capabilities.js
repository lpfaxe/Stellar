// 她的能力表 —— 控制台、调度器、桥接、MCP 共用同一份定义。
//
// 为什么单独一个文件：面板上每个开关必须真的对应一处运行期判断，
// 否则就是装饰。定义只写"叫什么、改哪个配置路径、关掉会怎样"，
// 读取统一走 tools/lib/config.mjs 的 mtime 缓存（改完下一轮就生效）。
import { config } from '../plugins/stellar/tools/lib/config.mjs'

export const CAPABILITY_DEFS = [
  {
    id: 'todo',
    group: '聊天助手',
    name: '待办提醒',
    path: 'capabilities.todo',
    desc: '主人说「后天提醒我买东西」时记下来，到点叫醒她再提醒主人。',
    effect: '关掉后不再到点叫醒，已经记下的待办会保留。',
  },
  {
    id: 'askOwner',
    group: '聊天助手',
    name: '替人问主人',
    path: 'capabilities.askOwner',
    desc: '别人问到只有主人能拍板的事，她把问题转给主人，再把答案带回去。',
    effect: '关掉后她只能说自己做不了主，不能把问题转给你。',
  },
  {
    id: 'shareToFriends',
    group: '聊天助手',
    name: '主动分享给好友',
    path: 'capabilities.shareToFriends',
    desc: '遇到有意思的事，她可以主动分享给通讯录里的好友（一天最多 3 次）。',
    effect: '关掉后「主动分享」工具直接拒绝，不会再打扰你的朋友。',
  },
  {
    id: 'qzonePost',
    group: 'QQ空间',
    name: '发说说提醒',
    path: 'qzone.enabled',
    desc: '每周至少发几条说说，到点提醒她自己写；发过就不再催。',
    effect: '关掉后不再自动提醒；你仍可以在「她」页手动发布。',
  },
  {
    id: 'qzoneWatch',
    group: 'QQ空间',
    name: '空间互动监看',
    path: 'qzone.watch',
    desc: '盯着你的新说说和评论她的人，有动静就叫醒她回。',
    effect: '关掉后不再主动查看空间动静。',
  },
  {
    id: 'qzoneReact',
    group: 'QQ空间',
    name: '自动点赞 / 评论',
    path: 'capabilities.qzoneReact',
    desc: '她可以在你或她自己的说说下面点赞、回评论（评论仍要先演练/审批）。',
    effect: '关掉后点赞和评论工具直接拒绝，看说说不受影响。',
  },
  {
    id: 'biliNight',
    group: 'B站 · 刷与发',
    name: '刷视频（生物钟）',
    path: 'night.enabled',
    desc: '按生物钟窗口随机醒来，刷视频、看评论、记日记。',
    effect: '关掉后不再自动醒来刷视频；手动发来的视频链接仍可看。',
  },
  {
    id: 'biliDynamic',
    group: 'B站 · 刷与发',
    name: '发 B站动态',
    path: 'dynamics.enabled',
    desc: '看完视频到点提醒她发一条动态，按四类（游戏/动画/生活…）轮换。',
    effect: '关掉后不再提醒发动态。',
  },
  {
    id: 'biliComment',
    group: 'B站 · 互动',
    name: '自动评论 / 回复',
    path: 'interact.enabled',
    desc: '回评论她的人、主动搭话、给鱼群点赞；仍受每日额度和冷却限制。',
    effect: '关掉后自动评论、回复、搭话全部暂停（手动评论不受影响）。',
  },
  {
    id: 'biliShare',
    group: 'B站 · 互动',
    name: '视频分享',
    path: 'share.enabled',
    desc: '看到高分视频，按设置分享成动态或转到群里。',
    effect: '关掉后不再自动分享视频。',
  },
  {
    id: 'biliReport',
    group: 'B站 · 刷与发',
    name: '看后日报',
    path: 'report.enabled',
    desc: '每天到点提醒她写一份给主人看的日报，放在控制台「她的日报」里。',
    effect: '关掉后不再提醒写日报，历史日报仍可查看。',
  },
  {
    id: 'biliFish',
    group: 'B站 · 互动',
    name: '鱼群保护',
    path: 'fishGuard.enabled',
    desc: '评论区被同一批人刷屏时，优先回鱼、给鱼点赞，不另开新楼层。',
    effect: '关掉后按普通评论策略处理，不做鱼群聚拢。',
  },
  {
    id: 'biliTriple',
    group: 'B站 · 互动',
    name: '每日三连',
    path: 'triple.enabled',
    desc: '每天挑当天评分最高的那条视频，点赞 + 投一枚币 + 收藏，一天只做这一个。',
    effect: '关掉后不再自动三连；想补做就手动跑 node bili.mjs triple --go。',
  },
  {
    id: 'biliVlog',
    group: 'B站 · 刷与发',
    name: '每日 vlog',
    path: 'vlog.enabled',
    desc: '谷期看完视频后，自己做一条 1–10 分钟的视频（配乐+解说），交你审核后再发到 B站。',
    effect: '关掉后当天不再生成；已经做好的还在控制台等你审核，历史成片不受影响。',
  },
  {
    id: 'town',
    group: '鱼缸小镇',
    name: '小镇日常',
    path: 'town.enabled',
    desc: '每天几次去小镇过自己的日子：看看谁来串门、要不要坐下打一局、出门逛逛（默认只读，动作要另外打开）。',
    effect: '关掉后不再进镇（长轮询断开）、不再采集近况、也不再唤醒；已经记下的会按 3 天自然过期，钱一分不花。',
  },
  {
    id: 'biliListen',
    group: 'B站 · 互动',
    name: '评论区倾听',
    path: 'listen.comment',
    desc: '定时看她收到的回复和 @，有人找她就叫醒她。',
    effect: '关掉后不再主动扫评论区消息。',
  },
]

export const CAPABILITY_BY_ID = new Map(CAPABILITY_DEFS.map((d) => [d.id, d]))

function getPath(obj, dotted) {
  let cur = obj
  for (const key of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

/** 配置里没写这个键时按默认开处理（升级后行为不变）。 */
export function capabilityEnabled(id) {
  const def = CAPABILITY_BY_ID.get(String(id))
  if (!def) return true
  let value
  try { value = getPath(config(), def.path) } catch { value = undefined }
  if (value === undefined || value === null) return true
  return value !== false
}

export function capabilityValue(id) {
  const def = CAPABILITY_BY_ID.get(String(id))
  if (!def) return undefined
  try { return getPath(config(), def.path) } catch { return undefined }
}

/** 面板用：按组返回当前值。 */
export function listCapabilities() {
  const groups = []
  const byGroup = new Map()
  for (const def of CAPABILITY_DEFS) {
    let g = byGroup.get(def.group)
    if (!g) {
      g = { name: def.group, items: [] }
      byGroup.set(def.group, g)
      groups.push(g)
    }
    g.items.push({
      id: def.id,
      name: def.name,
      desc: def.desc,
      effect: def.effect,
      path: def.path,
      enabled: capabilityEnabled(def.id),
      configured: capabilityValue(def.id) !== undefined,
    })
  }
  return groups
}

export function setCapabilityPath(cfg, id, enabled) {
  const def = CAPABILITY_BY_ID.get(String(id))
  if (!def) throw new Error('未知能力：' + id)
  const parts = String(def.path).split('.')
  let cur = cfg
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]
    if (!cur[key] || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {}
    cur = cur[key]
  }
  cur[parts[parts.length - 1]] = enabled === true
  return cfg
}