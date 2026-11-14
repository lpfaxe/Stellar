// 每日三连（2026-11-10 加，主人要求：每天只对当天评分最高的那一条三连，仅一个）
//
// 为什么单独一个命令：三连是三个写动作（赞 / 币 / 藏），散在 three 个工具里迟早会
//   出现"赞了没投币"这种半拉子状态；而且"每天只一个"是硬约束，得有个地方记账。
//
// 用法:
//   node bili.mjs triple                 # 看今天该三连谁（只读，默认取当天最高分）
//   node bili.mjs triple --dry            # 打印将要发的三个请求，不写
//   node bili.mjs triple --go             # 真的三连（今天已做过就拒）
//   node bili.mjs triple --bv BV1xx --go  # 指定视频（仍受"每天一个"约束）
//   node bili.mjs triple --status         # 看今天做没做、昨天做的谁
//   node bili.mjs triple --force --go     # 破"每天一个"（换号/补做时用）
//
// 三条安全线（代码强制）：
//   ① 必须显式 --dry 或 --go，不给就只打印计划
//   ② 每天只允许一条；已做过再跑 → 直接退出，不覆盖记录
//   ③ 先查三态（已赞/已投币/已收藏），已经是三连的视频不会重复消耗硬币
import { accountBili, biliState } from '../lib/state-paths.mjs'
import { bestToday, todayScores } from '../lib/scores.mjs'
import fs from 'node:fs'
import path from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const LOG = biliState('triple.json')
const today = () => new Date().toLocaleDateString('sv-SE')
const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh', 'stellar', 'bili.config.json'), 'utf8'))

const argv = process.argv.slice(2)
const opt = {}
const pos = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) opt[a.slice(2)] = true
    else { opt[a.slice(2)] = v; i += 1 }
  } else pos.push(a)
}
const DRY = !!opt.dry
const GO = !!opt.go
const FORCE = !!opt.force
const NO_FAV = !!opt['no-fav']
const COIN = Math.max(1, Math.min(2, Number(opt.coin ?? 1) || 1))

const loadLog = () => { try { return JSON.parse(fs.readFileSync(LOG, 'utf8')) } catch { return { days: {} } } }
const saveLog = (d) => {
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  const days = d.days ?? {}
  const keep = Object.keys(days).sort().slice(-30)
  const out = {}
  for (const k of keep) out[k] = days[k]
  fs.writeFileSync(LOG, JSON.stringify({ days: out }, null, 2) + '\n')
}

// ── --status ────────────────────────────────────────────
if (opt.status) {
  const d = loadLog().days ?? {}
  const t = d[today()]
  if (t) {
    console.log(t.done
      ? '今天已经三连过了：' + t.bv + '（' + (t.title ?? '') + '）'
      : '今天有一条没做完的记录：' + t.bv)
    console.log('  赞 ' + (t.like ? '✓' : '✗') + ' · 币 ' + (t.coin ? '✓' : '✗') + ' · 藏 ' + (t.fav ? '✓' : '✗') + ' · ' + (t.at ?? ''))
  } else console.log('今天还没三连。')
  const days = Object.keys(d).sort().slice(-3)
  for (const k of days) { const x = d[k]; console.log('  ' + k + '  ' + x.bv + '  ' + (x.title ?? '').slice(0, 34)) }
  process.exit(0)
}

// ── 选视频：命令行 > 当天最高分 ─────────────────────────
let bv = String(opt.bv ?? pos[0] ?? '').trim()
let pick = null
if (!bv) {
  pick = bestToday()
  if (!pick) {
    console.error('今天还没有评分记录 —— 先 node bili.mjs score <BV> --score N，或者用 --bv 指定')
    process.exit(1)
  }
  bv = pick.bv
}
if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) { console.error('用法: triple [--bv BV…] [--dry|--go] [--status]'); process.exit(2) }

const log = loadLog()
const doneToday = log.days?.[today()]
if (doneToday && doneToday.done && doneToday.bv !== bv && !FORCE) {
  console.error('今天已经三连过 ' + doneToday.bv + ' 了（每天只一个）。要换这条就加 --force')
  process.exit(3)
}
if (doneToday && doneToday.done && doneToday.bv === bv) {
  console.log('今天这条已经三连过了（' + bv + '），不用再做。')
  process.exit(0)
}

// ── 凭据 + 三态预检（只读）──────────────────────────────
const cred = JSON.parse(fs.readFileSync(accountBili('credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  cookie: 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + (cred.buvid3 ?? ''),
}
const jget = async (url) => {
  const r = await fetch(url, { headers: H })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 0) throw new Error('code=' + j.code + ' ' + (j.message ?? url))
  return j.data
}
const jpost = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, code: j.code, message: j.message, data: j.data }
}

const info = await jget('https://api.bilibili.com/x/web-interface/view?bvid=' + bv)
const aid = info.aid
const title = String(info.title ?? '')
const up = String(info.owner?.name ?? '')
const score = pick?.score ?? null

