#!/usr/bin/env node
// test-town-album.mjs —— 鱼缸相册镜像的回归测试（2026-11-22）。
//
// 全是离线的：fetch 注入假的，不连小镇。覆盖 id 校验、URL 拼装、四种魔数、
// 不带授权头、超大只留缩略图、双限淘汰、索引坏掉不炸。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(root, 'src', 'town-album.js')).href)
const clientMod = await import(pathToFileURL(path.join(root, 'src', 'town-client.js')).href)

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; return }
  fail += 1
  console.error('  ✗ ' + label)
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)])
const ID1 = 'al_' + '0123456789abcdef'
const ID2 = 'al_' + 'fedcba9876543210'
const ID3 = 'al_' + 'aaaabbbbccccdddd'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-town-album-'))
}

// ---- 纯函数 ----
ok(clientMod.ALBUM_ID_RE.test(ID1), 'id 正则认 al_+16 hex')
ok(!clientMod.ALBUM_ID_RE.test('al_short'), 'id 正则拒短 id')
ok(!clientMod.ALBUM_ID_RE.test('../../etc/passwd'), 'id 正则拒路径穿越')
ok(mod.looksLikeImage(PNG) === '.png', '魔数认 PNG')
ok(mod.looksLikeImage(JPG) === '.jpg', '魔数认 JPEG')
ok(mod.looksLikeImage(Buffer.from('<html>hi</html>')) === '', '魔数拒 HTML')
ok(mod.extFromType('image/webp; charset=binary') === '.webp', 'content-type 认 webp')
ok(mod.extFromType('text/html') === '', 'content-type 拒非图片')

// ---- URL 拼装 ----
const base = 'https://fishbowltown.com/town/api/outside'
ok(clientMod.albumFileUrl(base, ID1, { thumb: true }) === 'https://fishbowltown.com/town/api/album/' + ID1 + '/thumb', '缩略图 URL')
let threw = ''
try { clientMod.albumFileUrl(base, 'al_zzz') } catch (e) { threw = e.code }
ok(threw === 'bad_album_id', '非法 id 抛 bad_album_id')

// ---- 同步：假 client + 假 fetch ----
const requests = []
function fakeFetch(real) {
  return async (url, init = {}) => {
    requests.push({ url, headers: init.headers || {}, method: init.method || 'GET' })
    return { ok: true, status: 200, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => real, text: async () => '' }
  }
}

{
  const home = tmpHome()
  const client = {
    baseUrl: base,
    read: async () => ({ available: true, data: { items: [
      { item_id: ID1, kind: 'photo', what: '海边合影', created: '2026-11-20T10:00:00Z', with: ['阿鲸'] },
      { item_id: ID2, kind: 'paint', what: '画铺画的', created: '2026-11-21T10:00:00Z' },
      { item_id: ID3, kind: 'song', what: '点给谁的一首歌', created: '2026-11-21T11:00:00Z' },
    ], making: 1 } }),
  }
  const result = await mod.syncAlbum({ dshHome: home, client, fetchImpl: fakeFetch(PNG), log: () => {} })
  ok(result.ok === true, '同步返回 ok')
  ok(result.added === 2, '新增 2 张（song 跳过）得到 ' + result.added)
  ok(result.total === 2, '索引里 2 张')
  ok(requests.length === 4, '2 张原图 + 2 张缩略图 = 4 次（song 跳过）得到 ' + requests.length)
  ok(requests.every((r) => !Object.keys(r.headers).includes('authorization')), '文件下载不带授权头')
  const dir = mod.albumDir(home)
  ok(fs.existsSync(path.join(dir, ID1 + '.png')), '原图落盘 ' + ID1 + '.png')
  const list = mod.listAlbum(home, { limit: 5 })
  ok(list.total === 2, 'listAlbum 2 张')
  ok(list.items.every((i) => path.isAbsolute(i.path) && fs.existsSync(i.path)), 'listAlbum 给的是存在的绝对路径')
  ok(list.items[0].created === '2026-11-21T10:00:00Z', 'listAlbum 按 created 从新到旧')
  const entries = mod.albumEntries(home)
  ok(entries.length === 2 && entries[0].file === ID2 + '.png', 'albumEntries 给面板的文件名')
}

