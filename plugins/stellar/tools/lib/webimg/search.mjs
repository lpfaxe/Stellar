// search.mjs —— 图片搜索的门面：中文先百度，英文先 Bing，失败互相回退。
import { bingImageSearch } from './search-bing.mjs'
import { baiduImageSearch } from './search-baidu.mjs'

export function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''))
}

export async function imageSearch(query, { count = 20, pages = 2, timeoutMs = 15000 } = {}) {
  const chinese = hasChinese(query)
  const first = chinese
    ? () => baiduImageSearch(query, { count, pages, timeoutMs })
    : () => bingImageSearch(query, { count, pages, timeoutMs })
  const second = chinese
    ? () => bingImageSearch(query, { count, pages, timeoutMs })
    : () => baiduImageSearch(query, { count, pages, timeoutMs })
  const a = await first()
  if (a.ok && a.candidates.length) return { ...a, engine: chinese ? 'baidu' : 'bing' }
  const b = await second()
  if (b.ok && b.candidates.length) return { ...b, engine: chinese ? 'bing' : 'baidu' }
  return { ok: false, candidates: [], error: a.error || b.error || '没有搜索到图片' }
}
