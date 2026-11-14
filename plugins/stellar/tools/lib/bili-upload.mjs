// B站 web 端投稿（preupload → upos 分片 → add/v3）。
//
// 为什么走这套老接口：
//   · 没有开放平台的 appkey/secret，只能用网页端同一套接口（浏览器登录态 cookie 就够）；
//   · 全流程只依赖 cookie（SESSDATA / bili_jct）与普通 https，不需要 puppeteer 之类重依赖。
//
// 安全：
//   · 默认 **只上传不发布**（stopBeforeAdd），真正 add/v3 必须显式传 dry=false；
//   · 控制台点「通过并发布」才会走到 add；失败时视频与元数据留在队列里，可去创作中心手动投。
//
// 已知限制：upos 分片大小以 preupload 返回的 chunk_size 为准；超时 10 分钟。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { accountBili } from './state-paths.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://member.bilibili.com/platform/upload/video/frame'
export const CREATIVE_URL = 'https://member.bilibili.com/platform/upload/video/frame'

export function readCredentials() {
  const file = accountBili('credentials.json')
  let raw = {}
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { raw = {} }
  const sessdata = String(raw.sessdata || raw.SESSDATA || '').trim()
  const csrf = String(raw.bili_jct || raw.biliJct || raw.csrf || '').trim()
  return { file, sessdata, csrf, mid: String(raw.mid || ''), name: String(raw.name || ''), ok: Boolean(sessdata && csrf) }
}

function cookieHeader(cred) {
  const parts = ['SESSDATA=' + cred.sessdata]
  if (cred.csrf) parts.push('bili_jct=' + cred.csrf)
  return parts.join('; ')
}

async function jfetch(url, init = {}) {
  const res = await fetch(url, init)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text: text.slice(0, 400) }
}

/** 1) 预上传：拿 endpoint / upos_uri / auth / biz_id / chunk_size */
export async function preupload(cred, { file, filename }) {
  const size = fs.statSync(file).size
  const qs = new URLSearchParams({
    name: filename, size: String(size), r: 'upos', profile: 'ugcfx/bup', ssl: '0', version: '2.14.0', build: '2140000',
  })
  const r = await jfetch('https://member.bilibili.com/preupload?' + qs.toString(), {
    headers: { 'user-agent': UA, referer: REFERER, cookie: cookieHeader(cred) },
  })
  if (!r.json || Number(r.json.OK) !== 1) {
    const why = r.json ? ('preupload 返回 ' + JSON.stringify(r.json).slice(0, 200)) : ('HTTP ' + r.status + ' ' + r.text)
    throw new Error('预上传失败：' + why + '（cookie 可能过期，去浏览器重新登录一次 B站）')
  }
  return { ...r.json, size, filename }
}

/** 2) 分片上传，返回 parts[{partNumber, etag}] */
export async function uploadParts(cred, pre, file, { onProgress } = {}) {
  const buf = fs.readFileSync(file)
  const chunkSize = Math.max(1024 * 1024, Number(pre.chunk_size) || 8 * 1024 * 1024)
  const uploadPath = String(pre.upos_uri).replace(/^upos:\/\//, '')
  // endpoint 可能带 "//upos-xxx.bilivideo.com" 这种前缀，拼 URL 前要剥干净（否则 https:////… 会 403）
  const host = String(pre.endpoint || '').replace(/^https?:/i, '').replace(/^\/+/, '').replace(/\/+$/, '')
  const baseUrl = 'https://' + host + '/' + uploadPath
  const auth = String(pre.auth || '')

  const init = await jfetch(baseUrl + '?uploads&output=json', {
    method: 'POST', headers: { 'user-agent': UA, referer: REFERER, 'x-upos-auth': auth, cookie: cookieHeader(cred) },
  })
  if (!init.json || !init.json.upload_id) throw new Error('开始上传失败：' + (init.json ? JSON.stringify(init.json).slice(0, 200) : init.status))
  const uploadId = String(init.json.upload_id)

  const parts = []
  const total = Math.ceil(buf.length / chunkSize)
  for (let i = 0; i < total; i++) {
    const start = i * chunkSize
    const chunk = buf.subarray(start, Math.min(buf.length, start + chunkSize))
    const partNumber = i + 1
    const url = baseUrl + '?partNumber=' + partNumber + '&uploadId=' + encodeURIComponent(uploadId) + '&chunk=' + partNumber + '&chunks=' + total + '&size=' + chunk.length + '&start=' + start + '&end=' + (start + chunk.length) + '&total=' + buf.length
    const put = await fetch(url, { method: 'PUT', headers: { 'user-agent': UA, referer: REFERER, 'x-upos-auth': auth, 'content-type': 'application/octet-stream' }, body: chunk })
    if (!put.ok) throw new Error('第 ' + partNumber + '/' + total + ' 片上传失败：HTTP ' + put.status)
    const bodyText = await put.text()
    let etag = ''
    try { etag = String(JSON.parse(bodyText)?.etag || '') } catch {}
    if (!etag) etag = crypto.createHash('md5').update(chunk).digest('hex')
    parts.push({ partNumber, etag })
    onProgress?.(partNumber, total)
  }
  return { parts, uploadId, baseUrl, auth }
}

/** 3) 声明分片完成 */
export async function finishUpload(cred, pre, up) {
  const url = up.baseUrl + '?output=json&name=' + encodeURIComponent(pre.filename) + '&profile=ugcfx%2Fbup&uploadId=' + encodeURIComponent(up.uploadId) + '&biz_id=' + encodeURIComponent(String(pre.biz_id))
  const r = await jfetch(url, {
    method: 'POST',
    headers: { 'user-agent': UA, referer: REFERER, 'x-upos-auth': up.auth, cookie: cookieHeader(cred), 'content-type': 'application/json' },
    body: JSON.stringify({ parts: up.parts, output: 'json', profile: 'ugcfx/bup' }),
  })
  if (!r.json || (r.json.OK !== 1 && Number(r.json.OK) !== 1)) throw new Error('合并分片失败：' + (r.json ? JSON.stringify(r.json).slice(0, 200) : r.status))
  return r.json
}

/** 4) 封面上传：multipart，返回可用的图片 url */
export async function uploadCover(cred, coverFile) {
  const form = new FormData()
  const buf = fs.readFileSync(coverFile)
  form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'cover.jpg')
  form.append('cover', '')
  const r = await jfetch('https://api.bilibili.com/x/vu/web/cover/up?csrf=' + encodeURIComponent(cred.csrf), {
    method: 'POST', headers: { 'user-agent': UA, referer: REFERER, cookie: cookieHeader(cred) }, body: form,
  })
  if (!r.json || Number(r.json.code) !== 0) {
    throw new Error('封面上传失败：' + (r.json ? (r.json.code + ' ' + (r.json.message || '')) : r.status))
  }
  return String(r.json.data?.url || '')
}

