/* 她每天做什么 —— 面板上的每日任务开关与数量（2026-11-11 主人要：「我可以改她每日任务，是否做某些任务，做多少」）
 * 每个字段都对应一处真实运行期判断，写的是她自己的配置：
 *   bili  = ~/.dsh/stellar/bili.config.json（调度器 lib/scheduler.js 与 tools/lib/config.mjs 读它）
 *   bridge= <仓库>/config.json（qzone.mjs 等 CLI 读它）
 *   both  = 两个都写，保证调度器与脚本口径一致（qzone.public 就是这种：调度器读 bili、CLI 读 bridge）
 * 只认白名单里的路径，其余一律拒绝，避免面板变成任意配置编辑器。
 */
import fs from 'node:fs'
import { BRIDGE_CFG, CFG_FILE } from './paths.js'
import { atomicWriteJson, readJson } from './util.js'

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

const TASKS = [
  {
    key: 'watch', name: '刷 B站视频', hint: '按生物钟醒来，看视频、看评论、记日记',
    enabled: { path: 'night.enabled', file: 'bili' },
    numbers: [
      { path: 'night.maxWakesPerDay', label: '每天最多醒几次', min: 0, max: 12, def: 6 },
      { path: 'night.videoTargetPerDay', label: '每天看几条', min: 0, max: 200, def: 40 },
      { path: 'night.weeklyMax', label: '每周上限', min: 0, max: 400, def: 140 },
    ],
  },
  {
    key: 'dynamics', name: '发 B站动态', hint: '四个时段各一条，按类型轮换',
    enabled: { path: 'dynamics.enabled', file: 'bili' },
    numbers: [{ path: 'dynamics.gapMin', label: '两条之间最少隔几分钟', min: 5, max: 240, def: 30 }],
    kinds: true,
  },
  {
    key: 'qzone-public', name: '刷好友爱看', hint: '看公开动态 → 打分 → 给高分的点赞 → 挑几条评论',
    enabled: { path: 'qzone.public.enabled', file: 'both' },
    // 这四个全部 both：调度器读 bili、qzone.mjs 读 bridge，只写一边就会出现「面板改了不生效」。
    times: [{ path: 'qzone.public.time', label: '每天几点开始', def: '20:30', file: 'both' }],
    numbers: [
      { path: 'qzone.public.seenTarget', label: '每天看几条', min: 3, max: 30, def: 10, file: 'both' },
      { path: 'qzone.public.likeLimit', label: '每天最多赞几条', min: 0, max: 10, def: 3, file: 'both' },
      { path: 'qzone.public.commentLimit', label: '每天最多评几条', min: 0, max: 10, def: 3, file: 'both' },
    ],
  },
  {
    key: 'qzone-post', name: '发 QQ 空间说说', hint: '每周至少几条，到点提醒她自己写',
    enabled: { path: 'qzone.enabled', file: 'bili' },
    times: [{ path: 'qzone.time', label: '每天几点提醒', def: '21:30' }],
    numbers: [
      { path: 'qzone.weekly.min', label: '每周最少条数', min: 0, max: 21, def: 7 },
      { path: 'qzone.dailyLimit', label: '每天最多发几条', min: 1, max: 10, def: 3, file: 'both' },
    ],
  },
  {
    key: 'triple', name: '每日三连', hint: '给当天最高分那条点赞 + 投币 + 收藏',
    enabled: { path: 'triple.enabled', file: 'bili' },
    times: [{ path: 'triple.time', label: '每天几点跑', def: '22:30' }],
    numbers: [],
  },
  {
    key: 'report', name: '写日报', hint: '给主人看的一天小结，落在控制台',
    enabled: { path: 'report.enabled', file: 'bili' },
    times: [{ path: 'report.time', label: '每天几点提醒', def: '23:30' }],
    numbers: [],
  },
  {
    key: 'diary', name: '记日记', hint: '看过的、想过的写进事件流',
    enabled: { path: 'diary.enabled', file: 'bili' },
    numbers: [],
  },
  {
    key: 'ta', name: 'B站搭话', hint: '主动去评论区说话，今日额度尽量用完',
    enabled: { path: 'interact.enabled', file: 'bili' },
    numbers: [
      { path: 'limits.taDaily', label: '每天最多搭几句话', min: 0, max: 100, def: 15 },
      { path: 'limits.replyDaily', label: '每天最多回几条', min: 0, max: 200, def: 50 },
    ],
  },
  {
    key: 'qzone-watch', name: '空间监看', hint: '盯主人新说说、谁评论了她',
    enabled: { path: 'qzone.watch', file: 'bili' },
    numbers: [
      { path: 'qzone.watchMin', label: '隔几分钟看一次', min: 3, max: 120, def: 10 },
      { path: 'qzone.watchMaxPerDay', label: '每天最多看几次', min: 0, max: 24, def: 6 },
    ],
  },
  {
    key: 'vlog', name: '每日 vlog', hint: '自己剪一条 1~10 分钟的视频，交你审核',
    enabled: { path: 'vlog.enabled', file: 'bili' },
    numbers: [],
  },
]

const KIND_ORDER = ['best', 'game', 'anime', 'gaming']
const KIND_LABEL = { best: '最高分', game: '游戏区', anime: '动画区', gaming: '游戏实况' }

