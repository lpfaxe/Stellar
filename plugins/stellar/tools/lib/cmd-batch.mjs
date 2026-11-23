// 批量跑「一条 BV 一条命令」的公用小件（2026-11-23）。
//
// 为什么单独一个文件：BV 的判定（正则是唯一真相）和「最多 5 条 + 表头格式」两件事，
// 既要在命令入口里用（debrief 逐条 spawn 自己），也要能被离线测试直接 import 断言。
// 抄两份的下场是入口改了、测试还在验旧规则 —— 两边都说"通过"。
//
// 约定：
//   · pickBvs 只认**整参就是 BV 号**的写法（/^BV[0-9A-Za-z]{10}$/）——
//     链接/文案里的 BV 由各自的 link 之类命令先抠出来，这里不做子串匹配（避免把 --q 里
//     偶然出现的 BV 当输入）。
//   · 去重但保序：她同一条视频写两遍只跑一次。
//   · batchPlan 默认最多 5 条：一趟看 5 条已经够多，再多就是拿钱和时间换低质量阅读。

export const BV_RE = /^BV[0-9A-Za-z]{10}$/

/** argv 里所有形如 BV 号的参数，去重、保持顺序。 */
export function pickBvs(argv) {
  const out = []
  for (const a of argv ?? []) {
    if (typeof a === 'string' && BV_RE.test(a) && !out.includes(a)) out.push(a)
  }
  return out
}

/**
 * 把 N 条 BV 折成一次批量计划。
 * @param {string[]} bvs
 * @param {{max?: number}} [opts]
 * @returns {{bvs: string[], dropped: number, header: (i: number) => string}}
 *   bvs = 前 max 条；dropped = 超出没跑的条数；header(i) 的 i 从 1 开始
 */
export function batchPlan(bvs, { max = 5 } = {}) {
  const list = Array.isArray(bvs) ? bvs.filter((b) => BV_RE.test(String(b))) : []
  const kept = list.slice(0, Math.max(1, max))
  return {
    bvs: kept,
    dropped: Math.max(0, list.length - kept.length),
    header: (i) => `===== [${i}/${kept.length}] ${kept[i - 1]} =====`,
  }
}
