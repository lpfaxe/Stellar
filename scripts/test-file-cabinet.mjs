#!/usr/bin/env node
// 文件柜写入侧的判据（src/file-cabinet.js）。
//
// 2026-11-20：主人要求「让她能根据我的要求把文件存进文件柜」。写入规则必须和面板
// （stellar-manager/lib/files.js）完全一致，否则她在 QQ 里存的文件和面板里看到的不是同一个柜子。
// 这里把清洗、同名不覆盖、索引追加、边界（空文件 / 超大 / 目录穿越）都钉住。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CABINET_INDEX,
  CABINET_MAX_BYTES,
  CABINET_MAX_NAME,
  cabinetDir,
  ensureCabinetDir,
  humanBytes,
  kindOf,
  listCabinetNames,
  safeName,
  saveToCabinet,
} from '../src/file-cabinet.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; return }
  fail += 1
  console.log('✗ ' + name + (extra ? ' — ' + extra : ''))
}

// ── 1. safeName：清洗规则 ──────────────────────────────────────────────
ok(safeName('报告.pdf') === '报告.pdf', '中文名原样保留')
ok(safeName('a/b/c.pdf') === 'a_b_c.pdf', '正斜杠换成下划线')
ok(safeName('a\\b.pdf') === 'a_b.pdf', '反斜杠换成下划线')
const trav = safeName('..\\..\\x.pdf')
ok(!trav.includes('/') && !trav.includes('\\'), '穿越名里没有路径分隔符', trav)
ok(!trav.startsWith('.'), '穿越名不以点开头', trav)
ok(trav === '_.._x.pdf' || !trav.includes('..'), '穿越名被压成单个文件名', trav)
ok(safeName('a<b>c:d"e|f?g*h.pdf') === 'abcdefgh.pdf', 'Windows 保留字符被去掉')
ok(safeName('  .hidden  ') === 'hidden', '首部点被剥掉')
ok(safeName('') === '', '空名字返回空串')
ok(safeName('...') === '', '只有点也返回空串')
const longName = safeName('长'.repeat(200) + '.pdf')
ok(longName.length <= CABINET_MAX_NAME, '超长名字被截到 120', String(longName.length))
ok(longName.endsWith('.pdf'), '截断后保留扩展名', longName)

// ── 2. kindOf ────────────────────────────────────────────────────────
const kinds = [
  ['a.pdf', 'pdf'], ['a.docx', 'word'], ['a.doc', 'word'], ['a.xlsx', 'excel'], ['a.csv', 'excel'],
  ['a.pptx', 'ppt'], ['a.png', 'image'], ['a.gif', 'image'], ['a.zip', 'archive'], ['a.exe', 'other'], ['noext', 'other'],
]
for (const [name, want] of kinds) ok(kindOf(name) === want, 'kindOf ' + name, kindOf(name))

// ── 3. cabinetDir / humanBytes ───────────────────────────────────────
ok(cabinetDir('C:\\u\\.dsh') === path.join('C:\\u\\.dsh', 'stellar', 'files'), '柜子目录是 <dshHome>/stellar/files')
ok(humanBytes(512) === '512 B', 'humanBytes B')
ok(humanBytes(2048) === '2 KB', 'humanBytes KB')
ok(humanBytes(3 * 1048576) === '3.0 MB', 'humanBytes MB')