const FIELD_INDEX = new Map()
for (const t of TASKS) {
  if (t.enabled) FIELD_INDEX.set(t.enabled.path, { type: 'bool', file: t.enabled.file || 'bili' })
  for (const n of t.numbers || []) FIELD_INDEX.set(n.path, { type: 'num', file: n.file || 'bili', min: n.min, max: n.max, def: n.def })
  for (const tm of t.times || []) FIELD_INDEX.set(tm.path, { type: 'time', file: tm.file || 'bili', def: tm.def })
  if (t.kinds) {
    for (const k of KIND_ORDER) {
      FIELD_INDEX.set('dynamics.kinds.' + k + '.enabled', { type: 'bool', file: 'bili' })
      FIELD_INDEX.set('dynamics.kinds.' + k + '.slot', { type: 'num', file: 'bili', min: 0, max: 23, def: 8 })
    }
  }
}

function getPath(obj, dotted) {
  let cur = obj
  for (const key of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i]
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

function clampNum(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.round(n)))
}

function readBoth() {
  return { bili: readJson(CFG_FILE, {}) || {}, bridge: readJson(BRIDGE_CFG, {}) || {} }
}

function effective(fileName, cfg, path, dflt) {
  const raw = getPath(cfg, path)
  if (raw === undefined || raw === null) return dflt
  return raw
}

export function buildDailyPlan() {
  const st = readBoth()
  let mtime = 0
  try { mtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
  const tasks = TASKS.map(function (t) {
    const src = t.enabled && t.enabled.file === 'bridge' ? st.bridge : st.bili
    const enabledRaw = t.enabled ? effective(t.enabled.file === 'bridge' ? 'bridge' : 'bili', src, t.enabled.path, undefined) : undefined
    const item = {
      key: t.key,
      name: t.name,
      hint: t.hint,
      enabled: enabledRaw === undefined ? true : enabledRaw !== false,
      enabledPath: t.enabled ? t.enabled.path : '',
      togglable: Boolean(t.enabled),
      numbers: [],
      times: [],
      kinds: [],
    }
    for (const n of t.numbers || []) {
      // both 类字段以 bridge 为显示基准：真正去发表/点赞的是 qzone.mjs，它读的是 bridge；
      // 面板只要把这一个数写回两边，双源就自愈了。
      const declared = n.file || (t.enabled && t.enabled.file)
      const useBridge = declared === 'bridge' || declared === 'both'
      const cfg = useBridge ? st.bridge : st.bili
      const other = useBridge ? st.bili : st.bridge
      // 先看主文件，主文件没有这个键就退到另一边（qzone.public 以前只写在仓库 config.json 里）
      const raw = getPath(cfg, n.path) !== undefined ? getPath(cfg, n.path) : getPath(other, n.path)
      item.numbers.push({ path: n.path, label: n.label, min: n.min, max: n.max, value: raw === undefined ? n.def : Number(raw) })
    }
    for (const tm of t.times || []) {
      const raw = getPath(st.bili, tm.path) || getPath(st.bridge, tm.path)
      item.times.push({ path: tm.path, label: tm.label, value: raw === undefined || raw === null ? tm.def : String(raw) })
    }
    if (t.kinds) {
      const kindsCfg = (st.bili.dynamics && st.bili.dynamics.kinds) || {}
      item.kinds = KIND_ORDER.map(function (k) {
        const kc = kindsCfg[k] || {}
        return {
          key: k,
          name: KIND_LABEL[k],
          enabled: kc.enabled !== false,
          enabledPath: 'dynamics.kinds.' + k + '.enabled',
          slot: kc.slot === undefined ? null : Number(kc.slot),
          slotPath: 'dynamics.kinds.' + k + '.slot',
        }
      })
    }
    return item
  })
  return { ok: true, at: Date.now(), file: CFG_FILE, bridgeFile: BRIDGE_CFG, mtime: mtime, tasks: tasks }
}

export function saveDailyPlan(values, baseMtime) {
  const entries = Object.entries(values || {})
  if (!entries.length) throw new Error('没有要保存的字段')
  for (const [path] of entries) {
    if (!FIELD_INDEX.has(String(path))) throw new Error('不允许改这个字段：' + path)
  }
  const cur = 0
  let currentMtime = 0
  try { currentMtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
  if (baseMtime && currentMtime && Math.abs(currentMtime - Number(baseMtime)) > 50) {
    const err = new Error('配置刚被别处改过（可能是调度器或另一个页面），这次没有写入。刷新页面再保存即可。')
    err.code = 'plan-conflict'
    err.mtime = currentMtime
    throw err
  }
  const st = readBoth()
  const touched = { bili: false, bridge: false }
  for (const [path, raw] of entries) {
    const def = FIELD_INDEX.get(String(path))
    const targets = def.file === 'both' ? ['bili', 'bridge'] : [def.file === 'bridge' ? 'bridge' : 'bili']
    let value
    if (def.type === 'bool') value = raw === true || raw === 'true'
    else if (def.type === 'num') value = clampNum(raw, def.min, def.max, def.def)
    else {
      const s = String(raw == null ? '' : raw).trim()
      if (!TIME_RE.test(s)) throw new Error('时间格式要像 20:30：' + path)
      value = s.length === 4 ? '0' + s : s
    }
    for (const t of targets) {
      setPath(st[t], path, value)
      touched[t] = true
    }
  }
  if (touched.bili) atomicWriteJson(CFG_FILE, st.bili)
  if (touched.bridge) atomicWriteJson(BRIDGE_CFG, st.bridge)
  let nextMtime = 0
  try { nextMtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
  return { ok: true, updated: entries.length, wrote: Object.keys(touched).filter(function (k) { return touched[k] }), mtime: nextMtime }
}