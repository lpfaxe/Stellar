// 「她给主人的日报」—— 每天简短记下干了什么，主人在集成控制台里看（2026-11-08 主人要）
//
// 用法:
//   node report.mjs digest [--date YYYY-MM-DD]      今天的素材汇总（给她写日报用，只读）
//   node report.mjs write --text "…" [--title "…"] [--date YYYY-MM-DD]
//   node report.mjs list [--days 14] [--json]       有哪几天的报告
//   node report.mjs show [--date YYYY-MM-DD]        看某一天的报告
//
// 存哪儿：~/.dsh/stellar/state/reports.jsonl（一行一份，同一天后写的覆盖先写的）
// 谁写：她自己（调度器 23:30 提醒；或者主人在控制台点「让她现在写」）
// 素材来源：whale-night.json（生物钟/醒了几次）、daily-dynamic.json（B站动态）、
//           my-dynamics.json、quota.json（对外发言账）、whale-log.jsonl（她自己的记录）、
//           qzone-log.jsonl（空间说说/评论）、bridge 的 state/tool-calls.jsonl（QQ 聊天）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { biliState, STELLAR_DIR } from '../lib/state-paths.mjs'
// ⑦ 的素材（见闻 / 聊天 / 小镇）跟说说共用一份聚合，口径写在 lib/material-kit.mjs
import { buildKit, renderMemoryLines } from '../lib/material-kit.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) opt[a.slice(2)] = true
    else { opt[a.slice(2)] = next; i += 1 }
  } else if (!opt._a) opt._a = a
}

const REPORTS = path.join(STELLAR_DIR, 'state', 'reports.jsonl')
const NIGHT = biliState('whale-night.json')
const DAILY = biliState('daily-dynamic.json')
const MYDYN = biliState('my-dynamics.json')
const QUOTA = biliState('quota.json')
const WLOG = biliState('whale-log.jsonl')
const QZLOG = path.join(STELLAR_DIR, 'state', 'qzone-log.jsonl')
// 桥接自己的状态目录在插件仓库根部（<ROOT>/state），不在 ~/.dsh 下 —— 两个都试一遍
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const TOOLCALLS = [path.join(STELLAR_DIR, 'state', 'tool-calls.jsonl'), path.join(ROOT, 'state', 'tool-calls.jsonl')]
  .find((f) => fs.existsSync(f)) ?? path.join(ROOT, 'state', 'tool-calls.jsonl')

const localDate = (d) => new Date(d).toLocaleDateString('sv-SE')
const today = () => localDate(Date.now())
const dayOf = (iso) => {
  if (!iso) return ''
  const t = new Date(iso)
  return Number.isFinite(t.getTime()) ? localDate(t) : String(iso).slice(0, 10)
}
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fallback } }
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const hm = (iso) => String(iso ?? '').slice(11, 16)

