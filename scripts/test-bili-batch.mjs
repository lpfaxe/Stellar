#!/usr/bin/env node
// test-bili-batch.mjs —— B站 工具链「少跑几次」那三件事的回归测试（2026-11-23）。
//
// 覆盖：
//   ① 命令表抽成 lib/cmd-map.mjs 之后仍然完整（键数、关键字、脚本路径都在）
//   ② deps 顺带打印的「写类命令怎么传参」段：真的打出来、命令名来自命令表、整段 ≤700 字、--json 有 writeCommands
//   ③ diary append：只追加（第二次不丢第一次）、文件不存在时写标题、空正文/超 4000 字拒绝且不动文件
//   ④ debrief 批量的两件小事：pickBvs 去重保序、batchPlan 的表头与 dropped
//
// 全是离线的：临时 DSH_HOME + 直接跑子进程。**不建 credentials.json** —— deps 只会本地报
// 「没有或读不了凭据文件」，不会带着真凭据去请求 nav 接口，测试也不碰 ~/.dsh。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.join(import.meta.dirname, '..')
const TOOLS = path.join(ROOT, 'plugins', 'stellar', 'tools')
const tmpDirs = []

let pass = 0
let fail = 0
function ok(label, fn) {
  try {
    fn()
    pass += 1
  } catch (e) {
    fail += 1
    console.error('  ✗ ' + label + ' — ' + String(e.message ?? e))
  }
}

function sandbox(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(tmp, 'stellar', 'bili'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'stellar', 'bili.config.json'), JSON.stringify({ persona: { name: '测试角色' } }))
  tmpDirs.push(tmp)
  return tmp
}

function run(script, args, home, opts = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    input: opts.input,
    env: { ...process.env, DSH_HOME: home, USERPROFILE: home, HOME: home, STELLAR_BILI_CONFIG: '' },
  })
}

const CMD_MAP_URL = pathToFileURL(path.join(TOOLS, 'lib', 'cmd-map.mjs')).href
const BATCH_URL = pathToFileURL(path.join(TOOLS, 'lib', 'cmd-batch.mjs')).href

/* ── ① 命令表 ─────────────────────────────────────────────── */
test('CMD_MAP 是完整的一份命令表', async () => {
  const { CMD_MAP } = await import(CMD_MAP_URL)
  const names = Object.keys(CMD_MAP)
  ok('导出 CMD_MAP 且是对象', () => assert.equal(typeof CMD_MAP, 'object'))
  ok('键数 > 50（实际 ' + names.length + '）', () => assert.ok(names.length > 50))
  ok("包含 'debrief'", () => assert.ok(CMD_MAP.debrief))
  ok("包含 'diary'", () => assert.ok(CMD_MAP.diary))
  ok('每项都是 [脚本路径, 说明] 且都非空', () => {
    for (const [name, v] of Object.entries(CMD_MAP)) {
      assert.ok(Array.isArray(v) && v.length >= 2, name + ' 结构不对')
      assert.equal(typeof v[0], 'string'); assert.equal(typeof v[1], 'string')
      assert.ok(v[0].trim() && v[1].trim(), name + ' 有空字段')
    }
  })
  ok('脚本路径都真实存在（搬表时没写错目录）', () => {
    const missing = Object.entries(CMD_MAP).filter(([, [rel]]) => !fs.existsSync(path.join(TOOLS, rel))).map(([n]) => n)
    assert.deepEqual(missing, [])
  })
})

