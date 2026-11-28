// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 stellar bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { takeImageSlot } from './lib/image-budget.js'
import { takeDiagramSlot } from './lib/diagram-budget.js'
import { takePdfSlot } from './tools/lib/pdf/budget.mjs'
import { readStop } from './lib/emergency-stop.js'
import { approvalsEnabled, createApproval, finishApproval } from '../../src/approvals.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const name = 'qq-tool-restrict'

export const inject = ['tools']

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `subagent_codex` / `subagent_claude_code`（Codex / Claude Code 子智能体）
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

/**
 * Schema 精简名单（2026-11-09，用户要求「多余的全部砍掉」）。
 *
 * 与上面的危险工具名单不是一回事：这些名字**不危险**，只是走 QQ 会话根本用不到，
 * 而每一段 schema 都会在**每一步**请求里重新发一遍（实测 88 个工具共 73,425 字符 ≈ 24.5K tokens/步）。
 * 只保留主人点名的能力面：QQ 聊天/表情包、生图、B 站刷视频与动态、B 站评论与回复、
 * 空间说说（发/赞/评/回/删）、聊天与空间图片识别、联网搜索。
 *
 * 说明：
 *  - 只对**继承来的全局层**生效（tools.restrict 的语义）；preset 自己注册的
 *    ask_user_question / todo_write 不受影响。
 *  - 逐个 restrict + try/catch：当前 DSH 版本不存在的名字只记日志，不会整批失败。
 *  - mcp__snowluma__ 下的群聊工具也在名单里：config.allow.groups 为空（一个群都没有），
 *    这些工具调用必被拒绝，留着只是白付 schema 钱。
 */
const SCHEMA_SLIM_GLOBAL_TOOLS = [
  // univer 文档/表格/幻灯片全家桶（14）
  'univer_api', 'univer_compile_svg', 'univer_execute', 'univer_export', 'univer_import',
  'univer_inspect', 'univer_lint', 'univer_new', 'univer_print_pdf', 'univer_resources',
  'univer_screenshot', 'univer_status', 'univer_unit', 'univer_worktree',
  // DrawAI 画布三件（2026-11-27 补）：QQ 执行期白名单本来就不放行，但 schema 里留着
  // 会诱导模型去调（2026-11-26 她误把 diagram_apply 当画图工具，被拒后才发现没工具）。
  // 精确函数图/思维导图用 mcp__diagram__*，画布编辑只属于本地开发会话。
  'diagram_apply', 'diagram_export', 'diagram_read',
  // 远程会话（11）
  'remote_create_session', 'remote_download_file', 'remote_get_operation', 'remote_interrupt_session',
  'remote_list_hosts', 'remote_list_sessions', 'remote_list_workspaces', 'remote_read_session',
  'remote_send_message', 'remote_upload_file', 'remote_wait_sessions',
  // 上下文/ACP 里她用不到的（compress / search_context 保留：长聊靠它自救）
  'acp_cache', 'acp_read_original_image', 'acp_status', 'decompress',
  // 联网只留 mcp__web-search-safe__*（防 SSRF），宿主自带的两个不要
  'read_page', 'x_search',
  // 工作区切换（仿真会话本来就没有本地文件面）
  'working_directory',
  // 群聊工具见下方 GROUP_GLOBAL_TOOLS：按 allow.groups 动态决定是否隐藏
  // 历史 1480 次调用里一次没用过、且与保留工具重复的（2026-11-09 第二轮）
  // 注：qq_get_forward_msg（拆合并转发，返回 nestedForwardIds）与 qq_get_self_image 已放回——
  // 主人实际会发合并转发，她需要能真读到内容，不能只看到壳。
  'mcp__snowluma__qq_send_burst',        // 连发：qq_send_message 的 messages 数组已覆盖
  'mcp__snowluma__qq_read',              // 读会话：qq_wait_for_messages / get_message_detail 已覆盖
  'mcp__snowluma__stellar_bili_history',// 与 stellar_bili_my history 重复
  'search_context',                      // 搜压缩摘要：compress 还在，够用
]

