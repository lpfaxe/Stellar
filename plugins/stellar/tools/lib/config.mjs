// 统一配置层 —— 一个文件承载所有"属于使用者"的东西。
//
// 为什么要有它（2026-10-14 外部评审指出的最大架构缺口）：
//   在此之前，"个人化的东西"散在四处、形态还不一样 ——
//     ① `~/.dsh/stellar/bili/quota.json`（额度/白名单，独立文件）
//     ② `~/.dsh/stellar/bili/whale-night.config.json`（作息，独立文件）
//     ③ `whale-diary.md` 的叙事段落（偏好被 feed.mjs 解析 Markdown 提取 ✗ 脆弱）
//     ④ 代码里硬编码（历史昵称 SELF_NAMES ✗）
//   使用者的体验是"我得读源码才知道要改哪" ✗ —— 这不是模板，是作者的自用件。
//   现在：**填一个 `bili.config.json` 就完成自定义** ✓，其余全是中性默认值。
//
// 查找顺序：$STELLAR_BILI_CONFIG → ~/.dsh/stellar/bili.config.json → 内置默认值（中性）
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_BILI_FISH_GUARD } from './fish-guard.mjs'
import { DEFAULT_LIMITS } from './limits.mjs'
// 2026-11-11 主人要的三档运行模式（摸鱼）：数量目标要跟着模式变，
// 但**不能改用户配置文件**（那些数是主人手填的）——所以在读取时叠加，不落盘。
import { currentRunMode, modeLimits } from '../../lib/run-mode.js'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
// 与插件侧 paths.js 同一优先级：显式文件 > DSH_HOME > HOME/.dsh。
// 2026-11-01：这里以前只认 HOME/.dsh，和插件的 DSH_HOME 分叉；
// 自定义 DSH_HOME 的用户在设置页清空前缀，daily 仍读旧文件。
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
export const configPath = process.env.STELLAR_BILI_CONFIG || path.join(DSH_HOME, 'stellar', 'bili.config.json')

