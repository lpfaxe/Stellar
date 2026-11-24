// QQ 空间：发说说、看说说（自己的/主人的/好友动态）、点赞、评论/回复评论。
// 走 SnowLuma 的 OneBot HTTP，不碰 Cookie/协议。
//
//   node bili.mjs qzone profile
//   node bili.mjs qzone post    --text "..." [--image a.png] [--right 1|4|16|64|128] [--targets 123,456] --dry|--go
//   node bili.mjs qzone read    [--scope mine|owner|friends] [--num 10] [--json]
//   node bili.mjs qzone detail  --tid <tid> [--uin <QQ>] [--num 20]
//   node bili.mjs qzone card    --tid <说说 id> | --url <链接>   # 读一张转发的空间卡片（2026-11-24）
//       卡片里的链接是 mqqapi://qzoneschema/?schema=<base64>，里面的 cellid 就是 tid；
//       走 get_qzone_feed_detail（不是 detail 用的 get_qzone_msg_detail —— 那是另一套 id）。
//   node bili.mjs qzone comment-media --tid <tid>      # 下载评论区里的图（JSON，给 MCP 附图用）
//   node bili.mjs qzone like    --tid <tid> [--uin <QQ>] [--time <ts>] --dry|--go
//   node bili.mjs qzone unlike  --tid <tid> [--uin <QQ>] [--time <ts>] --dry|--go
//   node bili.mjs qzone comment --tid <tid> --text "..." [--uin <QQ>] [--cid <评论id> --cuin <QQ>] [--ruin <QQ> --rname <名字>] --dry|--go
//   node bili.mjs qzone comments --tid <tid>            # 列评论（带 #id，★= 自己发的）
//   node bili.mjs qzone uncomment --tid <tid> --comment <#id> --dry|--go
//   node bili.mjs qzone uncomment --tid <tid> --reply <#id> --parent <父评论#id> --dry|--go
//   node bili.mjs qzone delete  --tid <tid> --go
//   node bili.mjs qzone public list  [--n 10] [--images 1] [--json]     # 好友爱看/推荐流
//   node bili.mjs qzone public media --id <动态id>                      # 下载这条动态的图（JSON）
//   node bili.mjs qzone public like   --id <动态id> --dry|--go
//   node bili.mjs qzone public unlike --id <动态id> --dry|--go
//   node bili.mjs qzone public comment --id <动态id> --text "..." --dry|--go
//   node bili.mjs qzone public batch --likes "3,5" --comments "7=这句真准; 2=猫怎么这么胖" --dry|--go
//        （一条命令做完这一轮的赞+评：以前一条一调用，6 次模型往返压成 1 次）
//   node bili.mjs qzone public score  --scores "1=7,2=3,3=8"          # 打分（面板「今天刷的动态」显示）
//   node bili.mjs qzone public score  --id <动态id> --score 7 --note "猫太胖了"
//   node bili.mjs qzone public today  [--json]                        # 今天刷过/赞过/评过什么（面板同款数据）
//
// 与 B站动态的区别：这是她**自己的 QQ 号**的说说，权限默认 4=好友可见（1=所有人）。
// 写操作一律要 --dry（只打印）或 --go（真做）；说说的每天条数上限是 qzone.dailyLimit（默认 3），
// 点赞/评论不占这个额度，但会写进同一个账本（kind=like / comment）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ffmpegPath } from '../lib/ffmpeg.mjs'
import { checkPrivacy, privacyRejectText } from '../lib/privacy-guard.mjs'
import { feedCardText, mediaImageUrls, qzoneIdsFromUrl } from '../../../../src/qq-card.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')          // stellar 仓库根
const CFG_FILE = path.join(ROOT, 'config.json')
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
// 与插件调度器（lib/scheduler.js 的 qzonePostedToday）共用同一个账本
const STATE_DIR = path.join(DSH_HOME, 'stellar', 'state')
const LOG_FILE = path.join(STATE_DIR, 'qzone-log.jsonl')
const RIGHTS = new Set([1, 4, 16, 64, 128])
const RIGHT_LABEL = { 1: '所有人可见', 4: '好友可见', 16: '部分好友可见', 64: '仅自己可见', 128: '部分好友不可见' }

function readJson(file, fallback = {}) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

const cfg = readJson(CFG_FILE, {})
const qz = cfg.qzone ?? {}
const ownerQQ = Number(cfg.ownerQQ ?? 0)

const argv = process.argv.slice(2)
const sub = (argv[0] ?? 'profile').toLowerCase()
const args = new Map()
const images = []
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--image') { images.push(argv[i + 1]); i += 1; continue }
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const val = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
    args.set(key, val)
  }
}
const isDry = args.has('dry')
const isGo = args.has('go')
// --json：只输出结构化 JSON（含把图片下载到本地临时目录后的路径），给 MCP 工具读图用
const JSON_OUT = args.has('json')
const num = Number(args.get('num') ?? 10)
const right = Number(args.get('right') ?? qz.defaultRight ?? 4)
const targets = String(args.get('targets') ?? '').split(',').map((s) => s.trim()).filter(Boolean)

function oneBot() {
  const base = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const token = String(cfg.snowluma?.accessToken ?? '')
  return { base, token }
}

async function call(action, body = {}) {
  const { base, token } = oneBot()
  if (!token) throw new Error('config.json 的 snowluma.accessToken 为空（Settings → Stellar → SnowLuma 里拿）')
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  if (!json) throw new Error(`${action} 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 300)}`)
  if (json.status === 'failed' || json.retcode !== 0) {
    throw new Error(`${action} 失败（retcode=${json.retcode}）: ${json.wording ?? json.message ?? text.slice(0, 300)}`)
  }
  return json.data ?? null
}

// 只数"发说说"，点赞/评论不占每日额度
function todayCount() {
  try {
    const day = new Date().toLocaleDateString('sv-SE')      // YYYY-MM-DD，本地时区
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n')
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((e) => e && e.kind === 'post' && String(e.at ?? '').startsWith(day)).length
  } catch {
    return 0
  }
}

function logWrite(entry) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
}

function toFileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/')
  return 'file:///' + abs.replace(/^\//, '').replace(/ /g, '%20')
}

function needGo() {
  if (isDry === isGo) {
    console.error('必须且只能给一个 --dry 或 --go')
    process.exit(2)
  }
}

function fmtTime(ts) {
  const n = Number(ts)
  if (!n) return '?'
  return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false })
}

// QQ 空间正文里夹着 [em]e400181[/em] 这种表情占位符。原样吐出来她读到的是
// 一串乱码，看图/评论文本时很容易被它带偏；换成「[表情]」更接近人眼看到的。
function cleanQzoneText(text) {
  return String(text ?? '')
    .replace(/\[em\]e\d+\[\/em\]/gi, '[表情]')
    .replace(/\[em\][^\[\]]*\[\/em\]/gi, '[表情]')
}

function oneLine(text, max = 80) {
  return cleanQzoneText(text).replace(/\s*\n+\s*/g, ' / ').slice(0, max)
}

// ── 图片：把说说/动态里的图下载到本地临时目录，给 MCP 读图用 ────────────────
// 同 lib/image-fetch.mjs：宿主把 TEMP/TMP 剥掉时 os.tmpdir() 会给出 'undefined\\temp'，
// 那样图会落到 cwd/undefined/temp；这里兜一层，拿不到绝对路径就退到 TEMP/TMP/系统临时目录。
function mediaTmpRoot() {
  let d = ''
  try { d = os.tmpdir() } catch {}
  if (d && path.isAbsolute(d) && !/^undefined[\\/]/i.test(d)) return d
  const env = process.env.TEMP || process.env.TMP || process.env.TMPDIR || ''
  if (env && path.isAbsolute(env)) return env
  return 'C:\\Windows\\Temp'
}
const MEDIA_DIR = path.join(mediaTmpRoot(), 'stellar-qzone-media')

function pickExt(ct, url) {
  const t = String(ct || '').toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  const m = String(url || '').match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

// 按字节判断真实格式：空间评论区的图 CDN 常常回 AVIF（ftyp avif），
// 光看 content-type/扩展名会存成 .jpg，模型那边解不了 → 必须转码。
function sniffImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif'
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp'
  if (buf.slice(4, 8).toString() === 'ftyp') {
    const brand = buf.slice(8, 12).toString()
    if (['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1', 'hevc', 'hevx'].includes(brand)) return 'avif'
  }
  return ''
}

let warnedNoFfmpeg = false
function convertToJpeg(file) {
  const ff = ffmpegPath()
  if (!ff) {
    if (!warnedNoFfmpeg) {
      warnedNoFfmpeg = true
      console.error('[qzone] 评论区图片是 AVIF 格式，需要 ffmpeg 转成 JPEG；本机没找到 ffmpeg，这次跳过附图')
    }
    return null
  }
  const out = file.replace(/.[A-Za-z0-9]+$/, '') + '-conv.jpg'
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, out], { windowsHide: true })
  if (r.status !== 0 || !fs.existsSync(out)) return null
  try { fs.unlinkSync(file) } catch { /* 原图删不掉也无所谓 */ }
  return out
}

