// 「她的一天」—— 让主人看得见她做了什么（可见性层，2026-10-14 主人问"我怎么知道她做了什么"）
//
// 用法:
//   node diary.mjs show [--days 1]      人读摘要：今天看了什么 / 想了什么 / 发了什么 / 额度还剩多少
//   node diary.mjs log <kind> [--target X] [--note "…"]   记一条结构化事件到 ~/.dsh/stellar/bili/whale-log.jsonl
//   node diary.mjs tail [--n 20]        最近的结构化事件
//   node diary.mjs append --public  "正文…"     追加到公开日记 whale-diary.md（只追加，永不整文件覆盖）
//   node diary.mjs append --private "正文…"     追加到私密日记 whale-diary-private.md（正文含引号就加 --stdin 从管道读；--heading "21:40 夜读十条" 先写一行小标题）
//
// 三个数据源（各司其职）：
//   ~/.dsh/stellar/bili/whale-diary.md      叙事（她自己的话：看过的、想法池、谁回过她）—— 给人读
//   ~/.dsh/stellar/bili/quota.json      发言账（每条对外发言，含"自主/主人授权"标记）—— 给闸门与审计用
//   ~/.dsh/stellar/bili/whale-log.jsonl     事件流（看/想/发/被回… 结构化）—— 给程序与其他端用
//
// 关键约定（写进 AGENTS.md）：**自主发言之后必须主动通知主人**（notify_wechat），
// 因为"她自己决定的对外动作"必须让主人事后可见 —— 这是 B 档能成立的前提。
import { accountBili, biliState, biliStateDir } from '../lib/state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

const argv = process.argv.slice(2)
// 设置页的「日记总开关」真的生效（2026-10-18 修）：关掉就什么都不记
if (config().diary?.enabled === false) { console.log('（日记总开关关着 —— 这次不记）'); process.exit(0) }
const cmd = argv[0]
const opt = {}
for (let i = 1; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  else if (!opt._a) opt._a = argv[i]
}
const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const DIARY = biliState('whale-diary.md')
const QUOTA = biliState('quota.json')
const LOG = biliState('whale-log.jsonl')
const today = () => new Date().toLocaleDateString('sv-SE')
const hhmm = (iso) => String(iso).slice(11, 16)

// 追加正文（2026-11-23 加）：以前没有写正文的入口，她只能 PowerShell 把整个文件读出来再覆盖写
// —— 11-23 真的这么干过一次。整文件覆盖只要一次读漏/编码错/并发写就把旧日记弄丢，
// 所以这里**只 appendFileSync**：文件不存在才写标题行，标题格式照抄现有文件首行（读不到才用默认）。
// stdin（--stdin）是给"正文里有引号/换行/反引号"的情况留的：PowerShell 里不用再跟转义打架。
if (cmd === 'append') {
  const rest = argv.slice(1)
  let isPrivate = false
  let fromStdin = false
  let heading = ''
  const words = []
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a === '--public') { isPrivate = false; continue }
    if (a === '--private') { isPrivate = true; continue }
    if (a === '--stdin') { fromStdin = true; continue }
    if (a === '--heading') { heading = String(rest[i + 1] ?? '').trim(); i += 1; continue }
    if (a.startsWith('--heading=')) { heading = a.slice('--heading='.length).trim(); continue }
    if (a.startsWith('--')) { console.error(`append 不认识的参数：${a}（可用：--public / --private / --stdin / --heading）`); process.exit(1) }
    words.push(a)
  }
  const file = biliState(isPrivate ? 'whale-diary-private.md' : 'whale-diary.md')
  const label = isPrivate ? '私密' : '公开'
  let body = fromStdin ? fs.readFileSync(0, 'utf8') : words.join(' ')
  body = String(body).replace(/\r\n/g, '\n').trim()
  if (!body) {
    console.error(`没给正文 —— 用法: node diary.mjs append ${isPrivate ? '--private' : '--public'} "正文…"（正文里有引号就加 --stdin 从管道读）`)
    process.exit(1)   // 不写文件
  }
  const chars = [...body].length
  if (chars > 4000) {
    console.error(`一条最多 4000 字，分两次写（这条 ${chars} 字）`)
    process.exit(1)   // 不写文件
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let old = ''
  try { old = fs.readFileSync(file, 'utf8') } catch {}
  const name = String(config().persona?.name ?? '').trim() || '她'
  const defaultTitle = isPrivate ? `# 私人日记 · ${name}` : `# 鲸鱼日记 · ${name}`
  const firstLine = old.split('\n')[0] ?? ''
  const title = old.trim() ? (firstLine.startsWith('#') ? firstLine : defaultTitle) : defaultTitle
  const now = new Date()
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const text = heading ? `\n## ${heading}\n\n- ${hm} ${body}\n` : `\n- ${hm} ${body}\n`
  if (!old.trim()) fs.appendFileSync(file, title + '\n')
  fs.appendFileSync(file, text)
  const all = (old.trim() ? old : title + '\n') + text
  const lines = all.split('\n').length - (all.endsWith('\n') ? 1 : 0)
  console.log(`已追加 ${chars} 字到${label}日记（现共 ${lines} 行，文件 ${file}）`)
  process.exit(0)
}

