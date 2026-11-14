/* 路径与常量：本面板用到的所有文件位置、端口、外部程序 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// lib/ 的上一级才是面板根目录（public、panel-token.txt 都在那儿）
export const PANEL_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const __dirname = PANEL_ROOT
export const PORT = Number(process.env.STELLAR_PANEL_PORT || process.env.SURFCORE_PANEL_PORT || 3300)
// 默认只听本机回环（127.0.0.1）。面板对外只走 cloudflared 隧道 —— 那条会被判成 public、默认只读。
// 为什么不再默认 '::'：绑 '::' 等于把面板直接挂到公网 IPv6 上，谁能扫到端口谁就能进登录页，
// 而本机是非管理员、加不了防火墙规则，只能靠口令硬扛。要让同一 WiFi 的手机直连，
// 显式设 STELLAR_PANEL_HOST=0.0.0.0（或 '::'）再开。
export const HOST = process.env.STELLAR_PANEL_HOST || process.env.SURFCORE_PANEL_HOST || '127.0.0.1'
export const HOME = process.env.USERPROFILE || os.homedir()
export const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh')
export const SURF = process.env.STELLAR_DATA_DIR || path.join(DSH_HOME, 'stellar')
export const CFG_FILE = path.join(SURF, 'bili.config.json')
// 仓库自带的面板放在 <仓库根>/stellar-manager，所以桥接源码就在上一级。
// 完整部署里面板与桥接是同级目录（stellar-manager 与 stellar 并列），用 STELLAR_ROOT 指过去。
export const REPO = process.env.STELLAR_ROOT || path.dirname(PANEL_ROOT)
export const BILI = path.join(REPO, 'plugins', 'stellar', 'tools', 'bili.mjs')
// 桥接自己的配置（allow / deny / ownerQQ / consoleToken 都在这里，不是 bili.config.json）
export const BRIDGE_CFG = path.join(REPO, 'config.json')
// 黑名单/未授权拦截审计：桥接只追加，面板只读最后几行
export const ACCESS_AUDIT = path.join(REPO, 'state', 'access-audit.jsonl')
export const BRIDGE = path.join(REPO, 'src', 'bridge.js')
export const KEEPALIVE = path.join(SURF, 'keepalive.ps1')
export const PANEL_LOG = path.join(SURF, 'panel.log')
export const REPORTS_FILE = path.join(SURF, 'state', 'reports.jsonl')
export const REPORT_REQ = path.join(SURF, 'state', 'report-request.json')
export const TODOS_FILE = path.join(SURF, 'state', 'todos.json')
export const TUNNEL_FILE = path.join(SURF, 'state', 'panel-tunnel.json')
export const CLOUDFLARED = path.join(SURF, 'bin', 'cloudflared.exe')
export const TUNNEL_LOG = path.join(SURF, 'state', 'cloudflared.log')
export const LOGS = {
  keepalive: path.join(SURF, 'keepalive.log'),
  bridge: path.join(REPO, 'state', 'bridge.log'),
  panel: PANEL_LOG
}
// SnowLuma 的安装位置各家不同：优先环境变量，其次常见路径，最后留空（相关按钮会提示没找到）。
export const SNOW = process.env.STELLAR_SNOWLUMA_DIR || (['D:/SnowLuma', path.join(HOME, 'SnowLuma')].find((d) => { try { return fs.existsSync(d) } catch { return false } }) || '')
export const NODE = process.execPath
export const DSH_EXE = process.env.STELLAR_DSH_EXE || process.env.SURFCORE_DSH_EXE || findDshExe()
function findDshExe() {
  const guess = ['D:/dsh/DeepSeek Harness.exe', path.join(HOME, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')]
  for (const f of guess) { try { if (fs.existsSync(f)) return f } catch {} }
  return ''
}
export const AGENT_STATE_FILE = path.join(REPO, 'state', 'agent-state.json')
export const AUDIT_FILE = path.join(__dirname, 'audit.jsonl')
export const SLANG_FILE = path.join(REPO, 'state', 'slang.json')
export const STICKER_FILE = path.join(REPO, 'state', 'stickers.json')
export const MEMORY_REQUEST = path.join(SURF, 'state', 'memory-request.json')
// 通讯录（对象侧写）、发件箱（她发出去的消息）与查岗审计
export const FRIENDS_FILE = path.join(SURF, 'state', 'friends.json')
export const OUTBOUND_FILE = path.join(SURF, 'state', 'outbound-messages.jsonl')
export const CHAT_AUDIT = path.join(SURF, 'state', 'chat-history-audit.jsonl')
// 桥接 control console（本机回环 + x-console-token）
export const BRIDGE_CONSOLE = 'http://127.0.0.1:3100'
