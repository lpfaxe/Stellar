// webimg.mjs —— 她自己上网找图（owner 2026-11-11 22:25 要求）。
//
// 用法：
//   node bili.mjs webimg search "雾凇 风景" --n 4 [--json]
//   node bili.mjs webimg list [--json]
//   node bili.mjs webimg del --name <文件名>    （她删 → 控制台会留下记录）
//   node bili.mjs webimg clear                  （清空今天）
//   node bili.mjs webimg path                   （今天的目录）
//
// 为什么是 Bing 的 async 图片接口：不需要 key、返回的 HTML 里每张图都有 murl 直链，
// 实测一次 20 多条；用公开的 Wikimedia 之类当备用没必要（她的图多是「找个氛围图」）。
// 图片存到 ~/.dsh/stellar/web-images/<日期>/，与 B站封面池（image-pool）**分开**。
import fs from 'node:fs'
import path from 'node:path'
import { grabImage } from '../lib/image-fetch.mjs'
import {
  MAX_PER_DAY, addWebImage, clearWebImages, dayDir, dayKey, deleteWebImage, listWebImages, rootDir,
} from '../lib/web-images.mjs'

// bili.mjs 用 spawnSync 透传参数：argv = [node, webimg.mjs, <action>, ...]
const raw = process.argv.slice(2)
const action = String(raw[0] && !String(raw[0]).startsWith('--') ? raw[0] : 'list')
const argv = raw.slice(raw[0] && !String(raw[0]).startsWith('--') ? 1 : 0)
const args = new Map()
const flags = new Set()
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) { positional.push(a); continue }
  const key = a.slice(2)
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) { flags.add(key); continue }
  args.set(key, next)
  i += 1
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

function human(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + 'MB'
  if (n >= 1024) return Math.round(n / 1024) + 'KB'
  return n + 'B'
}

async function bingImages(query, want) {
  const out = []
  const seen = new Set()
  for (let page = 0; page < 3 && out.length < want * 3; page += 1) {
    const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(query)
      + '&first=' + (page * 20) + '&count=20&mmasync=1&mkt=zh-CN'
    let html = ''
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' } })
      if (!r.ok) break
      html = await r.text()
    } catch (e) {
      // 网络断了就用手上已有的（报错留给上层说清楚）
      if (!out.length) throw new Error('搜图失败：' + (e?.message ?? e))
      break
    }
    for (const m of html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)) {
      const u = String(m[1] || '').replace(/&amp;/g, '&')
      if (!/^https?:\/\//i.test(u)) continue
      if (/\.(svg|gif)(\?|$)/i.test(u)) continue
      if (seen.has(u)) continue
      seen.add(u)
      out.push(u)
      if (out.length >= want * 3) break
    }
  }
  return out
}

async function search() {
  const query = String(args.get('q') ?? args.get('query') ?? args.get('kw') ?? positional[0] ?? '').trim()
  if (!query) { console.error('用法: node bili.mjs webimg search "关键词" --n 4'); process.exit(2) }
  const want = Math.max(1, Math.min(10, Number(args.get('n') ?? 4) || 4))
  const before = listWebImages().images.length
  const room = Math.max(0, MAX_PER_DAY - before)
  if (room <= 0) {
    console.log('今天的图已经放满 ' + MAX_PER_DAY + ' 张了（明天自动清空；要腾地方就先 webimg del 或 clear）。')
    process.exit(0)
  }
  const take = Math.min(want, room)
  const urls = await bingImages(query, take * 2)
  const saved = []
  for (const u of urls) {
    if (saved.length >= take) break
    let got = null
    try { got = await grabImage(u, 'web', saved.length + 1, 'https://www.bing.com/') } catch { got = null }
    if (!got?.file) continue
    const added = addWebImage(got.file, {
      origin: 'web', source: 'bing', query, title: query, url: u, by: 'her',
    })
    try { fs.rmSync(got.file, { force: true }) } catch {}
    if (!added.ok) { console.log('（这张没存下：' + added.reason + '）'); continue }
    saved.push({ name: added.name, file: added.file, bytes: added.bytes, url: u })
  }
  if (flags.has('json')) {
    // images 字段和 list 对齐：MCP 那边两种 action 用同一套解析（saved 是历史字段名）
    console.log(JSON.stringify({ ok: true, query, requested: take, saved, images: saved, count: before + saved.length, dir: dayDir(), max: MAX_PER_DAY }))
    return
  }
  console.log('搜「' + query + '」→ 存了 ' + saved.length + ' 张（今天共 ' + (before + saved.length) + '/' + MAX_PER_DAY + ' 张）')
  for (const s of saved) console.log('  🖼 ' + s.file + '  [' + human(s.bytes) + ']')
  if (!saved.length) console.log('（一张都没下下来：可能是图源拦了，换个说法再试；别死磕）')
}

function showList() {
  const d = listWebImages()
  if (flags.has('json')) { console.log(JSON.stringify({ ok: true, ...d })); return }
  console.log('今天的网图（' + d.day + '）：' + d.images.length + '/' + d.max + ' 张 → ' + d.dir)
  for (const it of d.images) {
    const tags = [it.by === 'her' ? '她找的' : '', it.title || ''].filter(Boolean).join(' · ')
    console.log('  ' + it.name + '  [' + human(it.bytes) + ']' + (tags ? '  ' + tags : ''))
  }
  if (d.deletes.length) {
    console.log('最近删掉的：')
    for (const r of d.deletes.slice(0, 5)) console.log('  ' + r.name + '  由 ' + (r.by || '?') + ' 删于 ' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }))
  }
}

function run() {
  if (action === 'list' || action === 'ls') return showList()
  if (action === 'path') { console.log(dayDir()); return }
  if (action === 'search' || action === 'find' || action === 'get') return search()
  if (action === 'del' || action === 'rm') {
    const name = String(args.get('name') ?? args.get('id') ?? positional[0] ?? '')
    if (!name) { console.error('用法: node bili.mjs webimg del --name <文件名>'); process.exit(2) }
    const r = deleteWebImage(name, { by: String(args.get('by') ?? 'her') })
    if (!r.ok) { console.error('没删成：' + r.reason); process.exit(1) }
    console.log('已删 ' + r.name + '（控制台会看到这条记录）')
    return
  }
  if (action === 'clear') {
    const r = clearWebImages({ by: String(args.get('by') ?? 'her') })
    console.log('已清空 ' + r.day + ' 的网图（' + r.removed + ' 张）')
    return
  }
  console.error('未知子命令：' + action + '（search / list / del / clear / path）')
  process.exit(2)
}

// 注意：run() 里大部分子命令是同步的，返回值是 undefined —— 不能直接 .catch（会 TypeError）。
Promise.resolve()
  .then(run)
  .catch((e) => { console.error('webimg 失败：' + (e?.message ?? e)); process.exit(1) })