// image-meta.mjs —— 不看扩展名，按字节读出图片的真实格式、宽高和哈希。
//
// 为什么要有这层：网图的 URL 经常是 .jpg?xxx，实际却是 WebP；Bing 缩略图
// 更小但地址看起来一样。排序必须按真实像素，不然会优先挑到 200×150 的缩略图。
import crypto from 'node:crypto'
import fs from 'node:fs'

export function sniffKind(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.slice(0, 3).toString() === 'GIF') return 'gif'
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp'
  if (buf.slice(4, 8).toString() === 'ftyp') return 'avif'
  return ''
}

export function readSize(buf, kind = sniffKind(buf)) {
  try {
    if (kind === 'png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (kind === 'gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (kind === 'jpg') {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue }
        const marker = buf[i + 1]
        if (marker === 0xd8 || marker === 0xd9) { i += 2; continue }
        const len = buf.readUInt16BE(i + 2)
        if (len < 2) break
        // SOF0/1/2/3/5/6/7/9/10/11/13/14/15 里带宽高
        if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
    if (kind === 'webp' && buf.length >= 30) {
      const chunk = buf.slice(12, 16).toString()
      if (chunk === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      }
      if (chunk === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
      }
      if (chunk === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      }
    }
  } catch { /* 坏图按未知尺寸处理 */ }
  return { width: 0, height: 0 }
}

export function inspectImageBuffer(buf, kindHint = '') {
  const kind = sniffKind(buf) || String(kindHint || '').toLowerCase()
  const { width, height } = readSize(buf, kind)
  return {
    kind,
    width,
    height,
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex')
  }
}

export function inspectImageFile(file) {
  const buf = fs.readFileSync(file)
  const info = inspectImageBuffer(buf)
  return { ...info, file, ok: Boolean(info.kind && info.width && info.height) }
}

export function aspectRatio(width, height) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  if (!w || !h) return 0
  return Math.round((w / h) * 1000) / 1000
}