async function grabImage(url, tag, idx) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://user.qzone.qq.com/' },
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > 15 * 1024 * 1024) return null
    const kind = sniffImage(buf) || pickExt(res.headers.get('content-type'), url)
    const safe = String(tag || 'img').replace(/[^0-9A-Za-z_-]/g, '')
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
    const raw = path.join(MEDIA_DIR, `${safe}-${idx}-${Date.now()}.${kind}`)
    fs.writeFileSync(raw, buf)
    const file = kind === 'avif' ? convertToJpeg(raw) : raw
    if (!file) return null
    return { file, bytes: fs.statSync(file).size, url }
  } catch {
    return null
  }
}

async function grabImages(urls, tag) {
  const out = []
  const list = (Array.isArray(urls) ? urls : []).slice(0, 9)
  for (let i = 0; i < list.length; i += 1) {
    const got = await grabImage(list[i], tag, i + 1)
    if (got) out.push(got)
  }
  return out
}

// 评论里的图：get_qzone_feed_detail 的评论对象带 media_items[].image
// （default_url / photo_url[]），旧版 get_qzone_msg_detail 会把它们丢掉。
function commentImageUrls(c) {
  const urls = []
  const seen = new Set()
  for (const it of Array.isArray(c?.media_items) ? c.media_items : []) {
    const img = it?.image ?? it?.pic ?? null
    if (!img) continue
    const key = String(img.lloc ?? img.sloc ?? '') || String(urls.length)
    if (seen.has(key)) continue
    seen.add(key)
    // 同一张图有多个 spec 变体，取一张就够：优先 default_url，其次第一张 photo_url。
    const dft = img.default_url?.url ?? (typeof img.default_url === 'string' ? img.default_url : '')
    if (dft) { urls.push(dft); continue }
    for (const p of Array.isArray(img.photo_url) ? img.photo_url : []) {
      const u = typeof p === 'string' ? p : (p?.url?.url ?? p?.url ?? '')
      if (typeof u === 'string' && u) { urls.push(u); break }
    }
  }
  const text = Array.isArray(c?.content)
    ? c.content.map((x) => x?.content ?? '').join('')
    : String(c?.content ?? '')
  for (const m of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) urls.push(m[1])
  return [...new Set(urls)]
}

// 把某条说说评论区里带图的评论（含楼中楼）下载下来，输出 JSON。
async function commentsMedia() {
  const tid = args.get('tid')
  if (!tid || typeof tid !== 'string') { console.error('需要 --tid <说说 id>'); process.exit(2) }
  const max = Math.max(1, Math.min(30, Number(args.get('num') ?? 20)))
  const { comments } = await loadThread(tid)
  const out = []
  let budget = 12
  for (const c of (comments ?? []).slice(0, max)) {
    const rows = [c, ...(Array.isArray(c.replys) ? c.replys : [])]
    const images = []
    for (const row of rows) {
      if (budget <= 0) break
      for (const url of commentImageUrls(row).slice(0, 9)) {
        if (budget <= 0) break
        const got = await grabImage(url, `${tid}-c${row?.id ?? c.id ?? ''}`, images.length + 1)
        if (got) { images.push(got); budget -= 1 }
      }
    }
    if (!images.length) continue
    out.push({
      id: String(c.id ?? ''),
      uin: Number(c.user?.uin ?? 0),
      nickname: c.user?.nick ?? '',
      time: c.time,
      content: oneLine(commentText(c), 200),
      images,
    })
  }
  console.log(JSON.stringify({ tid, comments: out }))
}

// 把某个流里带图的条目下载下来，输出 JSON（stdout 只有这一行 JSON）。
// 带 --tid 时只取那一条：先翻好友动态，再翻主人/自己的说说列表（详情接口不带图）。
async function media() {
  const onlyTid = String(args.get('tid') ?? '').trim()
  const scope = String(args.get('scope') ?? 'friends')
  const wantUin = Number(args.get('uin') ?? 0)
  if (!['mine', 'owner', 'friends', 'person'].includes(scope)) {
    console.error(`--scope 只能是 mine / owner / friends / person，收到 ${scope}`)
    process.exit(2)
  }
  const items = []
  const pushIfWanted = async (it, uin, nickname) => {
    if (onlyTid && String(it.tid) !== onlyTid) return false
    if (!(it.images ?? []).length) return false
    items.push({
      tid: String(it.tid), uin, nickname: nickname ?? '', time: it.time,
      content: oneLine(it.content ?? '', 200),
      images: await grabImages(it.images, it.tid),
    })
    return true
  }
  const feedList = async () => {
    const data = await call('get_qzone_feeds', { page_num: 1, count: Math.max(num, onlyTid ? 30 : num) })
    return (data?.feeds ?? []).filter((it) => it.tid && Number(it.uin) > 0)
  }
  const msgList = async (targetUin) => {
    const body = { pos: 0, num: Math.max(num, onlyTid ? 30 : num) }
    if (targetUin) body.target_uin = Number(targetUin)
    const data = await call('get_qzone_msg_list', body)
    return (data?.msglist ?? []).filter((it) => it && it.tid)
  }
  if (onlyTid) {
    // 单条：指定了 --uin 就直接去那个人空间里找（通讯录成员的新说说常常不在
    // friends 流第一页里，只翻流会「读不到图」）；没给才按三条流依次翻。
    if (wantUin) {
      for (const it of await msgList(wantUin)) {
        if (await pushIfWanted(it, wantUin, '')) break
      }
    }
    if (!items.length) {
      for (const it of await feedList()) {
        if (await pushIfWanted(it, Number(it.uin), it.nickname)) break
      }
    }
    if (!items.length && ownerQQ) {
      for (const it of await msgList(ownerQQ)) {
        if (await pushIfWanted(it, ownerQQ, '')) break
      }
    }
    if (!items.length) {
      for (const it of await msgList(0)) {
        if (await pushIfWanted(it, 0, '')) break
      }
    }
  } else if (scope === 'person' || (scope === 'friends' && wantUin)) {
    if (!wantUin) {
      console.error('--scope person 要同时给 --uin（那个人的 QQ）。不知道 QQ 就先 read --scope friends 看列表')
      process.exit(2)
    }
    const target = wantUin
    for (const it of await msgList(target)) {
      await pushIfWanted(it, target, '')
    }
  } else if (scope === 'friends') {
    for (const it of await feedList()) {
      await pushIfWanted(it, Number(it.uin), it.nickname)
    }
  } else {
    if (scope === 'owner' && !ownerQQ) throw new Error('config.json 没配 ownerQQ，读不了主人空间')
    for (const it of await msgList(scope === 'owner' ? ownerQQ : 0)) {
      await pushIfWanted(it, scope === 'owner' ? ownerQQ : 0, '')
    }
  }
  console.log(JSON.stringify({ scope: onlyTid ? 'tid' : scope, tid: onlyTid || undefined, items }))
}

// ── 读：列表 / 详情 ─────────────────────────────────────────────────────────


