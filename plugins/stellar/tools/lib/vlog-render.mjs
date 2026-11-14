// 把一份脚本渲染成视频：幻灯片（SVG → PNG）+ 旁白音轨（vlog-audio）+ ffmpeg 合流。
//
// 为什么用 SVG 而不是 headless 浏览器：
//   · resvg 直接吃系统字体（实测 Microsoft YaHei 中文正常），一次渲染几十毫秒、结果确定；
//   · 不依赖 Edge/Chrome 是否存在、也不用等页面加载，B站会话里跑更稳。
//
// 为什么先出分段再 concat：
//   · 每段参数完全一致（1920x1080 / 30fps / yuv420p），concat 不会因为时间基不同而错帧；
//   · 某一段失败时只要重渲那一段，不用整片重来。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { writeVlogAudio } from './vlog-audio.mjs'

export const W = 1920
export const H = 1080
export const FPS = 30
export const MIN_SECONDS = 60
export const MAX_SECONDS = 600
export const MAX_SCENES = 40
const C = { page: '#0b0e13', surface: '#11161f', ink: '#e8edf4', dust: '#8a94a6', mint: '#58e0a8', blue: '#6aa9ff', border: '#222b3a' }

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 中文按 1 个字宽、英文数字按 0.55 估算，够排版用 */
function widthOf(text) {
  let n = 0
  for (const ch of Array.from(String(text ?? ''))) n += /[\u3400-\u9fff]/.test(ch) ? 1 : 0.55
  return n
}

/** 按最大字宽折行（不切断英文单词尽量） */
export function wrapText(text, maxUnits) {
  const out = []
  let line = ''
  for (const ch of Array.from(String(text ?? ''))) {
    if (ch === '\n') { out.push(line); line = ''; continue }
    if (widthOf(line + ch) > maxUnits && line) { out.push(line); line = ch } else line += ch
  }
  if (line) out.push(line)
  // 中文排版：行首不留句读（「。」「，」出现在行首很难看），把它吊回上一行末尾
  const LEAD = '。，、；：？！…）》」』”’·'
  for (let i = 1; i < out.length; i++) {
    while (out[i] && LEAD.includes(out[i][0])) {
      out[i - 1] += out[i][0]
      out[i] = out[i].slice(1)
    }
  }
  return out.filter((l, i) => l !== '' || i === 0)
}

function baseSvg(inner, { index = 0, total = 0, date = '' } = {}) {
  const grid = []
  for (let x = 120; x < W; x += 80) grid.push('  <path d="M' + x + ' 0V' + H + '"/>')
  for (let y = 160; y < H; y += 80) grid.push('  <path d="M0 ' + y + 'H' + W + '"/>')
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
    '  <rect width="' + W + '" height="' + H + '" fill="' + C.page + '"/>',
    '  <g stroke="' + C.border + '" stroke-width="1" opacity="0.55">',
    grid.join('\n'),
    '  </g>',
    '  <rect x="96" y="88" width="' + (W - 192) + '" height="' + (H - 176) + '" fill="none" stroke="' + C.border + '" stroke-width="2"/>',
    '  <rect x="96" y="84" width="120" height="4" fill="' + C.mint + '"/>',
    inner,
    '  <text x="112" y="62" font-family="Consolas" font-size="22" fill="' + C.dust + '" letter-spacing="3">STELLAR / VLOG</text>',
    '  <text x="' + (W - 112) + '" y="62" text-anchor="end" font-family="Consolas" font-size="22" fill="' + C.dust + '" letter-spacing="2">' + esc(date) + ' · ' + String(index + 1).padStart(2, '0') + '/' + String(total).padStart(2, '0') + '</text>',
    '</svg>',
  ].join('\n')
}

function textBlock(lines, { x, y, size, fill = C.ink, weight = 400, family = 'Microsoft YaHei', lh = 1.35, anchor = 'start' }) {
  return lines.map((line, i) => '  <text x="' + x + '" y="' + (y + i * size * lh) + '" font-family="' + family + '" font-size="' + size + '" font-weight="' + weight + '" fill="' + fill + '" text-anchor="' + anchor + '" xml:space="preserve">' + esc(line) + '</text>').join('\n')
}