if (cmd === 'log') {
  const kind = opt._a ?? 'event'
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind, target: opt.target ?? null, note: opt.note ?? null }) + '\n')
  console.log(`已记：${kind}${opt.target ? ' → ' + opt.target : ''}`)
  process.exit(0)
}

if (cmd === 'tail') {
  const n = Number(opt.n ?? 20)
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  if (!lines.length) { console.log('（还没有事件记录）'); process.exit(0) }
  for (const l of lines.slice(-n)) {
    try { const e = JSON.parse(l); console.log(`  ${String(e.at).slice(0, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) }
    catch { console.log('  ' + l) }
  }
  process.exit(0)
}

if (cmd === 'show' || !cmd) {
  const days = Number(opt.days ?? 1)
  const since = new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString('sv-SE')
  const title = config().persona?.diaryTitle ?? '今日摘要'
  console.log(`════════ ${title}（${since} ~ ${today()}）════════\n`)

  // ① 叙事部分：解析日记
  let text = ''
  try { text = fs.readFileSync(DIARY, 'utf8') } catch { console.log(`（读不到日记 ${DIARY}）`) }
  if (text) {
    const sections = {}
    let cur = null
    for (const line of text.split('\n')) {
      const h = line.match(/^##\s+(.+)$/)
      if (h) { cur = h[1].trim(); sections[cur] = []; continue }
      if (cur) sections[cur].push(line)
    }
    // 看过的：表格里日期匹配的
    const seenKey = Object.keys(sections).find((k) => k.includes('看过')) ?? ''
    const rows = (sections[seenKey] ?? []).filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l) && !l.includes('| 时间 |'))
    const hit = rows.filter((r) => r.includes(since) || r.includes(today()))
    console.log(`【看过 ${hit.length} 条】`)
    for (const r of hit) {
      const c = r.split('|').map((s) => s.trim()).filter(Boolean)
      console.log(`  · ${c[2] ?? c[0]}  ${String(c[3] ?? '').slice(0, 46)}`)
      if (c[4]) console.log(`      她的想法：${String(c[4]).slice(0, 120)}`)
    }
    // 想法池
    const wantKey = Object.keys(sections).find((k) => k.includes('想说')) ?? ''
    const wants = (sections[wantKey] ?? []).filter((l) => l.trim().startsWith('-') && !/^-\s*（空/.test(l.trim()))
    console.log(`\n【想说但还没说 ${wants.length} 条】`)
    for (const w of wants) console.log('  ' + w.trim().replace(/^-\s*/, '  · ').slice(0, 150))
  }

  // ② 发言账（她真的对外说了什么）
  console.log('\n【对外发言（今天）】')
  try {
    const q = JSON.parse(fs.readFileSync(QUOTA, 'utf8'))
    const todayLog = (q.log ?? []).filter((x) => String(x.at).startsWith(today()))
    const auto = todayLog.filter((x) => x.auto).length
    console.log(`  共 ${todayLog.length} 条（自主 ${auto}/${q.daily}，主人授权 ${todayLog.length - auto}）`)
    for (const x of todayLog) console.log(`  · ${hhmm(x.at)}  ${x.type}${x.auto ? '（自主）' : ''}  ${x.target ?? ''}  ${x.note ?? ''}`)
    if (!todayLog.length) console.log('  （今天一条都没发）✓')
  } catch { console.log('  （还没有发言记录 —— 发第一条时 `quota record` 会自动建 quota.json）✓') }

  // ③ 事件流
  console.log('\n【最近事件】')
  let lines = []
  try { lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  if (!lines.length) console.log('  （还没有事件记录 —— `diary log` 会往这里写）')
  for (const l of lines.slice(-6)) {
    try { const e = JSON.parse(l); console.log(`  · ${String(e.at).slice(5, 16).replace('T', ' ')}  ${e.kind}  ${e.target ?? ''}  ${e.note ?? ''}`) } catch {}
  }
  console.log('\n（她是主动来找你的：自主发言后必须 notify_wechat —— 见 AGENTS.md「日子」一节）')
  process.exit(0)
}

console.log('用法: node diary.mjs show [--days 1] | log <kind> [--target X] [--note "…"] | tail [--n 20] | append --public|--private "正文…" [--stdin] [--heading "…"]')
