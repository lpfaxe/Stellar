// B站鲸鱼会话的工具面精简（2026-11-09）
//
// 与 qq-tool-restrict 的区别（别混用）：
//   · qq-tool-restrict 是**安全硬边界**：restrict 危险工具 + 执行期白名单 guard，
//     给 QQ 群聊用，宁可少能力也不能越权；
//   · 本文件只是**省钱**：不删任何插件/工具定义，仅在 bili-slim 这个 preset 的
//     composition 里把鲸鱼用不到的工具从 schema 隐藏；没有 guard，
//     她原有的 MCP / 文件 / 命令能力一个不少。
//
// 为什么按 preset 而不是全局：preset 决定「这条会话的工具面」。
//   QQ 会话用 qq-chat/qq-chat-v2（已精简到 50 个工具 / 42K 字符）；
//   鲸鱼会话默认是 DSH 的 standard preset（88 个工具 / 73.5K 字符 ≈ 24.5K token/步）。
//   bili-slim = standard 的行列表 + 本行，scheduler 创建鲸鱼会话时指定它。
//
// 开关（一键恢复全量）：stellar/config.json 的 tools.slimBili = false，
//   或者把 bili.agentPreset 改回空字符串（鲸鱼换回 standard preset）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const name = 'whale-tool-restrict'

export const inject = ['tools']

/** 与鲸鱼无关、每步都要重发一遍 schema 的工具（不是危险名单）。 */
export const SLIM_TOOL_NAMES = Object.freeze([
  // univer 文档/表格/幻灯片全家桶（dsh-univer-office，14 个）
  'univer_api', 'univer_compile_svg', 'univer_execute', 'univer_export', 'univer_import',
  'univer_inspect', 'univer_lint', 'univer_new', 'univer_print_pdf', 'univer_resources',
  'univer_screenshot', 'univer_status', 'univer_unit', 'univer_worktree',
  // 远程主机/远程会话（ds-harness-remote + dsh-remote-web-ui，11 个）
  // 这是「本机 DSH 去控制另一台机器的 Harness」，不是 DSH Go 手机端连本机的通道：
  // 手机端走的是 Web GUI 本身，隐藏这些工具不影响手机访问。
  'remote_create_session', 'remote_download_file', 'remote_get_operation', 'remote_interrupt_session',
  'remote_list_hosts', 'remote_list_sessions', 'remote_list_workspaces', 'remote_read_session',
  'remote_send_message', 'remote_upload_file', 'remote_wait_sessions',
  // 上下文管理里鲸鱼用不到的（compress/decompress 必须保留：长聊靠它自救）
  'acp_cache', 'acp_read_original_image', 'acp_status',
  // 联网只走 mcp__web-search-safe__*；宿主自带的两个对鲸鱼没意义
  'read_page', 'x_search',
  // 工作区切换（鲸鱼会话固定在自己的工作区）
  'working_directory',
  // 通用 MCP 资源读取（鲸鱼只用 snowluma 自己的工具）
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
])

/** 读 config.json：~/.dsh/stellar/config.json 优先，仓库内 config.json 兜底。 */
function readConfig() {
  const candidates = [
    path.join(os.homedir(), '.dsh', 'stellar', 'config.json'),
    path.resolve(__dirname, '..', '..', 'config.json'),
  ]
  for (const file of candidates) {
    try {
      let text = fs.readFileSync(file, 'utf8')
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') return parsed
    } catch {}
  }
  return {}
}

/** 默认开；显式 false 或字符串 'false'/'0'/'off' 视为关闭。 */
export function slimEnabled(cfg = readConfig()) {
  const value = cfg?.tools?.slimBili
  if (value === false) return false
  if (typeof value === 'string' && /^(false|0|off|no)$/i.test(value.trim())) return false
  return true
}

// restrict 只对「调用这一刻已经注册」的工具生效；remote_/acp_ 这类来自 profile bundle 的
// 工具注册得比 preset 行晚，一次性 restrict 会漏掉（2026-11-09 实测：14 个漏网）。
// 所以先隐藏已存在的，剩下的按 2s / 8s / 20s 重试；都失败就照实记日志，不再纠缠。
const RETRY_DELAYS_MS = [2000, 8000, 20000]

export function apply(ctx, options = {}) {
  const enabled = slimEnabled()
  if (!enabled) {
    console.log('[whale-tool-restrict] 已关闭（config.json tools.slimBili=false），鲸鱼保持全量工具面')
    return
  }
  const denied = new Set()
  const hidden = (toolName) => {
    try {
      ctx.tools.restrict({ deny: [toolName] })
      denied.add(toolName)
      return true
    } catch {
      return false
    }
  }
  let skipped = SLIM_TOOL_NAMES.filter((toolName) => !hidden(toolName))
  const detail = skipped.length ? `（稍后重试：${skipped.join(', ')}）` : ''
  console.log(`[whale-tool-restrict] 已从鲸鱼会话隐藏 ${denied.size}/${SLIM_TOOL_NAMES.length} 个工具${detail}`)

  if (skipped.length === 0) return
  RETRY_DELAYS_MS.forEach((delayMs, index) => {
    const timer = setTimeout(() => {
      skipped = skipped.filter((toolName) => !hidden(toolName))
      const isLast = index === RETRY_DELAYS_MS.length - 1
      if (skipped.length === 0) {
        console.log(`[whale-tool-restrict] 延迟注册的工具已补隐藏，合计 ${denied.size}/${SLIM_TOOL_NAMES.length}`)
      } else if (isLast) {
        console.log(`[whale-tool-restrict] 仍有 ${skipped.length} 个工具隐藏失败（保持可见）：${skipped.join(', ')}`)
      }
    }, delayMs)
    timer?.unref?.()
  })
}
