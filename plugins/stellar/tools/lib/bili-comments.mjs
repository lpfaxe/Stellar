// bili-comments.mjs —— 把一条视频的评论一次多拉几条（评论区能力的地基）。
//
// 为什么不用最简单的 /x/v2/reply?ps=20&pn=N：
//   · 实测（2026-11-09）sort=2（热度）翻到第 3 页就空了 → 热度评论最多只能拿 ~40 条；
//   · 而且 ps 每页不同（最后页 ps<20）时 pn 的偏移会错位，重复/漏条。
// 所以主路径换成 /x/v2/reply/main 的**游标分页**：
//   · mode=3 热度 / mode=2 时间，next 由 data.cursor.next 给；
//   · 实测 6 页能稳定拿到 100 条，热度与时间两条线都通。
// 主路径失败（老视频/风控/接口变动）再退回 /x/v2/reply 的 pn 分页（能拿多少算多少）。

export const COMMENT_MAX = 120

/**
 * @param {object} o
 * @param {number} o.aid        视频 aid
 * @param {number} o.want       最多要几条（内部夹到 1..120）
 * @param {'hot'|'new'} [o.sort]
 * @param {(url:string)=>Promise<any>} o.jget  带登录态/UA 的取 JSON 函数
 * @param {number} [o.pageSize] 每页条数，默认 20（B 站上限）
 * @param {number} [o.maxPages] 最多翻几页，默认 10
 * @returns {Promise<{list:any[], code:number, via:'main'|'legacy', pages:number}>}
 */
export async function fetchComments({ aid, want = 30, sort = 'hot', jget, pageSize = 20, maxPages = 10 }) {
  const n = Math.max(1, Math.min(COMMENT_MAX, Math.floor(Number(want) || 30)))
  const ps = Math.max(1, Math.min(20, Math.floor(Number(pageSize) || 20)))
  const mode = sort === 'new' ? 2 : 3
  const seen = new Set()
  const list = []
  let code = 0
  let pages = 0

  // ── 主路径：reply/main 游标分页 ──
  let next = 0
  let mainOk = true
  while (list.length < n && pages < maxPages) {
    pages += 1
    let rep = null
    try {
      rep = await jget(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=${mode}&next=${next}&ps=${ps}`)
    } catch { mainOk = false; break }
    code = Number(rep?.code ?? 0)
    const batch = rep?.data?.replies ?? []
    if (code !== 0 || !batch.length) { if (pages === 1) mainOk = false; break }
    for (const r of batch) {
      const rid = String(r.rpid ?? '')
      if (rid && seen.has(rid)) continue
      if (rid) seen.add(rid)
      list.push(r)
    }
    const nx = Number(rep?.data?.cursor?.next)
    if (!Number.isFinite(nx) || nx === next || nx <= 0) break
    next = nx
  }
  if (mainOk && list.length) return { list: list.slice(0, n), code, via: 'main', pages }

  // ── 退路：老的 pn 分页（热度只给 ~2 页，时间能深一些）──
  const legacySort = sort === 'new' ? 0 : 2
  for (let pn = 1; pn <= Math.min(4, maxPages) && list.length < n; pn += 1) {
    let rep = null
    try {
      rep = await jget(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=${legacySort}&ps=${ps}&pn=${pn}`)
    } catch { break }
    code = Number(rep?.code ?? code)
    const batch = rep?.data?.replies ?? []
    if (!batch.length) break
    for (const r of batch) {
      const rid = String(r.rpid ?? '')
      if (rid && seen.has(rid)) continue
      if (rid) seen.add(rid)
      list.push(r)
    }
  }
  return { list: list.slice(0, n), code, via: 'legacy', pages }
}

/** 给一条主评论再拉几条楼中楼（/x/v2/reply/reply）。失败返回空数组，不抛。 */
export async function fetchSubReplies({ aid, root, want = 3, jget }) {
  const ps = Math.max(1, Math.min(5, Math.floor(Number(want) || 3)))
  try {
    const rep = await jget(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root}&ps=${ps}&pn=1`)
    return (rep?.data?.replies ?? []).slice(0, ps)
  } catch { return [] }
}