/**
 * 群聊工具（2026-11-09 主人：「未来我会考虑将她接入群聊，请保留对应能力，但暂时不启用」）。
 *
 * 能力要保住、schema 先别付费：只要 config.json 的 allow.groups 还是空的，就把这四个藏起来；
 * 主人真加了群号并重启 DSH，它们自动回到工具表里 —— 不需要改代码。
 */
const GROUP_GLOBAL_TOOLS = [
  'mcp__snowluma__qq_send_group_message', 'mcp__snowluma__qq_get_group_history',
  'mcp__snowluma__qq_get_group_members', 'mcp__snowluma__qq_list_groups',
]

/** 读 allow.groups：有群号就说明准备进群了，群聊工具不藏。读不到配置按「没群」处理。 */
function groupModeEnabled() {
  const candidates = [
    path.join(os.homedir(), '.dsh', 'stellar', 'config.json'),
    path.resolve(__dirname, '..', '..', '..', '..', 'config.json')
  ]
  for (const file of candidates) {
    try {
      let text = fs.readFileSync(file, 'utf8')
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
      const groups = JSON.parse(text)?.allow?.groups
      if (Array.isArray(groups) && groups.length > 0) return true
    } catch {}
  }
  return false
}

// 供 test-preset-local-tools.mjs 对账：schema 精简名单单独导出，便于断言它确实被下发。
export const SCHEMA_SLIM_TOOL_NAMES = Object.freeze([...SCHEMA_SLIM_GLOBAL_TOOLS])

/** restrict 实际下发的全部名字（危险名单 + 精简名单 + 未进群时的群聊工具，去重）。 */
function restrictAll() {
  const slim = groupModeEnabled() ? SCHEMA_SLIM_GLOBAL_TOOLS : [...SCHEMA_SLIM_GLOBAL_TOOLS, ...GROUP_GLOBAL_TOOLS]
  return [...new Set([...KNOWN_DANGEROUS_GLOBAL_TOOLS, ...slim, ...FISHBOWL_BLOCKED_TOOLS])]
}

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

/**
 * 第三方小镇插件（dsh-fishbowl-town）注册的全局工具，名字不带 MCP 命名空间。
 *
 * 2026-11-21 安全审计：整前缀放行等于把 13 个**没有 owner 校验**的工具递给她——
 * 其中 setup 能持久改写人设、重绑接入码、把任意会话（含群）设成她的「家」；
 * owner 能替主人提交恋爱同意；phone 能给别的玩家发任意文本；go/play/visit/place
 * 都能花钱。而镇上的文字（昵称、招牌、留言）本来就可能带着指令，两者叠起来就是一条
 * 数据→指令→代主人办事的链（2026-11-21 安全体检的 S1 条目）。
 *
 * 当晚 21:56 主人拍板取「B 档」：玩法放开，三根红线继续拦。
 * 2026-11-27 插件 0.9.20：老镇关门，聊天工具改成鱼缸岛的 look/act；旧 look/play/visit/place
 * 已从插件里删掉，名单必须跟着换，否则岛上的事全落在 fail-closed 兜底。
 *   放行 = 只读（recent/isle_look/album/chats/rules）+ 玩法（go/friends，只动她自己的号）。
 *   仅主人私聊 = isle_act（能拿主人的饭票换鲸币、拍地、开店，非主人不能碰）。
 *   拒绝 = setup（改人设/重绑接入码/搬会话）、owner（替主人表态）、phone（给别人发文本）、
 *          build（在本机 Blender 里盖楼，属于本地执行）。
 * 名单之外的新工具一律 fail-closed。第三方插件自己的回合（答题）不吃这层白名单，
 * 因为它在插件的会话里跑，不经过 QQ preset。
 */