async function scopeList(scope) {
  // 2026-11-11：主人要求「能主动去看通讯录里某个人的动态」。朋友的 feeds 流只给第一页、
  // 而且翻不到更早的；要盯住某个人（比如测试员A）得按 uin 直接读她的空间。
  const uinArg = String(args.get('uin') ?? '').trim()
  if (scope === 'person' || (scope === 'friends' && uinArg)) {
    const target = Number(uinArg || 0)
    if (!target) { console.error('读某个人的空间需要 --uin <QQ号>'); process.exit(2) }
    const data = await call('get_qzone_msg_list', { pos: 0, num, target_uin: target })
    const list = (data?.msglist ?? []).filter((it) => it && it.tid)
    console.log(`${target} 的空间：共 ${data?.total ?? list.length} 条，本页 ${list.length} 条`)
    if (!list.length) {
      console.log('（这个人没发过说说，或者她没权限看这个人的空间）')
      return
    }
    for (const it of list) {
      console.log(`- [${it.tid}] ${fmtTime(it.time)} 赞${it.like_count ?? 0}/评${it.comment_num ?? 0}${it.is_private ? ' 私密' : ''}`)
      console.log(`  ${oneLine(it.content ?? '', 100)}`)
      const pics = it.images ?? []
      if (pics.length) console.log(`  🖼 ${pics.length} 张图片：${pics[0]}`)
    }
    console.log(`\n看某条的评论：node bili.mjs qzone detail --tid <tid> --uin ${target}`)
    return
  }
  if (scope === 'friends') {
    const data = await call('get_qzone_feeds', { page_num: 1, count: num })
    // uin=0 / tid=null 的是广告位，过滤掉
    const list = (data?.feeds ?? []).filter((it) => it.tid && Number(it.uin) > 0)
    console.log(`好友动态：本页 ${list.length} 条（has_more=${data?.has_more ? '有' : '无'}）`)
    for (const it of list) {
      console.log(`- [${it.tid}] ${fmtTime(it.time)} uin=${it.uin} ${it.nickname ?? '?'}`)
      console.log(`  ${oneLine(it.content ?? '', 100)}  (赞${it.like_count ?? 0}/评${it.comment_count ?? 0}）`)
      const pics = it.images ?? []
      if (pics.length) console.log(`  🖼 ${pics.length} 张图片：${pics[0]}`)
    }
    return
  }
  const body = { pos: 0, num }
  if (scope === 'owner') {
    if (!ownerQQ) throw new Error('config.json 没配 ownerQQ，读不了主人空间')
    body.target_uin = ownerQQ
  }
  const who = scope === 'owner' ? `主人(${ownerQQ}）` : '自己'
  let data
  try {
    data = await call('get_qzone_msg_list', body)
  } catch (err) {
    // 空空间时 QQ 返回 msglist:null，SnowLuma 判成"响应结构异常"——当成"还没有说说"
    if (String(err.message).includes('响应结构异常')) {
      console.log(`${who}的空间现在读不出说说列表（多半是还没有说说，或空空间返回 null）。`)
      return
    }
    throw err
  }
  const list = data?.msglist ?? []
  console.log(`${who}的空间：共 ${data?.total ?? list.length} 条，本页 ${list.length} 条`)
  for (const it of list) {
    console.log(`- [${it.tid}] ${fmtTime(it.time)} 评论${it.comment_num ?? 0}${it.is_private ? ' 私密' : ''}`)
    console.log(`  ${oneLine(it.content ?? '', 100)}`)
    const pics = it.images ?? []
    if (pics.length) console.log(`  🖼 ${pics.length} 张图片：${pics[0]}`)
  }
  if (list.length) console.log(`\n看某条的评论：node bili.mjs qzone detail --tid <tid>${scope === 'owner' ? ' --uin ' + ownerQQ : ''}`)
}

async function detail(tid, uin) {
  const body = { tid, pos: 0, num: Number(args.get('num') ?? 20) }
  if (uin) body.target_uin = Number(uin)
  const data = await call('get_qzone_msg_detail', body)
  console.log(`说说 ${data?.tid ?? tid}：${oneLine(data?.content ?? '', 200)}`)
  // 评论以「空间动态」接口为准：它带评论图，而且比 get_qzone_msg_detail 更全
  // （详情接口有时会漏掉某几条评论）。
  let thread = null
  try { thread = await loadThread(tid) } catch { /* 读不到就退回详情接口的评论 */ }
  if (thread && (thread.comments ?? []).length) {
    const comments = thread.comments
    console.log(`评论 ${comments.length} 条（↳ 是楼中楼回复）`)
    for (const c of comments) {
      const cpics = commentImageUrls(c).length
      console.log(`\n#${c.id} uin=${Number(c.user?.uin ?? 0) || '?'} ${c.user?.nick ?? '?'} ${fmtTime(c.time)}${cpics ? `  🖼 ${cpics} 张图` : ''}`)
      console.log(`  ${oneLine(commentText(c), 200)}`)
      for (const r of c.replys ?? []) {
        const rpics = commentImageUrls(r).length
        console.log(`  ↳ #${r.id} uin=${Number(r.user?.uin ?? 0) || '?'} ${r.user?.nick ?? '?'} ${fmtTime(r.time)}（回 #${c.id}）${rpics ? `  🖼 ${rpics} 张图` : ''}`)
        console.log(`    ${oneLine(commentText(r), 200)}`)
      }
    }
    console.log('\n评论区里的图片：读详情时会自动附图；单独下载用 qzone comment-media --tid <tid>')
  } else {
    console.log(`评论 ${data?.comment_num ?? 0} 条`)
    for (const c of data?.comments ?? []) {
      console.log(`\n#${c.comment_id} uin=${c.uin} ${c.name ?? '?'} ${fmtTime(c.time)}`)
      console.log(`  ${oneLine(c.content, 200)}`)
      for (const r of c.replies ?? []) {
        console.log(`  ↳ #${r.comment_id} uin=${r.uin} ${r.name ?? '?'} ${fmtTime(r.time)}（回 #${r.parent_comment_id ?? '?'} ${r.parent_comment_uin ?? '?'}）`)
        console.log(`    ${oneLine(r.content, 200)}`)
      }
    }
  }
  console.log('\n回复某条一级评论：--cid <#id> --cuin <对方QQ>')
  console.log('回复楼中楼：--cid <父评论#id> --cuin <父评论QQ> --ruin <对方QQ> --rname <对方昵称>')
}

// ── 评论区：列评论（带 id）／删自己发的评论 ────────────────────────────────
function commentText(c) {
  const parts = Array.isArray(c?.content) ? c.content.map((x) => x?.content ?? '').filter(Boolean) : []
  return cleanQzoneText(parts.length ? parts.join('') : String(c?.content ?? ''))
}

async function loginUin() {
  const me = await call('get_login_info')
  const id = Number(me?.user_id ?? 0)
  if (!id) throw new Error('读不到本机登录的 QQ 号（get_login_info 返回空）')
  return id
}

// 走「空间动态」接口读评论：只有这条通路带可删除的评论对象（feed + 评论 id）
async function loadThread(tid, maxPages = 5) {
  const d = await call('get_qzone_feed_detail', { tid })
  const feed = d?.feed
  if (!feed) throw new Error(`读不到说说 ${tid} 的动态详情（没权限或 tid 不对）`)
  const comments = [...(feed.cell_comment?.comments ?? [])]
  let cursor = d?.attach_info ?? null
  for (let i = 0; cursor && i < maxPages; i += 1) {
    const page = await call('get_qzone_public_comments', { feed, cursor })
    const got = page?.cell_comment?.comments ?? []
    if (got.length) comments.push(...got)
    if (!page?.has_more || !page?.attach_info) break
    cursor = page.attach_info
  }
  return { feed, comments }
}

function listThread(tid, comments, meUin) {
  console.log(`说说 ${tid} 的评论（${comments.length} 条一级评论；★= 你发的，可删）`)
  let mine = 0
  for (const c of comments) {
    const cuin = Number(c.user?.uin ?? 0)
    const own = cuin === meUin
    if (own) mine += 1
    console.log(`\n#${c.id} ${own ? '★' : '·'} uin=${cuin || '?'} ${c.user?.nick ?? '?'} ${fmtTime(c.time)}`)
    console.log(`  ${oneLine(commentText(c), 200)}`)
    const cpics = commentImageUrls(c).length
    if (cpics) console.log(`  🖼 这条评论带 ${cpics} 张图`)
    for (const r of c.replys ?? []) {
      const ruin = Number(r.user?.uin ?? 0)
      const rown = ruin === meUin
      if (rown) mine += 1
      console.log(`  ↳ #${r.id} ${rown ? '★' : '·'} uin=${ruin || '?'} ${r.user?.nick ?? '?'} ${fmtTime(r.time)}（回 #${c.id}）`)
      console.log(`    ${oneLine(commentText(r), 200)}`)
      const rpics = commentImageUrls(r).length
      if (rpics) console.log(`    🖼 带 ${rpics} 张图`)
    }
  }
  if (!mine) console.log('\n这条说说下面没有你发过的评论，没什么可删的。')
  else console.log('\n删自己的一级评论：qzone uncomment --tid <tid> --comment <#id> --dry|--go；删楼中楼：--reply <#id> --parent <父评论#id>')
}

async function commentsList() {
  const tid = args.get('tid')
  if (!tid || typeof tid !== 'string') { console.error('需要 --tid <说说 id>'); process.exit(2) }
  const me = await loginUin()
  const { comments } = await loadThread(tid)
  listThread(tid, comments, me)
}

