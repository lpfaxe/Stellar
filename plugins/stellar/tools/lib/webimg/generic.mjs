// generic.mjs —— 普通「找张图」（风景/物品/表情包/插图）。
//
// 不再按 Bing 的网页顺序直接下前 N 张：先按标题/来源粗排，下载后按真实像素、
// 比例、体积精排，只把够清晰的交出去。判断「图里是什么」仍然靠模型自己看
// （工具会把前两张附在结果里），这里只保证「清晰度与来源不拖后腿」。
//
// 2026-11-27：增加 preload 两阶段模式 —— 候选 100 条、下载最多 24 张，
// 全部交给调用方建联系表；此时**不删临时文件、不存 web-images**。
import fs from 'node:fs'
import { grabImage } from '../image-fetch.mjs'
import { inspectImageFile } from './image-meta.mjs'
import { acceptableImage, isTrustedProductHost, preRank, rankDownloaded } from './rank.mjs'
import { imageSearch } from './search.mjs'

export async function searchGeneric(query, { n = 3, minSide = 500, timeoutMs = 60000, preload = 0 } = {}) {
  const deep = Number(preload) > 0
  const search = await imageSearch(query, {
    count: deep ? Math.max(60, Number(preload)) : 30,
    pages: deep ? Math.min(5, Math.max(2, Math.ceil(Number(preload) / 25))) : 3,
    timeoutMs: 15000
  })
  if (!search.ok) return { ok: false, code: 'NO_CANDIDATES', items: [], error: search.error, hint: '换个更具体的词再试（加主体/场景/颜色），或直接生图。' }
  const candidates = preRank(search.candidates, { query, trustedHost: isTrustedProductHost }).slice(0, deep ? 30 : 24)
  const deadline = Date.now() + Math.max(deep ? 90000 : 15000, timeoutMs)
  const maxDownload = deep ? 24 : 16
  const downloaded = []
  for (const c of candidates) {
    if (downloaded.length >= maxDownload || Date.now() > deadline - 3000) break
    const referer = c.page && /^https?:\/\//i.test(c.page) ? c.page : 'https://image.baidu.com/'
    const got = await grabImage(c.url, 'web', downloaded.length + 1, referer)
    if (!got?.file) continue
    let info = null
    try { info = inspectImageFile(got.file) } catch { info = null }
    if (!info?.ok) { try { fs.rmSync(got.file, { force: true }) } catch {} ; continue }
    const item = { ...c, ...info, file: got.file }
    const check = acceptableImage(item, { minSide, minBytes: 15000, ratioMin: 0.25, ratioMax: 3.4 })
    if (!check.ok) { try { fs.rmSync(item.file, { force: true }) } catch {} ; continue }
    downloaded.push(item)
  }
  if (!downloaded.length) {
    return { ok: false, code: 'NO_CANDIDATES', items: [], error: '搜到的图都太糊/太小/比例不对', hint: '换个说法或指定更常见的场景再试。' }
  }
  const ranked = rankDownloaded(downloaded, { query, minSide, trustedHost: isTrustedProductHost })
  if (deep) {
    return {
      ok: true,
      preload: true,
      code: '',
      items: ranked,
      error: '',
      engine: search.engine,
      stats: { candidates: search.candidates.length, downloaded: downloaded.length, kept: ranked.length },
      note: '预加载：还没写进今天的 30 张，等你在联系表上挑完再存。'
    }
  }
  const items = ranked.slice(0, Math.max(1, n))
  // ranked 是 {...it} 的新对象：不能拿 includes 判断，否则会把保留的图也删掉。
  const keep = new Set(items.map((x) => x.file))
  for (const it of downloaded) if (!keep.has(it.file)) { try { fs.rmSync(it.file, { force: true }) } catch {} }
  return { ok: true, code: '', items, error: '', engine: search.engine, note: '按清晰度和来源排序，已过滤掉缩略图与比例异常的图。' }
}
