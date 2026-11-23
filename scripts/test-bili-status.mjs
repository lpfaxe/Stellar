#!/usr/bin/env node
/**
 * commands/status.mjs 的沙箱测试。
 *
 * 手法与 scripts/test-bili-state-paths.mjs 一致：临时 DSH_HOME + USERPROFILE，
 * 把几本账、鱼群保护、日记都写成最小样例，再真的 spawn 一次命令看输出 ——
 * 这样才能验证「聚合口径」和「长度上限」，而不是只测纯函数。
 *
 * 注意：bili.mjs 的命令表正在被抽到 tools/lib/cmd-map.mjs（另一个改动）。
 * 所以这里先看注册表：注册了 status 就走 `node bili.mjs status`（端到端），
 * 没注册就直接跑 commands/status.mjs（参数透传等价）—— 两种情况测试都必须过，
 * 否则命令表一重构，这条测试就假红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TOOLS = path.join(HERE, '..', 'plugins', 'stellar', 'tools')
const STATUS = path.join(TOOLS, 'commands', 'status.mjs')
const BILI = path.join(TOOLS, 'bili.mjs')
const CMD_MAP = path.join(TOOLS, 'lib', 'cmd-map.mjs')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-bili-status-'))
const BILI_DIR = path.join(temp, 'stellar', 'bili')
const nowMs = Date.now()
const day = (n = 0) => new Date(nowMs + n).toLocaleDateString('sv-SE')
const today = day(0)
const yesterdayIso = new Date(nowMs - 26 * 3600 * 1000).toISOString()
const nowIso = (n = 0) => new Date(nowMs + n).toISOString()

// status 注册了没有：有注册表且里面出现 status 键，才走统一入口。
function statusRegistered() {
  try {
    return /^\s*status\s*:/m.test(fs.readFileSync(CMD_MAP, 'utf8'))
  } catch { return false }
}
const REGISTERED = statusRegistered()

function writeJson(rel, value) {
  const file = path.join(BILI_DIR, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}
function writeText(rel, text) {
  const file = path.join(BILI_DIR, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const env = {
  ...process.env,
  DSH_HOME: temp,
  USERPROFILE: temp,
  STELLAR_BILI_CONFIG: path.join(temp, 'stellar', 'bili.config.json'),
}
function runStatus(args = []) {
  // 走统一入口时多一层 bili.mjs → commands/status.mjs；直接跑就是同一条命令。
  const [bin, argv] = REGISTERED ? [BILI, ['status', ...args]] : [STATUS, args]
  return execFileSync(process.execPath, [bin, ...argv], { env, encoding: 'utf8', timeout: 30_000 })
}

// 时间都压在「今天」里，但别越过零点：刚过 0 点时退回今天 00:00:01。
const startOfToday = new Date(new Date(nowMs).setHours(0, 0, 0, 0)).getTime()
const freeAtMs = Math.max(startOfToday + 1000, nowMs - 30 * 1000)
const at = (n) => new Date(freeAtMs + n).toISOString()
const soft = at(-3000)   // 分享（不算自主发言）
const ta = at(-2000)     // 搭话
const reply = at(-1000)  // 回评
const free = at(0)       // 普通评论：30 秒前 → globalMin 2 分钟还没到

fs.mkdirSync(BILI_DIR, { recursive: true })
fs.mkdirSync(path.join(temp, 'stellar'), { recursive: true })

// 配置：本周上限 7、分享 3 条、点赞 6 个、全局冷却 2 分钟。
fs.writeFileSync(path.join(temp, 'stellar', 'bili.config.json'), JSON.stringify({
  night: { weeklyMax: 7 },
  quota: { shareDaily: 3 },
  limits: { globalMin: 2 },
  fishGuard: { maxLikesPerDay: 6 },
}, null, 2) + '\n')

// 观看历史：今天 2 条（1 条深看）+ 昨天 1 条（不该算进今天）
fs.writeFileSync(path.join(BILI_DIR, 'watch-history.jsonl'), [
  { at: nowIso(-40 * 60 * 1000), bvid: 'BV1Aa411c7Xd', title: '测试视频一', up: '测试UP', mode: 'full' },
  { at: nowIso(-10 * 60 * 1000), bvid: 'BV1Bb411c7Xd', title: '测试视频二', up: '测试UP', mode: 'meta' },
  { at: yesterdayIso, bvid: 'BV1Cc411c7Xd', title: '昨天的视频', up: '测试UP', mode: 'meta' },
].map((x) => JSON.stringify(x)).join('\n') + '\n')

// 评分：今天两条，最高 18（排序由 lib 负责，这里故意逆序写）
writeJson('scores.json', {
  [today]: [
    { bv: 'BV1Bb411c7Xd', score: 11, reason: '一般', title: '测试视频二', at: nowIso(-5 * 60 * 1000) },
    { bv: 'BV1Aa411c7Xd', score: 18, reason: '很好', title: '测试视频一', at: nowIso(-6 * 60 * 1000) },
  ],
})

// 收藏：今天 1 条 + 昨天 1 条
writeJson('favorites.json', {
  items: [
    { at: nowIso(-3 * 60 * 1000), bv: 'BV1Aa411c7Xd', title: '测试视频一', reason: '收藏', kind: 'video' },
    { at: yesterdayIso, bv: 'BV1Cc411c7Xd', title: '昨天的视频', reason: '收藏', kind: 'video' },
  ],
})

// 四类动态：今天完成 3 类，anime 还是昨天的
writeJson('daily-dynamic.json', {
  best: { date: today, at: nowIso(-2 * 60 * 60 * 1000), bvid: 'BV1Aa411c7Xd', dynId: '1' },
  game: { date: today, at: nowIso(-2 * 60 * 60 * 1000), bvid: 'BV1Bb411c7Xd', dynId: '2' },
  anime: { date: day(-86400000), at: yesterdayIso, bvid: 'BV1Cc411c7Xd', dynId: '3' },
  gaming: { date: today, at: nowIso(-2 * 60 * 60 * 1000), bvid: 'BV1Aa411c7Xd', dynId: '4' },
})

// 鱼群保护：今天赞了 2 个
writeJson('fish-guard.json', {
  version: 1,
  liked: {},
  gathered: {},
  daily: { [today]: { likes: 2, gathers: 0 } },
  likeFailed: {},
  fishGuardLog: [],
})

// 额度账本：4 条今天的记录，各归一本账
writeJson('quota.json', {
  log: [
    { type: 'comment', auto: true, at: free, bvid: 'BV1Aa411c7Xd', text: '普通评论' },
    { type: 'comment', auto: true, reply: true, at: reply, bvid: 'BV1Bb411c7Xd', text: '回评' },
    // 搭话也是「回别人」的一条，所以带上 reply:true —— 这样它只进搭话那本账，
    // 不会被「普通评论」再数一遍（口径见 quota.mjs:112-114）。
    { type: 'comment', auto: true, ta: true, reply: true, at: ta, bvid: 'BV1Cc411c7Xd', text: '搭话' },
    { type: 'comment', auto: true, share: true, at: soft, bvid: 'BV1Aa411c7Xd', text: '分享' },
  ],
})

// 日记：公开 10 行（末尾 8 行应出现 03~10），私密 2 行
writeText('whale-diary.md', Array.from({ length: 10 }, (_, i) => `公开日记 ${String(i + 1).padStart(2, '0')}`).join('\n') + '\n')
writeText('whale-diary-private.md', '私密日记 01\n私密日记 02\n')
// 刻意不写 selftest-passed.json：要断言「还没跑启动测试」的提醒。

test('status：纯文本一眼看全今天/本周/冷却/评分/日记', () => {
  const out = runStatus()

  assert.match(out.split('\n')[0], /^== B站 状态 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} ==$/)
  assert.ok(out.includes('【今天】看过 2 条（深读 1）'), '今天的观看/深读条数不对：' + out.split('\n')[1])
  assert.ok(out.includes('收藏 1'), '收藏今天应为 1')
  assert.ok(out.includes('点赞 2/6'), '点赞应为 2/6')
  assert.ok(out.includes('动态 3/4'), '动态应为 3/4')
  assert.ok(out.includes('普通评论 1/'), '普通评论应为 1 条')
  assert.ok(out.includes('回评 1/'), '回评应为 1 条')
  assert.ok(out.includes('搭话 1/'), '搭话应为 1 条')
  assert.ok(out.includes('分享 1/3'), '分享应为 1/3')
  assert.match(out, /【本周】看过 \d+\/7/, '本周上限应取配置的 7')
  assert.ok(out.includes('【冷却】'), '缺【冷却】段')
  assert.ok(out.includes('还差'), '30 秒前刚发过普通评论，globalMin 2 分钟应显示「还差」')
  assert.ok(out.includes('【评分】2 条（最高 18/20）'), '评分汇总不对')
  assert.ok(out.includes('★ 18/20  BV1Aa411c7Xd  测试视频一'), '最高分行应带 ★')
  assert.ok(out.includes('【日记·公开末 8 行】'), '缺公开日记段')
  assert.ok(out.includes('公开日记 10'), '应显示公开日记最后一行')
  assert.ok(!out.includes('公开日记 02'), '末 8 行不该含第 2 行')
  assert.ok(out.includes('【日记·私密末 8 行】'), '缺私密日记段')
  assert.ok(out.includes('私密日记 02'), '应显示私密日记最后一行')
  assert.ok(out.includes('还没跑启动测试：node bili.mjs selftest'), '缺启动测试提醒')
  assert.ok(!out.includes('SESSDATA'), '输出里不能出现 cookie')
  assert.ok(!out.includes(temp), '输出里不该出现本机绝对路径')
  assert.ok(out.length <= 4500, '纯文本必须 <= 4500 字符，实际 ' + out.length)
})

test('status --json：字段与纯文本各段一一对应', () => {
  const obj = JSON.parse(runStatus(['--json']))

  assert.equal(obj.ok, true)
  assert.equal(obj.date, today)
  assert.equal(obj.today.watched, 2, '今天看过 2 条')
  assert.equal(obj.today.deep, 1, '深看 1 条')
  assert.equal(obj.today.scored, 2, '今天记分 2 条')
  assert.equal(obj.today.favorites, 1, '今天收藏 1 条')
  assert.equal(obj.today.likes.daily, 2)
  assert.equal(obj.today.likes.max, 6)
  assert.equal(obj.today.dynamics.done, 3)
  assert.equal(obj.today.dynamics.total, 4)
  assert.equal(obj.today.dynamics.anime, false, 'anime 是昨天的，今天不该算完成')
  assert.equal(obj.today.comments.free, 1)
  assert.equal(obj.today.comments.reply, 1)
  assert.equal(obj.today.comments.ta, 1)
  assert.equal(obj.today.comments.share, 1)
  assert.equal(obj.today.comments.total, 4)
  assert.equal(obj.caps.globalMin, 2)
  assert.equal(obj.week.max, 7)
  assert.equal(obj.week.unlimited, false)
  assert.ok(obj.week.watched >= 2, '本周至少看过今天这 2 条')
  assert.equal(obj.cooldown.comment.state, 'wait')
  assert.ok(obj.cooldown.comment.waitMin >= 1, '还差至少 1 分钟')
  assert.equal(obj.cooldown.share.max, 3)
  assert.equal(obj.scores.length, 2)
  assert.equal(obj.scores[0].score, 18)
  assert.equal(obj.scores[0].best, true)
  assert.equal(obj.scores[0].bv, 'BV1Aa411c7Xd')
  assert.equal(obj.diary.lines, 8)
  assert.equal(obj.diary.public.length, 8)
  assert.equal(obj.diary.private.length, 2)
  assert.ok(obj.reminders.some((x) => x.includes('selftest')), '缺启动测试提醒')
})

test('status --diary 0 --scores 3：能收窄输出', () => {
  const obj = JSON.parse(runStatus(['--json', '--diary', '0', '--scores', '3']))
  assert.equal(obj.diary.lines, 0)
  assert.deepEqual(obj.diary.public, [])
  assert.equal(obj.scores.length, 2, '今天只有 2 条评分，--scores 3 不该造假')
})

test('status：日记很长时整体截断到 4500 字符以内', () => {
  const long = Array.from({ length: 40 }, (_, i) => `长日记 ${i + 1} ${'字'.repeat(200)}`).join('\n') + '\n'
  writeText('whale-diary.md', long)
  const out = runStatus(['--diary', '40'])
  assert.ok(out.length <= 4500, '截断后仍超过 4500，实际 ' + out.length)
  assert.ok(out.includes('已截断'), '截断时要给出更短的用法提示')
  assert.ok(out.includes('长日记 1 '), '被截掉的是尾部，开头几行要留着')
})

test('status：只读 —— 跑完账本一个字节都不变', () => {
  const walk = (dir) => {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { out.push(...walk(full)); continue }
      const stat = fs.statSync(full)
      out.push([path.relative(BILI_DIR, full), stat.size, stat.mtimeMs, fs.readFileSync(full, 'utf8')])
    }
    return out.sort((a, b) => a[0].localeCompare(b[0]))
  }
  const before = walk(BILI_DIR)
  const filesBefore = fs.readdirSync(path.join(temp, 'stellar')).sort()
  runStatus()
  const after = walk(BILI_DIR)
  assert.deepEqual(after, before, 'status 不该写任何账本')
  assert.deepEqual(fs.readdirSync(path.join(temp, 'stellar')).sort(), filesBefore, 'status 不该新建任何文件')
})

test.after(() => {
  fs.rmSync(temp, { recursive: true, force: true })
  // PITFALLS：rmSync 可能假成功（Windows 上文件被占用时）——复查一次，还在就再来一遍。
  if (fs.existsSync(temp)) fs.rmSync(temp, { recursive: true, force: true })
  assert.equal(fs.existsSync(temp), false, '临时目录没清掉：' + temp)
})
