// 她主动给 QQ 好友发消息 —— 命令行版（2026-11-11）
//
// 为什么需要它：QQ 侧会话（qq-chat-v2）有 qq_send_message，但 B站鲸鱼会话
// 拿不到 QQ 会话令牌，调不了那个 MCP 工具。摸鱼模式要求她「更主动找通讯录里的人聊天」，
// 这条链路就在鲸鱼会话里跑，所以得有一个不依赖会话令牌的出口。
//
// 护栏（代码硬拦，不靠提示词）：
//   · 只发通讯录里的人（state/friends.json），不在册直接拒绝；
//   · 每人每天 3 条、全站每天 12 条；
//   · 同一人 90 分钟内不重复（她刚说完「晚安」别马上又「在吗」）。
//
// 用法:
//   node bili.mjs say --to 测试员A --text "…" --dry
//   node bili.mjs say --to 1000000003 --text "…" --go
//   node bili.mjs say --list            # 今天还能给谁发、各剩几条
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Map()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (!argv[i].startsWith('--')) continue
  const key = argv[i].slice(2)
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) args.set(key, true)
  else { args.set(key, next); i += 1 }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')   // stellar 仓库根（与 qzone.mjs 同一套推导）
const CFG_FILE = path.join(ROOT, 'config.json')
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || os.homedir(), '.dsh')
const STELLAR_HOME = path.join(DSH_HOME, 'stellar')
const STATE_DIR = path.join(STELLAR_HOME, 'state')
const FRIENDS_FILE = path.join(STATE_DIR, 'friends.json')
const LOG_FILE = path.join(STATE_DIR, 'qq-say.jsonl')

const PER_PERSON_PER_DAY = 3
const PER_DAY_TOTAL = 12
const SAME_PERSON_GAP_MS = 90 * 60 * 1000

const dry = args.has('dry')
const go = args.has('go')

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}

const cfg = readJson(CFG_FILE, {})
const ownerQQ = String(cfg.ownerQQ ?? cfg.owner?.qq ?? '')

function localDay(d = new Date()) {
  return d.toLocaleDateString('sv-SE')
}

function people() {
  const raw = readJson(FRIENDS_FILE, {})
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw.people) ? raw.people : (raw.people && typeof raw.people === 'object' ? Object.values(raw.people) : []))
  return list.filter((p) => p && Number(p.uin) > 0)
}

function findPeople(who) {
  const q = String(who ?? '').trim().toLowerCase()
  if (!q) return []
  return people().filter((p) => String(p.uin) === q || String(p.nickname ?? '').toLowerCase() === q || String(p.remark ?? '').toLowerCase() === q)
}

function logRows() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function todayRows() {
  const day = localDay()
  return logRows().filter((r) => String(r.at ?? '').startsWith(day))
}

function quota(uin) {
  const rows = todayRows()
  const mine = rows.filter((r) => String(r.uin) === String(uin))
  const last = mine.length ? Math.max(...mine.map((r) => Number(r.ts ?? 0))) : 0
  return {
    total: rows.length,
    perPerson: mine.length,
    leftTotal: Math.max(0, PER_DAY_TOTAL - rows.length),
    leftPerson: Math.max(0, PER_PERSON_PER_DAY - mine.length),
    waitMs: last ? Math.max(0, SAME_PERSON_GAP_MS - (Date.now() - last)) : 0,
  }
}

function listQuota() {
  const rows = todayRows()
  console.log(`今天已发 ${rows.length}/${PER_DAY_TOTAL} 条`)
  for (const p of people()) {
    if (String(p.uin) === ownerQQ) continue
    const q = quota(p.uin)
    const waitMin = Math.ceil(q.waitMs / 60000)
    console.log(`- ${p.nickname || p.remark || p.uin}（${p.uin}）今天 ${q.perPerson}/${PER_PERSON_PER_DAY} 条${q.waitMs ? `，还要等 ${waitMin} 分钟` : ''}`)
  }
}

async function send(uin, text) {
  const base = String(cfg.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
  const token = String(cfg.snowluma?.accessToken ?? '')
  if (!token) throw new Error('config.json 的 snowluma.accessToken 为空')
  const res = await fetch(base + '/send_private_msg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ user_id: Number(uin), message: text }),
  })
  const raw = await res.text()
  let json = null
  try { json = JSON.parse(raw) } catch {}
  if (!json) throw new Error('send_private_msg 返回非 JSON（HTTP ' + res.status + '）: ' + raw.slice(0, 200))
  if (json.status === 'failed' || json.retcode !== 0) throw new Error('发送失败: ' + (json.wording ?? json.message ?? raw.slice(0, 200)))
  return json.data ?? null
}

async function main() {
  if (args.has('list')) { listQuota(); return }
  const to = String(args.get('to') ?? args.get('uin') ?? '').trim()
  const text = String(args.get('text') ?? args.get('msg') ?? '').trim()
  if (!to || !text) { console.error('用法: node bili.mjs say --to <昵称或QQ> --text "…" --dry|--go    或 say --list'); process.exit(2) }
  if (!dry && !go) { console.error('要加 --dry（演练）或 --go（真发）'); process.exit(2) }
  if (text.length > 400) { console.error('一次别超过 400 字'); process.exit(2) }
  const hits = findPeople(to)
  if (!hits.length) {
    console.error('通讯录里没有「' + to + '」。能发的人：' + people().map((p) => (p.nickname || p.uin) + '(' + p.uin + ')').join('、'))
    process.exit(3)
  }
  if (hits.length > 1) { console.error('「' + to + '」对上了 ' + hits.length + ' 个人，请直接写 QQ 号'); process.exit(3) }
  const person = hits[0]
  const q = quota(person.uin)
  if (q.perPerson >= PER_PERSON_PER_DAY) { console.error('今天已经给 ' + (person.nickname || person.uin) + ' 发满 ' + PER_PERSON_PER_DAY + ' 条了'); process.exit(4) }
  if (q.total >= PER_DAY_TOTAL) { console.error('今天一共已经发了 ' + PER_DAY_TOTAL + ' 条，明天再说'); process.exit(4) }
  if (q.waitMs > 0) { console.error('刚给' + (person.nickname || person.uin) + '发过，再等 ' + Math.ceil(q.waitMs / 60000) + ' 分钟'); process.exit(4) }
  if (dry) {
    console.log(JSON.stringify({ ok: true, dry: true, to: { uin: person.uin, name: person.nickname || person.remark || '' }, text, leftPerson: q.leftPerson - 1, leftTotal: q.leftTotal - 1 }, null, 2))
    return
  }
  const sent = await send(person.uin, text)
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ts: Date.now(), uin: String(person.uin), name: person.nickname || '', text: text.slice(0, 200), messageId: sent?.message_id ?? null }) + '\n', 'utf8')
  console.log('✓ 已发给 ' + (person.nickname || person.uin) + '（今天还能发 ' + (q.leftTotal - 1) + ' 条）')
}

Promise.resolve().then(main).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })