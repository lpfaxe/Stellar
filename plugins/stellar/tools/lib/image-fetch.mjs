// image-fetch.mjs —— 把图片 URL 抓到本地临时目录，给模型看图用。
//
// 为什么要单独一个：B站评论区的图、QQ空间评论区的图都是 CDN 直链，且
//   · 有些只认 UA/Referer；
//   · 有些回 AVIF/HEIC（模型解不了）→ 必须 sniff 字节再决定要不要 ffmpeg 转 JPEG；
//   · 单张可能十几 MB。
// 这套逻辑原本只写在 qzone.mjs 里，评论区要图就复制了一份 —— 现在抽出来共用。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ffmpegPath } from './ffmpeg.mjs'

// os.tmpdir() 在「环境变量被剥掉」的宿主里会返回相对路径 'undefined\\temp'（Windows 上它直接读
// TEMP/TMP 拼出来的），那样图片会落进 cwd/undefined/temp —— 所以这里兜一层：拿不到像样的绝对
// 临时目录就退回 TEMP/TMP/系统临时目录。生产里 MCP 是正常 node 进程，走不到这个兜底。
function tmpRoot() {
  let t = ''
  try { t = os.tmpdir() } catch {}
  if (t && path.isAbsolute(t) && !/^undefined[\\/]/i.test(t)) return t
  const env = process.env.TEMP || process.env.TMP || process.env.TMPDIR || ''
  if (env && path.isAbsolute(env)) return env
  return 'C:\\Windows\\Temp'
}

export const MEDIA_ROOT = path.join(tmpRoot(), 'stellar-media')
const MAX_BYTES = 15 * 1024 * 1024

let warnedNoFfmpeg = false

export function pickExt(ct, url) {
  const t = String(ct || '').toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  const m = String(url || '').match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

export function sniffImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif'
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp'
  if (buf.slice(4, 8).toString() === 'ftyp') {
    const brand = buf.slice(8, 12).toString()
    if (['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1', 'hevc', 'hevx'].includes(brand)) return 'avif'
  }
  return ''
}

function convertToJpeg(file) {
  const ff = ffmpegPath()
  if (!ff) {
    if (!warnedNoFfmpeg) {
      warnedNoFfmpeg = true
      console.error('[media] 图片是 AVIF/HEIC 格式，需要 ffmpeg 转成 JPEG；本机没找到 ffmpeg，这次跳过')
    }
    return null
  }
  const out = file.replace(/\.[A-Za-z0-9]+$/, '') + '-conv.jpg'
  const r = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, out], { windowsHide: true })
  if (r.status !== 0 || !fs.existsSync(out)) return null
  try { fs.unlinkSync(file) } catch { /* 原图删不掉也无所谓 */ }
  return out
}

/**
 * 抓一张图到临时目录。
 * @returns {Promise<{file: string, bytes: number, url: string}|null>}
 */
export async function grabImage(url, tag, idx, referer = 'https://www.bilibili.com/') {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: referer } })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return null
    const kind = sniffImage(buf) || pickExt(res.headers.get('content-type'), url)
    const safe = String(tag || 'img').replace(/[^0-9A-Za-z_-]/g, '')
    fs.mkdirSync(MEDIA_ROOT, { recursive: true })
    const raw = path.join(MEDIA_ROOT, safe + '-' + idx + '-' + Date.now() + '.' + kind)
    fs.writeFileSync(raw, buf)
    const file = kind === 'avif' ? convertToJpeg(raw) : raw
    if (!file) return null
    return { file, bytes: fs.statSync(file).size, url }
  } catch {
    return null
  }
}

/** 从 B站评论对象里取图片直链（content.pictures[].img_src）。 */
export function biliCommentImageUrls(comment) {
  const out = []
  for (const p of Array.isArray(comment?.content?.pictures) ? comment.content.pictures : []) {
    const u = String(p?.img_src ?? '').trim()
    if (u) out.push(u.replace(/^http:\/\//i, 'https://'))
  }
  // 老接口也有把图塞在 content.message 里的 HTML（<img src>）
  for (const m of String(comment?.content?.message ?? '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    if (m[1]) out.push(m[1])
  }
  return [...new Set(out)]
}
