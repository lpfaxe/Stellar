// 今日图片池：她今天看过的图（B站封面 / 评论区图 / 空间公开动态里的图），当天留、跨天自动清。
//
//   node bili.mjs pool list [--json] [--n 20]
//   node bili.mjs pool add  <图片路径> [--origin bili-cover] [--caption "它是什么"]
//   node bili.mjs pool clear [--all]
//   node bili.mjs pool prune
//
// 用途：发 QQ 空间说说 / B站动态时想配一张“今天真的看过”的图 →
//   qzone post --text "…" --image "<list 里给的文件路径>" --right 4 --dry → --go
// 没有合适的图就别配（主人原话：没有符合的不配）。
import path from 'node:path'
import { addImage, clearPool, listImages, prunePool, poolDayDir } from '../lib/image-pool.mjs'

const argv = process.argv.slice(2)
const sub = String(argv[0] ?? 'list').toLowerCase()
const args = new Map()
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const key = a.slice(2)
  const val = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
  args.set(key, val)
}

if (sub === 'list' || sub === 'ls') {
  const { dir, day, images } = listImages()
  const limit = Math.max(1, Number(args.get('n') ?? 40) || 40)
  if (args.has('json')) {
    console.log(JSON.stringify({ day, dir, images: images.slice(-limit) }))
  } else if (!images.length) {
    console.log('今天的图片池是空的（' + dir + '）——看过视频/评论区之后就会有了。')
  } else {
    console.log('今天（' + day + '）的图：' + images.length + ' 张 → ' + dir)
    images.slice(-limit).forEach((img, i) => {
      const from = img.origin ? ' [' + img.origin + ']' : ''
      const cap = img.caption ? '' + String(img.caption).replace(/\s+/g, ' ').slice(0, 60) : ''
      console.log((i + 1) + '. ' + img.file + from + (cap ? '  ' + cap : ''))
    })
    console.log('\n配图写法：qzone post --text "…" --image "<上面某个路径>" --right 4 --dry')
    console.log('没有合适的就别配（主人要求：没有符合的不配）。')
  }
} else if (sub === 'add') {
  const file = argv[1]
  if (!file || file.startsWith('--')) { console.error('用法: pool add <图片路径> [--origin …] [--caption "…"]'); process.exit(2) }
  const got = addImage(path.resolve(file), {
    origin: String(args.get('origin') ?? 'manual'),
    caption: String(args.get('caption') ?? ''),
    url: String(args.get('url') ?? ''),
    key: String(args.get('key') ?? ''),
  })
  if (!got.ok) { console.error('✗ 没能入池：' + got.error); process.exit(1) }
  console.log('✓ 已入池：' + got.file + '（' + Math.round(got.bytes / 1024) + ' KiB）')
} else if (sub === 'clear') {
  const all = args.has('all')
  const removed = clearPool({ all })
  console.log('✓ 已清空' + (all ? '全部' : '今天') + '的图片池（' + removed + ' 个目录）')
} else if (sub === 'prune') {
  const removed = prunePool()
  console.log('✓ 跨天清理：删掉 ' + removed + ' 个旧日期目录（今天保留 ' + poolDayDir() + '）')
} else {
  console.error('pool 的子命令只有 list / add / clear / prune，收到 ' + sub)
  process.exit(2)
}
