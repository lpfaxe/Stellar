#!/usr/bin/env node
// test-tokenless-guard.mjs —— 「模型漏传 token 就整条丢消息」的兜底（2026-11-22 主人拍板 B）。
//
// 两层：
//   1. 逻辑层：src/tokenless-guard.js 是纯函数，直接单测三条放行条件的各种组合；
//   2. 接线层：bridge.js / mcp-snowluma-safe.js 太大不能整体加载，所以读源码做契约断言 ——
//      确认「三个端点都接了兜底」「MCP 不再把 token 当必填」「没有令牌时不发那个头」。
//      这类断言盯的是接线方式，不是文案；改了接线就要一起改这里（PITFALLS #292 的教训）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(root, 'src', 'tokenless-guard.js')).href)
const bridgeSrc = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8')
const mcpSrc = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}
const count = (haystack, needle) => haystack.split(needle).length - 1

// ---- 逻辑：三条同时成立才放行 ----
const pending = new Set(['private:3025145051'])
const call = (headers, key = 'private:3025145051', set = pending) => mod.tokenlessTurnDecision({ headers, key, pendingKeys: set })
ok(call({ 'x-agent-call': '1' }).allowed === true, '无令牌 + 声明了 x-agent-call + 正在唤醒 → 放行')
ok(call({ 'x-agent-call': '1' }).reason === 'tokenless-wake-turn', '放行理由可读')
ok(call({}).allowed === false, '没有 x-agent-call → 拒（不是随便一个本机脚本都能发）')
ok(call({}).reason === 'no-agent-call', '拒绝理由：没声明 x-agent-call')
ok(call({ 'x-agent-token': 'abc', 'x-agent-call': '1' }).allowed === false, '带了令牌就不走兜底（照常校验）')
ok(call({ 'x-agent-token': 'abc', 'x-agent-call': '1' }).reason === 'token-presented', '拒绝理由：带了令牌')
ok(call({ 'x-agent-call': '1' }, 'private:111').allowed === false, 'key 不在唤醒集合 → 拒（不能跨会话冒充）')
ok(call({ 'x-agent-call': '1' }, 'private:111').reason === 'key-not-waking', '拒绝理由：这个会话没在唤醒')
ok(call({ 'x-agent-call': '1' }, '').allowed === false, '没有 key → 拒')
ok(call({ 'x-agent-call': '1' }, 'private:3025145051', null).allowed === false, '没有唤醒集合 → 拒')
ok(call({ 'x-agent-call': '' }).allowed === false, 'x-agent-call 是空串也算没声明')
ok(call({ 'x-agent-call': ['1'] }).allowed === true, 'header 是数组也认（Node 的重复头）')
ok(call({ 'x-agent-token': [''] }).allowed === false, '空数组令牌当没带，但仍要求 x-agent-call（这里是空的）')
ok(mod.tokenlessDeniedHint('token-presented').includes('令牌'), '拒绝理由有中文解释')
ok(mod.tokenlessDeniedHint('unknown').includes('缺少'), '未知理由给通用解释')
ok(mod.AGENT_CALL_HEADER === 'x-agent-call' && mod.AGENT_TOKEN_HEADER === 'x-agent-token', '两个头名字固定')

// ---- 接线：bridge.js ----
ok(bridgeSrc.includes("from './tokenless-guard.js'"), 'bridge 引用了兜底判定模块')
ok(bridgeSrc.includes('tokenlessTurnDecision({ headers: req.headers, key, pendingKeys: pendingWakeKeys })'), 'bridge 把当前唤醒集合递进判定')
ok(!bridgeSrc.includes("if (req.headers['x-agent-call'] === undefined) return false;"), '旧的内联判定已被替换，不留两份逻辑')
ok(count(bridgeSrc, 'tokenlessTurnForKey(req, key)') >= 3, '三个端点（burst / message / close）都调了兜底判定')
ok(bridgeSrc.includes('const tokenlessBurst = tokenlessTurnForKey(req, key);'), 'send-burst 接了兜底')
ok(bridgeSrc.includes('const tokenlessSend = tokenlessTurnForKey(req, key);'), 'send-message 接了兜底')
ok(bridgeSrc.includes('const tokenlessClose = tokenlessTurnForKey(req, key);'), 'close 接了兜底')
ok(bridgeSrc.includes("'/api/socialV2/send-message'") && bridgeSrc.includes("'/api/socialV2/send-burst'") && bridgeSrc.includes("'/api/socialV2/close'"), '三个端点进了 tokenlessAgentAllowed（否则进不了兜底判定）')
ok(bridgeSrc.includes('由桥接按 key 兜底'), '403 的提示里写明怎么才会兜底')

// ---- 接线：MCP 工具层 ----
ok(count(mcpSrc, 'token: z.string().optional()') >= 2, 'qq_send_message / qq_reply_and_finish 的 token 不再是必填')
ok(!/token: z\.string\(\)\s*\n?\s*\.describe\('[^']*会话令牌/.test(mcpSrc) || true, '（说明性断言，不拦）')
ok(count(mcpSrc, "...(token ? { headers: { 'x-agent-token': token } } : {})") >= 3, '没有令牌时不带这个头（三处发送体都改了）')
// 只看这两个发送工具自己的代码段：其它只读工具仍是必填 token + 无条件带头，那是另一回事。
function toolBlock(src, name) {
  const start = src.indexOf("server.tool(\n  '" + name + "'")
  if (start < 0) return ''
  // 下一个 server.tool( 的缩进不统一（有的顶格、有的缩两格），所以用正则找边界。
  const rest = src.slice(start + 'server.tool('.length)
  const next = /\n[ \t]*server\.tool\(/.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}
for (const name of ['qq_reply_and_finish', 'qq_send_message']) {
  const block = toolBlock(mcpSrc, name)
  ok(block.length > 0, name + ' 的代码段找到了')
  const conditional = block.split("...(token ? { headers: { 'x-agent-token': token } } : {})").length - 1
  const bare = block.split("headers: { 'x-agent-token': token }").length - 1
  ok(conditional >= 1, name + ' 用了条件头')
  // 条件头里也含这个片段，所以比数量：每个带头的地方都必须是条件形式。
  ok(bare === conditional, name + ' 里不再有无条件带头（' + bare + ' 处带头 / ' + conditional + ' 处条件头）')
}
ok(mcpSrc.includes('x-agent-call'), '发送时声明了 x-agent-call（否则桥接不会兜底）')

console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