async function uncomment() {
  const tid = args.get('tid')
  const cid = args.get('comment')
  const rid = args.get('reply')
  const parent = args.get('parent')
  needGo()
  if (!tid || typeof tid !== 'string') { console.error('需要 --tid <说说 id>'); process.exit(2) }
  if (cid === undefined && rid === undefined) {
    console.error('需要 --comment <一级评论 id>，或 --reply <回复 id> --parent <父评论 id>')
    process.exit(2)
  }
  if (rid !== undefined && parent === undefined) { console.error('删楼中楼回复要带 --parent <父评论 id>'); process.exit(2) }
  const me = await loginUin()
  const { feed, comments } = await loadThread(tid)
  let target = null
  let parentComment = null
  if (rid !== undefined) {
    parentComment = comments.find((c) => String(c.id) === String(parent)) ?? null
    if (!parentComment) throw new Error(`没找到父评论 #${parent}（先用 qzone comments --tid ${tid} 看现有评论）`)
    target = (parentComment.replys ?? []).find((r) => String(r.id) === String(rid)) ?? null
    if (!target) throw new Error(`父评论 #${parent} 下面没有回复 #${rid}`)
  } else {
    target = comments.find((c) => String(c.id) === String(cid)) ?? null
    if (!target) throw new Error(`没找到评论 #${cid}（先用 qzone comments --tid ${tid} 看现有评论）`)
  }
  const tuin = Number(target.user?.uin ?? 0)
  const ttext = oneLine(commentText(target), 200)
  const who = rid !== undefined ? `楼中楼回复 #${rid}（父 #${parent}）` : `一级评论 #${cid}`
  console.log('=== 删评论 ===')
  console.log(`  说说: ${tid}`)
  console.log(`  目标: ${who} uin=${tuin || '?'} ${target.user?.nick ?? '?'}`)
  console.log(`  内容: ${ttext}`)
  if (tuin !== me) {
    // 不用 process.exit：此时 fetch 的连接还开着，硬退会在 Windows 上触发 libuv 断言
    console.error(`\n✗ 这条不是你发的（你 ${me}，它 ${tuin || '?'}），只能删自己的评论`)
    process.exitCode = 5
    return
  }
  if (isDry) { console.log('\n[dry] 将要删除上面这条，确认后加 --go'); return }
  if (rid !== undefined) await call('delete_qzone_public_reply', { feed, comment: parentComment, reply: target })
  else await call('delete_qzone_public_comment', { feed, comment: target })
  logWrite({ kind: 'uncomment', tid, cid: rid !== undefined ? parent : cid, reply: rid, text: ttext.slice(0, 200) })
  let gone = false
  try {
    const after = await loadThread(tid)
    if (rid !== undefined) {
      const p = after.comments.find((c) => String(c.id) === String(parent))
      gone = !(p?.replys ?? []).some((r) => String(r.id) === String(rid))
    } else {
      gone = !after.comments.some((c) => String(c.id) === String(cid))
    }
  } catch { /* 复核失败不算删除失败 */ }
  console.log(gone ? `\n✓ 已删除 ${who}` : `\n✓ 删除请求已发出，但复核时还能看到 ${who}（可能是缓存，稍后再看）`)
}

// ── 写：点赞 / 取消赞 / 评论 ────────────────────────────────────────────────

async function react(kind) {
  const tid = args.get('tid')
  if (!tid || typeof tid !== 'string') { console.error('需要 --tid <说说 id>'); process.exit(2) }
  const uin = args.get('uin')
  const time = args.get('time')
  const body = { tid }
  if (uin !== undefined) body.target_uin = Number(uin)
  if (time !== undefined) body.abstime = Number(time)
  const action = kind === 'like' ? 'like_qzone' : 'unlike_qzone'
  console.log(`=== ${kind === 'like' ? '点赞' : '取消赞'} ===`)
  console.log(`  说说: ${tid}${uin !== undefined ? ` (空间主人 ${uin}）` : ' (自己空间)'}`)
  if (isDry) { console.log('\n[dry] 将要调用的请求：'); console.log(JSON.stringify({ action, body }, null, 2)); return }
  await call(action, body)
  logWrite({ kind, tid, uin: uin !== undefined ? Number(uin) : undefined })
  console.log(`\n✓ 已${kind === 'like' ? '点赞' : '取消赞'} ${tid}`)
}

async function comment() {
  const tid = args.get('tid')
  const text = args.get('text')
  if (!tid || typeof tid !== 'string') { console.error('需要 --tid <说说 id>'); process.exit(2) }
  if (!text || typeof text !== 'string' || !text.trim()) { console.error('需要 --text "评论内容"'); process.exit(2) }
  needGo()
  const uin = args.get('uin')
  const cid = args.get('cid')
  const cuin = args.get('cuin')
  const ruin = args.get('ruin')
  const rname = args.get('rname')
  if ((cid === undefined) !== (cuin === undefined)) {
    console.error('--cid 和 --cuin 必须成对出现（要回复某条一级评论时）')
    process.exit(2)
  }
  if ((ruin === undefined) !== (rname === undefined)) {
    console.error('--ruin 和 --rname 必须成对出现（回复楼中楼时）')
    process.exit(2)
  }
  if (ruin !== undefined && cid === undefined) {
    console.error('回复楼中楼必须同时给 --cid/--cuin（父评论）')
    process.exit(2)
  }
  if (images.length) {
    console.error('评论不支持图片，去掉 --image')
    process.exit(2)
  }
  // 空间是公开面：主人自己的生日/城市、通讯录里别人的号码与备注都不许出现。
  const pvComment = checkPrivacy(text, { audience: 'public' })
  if (!pvComment.ok) { console.error(privacyRejectText(pvComment.hits)); process.exit(8) }
  const body = { tid, content: text }
  if (uin !== undefined) body.target_uin = Number(uin)
  if (cid !== undefined) { body.comment_id = String(cid); body.comment_uin = Number(cuin) }
  if (ruin !== undefined) { body.reply_uin = Number(ruin); body.reply_name = String(rname) }
  console.log('=== 评论 ===')
  console.log(`  说说: ${tid}`)
  if (cid !== undefined) console.log(`  回复评论: #${cid}（uin=${cuin}）${ruin !== undefined ? ` → ${rname}(${ruin}）` : ''}`)
  console.log(`  内容: ${oneLine(text, 120)}`)
  if (isDry) { console.log('\n[dry] 将要发送的请求：'); console.log(JSON.stringify(body, null, 2)); return }
  const data = await call('comment_qzone', body)
  logWrite({ kind: 'comment', tid, cid: data?.comment_id, parent: data?.parent_comment_id, text: text.slice(0, 200) })
  console.log(`\n✓ 已评论 ${tid}，评论 id=${data?.comment_id ?? '?'}${data?.parent_comment_id ? ` (楼中楼，父 #${data.parent_comment_id}）` : ''}`)
}

// ── 公开动态（「空友爱看」推荐流）：读 10 条 → 打分 → 前 3 点赞 → 随机 3 条评论 ──
// 上游 get_qzone_public_feeds 一次给 10 条，里面夹着聚合卡片/广告：只有带 cell_summary 的才是真动态。
// 写操作（set_qzone_public_like / comment_qzone_public_feed）要把**整条 feed 原样**回传，单条 9~62KB，
// 模型贴着回填不现实 → 这里按 feed_id 缓存整条 feed，命令行只认短 id（前缀匹配也认）。
const PUBLIC_CACHE = path.join(STATE_DIR, 'qzone-public-cache.json')
// 「今天刷过什么」的账本：控制台（stellar-manager）读同一个文件渲染「今天刷的动态」。
// 只存当天（跨天自动重置），每条记 id/昵称/正文摘要/图数/赞评数 + 她的评分/点赞/评论。
const PUBLIC_DAY = path.join(STATE_DIR, 'qzone-public-day.json')
const PUBLIC_TTL_MS = 24 * 3600 * 1000
const QZP = qz.public ?? {}
const PUBLIC_LIKE_LIMIT = Math.max(0, Number(QZP.likeLimit ?? 3) || 0)
const PUBLIC_COMMENT_LIMIT = Math.max(0, Number(QZP.commentLimit ?? 3) || 0)
// 2026-11-20（主人）：一天**总共**能看几条。以前 seenTarget 只当「每次 list 拉几条」，
// 她在同一轮里连跑 4 次 list → 账本 40 条 = 上限的 4 倍，谁都没拦。
const PUBLIC_SEEN_LIMIT = Math.max(1, Math.min(60, Number(QZP.seenTarget ?? 10) || 10))

function publicId(feed) {
  return String(feed?.cell_common?.feed_id ?? '')
}

function publicNick(feed) {
  const u = feed?.cell_user_info?.user ?? {}
  return String(u.nick ?? u.uin ?? '')
}

function publicText(feed) {
  const parts = []
  for (const s of Array.isArray(feed?.cell_summary?.summary) ? feed.cell_summary.summary : []) {
    if (typeof s?.content === 'string' && s.content.trim()) parts.push(s.content)
  }
  return parts.join(' ')
}

function publicStat(feed) {
  return {
    liked: !!feed?.cell_like?.liked,
    likes: Number(feed?.cell_like?.num ?? 0) || 0,
    comments: Number(feed?.cell_comment?.num ?? 0) || 0,
  }
}

// 公开动态的配图：cell_media.media_items[].image（有 default_url 就用它，否则第一张 photo_url）
function publicImageUrls(feed) {
  const urls = []
  const seen = new Set()
  for (const it of Array.isArray(feed?.cell_media?.media_items) ? feed.cell_media.media_items : []) {
    const img = it?.image ?? null
    if (!img) continue
    const key = String(img.lloc ?? img.sloc ?? img.name ?? '') || String(urls.length)
    if (seen.has(key)) continue
    seen.add(key)
    const dft = img.default_url?.url ?? (typeof img.default_url === 'string' ? img.default_url : '')
    if (dft) { urls.push(dft); continue }
    for (const p of Array.isArray(img.photo_url) ? img.photo_url : []) {
      const u = typeof p === 'string' ? p : (p?.url?.url ?? p?.url ?? '')
      if (typeof u === 'string' && u) { urls.push(u); break }
    }
  }
  return [...new Set(urls)]
}

function readPublicCache() {
  const raw = readJson(PUBLIC_CACHE, { feeds: {} })
  const feeds = {}
  const now = Date.now()
  for (const [id, row] of Object.entries(raw.feeds ?? {})) {
    if (!row || !row.feed) continue
    if (!row.at || now - Number(row.at) > PUBLIC_TTL_MS) continue
    feeds[id] = row
  }
  return { at: raw.at ?? '', feeds }
}

function writePublicCache(cache) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(PUBLIC_CACHE, JSON.stringify({ at: new Date().toISOString(), feeds: cache.feeds }))
  } catch (err) {
    console.error('[qzone] 公开动态缓存写不进去（这次仍可用，但下一条命令可能找不到 id）：' + err.message)
  }
}

// 截图落盘（2026-11-11 主人要求）：控制台要看见她到底刷到了什么，光靠文字不够。
// 放在 state/qzone-public-shots/<本地日期>/ 下，按日期分目录 → 「每天清空截图」就是删旧目录；
// 文字账本另有 qzone-public-day.json，图删了正文还在。
const PUBLIC_SHOTS = path.join(STATE_DIR, 'qzone-public-shots')

function publicShotDir(day = publicDay()) {
  return path.join(PUBLIC_SHOTS, day)
}

/** 把已经下好的临时图收进按日目录，返回相对文件名（面板用 /api/qzone-public/shot?name= 取）。 */
function keepPublicShot(file, id, index) {
  try {
    const dir = publicShotDir()
    fs.mkdirSync(dir, { recursive: true })
    const ext = path.extname(String(file || '')).toLowerCase() || '.jpg'
    const name = String(id).slice(0, 24) + '-' + index + ext
    fs.copyFileSync(file, path.join(dir, name))
    return name
  } catch (err) {
    console.error('[qzone] 动态截图存不下来（不影响点赞评论）：' + err.message)
    return ''
  }
}

/** 删掉非今天的截图目录；all=true 连今天的也删。返回删除的目录数。 */
function prunePublicShots({ all = false, keepDay = publicDay() } = {}) {
  let removed = 0
  let days = []
  try { days = fs.readdirSync(PUBLIC_SHOTS) } catch { return 0 }
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if (!all && d === keepDay) continue
    try { fs.rmSync(path.join(PUBLIC_SHOTS, d), { recursive: true, force: true }); removed += 1 } catch {}
  }
  return removed
}

// ── 「今天刷过什么」账本（面板读它）────────────────────────────────────
function publicDay() {
  return new Date().toLocaleDateString('sv-SE')
}

function readPublicDay() {
  const day = publicDay()
  const raw = readJson(PUBLIC_DAY, {})
  if (!raw || raw.day !== day || !Array.isArray(raw.items)) return { day, items: [] }
  return { day, items: raw.items.filter((e) => e && e.id) }
}

function writePublicDay(store) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    // 一天最多看 10 条 × 几次 = 几十条，留 60 条足够，别让文件无限长
    store.items = store.items.slice(0, 60)
    fs.writeFileSync(PUBLIC_DAY, JSON.stringify(store))
  } catch (err) {
    console.error('[qzone] 今日公开动态账本写不进去（不影响点赞评论，但控制台会看不到）：' + err.message)
  }
}