/** 5) 正式投稿 */
export async function submitVideo(cred, { title, desc, tags, tid, coverUrl, filename }) {
  const payload = {
    cover: coverUrl,
    title: String(title).slice(0, 80),
    copyright: 1,
    tid: Number(tid) || 21,
    tag: (Array.isArray(tags) ? tags : String(tags || '').split(',')).filter(Boolean).slice(0, 10).join(','),
    desc: String(desc || '').slice(0, 2000),
    desc_format_id: 9999,
    source: '',
    re_create: 0,
    videos: [{ filename, title: String(title).slice(0, 80), desc: '' }],
    dynamic: '',
    interactive: 0,
    no_reprint: 1,
    act_reserve_create: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    original: 1,
    aid: 0,
  }
  const r = await jfetch('https://member.bilibili.com/x/vu/web/add/v3?csrf=' + encodeURIComponent(cred.csrf) + '&t=' + Date.now(), {
    method: 'POST',
    headers: { 'user-agent': UA, referer: REFERER, cookie: cookieHeader(cred), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!r.json || Number(r.json.code) !== 0) {
    const msg = r.json ? ('code=' + r.json.code + ' ' + (r.json.message || '')) : ('HTTP ' + r.status)
    throw new Error('投稿被拒：' + msg + '（去创作中心手动投：' + CREATIVE_URL + '）')
  }
  return { aid: r.json.data?.aid, bvid: r.json.data?.bvid }
}

/**
 * 一站式：预上传 → 分片 → 合并 →（可选封面）→（dry 时停）→ 投稿。
 * @param {{file:string, cover?:string, title:string, desc?:string, tags?:string[]|string, tid?:number, dry?:boolean, onLog?:Function}} opts
 */
export async function publishVlog(opts) {
  const logs = []
  const logLine = (m) => { logs.push(m); opts.onLog?.(m) }
  const cred = readCredentials()
  if (!cred.ok) throw new Error('没有 B站 cookie（' + cred.file + ' 缺 sessdata / bili_jct）')
  const file = opts.file
  if (!fs.existsSync(file)) throw new Error('找不到视频文件：' + file)
  const base = path.basename(file).replace(/[^\w.-]/g, '_')
  const filename = /\.mp4$/i.test(base) ? base : base + '.mp4'

  await waitForUploadSlot(logLine)
  logLine('预上传 ' + filename + '（' + (fs.statSync(file).size / 1048576).toFixed(1) + 'MB）')
  const pre = await preupload(cred, { file, filename })
  const up = await uploadParts(cred, pre, file, {
    onProgress: (i, n) => { if (i === n || i % 5 === 0) logLine('分片 ' + i + '/' + n) },
  })
  await finishUpload(cred, pre, up)
  logLine('视频已上传，等待投稿')
  let coverUrl = ''
  if (opts.cover && fs.existsSync(opts.cover)) {
    try { coverUrl = await uploadCover(cred, opts.cover); logLine('封面已上传') } catch (e) { logLine('封面失败（不影响投稿）：' + e.message) }
  }
  const videoName = path.basename(String(pre.upos_uri).replace(/^upos:\/\//, ''))
  if (opts.dry) {
    logLine('dry-run：已上传但不投稿（可去创作中心手动投）')
    return { ok: true, dry: true, filename: videoName, coverUrl, logs, creative: CREATIVE_URL }
  }
  const res = await submitVideo(cred, { title: opts.title, desc: opts.desc, tags: opts.tags, tid: opts.tid, coverUrl, filename: videoName })
  logLine('投稿成功：BV' + res.bvid)
  return { ok: true, dry: false, ...res, filename: videoName, coverUrl, logs }
}

// 同时只允许一个上传（避免多进程抢分片），排队最多 15 分钟
let uploadChain = Promise.resolve()
function waitForUploadSlot(logLine) {
  const prev = uploadChain
  let release
  uploadChain = new Promise((r) => { release = r })
  return prev.then(() => { logLine('拿到上传锁'); setTimeout(release, 0) }).catch(() => { logLine('拿到上传锁') })
}