const FISHBOWL_READONLY_TOOLS = Object.freeze([
  'fishbowl_town_recent',   // 读她的日记本与小镇此刻状态
  'fishbowl_isle_look',     // 看岛上：鲸币/地/楼/店/订单/镇规/怎么做（0.9.17 起主世界）
  'fishbowl_town_album',    // 读相册
  'fishbowl_town_chats',    // 读聊天记录
  'fishbowl_town_rules',    // 读小镇规则
])

/** 玩法（游戏内动作，只作用于她自己的号；花的是游戏里的钱，由小镇日上限与小预算闸管）。 */
const FISHBOWL_PLAY_TOOLS = Object.freeze([
  'fishbowl_town_go',       // 让小镇立刻给她一个回合
  'fishbowl_town_friends',  // 为朋友做点什么
])

/** 仅主人私聊可用：isle_act 能动主人的饭票（fx_buy 自 0.9.16 起不再要求 owner_words）。 */
const FISHBOWL_OWNER_TOOLS = Object.freeze([
  'fishbowl_isle_act',      // 在岛上当场办事：换鲸币/出价/圈地/开店/画立绘
])

/** 明确拒绝的红线（schema 里也一并藏起来，避免模型反复尝试）。 */
const FISHBOWL_BLOCKED_TOOLS = Object.freeze([
  'fishbowl_town_setup',    // 改人设 / 重绑接入码 / 搬会话
  'fishbowl_town_owner',    // 替主人提交同意/分手
  'fishbowl_town_phone',    // 给别的玩家发任意文本
  'fishbowl_town_build',    // 在本机 Blender 里盖楼（本地执行）
])

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  // 第三方上下文压缩（billion-context 注入的全局工具）：只操作上下文，不含本地执行/网络写操作。
  // 2026-10-30 用户要求放行：不放行时模型会反复重试被拒工具（实测一个回合 197 次），
  // 且 QQ 会话本身没有这两套压缩就更容易爆上下文。
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
  // 画图（2026-11-08 用户要求「它可以自己画图」）：image_generate 只是调用 DSH 里已配置的
  // 生图供应商，把图片写进工作区，再返回路径；不碰 shell、不读任意本地文件。
  // 不放行时模型会反复尝试并跟主人抱怨「生成图片工具没给它放行」。
  // 注意：read_image 不能放——它在 LOCAL_EXECUTION_TOOLS 里（能读任意本地文件）。
  // 画完要让主人看到，用 qq_send_image 发到聊天、stellar_qzone_post 发空间。
  'image_generate',
  // 本地绘图（2026-11-26 主人拍板）：函数图/曲线/思维导图由 stellar 自绘 SVG，
  // 不联网、不读任意本地文件，只写 generate/diagram/。非主人有每日/窗口硬闸。
  'mcp__diagram__plot_function',
  'mcp__diagram__plot_curve',
  'mcp__diagram__draw_mindmap',
  // 小镇插件：只读五件 + 玩法五件（2026-11-21 主人拍板 B 档）；三根红线见 FISHBOWL_BLOCKED_TOOLS。
  ...FISHBOWL_READONLY_TOOLS,
  ...FISHBOWL_PLAY_TOOLS,
])

// 对外写操作：紧急停止时一律拒绝（读工具不受影响）。
const WRITE_TOOL_RE = /(?:qq_send_|qq_reply|qq_send_image|qq_send_sticker|stellar_qzone_post|stellar_qzone_react|stellar_qzone_delete_comment|stellar_bili_post|stellar_bili_comment|dynamic|image_generate|fishbowl_town_|fishbowl_isle_act)/i
function isWriteTool(name) { return WRITE_TOOL_RE.test(String(name || '')) }

// 紧急停止状态：3 秒缓存，避免每次工具调用都读盘。
let stopCache = { at: 0, active: false }
function stopActive(now = Date.now()) {
  if (now - stopCache.at < 3000) return stopCache.active
  try {
    stopCache = { at: now, active: readStop(now).active === true }
  } catch { stopCache = { at: now, active: false } }
  return stopCache.active
}

