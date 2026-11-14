// 看一眼主人甩过来的 B 站链接：从任意 URL / 分享文案里抠出 BV，然后直接 debrief。
//
//   node bili.mjs link "https://b23.tv/xxxx"           # 短链会自动跟跳转
//   node bili.mjs link "【标题】 https://www.bilibili.com/video/BV1xx411c7mD" --no-frames
//
// 参数里第一个非 -- 的东西当输入；其余参数原样透传给 debrief。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEBRIEF = path.join(here, 'debrief.mjs')
const BV_RE = /BV[0-9A-Za-z]{10}/

const argv = process.argv.slice(2)
const passthrough = argv.filter((a) => a !== (argv.find((x) => !x.startsWith('--')) ?? ''))
const input = argv.find((a) => !a.startsWith('--'))

if (!input) {
  console.error('用法: node bili.mjs link "<B站链接/分享文案/BV号>" [debrief 的参数，如 --no-frames]')
  process.exit(2)
}

function bvFrom(text) {
  const m = BV_RE.exec(text || '')
  return m ? m[0] : ''
}

let bv = bvFrom(input)
let resolved = ''

if (!bv && /^https?:\/\//i.test(input.trim())) {
  const url = input.trim()
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } })
    resolved = res.url || ''
    bv = bvFrom(resolved) || bvFrom(await res.text())
  } catch (err) {
    console.error(`短链解析失败: ${err.message}`)
  }
}

if (!bv) {
  console.error('没在输入里找到 BV 号。把完整链接或「【标题】https://…」整段发我。')
  process.exit(3)
}

console.log(`BV: ${bv}${resolved ? `  （来自 ${resolved}）` : ''}`)
const r = spawnSync(process.execPath, [DEBRIEF, bv, ...passthrough.filter((a) => a !== input)], { stdio: 'inherit' })
process.exit(r.status ?? 1)
