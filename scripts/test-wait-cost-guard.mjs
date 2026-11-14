// 2026-11-12 成本闸回归：guard 必须真的挡住重复等待/重复收尾，且不能误伤 reply 与沉睡前观察。
// 起因：token 分析显示 330 轮里 wait 392 次、close 268 次，每次重发整段上下文（平均 91K），
// 合计占账单 17.7%；预设提示词已写「发完就 reply_and_finish」，但执行率不够，所以加代码兜底。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'stellar', 'qq-tool-restrict.mjs')

// 用最小 ctx 桩拿到插件注册的 guard；DSH 真身的 ctx.tools 也只有这两个方法被用到。
async function loadGuard() {
  const mod = await import(pathToFileURL(PLUGIN).href)
  let guard = null
  const ctx = {
    tools: {
      restrict() {},
      guard(fn) { guard = fn }
    },
    on() {}
  }
  mod.apply(ctx)
  assert.equal(typeof guard, 'function', '插件没有注册 tools.guard')
  return guard
}

const KEY = 'private:1000000001'
const WAIT = 'mcp__snowluma__qq_wait_for_messages'
const CLOSE = 'mcp__snowluma__qq_close_conversation'
const exec = (name, args) => ({ name, arguments: args })

test('普通等待 90 秒内第 3 次被拒绝', async () => {
  const guard = await loadGuard()
  assert.equal(guard(exec(WAIT, { key: KEY, purpose: 'messages', timeoutMs: 60000 })), undefined)
  assert.equal(guard(exec(WAIT, { key: KEY, purpose: 'messages', timeoutMs: 60000 })), undefined)
  const denied = guard(exec(WAIT, { key: KEY, purpose: 'messages', timeoutMs: 60000 }))
  assert.equal(typeof denied, 'string', '第 3 次应该被拒')
  assert.match(denied, /reply_and_finish/, '拒绝文案要给替代方案')
})

test('reply 型等待不受限制', async () => {
  const guard = await loadGuard()
  for (let i = 0; i < 5; i += 1) {
    assert.equal(guard(exec(WAIT, { key: KEY, purpose: 'reply', quietMs: 10000 })), undefined)
  }
})

test('沉睡前 300 秒观察不受限制', async () => {
  const guard = await loadGuard()
  for (let i = 0; i < 5; i += 1) {
    assert.equal(guard(exec(WAIT, { key: KEY, purpose: 'messages', timeoutMs: 300000 })), undefined)
  }
})

test('不同会话各算各的', async () => {
  const guard = await loadGuard()
  assert.equal(guard(exec(WAIT, { key: 'private:1', timeoutMs: 60000 })), undefined)
  assert.equal(guard(exec(WAIT, { key: 'private:1', timeoutMs: 60000 })), undefined)
  assert.equal(typeof guard(exec(WAIT, { key: 'private:1', timeoutMs: 60000 })), 'string')
  assert.equal(guard(exec(WAIT, { key: 'private:2', timeoutMs: 60000 })), undefined)
})

test('收尾 45 秒内重复被拒绝', async () => {
  const guard = await loadGuard()
  assert.equal(guard(exec(CLOSE, { key: KEY })), undefined)
  const denied = guard(exec(CLOSE, { key: KEY }))
  assert.equal(typeof denied, 'string', '重复收尾应该被拒')
  assert.match(denied, /qq_send_message/, '拒绝文案要说明怎么接着说')
})

test('没有 key 的调用放行（不误伤别的工具/探测）', async () => {
  const guard = await loadGuard()
  assert.equal(guard(exec(WAIT, {})), undefined)
  assert.equal(guard(exec(WAIT, { key: KEY })), undefined)
})