// ── 生图（2026-11-11 主人：不再请示管理员，改由每日 3 张硬闸兜）────────────────
// image_generate 是 DSH 全局工具，没有 MCP 的 key 参数，只能靠桥接写的
// state/turn-context.json 认「这条消息是谁说的」。快照 2 分钟内有效，对不上就
// 当非主人处理（宁可多问一次，也不让群友用一句提示词把图画出来）。
const TURN_CONTEXT_FILE = path.join(__dirname, '..', '..', 'state', 'turn-context.json')
const TURN_CONTEXT_DIR = path.join(__dirname, '..', '..', 'state', 'turn-context')
function readTurnContextFile(file, now) {
  try {
    const ctx = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!ctx || typeof ctx !== 'object' || !ctx.at) return null
    // 15 分钟：一轮长任务里身份快照不能中途过期，否则非主人的画图请求会掉进额度分支。
    if (now - Number(ctx.at) > 15 * 60 * 1000) return null
    return ctx
  } catch {
    return null
  }
}
function currentTurnContext(now = Date.now()) {
  return readTurnContextFile(TURN_CONTEXT_FILE, now)
}
// PDF 这类带 key 参数的工具按会话读自己的快照：全局 turn-context.json 会被
// 另一个会话的最后一条消息覆盖（2026-11-09 小号审批挂到主人会话的同一个坑）。
// 文件名规则与 bridge.js 的 turnContextFileFor 必须逐字一致。
function currentTurnContextForKey(key, now = Date.now()) {
  const k = String(key || '')
  if (k) {
    const safe = k.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)
    const ctx = readTurnContextFile(path.join(TURN_CONTEXT_DIR, safe + '.json'), now)
    if (ctx && String(ctx.key || '') === k) return ctx
  }
  return currentTurnContext(now)
}

