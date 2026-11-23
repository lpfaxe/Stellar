// 依赖体检（2026-10-17 加）：装完之后让 agent 自己跑一次，确认"能不能用"
//
// 用法：
//   node deps.mjs            人读版（每项 ✓/✗ + 怎么修）
//   node deps.mjs --json     机器读版（agent 判断用）
//
// 2026-11-23 加：体检之后顺带打印「写类命令怎么传参」—— 她以前每趟为写命令跑 4 次 --help，
// 每次都是一整趟模型往返（约 ¥0.04）。参数摘要直接从 lib/cmd-map.mjs 的命令表生成，
// 不另抄一份（见该文件头的「为什么单独一个文件」）。上限 700 字，放不下就退到 --go 类 + --help 提示。
//
// 退出码：0 = 全可用；3 = 有缺的（缺的那项会写明补救办法）
import { accountBili, biliState, biliStateDir } from '../lib/state-paths.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { ffmpegInfo } from '../lib/ffmpeg.mjs'
import { CMD_MAP } from '../lib/cmd-map.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const cred = accountBili('credentials.json')
const asJson = process.argv.includes('--json')

const items = []

// ① 凭据（cookie）：**真去请求一次 nav** —— 只查"字段齐不齐"是不够的（cookie 会过期 ✗）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
let credOk = false, credNote = ''
try {
  const c = JSON.parse(fs.readFileSync(cred, 'utf8'))
  const miss = ['sessdata', 'bili_jct'].filter((k) => !c[k] || !String(c[k]).trim())
  if (miss.length) { credNote = `缺字段：${miss.join(', ')}` }
  else {
    const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: `SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; buvid3=${c.buvid3}` },
    })).json()
    credOk = nav.code === 0 && !!nav.data?.isLogin
    credNote = credOk
      ? `已登录：${nav.data.uname}（mid ${nav.data.mid}）`
      : `cookie 无效：code=${nav.code} ${nav.message ?? ''} —— 重新复制一次（选"长期/记住我"）`
  }
} catch { credNote = `没有或读不了凭据文件（${cred}）` }
items.push({
  name: 'B站 cookie',
  ok: credOk,
  detail: credNote,
  fix: '在设置里重新填 SESSDATA / bili_jct（buvid3 可留空）；注意 cookie 会过期，写操作前先跑一次本命令',
})

// ② ffmpeg（抽帧看画面）
const ff = ffmpegInfo()
items.push({
  name: 'ffmpeg（抽帧看画面）',
  ok: ff.ok,
  detail: ff.ok ? `${ff.version}\n  路径：${ff.path}` : (ff.path ? `找到了但跑不起来：${ff.version ?? ff.error}` : '没找到'),
  fix: '① winget install ffmpeg  ② 或设环境变量 FFMPEG=路径  ③ 或放进 <仓库>/bin/ 或 ~/.dsh/stellar/bili/bin/',
})

// ③ Node 版本（要 18+ 才有稳定 fetch）
const major = Number(process.versions.node.split('.')[0])
items.push({
  name: 'Node.js',
  ok: major >= 18,
  detail: `v${process.versions.node}`,
  fix: '升级到 Node 18 或更高（fetch / Blob 之类要用）',
})

// ④ 可写的家目录（放 cookie/配额/日记）
let dirOk = false
try {
  const d = biliStateDir()
  fs.mkdirSync(d, { recursive: true })
  const probe = path.join(d, '.write-probe')
  fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe)
  dirOk = true
} catch {}
items.push({ name: '数据目录可写', ok: dirOk, detail: biliStateDir(), fix: '检查该目录权限' })

const bad = items.filter((i) => !i.ok)

// ⑤ 写类命令怎么传参（2026-11-23）：她不知道写命令的参数就得 --help 一次，
// 一次调用 = 一整趟模型往返。参数摘要直接从命令表生成：判定按「说明里出现 --go/--dry/--auto」，
// 因为写操作在这套工具里**必须**显式给其中之一（见 bili.mjs 的安全约定）。
// 整段上限 1400 字（2026-11-23 从 700 放宽）：写命令的说明里都带着它们自己的旗标，
//   截得太狠会把 "--dry|--go" 本身切掉 —— 那就等于又得 --help 一次，白改。
//   现在按「保头保尾」截断（尾部 26 字留旗标），总预算够放全部写命令，不再退化成「只留 --go 类」。
const WRITE_FLAG = /--(go|dry|auto)\b/
const WRITE_GO = /--go\b/
const WRITE_MAX = 1700
const WRITE_HEAD = '写类命令怎么传参（不用再跑 --help）'
const WRITE_HINT = '（其余用 node bili.mjs <命令> --help）'

function writeCommands() {
  // 保头保尾：旗标几乎总在说明末尾（"--dry|--go"），只砍中间。
  const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(10, n - 28)) + '…' + s.slice(-26) : s)
  const all = Object.entries(CMD_MAP)
    .filter(([, [, desc]]) => WRITE_FLAG.test(String(desc)))
    .map(([name, [, desc]]) => ({ name, desc: String(desc).replace(/\s+/g, ' ').trim() }))
  const go = all.filter((x) => WRITE_GO.test(x.desc))
  const render = (list, n) => list.map((x) => ({ name: x.name, usage: clip(x.desc, n) }))
  const size = (rows, withHint) => WRITE_HEAD.length + rows.reduce((a, r) => a + r.name.length + 4 + r.usage.length, 0)
    + (withHint ? WRITE_HINT.length : 0)
  const full = render(all, 120)
  if (size(full, false) <= WRITE_MAX) return { rows: full, hint: false }
  let rows = render(go, 120)
  const tr = [120, 100, 90, 70, 50, 40, 30].find((n) => size(render(go, n), true) <= WRITE_MAX) ?? 30
  rows = render(go, tr)
  while (rows.length > 1 && size(rows, true) > WRITE_MAX) rows = rows.slice(0, -1)
  return { rows, hint: true }
}

const writeMap = writeCommands()

if (asJson) {
  console.log(JSON.stringify({ ok: bad.length === 0, node: process.versions.node, items, writeCommands: writeMap.rows }, null, 2))
} else {
  console.log('== 依赖体检 ==')
  for (const i of items) {
    console.log(`${i.ok ? '✓' : '✗'} ${i.name}  ${i.detail ? '— ' + i.detail : ''}`)
    if (!i.ok) console.log(`    修：${i.fix}`)
  }
  console.log(bad.length ? `\n✗ ${bad.length} 项不可用 —— 先用上面的"修"处理，再重跑一次。` : '\n✓ 全部可用')
  console.log(`\n${WRITE_HEAD}`)
  for (const r of writeMap.rows) console.log(`  ${r.name} —— ${r.usage}`)
  if (writeMap.hint) console.log(WRITE_HINT)
}
process.exit(bad.length ? 3 : 0)