async function digest(day) {
  const out = []
  out.push(`【素材 · ${day}】`)

  // ① 生物钟：计划几次、醒了几次
  const night = readJson(NIGHT, null)
  if (night && night.date === day) {
    const slots = Array.isArray(night.slots) ? night.slots : []
    const fired = slots.filter((s) => s.status === 'fired')
    const skip = slots.filter((s) => s.action === 'skip')
    out.push(`· 生物钟：计划 ${slots.length} 次（含跳过 ${skip.length}），已醒 ${fired.length} 次` +
      (fired.length ? `（${fired.map((s) => s.atText ?? '').filter(Boolean).join(' / ')}）` : ''))
  } else {
    out.push('· 生物钟：今天没有计划记录（或者没醒）')
  }

  // ② B 站动态：四类各发了什么
  const daily = readJson(DAILY, {}) || {}
  const posts = Object.entries(daily).filter(([, v]) => v && v.date === day)
  if (posts.length) {
    out.push('· B站动态：' + posts.map(([k, v]) => `${k} ${v.bvid ?? ''} ${v.atText ? '(' + String(v.atText).slice(0, 5) + ')' : ''}`.trim()).join('、'))
  } else {
    out.push('· B站动态：今天没发')
  }
  const mydyn = readJson(MYDYN, null)
  if (mydyn && Number.isFinite(Number(mydyn.at)) && localDate(Number(mydyn.at)) === day) {
    const when = new Date(Number(mydyn.at))
    out.push(`· 最近一条B站动态：${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}（共 ${(mydyn.ids ?? []).length} 条记录）`)
  }

  // ③ QQ 空间：说说 / 评论 / 点赞
  const qz = readLines(QZLOG).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((e) => e && dayOf(e.at) === day)
  const qzPost = qz.filter((e) => e.kind === 'post')
  const qzComment = qz.filter((e) => e.kind === 'comment')
  const qzLike = qz.filter((e) => e.kind === 'like' || e.kind === 'unlike')
  out.push(`· QQ空间：发说说 ${qzPost.length} 条、评论 ${qzComment.length} 条、点赞 ${qzLike.length} 次`)
  for (const e of qzPost) out.push(`    - 说说：${String(e.text ?? '').replace(/\s+/g, ' ').slice(0, 60)}`)

  // ④ B 站对外发言账
  const quota = readJson(QUOTA, null)
  const qlog = (quota && Array.isArray(quota.log) ? quota.log : []).filter((e) => dayOf(e.at) === day)
  const byType = {}
  for (const e of qlog) byType[e.type ?? 'other'] = (byType[e.type ?? 'other'] ?? 0) + 1
  const quotaText = Object.entries(byType).map(([k, v]) => `${k} ${v}`).join('、')
  out.push(`· B站发言：${qlog.length ? quotaText : '今天没说话'}`)

  // ⑤ QQ 聊天（桥接那边记的工具调用）
  const calls = readLines(TOOLCALLS).map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((e) => e && e.type === 'call' && dayOf(e.time) === day)
  const sendMsg = calls.filter((e) => /qq_send_message/.test(String(e.tool ?? ''))).length
  if (sendMsg) out.push(`· QQ 聊天：回了 ${sendMsg} 次`)

  // ⑥ 她自己的记录（这是最好的素材）
  const log = readLines(WLOG).map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((e) => e && dayOf(e.at) === day)
  if (log.length) {
    out.push(`· 她自己的记录（${log.length} 条）：`)
    for (const e of log.slice(-6)) {
      out.push(`    - ${hm(e.at)} ${e.kind}${e.target ? ' → ' + e.target : ''}${e.note ? '：' + String(e.note).replace(/\s+/g, ' ').slice(0, 90) : ''}`)
    }
  }
  // ⑦ 记忆：B站见闻 / 好友爱看 / 聊天话题 / 小镇（2026-11-25 主人要的：日报要参考她记下的东西，不是只复述日志）
  //    只给元信息，不给聊天正文 —— 日报虽然只给主人看，但「能复述原文」和「记着发生过什么」是两件事。
  try {
    const kit = await buildKit({ day, audience: 'report' })
    out.push(...renderMemoryLines(kit, { audience: 'report' }))
    if (kit.warnings.length) out.push('· 记忆读取有问题：' + kit.warnings.slice(0, 2).join('；') + '（照实说，别补）')
  } catch (e) {
    out.push('· 记忆读取失败：' + (e && e.message ? e.message : String(e)) + '（别编记忆，只写今天真做过的）')
  }
  return out.join('\n')
}

function readReports() {
  const map = new Map()
  for (const line of readLines(REPORTS)) {
    try {
      const r = JSON.parse(line)
      if (r && typeof r.date === 'string' && r.date) map.set(r.date, r)
    } catch {}
  }
  return [...map.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)))
}

if (cmd === 'digest' || !cmd) {
  console.log(await digest(opt.date ? String(opt.date) : today()))
  process.exit(0)
}

if (cmd === 'write') {
  const raw = typeof opt.text === 'string' ? opt.text : ''
  if (!raw.trim()) {
    console.log('用法：node report.mjs write --text "今天…"（用 \\n 换行）[--title 标题] [--date YYYY-MM-DD]')
    process.exit(2)
  }
  const text = raw.replace(/\\n/g, '\n').replace(/\r/g, '').trim()
  if (text.length > 3000) {
    console.log(`太长了（${text.length} 字）—— 日报别超过 3000 字，压短一点 ✗`)
    process.exit(2)
  }
  const date = typeof opt.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opt.date) ? opt.date : today()
  const entry = {
    date,
    title: typeof opt.title === 'string' ? opt.title.slice(0, 40) : '',
    text,
    at: new Date().toISOString(),
    source: 'agent',
  }
  fs.mkdirSync(path.dirname(REPORTS), { recursive: true })
  fs.appendFileSync(REPORTS, JSON.stringify(entry) + '\n')
  console.log(`已记录 ${date} 的日报（${text.length} 字）✓`)
  process.exit(0)
}

if (cmd === 'list') {
  const days = Math.max(1, Number(opt.days ?? 14) || 14)
  const since = localDate(Date.now() - (days - 1) * 86400000)
  const rows = readReports().filter((r) => r.date >= since)
  if (opt.json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0) }
  if (!rows.length) { console.log('（这段时间还没有报告）'); process.exit(0) }
  for (const r of rows) {
    const first = String(r.text ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? ''
    console.log(`${r.date}  ${(r.title || first).slice(0, 50)}`)
  }
  process.exit(0)
}

if (cmd === 'show') {
  const date = typeof opt.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opt.date) ? opt.date : today()
  const r = readReports().find((x) => x.date === date)
  if (!r) { console.log(`（${date} 还没有报告）`); process.exit(0) }
  console.log(`${r.date}${r.title ? ' · ' + r.title : ''}（${String(r.at ?? '').slice(0, 16).replace('T', ' ')}）`)
  console.log(r.text)
  process.exit(0)
}

console.log('用法：node report.mjs digest | write --text "…" [--title …] [--date …] | list [--days N] | show [--date …]')
process.exit(2)