// 精确数学图形的提示词特征（2026-11-27）：她昨天拿 image_generate 画 y=x，连画三张都歪。
// 只拦「明确要函数图/坐标系」的窄口径，避免误伤插画；命中后让她改用本地绘图 MCP。
const MATH_PLOT_PROMPT_RE = /(?:函数(?:图像|图|曲线)|坐标系|坐标轴|抛物线|双曲线|正弦|余弦|正切|指数函数|对数函数|幂函数|y\s*[=＝]\s*[-+0-9a-zA-Zπθ(])/;
function looksLikeMathPlotPrompt(prompt) {
  return MATH_PLOT_PROMPT_RE.test(String(prompt || ''));
}

/** 生图额度硬闸：每天 3 张、每 10 分钟最多 3 张；超了拒绝。**不用请示主人**（2026-11-11 改）。 */
function imageBudgetGuard(now = Date.now()) {
  try {
    const slot = takeImageSlot({ now })
    if (slot.ok) return
    if (slot.daily) {
      return '今天的画图额度用完了（每天最多 3 张，代码硬拦）。这次别画，也别重试；'
        + '跟对方说「今天画不了了，明天再说」就行，不用找主人批。'
    }
    const mins = Math.max(1, Math.ceil(slot.waitMs / 60000))
    return '画图额度用完了：' + slot.reason + '。不用请示主人，等额度自己恢复就行；'
      + `（大约 ${mins} 分钟后能再画；不要连续重试。）`
  } catch (error) {
    // 额度文件坏了不能把画图功能整体打死，但要留痕。
    console.error('[qq-tool-restrict] 生图额度检查失败：' + (error?.message ?? error))
    return
  }
}

/** PDF 深度读额度：非主人每天 5 次、10 分钟 2 次；主人（15 分钟内 turn-context 且 isOwner）不限。 */
function pdfBudgetGuard(exec, now = Date.now()) {
  try {
    // 按调用方传来的会话 key 读自己的身份快照；主人豁免必须命中这一条，
    // 不能靠「最后一条消息是谁说的」——两个会话交替时会误判。
    const args = exec?.arguments ?? exec?.args ?? null
    const key = args && typeof args === 'object' ? args.key : undefined
    const ctx = currentTurnContextForKey(key, now)
    const isOwner = ctx?.isOwner === true
    const slot = takePdfSlot({ now, isOwner })
    if (slot.ok) return
    if (slot.daily) {
      return '今天的 PDF 深度读额度用完了（非主人每天最多 5 次，代码硬拦）。这次别读，也别重试；'
        + '跟对方说「今天读不了了，明天再来」就行，不用找主人批。'
    }
    const waitMs = Number(slot.waitMs)
    const mins = Number.isFinite(waitMs) ? Math.max(1, Math.ceil(waitMs / 60000)) : 1
    return 'PDF 读得太频繁了（10 分钟内最多 2 次）。等一会儿再读；'
      + '大约 ' + mins + ' 分钟后能再读，不要连续重试。'
  } catch (error) {
    console.error('[qq-tool-restrict] PDF 额度检查失败：' + (error?.message ?? error))
    return
  }
}

/** 绘图额度硬闸：非主人每天 20 张、10 分钟 10 张；主人（15 分钟内 turn-context 且 isOwner）不限。 */
function diagramBudgetGuard(now = Date.now()) {
  try {
    const ctx = currentTurnContext(now)
    const isOwner = ctx?.isOwner === true
    const slot = takeDiagramSlot({ now, isOwner })
    if (slot.ok) return
    if (slot.daily) {
      return '今天的绘图额度用完了（非主人每天最多 20 张，代码硬拦）。这次别画，也别重试；'
        + '跟对方说「今天画不了了，明天再来」就行，不用找主人批。'
    }
    const mins = Math.max(1, Math.ceil(slot.waitMs / 60000))
    return '绘图额度用完了：' + slot.reason + '。不用请示主人，等额度自己恢复；'
      + `（大约 ${mins} 分钟后能再画；不要连续重试。）`
  } catch (error) {
    // 额度文件坏了不能把绘图功能整体打死，但要留痕。
    console.error('[qq-tool-restrict] 绘图额度检查失败：' + (error?.message ?? error))
    return
  }
}

// 给「插件兼容性体检」读取的只读快照：不要在别处再抄一份白名单。
export const SAFE_EXACT_TOOLS = Object.freeze([...SAFE_EXACT])
export const SAFE_TOOL_PREFIXES = Object.freeze([...SAFE_PREFIXES])
export const FISHBOWL_READONLY = Object.freeze([...FISHBOWL_READONLY_TOOLS])
export const FISHBOWL_PLAY = Object.freeze([...FISHBOWL_PLAY_TOOLS])
export const FISHBOWL_OWNER = Object.freeze([...FISHBOWL_OWNER_TOOLS])
export const FISHBOWL_BLOCKED = Object.freeze([...FISHBOWL_BLOCKED_TOOLS])

export function apply(ctx) {
  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  // 名字不存在时跳过（执行期白名单仍然兜底），但**只汇总一行**：
  // 以前每个工具打一行，DSH 启动时刷几百行日志，把真实告警淹没（2026-10-28 用户反馈）。
  const restricted = new Set()
  const ALL_NAMES = restrictAll()
  function restrictAvailable(report = false) {
    const skipped = []
    for (const name of ALL_NAMES) {
      if (restricted.has(name)) continue
      // 先登记再 restrict：restrict 可能同步触发 tools/change，避免重入时重复安装。
      restricted.add(name)
      try {
        ctx.tools.restrict({ deny: [name] })
      } catch (error) {
        restricted.delete(name)
        skipped.push(name)
        if (report && skipped.length === 1) {
          // 只在第一次失败时记一条细节，便于排查“某个名字失效”。
          console.error(`[qq-tool-restrict] restrict 跳过（示例）：${name} — ${error?.message ?? error}`)
        }
      }
    }
    return skipped
  }
  const skipped = restrictAvailable(true)
  // 一行汇总，便于重启后确认精简真的生效（用户 2026-11-09 要求砍掉多余工具面的验证点）。
  const slimSkipped = SCHEMA_SLIM_GLOBAL_TOOLS.filter((n) => skipped.includes(n))
  console.log(`[qq-tool-restrict] schema 精简 ${SCHEMA_SLIM_GLOBAL_TOOLS.length - slimSkipped.length}/${SCHEMA_SLIM_GLOBAL_TOOLS.length} 个工具`
    + `${slimSkipped.length ? `（当前版本没有：${slimSkipped.join(', ')}）` : ''}`)
  // 全局插件可能在 QQ preset 挂载之后才注册工具；执行白名单仍会拒绝，
  // 但 Schema 也会暴露给模型。每次工具表变化后，把晚注册的已知危险工具补装限制。
  ctx.on?.('tools/change', () => {
    try { restrictAvailable(false) } catch (error) {
      console.error(`[qq-tool-restrict] tools/change 补装限制失败：${error?.message ?? error}`)
    }
  })
  if (skipped.length) {
    const list = skipped.length > 8 ? `${skipped.slice(0, 8).join(', ')} 等` : skipped.join(', ')
    console.error(`[qq-tool-restrict] 跳过 ${skipped.length}/${ALL_NAMES.length} 个当前版本不存在的工具名：${list}（执行期白名单仍生效）`)
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  // ── 2026-11-12 成本硬闸（主人要求省 token）────────────────────────────
  // 数据：330 轮里 1837 次模型调用，avg 5.56 次/轮；qq_wait_for_messages 392 次、
  // qq_close_conversation 268 次，每次都要把整段上下文（平均 91K）重发一遍，
  // 合计占账单 17.7%。提示词已经写了「发完就 reply_and_finish」，但执行率不够
  // （145 轮里 wait+close 同时出现、44 轮 wait 超 2 次），所以这里加一层代码兜底：
  // 同一会话 90 秒内普通等待最多 2 次、45 秒内收尾最多 1 次，超了直接拒并给替代方案。
  // 沉睡前那一次 300 秒观察不受限制（那是铁律要求的）。
  const WAIT_WINDOW_MS = 90 * 1000
  const WAIT_WINDOW_MAX = 2
  const CLOSE_WINDOW_MS = 45 * 1000
  const waitHits = new Map()
  const lastCloseAt = new Map()
  const PRE_SLEEP_MS = 180 * 1000
  function argOf(exec, field) {
    const args = exec?.arguments ?? exec?.args ?? null
    if (!args || typeof args !== 'object') return undefined
    return args[field]
  }
  function costGuard(exec, name) {
    const key = String(argOf(exec, 'key') ?? '')
    if (!key) return
    const now = Date.now()
    if (name === 'mcp__snowluma__qq_wait_for_messages') {
      const purpose = String(argOf(exec, 'purpose') ?? 'messages')
      const timeout = Number(argOf(exec, 'timeoutMs') ?? 0) || 0
      // 沉睡前观察 / reply 型短静默都不拦：前者是铁律，后者本来就是省钱的做法。
      if (purpose === 'reply' || timeout >= PRE_SLEEP_MS) return
      const hits = (waitHits.get(key) ?? []).filter((at) => now - at < WAIT_WINDOW_MS)
      if (hits.length >= WAIT_WINDOW_MAX) {
        waitHits.set(key, hits)
        return '这轮已经等过了（90 秒内第 ' + (hits.length + 1) + ' 次普通等待）。等一次就够：要么按已有消息直接回，要么用 qq_reply_and_finish 回完收尾，要么先看 qq_get_context_snapshot 再决定。确需潜水，再做那一次 300 秒的沉睡前观察。'
      }
      hits.push(now)
      waitHits.set(key, hits)
      return
    }
    if (name === 'mcp__snowluma__qq_close_conversation') {
      const last = lastCloseAt.get(key) ?? 0
      if (last && now - last < CLOSE_WINDOW_MS) {
        return '这段已经收过尾了（45 秒内重复收尾）。重复 close 不会让对话更干净，只会再烧一遍上下文：有话没说完就用 qq_send_message 接着说完，下一轮再收。'
      }
      lastCloseAt.set(key, now)
      return
    }
  }
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    const costDenied = costGuard(exec, name)
    if (costDenied) return costDenied
    if (SAFE_EXACT.has(name)) {
      // 紧急停止时连生图也停（画了也发不出去，白花钱）
      if (name === 'image_generate' && stopActive()) {
        return '已紧急停止：主人按了停止键，现在不画图、不发消息。等主人在控制台恢复。'
      }
      // 2026-11-11 主人：开放生图，不再请示管理员；只剩每日 3 张的硬闸。
      if (name === 'image_generate') {
        // 2026-11-27：精确函数图不要交给生图模型（画不准，还白烧每天 3 张额度）。
        if (looksLikeMathPlotPrompt(argOf(exec, 'prompt'))) {
          return '这看起来是要精确的函数图/坐标系，不要用 image_generate 重画。'
            + '请改用 mcp__diagram__plot_function（参数/极坐标曲线用 mcp__diagram__plot_curve），'
            + '生成 PNG 后用 qq_send_image 发；如果确实想要插画风格，请在提示词里说明「插画/海报」并避开 y=... 这种精确表达式。'
        }
        return imageBudgetGuard()
      }
      if (name.startsWith('mcp__diagram__')) {
        if (stopActive()) return '已紧急停止：主人按了停止键，现在不画图。等主人在控制台恢复。'
        return diagramBudgetGuard()
      }
      return
    }
    // 小镇插件：逐名放行只读 + 玩法；isle_act 仅主人私聊；红线与未来新名字一律 fail-closed。
    if (name.startsWith('fishbowl_town_') || name.startsWith('fishbowl_isle_')) {
      if (FISHBOWL_READONLY_TOOLS.includes(name) || FISHBOWL_PLAY_TOOLS.includes(name)) return
      if (FISHBOWL_OWNER_TOOLS.includes(name)) {
        if (stopActive()) return '已紧急停止：主人按了停止键，现在不在岛上办事、不花饭票。等主人在控制台恢复。'
        const ctx = currentTurnContext()
        if (ctx?.isOwner === true && ctx?.kind === 'private') return
        return '岛上办事（' + name + '）只能在主人私聊里做：它可能拿主人的饭票换鲸币、拍地、开店。'
          + '非主人或群聊里先用 fishbowl_isle_look 查，别替主人花钱。'
      }
      return `小镇工具 "${name}" 不在 QQ 会话的白名单内：只放行只读（recent/isle_look/album/chats/rules）与玩法（go/friends）；`
        + '岛上办事（isle_act）只给主人私聊；改人设（setup）、替主人表态（owner）、给别人发文本（phone）、盖楼（build）仍然拦着。'
    }
    if (name === 'mcp__snowluma__stellar_pdf') {
      return pdfBudgetGuard(exec)
    }
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      // 紧急停止：停掉一切对外发言/发帖，只保留读工具
      if (isWriteTool(name) && stopActive()) {
        return '已紧急停止：主人按了停止键，现在不发消息、不发动态、不评论。等主人在控制台点「恢复运行」。'
      }
      return
    }
    // DrawAI 画布工具在 QQ 不可用；模型偶尔会凭旧上下文去调，直接把正确入口给它。
    if (name === 'diagram_apply' || name === 'diagram_export' || name === 'diagram_read') {
      return 'DrawAI 画布工具在 QQ 不可用。要画精确函数图请用 mcp__diagram__plot_function（参数/极坐标曲线用 mcp__diagram__plot_curve），思维导图用 mcp__diagram__draw_mindmap；生成 PNG 后用 qq_send_image 发。'
    }
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
}
