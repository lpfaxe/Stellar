#!/usr/bin/env node
// 统一入口：node bili.mjs <命令> [参数...]
// 只是把你转到 commands/ 或 verify/ 下的具体脚本，参数原样透传。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const map = {
  // —— 读（不需要写操作，安全） ——
  session: ['verify/session.mjs', '确认凭据属于哪个号'],
  thread: ['verify/thread.mjs', '导出一条评论的完整楼中楼结构'],
  'check-comment': ['verify/comment-exists.mjs', '按 rpid 复核评论是否存在'],
  'check-dynamic': ['verify/dynamic-inspect.mjs', '看动态的结构化内容（类型/图片/节点）'],
  'check-mention': ['verify/mention-check.mjs', '确认动态里的 @ 是不是真提及（查 opus 页）'],
  watch: ['verify/watch-replies.mjs', '盯一条评论的楼中楼等新回复：--aid --root --bvid [--uid 只认某人] [--minutes]'],
  'comment-await': ['commands/comment-await.mjs', '评论版"叫我起床"：廉价进程守「回复我的」，命中即退出叫醒 agent（0 token）：--minutes --interval [--only-owner]'],
  'comment-digest': ['commands/comment-digest.mjs', '今天谁找过人家（回复+@ 两个收件箱汇总，只读）：--hours 24 --pages 2 [--only-unread]'],
  recon: ['verify/dryrun.mjs', '发评论前的侦查：BV→aid + 评论区状态 + WBI 材料'],
  video: ['commands/video-content.mjs', '不点开视频也能还原它讲什么（读文字：简介/字幕/弹幕/评论）'],
  subtitles: ['commands/subtitles.mjs', '拉官方字幕全文（WBI 签名，带时间戳）落盘，只打印前 N 行：<BV> [--lan ai-zh] [--print N] —— 看视频请先 debrief 看目录、问答用 find，别把全文读进上下文'],
  cache: ['commands/cache.mjs', '查看并清理 B站视频缓存（shots/video、covers、subs）'],
  'watch-video': ['commands/bili-watch.mjs', '真"看"视频：取直链 → 下载 → ffmpeg 抽帧拼九宫格 → 交给 read_image：<BV> [3x3|4x4] [--uniform] [--keep-mp4]'],
  debrief: ['commands/debrief.mjs', '看懂一条视频（一条龙）：封面+简介+官方字幕+弹幕热区(对齐字幕)+热评+画面抽帧，并顺手建字幕索引、打印 5 分钟目录：<BV> [--bucket 30] [--top 5] [--grid 3x3] [--no-frames] [--substrip] [--keep-mp4] [--no-outline]'],
  find: ['commands/find.mjs', '按问题查一条视频的字幕（先 debrief 建索引）：<BV> [--q 问题] [--at mm:ss] [--outline] [--limit 3] [--window 75] —— 只回 2~3 段 + 覆盖率，比读字幕全文省一个数量级'],
  feed: ['commands/feed.mjs', '选题器（只读）：按偏好权重分配名额、排除看过的/最近推过的：--n 6 [--per 2] [--pages 3] [--source all] [--json]'],
  my: ['commands/my-bili.mjs', '用主人自己的 B 站账号看（只读）：account / history / favorites / following / updates / recommend [--limit N]'],
  prefs: ['commands/prefs.mjs', '抓取偏好关键词（只读）：scan [--target fish|owner|both] [--sources history,favorites,local] [--limit 24] [--json]'],
  quota: ['commands/quota.mjs', '限额闸（B 档「限额自主」的代码强制部分）：status / check --auto|--share / record / set --daily N / allow <范围>'],
  'fish-guard': ['commands/fish-guard.mjs', '评论区鱼群保护：status / plan / like --bvid BV...（或 --oid <aid>）[--json] [--dry]；抓评论会带登录态，点赞失败原因会落盘'],
  'watch-history': ['commands/watch-history.mjs', '看她看过什么（当前角色）：list [--limit N] [--q 关键词] [--days N] [--json]'],
  likes: ['commands/likes.mjs', '谁赞了她（「收到的赞」通知流，含点赞者 mid/昵称）：--hours 24 [--owner] [--json]'],
  selftest: ['commands/selftest.mjs', '启动测试（装完先跑这个）：配置/凭据/登录态/目录/ffmpeg + 下一步两件事（未分组会话 · 完全权限）'],
  deps: ['commands/deps.mjs', '依赖体检（装完先跑它）：cookie / ffmpeg / Node / 数据目录；--json 给 agent 判断'],
  diary: ['commands/diary.mjs', '她的一天（可见性）：show 人读摘要 / log 记结构化事件 / tail 最近事件'],
  report: ['commands/report.mjs', '给主人的日报（每天一条，主人在控制台看）：digest 今天的素材 / write --text "…" / list / show'],
  notify: ['commands/notify.mjs', '通知分发：把"自主发言后必须报备"落到代码里（后端 stdout/file/webhook/command，由 config.notify 决定）'],
  night: ['commands/whale-night.mjs', '生物钟：plan 掷骰子定今晚 / clock 到点退出叫醒她 / mark 兜底标记 / status 看计划'],
  score: ['commands/score.mjs', '记分（每天动态要用）：score <BV> --score 0-20 / --today / --best'],
  daily: ['commands/daily.mjs', '四类动态各一天一条：--kind best(8:00 最高分视频) / game(12:00 游戏AI二创) / anime(16:00 动漫) / gaming(20:00 游戏区)'],
  'share-dynamic': ['commands/share-dynamic.mjs', '每日分享 → 自己的动态：转发视频卡片 + 分享额度判重 + 与四类动态至少隔 30 分钟（--bvid --text --score --reason --dry|--go）'],
  gamefeed: ['commands/gamefeed.mjs', '候选池：默认给今天轮到的游戏 + AI 二创，已排除看过的/最近 3 天推过的；--for anime / --for gaming 给动漫/游戏区'],
  attack: ['commands/attack.mjs', '疑似被攻击/阴阳怪气的待审队列：add / list / show / approve / reject（批准前不许回 ✗）'],
  search: ['commands/search.mjs', '按关键词搜视频（WBI 签名）：标题/UP/播放/简介/标签'],
  covers: ['diagnostics/fetch-covers.mjs', '抓视频元信息 + 封面图存到 covers/（供看图理解内容）'],
  pool: ['commands/pool.mjs', '今日图片池（看过的封面/图，当天留、跨天清）：list [--json] / add <图> [--caption …] / clear [--all] / prune'],
  whois: ['diagnostics/whois.mjs', '按 mid 查昵称（@ 人前先核准名字）'],
  webimg: ['commands/webimg.mjs', '她自己上网找图（另开目录、每天清空、最多 30 张）：search "关键词" --n 4 / list / del --name <文件> / clear / path'],
  'check-reply': ['verify/verify-reply.mjs', '按 rpid 复核一条回复是不是真的存在'],
  // —— 写（会真的发出去；都必须显式 --dry 或 --go） ——
  'dm-await': ['commands/dm-await.mjs', '私信监听（只认主人；命中打印 DM_HIT）'],
  fav: ['commands/fav.mjs', '收藏（我想留着）：判据强制 · --list / --check / <BV> --reason … --dry|--go'],
  triple: ['commands/triple.mjs', '每日三连（赞+币+藏，只对当天评分最高的那一条）：无参=看计划 / --dry / --go / --status；每天只做一个，做了就拒'],
  dm: ['commands/dm.mjs', '私信（专属通道）：一天 1 条 · 只发主人 · 必须互关（都写死）'],
  say: ['commands/qq-say.mjs', '主动给通讯录里的 QQ 好友发消息（每人 3 条/天 · 全站 12 条 · 同人隔 90 分钟）：--to <昵称或QQ> --text "…" --dry|--go · --list'],
  comment: ['commands/comment.mjs', '发一条视频评论；带 --root/--parent 就是二级回复'],
  'reply-draft': ['commands/reply-draft.mjs', '待审回复（B 档：发前审核）：add 进队列 / list / drop / take'],
  'comment-del': ['commands/comment-del.mjs', '删除自己发的一条评论（x/v2/reply/del，只能删自己的）'],
  dynamic: ['commands/dynamic.mjs', '动态：post / rm / check'],
  'dynamic-image': ['commands/dynamic-image.mjs', '发图文动态（上传图片 + 可带 @节点）'],
  link: ['commands/link.mjs', '主人甩来一个 B 站链接/分享文案：抠出 BV（b23.tv 自动跟跳转）后直接 debrief：<url 或 BV> [--no-frames] [--comments N]'],
  comments: ['commands/comments.mjs', '单看评论区（快，薄）：<BV|av|链接> [--n 30 上限 120] [--sort hot|new] [--replies 3] 每条带点赞/回复数/rpid'],
  douyin: ['commands/douyin.mjs', '主人甩来抖音分享文案/链接：无头浏览器读页面文案/作者/数据/热评（不抽帧）：<url 或分享文案> [--comments N] [--json]'],
  cost: ['commands/cost.mjs', '花钱前先算账（只读）：不带参数=今日账单+价目表；--preset bili-watch / --tokens N --out N --turns N / --chars N [--json]'],
  vlog: ['commands/vlog.mjs', '每日 vlog：plan 看素材 / render 渲染入队 / queue 队列 / publish <id> [--go] / reject / reflect 复盘 / cost 花费 / status'],
  qzone: ['commands/qzone.mjs', 'QQ 空间说说（走 SnowLuma）：profile / post --text … [--image …] [--right 4] --dry|--go / list / feeds / delete --tid <tid> --go'],
  'sticker-tags': ['commands/sticker-tags.mjs', '表情包标签回填 + 按 md5 去重（本地启发式，零费用）：--dry 先看 / --go 写入'],
  'dynamic-edit': ['commands/edit-dynamic.mjs', '编辑已存在的动态（文字/图片都能改，id 不变、评论与点赞保留）：<dyn_id> <文本文件> [--go]'],
  danmaku: ['commands/danmaku.mjs', '直播间弹幕：pre 预检 / send 发送 / history 回读 / live 实时流'],
  await: ['commands/danmaku-await.mjs', '直播间"叫我起床"：出现该回的弹幕就退出，交给 agent 回（质量优先）'],
  // —— 排查 ——
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
  console.log('用法: node bili.mjs <命令> [参数...]\n')
  console.log('命令:')
  for (const [name, [, desc]] of Object.entries(map)) console.log(`  ${name.padEnd(16)} ${desc}`)
  console.log('\n安全约定（脚本里也强制）:')
  console.log('  · 写操作必须显式给 --dry（只打印请求）或 --go（真的发）')
  console.log('  · 先跑 session 确认是哪个号；写操作后一定用 check-*/thread/history 回读复核')
  console.log('  · 一次一条。批量、定时、多房间铺量不是这套工具的用途')
  process.exit(cmd ? 0 : 2)
}
const entry = map[cmd]
if (!entry) {
  console.error(`未知命令: ${cmd}\n跑 "node bili.mjs help" 看清单。`)
  process.exit(2)
}
const r = spawnSync(process.execPath, [path.join(here, entry[0]), ...rest], { stdio: 'inherit' })
process.exit(r.status ?? 1)
