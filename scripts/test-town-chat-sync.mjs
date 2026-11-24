#!/usr/bin/env node
// test-town-chat-sync.mjs —— QQ 私聊会话 → 小镇插件 alsoSids 的自动重绑（2026-11-22）。
//
// 全离线：fetch 注入假的，不碰真的插件、不写真数据目录（用临时目录）。
// 覆盖：只认主人私聊、同一个会话不重复打、换会话时加新的并摘旧的、失败静默并退避、
//       网络异常不抛、坏 sid / 空 base 直接跳过、绑定记录可读回。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(root, 'src', 'town-chat-sync.js')).href)

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}

const OWNER = '3025145051'
const KEY = 'private:' + OWNER
const SID_A = 'session-8ccb5170-066f-4917-bce0-7cbffc12096b'
const SID_B = 'session-11111111-2222-3333-4444-555555555555'
const BASE = 'http://127.0.0.1:13959'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-town-chat-sync-'))
}
function fakeFetch(result) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const r = typeof result === 'function' ? result(url, init) : result
    if (r instanceof Error) throw r
    return r
  }
  impl.calls = calls
  return impl
}
const okRes = (status = 200, text = '{"ok":true}') => ({ status, ok: status >= 200 && status < 300, text: async () => text })

// ---- 纯函数 ----
ok(mod.isOwnerPrivateKey(KEY, OWNER) === true, '认主人私聊 key')
ok(mod.isOwnerPrivateKey('private:123', OWNER) === false, '别人的私聊不放行')
ok(mod.isOwnerPrivateKey('group:1132808329', OWNER) === false, '群聊不放行')
ok(mod.isOwnerPrivateKey(KEY, '') === false, '没配主人 QQ 时一律不放行')
ok(mod.chatBindPath('/x/stellar').replace(/\\/g, '/').endsWith('state/town/chat-bind.json'), '记录文件路径')
ok(JSON.stringify(mod.readChatBind(tmpHome())) === '{}', '没有记录文件回空对象')
{
  const home = tmpHome()
  fs.mkdirSync(path.join(home, 'state', 'town'), { recursive: true })
  fs.writeFileSync(mod.chatBindPath(home), '{坏 json')
  ok(JSON.stringify(mod.readChatBind(home)) === '{}', '坏记录文件回空对象')
}

// ---- 不满足条件：一个请求都不发 ----
{
  const home = tmpHome()
  const f = fakeFetch(okRes())
  let r = await mod.syncTownChatBinding({ stellarDir: home, key: 'private:999', ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f })
  ok(r.skipped === 'not-owner' && f.calls.length === 0, '不是主人私聊 → 不发请求')
  r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: 'oops', baseUrl: BASE, fetchImpl: f })
  ok(r.skipped === 'bad-session' && f.calls.length === 0, '会话 id 形状不对 → 不发请求')
  r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: '', fetchImpl: f })
  ok(r.skipped === 'no-base' && f.calls.length === 0, '没有 DSH 地址 → 不发请求')
  r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: null })
  ok(r.skipped === 'no-fetch', '没有 fetch → 跳过而不是抛')
}

// ---- 首次绑定 ----
{
  const home = tmpHome()
  const f = fakeFetch(okRes())
  const r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 1000 })
  ok(r.ok === true && r.changed === true, '首次绑定成功')
  ok(f.calls.length === 1, '首次绑定只发一次请求')
  ok(f.calls[0].url === BASE + '/fishbowl-town/save?fish=whale', '打到插件 /save 并指明是哪条鱼：' + f.calls[0].url)
  ok(f.calls[0].init.method === 'POST', '用 POST')
  ok(f.calls[0].init.headers.origin === BASE, '带上 origin（插件只认同源）')
  const body = JSON.parse(f.calls[0].init.body)
  ok(body.addAlso === SID_A, '按 addAlso 登记会话')
  ok(body.bridgeChat === true, '顺手把 bridgeChat 打开（主人拍板 B）')
  ok(!('removeAlso' in body), '第一次没有旧会话可摘')
  const saved = mod.readChatBind(home)
  ok(saved.ok === true && saved.sid === SID_A && saved.at === 1000, '绑定记录落盘')
  ok(saved.base === BASE && saved.fishId === 'whale', '记录里带地址与鱼的编号')
  // 同一个会话再来一次：不发请求
  const r2 = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 2000 })
  ok(r2.ok === true && r2.skipped === 'same' && f.calls.length === 1, '同一个会话不重复打请求')
  // force 时照打（排障用）
  const r3 = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 3000, force: true })
  ok(r3.ok === true && f.calls.length === 2, 'force 时不看记录直接打')
}