// list 看到的条目并进今天的账本：保留她之前打的分数、点赞、评论
function rememberPublicRows(rows) {
  const store = readPublicDay()
  const byId = new Map(store.items.map((e) => [e.id, e]))
  const at = new Date().toISOString()
  rows.forEach((r, i) => {
    const prev = byId.get(r.id) ?? {}
    byId.set(r.id, {
      ...prev,
      id: r.id,
      short: r.short,
      nick: r.nick,
      text: String(r.text ?? '').slice(0, 300),
      pictures: Number(r.pictures) || 0,
      likes: Number(r.likes) || 0,
      comments: Number(r.comments) || 0,
      liked: Boolean(prev.likeAt) || Boolean(r.liked),
      seenAt: prev.seenAt || at,
      order: i + 1,
      score: prev.score ?? null,
      note: prev.note ?? '',
      // 截图文件名（面板拼 /api/qzone-public/shot?name= 取图）；每天清空后这里只剩空数组，正文仍保留
      shots: Array.isArray(r.shots) && r.shots.length ? r.shots.slice(0, 3) : (Array.isArray(prev.shots) ? prev.shots : []),
      likeAt: prev.likeAt ?? '',
      commentText: prev.commentText ?? '',
      commentAt: prev.commentAt ?? '',
    })
  })
  store.items = [...byId.values()]
  writePublicDay(store)
  return store
}

// 按短 id / 全 id / 列表序号（#1..#10）找账本里的那条。
// 注意必须传入**同一个** store：旧写法自己又读了一次盘，改到的是另一份解析结果，落盘等于没改。
function resolvePublicRowIn(store, hit) {
  const want = String(hit ?? '').trim()
  if (!want) return null
  const byId = store.items.find((e) => e.id === want)
  if (byId) return byId
  const byPrefix = store.items.find((e) => e.id.startsWith(want))
  if (byPrefix) return byPrefix
  const n = Number(want.replace(/^#/, ''))
  if (Number.isFinite(n) && n > 0) return store.items.find((e) => Number(e.order) === n) ?? null
  return null
}

// 记一笔她的动作（点赞/评论/打分）到今天的账本；id 不在今天的账本里就先补一条
function markPublicRow(id, patch) {
  const store = readPublicDay()
  let row = store.items.find((e) => e.id === id)
  if (!row) {
    const cached = (readPublicCache().feeds ?? {})[id] ?? {}
    row = {
      id,
      short: String(id).slice(0, 8),
      nick: cached.nick ?? '',
      text: String(cached.text ?? '').slice(0, 300),
      pictures: 0,
      likes: 0,
      comments: 0,
      liked: false,
      seenAt: new Date().toISOString(),
      order: 99,
      score: null,
      note: '',
      shots: [],
      likeAt: '',
      commentText: '',
      commentAt: '',
    }
    store.items.unshift(row)
  }
  Object.assign(row, patch)
  writePublicDay(store)
  return row
}

// 只认本机缓存里的 id：前缀匹配（列表里打印的是前 8 位，全 id 也认）
function resolvePublicFeed(idArg) {
  const want = String(idArg ?? '').trim()
  if (!want) throw new Error('需要 --id <动态 id>')
  const cache = readPublicCache()
  const ids = Object.keys(cache.feeds)
  const hit = ids.find((id) => id === want) ?? ids.find((id) => id.startsWith(want))
  if (!hit) throw new Error('没有这个动态 id 的缓存（' + want + '）；先跑一次 qzone public list 重新拉取')
  return { id: hit, feed: cache.feeds[hit].feed, nick: cache.feeds[hit].nick ?? '', text: cache.feeds[hit].text ?? '' }
}

// 今天的某个动作已经做了几次（按本地日期算；qzone-log.jsonl 的 at 是 UTC ISO，不能直接截前 10 位比）
function reactedToday(kind) {
  const day = new Date().toLocaleDateString('sv-SE')
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n')
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((e) => e && e.kind === kind && new Date(e.at ?? 0).toLocaleDateString('sv-SE') === day).length
  } catch {
    return 0
  }
}

function publicTouched(kind, id) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n')
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .some((e) => e && e.kind === kind && String(e.feedId ?? '') === id)
  } catch {
    return false
  }
}

// 一页 10 条里常有一半是聚合卡片/广告（没有 cell_summary），所以要翻页凑够需要看的那几条。
async function fetchPublicFeeds(want = 10) {
  const feeds = []
  const seen = new Set()
  let cursor = ''
  let hasMore = false
  // 2026-11-11：主人能在控制台把「每天看几条」调到 30，一页 10 条按 3 页不够 → 放宽到 5 页。
  for (let page = 0; page < 5; page += 1) {
    const data = await call('get_qzone_public_feeds', cursor ? { cursor } : {})
    for (const f of data?.feeds ?? []) {
      const id = publicId(f)
      if (!id || !publicText(f) || seen.has(id)) continue
      seen.add(id)
      feeds.push(f)
    }
    hasMore = !!data?.has_more
    cursor = String(data?.next_cursor ?? '')
    if (feeds.length >= want || !hasMore || !cursor) break
  }
  return { feeds, hasMore }
}

