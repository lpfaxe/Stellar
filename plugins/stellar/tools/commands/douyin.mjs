// 看一条抖音分享链接：不抽帧，只读页面上的文案/作者/数据/热评（和 bili.mjs link 一个思路）。
//
//   node bili.mjs douyin "7.32 复制打开抖音… https://v.douyin.com/xxxx/"
//   node bili.mjs douyin https://www.douyin.com/video/7705700569016519951 --comments 8
//   node bili.mjs douyin <url> --json
//
// 为什么必须开浏览器：抖音网页对无签名请求只给空壳（_ROUTER_DATA / RENDER_DATA 里没有正文），
// 旧接口 iesdouyin/web/api/v2/aweme/iteminfo 已返回空，aweme/detail 直接 403 Argus。
// 无头 Edge 渲染后 DOM 里 data-e2e 标记齐全，读文本即可，不用下载视频、不用 ffmpeg。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean)

const argv = process.argv.slice(2)
const input = argv.find((a) => !a.startsWith('--'))
const wantJson = argv.includes('--json')
const commentsArg = argv.find((a) => a.startsWith('--comments'))
const commentsN = clamp(Number((commentsArg || '').split('=')[1] || (argv[argv.indexOf(commentsArg) + 1] ?? 5)) || 5, 0, 20)
const timeoutArg = argv.find((a) => a.startsWith('--timeout'))
const timeoutMs = clamp(Number((timeoutArg || '').split('=')[1] || 90000) || 90000, 15000, 180000)

if (!input) {
  console.error('用法: node bili.mjs douyin "<抖音分享文案或链接>" [--comments N] [--json] [--timeout ms]')
  process.exit(2)
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n) || lo)) }

function urlFrom(text) {
  const m = /https?:\/\/[^\s"'<>，。）)]+/.exec(text || '')
  if (m) return m[0]
  const bare = /\b(?:v\.douyin\.com\/[A-Za-z0-9_-]+|www\.douyin\.com\/video\/\d+)/.exec(text || '')
  return bare ? 'https://' + bare[0] : ''
}

function stripTags(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

function cleanLines(text) {
  return text.split('\n').map((s) => s.trim()).filter((s) => s
    && !s.startsWith('<')
    && !/^(data-|class=|style=)/.test(s)
    && s.length <= 160
    && !/^[\d.,:+-]{24,}$/.test(s))
}

function pickBlock(html, name, len = 5000) {
  const i = html.indexOf('data-e2e="' + name + '"')
  if (i < 0) return []
  return cleanLines(stripTags(html.slice(i, i + len)))
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function parseDom(html) {
  const title = (() => {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    return m ? decodeEntities(m[1].trim()).replace(/\s*-\s*抖音\s*$/, '') : ''
  })()
  const descMeta = (() => {
    const m = /<meta[^>]+name="description"[^>]+content="([^"]*)"/i.exec(html) || /<meta[^>]+content="([^"]*)"[^>]+name="description"/i.exec(html)
    return m ? decodeEntities(m[1]) : ''
  })()

  const info = pickBlock(html, 'detail-video-info', 6000)
  const caption = (info.find((s) => s !== '展开' && s.length > 1) || title || '').slice(0, 1200)

  const user = pickBlock(html, 'user-info', 3000)
  const nick = user[0] || ''
  const fans = (() => { const i = user.indexOf('粉丝'); return i >= 0 ? user[i + 1] || '' : '' })()
  const likes = (() => { const i = user.indexOf('获赞'); return i >= 0 ? user[i + 1] || '' : '' })()
  const douyinId = (() => { const m = /抖音号[:：]\s*([A-Za-z0-9_.-]+)/.exec(user.join(' ')); return m ? m[1] : '' })()

  const publish = (() => {
    const m = /发布时间[:：]\s*([\d-]{8,12}\s+[\d:]{3,8})/.exec(stripTags(html))
    return m ? m[1].trim() : ''
  })()

  const diggSeg = (() => {
    const i = html.indexOf('data-e2e="video-player-digg"')
    return i < 0 ? '' : html.slice(i, i + 2500)
  })()
  const diggNums = (() => {
    const out = []
    for (const m of diggSeg.matchAll(/>([^<>]{1,40})</g)) {
      for (const n of (m[1].match(/\d+(?:\.\d+)?[万亿]?/g) || [])) if (!out.includes(n)) out.push(n)
      if (out.length >= 4) break
    }
    return out.slice(0, 4)
  })()
  const stats = { like: diggNums[0] || '', comment: diggNums[1] || '', collect: diggNums[2] || '', share: diggNums[3] || '' }

  // 评论：按 comment-item 切段，每段前面是昵称、然后是内容、时间·地区、点赞数
  const comments = []
  if (commentsN > 0) {
    const marker = 'data-e2e="comment-item"'
    let pos = 0
    while (comments.length < commentsN) {
      const i = html.indexOf(marker, pos)
      if (i < 0) break
      pos = i + marker.length
      const lines = cleanLines(stripTags(html.slice(i, i + 6000)))
      const body = lines.filter((s) => s !== marker && !s.includes('data-e2e=') && s !== '展开' && s !== '...' && s !== '·')
      const nickLine = body[0] || ''
      const metaIdx = body.findIndex((s) => /^(刚刚|\d+[秒分时天周月年]前|\d{1,2}-\d{1,2}|昨天|前天)/.test(s))
      const meta = metaIdx >= 0 ? body[metaIdx] : ''
      const content = body.slice(1, metaIdx >= 0 ? metaIdx : body.length).filter((s) => !/^\d+(\.\d+)?[万]?$/.test(s)).join(' ').slice(0, 300)
      const likeN = metaIdx >= 0 && body[metaIdx + 1] && /^\d+(\.\d+)?万?$/.test(body[metaIdx + 1]) ? body[metaIdx + 1] : ''
      if (content) comments.push({ user: nickLine, text: content, meta, likes: likeN })
    }
  }

  return { title, descMeta, caption, author: nick, fans, likes, douyinId, publish, stats, comments }
}

async function resolveUrl(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36' } })
    return res.url || url
  } catch { return url }
}

function findEdge() {
  for (const p of EDGE_CANDIDATES) { try { if (p && fs.existsSync(p)) return p } catch {} }
  return ''
}

function render(url, edge) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-douyin-'))
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + profile,
      '--virtual-time-budget=15000',
      '--dump-dom', url,
    ]
    const child = spawn(edge, args, { windowsHide: true })
    const chunks = []
    let size = 0
    let err = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeoutMs)
    child.stdout.on('data', (b) => { if (size < 12 * 1024 * 1024) { chunks.push(b); size += b.length } })
    child.stderr.on('data', (b) => { if (err.length < 4000) err += b.toString() })
    child.on('error', (e) => { clearTimeout(timer); cleanup(); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      cleanup()
      const html = Buffer.concat(chunks).toString('utf8')
      if (!html || html.length < 2000) return reject(new Error('页面没渲染出内容（' + (code ?? '?') + '）' + (err ? '：' + err.split('\n')[0].slice(0, 200) : '')))
      resolve(html)
    })
    function cleanup() { try { fs.rmSync(profile, { recursive: true, force: true }) } catch {} }
  })
}

