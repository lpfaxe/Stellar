#!/usr/bin/env node
// test-town-prompt-digest.mjs —— 「小镇近况」一行（2026-11-22）。
//
// 全离线：只用临时目录里造的 status.json，不连小镇、不碰真数据目录。
// 发布版口径：小镇默认关，必须显式 town.enabled=true 才给指针（dev 默认开），
// 所以下面造 fixture 时都先把 bili.config.json 打开，否则测不到近况那一段。
// 覆盖：从 recall 抠当天那两句、去掉说话人前缀与句末标点、重复去重、
//       24 小时过期就不提、金额/大厅桌数、提示词里真的拼进去、坏文件不炸。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(root, 'src', 'town-prompt.js')).href)

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}

const RECALL = [
  '【小镇存档 · 这三天玩到（游戏）】',
  '今天（11-22）：鱼丸·柚：鱼丸·柚约Fugu在咖啡馆见了面，聊了打招呼约她出来、咖啡馆新甜点。；守灯：回港的时候顺手修了网。；鱼丸·柚：鱼丸·柚答应Fugu看完咖啡馆回来告诉Fugu甜点值不值。',
  '昨天（11-21）：和老张下了三盘棋。',
].join('\n')

// ---- todayDigestFromRecall ----
{
  const text = mod.todayDigestFromRecall(RECALL)
  ok(text.includes('鱼丸·柚约Fugu在咖啡馆见了面'), '抠出今天第一件事')
  ok(!text.startsWith('鱼丸·柚：'), '去掉了说话人前缀')
  ok(!text.includes('。'), '去掉了句末句号')
  ok(!text.includes('。；'), '不会拼出「。；」')
  ok(text.split('；').length <= 2, '最多两件事')
  ok(!text.includes('昨天'), '不拿昨天的')
  ok(mod.todayDigestFromRecall('') === '', '空输入回空串')
  ok(mod.todayDigestFromRecall('今天（11-22）：') === '', '今天行没内容回空串')
  ok(mod.todayDigestFromRecall('没有任何日期行') === '', '没有日期行回空串')
  const dup = mod.todayDigestFromRecall('今天（11-22）：A：同一件事。；B：同一件事。')
  ok(dup === '同一件事', '完全相同的事件只留一条')
}

// ---- townDigestText ----
{
  const now = Date.parse('2026-11-22T12:00:00Z')
  const snap = { at: now - 60_000, recall: RECALL, status: { piggyYuan: 18.534 }, lobby: { tables: 68 } }
  const text = mod.townDigestText(snap, { now })
  ok(text.includes('身上 18.53 元'), '金额保留两位')
  ok(text.includes('大厅 68 桌在等人'), '大厅桌数拼进去')
  ok(text.length <= 160, '整体不超过 160 字')
  // 数组形式的大厅（联网现场是数组）：只取长度，不当数字
  ok(mod.townDigestText({ at: now - 60_000, lobby: { tables: [{}, {}, {}] } }, { now }).includes('3 桌'), '数组形式的大厅取长度')
  // 过期：宁可不提，也别让她说旧消息
  ok(mod.townDigestText({ at: now - 25 * 3600_000, recall: RECALL }, { now }) === '', '超过 24 小时不提')
  ok(mod.townDigestText({ at: now - 23 * 3600_000, recall: RECALL }, { now }).includes('咖啡馆'), '23 小时内还提')
  // 秒级时间戳也要认
  ok(mod.townDigestText({ at: Math.floor((now - 60_000) / 1000), recall: RECALL }, { now }).includes('咖啡馆'), '秒级 at 也认')
  ok(mod.townDigestText(null, { now }) === '', 'null 快照回空串')
  ok(mod.townDigestText({}, { now }) === '', '空对象回空串')
}

// ---- townPromptLine（拼装 + 缓存 + 坏文件） ----
function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-town-digest-'))
  fs.mkdirSync(path.join(dir, 'state', 'town'), { recursive: true })
  return dir
}
{
  const home = tmpHome()
  const file = path.join(home, 'state', 'town', 'status.json')
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 60_000, recall: RECALL, status: { piggyYuan: 2 }, lobby: { tables: 5 } }))
  fs.writeFileSync(path.join(home, 'bili.config.json'), JSON.stringify({ town: { enabled: true } }))
  const normal = mod.townPromptLine({ stellarDir: home })
  ok(normal.includes('【小镇 · 游戏】'), '平常日子有小镇那一段')
  ok(normal.includes('【小镇近况（游戏里的，不是现实）】'), '近况标题在场')
  ok(normal.includes('大厅 5 桌在等人'), '近况内容拼进提示词')
  ok(normal.endsWith('\n\n'), '结尾仍是两个换行（后面的段落靠它分隔）')
  const idle = mod.townPromptLine({ stellarDir: home, mode: 'idle' })
  ok(idle.includes('今天是摸鱼日'), '摸鱼日多那一句')
  ok(idle.length > normal.length, '摸鱼日提示更长')
  // 关掉小镇：bili.config.json 里 town.enabled=false
  fs.writeFileSync(path.join(home, 'bili.config.json'), JSON.stringify({ town: { enabled: false } }))
  ok(mod.townPromptLine({ stellarDir: home }) === '', '小镇关着时返回空串')
  // 关掉时也应该不管近况
  fs.writeFileSync(path.join(home, 'bili.config.json'), JSON.stringify({ town: { enabled: true } }))
  fs.writeFileSync(file, '{坏掉的 json')
  const broken = mod.townPromptLine({ stellarDir: home })
  ok(broken.includes('【小镇 · 游戏】'), '快照坏掉仍给指针')
  ok(!broken.includes('【小镇近况'), '快照坏掉就不提近况')
  ok(!broken.includes('undefined'), '坏文件不会带出 undefined')
}
{
  const home = tmpHome()
  // 没有 status.json（刚装好：小镇还没采过）；小镇要显式开着才走到「只有指针没近况」这条路
  fs.writeFileSync(path.join(home, 'bili.config.json'), JSON.stringify({ town: { enabled: true } }))
  const text = mod.townPromptLine({ stellarDir: home })
  ok(text.includes('【小镇 · 游戏】') && !text.includes('【小镇近况'), '没有快照时只给指针')
}
{
  // 过期快照：缓存与保鲜都要挡住
  const home = tmpHome()
  const file = path.join(home, 'state', 'town', 'status.json')
  fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 48 * 3600_000, recall: RECALL }))
  fs.writeFileSync(path.join(home, 'bili.config.json'), JSON.stringify({ town: { enabled: true } }))
  ok(!mod.townPromptLine({ stellarDir: home }).includes('【小镇近况'), '48 小时前的快照不提近况')
}

console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