async function publicList() {
  // 默认看几条 = qzone.public.seenTarget（控制台「她每天做什么」里改的），缺省 10；显式 --n 优先。
  const seenDefault = Math.max(1, Math.min(30, Number(QZP.seenTarget ?? 10) || 10))
  const asked = Math.max(1, Math.min(30, Number(args.get('n') ?? args.get('num') ?? seenDefault) || seenDefault))
  // 今日总量的硬闸：账本里已有的条数算「今天已经看过」，剩下的才是这次能拉的。
  // 公开流每次请求返回的都是新的一批，所以重复 list 确实会越看越多 —— 必须在这里拦。
  const seenToday = readPublicDay().items.length
  const left = Math.max(0, PUBLIC_SEEN_LIMIT - seenToday)
  if (left <= 0) {
    console.error('✗ 今天已经看过 ' + seenToday + ' 条公开动态，到上限了（qzone.public.seenTarget = ' + PUBLIC_SEEN_LIMIT + '）。')
    console.error('  不要再拉新的一批：用 qzone public score / like / comment 处理已经拉下来的那些，然后 qzone public today 收尾。')
    process.exit(3)
  }
  const want = Math.min(asked, left)
  // 每条动态最多下几张图（0=不下）。上限 3 —— 一次 10 条全带图会太贵，也看不完。
  const wantImages = Math.max(0, Math.min(3, Number(args.get('images') ?? 0) || 0))
  const { feeds, hasMore } = await fetchPublicFeeds(want)
  const cache = readPublicCache()
  const now = Date.now()
  const rows = []
  for (const f of feeds.slice(0, want)) {
    const id = publicId(f)
    const row = {
      id,
      short: id.slice(0, 8),
      nick: publicNick(f),
      text: publicText(f),
      time: f?.cell_common?.time ?? 0,
      ...publicStat(f),
      pictures: publicImageUrls(f).length,
      images: [],
      shots: [],
    }
    cache.feeds[id] = { feed: f, nick: row.nick, text: row.text.slice(0, 400), at: now }
    if (wantImages > 0 && row.pictures > 0) {
      const urls = publicImageUrls(f).slice(0, Math.min(wantImages, row.pictures))
      for (let i = 0; i < urls.length; i += 1) {
        const got = await grabImage(urls[i], 'pub-' + id.slice(0, 8), i + 1)
        if (!got) continue
        row.images.push(got.file)
        // 顺手收进按日截图目录：临时目录会被系统清，控制台要能一直看到今天的图
        const kept = keepPublicShot(got.file, id, i + 1)
        if (kept) row.shots.push(kept)
      }
    }
    rows.push(row)
  }
  writePublicCache(cache)
  rememberPublicRows(rows)
  if (JSON_OUT) {
    console.log(JSON.stringify({ feeds: rows, has_more: hasMore }))
    return
  }
  console.log('公开动态（好友爱看/推荐流）：本页 ' + rows.length + ' 条' + (hasMore ? '，还有更多' : ''))
  rows.forEach((r, i) => {
    console.log('\n#' + (i + 1) + ' [' + r.short + '] ' + (r.nick || '?') + ' ' + fmtTime(r.time) + '  赞' + r.likes + (r.liked ? '(已赞)' : '') + ' 评' + r.comments + ' 图' + r.pictures)
    console.log('  ' + oneLine(r.text, 160))
    for (const g of r.images) console.log('  🖼 ' + g)
  })
  console.log('\n点赞：qzone public like --id <id> --dry|--go；评论：qzone public comment --id <id> --text "…" --dry|--go')
  console.log('今天已看 ' + (seenToday + rows.length) + '/' + PUBLIC_SEEN_LIMIT + ' 条公开动态（这次 ' + rows.length + ' 条）；已赞 ' + reactedToday('public-like') + '/' + PUBLIC_LIKE_LIMIT + ' 条、已评 ' + reactedToday('public-comment') + '/' + PUBLIC_COMMENT_LIMIT + ' 条')
  if (seenToday + rows.length >= PUBLIC_SEEN_LIMIT) {
    console.log('⚠️ 今天看够了（上限 ' + PUBLIC_SEEN_LIMIT + ' 条）：别再 list，把这一批处理完就收尾。')
  }
}

async function publicMedia() {
  const idArg = args.get('id')
  if (!idArg || typeof idArg !== 'string') { console.error('需要 --id <动态 id>'); process.exit(2) }
  const { id, feed } = resolvePublicFeed(idArg)
  const got = await grabImages(publicImageUrls(feed), 'pub-' + id.slice(0, 8))
  console.log(JSON.stringify({ id, images: got }))
}

async function publicReact(kind) {
  const idArg = args.get('id')
  if (!idArg || typeof idArg !== 'string') { console.error('需要 --id <动态 id>'); process.exit(2) }
  needGo()
  const { id, feed, nick } = resolvePublicFeed(idArg)
  const stat = publicStat(feed)
  const like = kind === 'like'
  console.log('=== 公开动态' + (like ? '点赞' : '取消赞') + ' ===')
  console.log('  动态: ' + id + (nick ? '  ' + nick : ''))
  console.log('  正文: ' + oneLine(publicText(feed), 100))
  if (like) {
    if (stat.liked) { console.error('\n✗ 这条你已经赞过了'); process.exit(6) }
    const used = reactedToday('public-like')
    console.log('  今日已赞: ' + used + '/' + PUBLIC_LIKE_LIMIT)
    if (PUBLIC_LIKE_LIMIT > 0 && used >= PUBLIC_LIKE_LIMIT) {
      console.error('\n✗ 今天的公开动态点赞已达上限 ' + PUBLIC_LIKE_LIMIT + ' 条（qzone.public.likeLimit）')
      process.exit(6)
    }
  }
  if (isDry) {
    console.log('\n[dry] 将要调用：set_qzone_public_like ' + JSON.stringify({ feed_id: id, enable: like }))
    return
  }
  await call('set_qzone_public_like', { feed, enable: like })
  logWrite({ kind: like ? 'public-like' : 'public-unlike', feedId: id, nick })
  markPublicRow(id, like ? { liked: true, likeAt: new Date().toISOString() } : { liked: false, likeAt: '' })
  console.log('\n✓ 已' + (like ? '点赞' : '取消赞') + ' ' + id)
}

async function publicComment() {
  const idArg = args.get('id')
  const text = args.get('text')
  if (!idArg || typeof idArg !== 'string') { console.error('需要 --id <动态 id>'); process.exit(2) }
  if (!text || typeof text !== 'string' || !text.trim()) { console.error('需要 --text "评论内容"'); process.exit(2) }
  needGo()
  if (text.length > 120) { console.error('公开动态评论最多 120 字，收到 ' + text.length + ' 字'); process.exit(2) }
  const { id, feed, nick } = resolvePublicFeed(idArg)
  if (publicTouched('public-comment', id)) {
    console.error('\n✗ 这条动态你已经评论过了（同一条只评一次）')
    process.exit(6)
  }
  const used = reactedToday('public-comment')
  if (PUBLIC_COMMENT_LIMIT > 0 && used >= PUBLIC_COMMENT_LIMIT) {
    console.error('\n✗ 今天的公开动态评论已达上限 ' + PUBLIC_COMMENT_LIMIT + ' 条（qzone.public.commentLimit）')
    process.exit(6)
  }
  const pv = checkPrivacy(text, { audience: 'public' })
  if (!pv.ok) { console.error(privacyRejectText(pv.hits)); process.exit(8) }
  console.log('=== 公开动态评论 ===')
  console.log('  动态: ' + id + (nick ? '  ' + nick : ''))
  console.log('  原文: ' + oneLine(publicText(feed), 100))
  console.log('  今日已评: ' + used + '/' + PUBLIC_COMMENT_LIMIT)
  console.log('  内容: ' + oneLine(text, 120))
  if (isDry) {
    console.log('\n[dry] 将要调用：comment_qzone_public_feed ' + JSON.stringify({ feed_id: id, content: text }))
    return
  }
  await call('comment_qzone_public_feed', { feed, content: text })
  logWrite({ kind: 'public-comment', feedId: id, nick, text: text.slice(0, 200) })
  markPublicRow(id, { commentText: text.slice(0, 200), commentAt: new Date().toISOString() })
  console.log('\n✓ 已评论 ' + id)
}

