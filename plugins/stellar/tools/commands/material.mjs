#!/usr/bin/env node
// 素材包命令：node bili.mjs material [...]
//
// 为什么单独一条命令而不是塞进 report：日报和说说都要用同一份素材（见闻 / 聊天 / 小镇 / 配图候选），
// 两个入口各收一份必然漂。这里只做「读 + 打印」，真正的口径全在 lib/material-kit.mjs。
import { buildKit, renderKit, renderMemoryLines, renderImageLines, pickImage, IMAGE_SOURCE_LABELS, FALLBACK_WEEKLY_MAX } from '../lib/material-kit.mjs'

function usage() {
  console.log('用法: node bili.mjs material [--for report|qzone] [--day YYYY-MM-DD] [--memory|--images] [--pick [--kw 词]] [--json]')
  console.log('  --for      report=日报口径（带她记得的事实）/ qzone=说说口径（不带事实，提醒别引用聊天）')
  console.log('  --memory   只打印记忆段；--images 只打印配图候选')
  console.log('  --pick     从本地候选里按权重挑一张（封面 6 : 相册 4），命中 --kw 的 ×4')
  console.log('  --json     打印原始素材包（调试用）')
}

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const k = a.slice(2)
  const nx = argv[i + 1]
  if (nx !== undefined && !String(nx).startsWith('--')) { opt[k] = nx; i += 1 } else opt[k] = true
}

const audience = opt.for === 'report' ? 'report' : (opt.for === 'qzone' ? 'qzone' : 'report')
const day = typeof opt.day === 'string' ? opt.day : undefined

try {
  const kit = await buildKit({ day, audience })
  if (opt.json) {
    console.log(JSON.stringify(kit, null, 2))
    process.exit(0)
  }
  if (opt.memory) {
    console.log(renderMemoryLines(kit, { audience }).join('\n'))
    process.exit(0)
  }
  if (opt.images) {
    console.log(renderImageLines(kit).join('\n'))
    process.exit(0)
  }
  if (opt.pick) {
    const kw = typeof opt.kw === 'string' ? opt.kw : ''
    const hit = pickImage(kit.images.candidates, { keyword: kw })
    if (hit.ok) {
      console.log('选中：' + (IMAGE_SOURCE_LABELS[hit.source] || hit.source) + '（权重 ' + hit.weight + (hit.keywordHit ? '，文案命中关键词「' + kw + '」×4' : '') + '）')
      console.log('  路径：' + hit.path)
      if (hit.caption) console.log('  说明：' + hit.caption)
      console.log('  用法：stellar_qzone_post 传 imagePath: "' + hit.path + '"（或 qzone post --image "' + hit.path + '" --go）')
      process.exit(0)
    }
    const used = Number(kit.recent.fallbackThisWeek) || 0
    const left = Math.max(0, FALLBACK_WEEKLY_MAX - used)
    console.log('本地没有可用的图（B站封面池空、小镇相册也空，或都用过了）。')
    if (left > 0) console.log('兜底（权重最低，本周还剩 ' + left + ' 次）：可以网上搜一张，或用 image_generate 生成一张；只用一张。')
    else console.log('兜底额度这周已经用完（' + used + '/' + FALLBACK_WEEKLY_MAX + '），今天就别配图了 —— 硬凑一张不如空着。')
    process.exit(0)
  }
  console.log(renderKit(kit, { audience }))
} catch (e) {
  console.error('素材包读取失败：' + (e && e.message ? e.message : String(e)))
  console.error('下一步：node bili.mjs material --for report 重试一次；还失败就把这段错误原样告诉主人（别自己编素材）。')
  process.exit(1)
}