const [liked, coins, fav] = await Promise.all([
  jget('https://api.bilibili.com/x/web-interface/archive/has/like?aid=' + aid).then((v) => Number(v) === 1).catch(() => null),
  jget('https://api.bilibili.com/x/web-interface/archive/coins?aid=' + aid).then((v) => Number(v.multiply ?? 0) > 0).catch(() => null),
  NO_FAV ? Promise.resolve(false) : jget('https://api.bilibili.com/x/v2/fav/video/favoured?aid=' + aid).then((v) => v.favoured === true).catch(() => null),
])

const mark = (v) => (v === null ? '未知' : v ? '已做' : '未做')
console.log('[triple] ' + bv + '  「' + title.slice(0, 46) + '」  @' + up)
if (score !== null) console.log('  今天的最高分：' + score + '/20' + (pick?.reason ? '  · ' + pick.reason : ''))
console.log('  当前状态：赞 ' + mark(liked) + ' · 币 ' + mark(coins) + ' · 藏 ' + mark(fav) + '（每天只做这一条）')

const needLike = liked !== true
const needCoin = coins !== true
const needFav = !NO_FAV && fav !== true
if (!needLike && !needCoin && !needFav) {
  console.log('  ✓ 这条早就三连过了，不用再做')
  log.days[today()] = { bv, aid, title, score, like: true, coin: true, fav: !NO_FAV, done: true, skipped: 'already', at: new Date().toISOString() }
  saveLog(log)
  process.exit(0)
}

console.log('  将要做：' + [needLike ? '点赞' : '', needCoin ? '投 ' + COIN + ' 币' : '', needFav ? '收藏' : ''].filter(Boolean).join(' + '))

if (!DRY && !GO) {
  console.log('\n（只是计划；确认无误后加 --go 真做，或 --dry 看请求明细）')
  process.exit(0)
}

if (DRY) {
  if (needLike) console.log('  [dry] POST /x/web-interface/archive/like  aid=' + aid + ' like=1')
  if (needCoin) console.log('  [dry] POST /x/web-interface/coin/add         aid=' + aid + ' multiply=' + COIN + ' select_like=1')
  if (needFav) console.log('  [dry] POST /x/v3/fav/resource/deal          rid=' + aid + ' type=2 → 默认收藏夹')
  console.log('  [dry] 未写入 ✓')
  process.exit(0)
}

// ── 真做：赞 → 币 → 藏（币放中间，因为投币会顺带点赞）────────
const result = { bv, aid, title, score, like: liked === true, coin: coins === true, fav: !NO_FAV && fav === true, at: new Date().toISOString() }
const csrf = String(cred.bili_jct ?? '')
let failed = null

if (needLike && !needCoin) {
  const r = await jpost('https://api.bilibili.com/x/web-interface/archive/like', { aid, like: 1, csrf })
  if (r.code === 0) { result.like = true; console.log('  ✓ 点赞') }
  else { failed = '点赞失败：code=' + r.code + ' ' + (r.message ?? ''); console.log('  ✗ ' + failed) }
}

if (needCoin) {
  const r = await jpost('https://api.bilibili.com/x/web-interface/coin/add', { aid, multiply: COIN, select_like: 1, csrf, cross_domain: 'true' })
  if (r.code === 0) {
    result.coin = true
    result.like = true // select_like=1 会顺带点赞
    console.log('  ✓ 投币 ×' + COIN + '（顺带点赞）')
  } else { failed = '投币失败：code=' + r.code + ' ' + (r.message ?? ''); console.log('  ✗ ' + failed) }
} else if (needLike) {
  // 已经投过币但没赞：单独补赞
  const r = await jpost('https://api.bilibili.com/x/web-interface/archive/like', { aid, like: 1, csrf })
  if (r.code === 0) { result.like = true; console.log('  ✓ 点赞') }
  else { failed = '点赞失败：code=' + r.code + ' ' + (r.message ?? ''); console.log('  ✗ ' + failed) }
}

if (needFav && !failed) {
  try {
    const fl = await jget('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + String(cfg.self?.mid ?? cred.mid ?? ''))
    const list = fl.list ?? []
    const folder = list.find((f) => /默认/.test(f.title)) ?? list[0]
    if (!folder) throw new Error('这个号还没有收藏夹')
    const r = await jpost('https://api.bilibili.com/x/v3/fav/resource/deal', {
      rid: aid, type: '2', add_media_ids: String(folder.id), del_media_ids: '', csrf,
    })
    if (r.code === 0) { result.fav = true; console.log('  ✓ 已收藏到「' + folder.title + '」') }
    else { failed = '收藏失败：code=' + r.code + ' ' + (r.message ?? ''); console.log('  ✗ ' + failed) }
  } catch (e) { failed = '收藏失败：' + e.message; console.log('  ✗ ' + failed) }
}

result.done = result.like && result.coin && (NO_FAV || result.fav)
result.failed = failed ?? ''
log.days[today()] = result
saveLog(log)

if (opt.json) console.log(JSON.stringify(result))
if (result.done) console.log('\n✓ 三连完成：' + bv + '（今天这一条就它了）')
else { console.log('\n✗ 没有全部完成：' + (failed ?? '有动作没成功')); process.exitCode = 4 }