// 一次做完「点赞 + 评论」（2026-11-21 省 token）：以前每条赞/评各一次调用（3 赞 + 3 评 = 6 次
// 模型往返，每次都要重发整段上下文）；现在一条命令把这一轮的计划全做完，失败一条不影响其余。
// 用法：node bili.mjs qzone public batch --likes "3,5" --comments "7=物价这句真准; 2=猫怎么这么胖" --dry|--go
// 仍然守全部老闸：今天条数上限、同一条只评一次、已经赞过就跳过、隐私闸拦下就跳过。
async function publicBatch() {
  const likes = String(args.get('likes') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const rawComments = String(args.get('comments') ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  const comments = []
  for (const pair of rawComments) {
    const at = pair.indexOf('=')
    if (at <= 0) throw new Error('--comments 每一项要写成「动态#/短id=内容」，收到：' + pair)
    const idArg = pair.slice(0, at).trim()
    const text = pair.slice(at + 1).trim()
    if (idArg && text) comments.push({ idArg, text })
  }
  if (!likes.length && !comments.length) {
    console.error('这一轮要做什么？--likes "3,5" / --comments "7=内容; 2=内容"（可以只给一个）')
    process.exit(2)
  }
  // 参数齐了再要 dry/go：先报「要做什么」比先报「缺 dry/go」有用。
  needGo()
  const plan = []
  for (const idArg of likes) {
    const { id, feed, nick } = resolvePublicFeed(idArg)
    if (publicStat(feed).liked) { plan.push({ kind: 'like', idArg, id, nick, skip: '已经赞过' }); continue }
    plan.push({ kind: 'like', idArg, id, nick, feed })
  }
  for (const c of comments) {
    const { id, feed, nick } = resolvePublicFeed(c.idArg)
    if (c.text.length > 120) { plan.push({ kind: 'comment', idArg: c.idArg, id, nick, skip: '超过 120 字' }); continue }
    if (publicTouched('public-comment', id)) { plan.push({ kind: 'comment', idArg: c.idArg, id, nick, skip: '这条已经评过' }); continue }
    const pv = checkPrivacy(c.text, { audience: 'public' })
    if (!pv.ok) { plan.push({ kind: 'comment', idArg: c.idArg, id, nick, skip: '隐私闸拦下' }); continue }
    plan.push({ kind: 'comment', idArg: c.idArg, id, nick, feed, text: c.text })
  }
  const todo = plan.filter((p) => !p.skip)
  const likeUsed = reactedToday('public-like')
  const cmtUsed = reactedToday('public-comment')
  const likeWant = todo.filter((p) => p.kind === 'like').length
  const cmtWant = todo.filter((p) => p.kind === 'comment').length
  const over = []
  if (PUBLIC_LIKE_LIMIT > 0 && likeUsed + likeWant > PUBLIC_LIKE_LIMIT) over.push('点赞：今天已 ' + likeUsed + '/' + PUBLIC_LIKE_LIMIT + '，这批还要 ' + likeWant + ' 条')
  if (PUBLIC_COMMENT_LIMIT > 0 && cmtUsed + cmtWant > PUBLIC_COMMENT_LIMIT) over.push('评论：今天已 ' + cmtUsed + '/' + PUBLIC_COMMENT_LIMIT + '，这批还要 ' + cmtWant + ' 条')
  if (over.length) {
    console.error('\n✗ 这一批会超过今天的额度：\n  ' + over.join('\n  ') + '\n  减几条再来（脚本不替你砍）')
    process.exit(6)
  }
  console.log('=== 公开动态：这一轮 ' + likeWant + ' 赞 / ' + cmtWant + ' 评 ===')
  for (const p of plan) {
    console.log('  [' + (p.kind === 'like' ? '赞' : '评') + '] ' + p.idArg + ' → ' + p.id + (p.nick ? '  ' + p.nick : '') + (p.skip ? '  （跳过：' + p.skip + '）' : ''))
    if (p.kind === 'comment' && !p.skip) console.log('        ' + oneLine(p.text, 80))
  }
  console.log('  今日已赞 ' + likeUsed + '/' + PUBLIC_LIKE_LIMIT + ' · 已评 ' + cmtUsed + '/' + PUBLIC_COMMENT_LIMIT)
  if (isDry) {
    console.log('\n[dry] 上面这些都会真做；满意就把 --dry 换成 --go 再跑这一条。')
    return
  }
  const failed = []
  for (const p of todo) {
    try {
      if (p.kind === 'like') {
        await call('set_qzone_public_like', { feed: p.feed, enable: true })
        logWrite({ kind: 'public-like', feedId: p.id, nick: p.nick })
        markPublicRow(p.id, { liked: true, likeAt: new Date().toISOString() })
        console.log('  ✓ 已赞 ' + p.id)
      } else {
        await call('comment_qzone_public_feed', { feed: p.feed, content: p.text })
        logWrite({ kind: 'public-comment', feedId: p.id, nick: p.nick, text: p.text.slice(0, 200) })
        markPublicRow(p.id, { commentText: p.text.slice(0, 200), commentAt: new Date().toISOString() })
        console.log('  ✓ 已评 ' + p.id)
      }
    } catch (e) {
      const why = String(e?.message ?? e).slice(0, 120)
      failed.push(p.kind + ' ' + p.id + '：' + why)
      console.log('  ✗ ' + p.kind + ' ' + p.id + ' 失败：' + why)
    }
  }
  console.log('\n收尾：node bili.mjs qzone public today（核对这一轮）')
  if (failed.length) {
    console.error('有 ' + failed.length + ' 条没成功；同一条别再重试：\n  ' + failed.join('\n  '))
    process.exit(6)
  }
}

// 打分：--scores "1=7,2=3" 一次打一批（左边是列表里的 # 序号或短 id），或 --id + --score 单独一条。
// 分数只写本地账本（控制台看），不碰 QQ 接口。
function publicScore() {
  const store = readPublicDay()
  const patches = []
  const bulk = args.get('scores')
  if (typeof bulk === 'string' && bulk.trim()) {
    for (const part of bulk.split(',')) {
      const m = part.trim().match(/^(#?[0-9a-fA-F]{1,24})\s*[=:：]\s*(\d{1,2})(?:\s+(.*))?$/)
      if (!m) { console.error('看不懂这一段：' + part.trim() + '（写成 1=7 或 #3=8）'); process.exit(2) }
      patches.push({ hit: m[1], score: Number(m[2]), note: (m[3] ?? '').trim() })
    }
  } else {
    const id = args.get('id')
    const score = args.get('score')
    if (!id || typeof id !== 'string') { console.error('需要 --scores "1=7,2=3" 或 --id <动态id> --score 7'); process.exit(2) }
    if (score === undefined) { console.error('需要 --score <0~10>'); process.exit(2) }
    patches.push({ hit: id, score: Number(score), note: String(args.get('note') ?? '').trim() })
  }
  if (!store.items.length) { console.error('今天还没有刷过公开动态（先跑 qzone public list --n 10）'); process.exit(2) }
  const at = new Date().toISOString()
  const done = []
  for (const p of patches) {
    const row = resolvePublicRowIn(store, p.hit)
    if (!row) { console.error('账本里没有这条：' + p.hit); process.exit(2) }
    if (!Number.isFinite(p.score) || p.score < 0 || p.score > 10) { console.error('分数要在 0~10：' + p.score); process.exit(2) }
    row.score = Math.round(p.score)
    if (p.note) row.note = String(p.note).slice(0, 120)
    row.scoredAt = at
    done.push(row)
  }
  writePublicDay(store)
  console.log('=== 打分已记下（控制台「今天刷的动态」里能看到）===')
  for (const r of done) console.log('  #' + r.order + ' [' + r.short + '] ' + (r.nick || '?') + ' → ' + r.score + ' 分' + (r.note ? '｜' + r.note : ''))
  const scored = store.items.filter((e) => e.score != null)
  console.log('\n今天已打分 ' + scored.length + '/' + store.items.length + ' 条')
  if (scored.length) {
    const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 3)
    console.log('分数最高的 3 条（点赞就点它们）：' + top.map((e) => '#' + e.order + '[' + e.short + ']' + e.score + '分').join('  '))
  }
}

// 今天刷过什么（面板同款数据），给她自己 / 主人核对用
function publicToday() {
  const store = readPublicDay()
  if (JSON_OUT) { console.log(JSON.stringify(store)); return }
  if (!store.items.length) { console.log('今天还没刷过公开动态（' + store.day + '）'); return }
  const liked = store.items.filter((e) => e.likeAt)
  const cmted = store.items.filter((e) => e.commentAt)
  const scored = store.items.filter((e) => e.score != null)
  console.log('=== 今天刷的动态（' + store.day + '）：' + store.items.length + ' 条，打分 ' + scored.length + '，赞 ' + liked.length + '，评 ' + cmted.length + ' ===')
  for (const e of store.items) {
    const marks = []
    if (e.score != null) marks.push(e.score + '分')
    if (e.likeAt) marks.push('已赞')
    if (e.commentAt) marks.push('已评')
    console.log('\n#' + e.order + ' [' + e.short + '] ' + (e.nick || '?') + (marks.length ? '  · ' + marks.join(' · ') : ''))
    console.log('  ' + oneLine(e.text, 140))
    if (e.note) console.log('  评语: ' + oneLine(e.note, 80))
    if (e.commentText) console.log('  她的评论: ' + oneLine(e.commentText, 120))
    const shots = Array.isArray(e.shots) ? e.shots.length : 0
    if (shots) console.log('  截图: ' + shots + ' 张')
  }
}

// 截图清理：默认只删「不是今天」的目录（真正的每天清空由面板/定时调用）；--all 连今天一起删。
// 文字账本不动 —— 主人要的是「图没了字还在」。
function publicShots() {
  const day = publicDay()
  const all = args.has('all')
  const removed = prunePublicShots({ all, keepDay: day })
  const dir = publicShotDir(day)
  let kept = 0
  try { kept = fs.readdirSync(dir).length } catch {}
  if (JSON_OUT) { console.log(JSON.stringify({ ok: true, day, removedDirs: removed, todayShots: kept, all })); return }
  console.log('截图清理完成：删掉 ' + removed + ' 个旧日期目录' + (all ? '（含今天）' : '') + '；今天还剩 ' + kept + ' 张（' + dir + '）')
  console.log('文字账本没有动：qzone public today 仍能看到今天刷过什么、打了多少分、赞没赞、评论了什么。')
}

// 读一张转发的 QQ 空间卡片（2026-11-24 主人要：转发里那张空间卡她得能看见内容）。
// 只读：不写账本、不改日记。
// 卡片里的链接是 mqqapi://qzoneschema/?schema=<base64>，解出来的 cellid 就是说说 id；
// 这条 id 属于「空间动态」接口（get_qzone_feed_detail），跟 detail 用的 get_qzone_msg_detail
// 是两套 id，混用会得到「数据不存在」。
async function card() {
  const url = typeof args.get('url') === 'string' ? String(args.get('url')).trim() : ''
  let tid = typeof args.get('tid') === 'string' ? String(args.get('tid')).trim() : ''
  let uin = typeof args.get('uin') === 'string' ? String(args.get('uin')).trim() : ''
  if (!tid && url) {
    const ids = qzoneIdsFromUrl(url)
    tid = ids.cellId
    uin = uin || ids.uin
  }
  if (!/^[0-9a-fA-F]{24}$/.test(tid)) {
    const msg = '需要 --tid <24 位说说 id> 或 --url <空间链接>；读不到可用的说说 id'
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, message: msg }))
    else console.error(msg)
    process.exit(2)
  }
  // 图片：主人 2026-11-24 追加「转发动态里的图片也要能读出来」——
  // 图在 feed.cell_media.media_items 里，下载到临时目录后把本地路径交给 MCP 当 image 块。
  const wantImages = args.has('images')
  const maxImages = Math.max(1, Math.min(9, Number(args.get('max-images') ?? 4) || 4))
  const done = (text, images) => {
    if (JSON_OUT) {
      console.log(JSON.stringify({ ok: true, tid, uin, text, images }))
      return
    }
    console.log(text)
    if (uin) console.log(`作者 QQ：${uin}`)
    if (images.length) console.log('图片已下载：' + images.map((x) => x.file).join('  '))
  }
  try {
    const detail = await call('get_qzone_feed_detail', { tid })
    const feed = detail?.feed
    const text = feedCardText(feed, { tid })
    if (text) {
      const images = []
      if (wantImages) {
        const urls = mediaImageUrls(feed?.cell_media?.media_items, { max: maxImages })
        for (let i = 0; i < urls.length; i += 1) {
          const got = await grabImage(urls[i], tid.slice(0, 12), i + 1)
          if (got) images.push(got)
        }
      }
      done(text, images)
      return
    }
  } catch (error) {
    const first = error instanceof Error ? error.message : String(error)
    // 兜底：老接口的 tid（msg_list 那套）偶尔也能撞上
    try {
      const data = await call('get_qzone_msg_detail', { tid, pos: 0, num: 1 })
      const body = oneLine(data?.content ?? '', 800)
      if (body) {
        done(`[空间说说] ${body}\n（这条走的是老接口：评论数、图数读不到）`, [])
        return
      }
    } catch { /* 两条都不行，下面统一报 */ }
    const msg = `这条说说打不开：${first}\n可能已经删了、只对部分人可见，或者 id 不是说说 id（24 位十六进制）。`
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, message: msg }))
    else console.error(msg)
    process.exit(1)
  }
}

