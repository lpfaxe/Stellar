// product.mjs —— 药品/试剂「实物包装图」的候选收集与校验。
//
// 和结构式不同，包装图没有唯一 ID：同名药有不同厂家、规格、新旧包装。
// 所以这里只做两件事：
//   1) 尽量找到「来源可信 + 分辨率够」的候选（厂家/监管库优先）；
//   2) 用 OCR 校验包装上是否同时有药名和规格，命中才标 verified。
// 没命中不假装对：返回候选 + 明确的 unverified 文案，让模型照实说。
import fs from 'node:fs'
import path from 'node:path'
import { grabImage } from '../image-fetch.mjs'
import { inspectImageFile } from './image-meta.mjs'
import { acceptableImage, isTrustedProductHost, preRank, rankDownloaded } from './rank.mjs'
import { imageSearch } from './search.mjs'
import { verifyPackaging } from './verify.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

export function buildProductQuery(input = {}) {
  const parts = []
  const add = (v) => { const s = String(v || '').trim(); if (s && !parts.includes(s)) parts.push(s) }
  add(input.name)
  add(input.brand)
  add(input.nameEn)
  add(input.strength)
  add(input.manufacturer)
  add(input.dosageForm)
  add(input.query)
  if (!parts.some((p) => /药盒|包装|说明书|盒/.test(p))) add('药盒')
  return parts.join(' ')
}

function decode(text) {
  return String(text || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

export function extractOgImages(html, baseUrl) {
  const out = []
  const push = (raw) => {
    let u = decode(raw).trim()
    if (!u) return
    try { u = new URL(u, baseUrl).toString() } catch { return }
    if (!/^https?:\/\//i.test(u)) return
    if (!out.includes(u)) out.push(u)
  }
  for (const m of String(html || '').matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi)) {
    const c = /content=["']([^"']+)["']/i.exec(m[0])
    if (c) push(c[1])
  }
  for (const m of String(html || '').matchAll(/"image"\s*:\s*("([^"]+)"|\[([^\]]+)\])/gi)) {
    const raw = m[1]
    if (raw.startsWith('"')) push(raw.slice(1, -1))
    else for (const x of raw.matchAll(/"([^"]+)"/g)) push(x[1])
  }
  return out.slice(0, 4)
}

async function fetchPageImages(pageUrl, { timeoutMs = 10000 } = {}) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    timer.unref?.()
    const res = await fetch(pageUrl, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return []
    const html = await res.text()
    return extractOgImages(html, pageUrl)
  } catch { return [] }
}

async function downloadCandidate(c) {
  const got = await grabImage(c.url, 'prod', 1, c.page || 'https://www.bing.com/')
  if (!got?.file) return null
  let info = null
  try { info = inspectImageFile(got.file) } catch { info = null }
  if (!info?.ok) { try { fs.rmSync(got.file, { force: true }) } catch {} ; return null }
  return { ...c, ...info, file: got.file, bytes: info.bytes }
}

function cleanup(list) {
  for (const it of list) { try { fs.rmSync(it.file, { force: true }) } catch {} }
}

/**
 * 找包装图。返回的 file 都在临时目录，调用方决定存不存。
 * @returns {Promise<{ok:boolean, code?:string, items:Array, verified:boolean, note:string, error?:string, hint?:string}>}
 */
export async function searchProduct(input = {}, { n = 3, timeoutMs = 90000, preload = 0 } = {}) {
  const deep = Number(preload) > 0
  const deadline = Date.now() + Math.max(deep ? 120000 : 20000, timeoutMs)
  const query = buildProductQuery(input)
  const search = await imageSearch(query, {
    count: deep ? Math.max(60, Number(preload)) : 28,
    pages: deep ? Math.min(5, Math.max(2, Math.ceil(Number(preload) / 25))) : 3,
    timeoutMs: 20000
  })
  if (!search.ok) return { ok: false, code: 'NO_CANDIDATES', items: [], verified: false, note: '', error: search.error, hint: '换个说法（加厂家/规格），或只给通用名。' }
  let candidates = preRank(search.candidates, { query, trustedHost: isTrustedProductHost })
  // 先用来源页的 og:image 补几条「官方主图」；失败不影响主流程。
  const pages = candidates.filter((c) => c.page && isTrustedProductHost(c.host)).slice(0, 4)
  for (const c of pages) {
    if (Date.now() > deadline - 20000) break
    const imgs = await fetchPageImages(c.page)
    for (const url of imgs) candidates.unshift({ url, page: c.page, title: c.title, host: c.host, thumbnail: '', preScore: 100 })
  }
  const seen = new Set()
  candidates = candidates.filter((c) => { if (seen.has(c.url)) return false; seen.add(c.url); return true }).slice(0, deep ? 30 : 20)

  const downloaded = []
  for (const c of candidates) {
    if (Date.now() > deadline - 8000 || downloaded.length >= (deep ? 24 : 12)) break
    const got = await downloadCandidate(c)
    if (!got) continue
    const check = acceptableImage(got, { minSide: 600, minBytes: 20000, ratioMin: 0.4, ratioMax: 2.6 })
    if (!check.ok) { try { fs.rmSync(got.file, { force: true }) } catch {} ; continue }
    downloaded.push(got)
  }
  if (!downloaded.length) {
    return { ok: false, code: 'NO_CANDIDATES', items: [], verified: false, note: '', error: '找到的图都太糊/太小/比例不对', hint: '给厂家名或商品名再试，或只查结构式。' }
  }
  const ranked = rankDownloaded(downloaded, { query, minSide: 600, trustedHost: isTrustedProductHost })
  const verified = []
  const unverified = []
  const ocrLimit = deep ? 12 : 8
  for (const it of ranked.slice(0, ocrLimit)) {
    if (Date.now() > deadline - 2000) break
    const v = verifyPackaging(it.file, {
      name: input.name || input.query || '',
      nameEn: input.nameEn || '',
      strength: input.strength || ''
    })
    const item = { ...it, ocrVerified: Boolean(v.verified), ocrName: v.matchedName, ocrStrength: v.matchedStrength, ocrText: v.text }
    if (v.verified) verified.push(item)
    else unverified.push(item)
    if (verified.length >= (deep ? 6 : Math.min(2, n))) break
  }
  for (const it of ranked) {
    if (verified.includes(it) || unverified.includes(it)) continue
    unverified.push(it)
  }
  if (deep) {
    return {
      ok: true,
      preload: true,
      code: '',
      items: [...verified, ...unverified].slice(0, 24),
      verified: verified.length > 0,
      engine: search.engine,
      stats: { candidates: search.candidates.length, downloaded: downloaded.length, verified: verified.length },
      note: verified.length
        ? '预加载：其中 ' + verified.length + ' 张包装文字校验通过；还没写进今天的 30 张。'
        : '预加载：还没写进今天的 30 张；这些只是候选，不能当成「同款/就是它」。',
      error: ''
    }
  }
  const items = [...verified, ...unverified].slice(0, Math.max(1, n))
  cleanup(downloaded.filter((it) => !items.some((x) => x.file === it.file)))
  return {
    ok: true,
    code: '',
    items,
    verified: verified.length > 0,
    engine: search.engine,
    note: verified.length
      ? '包装文字校验通过（药名 + 规格都在图上）。'
      : '没通过包装文字校验：下面只是候选图，不能当成「同款/就是它」，发之前先看图并说明来源。',
    error: ''
  }
}
