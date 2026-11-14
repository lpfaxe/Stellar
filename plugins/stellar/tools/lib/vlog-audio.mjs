// B站 vlog 配音：把场景文本变成「带语气与停顿的滴滴声」旁白 + 一层低音量铺底。
//
// 为什么不用 TTS：
//   · 主人明确说「滴滴声就行，但要有语气与停顿」—— 机械音也能表达情绪，靠的是**音高、语速、停顿**；
//   · 本地合成零成本、离线、可重现（同一天同脚本出来的音频逐字节一致），也方便控制视频总时长。
//
// 设计要点：
//   · 每个字一个短促脉冲（正弦 + 轻微谐波 + 快速衰减），基频按句子的语气上下浮动；
//   · 标点决定停顿：逗号 ~180ms、句号/问号/感叹号 ~380ms、省略号 ~600ms、换行 ~300ms；
//   · 语气词/感叹句整体抬高音高，句中疑问句末字上扬（这就是「语气」）；
//   · 铺底和 vlog 开场片头共用一条低调的 drone，保证不抢旁白。
//
// 输出：单声道 48kHz 16bit WAV（外面混成视频时再与画面合流）。
import fs from 'node:fs'
import path from 'node:path'

export const SR = 48000

const PAUSE = { '，': 0.18, ',': 0.18, '、': 0.14, '；': 0.26, ';': 0.26, '：': 0.22, ':': 0.22, '。': 0.38, '.': 0.38, '？': 0.42, '?': 0.42, '！': 0.44, '!': 0.44, '…': 0.6, '—': 0.3, '\n': 0.3, ' ': 0.05 }
const TAIL = { '？': 1.18, '?': 1.18, '！': 1.1, '!': 1.1 }   // 句末上扬/加重

/** 极简确定性随机（同一脚本每次渲染一致，方便复现） */
function makeRng(seedText = '') {
  let s = 2166136261
  for (let i = 0; i < seedText.length; i++) { s ^= seedText.charCodeAt(i); s = Math.imul(s, 16777619) }
  s = (s >>> 0) || 12345
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}

const isCJK = (ch) => /[\u3400-\u9fff]/.test(ch)

/**
 * 把一句文本拆成「发声单元 + 间隔」。
 * 返回 [{ ch, pitch, len, pause }]，ch 为空表示纯停顿。
 */
export function phonemesOf(text, rng, { basePitch = 300, speed = 1 } = {}) {
  const out = []
  const chars = Array.from(String(text ?? ''))
  let pitch = basePitch
  let drift = 0
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (PAUSE[ch] != null) {
      const tail = TAIL[ch]
      out.push({ ch: '', pitch, len: 0, pause: (PAUSE[ch] / speed) * (tail ? 1.1 : 1) })
      pitch = basePitch * (1 + (rng() - 0.5) * 0.08)   // 每句重新起调
      drift = 0
      continue
    }
    if (!isCJK(ch) && !/[A-Za-z0-9]/.test(ch)) continue
    // 句子内部的漂移：一句话越长，音高越往下落（自然陈述句的语调衰减）
    drift += 0.012
    const jitter = (rng() - 0.5) * 0.05
    const pitchHere = pitch * (1 - drift) * (1 + jitter)
    out.push({ ch, pitch: pitchHere, len: (isCJK(ch) ? 0.115 : 0.085) / speed, pause: 0.018 })
  }
  return out
}

/** 文本朗读时长（秒），用于排字幕时间轴 */
export function speechSeconds(text, { speed = 1, extra = 0.25 } = {}) {
  const rng = makeRng(text)
  const list = phonemesOf(text, rng, { speed })
  return list.reduce((n, p) => n + p.len + p.pause, 0) + extra
}

function addTone(buf, startSec, durSec, freq, gain, { attack = 0.004, decay = 2.6 } = {}) {
  const start = Math.max(0, Math.floor(startSec * SR))
  const n = Math.max(1, Math.floor(durSec * SR))
  for (let i = 0; i < n; i++) {
    const idx = start + i
    if (idx >= buf.length) break
    const t = i / SR
    const env = Math.min(1, t / attack) * Math.exp(-t * decay)
    const w = Math.sin(2 * Math.PI * freq * t) + 0.22 * Math.sin(2 * Math.PI * freq * 2 * t)
    buf[idx] += gain * env * w
  }
}

/**
 * 完整音轨：旁白（滴滴声）+ 低音量铺底。
 * @param {Array<{text:string}>} lines 按场景顺序的旁白
 * @param {{gapSec?:number, bed?:boolean, speed?:number, basePitch?:number}} opts
 * @returns {{buffer:Buffer, seconds:number, timeline:Array<{index:number,start:number,end:number}>}}
 */
export function buildVlogAudio(lines, opts = {}) {
  const { gapSec = 0.55, bed = true, speed = 1, basePitch = 300 } = opts
  const rng = makeRng(lines.map((l) => l.text).join('|'))
  const plan = []
  let t = 0.35
  const timeline = []
  for (let i = 0; i < lines.length; i++) {
    const text = String(lines[i]?.text ?? '')
    const start = t
    for (const p of phonemesOf(text, rng, { basePitch, speed })) {
      if (p.ch) {
        const freq = Math.max(120, p.pitch)
        plan.push({ at: t, dur: Math.max(0.06, p.len), freq, gain: 0.5 })
        t += p.len + p.pause
      } else {
        t += p.pause * 1.15
      }
    }
    timeline.push({ index: i, start, end: t })
    t += gapSec
  }
  const seconds = Math.max(1, t + 0.9)
  const n = Math.ceil(seconds * SR)
  const buf = new Float32Array(n)
  // 铺底：很轻的两音 drone，压在人声下面
  if (bed) {
    for (const [f, g] of [[110, 0.035], [165, 0.022], [220, 0.012]]) {
      for (let i = 0; i < n; i++) {
        const s = i / SR
        const breathe = 0.7 + 0.3 * Math.sin((2 * Math.PI * s) / 14)
        buf[i] += g * breathe * Math.sin(2 * Math.PI * f * s)
      }
    }
  }
  for (const p of plan) addTone(buf, p.at, p.dur, p.freq, p.gain)
  // 收尾淡出，避免爆音
  const fade = Math.floor(0.4 * SR)
  for (let i = 0; i < fade && i < n; i++) buf[n - 1 - i] *= i / fade
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]))
  const norm = peak > 0 ? 0.82 / peak : 1
  return { buffer: pcm16Wav(buf, norm), seconds, timeline }
}

/** Float32 → 单声道 16bit WAV（可选末端增益） */
export function pcm16Wav(samples, gain = 1) {
  const n = samples.length
  const out = Buffer.alloc(44 + n * 2)
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVE', 8)
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36); out.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * gain))
    out.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return out
}

/** 把音频和字幕时间轴写到磁盘，供渲染脚本读取 */
export function writeVlogAudio(lines, file, opts = {}) {
  const built = buildVlogAudio(lines, opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, built.buffer)
  return { file, seconds: built.seconds, timeline: built.timeline, bytes: built.buffer.length }
}
