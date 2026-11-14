#!/usr/bin/env node
/**
 * 用主人自己的 B 站账号看 B 站 —— 全部只读（GET），不发任何写请求。
 *
 *   node bili.mjs my account
 *   node bili.mjs my history    [--limit 10] [--q 关键词] [--days 7]
 *   node bili.mjs my favorites  [--limit 5] [--folders 3]
 *   node bili.mjs my following  [--limit 20]
 *   node bili.mjs my updates    [--limit 10]
 *   node bili.mjs my recommend  [--limit 10]
 *
 * 凭据：owner-credentials.json；单账号用户（self.mid === owner.mid）自动复用 credentials.json。
 * 用途：主人说「用我的号看看 B 站 / 我在看什么 / 我的收藏 / 我关注的人 / 首页推荐」。
 * 边界：用主人号发言是被禁止的（lib/bili-qr-login.mjs:9-13），这里只读。
 */
import crypto from 'node:crypto'
import { resolveOwnerCredentials, ownerCredentialHint } from '../lib/owner-account.mjs'

const argv = process.argv.slice(2)
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'account'
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const next = argv[i + 1]
  args.set(a.slice(2), next && !next.startsWith('--') ? argv[++i] : true)
}

const SUBS = ['account', 'history', 'favorites', 'following', 'updates', 'recommend']
if (!SUBS.includes(sub)) {
  console.error('usage: my <' + SUBS.join('|') + '> [--limit N] [--folders N] [--q 词] [--days N]')
  process.exit(2)
}

const LIMIT = Math.max(1, Math.min(50, Number(args.get('limit')) || (sub === 'following' ? 20 : 10)))
const FOLDERS = Math.max(1, Math.min(10, Number(args.get('folders')) || 3))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REF = 'https://www.bilibili.com/'

const found = resolveOwnerCredentials()
if (!found) {
  console.error('✗ ' + ownerCredentialHint())
  process.exit(3)
}
const cred = found.cred
const MID = String(found.mid || cred.mid || '')
const COOKIE = 'SESSDATA=' + cred.sessdata + '; bili_jct=' + cred.bili_jct + '; buvid3=' + (cred.buvid3 ?? '')

async function getJson(url, referer = REF) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, referer, cookie: COOKIE },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    } catch (error) {
      lastError = error
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new Error('请求失败')
}

function mustOk(data, what) {
  if (!data || data.code !== 0) {
    throw new Error(what + '失败：code=' + (data?.code ?? '?') + ' ' + (data?.message ?? ''))
  }
  return data.data ?? {}
}

const pad = (n) => String(n).padStart(2, '0')
function fmtTime(ms) {
  const d = new Date(Number(ms))
  if (!Number.isFinite(d.getTime())) return '时间未知'
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿'
  if (v >= 10000) return (v / 10000).toFixed(1) + '万'
  return String(v)
}
function fmtDur(sec) {
  const n = Math.round(Number(sec) || 0)
  if (!n) return ''
  return n >= 3600
    ? Math.floor(n / 3600) + ':' + pad(Math.floor((n % 3600) / 60)) + ':' + pad(n % 60)
    : Math.floor(n / 60) + ':' + pad(n % 60)
}
function clip(text, max = 42) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}
const who = (found.name || cred.name || '主人') + '（mid ' + MID + '）' + (found.shared ? ' · 与示例账号同一个号' : '')