async function main() {
  if (sub === 'profile') {
    const data = await call('get_qzone_profile')
    console.log(`空间名称: ${data?.name || '(未设置)'}`)
    console.log(`空间说明: ${data?.description || '(未设置)'}`)
    console.log(`主人: ${ownerQQ || '(config.ownerQQ 未设)'}`)
    return
  }

  if (sub === 'read' || sub === 'list' || sub === 'feeds') {
    const fallback = sub === 'feeds' ? 'friends' : 'mine'
    const scope = String(args.get('scope') ?? fallback)
    if (!['mine', 'owner', 'friends', 'person'].includes(scope)) {
      console.error(`--scope 只能是 mine / owner / friends / person，收到 ${scope}`)
      process.exit(2)
    }
    await scopeList(scope)
    return
  }

  if (sub === 'media') {
    await media()
    return
  }

  if (sub === 'comment-media' || sub === 'cmedia') {
    await commentsMedia()
    return
  }

  if (sub === 'card') {
    await card()
    return
  }

  if (sub === 'detail') {
    const tid = args.get('tid')
    if (!tid || typeof tid !== 'string') { console.error('需要 --tid <说说 id>'); process.exit(2) }
    await detail(tid, args.get('uin'))
    return
  }

  if (sub === 'like' || sub === 'unlike') {
    needGo()
    await react(sub)
    return
  }

  if (sub === 'comment') {
    await comment()
    return
  }

  if (sub === 'public') {
    const action = String(argv[1] ?? 'list').toLowerCase()
    if (action === 'list' || action === 'feeds') { await publicList(); return }
    if (action === 'media') { await publicMedia(); return }
    if (action === 'like' || action === 'unlike') { await publicReact(action); return }
    if (action === 'comment') { await publicComment(); return }
    if (action === 'batch' || action === 'do') { await publicBatch(); return }
    if (action === 'score' || action === 'rate') { publicScore(); return }
    if (action === 'today' || action === 'log') { publicToday(); return }
    if (action === 'shots' || action === 'prune') { publicShots(); return }
    console.error('qzone public 的子命令只有 list / media / like / unlike / comment / batch / score / today / shots，收到 ' + action)
    process.exit(2)
  }

  if (sub === 'comments' || sub === 'comment-list') {
    await commentsList()
    return
  }

  if (sub === 'uncomment' || sub === 'del-comment') {
    await uncomment()
    return
  }

  if (sub === 'delete') {
    const tid = args.get('tid')
    if (!tid || typeof tid !== 'string') { console.error('需要 --tid <说说 id>'); process.exit(2) }
    needGo()
    if (isDry) { console.log(`[dry] delete_qzone_msg tid=${tid}`); return }
    await call('delete_qzone_msg', { tid })
    logWrite({ kind: 'delete', tid })
    console.log(`已删除说说 ${tid}`)
    return
  }

  if (sub === 'post') {
    const text = args.get('text')
    if (!text || typeof text !== 'string' || !text.trim()) { console.error('需要 --text "说说正文"'); process.exit(2) }
    needGo()
    if (qz.enabled === false) { console.error('qzone.enabled=false（config.json），不发说说'); process.exit(4) }
    if (!RIGHTS.has(right)) { console.error(`ugc_right 只能是 1/4/16/64/128，收到 ${right}`); process.exit(2) }
    if ((right === 16 || right === 128) && targets.length === 0) {
      console.error(`ugc_right=${right} 必须带 --targets <QQ号,QQ号>`)
      process.exit(2)
    }
    for (const p of images) if (!fs.existsSync(p)) { console.error(`图片不存在: ${p}`); process.exit(2) }
    const limit = Number(qz.dailyLimit ?? 3)
    const used = todayCount()
    const pvPost = checkPrivacy(text, { audience: 'public' })
    if (!pvPost.ok) { console.error(privacyRejectText(pvPost.hits)); process.exit(8) }
    const body = {
      content: text,
      ugc_right: right,
      ...(targets.length ? { target_uins: targets.map(Number) } : {}),
      ...(images.length ? { images: images.map(toFileUrl) } : {}),
    }
    console.log('=== 说说 ===')
    console.log(`  正文: ${text.replace(/\n/g, ' / ').slice(0, 120)}`)
    console.log(`  权限: ${right}（${RIGHT_LABEL[right]}）`)
    console.log(`  图片: ${images.length ? images.join(', ') : '(无)'}`)
    console.log(`  今日已发: ${used}/${limit}`)
    if (used >= limit) { console.error(`\n✗ 今日说说已达上限 ${limit} 条（qzone.dailyLimit）`); process.exit(6) }
    if (isDry) { console.log('\n[dry] 将要发送的请求：'); console.log(JSON.stringify(body, null, 2)); return }
    const data = await call('send_qzone_msg', body)
    logWrite({ kind: 'post', tid: data?.tid, right, images: images.length, text: text.slice(0, 200) })
    console.log(`\n✓ 已发布，tid=${data?.tid}  时间=${fmtTime(data?.time)}`)
    console.log(`  删除用: node bili.mjs qzone delete --tid ${data?.tid} --go`)
    return
  }

  console.error(`未知子命令: ${sub}（profile / post / read / media / comment-media / detail / comments / uncomment / like / unlike / comment / delete / public）`)
  process.exit(2)
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
