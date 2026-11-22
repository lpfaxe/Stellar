#!/usr/bin/env node
// test-voice-style-bili.mjs —— 「说话方式」第二批（B站 / QQ空间 侧注入）的回归测试（2026-11-22）。
//
// 全是离线的：临时目录 + 直接调用插件里的 voice-style-line.js，不启动调度器、不碰真状态。
// 覆盖：没文件走默认、词条渲染、enabled=false 不注入、坏 JSON 兜底、dir/file 两种定位、
//       600 字上限、以及「调度器真的把它接在 identityContextLines 里」的静态接线。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const line = await import(pathToFileURL(path.join(root, 'plugins', 'stellar', 'lib', 'voice-style-line.js')).href)
const core = await import(pathToFileURL(path.join(root, 'src', 'voice-style.js')).href)

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bili-'))
const file = path.join(TMP, 'voice-style.json')
function writeStyle(obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  core.resetVoiceStyleCache()
}
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
}

/* 1. 没有文件 → 默认原则（和 QQ 侧同一份默认），不是空串 */
core.resetVoiceStyleCache()
const missing = line.voiceStyleBlockForBili({ file })
ok(missing.length > 0, '没文件时也注入默认原则（不是空串）')
ok(missing.startsWith(core.VOICE_HEAD), '首行是【说话方式】模板')
ok(missing.includes('原则：'), '带原则段')
ok(!missing.includes('词条'), '没词条时不出现词条段')

/* 2. 有文件 → 只注入主人写的内容，且首尾无多余空行 */
writeStyle({
  enabled: true,
  maxChars: 600,
  principles: ['先接话，别先总结'],
  entries: [{ id: 'e1', from: '这句我记下了', to: ['知道啦', '懂了'] }],
})
const custom = line.voiceStyleBlockForBili({ file })
ok(custom.includes('先接话，别先总结'), '原则进了提示词')
ok(custom.includes('「这句我记下了」→ 知道啦 / 懂了'), '词条按「原句 → 改法」渲染')
ok(custom === custom.trim(), '首尾没有多余空行/空格')

/* 3. enabled=false → B站 这边不注入（不拿 QQ 的兜底句顶上） */
writeStyle({ enabled: false, principles: ['不该出现'] })
const off = line.voiceStyleBlockForBili({ file })
ok(off === '', 'enabled=false 时 B站 侧不注入任何东西')

/* 4. 坏 JSON → 回到默认（不抛、也不空） */
core.resetVoiceStyleCache()
fs.writeFileSync(file, '{ 这不是 json', 'utf8')
let brokenThrew = false
let broken = ''
try { broken = line.voiceStyleBlockForBili({ file }) } catch (e) { brokenThrew = true }
ok(!brokenThrew, '坏 JSON 不抛异常')
ok(broken.length > 0, '坏 JSON 时仍注入默认原则')

/* 5. 目录定位：dir + voice-style.json */
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bili-dir-'))
fs.writeFileSync(path.join(dir2, 'voice-style.json'), JSON.stringify({
  enabled: true,
  principles: ['句子短一点'],
  entries: [],
}), 'utf8')
core.resetVoiceStyleCache()
const byDir = line.voiceStyleBlockForBili({ dir: dir2 })
ok(byDir.includes('句子短一点'), 'dir 选项能找到 voice-style.json')
ok(line.voiceStyleFileIn(dir2) === path.join(dir2, 'voice-style.json'), 'voiceStyleFileIn 拼的是 voice-style.json')

/* 6. file 选项优先于 dir */
core.resetVoiceStyleCache()
const byFile = line.voiceStyleBlockForBili({ dir: dir2, file })
ok(byFile.includes('原则：'), 'file 选项优先（读的是那个坏掉的文件 → 默认原则）')

/* 7. 600 字上限：堆很多词条也只到上限附近 */
const many = []
for (let i = 0; i < 60; i += 1) {
  many.push({ id: 'x' + i, from: '第' + i + '句我记下了', to: ['知道啦', '懂了', '好的'] })
}
writeStyle({ enabled: true, maxChars: 600, principles: ['先接话'], entries: many })
const capped = line.voiceStyleBlockForBili({ file })
ok(capped.length <= 600, '渲染长度不超过 600 字上限（实际 ' + capped.length + '）')
ok(capped.length < 700, '算上模板首行仍在同一量级')

/* 8. 状态目录：默认落在 <DSH_HOME>/stellar/state */
ok(line.voiceStateDir({ DSH_HOME: 'C:/x/.dsh' }) === path.join('C:/x/.dsh', 'stellar', 'state'), 'DSH_HOME 决定状态目录')

/* 9. 静态接线：调度器 import 了它，并且放在人设之后 */
const scheduler = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'lib', 'scheduler.js'), 'utf8')
ok(/import \{ voiceStyleBlockForBili \} from '\.\/voice-style-line\.js'/.test(scheduler), 'scheduler.js 导入了 voiceStyleBlockForBili')
const identity = scheduler.slice(scheduler.indexOf('function identityContextLines()'), scheduler.indexOf('function identityContextLines()') + 700)
ok(identity.includes('personaCardBlock(),'), 'identityContextLines 里人设排第一')
ok(identity.indexOf('voiceStyleBlockForBili(),') > identity.indexOf('personaCardBlock(),'), '说话方式排在人格卡之后')
ok(identity.indexOf('voiceStyleBlockForBili(),') < identity.indexOf('selfIdentityBlockForBili(),'), '说话方式排在自我锚点之前')
ok(!/await voiceStyleBlockForBili/.test(identity), '它是同步的（唤醒提示拼接不能 await）')

cleanup()
try { fs.rmSync(dir2, { recursive: true, force: true }) } catch (e) {}

console.log((fail === 0 ? '✅' : '❌') + ' voice-style-bili: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