const share = urlFrom(input)
if (!share) {
  console.error('没在输入里找到抖音链接。把分享文案整段发我（含 https://v.douyin.com/… 那种）。')
  process.exit(3)
}
const edge = findEdge()
if (!edge) {
  console.error('没找到 Edge/Chrome，抖音页面必须用浏览器渲染才能读到正文。可设环境变量 EDGE_PATH 指过去。')
  process.exit(4)
}

const finalUrl = await resolveUrl(share)
const idMatch = /(?:video|note|slides)\/(\d{6,})/.exec(finalUrl) || /(?:video|note|slides)\/(\d{6,})/.exec(share)
const videoId = idMatch ? idMatch[1] : ''
const canonical = videoId ? 'https://www.douyin.com/video/' + videoId : finalUrl

let parsed = null
let lastErr = null
const attempts = [share, finalUrl, canonical].filter((v, i, a) => v && a.indexOf(v) === i)
for (const target of attempts) {
  try {
    const html = await render(target, edge)
    const out = parseDom(html)
    if (out.caption || out.author || out.comments.length) { parsed = out; break }
    lastErr = new Error('渲染成功但页面里没有正文（可能是登录墙/风控页）')
  } catch (e) { lastErr = e }
}

if (!parsed) {
  console.error('抖音页面没读到内容：' + (lastErr?.message || '未知原因'))
  console.error('链接：' + share + (finalUrl !== share ? ' → ' + finalUrl : ''))
  process.exit(4)
}

const result = {
  ok: true,
  url: canonical,
  shareUrl: share,
  id: videoId,
  title: parsed.title,
  caption: parsed.caption,
  author: { name: parsed.author, fans: parsed.fans, likes: parsed.likes, douyinId: parsed.douyinId },
  publish: parsed.publish,
  stats: parsed.stats,
  comments: parsed.comments,
  note: '只读了页面上的文案/作者/数据/热评，没有下载视频、没有抽帧；画面内容看不到，只能按文案和评论判断。',
}

if (wantJson) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

const fmt = []
fmt.push('抖音｜' + (parsed.caption ? parsed.caption.split('\n')[0].slice(0, 70) : '（无文案）'))
if (parsed.author) fmt.push('作者 ' + parsed.author + (parsed.fans ? ' · 粉丝 ' + parsed.fans : '') + (parsed.likes ? ' · 获赞 ' + parsed.likes : '') + (parsed.douyinId ? ' · 抖音号 ' + parsed.douyinId : ''))
const statLine = [parsed.publish ? '发布 ' + parsed.publish : '', parsed.stats.like ? '点赞 ' + parsed.stats.like : '', parsed.stats.comment ? '评论 ' + parsed.stats.comment : '', parsed.stats.collect ? '收藏 ' + parsed.stats.collect : '', parsed.stats.share ? '分享 ' + parsed.stats.share : ''].filter(Boolean)
if (statLine.length) fmt.push(statLine.join(' · '))
if (parsed.caption) fmt.push('文案：' + parsed.caption.replace(/\n+/g, ' ').slice(0, 900))
if (parsed.comments.length) {
  fmt.push('热评：')
  parsed.comments.forEach((c, i) => fmt.push('  ' + (i + 1) + '. ' + (c.user || '匿名') + '：' + c.text + (c.meta ? '（' + c.meta + (c.likes ? ' · 赞 ' + c.likes : '') + '）' : '')))
}
fmt.push('链接 ' + canonical)
fmt.push('（只读文案与评论，没有抽帧；画面内容看不到）')
console.log(fmt.join('\n'))