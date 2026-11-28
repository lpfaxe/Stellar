// search-bing.mjs —— Bing 图片搜索的「结构解析」层。
//
// 为什么不用现成的图库 API：这里只需要「找一张能看的图」，Bing 的 async 接口不需要 key。
// 旧实现只抓 murl（原图直链），标题/来源页/缩略图全丢；排序只能按网页顺序，
// 于是搜「阿司匹林 药盒」经常先拿到一张头像或表情包。
// 这里把每条结果的 murl/purl/turl/t 一起解析出来，交给 rank.mjs 打分。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const ENTITIES = { '&quot;': '"', '&amp;': '&', '&#39;': "'", '&lt;': '<', '&gt;': '>' }

export function decodeEntities(text) {
  return String(text || '').replace(/&(?:quot|amp|#39|lt|gt);/g, (m) => ENTITIES[m] ?? m)
}

/** 从 Bing 的 m="{...}" 属性里解析结果。导出让单测能直接喂 HTML。 */
export function parseBingResults(html) {
  const out = []
  const seen = new Set()
  for (const m of String(html || '').matchAll(/\bm="(\{&quot;[\s\S]*?\})"/g)) {
    let obj = null
    try { obj = JSON.parse(decodeEntities(m[1])) } catch { obj = null }
    if (!obj) {
      // 有些页面把属性里的 JSON 再包一层；退回到逐字段抓取。
      const raw = decodeEntities(m[1])
      const url = /"murl"\s*:\s*"([^"]+)"/.exec(raw)?.[1]
      if (!url) continue
      obj = {
        murl: url,
        purl: /"purl"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || '',
        turl: /"turl"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || '',
        t: /"t"\s*:\s*"([^"]*)"/.exec(raw)?.[1] || ''
      }
    }
    const url = String(obj.murl || '').trim().replace(/^http:\/\//i, 'https://')
    if (!/^https?:\/\//i.test(url)) continue
    if (/\.(svg|gif)(\?|$)/i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push({
      url,
      page: String(obj.purl || '').trim(),
      thumbnail: String(obj.turl || '').trim(),
      title: String(obj.t || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    })
  }
  return out
}

export async function bingImageSearch(query, { count = 20, pages = 2, timeoutMs = 15000 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, candidates: [], error: '查询为空' }
  const out = []
  const seen = new Set()
  let lastError = ''
  for (let page = 0; page < Math.max(1, Math.min(5, pages)); page += 1) {
    const url = 'https://www.bing.com/images/async?q=' + encodeURIComponent(q)
      + '&first=' + (page * 20) + '&count=' + Math.max(10, Math.min(35, count))
      + '&mmasync=1&mkt=zh-CN'
    let html = ''
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), Math.max(3000, timeoutMs))
      timer.unref?.()
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (!res.ok) { lastError = 'Bing 返回 HTTP ' + res.status; break }
      html = await res.text()
    } catch (error) {
      lastError = 'Bing 请求失败：' + (error?.name === 'AbortError' ? '超时' : (error?.message ?? error))
      break
    }
    for (const item of parseBingResults(html)) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      out.push(item)
    }
    if (out.length >= count) break
  }
  if (!out.length) return { ok: false, candidates: [], error: lastError || 'Bing 没有返回可用结果' }
  return { ok: true, candidates: out.slice(0, count), error: '' }
}