/* ── ② deps 的写类命令参数摘要 ─────────────────────────────── */
test('deps 打印写类命令参数摘要（人读版 + --json）', async () => {
  const { CMD_MAP } = await import(CMD_MAP_URL)
  const home = sandbox('stellar-deps-')
  const deps = path.join(TOOLS, 'commands', 'deps.mjs')

  const r = run(deps, [], home)
  const out = String(r.stdout ?? '')
  ok('退出码是 0 或 3（体检有缺项也不算测试失败）', () => assert.ok([0, 3].includes(r.status), 'status=' + r.status + ' stderr=' + String(r.stderr).slice(0, 200)))
  ok('打印了「写类命令」段', () => assert.match(out, /写类命令/))
  const rows = out.split('\n').filter((l) => /^ {2}[a-z][\w-]* —— /.test(l))
  ok('至少 3 条命令行（实际 ' + rows.length + '）', () => assert.ok(rows.length >= 3))
  ok('命令名都来自 CMD_MAP', () => {
    for (const l of rows) {
      const name = l.trim().split(' —— ')[0]
      assert.ok(CMD_MAP[name], name + ' 不在命令表里')
    }
  })
  const sec = out.slice(out.indexOf('写类命令')).trim()
  // 2026-11-23：预算从 700 放到 1700 —— 700 字会退化成「只留 --go 类」，把 comment / daily 这类
  // 最常用的写命令挤掉，还会把 "--dry|--go" 这个旗标本身截断（那就等于又得 --help 一次）。
  ok('整段 ≤ 1700 字（实际 ' + sec.length + '）', () => assert.ok(sec.length <= 1700))
  ok('已经写了 --go/--dry 的命令出现在段里', () => assert.match(out, /(fav|triple|say|qzone|share-dynamic)/))
  // 每条写命令自己的旗标必须活下来：截断只能砍中间，不能砍掉 --dry|--go
  ok('comment / daily / dm 的 --dry|--go 没被截掉', () => {
    for (const name of ['comment', 'daily', 'dm']) {
      const line = rows.find((l) => l.trim().startsWith(name + ' —— '))
      assert.ok(line, name + ' 没出现在写类命令段里')
      assert.match(line, /--dry\|--go/, name + ' 那行丢了 --dry|--go：' + line.trim())
    }
  })
  ok('段落没有退化成「只留 --go 类」（不打印 /--help 兜底提示）', () => assert.equal(/其余用 node bili\.mjs/.test(out), false))

  const j = run(deps, ['--json'], home)
  const obj = JSON.parse(String(j.stdout ?? '{}'))
  ok('--json 里有 writeCommands 数组', () => assert.ok(Array.isArray(obj.writeCommands)))
  ok('writeCommands 至少 3 条', () => assert.ok(obj.writeCommands.length >= 3))
  ok('每项都有非空 name / usage', () => {
    for (const w of obj.writeCommands) {
      assert.equal(typeof w.name, 'string'); assert.ok(w.name.trim())
      assert.equal(typeof w.usage, 'string'); assert.ok(w.usage.trim())
    }
  })
  ok('writeCommands 的 name 全来自 CMD_MAP', () => {
    for (const w of obj.writeCommands) assert.ok(CMD_MAP[w.name], w.name)
  })
})

