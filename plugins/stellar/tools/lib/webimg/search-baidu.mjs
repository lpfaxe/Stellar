// search-baidu.mjs —— 百度图片搜索。
//
// 为什么加它：Bing 的 async 接口对多词中文查询经常返回完全无关的结果
// （2026-11-27 实测「雪山 小镇 风景」返回京剧、医院、抗日英雄），
// 而百度对中文短句的相关性稳定得多。中文查询先走百度，失败再回退 Bing。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

function cleanUrl(value) {
  return String(value || '').trim().replace(/^http:\/\//i, 'https://')
}

/** 百度 acjson 的字段解析。导出给单测喂 JSON。 */
export function parseBaiduResults(payload) {
  const out = []
  const seen = new Set()
  const rows = Array.isArray(payload?.data) ? payload.data : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const replacement = Array.isArray(row.replaceUrl) ? row.replaceUrl[0] : null
    const url = cleanUrl(replacement?.ObjURL || replacement?.ObjUrl || row.middleURL || row.hoverURL || row.thumbURL)
    if (!/^https?:\/\//i.test(url)) continue
    if (/\.(svg|gif)(\?|$)/i.test(url)) continue
    const page = cleanUrl(replacement?.FromURL || replacement?.FromUrl || row.fromJumpUrl || row.fromURL)
    const title = String(row.fromPageTitleEnc || row.fromPageTitle || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    const width = Number(row.width) || 0
    const height = Number(row.height) || 0
    const key = url
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url, page, thumbnail: cleanUrl(row.thumbURL), title, width, height })
  }
  return out
}

export async function baiduImageSearch(query, { count = 20, pages = 2, timeoutMs = 15000, minWidth = 0 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, candidates: [], error: '查询为空' }
  const out = []
  const seen = new Set()
  let lastError = ''
  const pageSize = 30
  for (let page = 0; page < Math.max(1, Math.min(4, pages)); page += 1) {
    const params = new URLSearchParams({
      tn: 'resultjson_com', ipn: 'rj', ct: '201326592', is: '', fp: 'result',
      cl: '2', lm: '-1', ie: 'utf-8', oe: 'utf-8', st: '-1', z: '', ic: '',
      hd: '', latest: '', copyright: '', word: q, queryWord: q,
      pn: String(page * pageSize), rn: String(pageSize)
    })
    let payload = null
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), Math.max(3000, timeoutMs))
      timer.unref?.()
      const res = await fetch('https://image.baidu.com/search/acjson?' + params.toString(), {
        headers: {
          'user-agent': UA,
          'accept-language': 'zh-CN,zh;q=0.9',
          referer: 'https://image.baidu.com/'
        },
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (!res.ok) { lastError = '百度返回 HTTP ' + res.status; break }
      payload = JSON.parse(await res.text())
    } catch (error) {
      lastError = '百度请求失败：' + (error?.name === 'AbortError' ? '超时' : (error?.message ?? error))
      break
    }
    for (const item of parseBaiduResults(payload)) {
      if (seen.has(item.url)) continue
      if (minWidth && item.width && item.width < minWidth) continue
      seen.add(item.url)
      out.push(item)
    }
    if (out.length >= count) break
  }
  if (!out.length) return { ok: false, candidates: [], error: lastError || '百度没有返回可用结果' }
  return { ok: true, candidates: out.slice(0, count), error: '' }
}