/** 一个场景 → SVG 文本 */
export function sceneSvg(scene, meta = {}) {
  const kind = String(scene.kind || 'note')
  const title = String(scene.title || '')
  const body = String(scene.text || '')
  const source = String(scene.source || '')
  let inner = ''
  if (kind === 'title') {
    inner = textBlock(wrapText(title || body, 11), { x: 200, y: 420, size: 118, weight: 700, lh: 1.18 })
      + textBlock(wrapText(scene.sub || '', 26), { x: 204, y: 760, size: 40, fill: C.dust })
      + '  <rect x="200" y="820" width="180" height="6" fill="' + C.mint + '"/>'
  } else if (kind === 'quote') {
    inner = textBlock(wrapText(body || title, 14), { x: W / 2, y: 470, size: 86, weight: 700, lh: 1.34, anchor: 'middle' })
      + textBlock(wrapText(scene.sub || '', 30), { x: W / 2, y: 800, size: 36, fill: C.dust, anchor: 'middle' })
  } else if (kind === 'list') {
    const items = (Array.isArray(scene.items) ? scene.items : body.split('\n')).filter(Boolean).slice(0, 6)
    inner = textBlock(wrapText(title, 16), { x: 200, y: 300, size: 76, weight: 700 })
    items.forEach((it, i) => {
      const y = 430 + i * 96
      inner += '  <circle cx="212" cy="' + (y - 16) + '" r="8" fill="' + (i % 2 ? C.blue : C.mint) + '"/>\n'
      inner += textBlock(wrapText(it, 26), { x: 248, y, size: 42, fill: C.ink })
    })
  } else if (kind === 'outro') {
    inner = textBlock(wrapText(title || '明天见', 12), { x: W / 2, y: 500, size: 96, weight: 700, anchor: 'middle' })
      + textBlock(wrapText(body || '', 30), { x: W / 2, y: 640, size: 42, fill: C.dust, anchor: 'middle' })
  } else {
    const lines = wrapText(body || title, 22).slice(0, 6)
    inner = textBlock(wrapText(title, 16).slice(0, 2), { x: 200, y: 320, size: 68, weight: 700, fill: C.ink })
      + textBlock(lines, { x: 200, y: 470, size: 52, lh: 1.5 })
      + '  <rect x="200" y="' + (470 + lines.length * 52 * 1.5 - 8) + '" width="96" height="5" fill="' + (kind === 'fact' ? C.blue : C.mint) + '"/>'
  }
  if (source) {
    inner += textBlock(wrapText('来源 · ' + source, 40), { x: 200, y: H - 190, size: 26, fill: C.dust })
  }
  return baseSvg(inner, meta)
}

/** 封面：标题 + 日期 + 一条薄荷色强调条（B站封面建议 16:9，1146x717 也够） */
export function coverSvg(title, sub = '') {
  const lines = wrapText(title, 12).slice(0, 3)
  const inner = textBlock(lines, { x: 120, y: 300, size: 110, weight: 700, lh: 1.22 })
    + textBlock(wrapText(sub, 26).slice(0, 2), { x: 124, y: 760, size: 40, fill: C.dust })
    + '  <rect x="120" y="820" width="220" height="8" fill="' + C.mint + '"/>'
    + '  <text x="120" y="900" font-family="Consolas" font-size="30" fill="' + C.mint + '" letter-spacing="4">STELLAR</text>'
  return baseSvg(inner, { index: 0, total: 1, date: new Date().toLocaleDateString('sv-SE') })
}

async function loadResvg() {
  const candidates = [
    path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@resvg', 'resvg-js', 'index.js'),
    path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@resvg', 'resvg-js', 'index.js'),
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const mod = await import('file:///' + file.replace(/\\/g, '/'))
    if (mod?.Resvg) return mod.Resvg
  }
  throw new Error('找不到 @resvg/resvg-js（应随 dsh-drawai 或 univer 插件装在 profile 里）')
}

