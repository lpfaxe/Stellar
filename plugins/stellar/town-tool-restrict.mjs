// 鱼缸小镇影子会话（town-act）的工具面：**只留小镇自己的几个工具**（2026-11-21）。
//
// 为什么要有这一层：
//   P2 阶段她每天只醒 3 次、去小镇看看自己的日子，不该顺手发 QQ、发空间、写文件、花钱。
//   「工具不存在」比「注册了再在代码里判断拒掉」更难被绕过：这里的 allowlist 是执行期兜底，
//   restrict 只是把无关工具的 schema 从上下文里拿掉（省钱），两层都不含任何写操作。
//
// 与 qq-tool-restrict / whale-tool-restrict 的区别：
//   · qq-tool-restrict = QQ 群聊的硬边界（允许 QQ MCP + 无害模型侧工具）；
//   · whale-tool-restrict = 只省钱，不做执行期拦截；
//   · 本文件 = 最窄的一档：除小镇自己的工具（含受闸门约束的 action）外，一律拒绝执行。
//
// 开关：删掉 preset 里的 town-tool-restrict 行就等于放开（不建议）；真正想开动作
// （visit/play/goto）时是在 MCP 侧按 town.actions 注册工具，不靠放开这个 guard。
export const name = 'town-tool-restrict'

export const inject = ['tools']

/** 唯一放行的工具：小镇自己的只读工具 + 规则查询（都是零副作用）。 */
export const ALLOWED_TOOLS = Object.freeze([
  'mcp__snowluma__stellar_town_status',
  'mcp__snowluma__stellar_town_bonds',
  'mcp__snowluma__stellar_town_lobby',
  'mcp__snowluma__stellar_town_recall',
  'mcp__snowluma__stellar_town_day',
  // 动作：工具本身还要过 town.actions + 预算/次数/间隔三道闸，这里只负责「影子会话可以碰它们」。
  'mcp__snowluma__stellar_town_visit',
  'mcp__snowluma__stellar_town_play',
  'mcp__snowluma__stellar_town_goto',
  'mcp__snowluma__stellar_rules',
])

/** 从 schema 里隐藏的重工具（省 token；执行期兜底是下面的 guard）。 */
export const HIDDEN_TOOLS = Object.freeze([
  // 本机执行 / 文件
  'pwsh', 'bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'working_directory',
  // 会话与任务
  'job_list', 'job_output', 'job_kill', 'schedule_create', 'schedule_edit', 'schedule_list',
  'schedule_view', 'todo_write', 'ask_user_question', 'present', 'skill',
  // 外发 / 联网 / 生图
  'web_search', 'web_fetch', 'read_page', 'x_search', 'image_generate',
  // 委派与工作流
  'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents',
  'list_subagent_models',
  // univer / remote / acp / MCP 通用资源
  'univer_api', 'univer_compile_svg', 'univer_execute', 'univer_export', 'univer_import',
  'univer_inspect', 'univer_lint', 'univer_new', 'univer_print_pdf', 'univer_resources',
  'univer_screenshot', 'univer_status', 'univer_unit', 'univer_worktree',
  'remote_create_session', 'remote_download_file', 'remote_get_operation',
  'remote_interrupt_session', 'remote_list_hosts', 'remote_list_sessions',
  'remote_list_workspaces', 'remote_read_session', 'remote_send_message',
  'remote_upload_file', 'remote_wait_sessions',
  'acp_cache', 'acp_read_original_image', 'acp_status', 'compress', 'decompress',
  'search_context', 'get_goal', 'create_goal', 'update_goal',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // QQ / B站 / 空间 / 抖音 / 记忆 —— 影子会话不该有对外的嘴
  'mcp__snowluma__qq_send_message', 'mcp__snowluma__qq_send_group_message',
  'mcp__snowluma__qq_send_private_message', 'mcp__snowluma__qq_send_image',
  'mcp__snowluma__qq_send_sticker', 'mcp__snowluma__qq_send_poke',
  'mcp__snowluma__qq_reply_and_finish', 'mcp__snowluma__qq_close_conversation',
  'mcp__snowluma__stellar_qzone_post', 'mcp__snowluma__stellar_qzone_react',
  'mcp__snowluma__stellar_qzone_delete_comment', 'mcp__snowluma__stellar_bili_post',
  'mcp__snowluma__stellar_bili_comment', 'mcp__snowluma__stellar_bili_share',
])

export function apply(ctx) {
  let hidden = 0
  for (const toolName of HIDDEN_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [toolName] })
      hidden += 1
    } catch {}
  }
  console.log(`[town-tool-restrict] 已从影子会话隐藏 ${hidden}/${HIDDEN_TOOLS.length} 个工具`)

  ctx.tools.guard((exec) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || toolName.length === 0) return '工具名无效，已拒绝'
    if (ALLOWED_TOOLS.includes(toolName)) return
    return `小镇影子会话只允许小镇工具（${toolName} 不在白名单内）。这里只看小镇，不发消息、不改文件、不花钱。`
  })
}