// ---- 换会话：加新的、摘旧的 ----
{
  const home = tmpHome()
  const f = fakeFetch(okRes())
  await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 1000 })
  const r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_B, baseUrl: BASE, fetchImpl: f, now: 2000 })
  ok(r.ok === true && r.removed === SID_A, '换会话成功并报出摘掉了哪个')
  const body = JSON.parse(f.calls[1].init.body)
  ok(body.addAlso === SID_B, '加的是新会话')
  ok(body.removeAlso === SID_A, '摘的是旧会话（否则 alsoSids 堆满 4 个就再也进不去）')
  ok(mod.readChatBind(home).sid === SID_B, '记录更新成新会话')
  // 鱼编号可覆盖
  const r2 = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_B, baseUrl: BASE + '/', fetchImpl: f, now: 3000, fishId: '2', force: true })
  ok(f.calls[2].url.endsWith('fish=2'), 'fishId 可指定（多鱼时按编号）')
  ok(f.calls[2].url.startsWith(BASE + '/fishbowl-town'), 'base 末尾多余斜杠不会拼出 //')
  ok(r2.ok === true, '末尾斜杠也成功')
}

// ---- 失败：静默 + 退避 ----
{
  const home = tmpHome()
  const f = fakeFetch(okRes(500, '{"ok":false,"message":"存不下"}'))
  const r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 1000 })
  ok(r.ok === false && r.status === 500, 'HTTP 500 返回 ok:false 而不是抛')
  ok(String(r.error).includes('存不下'), '把插件给的错误带出来')
  const saved = mod.readChatBind(home)
  ok(saved.ok === false && saved.sid === SID_A, '失败也记下来（退避要用）')
  const r2 = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 2000 })
  ok(r2.skipped === 'backoff' && f.calls.length === 1, '退避窗口内不再打')
  const r3 = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 1000 + mod.CHAT_BIND_RETRY_MS + 1 })
  ok(r3.ok === false && f.calls.length === 2, '过了退避窗口会再试一次')
  ok(mod.CHAT_BIND_RETRY_MS === 10 * 60 * 1000, '退避 10 分钟')
  // 换会话时不受退避影响（旧记录是别的 sid 就该试）
  const r4 = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_B, baseUrl: BASE, fetchImpl: f, now: 1500 })
  ok(f.calls.length === 3, '换了会话不受上一个 sid 的退避影响')
  ok(r4.ok === false, '新会话这次也失败（假 fetch 恒 500）')
}
{
  const home = tmpHome()
  const f = fakeFetch(new Error('connect ECONNREFUSED'))
  const r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 1000 })
  ok(r.ok === false && String(r.error).includes('ECONNREFUSED'), '网络异常不抛，带回错误')
  ok(mod.readChatBind(home).ok === false, '网络异常也记进记录文件')
}
{
  // fetch 返回没有 status 的怪东西：不能炸，按失败处理
  const home = tmpHome()
  const f = fakeFetch(async () => ({ status: 0, text: async () => '' }))
  const r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 1000 })
  ok(r.ok === false, 'status=0 当失败')
}
{
  // 记录文件写不进去（父路径是文件）：不能抛，只是成功也记不下
  const home = tmpHome()
  fs.writeFileSync(path.join(home, 'state'), 'not-a-dir')
  const f = fakeFetch(okRes())
  const r = await mod.syncTownChatBinding({ stellarDir: home, key: KEY, ownerUin: OWNER, sessionId: SID_A, baseUrl: BASE, fetchImpl: f, now: 1000 })
  ok(r.ok === true && r.changed === true, '写不了记录文件也照常返回成功')
}

console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