// WBI 签名（推荐流要）
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
let mixinCache = ''
async function wbiMixin() {
  if (mixinCache) return mixinCache
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav')
  const img = nav?.data?.wbi_img?.img_url ?? ''
  const subUrl = nav?.data?.wbi_img?.sub_url ?? ''
  const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
  const raw = keyOf(img) + keyOf(subUrl)
  mixinCache = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  return mixinCache
}
function signedQuery(params, mixin) {
  const wts = Math.round(Date.now() / 1000)
  const clean = (v) => String(v).replace(/[!'()*]/g, '')
  const merged = { ...params, wts }
  const q = Object.keys(merged).sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(clean(merged[k])))
    .join('&')
  return q + '&w_rid=' + crypto.createHash('md5').update(q + mixin).digest('hex')
}

async function showAccount() {
  const nav = await getJson('https://api.bilibili.com/x/web-interface/nav')
  if (!nav || nav.code !== 0 || !nav.data?.isLogin) {
    throw new Error('登录态无效：code=' + (nav?.code ?? '?') + ' ' + (nav?.message ?? '') + '（需要重新扫码）')
  }
  const d = nav.data
  console.log('账号：' + d.uname + '（mid ' + d.mid + '） Lv' + (d.level_info?.level ?? '?') + ' · 硬币 ' + (d.coins ?? 0) + ' · 关注 ' + (d.friend ?? '?') + ' · 粉丝 ' + (d.follower ?? '?'))
  console.log('手机绑定：' + (d.mobile_verified ? '是' : '否') + ' · 大会员：' + (d.vipStatus ? '是' : '否') + (found.shared ? ' · 与她的号是同一个' : ''))
}

async function showHistory() {
  const q = String(args.get('q') ?? '').trim().toLowerCase()
  const days = Number(args.get('days')) || 0
  const ps = q || days ? 30 : Math.min(30, LIMIT)
  const data = mustOk(
    await getJson('https://api.bilibili.com/x/web-interface/history/cursor?ps=' + ps + '&pn=1'),
    '读观看历史'
  )
  let list = data.list ?? []
  if (q) list = list.filter((it) => ((it.title ?? '') + ' ' + (it.author_name ?? '')).toLowerCase().includes(q))
  if (days) {
    const since = Date.now() / 1000 - days * 86400
    list = list.filter((it) => Number(it.view_at) >= since)
  }
  list = list.slice(0, LIMIT)
  const filter = [q ? '含"' + q + '"' : '', days ? '最近 ' + days + ' 天' : ''].filter(Boolean).join(' · ')
  console.log(who + ' 的观看历史' + (filter ? '（' + filter + '）' : '') + '（' + list.length + ' 条）：')
  if (!list.length) console.log('  （没有符合条件的记录）')
  list.forEach((item, i) => {
    const title = item.title || item.long_title || item.show_title || '(无标题)'
    const bvid = item.bvid || item.history?.bvid || ''
    const progress = Number(item.progress)
    const state = progress < 0 || item.is_finish ? '看完' : progress > 0 ? Math.min(100, Math.round(progress / 10)) + '%' : '刚点开'
    console.log('  ' + (i + 1) + '. ' + clip(title) + ' ｜ ' + clip(item.author_name, 16) + ' ｜ ' + bvid + ' ｜ ' + state + ' ｜ ' + fmtTime(Number(item.view_at) * 1000))
  })
}

async function showFavorites() {
  const data = mustOk(
    await getJson('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + MID),
    '读收藏夹'
  )
  const folders = (data.list ?? []).filter((f) => Number(f.media_count) > 0)
  const total = folders.reduce((sum, f) => sum + (Number(f.media_count) || 0), 0)
  console.log(who + ' 的收藏夹（' + folders.length + ' 个 · 共 ' + total + ' 个视频）：')
  if (!folders.length) console.log('  （空）')
  for (const folder of folders.slice(0, FOLDERS)) {
    console.log('  ▸ ' + folder.title + '（' + folder.media_count + '）')
    const items = mustOk(
      await getJson('https://api.bilibili.com/x/v3/fav/resource/list?media_id=' + folder.id + '&pn=1&ps=' + LIMIT + '&platform=web'),
      '读收藏内容'
    )
    for (const media of (items.medias ?? [])) {
      if (media.title === '已失效视频') continue
      console.log('     · ' + clip(media.title) + ' ｜ ' + clip(media.upper?.name, 14) + ' ｜ ' + (media.bvid ?? ''))
    }
  }
  if (folders.length > FOLDERS) {
    console.log('  …还有 ' + (folders.length - FOLDERS) + ' 个收藏夹：' + folders.slice(FOLDERS).map((f) => f.title).join('、'))
  }
}

async function showFollowing() {
  const data = mustOk(
    await getJson('https://api.bilibili.com/x/relation/followings?vmid=' + MID + '&pn=1&ps=50'),
    '读关注列表'
  )
  const list = data.list ?? []
  console.log(who + ' 关注的人（共 ' + (data.total ?? list.length) + ' 个，先列 ' + Math.min(list.length, LIMIT) + ' 个）：')
  list.slice(0, LIMIT).forEach((u, i) => {
    console.log('  ' + (i + 1) + '. ' + clip(u.uname, 20) + (u.sign ? ' ｜ ' + clip(u.sign, 26) : ''))
  })
}

async function showUpdates() {
  const data = mustOk(
    await getJson('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video&page=1', 'https://t.bilibili.com/'),
    '读关注动态'
  )
  const items = (data.items ?? []).slice(0, LIMIT)
  console.log('关注动态（' + items.length + ' 条视频更新）：')
  if (!items.length) console.log('  （关注的人今天没更新视频）')
  items.forEach((item, i) => {
    const m = item.modules ?? {}
    const author = m.module_author?.name ?? '?'
    const arch = m.module_dynamic?.major?.archive ?? null
    const title = arch?.title ?? m.module_dynamic?.desc?.text ?? '(无标题)'
    const bvid = arch?.bvid ?? ''
    const view = arch?.stat?.view
    const at = fmtTime(Number(m.module_author?.pub_ts ?? 0) * 1000)
    console.log('  ' + (i + 1) + '. [' + at + '] ' + clip(author, 14) + '：' + clip(title) + ' ｜ ' + bvid + (view != null ? ' ｜ ' + fmtCount(view) + '播放' : ''))
  })
}

async function showRecommend() {
  const mixin = await wbiMixin()
  const q = signedQuery({
    web_location: '1430650',
    y_num: '5',
    fresh_type: '3',
    feed_version: 'V8',
    fresh_idx: '1',
    fresh_idx_1h: '1',
    brush: '0',
    homepage_ver: '1',
    ps: String(LIMIT),
  }, mixin)
  const data = mustOk(
    await getJson('https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?' + q),
    '读首页推荐'
  )
  const items = (data.item ?? []).filter((it) => it?.bvid).slice(0, LIMIT)
  console.log(who + ' 的 B 站首页推荐（算法按这个号的习惯给的）：')
  if (!items.length) console.log('  （空的，可能是风控或今天没刷新）')
  items.forEach((item, i) => {
    const extra = [item.owner?.name ? clip(item.owner.name, 14) : '', item.stat?.view != null ? fmtCount(item.stat.view) + '播放' : '', fmtDur(item.duration)].filter(Boolean).join(' ｜ ')
    console.log('  ' + (i + 1) + '. ' + clip(item.title, 46) + ' ｜ ' + extra + ' ｜ ' + item.bvid)
  })
}

const runners = { account: showAccount, history: showHistory, favorites: showFavorites, following: showFollowing, updates: showUpdates, recommend: showRecommend }
try {
  await runners[sub]()
} catch (error) {
  console.error('✗ ' + (error?.message ?? error))
  process.exit(4)
}
