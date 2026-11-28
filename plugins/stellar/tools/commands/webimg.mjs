// webimg.mjs —— 她自己上网找图（owner 2026-11-11 22:25 要求）。
//
// 用法：
//   node bili.mjs webimg search "雾凇 风景" --n 4 [--json]
//   node bili.mjs webimg search "雾凇 风景" --preload 100 [--json]   （只预加载，拼联系表）
//   node bili.mjs webimg pick --session p-... --picks 1,4,7 [--json]（挑中的才存进今天）
//   node bili.mjs webimg search --mode structure --name 阿司匹林 [--json]
//   node bili.mjs webimg search --mode structure --cas 50-78-2 [--json]
//   node bili.mjs webimg search --mode product --name 阿司匹林 --strength 100mg --manufacturer 拜耳 [--json]
//   node bili.mjs webimg list [--json]
//   node bili.mjs webimg del --name <文件名>    （她删 → 控制台会留下记录）
//   node bili.mjs webimg clear                  （清空今天）
//   node bili.mjs webimg path                   （今天的目录）
//
// 2026-11-27：找图从「Bing 网页顺序前 N 张」改成三条路分流：
//   structure → PubChem（CID 确定）；product → 来源可信 + OCR 校验；photo → 像素/来源排序。
// 具体实现拆在 lib/webimg/ 下，本文件只做参数解析与命令分发。
import { clearWebImages, dayDir, deleteWebImage, listWebImages, MAX_PER_DAY } from '../lib/web-images.mjs'
import { pickImages, searchImages, webimgPreloadStatus } from '../lib/webimg/index.mjs'

// bili.mjs 用 spawnSync 透传参数：argv = [node, webimg.mjs, <action>, ...]
const raw = process.argv.slice(2)
const action = String(raw[0] && !String(raw[0]).startsWith('--') ? raw[0] : 'list')
const argv = raw.slice(raw[0] && !String(raw[0]).startsWith('--') ? 1 : 0)
const args = new Map()
const flags = new Set()
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) { positional.push(a); continue }
  const key = a.slice(2)
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) { flags.add(key); continue }
  args.set(key, next)
  i += 1
}

function human(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + 'MB'
  if (n >= 1024) return Math.round(n / 1024) + 'KB'
  return n + 'B'
}

function pick(name) { return String(args.get(name) ?? '').trim() }

async function search() {
  const query = String(args.get('q') ?? args.get('query') ?? args.get('kw') ?? positional[0] ?? '').trim()
  const mode = pick('mode') || 'auto'
  const want = Math.max(1, Math.min(10, Number(args.get('n') ?? 4) || 4))
  const preload = Math.max(0, Math.min(100, Number(pick('preload') ?? 0) || 0))
  const input = {
    query,
    mode,
    name: pick('name') || (mode === 'structure' || mode === 'product' ? query : ''),
    nameEn: pick('name-en'),
    cas: pick('cas'),
    smiles: pick('smiles'),
    manufacturer: pick('manufacturer'),
    brand: pick('brand'),
    strength: pick('strength'),
    dosageForm: pick('dosage-form')
  }
  if (!query && !input.name && !input.cas && !input.smiles && !input.nameEn) {
    console.error('用法: node bili.mjs webimg search "关键词" --n 4');
    console.error('   或: node bili.mjs webimg search --mode structure --name 阿司匹林');
    process.exit(2)
  }
  const res = await searchImages(input, { n: want, preload })
  if (flags.has('json')) {
    // images 与 items 同义：MCP 侧历史上用 images，保留两套字段。
    console.log(JSON.stringify({
      ok: res.ok,
      mode: res.mode,
      query: res.query || query,
      verified: Boolean(res.verified),
      preload: Boolean(res.preload),
      session: res.session || '',
      sheet: res.sheet || '',
      stats: res.stats || {},
      items: res.items || [],
      images: res.items || [],
      notes: res.notes || [],
      code: res.code || '',
      error: res.error || '',
      hint: res.hint || '',
      dir: res.dir || dayDir(),
      count: res.count ?? listWebImages().images.length,
      max: res.max || MAX_PER_DAY
    }))
    if (!res.ok) process.exit(1)
    return
  }
  if (!res.ok) {
    console.log('找图失败（' + (res.code || 'UNKNOWN') + '）：' + (res.error || '没有可用结果'))
    if (res.hint) console.log('下一步：' + res.hint)
    process.exit(1)
  }
  if (res.preload) {
    console.log('预加载「' + (res.query || query) + '」→ 候选 ' + (res.stats?.candidates ?? '?') + ' 条，下载 ' + (res.stats?.downloaded ?? res.items.length) + ' 张')
    console.log('  session：' + res.session)
    console.log('  联系表：' + (res.sheet || '（没拼出来）'))
    for (const note of res.notes || []) console.log('  · ' + note)
    for (const s of res.items) {
      const dim = s.width && s.height ? s.width + '×' + s.height : ''
      console.log('  #' + String(s.index).padStart(2, '0') + '  ' + human(s.bytes) + (dim ? '  ' + dim : '') + (s.verified ? '  [包装文字已核对]' : '') + (s.title ? '  ' + s.title.slice(0, 60) : ''))
    }
    console.log('下一步：看联系表挑 1–5 张，node bili.mjs webimg pick --session ' + res.session + ' --picks 1,4,7')
    return
  }
  const label = res.mode === 'structure' ? '结构式' : res.mode === 'product' ? '药品包装图' : '图'
  console.log('搜「' + (res.query || query) + '」→ ' + label + ' 存了 ' + res.items.length + ' 张（今天共 ' + (res.count ?? '?') + '/' + (res.max || MAX_PER_DAY) + ' 张）')
  for (const note of res.notes || []) console.log('  · ' + note)
  for (const s of res.items) {
    const dim = s.width && s.height ? s.width + '×' + s.height : ''
    console.log('  🖼 ' + s.file + '  [' + human(s.bytes) + (dim ? ' ' + dim : '') + ']' + (s.verified ? ' ✓已验证' : ''))
  }
}