// ---- 超大 → 只留缩略图 ----
{
  const home = tmpHome()
  const big = Buffer.concat([PNG, Buffer.alloc(mod.ALBUM_MAX_FILE_BYTES + 10, 1)])
  const small = PNG
  const client = { baseUrl: base, read: async () => ({ available: true, data: { items: [{ item_id: ID1, kind: 'photo', created: '2026-11-22T01:00:00Z' }] } }) }
  let calls = 0
  const fetchImpl = async (url, init = {}) => {
    calls += 1
    const isThumb = url.endsWith('/thumb')
    const body = isThumb ? small : big
    return { ok: true, status: 200, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => body }
  }
  const result = await mod.syncAlbum({ dshHome: home, client, fetchImpl, log: () => {} })
  ok(result.ok === true, '超大图同步仍 ok')
  ok(calls === 2, '原图太大后补抓一次缩略图（共 2 次）得到 ' + calls)
  const dir = mod.albumDir(home)
  ok(fs.existsSync(path.join(dir, ID1 + '.thumb.png')), '留的是缩略图')
  ok(!fs.existsSync(path.join(dir, ID1 + '.png')), '没留下超大原图')
  const list = mod.listAlbum(home, { limit: 3 })
  ok(list.items[0].thumbOnly === true, '标了 thumbOnly（别拿去发空间）')
}

// ---- 双限淘汰 ----
{
  const home = tmpHome()
  const items = [1, 2, 3].map((n) => ({ item_id: 'al_' + String(n).repeat(16), kind: 'photo', created: '2026-11-2' + n + 'T10:00:00Z' }))
  const client = { baseUrl: base, read: async () => ({ available: true, data: { items } }) }
  const result = await mod.syncAlbum({ dshHome: home, client, fetchImpl: fakeFetch(PNG), log: () => {}, keep: 2 })
  ok(result.ok === true, '淘汰场景 ok')
  ok(result.total === 2, 'keep=2 只留 2 张得到 ' + result.total)
  ok(result.pruned === 1, '淘汰 1 张得到 ' + result.pruned)
  const dir = mod.albumDir(home)
  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.png') && !n.includes('.thumb.'))
  ok(left.length === 2, '磁盘上剩 2 个原图得到 ' + left.length)
  const thumbs = fs.readdirSync(dir).filter((n) => n.includes('.thumb.'))
  ok(thumbs.length === 2, '淘汰时缩略图一起删（剩 2 个）得到 ' + thumbs.length)
  ok(left.includes('al_' + '3'.repeat(16) + '.png'), '留的是最新的')
}

// ---- 坏响应 / 索引坏掉 ----
{
  const home = tmpHome()
  const client = { baseUrl: base, read: async () => ({ available: true, data: { items: [{ item_id: ID1, kind: 'photo', created: '2026-11-22T00:00:00Z' }] } }) }
  const htmlFetch = async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/html']]), arrayBuffer: async () => Buffer.from('<html>nope</html>') })
  const result = await mod.syncAlbum({ dshHome: home, client, fetchImpl: htmlFetch, log: () => {} })
  ok(result.ok === true && result.added === 0, 'HTML 冒充图片 → 0 张，不抛')
  const dir = mod.albumDir(home)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, mod.ALBUM_INDEX), '{坏掉的 json')
  ok(mod.readAlbumIndex(dir).items && Object.keys(mod.readAlbumIndex(dir).items).length === 0, '索引坏了当空的')
}

// ---- 拉列表失败 ----
{
  const home = tmpHome()
  const client = { baseUrl: base, read: async () => { const e = new Error('连不上小镇'); e.code = 'network'; throw e } }
  const result = await mod.syncAlbum({ dshHome: home, client, fetchImpl: fakeFetch(PNG), log: () => {} })
  ok(result.ok === false && result.code === 'network', '列表失败返回 ok:false 而不是抛')
}

console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