// ── 4. 落盘 ──────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-cab-'))
try {
  ensureCabinetDir(dir)
  const one = saveToCabinet(dir, '无机化学B2024秋期中.pdf', Buffer.from('pdf-bytes'), { by: 'owner', note: '期中卷' })
  ok(one.ok === true, '第一次存成功', JSON.stringify(one))
  ok(one.name === '无机化学B2024秋期中.pdf', '文件名原样')
  ok(one.bytes === 9, '字节数对')
  ok(one.kind === 'pdf', 'kind 是 pdf')
  ok(fs.readFileSync(path.join(dir, one.name), 'utf8') === 'pdf-bytes', '内容落盘正确')
  ok(path.resolve(one.path).startsWith(path.resolve(dir) + path.sep), '路径在柜子目录里')

  const two = saveToCabinet(dir, '无机化学B2024秋期中.pdf', Buffer.from('second'), { by: 'stellar' })
  ok(two.ok === true && two.name === '无机化学B2024秋期中 (2).pdf', '同名不覆盖，加 (2)', two.name)
  const three = saveToCabinet(dir, '无机化学B2024秋期中.pdf', Buffer.from('third'), { by: 'stellar' })
  ok(three.name === '无机化学B2024秋期中 (3).pdf', '再来一个加 (3)', three.name)
  ok(fs.readFileSync(path.join(dir, '无机化学B2024秋期中.pdf'), 'utf8') === 'pdf-bytes', '原件没被覆盖')

  const evil = saveToCabinet(dir, '..\\..\\evil.txt', Buffer.from('x'), { by: 'owner' })
  ok(evil.ok === true, '穿越名仍能存（只是名字被清洗）', JSON.stringify(evil))
  ok(path.resolve(evil.path).startsWith(path.resolve(dir) + path.sep), '穿越名没有跑出柜子', evil.path)
  ok(fs.readdirSync(path.dirname(path.resolve(dir))).every((n) => !n.includes('evil')), '柜子外面没有 evil.txt')

  ok(saveToCabinet(dir, '', Buffer.from('x')).ok === false, '空名字被拒')
  ok(saveToCabinet(dir, 'empty.txt', Buffer.alloc(0)).ok === false, '空内容被拒')
  const big = saveToCabinet(dir, 'big.bin', Buffer.alloc(CABINET_MAX_BYTES + 1))
  ok(big.ok === false && /太大/.test(big.message), '超过 512MB 被拒', big.message)
  ok(/512\.0 MB/.test(big.message), '超限提示写明 512.0 MB', big.message)
  ok(CABINET_MAX_BYTES === 512 * 1024 * 1024, '上限常量就是 512MB', String(CABINET_MAX_BYTES))

  // 索引
  const idx = fs.readFileSync(path.join(dir, CABINET_INDEX), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  ok(idx.length >= 4, '索引有记录', String(idx.length))
  ok(idx[0].kind === 'add' && idx[0].name === '无机化学B2024秋期中.pdf', '索引第一条是第一次存的')
  ok(idx[0].by === 'owner', '索引记了 by=owner')
  ok(idx[0].note === '期中卷', '索引记了备注')
  ok(typeof idx[0].at === 'number' && idx[0].at > 1600000000000, '索引有时间戳')
  ok(idx[1].by === 'stellar', '索引记了 by=stellar')

  // 列目录
  const names = listCabinetNames(dir)
  ok(Array.isArray(names) && names.length === 4, '列出来 4 个文件（不含索引）', String(names.length))
  ok(names.every((r) => r.name !== CABINET_INDEX), '索引不算文件')
  ok(names.every((r) => typeof r.kind === 'string' && typeof r.bytes === 'number'), '每条带 kind/bytes')
  fs.writeFileSync(path.join(dir, '.hidden'), 'x')
  ok(listCabinetNames(dir).every((r) => r.name !== '.hidden'), '隐藏文件不列')
  ok(listCabinetNames(path.join(dir, 'nope')).length === 0, '目录不存在时返回空数组')

  // note 截断
  const noted = saveToCabinet(dir, 'note.txt', Buffer.from('n'), { by: 'owner', note: 'x'.repeat(500) })
  const last = JSON.parse(fs.readFileSync(path.join(dir, CABINET_INDEX), 'utf8').trim().split('\n').pop())
  ok(noted.ok === true && last.note.length === 200, '备注截到 200 字', String(last.note && last.note.length))
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ── 5. 接线：工具真的注册了，提示里真的叫她存 ────────────────────────
const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8')
ok(mcp.includes("from './file-cabinet.js'"), 'MCP 服务导入了 file-cabinet')
ok(mcp.includes("server.tool(\n  'stellar_file_save'"), 'stellar_file_save 已注册')
ok(mcp.includes('同名不覆盖，自动改成'), '工具说明里写了同名不覆盖')
ok(mcp.includes('只有主人能用 path/url 存本机或网上的文件'), '非主人被挡在 path/url 外')
ok(/GATED_TOPICS = Object\.freeze\(\{[\s\S]*?stellar_file_save: 'file'/.test(mcp), 'stellar_file_save 也挂上 file 规则门')

const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8')
const bridgeHits = (bridge.match(/stellar_file_save/g) || []).length
ok(bridgeHits >= 3, '唤醒提示里有 3 处以上「存下来就调 stellar_file_save」', String(bridgeHits))
ok(bridge.includes('没调工具就说「收好了」是骗人'), '提示里明确禁止空口说收好了')

const rules = fs.readFileSync(path.join(ROOT, 'plugins', 'stellar', 'tools', 'rules', 'file.md'), 'utf8')
ok(rules.includes('stellar_file_save'), 'rules/file.md 教了怎么存')
ok(rules.includes('没调工具就别说「收好了」'), 'rules/file.md 写了不许空口答应')

console.log('\n文件柜写入判据：' + pass + ' 通过，' + fail + ' 失败')
process.exit(fail ? 1 : 0)