/* ── ③ diary append（只追加）───────────────────────────────── */
test('diary append 只追加、不覆盖', () => {
  const home = sandbox('stellar-diary-')
  const diary = path.join(TOOLS, 'commands', 'diary.mjs')
  const file = path.join(home, 'stellar', 'bili', 'whale-diary.md')

  const first = run(diary, ['append', '--public', '第一行：猫在窗台上'], home)
  ok('第一次 append 退出 0', () => assert.equal(first.status, 0, String(first.stderr).slice(0, 300)))
  ok('文件建出来了且含正文', () => {
    assert.ok(fs.existsSync(file))
    assert.match(fs.readFileSync(file, 'utf8'), /- \d\d:\d\d 第一行：猫在窗台上/)
  })
  ok('文件不存在时先写标题（取 config 的 persona.name）', () => {
    assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], '# 鲸鱼日记 · 测试角色')
  })
  const beforeSecond = fs.readFileSync(file, 'utf8')
  const second = run(diary, ['append', '--public', '第二行：风把帘子吹起来了'], home)
  ok('第二次 append 退出 0', () => assert.equal(second.status, 0))
  const afterSecond = fs.readFileSync(file, 'utf8')
  ok('两行都在、顺序对', () => {
    assert.ok(afterSecond.includes('第一行：猫在窗台上'))
    assert.ok(afterSecond.indexOf('第一行') < afterSecond.indexOf('第二行'))
  })
  ok('第二次是纯追加（旧内容是前缀）', () => assert.ok(afterSecond.startsWith(beforeSecond)))
  ok('打印了「已追加 N 字」与行数/路径', () => assert.match(String(second.stdout), /已追加 \d+ 字到公开日记（现共 \d+ 行，文件 .+whale-diary\.md）/))

  const sizeBeforeBad = fs.statSync(file).size
  const empty = run(diary, ['append', '--public', ''], home)
  ok('空正文退出码 1', () => assert.equal(empty.status, 1))
  ok('空正文给一行提示', () => assert.match(String(empty.stderr), /没给正文/))
  ok('空正文不动文件', () => assert.equal(fs.statSync(file).size, sizeBeforeBad))

  const tooLong = run(diary, ['append', '--private', '长'.repeat(4001)], home)
  ok('超 4000 字退出码 1', () => assert.equal(tooLong.status, 1))
  ok('超长提示说清上限', () => assert.match(String(tooLong.stderr), /4000 字/))
  ok('超长不动文件（私密文件都没建）', () => {
    assert.equal(fs.statSync(file).size, sizeBeforeBad)
    assert.equal(fs.existsSync(path.join(home, 'stellar', 'bili', 'whale-diary-private.md')), false)
  })

  const priv = run(diary, ['append', '--private', '--stdin', '--heading', '21:40 夜读十条'], home, { input: '管道进来的正文\n' })
  ok('--private --stdin --heading 退出 0', () => assert.equal(priv.status, 0, String(priv.stderr)))
  const privText = fs.readFileSync(path.join(home, 'stellar', 'bili', 'whale-diary-private.md'), 'utf8')
  ok('私密文件标题是「# 私人日记 · 名字」', () => assert.equal(privText.split('\n')[0], '# 私人日记 · 测试角色'))
  ok('--heading 先写 ## 行，再写 - HH:MM 正文', () => assert.match(privText, /## 21:40 夜读十条\n\n- \d\d:\d\d 管道进来的正文/))

  // 日记总开关关着 = 什么都不记（主人明确要的开关，不能被 append 绕过去）
  fs.writeFileSync(path.join(home, 'stellar', 'bili.config.json'), JSON.stringify({ persona: { name: '测试角色' }, diary: { enabled: false } }))
  const sizeBeforeOff = fs.statSync(file).size
  const off = run(diary, ['append', '--public', '关掉时不该写进去'], home)
  ok('总开关关着时退出 0 且不写', () => {
    assert.equal(off.status, 0)
    assert.equal(fs.statSync(file).size, sizeBeforeOff)
  })
})

/* ── ④ debrief 批量的两个纯函数 ────────────────────────────── */
test('pickBvs / batchPlan', async () => {
  const { BV_RE, pickBvs, batchPlan } = await import(BATCH_URL)
  const picked = pickBvs(['BV1xx411c7mD', '--no-frames', 'BV1yy411c7mE', 'BV1xx411c7mD'])
  ok('pickBvs 去重后 2 条', () => assert.equal(picked.length, 2))
  ok('pickBvs 保持原顺序', () => assert.deepEqual(picked, ['BV1xx411c7mD', 'BV1yy411c7mE']))
  ok('BV_RE 认 12 位的 BV 号', () => {
    assert.equal(BV_RE.test('BV1xx411c7mD'), true)
    assert.equal(BV_RE.test('BV1xx411c7m'), false)
    assert.equal(BV_RE.test('av170001'), false)
    assert.equal(BV_RE.test('xBV1xx411c7mD'), false)
  })

  const plan = batchPlan(['BV1aa411c7mA', 'BV1bb411c7mB', 'BV1cc411c7mC'])
  ok('batchPlan 表头形如 ===== [2/3] BV… =====', () => assert.equal(plan.header(2), '===== [2/3] BV1bb411c7mB ====='))
  ok('batchPlan header(1) 从 1 开始', () => assert.equal(plan.header(1), '===== [1/3] BV1aa411c7mA ====='))
  ok('batchPlan 没超出时 dropped=0', () => assert.equal(plan.dropped, 0))

  const many = batchPlan(['BV1aa411c7mA', 'BV1bb411c7mB', 'BV1cc411c7mC', 'BV1dd411c7mD', 'BV1ee411c7mE', 'BV1ff411c7mF', 'BV1gg411c7mG'])
  ok('默认上限 5 条', () => assert.equal(many.bvs.length, 5))
  ok('超出条数记在 dropped', () => assert.equal(many.dropped, 2))
  ok('超出时表头分母是实际跑的条数', () => assert.match(many.header(5), /\[5\/5\] BV1ee411c7mE/))
})

after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  console.log((fail === 0 ? '✅ ' : '❌ ') + 'bili-batch: ' + pass + ' passed, ' + fail + ' failed')
  process.exitCode = fail === 0 ? 0 : 1
})
