#!/usr/bin/env node
// 花钱前先算一遍：今天的账 + 这件事大概要多少钱。
//
//   node bili.mjs cost                                   # 今日账单 + 常见任务价目表
//   node bili.mjs cost --preset bili-watch               # 按预设估一件事
//   node bili.mjs cost --tokens 200000 --out 4000 --turns 3
//   node bili.mjs cost --chars 8000 --kind zh            # 按字数粗估
//   node bili.mjs cost --json                            # 给代码看的
//
// 口径与 src/cost-estimate.js / model-prices.js / token-budget.js 一致，
// 和 QQ 会话里的 stellar_cost 工具是同一套算法。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TASK_PRESETS,
  advise,
  budgetSnapshot,
  charsToTokens,
  describePlan,
  estimateTask,
  formatEstimate,
  formatSnapshot
} from '../../../../src/cost-estimate.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(name)
  if (i < 0) return fallback
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}
const json = argv.includes('--json')

const snap = budgetSnapshot()

if (json && !flag('--preset') && !flag('--tokens') && !flag('--chars')) {
  console.log(JSON.stringify({
    day: snap.day,
    tier: snap.rates.tier,
    tierLabel: snap.rates.tierLabel,
    remaining: snap.remaining,
    presets: Object.fromEntries(Object.entries(TASK_PRESETS).map(([id]) => [id, estimateTask({ preset: id })])),
    predictions: null
  }, null, 2))
  process.exit(0)
}

const presetId = typeof flag('--preset') === 'string' ? flag('--preset') : ''
const tokens = flag('--tokens')
const chars = flag('--chars')
const out = flag('--out', flag('--outputTokens'))
const turns = flag('--turns')
const kind = typeof flag('--kind') === 'string' ? flag('--kind') : 'zh'
const model = typeof flag('--model') === 'string' ? flag('--model') : undefined

if (presetId && !TASK_PRESETS[presetId]) {
  console.error('没有这个预设: ' + presetId + '。可选: ' + Object.keys(TASK_PRESETS).join(' / '))
  process.exit(2)
}

const wantEstimate = Boolean(presetId) || tokens !== undefined || chars !== undefined
if (!wantEstimate) {
  console.log('今天的账：')
  console.log('  ' + formatSnapshot(snap))
  console.log('  按类别：QQ ¥' + snap.remaining.qq.usedCny.toFixed(4)
    + ' / B站 ¥' + snap.remaining.bili.usedCny.toFixed(4)
    + ' / 其他 ¥' + snap.remaining.other.usedCny.toFixed(4))
  console.log('')
  console.log('常见任务的估价（' + snap.rates.tierLabel + '）：')
  for (const [id, p] of Object.entries(TASK_PRESETS)) {
    const est = estimateTask({ preset: id })
    console.log('  ' + id.padEnd(16) + p.label.padEnd(24, ' ') + formatEstimate(est))
  }
  console.log('')
  console.log('估具体任务：node bili.mjs cost --preset bili-watch')
  console.log('           node bili.mjs cost --tokens 200000 --out 4000 --turns 3')
  console.log('           node bili.mjs cost --chars 8000 --kind zh')
  process.exit(0)
}

const opts = {}
if (presetId) opts.preset = presetId
if (tokens !== undefined) opts.contextTokens = Number(tokens)
if (chars !== undefined) opts.contextTokens = charsToTokens(Number(chars), kind)
if (out !== undefined) opts.outputTokens = Number(out)
if (turns !== undefined) opts.turns = Number(turns)
if (model) opts.model = model

const est = estimateTask(opts)
const a = advise(est, snap)

if (json) {
  console.log(JSON.stringify({ ...est, advice: a, snapshot: { day: snap.day, tier: snap.rates.tier, remaining: snap.remaining } }, null, 2))
  process.exit(0)
}

console.log(describePlan(est, snap))