async function pickFromPreload() {
  const session = pick('session')
  const rawPicks = pick('picks') || pick('pick')
  const picks = String(rawPicks || '').split(/[,，\s]+/).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
  if (!session || !picks.length) {
    console.error('用法: node bili.mjs webimg pick --session p-... --picks 1,4,7')
    process.exit(2)
  }
  const res = pickImages(session, picks)
  if (flags.has('json')) {
    console.log(JSON.stringify({ ok: res.ok, items: res.items || [], images: res.items || [], notes: res.notes || [], code: res.code || '', error: res.error || '', hint: res.hint || '', dir: res.dir || dayDir(), count: res.count ?? listWebImages().images.length, max: res.max || MAX_PER_DAY }))
    if (!res.ok) process.exit(1)
    return
  }
  if (!res.ok) {
    console.log('存图失败（' + (res.code || 'UNKNOWN') + '）：' + (res.error || '没有可用结果'))
    if (res.hint) console.log('下一步：' + res.hint)
    process.exit(1)
  }
  console.log('已存 ' + res.items.length + ' 张（今天共 ' + res.count + '/' + res.max + ' 张）')
  for (const note of res.notes || []) console.log('  · ' + note)
  for (const it of res.items) console.log('  🖼 ' + it.file + '  ' + (it.width || 0) + '×' + (it.height || 0))
}

function showList() {
  const d = listWebImages()
  if (flags.has('json')) { console.log(JSON.stringify({ ok: true, ...d })); return }
  console.log('今天的网图（' + d.day + '）：' + d.images.length + '/' + d.max + ' 张 → ' + d.dir)
  for (const it of d.images) {
    const tags = [it.by === 'her' ? '她找的' : '', it.title || ''].filter(Boolean).join(' · ')
    console.log('  ' + it.name + '  [' + human(it.bytes) + ']' + (tags ? '  ' + tags : ''))
  }
  if (d.deletes.length) {
    console.log('最近删掉的：')
    for (const r of d.deletes.slice(0, 5)) console.log('  ' + r.name + '  由 ' + (r.by || '?') + ' 删于 ' + new Date(r.at).toLocaleString('zh-CN', { hour12: false }))
  }
}

function run() {
  if (action === 'list' || action === 'ls') return showList()
  if (action === 'path') { console.log(dayDir()); return }
  if (action === 'search' || action === 'find' || action === 'get') return search()
  if (action === 'pick') return pickFromPreload()
  if (action === 'preload-status') { console.log(JSON.stringify(webimgPreloadStatus())); return }
  if (action === 'del' || action === 'rm') {
    const name = String(args.get('name') ?? args.get('id') ?? positional[0] ?? '')
    if (!name) { console.error('用法: node bili.mjs webimg del --name <文件名>'); process.exit(2) }
    const r = deleteWebImage(name, { by: String(args.get('by') ?? 'her') })
    if (!r.ok) { console.error('没删成：' + r.reason); process.exit(1) }
    console.log('已删 ' + r.name + '（控制台会看到这条记录）')
    return
  }
  if (action === 'clear') {
    const r = clearWebImages({ by: String(args.get('by') ?? 'her') })
    console.log('已清空 ' + r.day + ' 的网图（' + r.removed + ' 张）')
    return
  }
  console.error('未知子命令：' + action + '（search / pick / list / del / clear / path）')
  process.exit(2)
}

// run() 里大部分子命令是同步的，返回值可能是 undefined —— 不能直接 .catch。
Promise.resolve()
  .then(run)
  .catch((e) => { console.error('webimg 失败：' + (e?.message ?? e)); process.exit(1) })
