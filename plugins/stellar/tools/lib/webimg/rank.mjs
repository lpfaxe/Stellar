// rank.mjs —— 把「搜到的链接」排成「值得下载的候选」。
//
// 两个阶段：
//   1) 下载前粗排：标题相关度 + 来源页是否可信（Bing 顺序本身没有质量含义）；
//   2) 下载后精排：真实像素、宽高比、体积、来源域名一起算。
// 这里不判断「图里画的是什么」——化学结构式交给 PubChem，药品包装交给 OCR
// （verify.mjs）。排序只解决「在同类里挑更清晰、更可能对的那张」。

const STOP = new Set(['的', '了', '和', '与', '及', '或', '一个', '一张', '图片', '高清', '照片', '素材'])

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
}

export function queryTerms(query) {
  const text = normalize(query)
  const latin = text.match(/[a-z0-9][a-z0-9.+\-]*/g) || []
  const han = text.replace(/[a-z0-9.+\-]/g, ' ').match(/[\u4e00-\u9fff]{2,}/g) || []
  const out = []
  for (const term of [...latin, ...han]) {
    if (term.length < 2 || STOP.has(term)) continue
    if (!out.includes(term)) out.push(term)
  }
  return out.slice(0, 8)
}

export function hostOf(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase() } catch { return '' }
}

export const TRUSTED_PRODUCT_HOSTS = [
  'nmpa.gov.cn', 'dailymed.nlm.nih.gov', 'fda.gov', 'ema.europa.eu',
  'sigmaaldrich.com', 'merckmillipore.com', 'tci.com', 'aladdin-e.com',
  'macklin.cn', 'energy-chemical.com', 'bidepharm.com', 'targetmol.com',
  'medchemexpress.com', 'apexbio.cn', 'yuanye.com', 'cnreagent.com',
  'bayer.com', 'pfizer.com', 'astrazeneca.com', 'novartis.com', 'roche.com',
  'sanofi.com', 'gsk.com', 'takeda.com', 'sinopharm.com', 'crpharm.com'
]

const BAD_HOSTS = ['mm.bing.net', 'tse1.mm.bing.net', 'bing.com', 'lookaside.fbsbx.com', 'favicon.ico']

export const TRUSTED_PHOTO_HOSTS = [
  'unsplash.com', 'pexels.com', 'pixabay.com', 'wikimedia.org', 'wikipedia.org',
  'nhc.gov.cn', 'gov.cn', 'edu.cn', 'nature.com', 'science.org'
]

export function isTrustedPhotoHost(host) {
  const h = String(host || '').toLowerCase()
  return TRUSTED_PHOTO_HOSTS.some((d) => h === d || h.endsWith('.' + d))
}

export function isTrustedProductHost(host) {
  const h = String(host || '').toLowerCase()
  return TRUSTED_PRODUCT_HOSTS.some((d) => h === d || h.endsWith('.' + d))
}

function isBadHost(host) {
  const h = String(host || '').toLowerCase()
  return BAD_HOSTS.some((d) => h === d || h.endsWith('.' + d))
}

/** 下载前粗排：只用到标题和来源，不碰网络。 */
export function preRank(candidates, { query = '', trustedHost = () => false } = {}) {
  const terms = queryTerms(query)
  return (Array.isArray(candidates) ? candidates : []).map((c) => {
    const host = hostOf(c.page || c.url)
    let score = 0
    const title = normalize(c.title)
    let matched = 0
    for (const term of terms) if (title.includes(term)) { score += 12; matched += 1 }
    if (terms.length && !title) score -= 10
    if (terms.length && title && !matched) score -= 35
    if (trustedHost(host)) score += 25
    if (isBadHost(host)) score -= 40
    if (/^https:/i.test(c.url)) score += 2
    if (c.page) score += 1
    return { ...c, host, preScore: score }
  }).sort((a, b) => b.preScore - a.preScore)
}

/**
 * 下载后精排。
 * @param items {{file,width,height,bytes,title,page,url,sha256}}
 */
export function rankDownloaded(items, { query = '', minSide = 500, trustedHost = () => false } = {}) {
  const terms = queryTerms(query)
  return (Array.isArray(items) ? items : []).map((it) => {
    const width = Number(it.width) || 0
    const height = Number(it.height) || 0
    const side = Math.min(width, height)
    const ratio = height ? width / height : 0
    const title = normalize(it.title)
    let score = Math.min(60, side / 12)
    let matched = 0
    for (const term of terms) if (title.includes(term)) { score += 12; matched += 1 }
    // 标题里一个查询词都没有，基本是「同尺寸的无关图」；不压下去会专挑大而无辜的图。
    if (terms.length && title && !matched) score -= 55
    if (terms.length && !title) score -= 5
    if (trustedHost(hostOf(it.page || it.url))) score += 18
    if (ratio >= 0.55 && ratio <= 1.9) score += 8
    else if (ratio < 0.35 || ratio > 2.6) score -= 18
    if (Number(it.bytes) >= 50000) score += 4
    if (side < minSide) score -= 30
    return { ...it, ratio: Math.round(ratio * 1000) / 1000, minSide: side, score: Math.round(score * 10) / 10 }
  }).sort((a, b) => b.score - a.score)
}

export function acceptableImage(it, { minSide = 500, minBytes = 12000, maxBytes = 12 * 1024 * 1024, ratioMin = 0.3, ratioMax = 3.4 } = {}) {
  const width = Number(it.width) || 0
  const height = Number(it.height) || 0
  const bytes = Number(it.bytes) || 0
  if (!width || !height) return { ok: false, reason: '读不出宽高' }
  const side = Math.min(width, height)
  if (side < minSide) return { ok: false, reason: '最短边只有 ' + side + 'px（要求 ' + minSide + 'px）' }
  if (bytes < minBytes) return { ok: false, reason: '文件只有 ' + Math.round(bytes / 1024) + 'KB' }
  if (bytes > maxBytes) return { ok: false, reason: '文件超过 12MB' }
  const ratio = width / height
  if (ratio < ratioMin || ratio > ratioMax) return { ok: false, reason: '比例 ' + ratio.toFixed(2) + ' 不像正常图片' }
  return { ok: true, reason: '' }
}