export async function svgToPng(Resvg, svg, file, width = W) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' } })
  const png = r.render().asPng()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, png)
  return file
}

function ffmpegPath() {
  const home = process.env.USERPROFILE || os.homedir()
  const candidates = [
    path.join(home, '.dsh', 'stellar', 'bili', 'bin', 'ffmpeg.exe'),
    path.join(home, '.dsh', 'drawai-ffmpeg', 'win32-x64', 'ffmpeg.exe'),
  ]
  for (const f of candidates) if (fs.existsSync(f)) return f
  return 'ffmpeg'
}

function runFf(args, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(stderr ?? '').slice(-2000) })
    })
  })
}

/**
 * 渲染整片。
 * @param {{scenes:Array, title?:string, audioLines?:Array<{text:string}>, workDir:string, stillSeconds?:number}} opts
 */
export async function renderVlog(opts) {
  const { scenes, title = '', workDir, stillSeconds } = opts
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('脚本里没有 scenes')
  if (scenes.length > MAX_SCENES) throw new Error('场景太多（最多 ' + MAX_SCENES + ' 个）')
  const Resvg = await loadResvg()
  const frames = path.join(workDir, 'frames')
  const segments = path.join(workDir, 'seg')
  fs.mkdirSync(frames, { recursive: true })
  fs.mkdirSync(segments, { recursive: true })
  const date = new Date().toLocaleDateString('sv-SE')

  // 1) 音频先出：时长决定了每个场景该持续多久
  const audioFile = path.join(workDir, 'voice.wav')
  const audio = writeVlogAudio(opts.audioLines || scenes.map((s) => ({ text: s.text || s.title || '' })), audioFile, { gapSec: stillSeconds ? 0.7 : 0.55 })
  const per = audio.timeline

  // 2) 每场景：SVG → PNG → 静音分段（时长与该场景朗读时间对齐，末尾留 0.4s 呼吸）
  const segFiles = []
  for (let i = 0; i < scenes.length; i++) {
    const svg = sceneSvg(scenes[i], { index: i, total: scenes.length, date })
    const png = await svgToPng(Resvg, svg, path.join(frames, 'frame-' + String(i).padStart(3, '0') + '.png'))
    const talk = per[i] ? per[i].end - per[i].start : 4
    const dur = Math.max(2.2, stillSeconds ? stillSeconds : talk + 0.45)
    const seg = path.join(segments, 'seg-' + String(i).padStart(3, '0') + '.mp4')
    const r = await runFf(['-y', '-loop', '1', '-framerate', String(FPS), '-t', dur.toFixed(2), '-i', png,
      '-vf', 'scale=' + W + ':' + H + ',format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-r', String(FPS), seg])
    if (!r.ok) throw new Error('第 ' + (i + 1) + ' 段渲染失败：' + r.err.slice(-300))
    segFiles.push(seg)
  }

  // 3) concat + 混音
  const listFile = path.join(segments, 'list.txt')
  fs.writeFileSync(listFile, segFiles.map((f) => "file '" + f.replace(/\\/g, '/') + "'").join('\n') + '\n')
  const outFile = path.join(workDir, 'vlog.mp4')
  const mux = await runFf(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-i', audioFile,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', outFile], 600_000)
  if (!mux.ok) throw new Error('合流失败：' + mux.err.slice(-400))

  // 4) 封面
  const coverPng = await svgToPng(Resvg, coverSvg(title || String(scenes[0]?.title || ''), date + ' · 我看完今天这些视频之后'), path.join(workDir, 'cover.png'))
  const coverJpg = path.join(workDir, 'cover.jpg')
  const coverRun = await runFf(['-y', '-i', coverPng, '-vf', 'scale=1146:717', '-q:v', '2', coverJpg], 60_000)

  const stat = fs.statSync(outFile)
  return {
    file: outFile, bytes: stat.size, seconds: audio.seconds,
    cover: coverRun.ok ? coverJpg : coverPng, audio: audioFile,
    frames: scenes.length, segments: segFiles, timeline: audio.timeline,
  }
}
