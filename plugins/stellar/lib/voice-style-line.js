/**
 * 「说话方式（鱼八股）」给 B站 / QQ空间 侧提示词用的一段（2026-11-22，主人 m03296）。
 *
 * 为什么在插件里再包一层，而不是 scheduler 直接调 src/voice-style.js：
 *   · 路径解析（DSH_HOME/stellar/state）与「关掉时不要注入」这条策略只写一次；
 *   · 渲染仍归 src/voice-style.js —— 桥接（QQ）与这里（B站/空间）读的是**同一份**词表，
 *     面板里改一条，两边下一轮都变（按 mtimeMs:size 缓存，不用重启，PITFALLS #305）。
 *
 * 注入点：scheduler.js 的 identityContextLines() —— 20 处 B站唤醒（含 QQ空间那一串）共用的前置，
 *   加在那里等于全吃上；每次唤醒多 ~300 token，只在她醒着看 B站 时才付。
 *
 * 失败必须可见但绝不能拦住唤醒：渲染出错 → 返回 ''（这一轮不要这段），同一句错只喊一次。
 */
import path from 'node:path'
import os from 'node:os'
import { VOICE_FILE_NAME, voiceStylePrompt } from '../../../src/voice-style.js'

let warned = ''

/** 测试用：清掉「只喊一次」的记录。 */
export function resetVoiceStyleLineWarn() {
  warned = ''
}

/** 与桥接同一个目录：<DSH_HOME>/stellar/state。 */
export function voiceStateDir(env = process.env) {
  const home = (env && env.DSH_HOME) || path.join((env && env.USERPROFILE) || os.homedir(), '.dsh')
  return path.join(home, 'stellar', 'state')
}

export function voiceStyleFileIn(dir) {
  return path.join(String(dir || voiceStateDir()), VOICE_FILE_NAME)
}

/**
 * 这一轮要拼进唤醒提示的那段「说话方式」。没有（或主人关掉）时返回 ''。
 * options.file 优先；否则 options.dir + voice-style.json；再退到 DSH_HOME 下的正式位置。
 */
export function voiceStyleBlockForBili(options = {}) {
  const explicit = String((options && options.file) || '')
  const file = explicit || voiceStyleFileIn((options && options.dir) || voiceStateDir())
  try {
    const r = voiceStylePrompt({ file })
    // enabled:false → B站 这边当作从来没有过这段（别拿 QQ 的兜底句顶上去，那是另一处的行为）。
    if (!r || r.source === 'fallback') return ''
    return String(r.text || '').trim()
  } catch (error) {
    const message = String((error && error.message) || error)
    if (warned !== message) {
      warned = message
      console.error('[voice-style] B站 提示词注入失败（本轮跳过这段）：' + message)
    }
    return ''
  }
}
