#!/usr/bin/env node
// test-voice-style.mjs —— 「说话方式」模块的回归测试（2026-11-22）。
//
// 全是离线的：临时目录 + 直接读写文件，不碰桥接、不连 QQ。
// 覆盖：没文件/坏文件/enabled=false 三种兜底、词条渲染、600 字按整行截断、
//       重复与坏词条归一、保存前校验报错、AI 味指标计数、统计跨天归零与开关。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(root, 'src', 'voice-style.js')).href)

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-style-'))
const styleFile = path.join(TMP, 'voice-style.json')
const statsFile = path.join(TMP, 'voice-stats.json')
function writeStyle(obj) {
  fs.writeFileSync(styleFile, JSON.stringify(obj, null, 2), 'utf8')
  mod.resetVoiceStyleCache()
}
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
}

/* 1. 没有文件 → 用内置原则，source=default */
mod.resetVoiceStyleCache()
const missing = mod.voiceStylePrompt({ file: styleFile })
ok(missing.source === 'default', '没文件时 source=default')
ok(missing.text.includes('原则：'), '没文件时也给出原则段')
ok(missing.text.startsWith(mod.VOICE_HEAD), '首行固定是【说话方式】模板')
ok(missing.chars < 600, '默认渲染远小于上限')

/* 2. enabled=false → 回到 2026-11-22 之前那句 */
writeStyle({ enabled: false, principles: ['不该出现'] })
const off = mod.voiceStylePrompt({ file: styleFile })
ok(off.text === mod.LEGACY_FALLBACK, 'enabled=false 时用旧句')
ok(!off.text.includes('不该出现'), 'enabled=false 时不读文件里的原则')

/* 3. 词条渲染 */
writeStyle({
  enabled: true,
  principles: ['你不是客服。'],
  entries: [{ from: '这句我记下了', to: ['知道啦', '懂了'] }],
})
const withEntries = mod.voiceStylePrompt({ file: styleFile })
ok(withEntries.text.includes('「这句我记下了」→ 知道啦 / 懂了'), '词条按「原句」→ 改法渲染')
ok(withEntries.entries === 1, 'entry 计数正确')
ok(withEntries.source === 'file', '正常文件 source=file')

/* 4. 600 字按整行截断，不切半个字 */
const many = []
for (let i = 0; i < 40; i++) many.push({ from: '原句第' + i + '条很长很长很长很长', to: ['改法A', '改法B'] })
writeStyle({ enabled: true, principles: ['原则一'], entries: many })
const big = mod.voiceStylePrompt({ file: styleFile })
ok(big.chars <= 600, '渲染不超过 600 字（实际 ' + big.chars + '）')
ok(big.truncated === true, '超长时标记 truncated')
ok(big.droppedLines > 0, '记录了被丢掉的行数')
ok(!/\n- 「原句第3[0-9]条[^\n]*$/.test(big.text.slice(-40)), '末尾不是半行')

/* 5. 归一时丢掉重复与没改法的词条 */
const norm = mod.normalizeVoiceStyle({
  entries: [
    { from: '重复句', to: ['A'] },
    { from: '重复句', to: ['B'] },
    { from: '没有改法', to: [] },
    { from: '  ', to: ['C'] },
  ],
})
ok(norm.entries.length === 1, '重复/空/无改法的词条被丢掉（剩 ' + norm.entries.length + '）')
ok(norm.errors.length >= 2, '归一过程记下原因')
ok(norm.maxChars === 600, '没写 maxChars 时默认 600')

/* 6. 保存前校验：太长、缺改法、类型不对都要报 */
const bad = mod.validateVoiceStyle({
  principles: ['长'.repeat(200)],
  entries: [{ from: 'x', to: [] }],
})
ok(bad.ok === false && bad.errors.length >= 2, '校验能同时报多条错')
const good = mod.validateVoiceStyle({ principles: ['短原则'], entries: [{ from: '好的我明白了', to: ['懂了'] }] })
ok(good.ok === true, '正常内容校验通过')
ok(good.rendered.chars > 0, '校验时顺带返回渲染结果')

/* 7. AI 味指标 */
const traits = mod.countVoiceTraits('首先，甲。其次，乙。——总之就是这样，希望对你有帮助。', {
  entries: [{ from: '总之', to: ['就是这样'] }, { from: 'x', to: ['懂了'] }],
})
ok(traits.emDash === 1, '数破折号')
ok(traits.enum3 === 1, '数三点列举')
ok(traits.serviceWord >= 3, '数客服腔词（实际 ' + traits.serviceWord + '）')
ok(traits.entryHit === 1, '词条原句命中')
ok(traits.entryFollow === 1, '用了替换说法')
const empty = mod.countVoiceTraits('', null)
ok(empty.chars === 0 && empty.emDash === 0, '空文本不炸')

/* 8. 统计：写盘、累加、开关、跨天归零 */
const NOW = new Date('2026-11-22T14:00:00+08:00').getTime()
writeStyle({ enabled: true, stats: true, principles: ['p'], entries: [{ from: '这句我记下了', to: ['知道啦'] }] })
const rec1 = mod.recordVoiceStats(['这句我记下了——好的'], { styleFile, statsFile, now: NOW })
ok(rec1 && rec1.messages === 1, '统计写入了 1 条')
ok(rec1.emDash === 1 && rec1.entryHit === 1, '统计里分项正确')
const rec2 = mod.recordVoiceStats(['知道啦'], { styleFile, statsFile, now: NOW })
ok(rec2.messages === 2 && rec2.entryFollow === 1, '同一天累加')
const today = mod.readVoiceStats({ file: statsFile, now: NOW })
ok(today.day === '2026-11-22' && today.messages === 2, 'readVoiceStats 读回今天')
const tomorrow = mod.readVoiceStats({ file: statsFile, now: NOW + 24 * 3600 * 1000 })
ok(tomorrow.messages === 0 && tomorrow.day === '2026-11-23', '跨天自动归零')
writeStyle({ enabled: true, stats: false, principles: ['p'] })
const off2 = mod.recordVoiceStats(['这句我记下了'], { styleFile, statsFile, now: NOW })
ok(off2 === null, 'stats=false 时不记录')

/* 9. 坏文件不炸，回退内置原则 */
fs.writeFileSync(styleFile, '{ 这不是 JSON', 'utf8')
mod.resetVoiceStyleCache()
const broken = mod.voiceStylePrompt({ file: styleFile })
ok(broken.source === 'default', 'JSON 坏了 source=default')
ok(broken.error && broken.error.length > 0, '坏文件带回原因')
ok(broken.text.includes('原则：'), '坏文件仍然可用（有兜底原则）')

/* 10. 缓存：文件变了要能读到新内容（mtime+size 变了才重解析） */
writeStyle({ enabled: true, principles: ['第一版'] })
mod.voiceStylePrompt({ file: styleFile })
fs.writeFileSync(styleFile, JSON.stringify({ enabled: true, principles: ['第二版长一点的内容'] }), 'utf8')
const reloaded = mod.voiceStylePrompt({ file: styleFile })
ok(reloaded.text.includes('第二版长一点的内容'), '改文件后无需重置缓存也能读到新内容')

cleanup()
console.log((fail === 0 ? '✅ ' : '❌ ') + 'voice-style: ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