/** 中性默认值：不含任何作者的个人信息，换个人也能跑。 */
export const DEFAULTS = {
  persona: {
    name: '<角色名>',
    ownerTitle: '你',      // 助手怎么称呼使用者
    selfClaim: '我',       // 助手怎么自称
    diaryTitle: '今日摘要', // diary show 的标题（想用自己的口吻就改这里）
  },
  preferences: {
    like: ['AI 工具与插件', '鬼畜与怀旧向剪辑', '猫咪', 'Live2D/模型'],
    dislike: ['带货', '擦边', '标题党', '纯搬运'],
    // 每个偏好关键词的权重（0~5；0 = 停用，1 = 默认）。键名就是关键词本身。
    weights: {},
  },
  notify: { type: 'none', url: '', template: 'text', cmd: '', timeoutMutes: [] },   // none | desktop | qq | webhook | command（见 commands/notify.mjs）
  // 沉默逛：只看不说。enabled=false 时禁止评论/回复/搭话/动态/分享/私信，但仍可看/评分/写日记。
  interact: { enabled: true, maxCommentAgeDays: 14 },
  aliases: [],                  // 历史昵称（兜底用；当前昵称仍从 nav 动态读）
  // 使用者本人（分享型评论要 @ 的人）：mid 用于白名单/查询，name 用于正文里的 @昵称
  // （acc/info 查询会风控，所以 name 缓存一份；改过就用 thread 的 `@到:` 验一下）
  owner: { mid: '', name: '' },
  quota: { shareDaily: 3 },
  // 四本账的硬闸门（2026-10-22 从代码搬到配置；设置页可改）。默认值与旧行为一致。
  //   普通评论 / 回找我的人 / 主动搭话 / 动态回复 / 各冷却。
  limits: { ...DEFAULT_LIMITS },
  // 四类动态（2026-10-22 可编辑）：总开关、两条之间的最小间隔、每类的时段/长度/开头。
  //   kinds 里只存"被改过的字段"；缺省值在 tools/lib/kinds.mjs 的 DEFAULT_KINDS。
  dynamics: { enabled: true, gapMin: 30, kinds: {} },
  // QQ 空间说说（2026-11-08 加）：每天 time 点提醒一条；发过就不再提（见 lib/scheduler.js 的 qzonePostedToday）
  // watch/watchMin/watchMaxPerDay（2026-11-08 晚加）：空间互动监看 —— 主人发新说说、
  // 有人评论她的说说时叫醒她（间隔与每日上限），见 lib/scheduler.js 的 qzoneWatchTick
  qzone: { enabled: true, time: '21:30', dailyLimit: 2, weekly: { enabled: true, min: 3 }, watch: true, watchMin: 10, watchMaxPerDay: 6 },
  // 每天一条给主人看的日报（2026-11-08 加）：enabled=true 时到 time 提醒她写，写在控制台里看（commands/report.mjs）
  report: { enabled: true, time: '23:30' },
  // 每日三连（2026-11-10 主人要：每天只对当天评分最高的那一个视频三连）：
  //   到 time 由调度器直接跑 `bili.mjs triple --go`，不唤醒她（固定动作，省 token、更可靠）；
  //   一天只做一条，做过的记在 state/triple.json（见 commands/triple.mjs）。
  triple: { enabled: true, time: '22:30', coin: 1 },
  // 鱼缸小镇（2026-11-21）：接口保留，**默认不启用**（发布版只留接口）。
  //   enabled=false 就完全不醒；fishId 留空 = 用 settings.json 里第一条启用的鱼；
  //   访问码只在 %DSH_HOME%/fishbowl-town/settings.json（这里不存 fbo_*）。
  //   actions=false 时影子会话只读（status/bonds/lobby/recall），visit/play/goto 一律拒（P3 未接）。
  //   dailyBudgetCNY 是硬上限，softBudgetCNY 是「省着花」的软目标（提示词里提醒她别花满）。
  town: { enabled: false, fishId: '', wakesPerDay: 3, window: { start: '09:00', end: '23:00' }, minGapMin: 45, collectMin: 10, actions: false, dailyBudgetCNY: 1, softBudgetCNY: 0.3,
    // 进镇的长轮询（2026-11-21 真机确认）：不挂 /turns 就永远 not_connected，来访/牌局这些事件根本不会产生。
    // wake=true 时有人来找她最多再叫醒 maxWakesPerDay 次（和定时的 3 次分开算）；动作仍然没开。
    turns: { enabled: true, wait: 45, wake: true, maxWakesPerDay: 2, minGapMin: 30 } },
  // 每日 vlog（2026-11-10 主人要：谷期看片后自己做一条 1–10 分钟的视频，配乐+解说，
  //   发主人 B站号，先过控制台审核；花费每日 5 元上限；可整体关掉）。
  //   生成在本机做（SVG+ffmpeg+合成音），钱只来自她写脚本那几轮对话。
  vlog: { enabled: true, window: '12:00-14:00', dailyCostCNY: 5, minSeconds: 60, maxSeconds: 600, tid: 21, autoPublish: false },
  // 2026-10-23 用户定：默认发自己的动态（视频卡片），不再默认评论区 @ 主人。
  share: { enabled: true, via: 'dynamic', minScore: 13, silentAfterDays: 3, decayPerDay: 1 },  // 分享型开关与评分阈值
  // 倾听（2026-10-18 补默认值，与设置页对齐）：评论区 + 直播间
  listen: { comment: true, commentIntervalSec: 300, scope: 'both', oncePerPerson: false, allDay: false, dm: false, live: false, liveRoom: '', liveScope: 'owner' },
  // 作息：windows[] = 每天允许醒来的时段（每个窗口 = 一次机会）；maxWakesPerDay 缺省 = 窗口数（硬上限 3）
  night: { enabled: true, windows: [{ start: '06:00', end: '09:00', wakes: 1 }, { start: '12:00', end: '14:00', wakes: 1 }, { start: '18:00', end: '21:00', wakes: 2 }, { start: '21:00', end: '00:30', wakes: 2 }], skipChance: 0.3, maxVideos: 5, minGapMin: 20, maxWakesPerDay: 6, videoTargetPerDay: 40, weeklyMax: 140, frames: 'none' },
  // 2026-11-10 控制台「她的能力」：新增能力的开关都放这里。
  // 缺省/缺失一律按开处理，升级后行为不变；关掉由调度器、桥接、MCP 各自读。
  capabilities: { todo: true, askOwner: true, shareToFriends: true, qzoneReact: true },
  // 评论区鱼群保护：鱼太多不发新楼层；优先回鱼；给鱼点赞（设置页可改）。
  fishGuard: DEFAULT_BILI_FISH_GUARD,
  // B站 自己的 DSH 会话权限（2026-10-23）：
  //   %USERPROFILE% 在 workspace-write 下会因 WRITE_OWNER 起不了命令，
  //   定时醒来的 she 一条 bili.mjs 都跑不了。默认只给这一个会话完全访问；
  //   想收紧就改成 workspace-write，下一次 tick 生效。
  agent: { sandbox: 'danger-full-access' },
  // B站视频缓存（watch-video / debrief / subtitles 共用）：
  // dir 留空 = <DSH_HOME>/shots；retentionDays=0 不按天清；maxMB=0 不限总大小。
  shots: { dir: '', retentionDays: 7, maxMB: 0 },
}

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

let cache = null
let cacheKey = ''
/**
 * 读取合并后的配置（按文件 mtime/size 缓存）。
 *
 * ⚠️ 2026-10-22：以前是"进程内永久缓存"，长驻的插件宿主改了设置也读不到新值。
 *   现在每次调用先 stat 一下（很便宜）；文件不变就用缓存，变了就重读。
 *   这样调度器/提示词里的额度、四类动态、分享上限都能"改完下一轮生效"。
 */
export function config() {
  let key = 'none'
  try {
    const stat = fs.statSync(configPath)
    key = `${stat.mtimeMs}:${stat.size}`
  } catch { /* 没有用户配置 */ }
  if (cache && key === cacheKey) return cache
  let user = {}
  try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { /* 没配置就用默认 */ }
  cache = merge(DEFAULTS, user)
  cache.__hasUserFile = Object.keys(user).length > 0
  // 模式叠加：摸鱼模式要把「刷多少、醒几次」临时抬上去。写法上是覆盖读取结果，
  // 磁盘上的 bili.config.json 一个字都不动（面板的“她每天做什么”看到的仍是原值）。
  let mode = 'normal'
  try { mode = currentRunMode({ config: user }).mode } catch { /* 读不到状态就按正常模式 */ }
  if (mode !== 'normal' && !process.env.STELLAR_NO_MODE_LIMITS) {
    const lim = modeLimits(mode)
    if (Object.keys(lim).length) {
      cache = merge(cache, { night: { videoTargetPerDay: lim.videoTargetPerDay, maxWakesPerDay: lim.maxWakesPerDay, minGapMin: lim.minGapMin }, qzone: { public: { seenTarget: lim.qzonePublicSeen } } })
    }
  }
  cache.__runMode = mode
  cacheKey = key + '|' + mode
  return cache
}
