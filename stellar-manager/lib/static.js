/* 静态文件：public 目录 + PWA manifest（只允许 public 内，防目录穿越） */
import fs from 'node:fs'
import path from 'node:path'
import { PANEL_ROOT } from './paths.js'

const PUBLIC_DIR = path.join(PANEL_ROOT, 'public')

export const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' }

export const MANIFEST = {
  name: 'Stellar 控制台',
  short_name: 'Stellar',
  description: 'Stellar · 人格化 AI 的 QQ / B站 / QQ空间 · 常驻守护控制台',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0c10',
  theme_color: '#0b0c10',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
}

/** 返回 true 表示已经把这个请求处理掉了。 */
export function servePublic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''))
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, message: 'forbidden' }))
    return true
  }
  let st = null
  try { st = fs.statSync(file) } catch { return false }
  if (!st.isFile()) return false
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
  return true
}
