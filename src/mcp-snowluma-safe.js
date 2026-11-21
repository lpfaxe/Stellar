// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTownTools } from './town-tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { capabilityEnabled } from './capabilities.js';
import { addTodo, listTodos, getTodo, updateTodo, parseDueAt, formatTodo } from './todos.js';
import { createQuestion } from './owner-questions.js';
import { serializeModelData } from './qq-model-view.js';
import { EMOTION_LABELS } from './sticker-semantics.js';
import { cabinetDir, saveToCabinet, humanBytes, listCabinetNames, CABINET_MAX_BYTES } from './file-cabinet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`) + (body?.hint ? `；建议：${body.hint}` : ''));
    if (body?.code) err.code = String(body.code);
    if (body?.hint) err.hint = String(body.hint);
    throw err;
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r4' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_context_snapshot: 'getSnapshot',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_close_conversation: 'closeConversation',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_message: 'sendMessage',
  qq_send_image: 'sendImage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
};
const TOOL_PROFILE = String(cfg.socialV2?.toolProfile || (cfg.socialV2?.tools?.getSnapshot === false ? 'full' : 'balanced'));
const PROFILE_HIDDEN = {
  balanced: new Set([
    'qq_social_state',
    'qq_get_active_members', 'qq_get_my_recent_messages',
  ]),
  compact: new Set([
    'qq_social_state',
    'qq_get_active_members', 'qq_get_my_recent_messages',
    'qq_get_group_members', 'qq_get_group_history',
    'qq_list_stickers',
  ]),
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    if (TOOL_PROFILE !== 'full' && PROFILE_HIDDEN[TOOL_PROFILE]?.has(name)) {
      disabledTools.push(`${name}(profile:${TOOL_PROFILE})`);
      return undefined;
    }
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    mode: z.enum(['tone', 'full']).optional().describe('默认群聊 tone（只语气/场景/日常），私聊 full；需要完整核心时显式传 full'),
    sections: z.array(z.enum(['role', 'wake', 'memory', 'stickers', 'slang', 'closure', 'voices'])).optional().describe('默认 role/wake/memory；需要表情/黑话/收尾/语音库时显式加'),
  },
  async ({ key, token, mode, sections }) => {
    try {
      const q = new URLSearchParams({ key });
      if (mode) q.set('mode', mode);
      if (Array.isArray(sections) && sections.length) q.set('sections', sections.join(','));
      const data = await agentApi(`/api/socialV2/prompt?${q}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_context_snapshot',
  '一次读取会话上下文：未读 + 最近 + 会话状态 + 活跃成员。默认只返回最近少量摘要，带 truncated/refs；需要精确正文再用 qq_get_message_detail。避免连续调用 unread/recent/social/activeMembers。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    include: z.array(z.enum(['unread', 'recent', 'social', 'activeMembers'])).optional().describe('默认四类都取；只取需要的可减少结果'),
    unreadLimit: z.number().int().min(1).max(100).optional().describe('未读最多返回条数，默认 12'),
    recentLimit: z.number().int().min(1).max(100).optional().describe('最近消息最多返回条数，默认 10'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('只取本地 seq 大于该水位的未读；用于补读'),
    textChars: z.number().int().min(40).max(2000).optional().describe('每条正文最多字符，默认 200'),
  },
  async ({ key, token, include, unreadLimit, recentLimit, afterSeq, textChars }) => {
    try {
      const q = new URLSearchParams({ key });
      if (Array.isArray(include) && include.length) q.set('include', include.join(','));
      if (unreadLimit) q.set('unreadLimit', String(unreadLimit));
      if (recentLimit) q.set('recentLimit', String(recentLimit));
      if (afterSeq) q.set('afterSeq', String(afterSeq));
      if (textChars) q.set('textChars', String(textChars));
      const data = await agentApi('/api/socialV2/snapshot?' + q.toString(), { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '获取上下文快照失败：' + String(error?.message ?? error) }], isError: true };
    }
  }
);
server.tool(
  'qq_reply_and_finish',
  '一次做完「回话 + 收尾」（2026-11-04 复合工具）：发完消息顺手把这段对话收掉，省掉单独调 qq_close_conversation 的那一步（少一步就少付一遍上下文）。适合：你回完这句就该结束的情况（对方说完收尾语、话题闭环、道别）。还在聊、要等对方补充时不要用它，改用 qq_send_message。对方明确在提问/求助时先用 qq_send_message 回完，桥接也会拒绝这种收尾。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的内容：字符串=一条，数组=多条（一次最多 8 条）'),
    summary: z.string().max(200).optional().describe('这次收在哪（一句话，给下次的自己看）'),
    nextOpening: z.string().max(120).optional().describe('下次可以怎么自然接（一句话，可选）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('已读水位，用已查看结果里的 readThroughSeq')
  },
  async ({ key, token, messages, summary, nextOpening, throughSeq }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const isBurst = Array.isArray(finalMessages);
      const sent = await agentApi(isBurst ? '/api/socialV2/send-burst' : '/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify(isBurst ? { key, messages: finalMessages } : { key, message: String(finalMessages) }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      let closed = null;
      let closeError = '';
      try {
        closed = await agentApi('/api/socialV2/close', {
          method: 'POST',
          body: JSON.stringify({ key, throughSeq, summary, nextOpening }),
          headers: { 'x-agent-token': token }
        });
      } catch (error) {
        // 发都发出去了，收尾失败不能把整次调用判成失败（否则模型会以为没发出去而重发）。
        closeError = String(error?.message ?? error);
      }
      return { content: [{ type: 'text', text: serializeModelData({ sent, closed, closeError: closeError || undefined }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_close_conversation',
  '自然结束当前这段对话：不再发消息，只记下这次收在哪、下次可以怎么接。结束后仍保持唤醒（被 @/叫到/私聊/开新话题会照常醒），不是潜水，不需要沉睡前观察。适合：双方都已收尾、没有新内容、或你不想硬接一句。对方明确在提问/求助时不要用它逃避，先用 qq_send_message 回完；桥接也会直接拒绝。和 qq_mark_read 的区别：mark_read 只是划走消息，close 会留下结束点，让下次接得自然。不要每轮都收尾。这一轮如果还要再发最后一句话，改用 qq_reply_and_finish 一次做完（省一遍上下文），不要发了再单独 close。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读水位：使用已查看结果中的 readThroughSeq；不传则只确认已经展示给你的那部分'),
    reason: z.enum(['natural', 'topic-done', 'explicit-end', 'busy', 'tired', 'other']).optional().describe('收尾原因：natural=自然收尾 / topic-done=话题聊完 / explicit-end=对方道别 / busy=各自去忙 / tired=聊累了 / other=其它'),
    summary: z.string().max(200).optional().describe('这次收在哪（一句话，给下次的自己看）'),
    nextOpening: z.string().max(120).optional().describe('下次可以怎么自然接（一句话，可选）')
  },
  async ({ key, token, throughSeq, reason, summary, nextOpening }) => {
    try {
      const data = await agentApi('/api/socialV2/close', {
        method: 'POST',
        body: JSON.stringify({ key, throughSeq, reason, summary, nextOpening }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `收尾失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。一次最多 8 条（数组按条数算，桥接硬拦）；内容太长先总结/挑重点，不要拆成 10 条刷屏。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。说完这轮就结束时，优先用 qq_reply_and_finish 一步收掉（少一步少付一遍上下文）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_send_image',
    '在聊天里发一张图片（照片/画作/截图，不是表情包；表情包用 qq_send_sticker）。imagePath 可以是本地文件路径、http(s) 链接，或 base64://…；image_generate 生成后直接把它返回的路径原样传进来即可。可选 caption 会作为图片前面的一条文字气泡发出去（想配一句说明时用）；不传就只发图片。只支持 PNG/JPEG/GIF/WebP，单张默认上限 8MB。注意：发之前先确认这图是该发在聊天里的——纯文字用 qq_send_message，发 QQ 空间动态用 stellar_qzone_post。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      imagePath: z.string().describe('图片路径/URL/base64（image_generate 返回的路径可直接用）'),
      caption: z.string().optional().describe('可选配文：会作为图片前的一条文字气泡发出去'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）')
    },
    async ({ key, token, imagePath, caption, replyToMessageId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({ key, imagePath, caption: caption ?? '', replyToMessageId: replyToMessageId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '发送图片失败：' + (error?.message ?? error) }], isError: true };
      }
    }
  );
}
if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息（含本轮开始后、调用前到的）也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；已有本轮没看过的消息会立即返回，没有才等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。积压消息按配置有界交付（默认最多 20 条/4000 字）；超出部分用 foldedCount/foldedPreview 标记，不要要求一次性倒出全部历史。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。看图时先认人再聊内容：图里如果出现你自己的账号、主页、资料卡、头像或动态，那就是你自己，先认出来再说，别当成别人的页面。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：每条含编号 no（如 #03）、情绪分类 emotion/emotionLabel、内容描述 content、触发关键词 keywords，以及 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数。可用 query 按编号/情绪/内容/备注搜索（如 query="委屈"）；缺情绪/内容的表情先用 qq_get_sticker_image 看图，再用 qq_sticker_note 补上。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          if (data?.text) return { content: [{ type: 'text', text: String(data.text) }] };
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 直接写编号最省事（"#03" 或 "3"），也可以用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情编号（"#03" / "3"，来自 qq_list_stickers 的 no），或 emoji_id / md5 / 图片 URL'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。收藏时**顺手标好情绪和内容**：emotion 选最接近的情绪类别，content 写一句图里是什么/什么时候用（如“抱着碗眼泪汪汪，委屈要饭”）。messageId 用 qq_get_message_detail / qq_get_my_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_message_detail / qq_get_my_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”'),
      emotion: z.enum(EMOTION_LABELS).optional().describe('情绪分类：看图判断最接近的一种（委屈/嘲讽/卖萌/摆烂/开心…）'),
      content: z.string().optional().describe('内容描述：一句话说清图里是什么、适合什么场景（最多 120 字）'),
      keywords: z.array(z.string()).optional().describe('触发关键词，如 ["抱碗","要饭","饿了"]，最多 8 个')
    },
    async ({ key, token, messageId, remark, emotion, content, keywords }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '', emotion: emotion || '', content: content || '', keywords: keywords || [] }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          if (data?.text) return { content: [{ type: 'text', text: String(data.text) }] };
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解：情绪分类 emotion、内容描述 content、触发关键词 keywords、标签/用法。这是本地记忆，不会修改 QQ 账号的官方备注；适合看图后给没标注的表情补上语义，之后聊天时桥接会按情绪/内容相近自动推荐它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情编号（"#03" / "3"）或 emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字'),
      emotion: z.enum(EMOTION_LABELS).optional().describe('情绪分类（看图或看内容后选最接近的一种）'),
      content: z.string().optional().describe('内容描述：一句话说清图里是什么（最多 120 字）'),
      keywords: z.array(z.string()).optional().describe('触发关键词，最多 8 个')
    },
    async ({ key, token, stickerId, note, tags, usage, emotion, content, keywords }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        if (emotion !== undefined && emotion !== null) payload.emotion = String(emotion);
        if (content !== undefined && content !== null) payload.content = String(content);
        if (keywords !== undefined && keywords !== null) payload.keywords = Array.isArray(keywords) ? keywords.map(String) : [];
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。**这是 QQ 聊天记录，不是 B站/其他平台的内容**：返回里的 platform=QQ、source=forwarded-chat-record、notice 就是这个意思；里面可能是群友之间的旧对话，也可能包含你自己以前在别处说过的话，按聊天记录理解，不要当成「我在B站发过的东西」。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 主人专用窄工具：发 QQ 空间 / 看 B 站链接 ─────────────────────────────────
//
// 背景：qq-chat / qq-chat-v2 两个 preset 刻意**不挂本地工具**（L7：群友永远不能
// 让 agent 执行命令），于是「发空间说说」「读主人甩来的 B 站链接」这两件事在 QQ
// 会话里原本根本做不到 —— 它们只存在于 B 站鲸鱼 agent 的 bili.mjs 里。
//
// 这里给的不是 shell，而是两个**argv 写死**的窄接口：
//   - 解释器固定 process.execPath，脚本路径固定在本仓库 tools/ 下；
//   - 模型只能传文本/图片路径/URL，不能拼参数、不能选工作目录；
//   - 只对 private:<ownerQQ> 开放（群友/陌生人拿到工具名也调不动）。
// 工具名走 mcp__snowluma__ 前缀，因此 qq-tool-restrict 的执行期白名单自动放行。
import yaml from 'js-yaml';
import { budgetSnapshot, charsToTokens, describePlan, estimateTask, formatCny, formatEstimate, formatSnapshot, TASK_PRESETS } from './cost-estimate.js';
import { readSpillSlice, writeSpill } from './tool-spill.js';
import { assertReadableLocalPath, assertPublicHttpUrl } from './file-read-guard.js';
import {
  approvalsEnabled,
  claimApproval,
  createApproval,
  expireApprovals,
  finishApproval,
  listApprovals,
  recoverStaleExecutions,
  verifyApproval
} from './approvals.js';

const TOOLS_DIR = path.join(ROOT, 'plugins', 'stellar', 'tools');
const BILI_SCRIPT = path.join(TOOLS_DIR, 'bili.mjs');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');   // stellar 仓库的上一级 = DSH 工作区

function runLocalScript(args, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [BILI_SCRIPT, ...args], {
        cwd: TOOLS_DIR,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
      });
    } catch (error) {
      reject(error);
      return;
    }
    let out = '';
    const cap = (chunk) => {
      out += chunk.toString('utf8');
      if (out.length > 120000) out = out.slice(-120000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`本地脚本超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.replace(/\u001b\[[0-9;]*m/g, '').trim();
      resolve({ code, text });
    });
  });
}

async function ownerOnlyError(key, token = '') {
  const owner = String(getConfig().ownerQQ ?? '').trim();
  if (!owner) return '未配置 ownerQQ，无法确认主人身份，已拒绝';
  if (!(await isOwnerRequest(key, token))) {
    // 失败必须可行动（AGENTS.md §1.7）：说清「为什么被拒」和「下一步怎么做」。
    // 不提令牌内容、不提具体会话，避免把身份信息带回群聊。
    return [
      '只有主人本人可以使用这个工具，这次没有执行。',
      '原因：没能凭会话令牌确认你是主人（令牌缺失/已轮换，或这个 key 背后不是主人的私聊）。',
      '下一步：如果这是唤醒/调度提示发起的，请把提示词里【会话令牌】那一行的值原样填进 token 参数；',
      '如果是主人直接在面板里对话，确认此刻没有别的会话在同时聊天，或等那条会话结束再试。'
    ].join('');
  }
  return '';
}

// image_generate 给的常是相对路径（generate/image/xxx.jpg）。这里按「原样 →
// 工作区 → 工作区 generate/image」三段解析，避免模型为了找路径去猜 cwd。
function resolveImagePath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  // 三个可能的 cwd：DSH 工作区、stellar 仓库、QQ agent 的 state/agents
  const roots = [WORKSPACE_ROOT, ROOT, path.join(ROOT, 'state', 'agents')];
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(raw);
  for (const root of roots) candidates.push(path.resolve(root, raw));
  for (const root of roots) candidates.push(path.resolve(root, 'generate', 'image', path.basename(raw)));
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  throw new Error(`找不到图片：${raw}（传绝对路径，或 generate/image 下的文件名）`);
}

function clip(text, max = 2600) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}\n…（输出过长已截断）` : value;
}

// ── 通用审批队列（轨道 C）──────────────────────────────────────────────────
// 规则：写动作（发说说 / 发动态 / 评论 / 点赞 / 删评论 / 分享 / 生图）只有主人能直接
// 触发；非主人（群友、陌生人、以及主人在群里说的话）一律只能**提交审批**，等主人
// 在 QQ 私聊或控制台点通过，才由 MCP 以主人权限代理执行。
//
// 身份靠 state/turn-context.json：桥接每收到一条消息就更新它，记录这条消息来自哪个
// 会话、是不是主人。只信任「key 对得上」的那份快照，过期（2 分钟）就不认，避免
// 群友用提示词冒充主人。
const TURN_CONTEXT_FILE = path.join(ROOT, 'state', 'turn-context.json');
const TURN_CONTEXT_DIR = path.join(ROOT, 'state', 'turn-context');
const TURN_CONTEXT_TTL_MS = 15 * 60 * 1000;

function turnContextFileFor(key) {
  const safe = String(key || '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(TURN_CONTEXT_DIR, safe + '.json');
}

function readContextFile(file) {
  try {
    const ctx = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ctx || typeof ctx !== 'object') return null;
    if (!ctx.at || Date.now() - Number(ctx.at) > TURN_CONTEXT_TTL_MS) return null;
    return ctx;
  } catch {
    return null;
  }
}

/**
 * 读「这个会话」的身份快照。优先 per-key 文件；旧版本只有全局文件时，
 * 只有 key 对得上才认（对不上说明最后一条消息来自别的会话）。
 */
function readTurnContext(key = '') {
  const normalized = String(key ?? '');
  if (normalized) {
    const own = readContextFile(turnContextFileFor(normalized));
    if (own) return own.key === normalized ? own : null;
  }
  const global = readContextFile(TURN_CONTEXT_FILE);
  if (!global) return null;
  if (!normalized) return global;
  return global.key === normalized ? global : null;
}

// ── 会话身份：令牌 → 身份（2026-11-11 P0 修复，方案 2）──────────────────────────
//
// 旧逻辑用 state/turn-context.json 判断「这条消息是不是主人发的」。那个快照只能说明
// **最近一条消息**是谁发的，说明不了「现在这次工具调用是谁在调」——主人在 15 分钟内
// 说过话，群友就能诱导模型把 key 写成 private:<主人QQ>，于是 11 个主人专属读工具
// （含任意文件读取）与 6 个写工具全开。根因是「身份」被一个可被模型改写的外观参数决定。
//
// 现在身份只认**令牌**：桥接给每个会话签发 agentToken（只存内存），把它写进唤醒提示；
// 模型要求调用工具时原样带回，MCP 拿令牌到桥接 /api/agent/identity 换回
// 「这个令牌属于哪个会话、是不是主人」。模型没有令牌可报，冒充就此断掉。
const IDENTITY_CACHE_TTL_MS = 10 * 1000;
const IDENTITY_CACHE_MAX = 64;
const identityCache = new Map();

/**
 * 令牌 → 身份。返回 { key, kind, isOwner, ownerQQ }，令牌无效/桥接不可达返回 null。
 *
 * 为什么不用 agentApi()：agentHeaders() 恒加 x-agent-call:1，而桥接把「带 x-agent-call
 * 且没有会话令牌」的请求判定为 403（/api/agent/identity 更是明确只许控制台调用）。
 * 这里走独立 fetch，只带 x-console-token。
 *
 * 负结果也缓存（10 秒）：会话令牌轮换后旧值会瞬间失效，没有缓存时每次工具调用都要
 * 多打一次桥接；但过期很快，轮换后最多 10 秒就能重新认出新令牌。
 */
async function resolveAgentIdentity(token) {
  const presented = String(token ?? '').trim();
  if (!presented) return null;
  const hit = identityCache.get(presented);
  if (hit && Date.now() - hit.at < IDENTITY_CACHE_TTL_MS) {
    // 刷新 Map 顺序，让「最近用过」的令牌晚一点被淘汰。
    identityCache.delete(presented);
    identityCache.set(presented, hit);
    return hit.identity;
  }
  let identity = null;
  try {
    const consoleToken = readConsoleToken();
    const res = await fetch(`${agentApiBase()}/api/agent/identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(consoleToken ? { 'x-console-token': consoleToken } : {})
      },
      body: JSON.stringify({ token: presented }),
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const body = await res.json();
      if (body && body.ok === true && body.key) {
        identity = {
          key: String(body.key),
          kind: String(body.kind ?? ''),
          isOwner: body.isOwner === true,
          ownerQQ: String(body.ownerQQ ?? '')
        };
      }
    }
  } catch {
    // 桥接不可达 = 无法确认身份 = 不是主人（失败关闭）。调用方会给可行动的提示。
    identity = null;
  }
  identityCache.set(presented, { at: Date.now(), identity });
  while (identityCache.size > IDENTITY_CACHE_MAX) {
    const oldest = identityCache.keys().next().value;
    identityCache.delete(oldest);
  }
  return identity;
}

/**
 * 有没有「别人的」新鲜快照：即除主人私聊之外，是否有会话在最近 15 分钟内说过话。
 *
 * 只服务于「无令牌」的兜底分支：主人直接在 DSH 面板里对话时提示词里没有令牌，
 * 此时若 QQ 侧正有活跃会话，就说明模型可能正被群友牵着走 —— 一律拒绝。
 */
function hasFreshForeignTurnContext(ownerKey) {
  const fresh = (ctx) => Boolean(ctx) && ctx.key !== ownerKey;
  try {
    if (fresh(readContextFile(TURN_CONTEXT_FILE))) return true;
  } catch {}
  try {
    for (const name of fs.readdirSync(TURN_CONTEXT_DIR)) {
      if (!name.endsWith('.json')) continue;
      if (fresh(readContextFile(path.join(TURN_CONTEXT_DIR, name)))) return true;
    }
  } catch {}
  return false;
}

/**
 * 这次工具调用是不是主人本人发起。
 *
 * @param key - 模型自报的会话 key（**只是外观，不作为身份依据**）
 * @param token - 会话令牌（唤醒提示/调度提示里的【会话令牌】，没有就不传）
 *
 * 判定顺序：
 * 1. 有令牌且桥接认得：isOwner 必须为真，且令牌所属会话要与 key 对得上
 *    （内部调度令牌 owner:internal 例外：它服务的是「主人自己那一侧」，允许写主人私聊 key）。
 * 2. 无令牌：只有「封闭 agent 模式」或「此刻没有任何别的会话在说话」时，才认主人私聊 key。
 *    这是为了让主人直接在 DSH 面板里对话时不至于所有工具都失灵；群友发起的那次会话必然
 *    伴随新鲜 turn-context，于是在这里被拦下。
 */
async function isOwnerRequest(key, token = '') {
  const owner = String(getConfig().ownerQQ ?? '').trim();
  if (!owner) return false;
  const normalized = String(key ?? '');
  const ownerKey = `private:${owner}`;
  const identity = await resolveAgentIdentity(token);
  if (identity) {
    if (!identity.isOwner) return false;
    if (identity.kind === 'internal') return normalized === ownerKey || normalized.startsWith('owner:');
    return identity.key === normalized;
  }
  if (normalized !== ownerKey) return false;
  try {
    if (await legacyReadToolAllowed()) return true;
  } catch {
    return false;
  }
  return !hasFreshForeignTurnContext(ownerKey);
}

function approvalRequester(key) {
  const ctx = readTurnContext(key);
  const base = { key: String(key ?? '') };
  if (!ctx || ctx.key !== base.key) return base;
  return {
    ...base,
    userId: ctx.userId != null ? String(ctx.userId) : undefined,
    nickname: ctx.nickname || undefined,
    groupId: ctx.groupId != null ? String(ctx.groupId) : undefined,
    groupName: ctx.groupName || undefined
  };
}

async function submitApproval({ key, action, args, summary }) {
  try {
    const record = createApproval({
      key: String(key ?? ''),
      requester: approvalRequester(key),
      action,
      args,
      summary
    });
    return {
      content: [{
        type: 'text',
        text: [
          `已提交审批 #${record.requestId}`,
          `动作：${record.actionLabel}`,
          `内容：${record.summary}`,
          `预计花费：${record.estimatedCost || '—'}`,
          `有效期：30 分钟（到 ${new Date(record.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}）`,
          '',
          '现在**没有执行**，要等主人在 QQ 私聊或控制台点通过。',
          '告诉请求的人「已经报给主人了，等主人点头」，不要重复提交同一条。'
        ].join('\n')
      }]
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `提交审批失败：${error?.message ?? error}（这次没有执行）` }],
      isError: true
    };
  }
}

// 写工具统一的身份闸：主人直接放行（返回 null），非主人转审批，其他情况给拒绝文案。
async function approvalGate({ key, token = '', action, args, summary, deniedMessage }) {
  const owner = String(getConfig().ownerQQ ?? '').trim();
  if (!owner) {
    return { content: [{ type: 'text', text: deniedMessage || '未配置 ownerQQ，无法确认主人身份，已拒绝' }], isError: true };
  }
  // 身份只认令牌（理由见 isOwnerRequest 上方的注释）。没有令牌 = 不是主人 → 走审批。
  if (await isOwnerRequest(key, token)) return null;
  // 审批关闭：恢复旧行为（写动作只有主人能做），不建队列。
  if (!approvalsEnabled()) {
    return { content: [{ type: 'text', text: deniedMessage || '这个动作只有主人能做，已经拒绝。' }], isError: true };
  }
  // 非主人：一律进审批。归档用**这个会话自己的**快照；只有它不存在时才退回最新一条，
  // 避免主人会话与群友会话交替时把审批挂到错的人头上。
  const own = readTurnContext(key);
  const ctx = own || readTurnContext();
  const approvalKey = ctx?.key && (!own || ctx.key === own.key) ? ctx.key : String(key ?? '');
  return submitApproval({ key: approvalKey, action, args, summary });
}

// 批准后的执行：以主人权限代理跑同一条本地脚本。参数来自审批快照，执行前已由
// claimApproval + verifyApproval 校验过哈希，这里只做 argv 拼装，不接受任何模型输入。
async function runApprovedAction(record) {
  const a = record.args || {};
  if (record.action === 'qzone_post') {
    const argv = ['qzone', 'post', '--text', String(a.text ?? '')];
    const image = a.imagePath ? resolveImagePath(a.imagePath) : '';
    if (image) argv.push('--image', image);
    if (a.right != null && String(a.right).trim() !== '') argv.push('--right', String(Number(a.right)));
    argv.push('--go');
    return runLocalScript(argv, { timeoutMs: 180000 });
  }
  if (record.action === 'bili_post') {
    const body = String(a.text ?? '');
    const image = a.imagePath ? resolveImagePath(a.imagePath) : '';
    const argv = image
      ? ['dynamic-image', '--image', image, '--text', body, '--go']
      : ['dynamic', 'post', '--text', body, '--go'];
    return runLocalScript(argv, { timeoutMs: 240000 });
  }
  if (record.action === 'bili_comment') {
    const argv = ['comment', '--message', String(a.message ?? '')];
    if (a.bvid) argv.push('--bvid', String(a.bvid));
    if (a.oid) argv.push('--oid', String(a.oid));
    if (a.root && a.parent) argv.push('--root', String(a.root), '--parent', String(a.parent));
    argv.push('--go');
    return runLocalScript(argv, { timeoutMs: 180000 });
  }
  if (record.action === 'qzone_react') {
    const act = String(a.action ?? '');
    if (act === 'comment') {
      const argv = ['qzone', 'comment', '--tid', String(a.tid ?? ''), '--text', String(a.text ?? '')];
      if (a.uin != null && String(a.uin).trim() !== '') argv.push('--uin', String(Number(a.uin)));
      if (a.commentId && a.commentUin) argv.push('--cid', String(a.commentId), '--cuin', String(Number(a.commentUin)));
      if (a.replyUin && a.replyName) argv.push('--ruin', String(Number(a.replyUin)), '--rname', String(a.replyName));
      argv.push('--go');
      return runLocalScript(argv, { timeoutMs: 120000 });
    }
    const argv = ['qzone', act, '--tid', String(a.tid ?? '')];
    if (a.uin != null && String(a.uin).trim() !== '') argv.push('--uin', String(Number(a.uin)));
    if (a.time != null && String(a.time).trim() !== '') argv.push('--time', String(Number(a.time)));
    argv.push('--go');
    return runLocalScript(argv, { timeoutMs: 90000 });
  }
  if (record.action === 'qzone_delete_comment') {
    const argv = ['qzone', 'uncomment', '--tid', String(a.tid ?? '')];
    if (a.replyId) argv.push('--reply', String(a.replyId), '--parent', String(a.parentCommentId ?? ''));
    else argv.push('--comment', String(a.commentId ?? ''));
    argv.push('--go');
    return runLocalScript(argv, { timeoutMs: 120000 });
  }
  throw new Error(`不认识的审批动作：${record.action}`);
}

// ── 已批准生图：tick 里直接画 + 直接回给请求者（不叫醒模型，省一轮 token）──
// 2026-11-09 用户要求：审批跑完后必须自己把图送回去，不能只执行动作就断链。
function dshHome() {
  return path.join(os.homedir(), '.dsh');
}

function loadImageGenConfig() {
  // 从 DSH profile 的 cordis.patch.yml 读当前生图供应商；不猜默认值。
  const root = path.join(dshHome(), 'profiles');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {}
  dirs.sort((a, b) => (a === 'desktop' ? -1 : b === 'desktop' ? 1 : a.localeCompare(b)));
  for (const dir of dirs) {
    const file = path.join(root, dir, 'cordis.patch.yml');
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const entries = Array.isArray(doc) ? doc : [];
    const flat = [];
    for (const item of entries) {
      if (Array.isArray(item?.insert)) flat.push(...item.insert);
      else flat.push(item);
    }
    const entry = flat.find((e) => e?.name === 'dsh-image-generation' || e?.id === 'image-gen');
    if (!entry?.config) continue;
    const conf = entry.config;
    const provider = (conf.providers || []).find((p) => p.id === conf.providerId) || (conf.providers || [])[0];
    if (!provider?.baseUrl) continue;
    const modelId = String(conf.modelId || provider.models?.[0]?.id || '');
    if (!modelId) continue;
    return { profile: dir, enabled: conf.enabled !== false, provider, modelId, size: conf.defaultSize || '1024x1024' };
  }
  return null;
}

function readCredentialRef(name) {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8'));
    const value = doc?.refs?.[String(name || '')];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

function imageExtFromContentType(ct, fallback = 'jpg') {
  const s = String(ct || '').toLowerCase();
  if (s.includes('png')) return 'png';
  if (s.includes('webp')) return 'webp';
  if (s.includes('gif')) return 'gif';
  if (s.includes('jpeg') || s.includes('jpg')) return 'jpg';
  return fallback;
}

async function generateImageDirect(prompt) {
  const conf = loadImageGenConfig();
  if (!conf) throw new Error('没找到生图供应商配置（profiles/*/cordis.patch.yml 里没有 dsh-image-generation）');
  const apiKey = readCredentialRef(conf.provider.apiKeyEnv);
  if (!apiKey) throw new Error('生图 Key 不在凭据里（' + (conf.provider.apiKeyEnv || 'apiKeyEnv 未配置') + '）');
  if (conf.provider.apiFormat && conf.provider.apiFormat !== 'openai-images') {
    throw new Error('当前供应商格式是 ' + conf.provider.apiFormat + '，审批直出目前只支持 openai-images');
  }
  const base = String(conf.provider.baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(base + '/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model: conf.modelId, prompt, n: 1, size: conf.size, response_format: 'url' }),
    signal: AbortSignal.timeout(180000)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || text.slice(0, 300);
    throw new Error('生图接口 HTTP ' + res.status + '：' + msg);
  }
  const item = body?.data?.[0];
  if (!item) throw new Error('生图接口没返回图片数据');
  let buf;
  let ext;
  if (item.b64_json) {
    buf = Buffer.from(String(item.b64_json), 'base64');
    ext = 'png';
  } else if (item.url) {
    const img = await fetch(String(item.url), { signal: AbortSignal.timeout(120000) });
    if (!img.ok) throw new Error('下载生成的图失败：HTTP ' + img.status);
    buf = Buffer.from(await img.arrayBuffer());
    ext = imageExtFromContentType(img.headers.get('content-type'));
  } else {
    throw new Error('生图接口返回里既没有 url 也没有 b64_json');
  }
  const dir = path.join(WORKSPACE_ROOT, 'generate', 'image');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `approved-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, model: conf.modelId, profile: conf.profile };
}

async function notifyOwnerApprovalDone(text) {
  const owner = String(getConfig().ownerQQ ?? '').trim();
  if (!owner) return;
  try {
    await onebot('send_private_msg', { user_id: Number(owner), message: [{ type: 'text', text }] });
  } catch {}
}

async function sendImageToTarget(record, file, prompt) {
  const key = String(record.key || '');
  const km = key.match(/^private:(\d+)$/);
  const gm = key.match(/^group:(\d+)$/);
  const qq = String(record.targetQQ || record.requester?.userId || (km ? km[1] : '') || '').trim();
  const group = String(record.targetGroup || record.requester?.groupId || (gm ? gm[1] : '') || '').trim();
  const b64 = fs.readFileSync(file).toString('base64');
  const caption = '主人点头了，画好啦～' + (prompt ? '\n' + prompt.slice(0, 80) : '');
  const message = [{ type: 'text', text: caption }, { type: 'image', data: 'base64://' + b64 }];
  if (group && /^\d+$/.test(group)) {
    const data = await onebot('send_group_msg', { group_id: Number(group), message });
    return { where: 'group:' + group, messageId: data?.message_id ?? null };
  }
  if (qq && /^\d+$/.test(qq)) {
    const data = await onebot('send_private_msg', { user_id: Number(qq), message });
    return { where: 'private:' + qq, messageId: data?.message_id ?? null };
  }
  throw new Error('这条审批没有可回发的 targetQQ/targetGroup（key=' + record.key + '）');
}

function countApprovedImagesToday() {
  const day = new Date().toDateString();
  return listApprovals({ status: 'executed' })
    .filter((a) => a.action === 'image_generate' && new Date(Number(a.executedAt) || 0).toDateString() === day)
    .length;
}

async function runApprovedImage(record) {
  const prompt = String(record.args?.prompt || '').slice(0, 500);
  if (!prompt) throw new Error('审批里没有画面描述');
  if (countApprovedImagesToday() >= 8) throw new Error('今天的审批生图已经 8 张（每日硬上限），这张没画');
  const made = await generateImageDirect(prompt);
  const sent = await sendImageToTarget(record, made.file, prompt);
  return { file: made.file, bytes: made.bytes, model: made.model, sent };
}

let approvalTicking = false;
async function tickApprovals() {
  if (approvalTicking) return;
  approvalTicking = true;
  try {
    expireApprovals();
    if (!approvalsEnabled()) return;
    const approved = listApprovals({ status: 'approved' });
    if (approved.length) console.error('[approval] tick approved=' + approved.map((x) => x.requestId).join(','));
    for (const item of approved) {
      if (item.action === 'image_generate') {
        // 生图不走 runApprovedAction（本地脚本没有画图能力）：这里直接用供应商 API
        // 画出来，再按 target 发回请求者。全程不叫醒模型。
        const claimed = claimApproval(item.requestId);
        console.error('[approval] image claim ' + item.requestId + ' ok=' + claimed.ok + ' pid=' + process.pid);
        if (!claimed.ok) continue;
        const fresh = claimed.approval;
        if (!verifyApproval(fresh)) {
          finishApproval(fresh.requestId, { ok: false, error: '参数快照被改动，拒绝执行' });
          continue;
        }
        try {
          const made = await runApprovedImage(fresh);
          finishApproval(fresh.requestId, {
            ok: true,
            by: 'owner-proxy',
            result: '已画好并回发 ' + made.sent.where + '：' + made.file + '（' + made.model + '，' + made.bytes + ' 字节）'
          });
          void notifyOwnerApprovalDone('#' + fresh.requestId + ' 已画好并发给 ' + made.sent.where + '（' + made.model + '）。');
          console.error('[approval] image done ' + fresh.requestId + ' -> ' + made.sent.where);
        } catch (error) {
          const msg = error?.message ?? String(error);
          finishApproval(fresh.requestId, { ok: false, error: msg, by: 'owner-proxy' });
          void notifyOwnerApprovalDone('#' + fresh.requestId + ' 生图失败：' + msg);
          try {
            const qq = String(fresh.targetQQ || fresh.requester?.userId || fresh.key.replace(/^private:/, '')).trim();
            if (/^\d+$/.test(qq)) {
              await onebot('send_private_msg', {
                user_id: Number(qq),
                message: [{ type: 'text', text: '主人点头了，但图没画成：' + msg.slice(0, 120) }]
              });
            }
          } catch {}
          console.error('[approval] image error ' + fresh.requestId + ' ' + msg);
        }
        continue;
      }
      const claimed = claimApproval(item.requestId);
      console.error('[approval] claim ' + item.requestId + ' ok=' + claimed.ok + ' pid=' + process.pid);
      if (!claimed.ok) continue;
      // 执行前再核一次参数快照：approvals.json 被手改过就不执行。
      const fresh = claimed.approval;
      if (!verifyApproval(fresh)) {
        finishApproval(fresh.requestId, { ok: false, error: '参数快照被改动，拒绝执行' });
        continue;
      }
      try {
        console.error('[approval] exec start ' + fresh.requestId + ' ' + fresh.action);
        const { code, text } = await runApprovedAction(fresh);
        console.error('[approval] exec done ' + fresh.requestId + ' code=' + code + ' out=' + String(text || '').slice(0, 160));
        finishApproval(fresh.requestId, {
          ok: code === 0,
          result: clip(text, 1500),
          error: code === 0 ? '' : `脚本退出码 ${code}`,
          by: 'owner-proxy'
        });
      } catch (error) {
        console.error('[approval] exec error ' + fresh.requestId + ' ' + (error?.message ?? error));
        finishApproval(fresh.requestId, { ok: false, error: error?.message ?? String(error), by: 'owner-proxy' });
      }
    }
  } catch (error) {
    // 审批轮询失败不该影响工具服务本身，下个 tick 再试。
    console.error('[approval] tick error ' + (error?.stack || error));
  } finally {
    approvalTicking = false;
  }
}

// ── 分类规则按需下发（2026-11-09 主人要求）──────────────────────────────────
// 背景：以前把 B 站/空间/看图/抖音/日报/省钱的细则全写进人设，每轮都要发一遍；
// 但大部分轮次她只是在聊天，这些字就是纯浪费的「无效文本」。
//
// 现在的口径：
//   - 全局只留角色扮演 + 安全边界 + 聊天协议；
//   - 工具类规则放在 plugins/stellar/tools/rules/<topic>.md；
//   - 某个分类的工具在**本会话第一次**被调用时，把该分类的规则一起附在结果最前面，
//     之后不再重复（同一个 key + topic 只发一次，6 小时过期后重新发一次）；
//   - 想看某类规则也可以主动调 stellar_rules（不带 topic 就是目录）。
const RULES_DIR = path.join(TOOLS_DIR, 'rules');
const RULES_TTL_MS = 6 * 60 * 60 * 1000;
const RULE_TOPICS = Object.freeze({
  bili: 'B 站：看视频 / 评论与回复 / 发动态 / 用主人的号看',
  qzone: 'QQ 空间：发说说 / 看空间 / 点赞 / 评论回复 / 收回评论',
  image: '生图与发图（image_generate / qq_send_image / 发到空间或动态）',
  vision: '看懂聊天里的图片与表情',
  douyin: '抖音链接（只能读文字和评论，看不见画面）',
  report: '每天给主人写日报',
  cost: '花钱与预算（大任务先报价）',
  group: '群聊（预留，当前未启用）',
  file: '读文件 / 存进文件柜（PDF / Word / PPT / Excel / WPS）',
  town: '小镇：这三天在小镇做了什么、碰见过谁'
});
// key -> { at, topics:Set }
const rulesLoaded = new Map();

function readRuleFile(topic) {
  const name = String(topic ?? '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(RULE_TOPICS, name)) return '';
  try {
    const text = fs.readFileSync(path.join(RULES_DIR, `${name}.md`), 'utf8');
    return text.trim();
  } catch {
    return '';
  }
}

function ruleCatalog() {
  return Object.entries(RULE_TOPICS).map(([id, desc]) => `- ${id}：${desc}`).join('\n');
}

/** 把某个分类的规则标成「本会话已看过」。 */
function markRulesSeen(key, topic) {
  const k = String(key ?? '');
  if (!k) return;
  const now = Date.now();
  let entry = rulesLoaded.get(k);
  if (!entry || now - entry.at > RULES_TTL_MS) {
    entry = { at: now, topics: new Set() };
    rulesLoaded.set(k, entry);
  }
  entry.at = now;
  entry.topics.add(String(topic));
}

/**
 * 本会话第一次用这个话题的工具时，返回「规则正文」；已经看过则返回空串。
 * 这样她不必额外多跑一步，但每次真正动手前一定先看到该类限制。
 */
function rulesGateBlock(key, topic) {
  const k = String(key ?? '');
  const now = Date.now();
  const entry = rulesLoaded.get(k);
  if (entry && now - entry.at <= RULES_TTL_MS && entry.topics.has(topic)) return '';
  const body = readRuleFile(topic);
  if (!body) return '';
  markRulesSeen(k, topic);
  return `【${topic} 规则 · 本会话第一次用，之后不再重复】\n${body}\n【规则结束】`;
}

/** 把规则块插到工具返回的最前面（返回体可以是 text 或 text+image 混合）。 */
function withTopicRules(topic, handler) {
  return async (args) => {
    const result = await handler(args);
    const block = rulesGateBlock(args?.key, topic);
    if (!block) return result;
    if (result && Array.isArray(result.content)) {
      const [first, ...rest] = result.content;
      if (first && first.type === 'text') {
        return { ...result, content: [{ ...first, text: `${block}\n\n${first.text}` }, ...rest] };
      }
      return { ...result, content: [{ type: 'text', text: block }, ...result.content] };
    }
    return result;
  };
}

// 需要「先看规则」的工具 → 规则分类。注册时统一包一层，避免每个 handler 各写一遍。
const GATED_TOPICS = Object.freeze({
  stellar_bili_watch: 'bili',
  stellar_bili_my: 'bili',
  stellar_bili_history: 'bili',
  stellar_bili_feed: 'bili',
  stellar_bili_post: 'bili',
  stellar_bili_comment: 'bili',
  stellar_bili_comments: 'bili',
  stellar_qzone_post: 'qzone',
  stellar_qzone_read: 'qzone',
  stellar_qzone_react: 'qzone',
  stellar_qzone_delete_comment: 'qzone',
  stellar_douyin_watch: 'douyin',
  stellar_file_read: 'file',
  stellar_file_save: 'file',
  stellar_town_recall: 'town'
});

// 把这个 MCP 进程里注册的「分类工具」自动包上规则门（必须在我们自己的 server.tool 注册之前装好）。
{
  const rawTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const topic = GATED_TOPICS[name];
    if (!topic) return rawTool(name, ...rest);
    const handler = rest[rest.length - 1];
    if (typeof handler !== 'function') return rawTool(name, ...rest);
    return rawTool(name, ...rest.slice(0, -1), withTopicRules(topic, handler));
  };
}

// ── 小镇记忆查询（2026-11-21）───────────────────────────────────────────────
// ── 小镇工具（2026-11-21）：整块在 src/town-tools.js 里，这里只负责挂上去。
// 拆除：删 src/town-tools.js + 这一行 + GATED_TOPICS / RULE_TOPICS 的两行 town（scripts/town-remove.mjs 会列全）。
registerTownTools(server, { dshHome, z, ownerOnlyError });

server.tool(
  'stellar_rules',
  '查某一类工具的规矩（B 站/空间/生图/看图/抖音/日报/花钱/群聊/小镇）。不带 topic 返回目录。首次使用某类工具时规则会自动附在结果里，这里只是需要先看一眼或用完想复查时用。',
  {
    key: z.string().describe('当前会话 key，形如 private:<QQ> 或 group:<群号>；非主人只能读本会话转发里的文件'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    topic: z.string().optional().describe('bili / qzone / image / vision / douyin / report / cost / group')
  },
  async ({ key, token, topic }) => {
    const denied = await ownerOnlyError(key, token);
    if (denied) return { isError: true, content: [{ type: 'text', text: denied }] };
    const wanted = String(topic ?? '').trim().toLowerCase();
    if (!wanted) {
      return { content: [{ type: 'text', text: `可查的规则分类：\n${ruleCatalog()}\n\n用法：stellar_rules(key, topic: "bili")` }] };
    }
    const body = readRuleFile(wanted);
    if (!body) {
      return { isError: true, content: [{ type: 'text', text: `没有 ${wanted} 这个分类。可查：\n${ruleCatalog()}` }] };
    }
    markRulesSeen(key, wanted);
    return { content: [{ type: 'text', text: body }] };
  }
);


server.tool(
  'stellar_qzone_post',
  '发一条 QQ 空间说说（机器人自己那个 QQ 号的空间）。主人私聊直接用；非主人带 go=true 时会自动转成「等主人审批」，不会立即发。用法：先不带 go 调一次（只演练，返回将要发送的正文/图片/权限），确认无误再带 go=true 真发。一天有条数上限。配图优先从「今天手边能用的图」里挑（stellar_image_pool action=list，B站封面/评论图都在池子里，跨天清空）—— 图真的贴合文案才配，没有就不配；也可以用 image_generate 刚生成的路径（相对路径会按工作区解析）。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    text: z.string().describe('说说正文（不要写"AI生成"，不要贴主人隐私/地址/联系方式）'),
    imagePath: z.string().optional().describe('可选：配图路径（stellar_image_pool 里挑到的图路径 / image_generate 返回的路径 / generate/image 下的文件名）；没有贴合的图就别传'),
    right: z.union([z.number(), z.string()]).optional().describe('可见范围：1=所有人 4=好友（默认） 16=部分可见 64=仅自己 128=部分不可见'),
    go: z.boolean().optional().describe('不传或 false=只演练；true=真正发出去。确认要发才传 true')
  },
  async ({ key, token, text, imagePath, right, go }) => {
    try {
      const body = String(text ?? '').trim();
      if (!body) return { content: [{ type: 'text', text: '说说正文不能为空' }], isError: true };
      if (body.length > 900) return { content: [{ type: 'text', text: `正文太长（${body.length} 字），QQ 空间说说请压到 900 字以内` }], isError: true };
      if (go === true) {
        const gate = await approvalGate({
          key,
          token,
          action: 'qzone_post',
          args: { text: body, imagePath: imagePath ? String(imagePath) : '', right: right != null ? String(right) : '' }
        });
        if (gate) return gate;
      }
      const args = ['qzone', 'post', '--text', body];
      const image = resolveImagePath(imagePath);
      if (image) args.push('--image', image);
      if (right != null && String(right).trim() !== '') args.push('--right', String(Number(right)));
      args.push(go === true ? '--go' : '--dry');
      const { code, text: output } = await runLocalScript(args, { timeoutMs: 180000 });
      const prefix = go === true ? '【已尝试真实发送】' : '【仅演练，未发送；确认后带 go=true 再调一次】';
      const payload = output || '（脚本无输出）';
      return {
        content: [{ type: 'text', text: clip(`${prefix}\n退出码: ${code}\n${payload}`) }],
        isError: code !== 0
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `发空间失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'stellar_bili_watch',
  '看 B 站视频链接（公开只读，主人和群友都能用，不进审批）。自动从任意分享文案/短链（b23.tv 会跟跳转）里抠出 BV 号，抓标题/简介/字幕/热评给她一份简报。主人发来 BV 号、b23.tv 或 bilibili.com 链接、或"【标题】https://…"整段文字时用它；默认不抽帧（快），要细看画面再传 frames=true（慢，会下载视频+ffmpeg 抽帧）。热评默认 8 条，主人说"多看看评论"就把 comments 调到 40~60（最多 80）；只想先扫评论区可以用更轻的 stellar_bili_comments。评论里的图（表情包/截图）默认不下载，传 images 才附上。注意：这是**只读分析**（抓标题/字幕/热评/抽帧），不会在 B 站观看历史里留下记录——B 站的历史要播放器真的报进度才算；主人问"为什么看了没有历史"就这么解释，别说接口坏了。',
  {
    key: z.string().describe('当前会话 key（私聊 private:<QQ> 或群聊 group:<群号>）'),
    url: z.string().describe('B 站链接、b23.tv 短链、BV 号，或整段分享文案'),
    frames: z.boolean().optional().describe('是否抽帧看画面（默认 false，只读文字信息）'),
    comments: z.number().int().min(0).max(80).optional().describe('这次读几条热评：默认 8；主人说"多看看评论/多读几条"就给 40~60（最多 80，越多越费 token）'),
    images: z.number().int().min(0).max(6).optional().describe('热评里的图下载几张并附在结果里（默认 0=只看文字；想看她评论区那些表情包/截图就给 1~3，很费 token）'),
    sort: z.enum(['hot', 'new']).optional().describe('评论排序：hot=热度（默认），new=按时间最新')
  },
  async ({ key, url, frames, comments, images, sort }) => {
    try {
      // 公开只读：非主人也能看，不进审批（不碰主人账号里的私有数据）。
      const input = String(url ?? '').trim();
      if (!input) return { content: [{ type: 'text', text: '没收到链接：把 B 站链接或 BV 号发过来' }], isError: true };
      const args = ['link', input];
      if (frames !== true) args.push('--no-frames');
      const want = Number.isFinite(comments) && comments > 0 ? Math.max(1, Math.min(80, Math.floor(comments))) : 0;
      if (want) args.push('--comments', String(want));
      const wantImages = Number.isFinite(images) ? Math.max(0, Math.min(6, Math.floor(images))) : 0;
      if (wantImages > 0) args.push('--cimages', String(wantImages));
      if (String(sort ?? '').toLowerCase() === 'new') args.push('--sort', 'new');
      const { code, text: output } = await runLocalScript(args, { timeoutMs: 300000 });
      const payload = output || '（脚本无输出）';
      const maxChars = want ? Math.min(12000, 3000 + want * 180) : 3200;
      // 带图时 debrief 会把评论图下载到临时目录并打成「🖼 <路径>」行；
      // 路径行摘出来换成真正的 image 块，模型才看得见（和 stellar_bili_comments 同一套）。
      if (wantImages <= 0) return { content: [{ type: 'text', text: clip(payload, maxChars) }], isError: code !== 0 };
      const restLines = [];
      const pics = [];
      for (const line of String(payload).split('\n')) {
        const m = /^\s*🖼\s+(.+?)\s*$/.exec(line);
        if (!m) { restLines.push(line); continue; }
        if (pics.length >= Math.max(1, wantImages)) continue;
        const blk = mediaImageBlock(m[1]);
        if (blk) pics.push(blk);
      }
      const blocks = [{ type: 'text', text: clip(restLines.join('\n'), maxChars) }];
      if (pics.length) {
        blocks.push({ type: 'text', text: '评论里的图（原图，直接看）一共 ' + pics.length + ' 张：' });
        blocks.push(...pics);
      } else {
        blocks.push({ type: 'text', text: '（这次没取到评论图：可能这几条热评没图、图是 AVIF/HEIC 而本机缺 ffmpeg、或单张超过 4.5MB 附不上）' });
      }
      return { content: blocks, isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: `看链接失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'stellar_douyin_watch',
  '看抖音分享链接/文案（公开只读，主人和群友都能用，不进审批）。会开一个无头浏览器读抖音页面，抓文案/作者/粉丝数/发布时间/点赞评论数/热评，给她一份简报。主人发来「复制打开抖音…」那种分享文案、v.douyin.com 短链、douyin.com/video/… 链接时用它。**不下载视频、不抽帧**：只读文字，画面内容看不到——被问画面细节就直说没抽帧，只能按文案和评论判断。一次渲染约 40-60 秒，等它跑完再说话。',
  {
    key: z.string().describe('当前会话 key（私聊 private:<QQ> 或群聊 group:<群号>）'),
    url: z.string().describe('抖音链接或整段分享文案（含 https://v.douyin.com/… 即可）'),
    comments: z.number().int().min(0).max(20).optional().describe('要读几条热评，默认 5，0 = 不读评论')
  },
  async ({ key, url, comments }) => {
    try {
      // 公开只读：非主人也能看，不进审批。
      const input = String(url ?? '').trim();
      if (!input) return { content: [{ type: 'text', text: '没收到链接：把抖音分享文案或链接发过来' }], isError: true };
      const args = ['douyin', input];
      if (Number.isFinite(comments)) args.push('--comments', String(comments));
      const { code, text: output } = await runLocalScript(args, { timeoutMs: 240000 });
      const payload = output || '（脚本无输出）';
      return { content: [{ type: 'text', text: clip(payload) }], isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: `看抖音失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 主人专用窄工具：用主人自己的 B 站号看 ─────────────────────────────────────
//
// 主人在 设置→B站 里绑定的「主人的号」，单账号用户（self.mid === owner.mid）由
// lib/owner-account.mjs 自动复用同一份 cookie。这里全是只读命令：历史/收藏/关注/
// 首页推荐/按她口味选题/发她自己的动态。**绝不为主人号发任何内容**（边界见
// lib/bili-qr-login.mjs:9-13），发动态永远走她自己的号。
server.tool(
  'stellar_bili_my',
  '用主人自己的 B 站账号看（只读，只给主人用：key 必须是 private:<主人QQ>）。what 选看什么：account=账号概况、history=最近在看的视频、favorites=收藏夹、following=关注的人、updates=关注的人发了什么新视频、recommend=B站按这个号习惯推的首页。主人说"用我的号看看B站""我在看什么""我的收藏""我关注了谁""首页给我推了啥"时用它。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    what: z.enum(['account', 'history', 'favorites', 'following', 'updates', 'recommend']).optional().describe('要看什么：account（默认）/history/favorites/following/updates/recommend'),
    limit: z.union([z.number(), z.string()]).optional().describe('条数，默认 10（following 20），最多 50')
  },
  async ({ key, token, what, limit }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const want = String(what ?? 'account').trim() || 'account';
      const allowed = ['account', 'history', 'favorites', 'following', 'updates', 'recommend'];
      if (!allowed.includes(want)) {
        return { content: [{ type: 'text', text: 'what 只能是 ' + allowed.join(' / ') }], isError: true };
      }
      const args = ['my', want];
      if (limit != null && String(limit).trim() !== '') {
        const n = Math.max(1, Math.min(50, Number(limit) || 10));
        args.push('--limit', String(n));
      }
      const { code, text: output } = await runLocalScript(args, { timeoutMs: 90000 });
      return { content: [{ type: 'text', text: clip(output || '（脚本无输出）') }], isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '用主人的号看 B 站失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_bili_history',
  '在主人自己的 B 站观看历史里找他看过的视频（只给主人用）。可以带关键词只找他看过的某个题材（q），也可以限定最近几天（days）。想看某个具体视频的正文内容，就把这里的 BV 号交给 stellar_bili_watch。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    limit: z.union([z.number(), z.string()]).optional().describe('条数，默认 10，最多 30'),
    q: z.string().optional().describe('可选：只留标题/UP 名里含这个词的记录'),
    days: z.union([z.number(), z.string()]).optional().describe('可选：只看最近 N 天看过的')
  },
  async ({ key, token, limit, q, days }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const args = ['my', 'history'];
      const n = limit != null && String(limit).trim() !== '' ? Math.max(1, Math.min(30, Number(limit) || 10)) : 10;
      args.push('--limit', String(n));
      const word = String(q ?? '').trim();
      if (word) args.push('--q', word);
      if (days != null && String(days).trim() !== '') args.push('--days', String(Math.max(1, Math.min(90, Number(days) || 7))));
      const { code, text: output } = await runLocalScript(args, { timeoutMs: 90000 });
      return { content: [{ type: 'text', text: clip(output || '（脚本无输出）') }], isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '看观看历史失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_bili_feed',
  '按**她自己的口味**选题：从 B 站的搜索/热门/排行/关注里挑几个她今天想看的视频（只读，不看她主人的号）。主人问"你今天想看什么""自己找点东西看"时用它，挑好再用 stellar_bili_watch 看具体内容。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    n: z.union([z.number(), z.string()]).optional().describe('要几个，默认 5，最多 15')
  },
  async ({ key, token, n }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const count = n != null && String(n).trim() !== '' ? Math.max(1, Math.min(15, Number(n) || 5)) : 5;
      const { code, text: output } = await runLocalScript(['feed', '--n', String(count)], { timeoutMs: 240000 });
      return { content: [{ type: 'text', text: clip(output || '（脚本无输出）') }], isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '选题失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_bili_post',
  '在**她自己的 B 站号**上发一条动态。主人私聊直接用；非主人带 go=true 时转成「等主人审批」，不会立即发。带 imagePath 就是图文动态（jpg/png/gif），不带就是纯文字。默认只演练：先不带 go 调一次看正文/图片，确认无误再 go=true 真发。发动态有每日额度上限，被限额拦下就照脚本提示来，别换参数硬试。发完把动态 id 记下来，发错了可以用 stellar_bili_watch 那套脚本的 rm 撤（动态 id 见返回）。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    text: z.string().describe('动态正文（她自己说话的语气；不要写"AI生成"，不要贴主人隐私）'),
    imagePath: z.string().optional().describe('可选：配图路径（image_generate 返回的路径原样传，或 generate/image 下的文件名）'),
    go: z.boolean().optional().describe('不传或 false=只演练；true=真正发出去')
  },
  async ({ key, token, text, imagePath, go }) => {
    try {
      const body = String(text ?? '').trim();
      if (!body) return { content: [{ type: 'text', text: '动态正文不能为空' }], isError: true };
      if (body.length > 700) return { content: [{ type: 'text', text: '正文太长（' + body.length + ' 字），B 站动态压到 700 字以内' }], isError: true };
      if (go === true) {
        const gate = await approvalGate({
          key,
          token,
          action: 'bili_post',
          args: { text: body, imagePath: imagePath ? String(imagePath) : '' }
        });
        if (gate) return gate;
      }
      const flag = go === true ? '--go' : '--dry';
      let scriptArgs;
      const image = resolveImagePath(imagePath);
      if (image) scriptArgs = ['dynamic-image', '--image', image, '--text', body, flag];
      else scriptArgs = ['dynamic', 'post', '--text', body, flag];
      const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 240000 });
      const prefix = go === true ? '【已尝试真实发布】' : '【仅演练，未发布；确认后带 go=true 再调一次】';
      return { content: [{ type: 'text', text: clip(prefix + '\n' + (output || '（脚本无输出）')) }], isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '发动态失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);
server.tool(
  'stellar_bili_comment',
  '在 B 站视频下发一条评论。主人私聊直接用；非主人带 go=true 时转成「等主人审批」，不会立即发。默认只演练：先不带 go 调一次看正文和账号，确认无误再 go=true 真发。带 root+parent 就是回复那条评论的楼中楼（先用 stellar_bili_watch 拿热评里的评论 id）。有每日条数上限和「同一视频 60 分钟内不重复」的限制，被拦就照提示来，别换参数硬试。她用的是主人自己的 B 站号，话要像主人自己说，别自称 AI。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    bvid: z.string().optional().describe('视频 BV 号（推荐，aid 会自动查）'),
    oid: z.string().optional().describe('可选：稿件 aid（一般不用传，bvid 会自动查）'),
    message: z.string().describe('评论正文（不要写"AI生成"，不要贴主人隐私）'),
    root: z.string().optional().describe('回复楼中楼时：线程根评论 rpid'),
    parent: z.string().optional().describe('回复楼中楼时：要回复的那条评论 rpid'),
    go: z.boolean().optional().describe('不传或 false=只演练；true=真正发出去')
  },
  async ({ key, token, bvid, oid, message, root, parent, go }) => {
    try {
      const body = String(message ?? '').trim();
      if (!body) return { content: [{ type: 'text', text: '评论正文不能为空' }], isError: true };
      if (body.length > 400) return { content: [{ type: 'text', text: '评论太长（' + body.length + ' 字），压到 400 字以内' }], isError: true };
      const bv = String(bvid ?? '').match(/BV[0-9A-Za-z]{10}/)?.[0] ?? '';
      const aid = String(oid ?? '').trim();
      if (!bv && !aid) return { content: [{ type: 'text', text: '要给 bvid（BV 号）或 oid（aid）' }], isError: true };
      const hasRoot = root != null && String(root).trim() !== '';
      const hasParent = parent != null && String(parent).trim() !== '';
      if (hasRoot !== hasParent) return { content: [{ type: 'text', text: 'root 和 parent 要成对给（回复楼中楼）' }], isError: true };
      if (go === true) {
        const gate = await approvalGate({
          key,
          token,
          action: 'bili_comment',
          args: { bvid: bv, oid: aid, message: body, root: hasRoot ? String(root) : '', parent: hasParent ? String(parent) : '' }
        });
        if (gate) return gate;
      }
      const scriptArgs = ['comment', '--message', body];
      if (bv) scriptArgs.push('--bvid', bv);
      if (aid) scriptArgs.push('--oid', aid);
      if (hasRoot) scriptArgs.push('--root', String(root), '--parent', String(parent));
      scriptArgs.push(go === true ? '--go' : '--dry');
      const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 180000 });
      const prefix = go === true ? '【已尝试真实发送】' : '【仅演练，没发出去；确认后带 go=true 再调一次】';
      return { content: [{ type: 'text', text: clip(prefix + '\n退出码: ' + code + '\n' + (output || '（脚本无输出）')) }], isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '发评论失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_bili_comments',
  '只看一条 B 站视频的评论区（公开只读，主人和群友都能用，不进审批）。比 stellar_bili_watch 轻：不抓字幕/弹幕、不抽帧、不下载视频，几秒就能给她几十条评论，每条带点赞数/回复数/rpid；想连楼中楼一起看就传 replies。评论区里的图（表情包/截图）默认不下载，传 images 才会把图附在结果里让她看见 —— 想吐槽/接梗时先看两眼图。主人说"多看几条评论""评论区都在说什么""再往下翻翻"时用它（n 给 40~60）；要搞懂视频本身还是用 stellar_bili_watch。返回里的 rpid 就是评论 id，想搭话时交给 stellar_bili_comment 的 root/parent。',
  {
    key: z.string().describe('当前会话 key（私聊 private:<QQ> 或群聊 group:<群号>）'),
    url: z.string().describe('B 站链接、b23.tv 短链、BV 号或 av 号'),
    n: z.number().int().min(1).max(80).optional().describe('要读几条评论，默认 30，最多 80（越多越费 token，40~60 一般够）'),
    sort: z.enum(['hot', 'new']).optional().describe('hot=按热度（默认）/ new=按时间最新'),
    replies: z.number().int().min(0).max(5).optional().describe('每条主评论再带几条楼中楼回复，默认 0（想看清争论就给 2~3）'),
    images: z.number().int().min(0).max(6).optional().describe('评论里的图下载几张并附在结果里（默认 0=只看文字；想看图给 1~3，很费 token）')
  },
  async ({ key, url, n, sort, replies, images }) => {
    try {
      // 公开只读：非主人也能看，不进审批。
      const input = String(url ?? '').trim();
      if (!input) return { content: [{ type: 'text', text: '没收到链接或 BV 号' }], isError: true };
      const count = Math.max(1, Math.min(80, Number.isFinite(n) ? Math.floor(n) : 30));
      const args = ['comments', input, '--n', String(count)];
      if (String(sort ?? '').toLowerCase() === 'new') args.push('--sort', 'new');
      const sub = Number.isFinite(replies) ? Math.max(0, Math.min(5, Math.floor(replies))) : 0;
      if (sub > 0) args.push('--replies', String(sub));
      const wantImages = Number.isFinite(images) ? Math.max(0, Math.min(6, Math.floor(images))) : 0;
      if (wantImages > 0) args.push('--images', String(wantImages));
      const { code, text: output } = await runLocalScript(args, { timeoutMs: 180000 });
      const payload = output || '（脚本无输出）';
      // 带图时脚本会把图片下载到临时目录并把路径打成「  🖼 <路径>」行；
      // 这里把路径行从正文里摘出来，换成真正的 image 块（模型才看得见）。
      const blocks = [];
      const imageBlocks = [];
      const textLines = [];
      for (const line of String(payload).split('\n')) {
        const m = /^\s*🖼\s+(.+?)\s*$/.exec(line);
        if (!m) { textLines.push(line); continue; }
        if (imageBlocks.length >= Math.max(1, wantImages) * 2) continue;
        const blk = mediaImageBlock(m[1]);
        if (blk) imageBlocks.push(blk);
      }
      blocks.push({ type: 'text', text: clip(textLines.join('\n'), Math.min(12000, 2500 + count * 140)) });
      if (imageBlocks.length) {
        blocks.push({ type: 'text', text: '评论里的图（原图，直接看）一共 ' + imageBlocks.length + ' 张：' });
        blocks.push(...imageBlocks);
      } else if (wantImages > 0) {
        blocks.push({ type: 'text', text: '（这次没取到评论图：可能这些评论没图、图是 AVIF/HEIC 而本机缺 ffmpeg、或单张超过 4.5MB 附不上）' });
      }
      return { content: blocks, isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '看评论区失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 主人专用窄工具：分段读落盘的超长工具结果 ─────────────────────────────────
// web_fetch / web_search 超长时会落盘到 state/tool-spill，只回头尾；这里按字符
// 偏移分段读。路径由 tool-spill.js 的 resolveSpillPath 做 realpath + 前缀校验，
// 只可能读到 spill 目录里的文件（挡 ../、绝对路径、符号链接逃逸）。
server.tool(
  'stellar_spill_read',
  '主人专用：分段读取被落盘的超长工具结果（网页/搜索结果）。只允许读 spill 目录里的文件；offset 是字符偏移，maxChars 单次最多 8000。',
  {
    key: z.string().describe('会话身份键，私聊固定 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    path: z.string().describe('工具结果里给出的 spill 文件绝对路径'),
    offset: z.number().int().min(0).max(20000000).optional().describe('从第几个字符开始，默认 0'),
    maxChars: z.number().int().min(200).max(8000).optional().describe('本次读多少字，默认 4000，最多 8000')
  },
  async ({ key, token, path: file, offset, maxChars }) => {
    const denied = await ownerOnlyError(key, token);
    if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
    try {
      const slice = readSpillSlice({ file, offset: offset ?? 0, maxChars: maxChars ?? 4000 });
      const head = `文件：${slice.file}\n第 ${slice.start}–${slice.end} 字 / 共 ${slice.total} 字` +
        (slice.hasMore ? `（还有 ${slice.total - slice.end} 字，下次 offset=${slice.end}）` : '（已到末尾）');
      return { content: [{ type: 'text', text: head + '\n\n' + slice.text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '读 spill 失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 主人专用窄工具：按 id 读长期记忆原文 ───────────────────────────────────
//
// 记忆注入只给「摘要 + id」（memory-tiers 的召回块、记忆卡都是这个口径），
// 原文留在 memory-card-full.jsonl / memory-card.json 里。以前只能去控制台搜，
// 会话里没有通道 —— 这里补上：按 id 取一条，或按关键词搜几条。
function activeMemoryDir() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    const cur = JSON.parse(fs.readFileSync(path.join(home, '.dsh', 'stellar', 'characters', 'current.json'), 'utf8'));
    if (cur && cur.dir) return path.join(String(cur.dir), 'memory');
  } catch { /* 没角色系统就回退 */ }
  return path.join(ROOT, '..', 'memory');
}

function memoryRecordView(rec, maxChars) {
  const lines = [];
  lines.push('id: ' + rec.id);
  if (rec.kind) lines.push('类型: ' + rec.kind);
  if (rec.title) lines.push('标题: ' + rec.title);
  if (rec.createdAt) lines.push('时间: ' + rec.createdAt);
  if (rec.importance != null) lines.push('重要度: ' + rec.importance);
  if (Array.isArray(rec.tags) && rec.tags.length) lines.push('标签: ' + rec.tags.join(', '));
  const text = String(rec.text ?? '');
  const detail = String(rec.detail ?? '');
  const body = [text, detail].filter(Boolean).join('\n');
  if (lines.length) lines.push('');
  lines.push(body.length > maxChars ? body.slice(0, maxChars) + '…（已截断）' : body);
  return lines.join('\n');
}

async function readMemoryById(id, maxChars) {
  const dir = activeMemoryDir();
  const keep = Math.min(4000, Math.max(200, Number(maxChars) || 2000));
  const wanted = String(id ?? '').trim();
  if (!wanted) return null;
  // 先翻全量档案（只追加，最新一条在后），命中即返回
  try {
    const file = path.join(dir, 'memory-card-full.jsonl');
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(wanted)) continue;
        try {
          const rec = JSON.parse(lines[i]);
          if (rec && String(rec.id) === wanted) return memoryRecordView(rec, keep);
        } catch { /* 坏行跳过 */ }
      }
    }
  } catch { /* 读不到就走卡片 */ }
  try {
    const card = JSON.parse(fs.readFileSync(path.join(dir, 'memory-card.json'), 'utf8'));
    const rec = (card.records || []).find((r) => String(r.id) === wanted);
    if (rec) return memoryRecordView(rec, keep);
  } catch { /* 忽略 */ }
  return null;
}

async function searchMemory(query, maxChars, limit) {
  const dir = activeMemoryDir();
  const q = String(query ?? '').trim();
  if (!q) return [];
  const keep = Math.min(4000, Math.max(200, Number(maxChars) || 1200));
  const n = Math.min(10, Math.max(1, Number(limit) || 5));
  const hits = [];
  const seen = new Set();
  const scan = (file) => {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0 && hits.length < n; i--) {
        if (!lines[i].includes(q)) continue;
        try {
          const rec = JSON.parse(lines[i]);
          if (!rec || !rec.id || seen.has(rec.id)) continue;
          seen.add(rec.id);
          hits.push(memoryRecordView(rec, keep));
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 文件不存在就跳过 */ }
  };
  scan(path.join(dir, 'memory-card-full.jsonl'));
  if (hits.length < n) {
    try {
      const card = JSON.parse(fs.readFileSync(path.join(dir, 'memory-card.json'), 'utf8'));
      const recs = Array.isArray(card.records) ? card.records : [];
      for (let i = recs.length - 1; i >= 0 && hits.length < n; i--) {
        const rec = recs[i];
        if (!rec || seen.has(rec.id)) continue;
        const blob = String(rec.text ?? '') + String(rec.detail ?? '') + String(rec.title ?? '');
        if (!blob.includes(q)) continue;
        seen.add(rec.id);
        hits.push(memoryRecordView(rec, keep));
      }
    } catch { /* 忽略 */ }
  }
  return hits;
}

// ── 通讯录：知道自己在跟谁说话，并能按人查记忆 ─────────────────────────────
//
// 通讯录数据与桥接/控制台共用 %USERPROFILE%\.dsh\stellar\state\friends.json。
// 权限：主人可以看全部人、查任何人的记忆；非主人只能看自己、查自己的记忆。
// 这里只读，不改通讯录（改名/关系走控制台，避免模型顺手改主人的人际关系）。
function contactsStateFile() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.dsh', 'stellar', 'state', 'friends.json');
}

let contactsStateCache = { at: 0, book: null };
function readContactsState(force = false) {
  if (!force && contactsStateCache.book && Date.now() - contactsStateCache.at < 5000) return contactsStateCache.book;
  let book = null;
  try {
    let text = fs.readFileSync(contactsStateFile(), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    book = JSON.parse(text);
  } catch { /* 没通讯录就空着 */ }
  if (!book || typeof book !== 'object') book = {};
  if (!Array.isArray(book.people)) {
    const people = [];
    for (const [k, v] of Object.entries(book)) {
      if (!/^\d{5,12}$/.test(k) || !v || typeof v !== 'object') continue;
      people.push({ uin: k, nickname: String(v.name || v.nickname || k), remark: '', type: String(v.type || 'stranger'), relation: String(v.relation || ''), relationNote: String(v.note || '') });
    }
    book.people = people;
  }
  if (!Array.isArray(book.groups)) book.groups = [];
  contactsStateCache = { at: Date.now(), book };
  return book;
}

function contactDisplayName(p) {
  return String((p && (p.remark || p.nickname)) || (p && p.uin) || '').trim();
}

function contactTypeLabel(p) {
  const type = String(p?.type || '');
  if (type === 'owner') return '主人';
  if (type === 'friend') return '朋友';
  if (type === 'stranger') return '陌生人';
  return type || '未分类';
}

let memoryPoolCache = { at: 0, mtime: 0, records: [] };
function memoryRecordPool() {
  const dir = activeMemoryDir();
  const file = path.join(dir, 'memory-card-full.jsonl');
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* 只有卡片也行 */ }
  if (memoryPoolCache.records.length && Date.now() - memoryPoolCache.at < 5000 && memoryPoolCache.mtime === mtime) {
    return memoryPoolCache.records;
  }
  let card = null;
  try { card = JSON.parse(fs.readFileSync(path.join(dir, 'memory-card.json'), 'utf8')); } catch { /* 忽略 */ }
  const cardRecords = Array.isArray(card?.records) ? card.records : [];
  const cardById = new Map(cardRecords.filter((r) => r && r.id).map((r) => [String(r.id), r]));
  const byId = new Map();
  // 全量档案只追加、最新修订在后：从尾往前，同一个 id 第一次遇到的就是最新版。
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const rec = JSON.parse(lines[i]);
        if (!rec || !rec.id || byId.has(String(rec.id))) continue;
        byId.set(String(rec.id), rec);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 没有全量档案就只用卡片 */ }
  for (const rec of cardRecords) {
    if (rec && rec.id && !byId.has(String(rec.id))) byId.set(String(rec.id), rec);
  }
  // 旧修订可能没有 objectKey：用卡片里同一 id 的 objectKey 补上，保证按人过滤不漏。
  const records = [...byId.values()];
  for (const rec of records) {
    if (!rec.objectKey && cardById.has(String(rec.id))) rec.objectKey = cardById.get(String(rec.id)).objectKey;
  }
  memoryPoolCache = { at: Date.now(), mtime, records };
  return records;
}

function contactsMemoryCounts() {
  const counts = new Map();
  for (const rec of memoryRecordPool()) {
    const k = String(rec?.objectKey || '');
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

function contactMemoryTotal(p, counts) {
  const uin = String(p.uin);
  return (counts.get('private:' + uin) || 0) + (counts.get('owner:' + uin) || 0) + (counts.get('user:' + uin) || 0);
}

function callerUinFromKey(key) {
  const m = /^private:(\d{5,12})$/.exec(String(key ?? ''));
  return m ? m[1] : '';
}

function findContactMatches(person) {
  const q = String(person ?? '').trim();
  if (!q) return [];
  const book = readContactsState(true);
  const people = (book.people || []).filter((p) => p && p.uin);
  if (/^\d{5,12}$/.test(q)) {
    const hit = people.find((p) => String(p.uin) === q);
    return hit ? [hit] : [];
  }
  const lower = q.toLowerCase();
  const exact = people.filter((p) => {
    const name = String(p.remark || '').trim().toLowerCase();
    const nick = String(p.nickname || '').trim().toLowerCase();
    return name === lower || nick === lower;
  });
  if (exact.length) return exact;
  return people.filter((p) => {
    const blob = [p.remark, p.nickname, p.uin].map((x) => String(x ?? '').toLowerCase()).join(' ');
    return blob.includes(lower);
  });
}

function contactLine(p, counts) {
  const relation = String(p.relation || '').trim();
  const note = String(p.relationNote || '').trim();
  const total = contactMemoryTotal(p, counts);
  return '- ' + contactDisplayName(p) + '（' + p.uin + '）· ' + contactTypeLabel(p)
    + (relation ? ' · 关系：' + relation : '')
    + (note ? ' · 备注：' + note : '')
    + ' · 记忆 ' + total + ' 条';
}

server.tool(
  'stellar_contacts',
  '看自己的通讯录：谁被登记了、什么关系、各自存了多少条记忆（只读，不改通讯录）。主人私聊能看全部；非主人只能看自己。想回忆跟某个人有关的事，再用 stellar_person_memory 按人查。',
  {
    key: z.string().describe('当前会话 key，形如 private:<QQ>'),
    query: z.string().optional().describe('按昵称/备注/QQ 号搜，不填就列全部'),
    uin: z.string().optional().describe('直接给 QQ 号，等价于精确查这个人'),
    limit: z.number().int().min(1).max(100).optional().describe('最多列几条，默认 30')
  },
  async ({ key, query, uin, limit }) => {
    try {
      const book = readContactsState(true);
      const counts = contactsMemoryCounts();
      const ownerUin = String(getConfig().ownerQQ ?? '');
      const caller = callerUinFromKey(key);
      if (!caller) {
        return { content: [{ type: 'text', text: '这个工具只能在私聊里用（key 形如 private:<QQ>）。' }], isError: true };
      }
      const isOwner = caller === ownerUin;
      if (!isOwner) {
        const me = (book.people || []).find((p) => String(p.uin) === caller);
        if (!me) {
          return { content: [{ type: 'text', text: '通讯录里没有登记你（QQ ' + caller + '）。可以请主人把你加进通讯录。' }] };
        }
        return { content: [{ type: 'text', text: '你的登记信息：\n' + contactLine(me, counts) + '\n\n（通讯录里其他人的资料只有主人能查。）' }] };
      }
      const want = String(uin ?? '').trim() || String(query ?? '').trim();
      let people = (book.people || []).filter((p) => p && p.uin);
      if (want) {
        const matches = findContactMatches(want);
        if (!matches.length) {
          return { content: [{ type: 'text', text: '通讯录里没有找到「' + want + '」。可以列全部看看登记名。' }], isError: true };
        }
        people = matches;
      }
      const n = Math.min(100, Math.max(1, Number(limit) || 30));
      const shown = people.slice(0, n);
      const groups = want ? [] : (book.groups || []).slice(0, 20);
      const lines = [];
      lines.push('通讯录：' + people.length + ' 人 · ' + (book.groups || []).length + ' 群（只读）');
      for (const p of shown) lines.push(contactLine(p, counts));
      for (const g of groups) {
        const relation = String(g.relation || '').trim();
        const note = String(g.relationNote || '').trim();
        lines.push('- 群「' + String(g.remark || g.name || g.groupId) + '」（' + g.groupId + '）'
          + (relation ? ' · 关系：' + relation : '') + (note ? ' · 备注：' + note : ''));
      }
      if (people.length > shown.length) lines.push('（还有 ' + (people.length - shown.length) + ' 人没显示，用 query 缩小范围）');
      lines.push('');
      lines.push('要看跟某个人的具体记忆：stellar_person_memory(person="QQ号或备注")。查不到就说没记住，别编。');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '查通讯录失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_person_memory',
  '按人查她记得的事：给联系人 QQ 号/备注/昵称，可选关键词。主人可以查任何人；非主人只能查自己。返回这个人的记忆条目（新→旧），查不到就明说没记住。',
  {
    key: z.string().describe('当前会话 key，形如 private:<QQ>'),
    person: z.string().describe('联系人的 QQ 号，或通讯录里的备注/昵称'),
    query: z.string().optional().describe('可选关键词，只返回正文/标题/标签里含这个词的'),
    limit: z.number().int().min(1).max(20).optional().describe('返回几条，默认 8，最多 20'),
    chars: z.number().int().min(200).max(2000).optional().describe('每条正文最多多少字，默认 600')
  },
  async ({ key, person, query, limit, chars }) => {
    try {
      const ownerUin = String(getConfig().ownerQQ ?? '');
      const caller = callerUinFromKey(key);
      if (!caller) {
        return { content: [{ type: 'text', text: '这个工具只能在私聊里用（key 形如 private:<QQ>）。' }], isError: true };
      }
      const matches = findContactMatches(person);
      if (!matches.length) {
        return { content: [{ type: 'text', text: '通讯录里没有找到「' + person + '」。先确认 QQ 号或备注（不知道就问主人，别瞎猜）。' }], isError: true };
      }
      if (matches.length > 1) {
        const names = matches.slice(0, 8).map((p) => contactDisplayName(p) + '（' + p.uin + '）').join('、');
        return { content: [{ type: 'text', text: '「' + person + '」匹配到多个人：' + names + '。请给 QQ 号或更准确的备注。' }], isError: true };
      }
      const target = matches[0];
      const uin = String(target.uin);
      const isOwner = caller === ownerUin;
      if (!isOwner && caller !== uin) {
        return { content: [{ type: 'text', text: '你只能查自己的记忆。' }], isError: true };
      }
      const keys = new Set(['private:' + uin, 'owner:' + uin, 'user:' + uin]);
      const q = String(query ?? '').trim();
      const lower = q.toLowerCase();
      const keep = Math.min(2000, Math.max(200, Number(chars) || 600));
      const n = Math.min(20, Math.max(1, Number(limit) || 8));
      const pool = memoryRecordPool();
      const selected = [];
      for (const rec of pool) {
        if (!keys.has(String(rec?.objectKey || ''))) continue;
        if (lower) {
          const blob = [rec.text, rec.detail, rec.title, Array.isArray(rec.tags) ? rec.tags.join(' ') : '']
            .map((x) => String(x ?? '')).join('\n').toLowerCase();
          if (!blob.includes(lower)) continue;
        }
        selected.push(rec);
        if (selected.length >= n) break;
      }
      const name = contactDisplayName(target);
      const head = '关于 ' + name + '（' + uin + '）的记忆'
        + (q ? ' · 含「' + q + '」' : '') + '：找到 ' + selected.length + ' 条（新→旧，最多显示 ' + n + ' 条）';
      if (!selected.length) {
        return { content: [{ type: 'text', text: head + '\n\n她还没把跟这个人有关的事记下来（或者已经被遗忘）。不要编，没记住就直说。' }] };
      }
      return { content: [{ type: 'text', text: head + '\n\n' + selected.map((rec) => memoryRecordView(rec, keep)).join('\n\n---\n\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '按人查记忆失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_todo',
  '她的待办事项（只给主人用，key 必须是 private:<主人QQ>）。主人说「后天提醒我买东西」「今晚 9 点叫我」时：action=add，text=要提醒的事，dueAt=时间（可以写「后天 19:00」「2026-11-12 09:30」或毫秒时间戳）。到点前她会被调度器叫醒，再由她用 qq_send_message 提醒主人。主人说「提醒示例好友明天带伞」时，再带上 targetKey（示例好友的会话 key，如 private:<他的QQ>）与 targetName。不填 targetKey 就提醒让记这件事的人。action=list 看还没做的；action=done/cancel 用 id 收尾。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    action: z.enum(['add', 'list', 'done', 'cancel']).describe('add=新增 / list=看列表 / done=完成 / cancel=取消'),
    text: z.string().optional().describe('action=add 时必填：要提醒什么事'),
    dueAt: z.union([z.string(), z.number()]).optional().describe('action=add 时必填：什么时候提醒（「后天 19:00」「明天上午 9 点」「2026-11-12 09:30」或毫秒时间戳）'),
    id: z.string().optional().describe('action=done/cancel 时必填：待办 id（t 开头）'),
    targetKey: z.string().optional().describe('action=add 时可选：到点提醒谁（会话 key，如 private:1000000003 或 group:123456）。不填就提醒让记这件事的人'),
    targetName: z.string().optional().describe('action=add 时可选：提醒对象怎么称呼（如「示例好友」），只用于提示词和列表展示'),
    includeDone: z.boolean().optional().describe('action=list 时是否连已完成的一起列，默认 false'),
    limit: z.number().int().min(1).max(100).optional().describe('action=list 时最多列几条，默认 20')
  },
  async ({ key, token, action, text, dueAt, id, includeDone, limit, targetKey, targetName }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const act = String(action || 'list');
      if (!capabilityEnabled('todo') && act !== 'list') {
        return { content: [{ type: 'text', text: '控制台把「待办提醒」关了，先让主人到设置里打开再说。' }], isError: true };
      }
      if (act === 'list') {
        const items = listTodos({ includeDone: includeDone === true, limit: limit || 20 });
        if (!items.length) return { content: [{ type: 'text', text: '待办是空的。' }] };
        const lines = items.map((it) => formatTodo(it));
        return { content: [{ type: 'text', text: '待办 ' + items.length + ' 条：\n\n' + lines.join('\n\n') }] };
      }
      const tid = String(id || '').trim();
      if (act === 'done' || act === 'cancel') {
        if (!tid) return { content: [{ type: 'text', text: '要给待办的 id（t 开头）' }], isError: true };
        const row = updateTodo(tid, { status: act === 'done' ? 'done' : 'cancelled' });
        return { content: [{ type: 'text', text: '已' + (act === 'done' ? '完成' : '取消') + '：' + formatTodo(row) }] };
      }
      const wantText = String(text || '').trim();
      if (!wantText) return { content: [{ type: 'text', text: 'action=add 要给 text（提醒什么事）' }], isError: true };
      let due = 0;
      const n = Number(dueAt);
      if (Number.isFinite(n) && n > 1e12) due = n;
      else due = parseDueAt(String(dueAt ?? ''));
      if (!due) due = parseDueAt(wantText);
      if (!due) return { content: [{ type: 'text', text: '时间没看懂：给「后天 19:00」「2026-11-12 09:30」这种，或者毫秒时间戳。' }], isError: true };
      if (due <= Date.now()) return { content: [{ type: 'text', text: '这个时间已经过去了（' + new Date(due).toLocaleString('zh-CN', { hour12: false }) + '），换一个。' }], isError: true };
      const ctx = readTurnContext(key) || {};
      const row = addTodo({
        text: wantText,
        dueAt: due,
        key: String(key || ''),
        createdBy: key,
        requester: {
          userId: String(ctx.userId || key.replace(/^private:/, '')),
          nickname: String(ctx.nickname || '主人'),
          groupId: String(ctx.groupId || ''),
          groupName: String(ctx.groupName || '')
        },
        targetKey: String(targetKey || ''),
        targetName: String(targetName || ''),
        note: String(ctx.groupName || '')
      });
      return { content: [{ type: 'text', text: '记下了：' + formatTodo(row) + '\n\n到点我会被叫醒，再提醒你。要取消就说一声，或者用 action=cancel id=' + row.id + '。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '待办操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_ask_owner',
  '遇到只有主人能拍板的问题（别人说「你不信去问你主人」、问到主人的私事/权限/安排），用它把问题转给主人。别自己编主人的态度。只能在非主人会话里用；主人会收到 QQ 私聊，回复后答案会送回这个会话，你再按主人的意思回复对方。',
  {
    key: z.string().describe('当前会话 key，形如 private:<QQ> 或 group:<群号>'),
    question: z.string().describe('要问主人的问题，一句话说清（比如「好友B问能不能帮他画一张图，你同意吗？」）'),
    context: z.string().optional().describe('可选：对方原话或背景，方便主人判断')
  },
  async ({ key, question, context }) => {
    try {
      if (!capabilityEnabled('askOwner')) {
        return { content: [{ type: 'text', text: '控制台把「替人问主人」关了，这个问题只能跟对方说你做不了主。' }], isError: true };
      }
      const k = String(key || '').trim();
      const ctx = readTurnContext(k);
      if (!ctx) return { content: [{ type: 'text', text: '这个会话最近没有消息记录，先别问主人（等对方再说一句）。' }], isError: true };
      if (ctx.isOwner === true) return { content: [{ type: 'text', text: '你就是主人，不用转给自己。' }], isError: true };
      const q = String(question || '').trim();
      if (!q) return { content: [{ type: 'text', text: '问题不能为空' }], isError: true };
      const row = createQuestion({
        key: k,
        question: q,
        context: String(context || ''),
        requester: {
          userId: String(ctx.userId || ''),
          nickname: String(ctx.nickname || ''),
          groupId: String(ctx.groupId || ''),
          groupName: String(ctx.groupName || '')
        }
      });
      return { content: [{ type: 'text', text: '已经把问题转给主人了（#' + row.id + '）。主人回之前，先跟对方说「我去问一下我主人」，别自己替他答。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '转问主人失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_share',
  '主动把有意思的事分享给通讯录里的人（只给主人/她自己的后台会话用）。people 写昵称、备注或 QQ 号，逗号分隔，最多 3 人；go=true 才真发，先不带 go 演练看发给谁。可以带一张图（imagePath 用 image_generate 返回的路径）。不要群发、不要发给陌生人、一天最多 3 次。',
  {
    key: z.string().describe('当前会话 key（主人私聊 private:<主人QQ>、owner:<QQ> 或 bili 后台会话）'),
    people: z.string().describe('收件人：昵称/备注/QQ号，逗号分隔，最多 3 人'),
    text: z.string().describe('要说的话（最多 300 字）'),
    imagePath: z.string().optional().describe('可选：本地图片路径（image_generate 返回的）'),
    go: z.boolean().optional().describe('true 才真发；不传或 false 只演练')
  },
  async ({ key, people, text, imagePath, go }) => {
    try {
      if (!capabilityEnabled('shareToFriends')) {
        return { content: [{ type: 'text', text: '控制台把「主动分享给好友」关了，别往别人那里发。' }], isError: true };
      }
      const k = String(key || '').trim();
      const owner = String(getConfig().ownerQQ ?? '').trim();
      const allowed = (owner && k === 'private:' + owner) || k.startsWith('owner:') || /bili/i.test(k);
      if (!allowed) return { content: [{ type: 'text', text: '只有主人私聊或她自己的后台会话可以主动分享。' }], isError: true };
      const body = String(text || '').trim().slice(0, 300);
      if (!body) return { content: [{ type: 'text', text: '分享内容不能为空' }], isError: true };
      // 硬上限：主动分享一天最多 3 次，防止她刷屏式转发。
      try {
        const outFile = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh', 'stellar', 'state', 'outbound-messages.jsonl');
        const day = new Date().toISOString().slice(0, 10);
        const todayShares = fs.readFileSync(outFile, 'utf8').split('\n')
          .filter((line) => line.includes('"kind":"share"') && line.includes('"at":"' + day)).length;
        if (todayShares >= 3) return { content: [{ type: 'text', text: '今天已经主动分享 3 次了，够啦，别再发了。' }], isError: true };
      } catch { /* 没有账本就不拦 */ }
      const names = String(people || '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
      if (!names.length) return { content: [{ type: 'text', text: '没写收件人。' }], isError: true };
      if (names.length > 3) return { content: [{ type: 'text', text: '一次最多分享给 3 个人。' }], isError: true };
      const targets = [];
      const missing = [];
      for (const name of names) {
        const hits = findContactMatches(name).filter((p) => String(p.type || '') !== 'owner');
        if (hits.length === 1) targets.push(hits[0]);
        else if (hits.length > 1) return { content: [{ type: 'text', text: '「' + name + '」匹配到多个人（' + hits.map(contactDisplayName).join('、') + '），写 QQ 号更准。' }], isError: true };
        else missing.push(name);
      }
      if (missing.length) return { content: [{ type: 'text', text: '通讯录里没有：' + missing.join('、') + '。先 stellar_contacts 看看有谁。' }], isError: true };
      let imageFile = '';
      if (imagePath) {
        try { imageFile = resolveImagePath(String(imagePath)); }
        catch (error) { return { content: [{ type: 'text', text: '图片没找到：' + (error?.message ?? error) }], isError: true }; }
        const st = fs.statSync(imageFile);
        if (st.size > 5 * 1024 * 1024) return { content: [{ type: 'text', text: '图片超过 5MB，QQ 发不出去。' }], isError: true };
      }
      const list = targets.map((p) => contactDisplayName(p) + '（' + p.uin + '）').join('、');
      if (go !== true) {
        return { content: [{ type: 'text', text: '[演练] 会发给：' + list + (imageFile ? '（带 1 张图）' : '') + '\n内容：' + body.slice(0, 80) + '\n确认没问题再加 go:true 真发。' }] };
      }
      const sent = [];
      const errors = [];
      for (const p of targets) {
        try {
          const message = [{ type: 'text', text: body }];
          if (imageFile) message.push({ type: 'image', data: 'base64://' + fs.readFileSync(imageFile).toString('base64') });
          const data = await onebot('send_private_msg', { user_id: Number(p.uin), message });
          sent.push({ uin: String(p.uin), name: contactDisplayName(p), messageId: data?.message_id ?? null });
        } catch (error) { errors.push(contactDisplayName(p) + '：' + (error?.message ?? error)); }
        await new Promise((r) => setTimeout(r, 600));
      }
      try {
        const file = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh', 'stellar', 'state', 'outbound-messages.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify({ id: 'share-' + Date.now(), at: new Date().toISOString(), kind: 'share', target: sent.map((x) => x.uin).join(','), text: body, image: imageFile || '', source: 'stellar_share' }) + '\n');
      } catch { /* 审计失败不影响发送 */ }
      const lines = ['已分享给 ' + sent.length + ' 人：' + sent.map((x) => x.name).join('、')];
      if (errors.length) lines.push('没发出去：' + errors.join('；'));
      lines.push('不用在聊天里再复述一遍，也别连着分享第二次。');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '分享失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── B站视频分享卡（owner 2026-11-11 22:25 要求 3）──────────────────────────
//
// 主人明确要求：**不是发链接**，而是像 B站 App 那个「分享到 QQ」按钮一样，
// 发一张能点开的小卡片。做法：
//   get_mini_app_ark(type:'bili', title/desc/pic_url/jump_url) → json 段 → send_private_msg
// 配额：每个收件人每天 3 条（tools/lib/bili-share.mjs 落盘计数），管理员不限。
server.tool(
  'stellar_bili_share',
  '把一条 B站视频以「卡片」形式分享给通讯录里的人（不是裸链接）。每个人每天最多收到 3 条（管理员不限），重复分享同一条视频会被拒。用法：先不带 go 调一次看会发给谁、卡片长什么样，确认后 go:true 真发。清醒时可主动分享；主人明确让你找某条视频分享时也用它。',
  {
    key: z.string().describe('当前会话 key（主人私聊 private:<主人QQ>、owner:<QQ> 或 bili 后台会话）'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    bvid: z.string().describe('要分享的 B站视频（BV 号）'),
    people: z.string().optional().describe('收件人：昵称/备注/QQ号，逗号分隔；不传=只发主人'),
    note: z.string().optional().describe('可选：卡片前面垫一句话（最多 80 字，别写成营销文案）'),
    go: z.boolean().optional().describe('true 才真发；不传或 false 只演练')
  },
  async ({ key, token, bvid, people, note, go }) => {
    try {
      if (!capabilityEnabled('shareToFriends')) {
        return { content: [{ type: 'text', text: '控制台把「主动分享给好友」关了，先别发。' }], isError: true };
      }
      const k = String(key || '').trim();
      const ownerQQ = String(getConfig().ownerQQ ?? '').trim();
      const allowed = (ownerQQ && k === 'private:' + ownerQQ) || k.startsWith('owner:') || /bili/i.test(k);
      if (!allowed) return { content: [{ type: 'text', text: '只有主人私聊或她自己的后台会话可以主动分享给别人。' }], isError: true };
      const bv = (String(bvid || '').match(/BV[0-9A-Za-z]{10}/) || [])[0];
      if (!bv) return { content: [{ type: 'text', text: '没认出 BV 号：先 stellar_bili_watch 或 feed 拿到 BV，再来分享。' }], isError: true };
      // 1) 取视频元信息（公开接口，不碰主人账号）
      const viewRes = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bv, {
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(15000)
      });
      const view = await viewRes.json();
      if (!viewRes.ok || view?.code !== 0 || !view?.data) {
        return { content: [{ type: 'text', text: '取视频信息失败：' + (view?.message || ('HTTP ' + viewRes.status)) }], isError: true };
      }
      const meta = view.data;
      const title = String(meta.title || '').slice(0, 60);
      const up = String(meta.owner?.name || '');
      const pic = String(meta.pic || '');
      const jump = 'https://www.bilibili.com/video/' + bv;
      const desc = (up ? up + ' · ' : '') + String(meta.desc || meta.tname || '').replace(/\s+/g, ' ').slice(0, 60);
      // 2) 收件人
      const share = await import(pathToFileURL(path.join(TOOLS_DIR, 'lib', 'bili-share.mjs')).href);
      const names = String(people || '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
      const targets = [];
      const missing = [];
      if (!names.length) {
        if (!ownerQQ) return { content: [{ type: 'text', text: '没配 ownerQQ，不知道该发给谁。' }], isError: true };
        targets.push({ uin: ownerQQ, name: '主人', isOwner: true });
      } else {
        if (names.length > 3) return { content: [{ type: 'text', text: '一次最多分享给 3 个人。' }], isError: true };
        for (const name of names) {
          const hits = findContactMatches(name);
          if (hits.length === 1) {
            const hit = hits[0];
            targets.push({ uin: String(hit.uin), name: contactDisplayName(hit), isOwner: String(hit.type || '') === 'owner' || String(hit.uin) === ownerQQ });
          } else if (hits.length > 1) {
            return { content: [{ type: 'text', text: '「' + name + '」匹配到多个人（' + hits.map(contactDisplayName).join('、') + '），写 QQ 号更准。' }], isError: true };
          } else missing.push(name);
        }
      }
      if (missing.length) return { content: [{ type: 'text', text: '通讯录里没有：' + missing.join('、') + '。先 stellar_contacts 看看有谁。' }], isError: true };
      // 3) 配额（每人每天 3 条；主人不限）+ 同一视频当天不重复
      const store = share.readShareStore();
      const blocked = [];
      const okTargets = [];
      for (const tg of targets) {
        const left = tg.isOwner ? -1 : share.remainingFor(tg.uin);
        if (left === 0) { blocked.push(tg.name + '（今天已经收到 3 条了）'); continue; }
        const dup = (store.items || []).some((it) => String(it.uin) === String(tg.uin) && String(it.bvid) === bv);
        if (dup) { blocked.push(tg.name + '（今天已经发过这条视频）'); continue; }
        okTargets.push({ ...tg, left });
      }
      if (!okTargets.length) {
        return { content: [{ type: 'text', text: '这次没发：' + blocked.join('；') + '。别再换人硬发，明天再说。' }], isError: true };
      }
      const plan = okTargets.map((tg) => tg.name + '（' + tg.uin + '）' + (tg.left < 0 ? ' 管理员不限' : ' 今天还剩 ' + tg.left + ' 条')).join('、');
      if (go !== true) {
        return { content: [{ type: 'text', text: '[演练] 会发这张卡给：' + plan + '\n卡片：' + title + (up ? '（UP：' + up + '）' : '') + '\n跳转：' + jump + (blocked.length ? '\n跳过：' + blocked.join('；') : '') }] };
      }
      // 4) 造卡片（服务端给的 ark 对象，不能自己拼）并发送
      const ark = await onebot('get_mini_app_ark', { type: 'bili', title, desc, pic_url: pic, jump_url: jump });
      const card = ark?.data ?? ark;
      if (!card || typeof card !== 'object') return { content: [{ type: 'text', text: '没拿到卡片数据（B站/OneBot 那边没给），这次没发。' }], isError: true };
      const cardJson = JSON.stringify(card);
      const sent = [];
      const errors = [];
      for (const tg of okTargets) {
        try {
          const message = [];
          const line = String(note || '').trim().slice(0, 80);
          if (line) message.push({ type: 'text', text: line });
          message.push({ type: 'json', data: { data: cardJson } });
          const data = await onebot('send_private_msg', { user_id: Number(tg.uin), message });
          share.recordShare({ uin: tg.uin, bvid: bv, title });
          sent.push({ uin: String(tg.uin), name: tg.name, messageId: data?.message_id ?? null });
        } catch (error) {
          errors.push(tg.name + '：' + (error?.message ?? error));
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      try {
        const file = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh', 'stellar', 'state', 'outbound-messages.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify({ id: 'share-bili-' + Date.now(), at: new Date().toISOString(), kind: 'share', via: 'bili-card', bvid: bv, target: sent.map((x) => x.uin) }) + '\n', 'utf8');
      } catch { /* 审计失败不影响发送 */ }
      const lines = ['已把「' + title + '」分享给 ' + sent.length + ' 人：' + sent.map((x) => x.name).join('、')];
      if (blocked.length) lines.push('跳过：' + blocked.join('；'));
      if (errors.length) lines.push('没发出去：' + errors.join('；'));
      lines.push('不用在聊天里再复述一遍这张卡，也别连着分享第二条。');
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '分享视频失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_memory_read',
  '按 id 读一条长期记忆的原文（只给主人用，key 必须是 private:<主人QQ>）。记忆注入里只给摘要和 id（mem_xxx），忘了细节就用这个查；也可以给 query 按关键词搜最近几条。查不到就直说没记住，别编。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    id: z.string().optional().describe('记忆 id，形如 mem_xxxxxxxx'),
    query: z.string().optional().describe('没记住 id 时按关键词搜（最多 5 条）'),
    chars: z.number().optional().describe('原文最多返回多少字（默认 2000，上限 4000）'),
    limit: z.number().optional().describe('搜索时返回几条（默认 5，上限 10）')
  },
  async ({ key, token, id, query, chars, limit }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const wantId = String(id ?? '').trim();
      const wantQuery = String(query ?? '').trim();
      if (!wantId && !wantQuery) {
        return { content: [{ type: 'text', text: '要给 id（mem_xxx）或 query 关键词' }], isError: true };
      }
      if (wantId) {
        const hit = await readMemoryById(wantId, chars);
        if (!hit) return { content: [{ type: 'text', text: '没找到 id=' + wantId + ' 的记忆（可能已被遗忘/压缩）。可以改用 query 搜关键词。' }], isError: true };
        return { content: [{ type: 'text', text: hit }] };
      }
      const hits = await searchMemory(wantQuery, chars, limit);
      if (!hits.length) return { content: [{ type: 'text', text: '没搜到含「' + wantQuery + '」的记忆。' }], isError: true };
      return { content: [{ type: 'text', text: '搜到 ' + hits.length + ' 条（新→旧）：\n\n' + hits.join('\n\n---\n\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '查记忆失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 新记忆库（memory-db）：目录 / 读话题 / 搜关键词 ─────────────────────────
//
// 为什么要三个工具：唤醒提示词只注入「标题目录」（省 token），正文一律靠按需查。
// 查询入口不能靠重读旧档案（memory-card-full.jsonl 171 MB，翻一次就是几十兆 IO），
// 新库是 SQLite + FTS5，按 id 取一条话题是毫秒级。
//
// 为什么动态 import：memory-db.js 顶层就 import 'node:sqlite'，静态引进来会让
// scripts/test-audit*.mjs 的 vm 沙箱从「缺 normalizeHybridConfig」变成「缺 DatabaseSync」。
// 这里只在第一次真的调用该工具时加载，加载失败给出可行动的报错（不让它变成一句"查记忆失败"）。
let memoryDbModPromise = null;
function memoryDbModule() {
  if (!memoryDbModPromise) {
    const file = path.join(__dirname, 'memory-db.js');
    memoryDbModPromise = import(pathToFileURL(file).href).catch((error) => {
      memoryDbModPromise = null;
      throw error;
    });
  }
  return memoryDbModPromise;
}

// owner 标签：默认「这个会话的对方」；只接受 数字QQ / group:<号> / owner:xxx 三种形态，
// 不让模型自由拼字符串去翻别人的记忆。
function memoryOwnerOrDefault(key, ownerId) {
  const want = String(ownerId ?? '').trim();
  if (want) {
    if (/^\d{4,12}$/.test(want) || /^group:\d{4,12}$/.test(want) || /^owner:[A-Za-z0-9_-]{1,40}$/.test(want)) return want;
    return '';
  }
  const k = String(key ?? '').trim();
  if (k.startsWith('private:')) return k.slice(8);
  if (k.startsWith('group:')) return k;
  if (k.startsWith('owner:')) return k;
  return '';
}

// ── 记忆的身份口径（2026-11-13 放宽）────────────────────────────────────────
//
// 旧口径是所有记忆工具一律 ownerOnlyError（只有主人能查）。问题是主人举的那个场景——
// 「A 问『你知道我的生日吗』」——A 根本不是主人：一律拒绝的话她只能回「不记得」，
// 而事实其实就躺在库里。新口径是**问谁就查谁**：
//   · 令牌认得的会话只能查自己（private:<自己> / group:<群>），不能查别人；
//   · 跨人查（含主人查别人）仍然是主人专属；
//   · 写别人的记忆也仍然只有主人能做（事实自动抽取走 memory-worker，不经过这里）。
function memoryOwnerOfKey(key) {
  const k = String(key ?? '').trim();
  if (k.startsWith('private:')) return k.slice(8);
  if (k.startsWith('group:')) return k;
  return '';
}

async function memoryActorInfo(key, token) {
  const tk = String(token ?? '').trim();
  const ident = tk ? await resolveAgentIdentity(tk) : null;
  const actorKey = String(ident?.key || key || '').trim();
  const isOwner = ident ? Boolean(ident.isOwner) : Boolean(await isOwnerRequest(key, ''));
  return { token: tk, ident, actorKey, ownerId: memoryOwnerOfKey(actorKey), isOwner };
}

/**
 * 记忆读闸：回 { ok, owner, audience, actor } 或 { ok:false, text }。
 * audience 决定事实的三级隐私怎么裁：owner=跟本人说话（全给）、other=主人在问别人（只给 normal）。
 */
async function memoryAccess(key, token, wantOwner) {
  const actor = await memoryActorInfo(key, token);
  if (actor.isOwner) {
    const owner = memoryOwnerOrDefault(actor.actorKey || key, wantOwner);
    if (!owner) return { ok: false, text: 'ownerId 格式不对（要数字QQ、group:<群号> 或 owner:xxx）' };
    return { ok: true, actor, owner, audience: actor.ownerId === owner ? 'owner' : 'other' };
  }
  const denied = await ownerOnlyError(key, token);
  const claimed = memoryOwnerOfKey(key);
  // 没有任何可信身份（没令牌、又不是主人）：只能按 key 猜 —— 这正是 P0 那个伪造口子，
  // 所以必须让 ownerOnlyError 说了算。只在它放行（closed-agent 旧模式的只读场景）时才继续。
  if (!actor.ident) return { ok: false, text: denied || '只有主人可以用这个记忆工具。' };
  if (!actor.ownerId) return { ok: false, text: '这个令牌没绑定到具体的人，查不了记忆。' };
  // key 与令牌对不上 = 想借令牌冒充别人（confused deputy），直接拒。
  if (claimed && claimed !== actor.ownerId) {
    return { ok: false, text: '只有主人可以查别人的记忆；这次没有执行。你自己的（' + actor.ownerId + '）可以查。' };
  }
  const owner = wantOwner ? memoryOwnerOrDefault(key, wantOwner) : actor.ownerId;
  if (!owner || owner !== actor.ownerId) {
    return { ok: false, text: '只有主人可以查别人的记忆；这次没有执行。你自己的（' + actor.ownerId + '）可以查。' };
  }
  return { ok: true, actor, owner, audience: 'owner' };
}

server.tool(
  'stellar_memory_catalog',
  '看记忆库的完整目录：某人名下的话题标题（重要优先、再按最近）+ 零碎记忆条数 + 一行侧写。唤醒提示里只给最近 8 条标题，这里可以看更多；正文要用 stellar_memory_topic 读。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    ownerId: z.string().optional().describe('看谁的目录：数字QQ / group:<群号>；不填就是当前会话的对方'),
    limit: z.number().optional().describe('返回几条标题（默认 20，上限 50）')
  },
  async ({ key, token, ownerId, limit }) => {
    try {
      const access = await memoryAccess(key, token, ownerId);
      if (!access.ok) return { content: [{ type: 'text', text: access.text }], isError: true };
      const owner = access.owner;
      const mod = await memoryDbModule();
      const data = mod.catalog({ ownerId: owner, limit: Math.max(1, Math.min(50, Number(limit) || 20)) });
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length && !data.fragments && !data.persona) {
        return { content: [{ type: 'text', text: '记忆库里还没有 ' + owner + ' 的话题（启用后才会开始记）。' }] };
      }
      const roster = Array.isArray(data.roster) ? data.roster : [];
      const lines = [];
      if (data.persona) lines.push('侧写：' + data.persona);
      if (roster.length) {
        // 群里的名册：名字后面必须带 QQ —— 同名的人在这类群里太常见了。
        lines.push('［群里的人］' + roster.map((p) => {
          const nm = String(p.name || '').trim();
          const qq = String(p.qq || '');
          const label = nm && !nm.includes(qq) ? nm + '(' + qq + ')' : (nm || 'QQ' + qq);
          return p.role === 'self' ? label + '·她' : label;
        }).join('、'));
      }
      lines.push('对象：' + owner + '｜话题 ' + rows.length + ' 条｜零碎记忆 ' + (Number(data.fragments) || 0) + ' 条');
      for (const row of rows) {
        const when = String(row.day_key || '').slice(5);
        const people = Array.isArray(row.participants) && row.participants.length
          ? '  — ' + row.participants.slice(0, 6).map((p) => {
            const nm = String(p.name || '').trim();
            const qq = String(p.qq || '');
            const label = nm && !nm.includes(qq) ? nm + '(' + qq + ')' : (nm || 'QQ' + qq);
            return p.role === 'self' ? '她' : label;
          }).join('、')
          : '';
        const ambient = String(row.scope || '') === 'ambient' ? '  [旁观]' : '';
        lines.push('· ' + row.id + '  ' + row.title + '  (' + when + ')' + (row.tier === 'important' ? '  [重要]' : '') + people + ambient);
      }
      lines.push('要细节用 stellar_memory_topic(topicId=…)；搜关键词用 stellar_memory_search(q=…)。');
      if (roster.length) {
        lines.push('问某人说过什么时：先 stellar_memory_search(about=那个人的QQ)，它会把「跟这个人的私聊」和「这个人在群里参与过的话题」一起搜出来；还没有才翻零碎。');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '读记忆目录失败：' + (error?.message ?? error) + '。（若是 node:sqlite 加载失败，说明当前 Node 版本太老）' }], isError: true };
    }
  }
);

server.tool(
  'stellar_memory_topic',
  '按 id 读一个记忆话题的原文：先给标题/时间/重要度/标签 + 对话条数，full=true 或条数不多时给完整对话（她说的和对方说的都在）。话题全文存在库里，两天前的也能读。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    topicId: z.string().describe('话题 id，形如 tp_20261113_0007'),
    full: z.boolean().optional().describe('true = 一定要完整对话；不填时超过 20 条只给摘要'),
    chars: z.number().optional().describe('最多返回多少字（默认 2000，上限 4000）')
  },
  async ({ key, token, topicId, full, chars }) => {
    try {
      const access = await memoryAccess(key, token, '');
      if (!access.ok) return { content: [{ type: 'text', text: access.text }], isError: true };
      const wantId = String(topicId ?? '').trim();
      if (!wantId) return { content: [{ type: 'text', text: '要给 topicId（形如 tp_20261113_0007），可以先调 stellar_memory_catalog 看目录' }], isError: true };
      const keep = Math.min(4000, Math.max(200, Number(chars) || 2000));
      const mod = await memoryDbModule();
      const data = mod.readTopic(wantId, { full: full === true, maxChars: keep });
      // 话题归属必须核对：否则非主人拿到 id 就能读别人的整段对话（id 是顺序号，很好猜）。
      const topicOwner = String(data?.topic?.owner_id ?? '');
      // 群会话的 access.owner 就是 group:<群号>，本群话题（含她旁观到的）都允许读；
      // 但读到别人私聊的话题仍然拒 —— 群号与私聊号不会相等。
      if (topicOwner && topicOwner !== access.owner && !access.actor.isOwner) {
        return { content: [{ type: 'text', text: '这个 id 不是你的记忆（id 形如 tp_… 是顺序号，猜不到别人的）。可以先用 stellar_memory_catalog 看你自己的目录。' }], isError: true };
      }
      if (!data) {
        return { content: [{ type: 'text', text: '记忆库里没有 id=' + wantId + ' 这个话题（可能还在缓存没切分，或 id 拼错了）。可以先用 stellar_memory_search 搜关键词。' }], isError: true };
      }
      return { content: [{ type: 'text', text: mod.formatTopicForModel(data, { maxChars: keep }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '读话题失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_memory_search',
  '在记忆库里搜关键词：命中话题标题/摘要、零碎记忆、侧写，按时间从新到旧。3 字以上走全文索引，2 字走模糊匹配。搜不到就是不记得，别编。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    q: z.string().describe('关键词（尽量给具体名词，如「绝区零」「抽卡」「生日」）'),
    ownerId: z.string().optional().describe('只在这个对象名下搜：数字QQ / group:<群号>；不填就是当前会话的对方'),
    scope: z.string().optional().describe('current=只搜当前对象（默认）；all=跨所有对象搜（结果会标归属）'),
    about: z.string().optional().describe('按人搜：给这个人的 QQ，会同时搜「他跟我的私聊话题」和「他在群里参与过的话题」。群里被问「你记得我昨天说的吗」就用它'),
    limit: z.number().optional().describe('返回几条（默认 5，上限 10）')
  },
  async ({ key, token, q, ownerId, scope, about, limit }) => {
    try {
      const query = String(q ?? '').trim();
      if (query.length < 2) return { content: [{ type: 'text', text: '关键词至少 2 个字' }], isError: true };
      const wantAll = String(scope ?? '').trim() === 'all';
      const access = await memoryAccess(key, token, ownerId);
      // 跨人搜只有主人能做：非主人 scope=all 会把别人说过的话一起端出来。
      if (!access.ok) return { content: [{ type: 'text', text: access.text }], isError: true };
      if (wantAll && !access.actor.isOwner) {
        return { content: [{ type: 'text', text: '只有主人可以跨对象搜记忆。你可以搜自己的（不加 scope）。' }], isError: true };
      }
      // about 是「按人查」的口子：非主人只能查自己，否则随便填一个 QQ 就能读到别人的私聊话题。
      const aboutWho = String(about ?? '').trim();
      if (aboutWho && !access.actor.isOwner && aboutWho !== access.actor.ownerId) {
        return { content: [{ type: 'text', text: '只有主人可以按别人的号查记忆。要查就说你自己的号。' }], isError: true };
      }
      const owner = wantAll ? '' : access.owner;
      const mod = await memoryDbModule();
      const rows = mod.search({
        q: query,
        ownerId: owner,
        scope: String(scope ?? '').trim() === 'all' ? 'all' : 'current',
        about: aboutWho,
        limit: Math.max(1, Math.min(10, Number(limit) || 5)),
      });
      // 参与人里要标出「她」和「主人」：群里同名的人多，只给名字分不清谁是谁。
      const text = mod.formatSearchForModel(rows, {
        currentOwner: owner,
        ownerQQ: String(getConfig().ownerQQ ?? ''),
        // 她自己那一行靠 role='self' 标「她」，不用知道自己的号（MCP 侧拿不到）。
        selfId: '',
      });
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '搜记忆失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_memory_fact',
  '重要事实（生日/纪念日/忌口/过敏/联系方式/约定这类，只给主人写）：不按话题分类，按人对号存，唤醒时自动注入。'
  + 'action=list 看某人的事实（默认当前对话对象）；search 按关键词搜；'
  + 'write 新增或覆盖一条（同一个人 + 同一个 label 会覆盖，权重取更高）；update 改一条；delete 删一条。'
  + 'privacy：normal=群里也能用 / private=只在跟本人说话时提 / secret=只本人私聊与面板。',
  {
    key: z.string().describe('当前会话 key，形如 private:<QQ> 或 group:<群号>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    action: z.string().describe('list / search / write / update / delete'),
    ownerId: z.string().optional().describe('谁的事实：数字QQ / group:<群号>；不填就是当前会话的对方'),
    kind: z.string().optional().describe('write：birthday/anniversary/like/dislike/allergy/contact/address/nickname/promise/identity/note'),
    label: z.string().optional().describe('write：这一条的标题，如「生日」「不吃」「手机号」（同人同 label 覆盖）'),
    text: z.string().optional().describe('write/update：内容，如「6月29日」「香菜」'),
    privacy: z.string().optional().describe('normal / private / secret（默认按 kind 给：生日 contact 地址偏私密）'),
    weight: z.number().optional().describe('1~5，越大越优先注入（生日/过敏 5，喜好 3）'),
    id: z.number().optional().describe('update/delete：事实 #id（list 里有）'),
    q: z.string().optional().describe('search：关键词'),
    limit: z.number().optional().describe('list/search 返回几条（默认 20，上限 50）')
  },
  async ({ key, token, action, ownerId, kind, label, text, privacy, weight, id, q, limit }) => {
    try {
      const act = String(action ?? 'list').trim().toLowerCase();
      const mod = await memoryDbModule();
      const keep = Math.max(1, Math.min(50, Number(limit) || 20));
      // 读：问谁查谁（非主人只能查自己）；写：只给主人。
      if (act === 'list' || act === 'search') {
        const access = await memoryAccess(key, token, ownerId);
        if (!access.ok) return { content: [{ type: 'text', text: access.text }], isError: true };
        const rows = act === 'search'
          ? (String(q ?? '').trim()
            ? mod.searchFacts({ q: String(q).trim(), ownerId: access.owner, limit: keep })
            : [])
          : mod.listFacts({ ownerId: access.owner, limit: keep });
        if (act === 'search' && !String(q ?? '').trim()) {
          return { content: [{ type: 'text', text: 'action=search 要给 q（关键词）' }], isError: true };
        }
        // 隐私裁剪：只有「正在跟事实本人说话」才给 private/secret；主人在问别人只给 normal。
        const allow = access.audience === 'owner' ? ['normal', 'private', 'secret'] : ['normal'];
        const shown = (rows || []).filter((r) => allow.includes(r.privacy));
        const hidden = (rows || []).length - shown.length;
        if (!shown.length) {
          const tail = hidden > 0 ? '（另有 ' + hidden + ' 条是隐私级的，只有本人能听；要看细节去面板「记忆」。）' : '';
          return { content: [{ type: 'text', text: '这边没有 ' + access.owner + ' 的重要事实。' + tail }] };
        }
        const lines = shown.map((r) => mod.formatFactLine(r));
        const tail = hidden > 0 ? '另有 ' + hidden + ' 条隐私级事实（只有本人能听）。' : '';
        return { content: [{ type: 'text', text: '对象：' + access.owner + '（' + shown.length + ' 条重要事实）' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + (tail ? String.fromCharCode(10) + tail : '') }] };
      }
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      if (act === 'write') {
        const owner = memoryOwnerOrDefault(key, ownerId);
        if (!owner) return { content: [{ type: 'text', text: 'ownerId 格式不对（要数字QQ、group:<群号> 或 owner:xxx）' }], isError: true };
        if (!String(text ?? '').trim()) return { content: [{ type: 'text', text: 'write 要给 text（内容）' }], isError: true };
        const res = mod.upsertFact({
          ownerId: owner,
          kind: kind || 'note',
          label: label || '',
          text,
          privacy: privacy || '',
          weight: Number(weight) || undefined,
          source: 'manual',
        });
        if (!res?.ok) return { content: [{ type: 'text', text: '没写成：' + (res?.reason || '未知原因') }], isError: true };
        const row = mod.getFact(res.id);
        return { content: [{ type: 'text', text: (res.created ? '已记下' : '已更新（原来那条被覆盖，权重取更高）') + '：' + mod.formatFactLine(row) }] };
      }
      if (act === 'update' || act === 'delete') {
        const fid = Number(id) || 0;
        if (!fid) return { content: [{ type: 'text', text: '要给 id（list 里的 #编号）' }], isError: true };
        const before = mod.getFact(fid);
        if (!before) return { content: [{ type: 'text', text: '没有 #' + fid + ' 这条事实。可以先 action=list 看看。' }], isError: true };
        if (act === 'delete') {
          mod.deleteFact(fid);
          return { content: [{ type: 'text', text: '已删除：' + mod.formatFactLine(before) }] };
        }
        const res = mod.updateFact(fid, { kind, label, text, privacy, weight });
        if (!res?.ok) {
          const why = res?.reason === 'duplicate' ? '（跟上一条撞了：同一个人 + 同一个 label 只能有一条，# ' + res.existsId + ' 已经占了）' : (res?.reason || '未知原因');
          return { content: [{ type: 'text', text: '没改成：' + why }], isError: true };
        }
        return { content: [{ type: 'text', text: '已改好：' + mod.formatFactLine(mod.getFact(fid)) }] };
      }
      return { content: [{ type: 'text', text: 'action 只能是 list / search / write / update / delete' }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: '重要事实操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 见闻区：B站 / 好友爱看 ───────────────────────────────────────────────────
//
// 主人 2026-11-13 的要求：B站 与 QQ好友爱看 各开一个记忆区，不按话题分类，
// 让她自己看完后写一条精简总结；被问「你今天在b站看了什么视频」时优先从 B站区搜。
//
// 为什么做成一个工具而不是两个：两个区的读写逻辑完全一样，只是 zone 不同；
// 拆成两个工具会让 schema 多一份、她多一次选择成本，也会让「先看看今天看了啥」
// 变成两次调用（多花一次上下文）。
function memoryZoneDay(want, dayKeyFn) {
  const v = String(want ?? '').trim();
  if (!v) return '';
  const key = typeof dayKeyFn === 'function' ? dayKeyFn : null;
  if (v === 'today') return key ? key(Date.now()) : '';
  if (v === 'yesterday') return key ? key(Date.now() - 86400000) : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return '';
}

server.tool(
  'stellar_memory_zone',
  'B站 / 好友爱看 两个见闻记忆区（只给主人用）：不按话题分类，写的是她看完之后自己精简的总结。'
  + 'action=write 写一条（zone=bili|qzone，text 是总结，items 可放 BV 号/短 id）；'
  + 'action=list 看最近/某天看了什么（被问「今天b站看了什么」先用它，zone=bili 优先）；'
  + 'action=search 在某个区内搜关键词；action=delete / clear 删一条或清空一个区。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    action: z.string().describe('write / list / search / delete / clear'),
    zone: z.string().describe('bili = B站看的视频；qzone = QQ好友爱看刷到的动态'),
    text: z.string().optional().describe('action=write：精简总结（建议 ≤200 字，最多 400；写「看了什么 + 一句话感受」，不要抄标题列表）'),
    items: z.array(z.string()).optional().describe('action=write：可选，附带的 BV 号 / 短 id（最多 20 个）'),
    day: z.string().optional().describe('today / yesterday / YYYY-MM-DD；不填 = 最近（list/search 时可选）'),
    q: z.string().optional().describe('action=search：关键词'),
    id: z.number().optional().describe('action=delete：要删的那条 #id（list 里有）'),
    limit: z.number().optional().describe('list/search 返回几条（默认 10，上限 30）')
  },
  async ({ key, token, action, zone, text, items, day, q, id, limit }) => {
    try {
      // 这里比其他 memory 工具多一档放行：B站 后台会话（bili-whale）没有 QQ 会话 key，
      // 它手里只有插件申请的 operator 令牌。没有这一档，B站 那一趟看完就写不进见闻区，
      // 而「今天在b站看了什么」正是她最常被问的问题。
      const denied = await ownerOnlyError(key, token);
      if (denied) {
        const ident = token ? await resolveAgentIdentity(token) : null;
        if (!(ident && ident.kind === 'internal' && ident.isOwner)) {
          return { content: [{ type: 'text', text: denied }], isError: true };
        }
      }
      const mod = await memoryDbModule();
      const wantZone = mod.normalizeZone(zone);
      if (!wantZone) return { content: [{ type: 'text', text: 'zone 只能是 bili（B站）或 qzone（好友爱看）' }], isError: true };
      const label = mod.ZONE_LABELS[wantZone] || wantZone;
      const wantAction = String(action ?? '').trim() || 'list';
      const wantDay = memoryZoneDay(day, mod.dayKey);
      if (String(day ?? '').trim() && !wantDay) {
        return { content: [{ type: 'text', text: 'day 只认 today / yesterday / YYYY-MM-DD' }], isError: true };
      }
      const n = Math.max(1, Math.min(30, Number(limit) || 10));
      if (wantAction === 'write') {
        const body = String(text ?? '').trim();
        if (body.length < 6) return { content: [{ type: 'text', text: '总结太短了（至少 6 个字）：写清看了什么 + 一句感受，别只写「看了几个视频」' }], isError: true };
        const row = mod.insertZoneNote({
          zone: wantZone,
          text: body,
          items: Array.isArray(items) ? items : [],
          day: wantDay,
          source: 'tool',
        });
        if (!row.ok) return { content: [{ type: 'text', text: '没写进去：' + (row.reason === 'empty' ? '正文是空的' : String(row.reason)) }], isError: true };
        const stats = mod.zoneStats();
        const info = stats[wantZone] || {};
        return { content: [{ type: 'text', text: '记进「' + label + '」区了（#' + row.id + (row.duplicated ? '，和今天那条一样，已合并' : '') + '）。这个区现在 ' + (Number(info.total) || 0) + ' 条，今天 ' + (Number(info.today) || 0) + ' 条。' }] };
      }
      if (wantAction === 'list' || wantAction === 'search') {
        const query = String(q ?? '').trim();
        const rows = query
          ? mod.searchZoneNotes({ zone: wantZone, q: query, day: wantDay, limit: n })
          : mod.listZoneNotes({ zone: wantZone, day: wantDay, limit: n });
        return { content: [{ type: 'text', text: mod.formatZoneNotesForModel(rows, { zone: wantZone, day: wantDay }) }] };
      }
      if (wantAction === 'delete') {
        const target = Number(id);
        if (!Number.isFinite(target) || target <= 0) return { content: [{ type: 'text', text: '要删哪一条？先 list 看 #id，再把 id 传进来' }], isError: true };
        const out = mod.deleteZoneNote(target);
        return { content: [{ type: 'text', text: out.deleted ? '已忘掉 #' + target + '（控制台「见闻」里会留一条删除记录）。' : '没有 #' + target + ' 这一条。' }] };
      }
      if (wantAction === 'clear') {
        const out = mod.clearZoneNotes({ zone: wantZone, day: wantDay });
        return { content: [{ type: 'text', text: '「' + label + '」区' + (wantDay ? ' ' + wantDay : '') + ' 清掉了 ' + out.deleted + ' 条。' }] };
      }
      return { content: [{ type: 'text', text: 'action 只能是 write / list / search / delete / clear' }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: '见闻区操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 主人专用窄工具：看空间 / 点赞 / 评论 ─────────────────────────────────────
//
// 与 stellar_qzone_post 同一套路：解释器与脚本路径写死，模型只能传文本/id/数字，
// 只认 private:<ownerQQ>。点赞、取消赞是可撤销的低风险动作 ⇒ 直接执行；
// 评论会出现在别人眼前 ⇒ 默认只演练（--dry），要 go=true 才真正发出去。
let cachedSelfQQ = 0;
async function selfQQ() {
  if (cachedSelfQQ) return cachedSelfQQ;
  try {
    const login = await onebot('get_login_info');
    cachedSelfQQ = Number(login?.user_id ?? 0) || 0;
  } catch { /* SnowLuma 没起来时留空，稍后再试 */ }
  return cachedSelfQQ;
}

// 2026-11-11：原来只有「主人 + 她自己」两个号，导致她没法去通讯录成员（比如测试员A）
// 的空间点赞/评论 —— 主人明确要求「能主动去看通讯录成员的动态并评论回复点赞」。
// 现在放开到通讯录里所有登记过的人（含 stranger，测试号就是 stranger）；
// 白名单只是防手滑写到陌生人身上，真正的护栏还是 approvalGate 与每日上限。
async function qzoneAllowedUins() {
  const set = new Set();
  const owner = Number(getConfig().ownerQQ ?? 0);
  if (owner) set.add(owner);
  const self = await selfQQ();
  if (self) set.add(self);
  try {
    const book = readContactsState();
    for (const p of Array.isArray(book?.people) ? book.people : []) {
      const n = Number(p?.uin ?? 0);
      if (n > 0) set.add(n);
    }
  } catch { /* 通讯录读不到就只认主人和自己 */ }
  return set;
}

// 空间图片：qzone 脚本把图下载到临时目录并输出 JSON，这里读回来当 image 块附加，
// 否则模型只看到「🖼 N 张图片」的标签 —— 她说「看不见动态里的图」就是这个原因。
async function qzoneScriptJson(scriptArgs) {
  const { code, text } = await runLocalScript(scriptArgs, { timeoutMs: 150000 });
  if (code !== 0) return null;
  const line = String(text).split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function sniffMimeType(buf, file) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

function mediaImageBlock(file) {
  try {
    const buf = fs.readFileSync(file);
    if (!buf.length || buf.length > 4.5 * 1024 * 1024) return null;
    // 按真实字节判断格式：空间评论图是 AVIF，脚本已经转成 JPEG，这里仍以防万一。
    if (buf.slice(4, 8).toString() === 'ftyp' && ['avif', 'avis', 'heic', 'heix', 'mif1'].includes(buf.slice(8, 12).toString())) return null;
    return { type: 'image', data: buf.toString('base64'), mimeType: sniffMimeType(buf, file) };
  } catch {
    return null;
  }
}

// 空间图片：正文图走 qzone media，评论区里的图走 qzone comment-media
// （get_qzone_msg_detail 会丢掉评论里的 media_items，只有 feed_detail 带）。
async function qzoneImageBlocks(scope, num, max = 3, tid = '', uin = '') {
  try {
    const blocks = [];
    let skipped = 0;
    let budget = Math.max(1, Number(max) || 3);
    const onlyTid = String(tid ?? '').trim();
    const scriptArgs = ['qzone', 'media'];
    const wantUin = String(uin ?? '').trim();
    if (onlyTid) scriptArgs.push('--tid', onlyTid);
    else scriptArgs.push('--scope', scope);
    // 按人读（通讯录里的某位）：带上 uin，带 tid 时也带 —— 成员的说说未必在 friends 流第一页
    if (wantUin) scriptArgs.push('--uin', String(Number(wantUin)));
    if (num != null && String(num).trim() !== '') scriptArgs.push('--num', String(Number(num)));
    const data = await qzoneScriptJson(scriptArgs);
    for (const item of data?.items ?? []) {
      if (budget <= 0) break;
      const pics = item.images ?? [];
      if (!pics.length) continue;
      blocks.push({ type: 'text', text: `【${item.nickname || item.uin} 的说说 ${item.tid}】${item.content || ''}（下面 ${Math.min(pics.length, budget)} 张图）` });
      for (const pic of pics) {
        if (budget <= 0) { skipped += 1; continue; }
        const blk = mediaImageBlock(pic.file);
        if (!blk) continue;
        blocks.push(blk);
        budget -= 1;
      }
    }
    if (onlyTid && budget > 0) {
      const cm = await qzoneScriptJson(['qzone', 'comment-media', '--tid', onlyTid]);
      for (const item of cm?.comments ?? []) {
        if (budget <= 0) break;
        const pics = item.images ?? [];
        if (!pics.length) continue;
        blocks.push({ type: 'text', text: `【评论区 · ${item.nickname || item.uin} 的评论（#${item.id || '?'}）】${item.content || ''}` });
        for (const pic of pics) {
          if (budget <= 0) { skipped += 1; continue; }
          const blk = mediaImageBlock(pic.file);
          if (!blk) continue;
          blocks.push(blk);
          budget -= 1;
        }
      }
    }
    if (skipped > 0) {
      blocks.push({ type: 'text', text: `（还有 ${skipped} 张没附上：一次最多附 ${Math.max(1, Number(max) || 3)} 张，看太多图很费钱。想细看哪条就带 tid 再读，或只问某一张。）` });
    }
    return blocks;
  } catch {
    return [];
  }
}

// 公开动态（好友爱看/推荐流）：脚本输出单行 JSON，这里取最后一行解析。
// 列表接口一页 10 条里夹着聚合卡片/广告，脚本已经过滤过，只剩有正文的真动态。
function qzoneJsonFrom(text) {
  const line = String(text).split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

async function qzonePublicList(count, images = 1) {
  // count 传 0 = 不指定 --n，让 CLI 用主人配的 qzone.public.seenTarget（控制台里能改）。
  const args = count > 0 ? ['qzone', 'public', 'list', '--n', String(count), '--json'] : ['qzone', 'public', 'list', '--json'];
  if (images > 0) args.push('--images', String(images));
  const { code, text } = await runLocalScript(args, { timeoutMs: 180000 });
  if (code !== 0) return { error: String(text || '（脚本无输出）') };
  const data = qzoneJsonFrom(text);
  return data ? { data } : { error: String(text || '（没拿到公开动态）') };
}

async function qzonePublicMedia(id) {
  const { code, text } = await runLocalScript(['qzone', 'public', 'media', '--id', String(id)], { timeoutMs: 180000 });
  if (code !== 0) return { error: String(text || '（脚本无输出）') };
  const data = qzoneJsonFrom(text);
  return data ? { data } : { error: String(text || '（没拿到图片）') };
}

server.tool(
  'stellar_qzone_read',
  '读 QQ 空间（只给主人用，key 必须是 private:<主人QQ>）。scope=owner 读主人最近的说说（默认）、mine 读自己的、friends 读好友动态流（她和主人都在里面）。给了 tid 就读那条说说的全部评论与楼中楼回复；这条说说正文里的图、以及**评论区里别人（含主人）发的图**都会把原图附在结果里（文字里的 🖼 只是标签）—— 回复别人之前先用它拿到评论 id 和对方 QQ。主人说"看看我发的说说""有人在我评论里发了图"、有人评论了她、要决定点赞/回复哪条时用它。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    scope: z.enum(['owner', 'mine', 'friends', 'person', 'public']).optional().describe('读哪个流：owner=主人（默认）、mine=自己、friends=好友动态（含主人与自己）、person=通讯录里某个人（要同时给 uin）、public=好友爱看/推荐流（陌生人的公开动态）'),
    tid: z.string().optional().describe('某条说说 id；给了就读这条的评论详情。scope=public 时可以给公开动态的短 id（列表里 [xxxx] 那串，前 8 位就够）来只取这条的图'),
    uin: z.string().optional().describe('这条说说属于谁：读主人空间要传主人 QQ；scope=person 时必传（通讯录里那个人的 QQ，比如测试员A 1000000003）'),
    num: z.union([z.number(), z.string()]).optional().describe('条数：列表默认 10，详情默认 20'),
    attachImages: z.boolean().optional().describe('默认 true：把这一页里带图的说说图片直接附在结果里（最多 3~4 张，每张都算 token）。只想读文字、或图太多时传 false，会说还有几张没附')
  },
  async ({ key, token, scope, tid, uin, num, attachImages }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const wantTid = String(tid ?? '').trim();
      const hasNum = num != null && String(num).trim() !== '';
      const scopeUsed = String(scope ?? 'owner').trim() || 'owner';

      // ── 好友爱看 / 推荐流：陌生人的公开动态（脚本 public 子命令）──────────────
      // 这条路径不碰 tid/uin：公开动态不是「说说」，没有 tid 概念，写操作也把
      // 整条 feed 原样回传（脚本缓存里取），所以这里只做「看」和「附图」。
      if (scopeUsed === 'public') {
        const blocks = [];
        const wantImages = attachImages === false ? 0 : 1;
        if (wantTid) {
          const only = await qzonePublicMedia(wantTid);
          if (only.error) return { content: [{ type: 'text', text: '取公开动态的图失败：' + clip(only.error, 1500) }], isError: true };
          blocks.push({ type: 'text', text: '公开动态 ' + String(only.data?.id ?? wantTid) + ' 的图片（原图，直接看）：' });
          let n = 0;
          for (const f of only.data?.images ?? []) {
            if (n >= 4) break;
            const blk = mediaImageBlock(f);
            if (!blk) continue;
            blocks.push(blk);
            n += 1;
          }
          if (!n) blocks.push({ type: 'text', text: '（这条没有图，或者图片没取下来）' });
          return { content: blocks };
        }
        const count = hasNum ? Math.max(1, Math.min(30, Number(num) || 10)) : 0;
        const got = await qzonePublicList(count, wantImages);
        if (got.error) return { content: [{ type: 'text', text: '读公开动态失败：' + clip(got.error, 1500) }], isError: true };
        const rows = got.data?.feeds ?? [];
        if (!rows.length) return { content: [{ type: 'text', text: '（这次没刷到有正文的公开动态；一页里常夹着聚合卡片和广告，过一会儿再刷）' }] };
        const fmtTime = (t) => {
          const n = Number(t) || 0;
          if (!n) return '';
          try { return new Date(n * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
        };
        const lines = rows.map((r, idx) => {
          const head = '#' + (idx + 1) + ' [' + r.short + '] ' + (r.nick || '?') + ' ' + fmtTime(r.time) + '  赞' + (r.likes ?? 0) + (r.liked ? '(已赞)' : '') + ' 评' + (r.comments ?? 0) + ' 图' + (r.pictures ?? 0);
          const body = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
          return head + '\n  ' + body;
        });
        blocks.push({ type: 'text', text: '好友爱看 / 推荐流（公开动态，本页 ' + rows.length + ' 条）：\n\n' + lines.join('\n\n') });
        if (wantImages > 0) {
          let budget = 4;
          for (const r of rows) {
            if (budget <= 0) break;
            const pics = Array.isArray(r.images) ? r.images : [];
            if (!pics.length) continue;
            blocks.push({ type: 'text', text: '【' + r.short + '｜' + (r.nick || '?') + '】的前几张图：' });
            for (const p of pics) {
              if (budget <= 0) break;
              const blk = mediaImageBlock(p);
              if (!blk) continue;
              blocks.push(blk);
              budget -= 1;
            }
          }
          if (budget <= 0) blocks.push({ type: 'text', text: '（图太多，只附了前面几张；想细看某条就传 tid=<那串短 id> 单独取图）' });
        }
        blocks.push({ type: 'text', text: '想赞/评哪条：stellar_qzone_react 传 feedId=' + (rows[0]?.short ?? '<短 id>') + '（列表里方括号那串前 8 位即可），action=like/unlike/comment；评论默认只演练，确认后 go=true。' });
        return { content: blocks };
      }

      const scriptArgs = ['qzone'];
      if (wantTid) {
        scriptArgs.push('detail', '--tid', wantTid);
        if (uin != null && String(uin).trim() !== '') scriptArgs.push('--uin', String(Number(uin)));
        if (hasNum) scriptArgs.push('--num', String(Number(num)));
      } else {
        if (!['owner', 'mine', 'friends', 'person'].includes(scopeUsed)) {
          return { content: [{ type: 'text', text: 'scope 只能是 owner / mine / friends / person / public' }], isError: true };
        }
        if (scopeUsed === 'person' && !(uin != null && String(uin).trim() !== '')) {
          return { content: [{ type: 'text', text: 'scope=person 要同时给 uin（那个人的 QQ，通讯录里能看到）' }], isError: true };
        }
        scriptArgs.push('read', '--scope', scopeUsed);
        if (uin != null && String(uin).trim() !== '') scriptArgs.push('--uin', String(Number(uin)));
        if (hasNum) scriptArgs.push('--num', String(Number(num)));
      }
      const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 120000 });
      const blocks = [{ type: 'text', text: clip(output || '（脚本无输出）') }];
      if (attachImages !== false) {
        // 详情接口（get_qzone_msg_detail）不返回图片，所以按 tid 单独把图捞回来 ——
        // 之前只在列表路径附图，导致她「读某条说说」时永远只看到文字。
        const pics = await qzoneImageBlocks(scopeUsed, hasNum ? num : undefined, wantTid ? 4 : 3, wantTid, uin);
        if (pics.length) {
          blocks.push({ type: 'text', text: wantTid ? '这条说说正文和评论区的图片已附在下面（原图，直接看）：' : '带图的说说，图片已附在下面：' });
          blocks.push(...pics);
        } else if (wantTid) {
          blocks.push({ type: 'text', text: '（这条说说和评论区都没有可见图片，或图片没取下来；文字里出现的 🖼 数量只是标签）' });
        }
      }
      return { content: blocks, isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '读空间失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_qzone_react',
  '在 QQ 空间互动。主人私聊里点赞/取消赞直接生效；非主人会转成「等主人审批」，评论默认只演练，go=true 才真发（同样要主人点头）。action=like 点赞、unlike 取消赞、comment 评论或回复。两种目标：①她自己/主人的说说 —— 传 tid（还能传 uin/time/commentId 等回复楼里某人）；②好友爱看/推荐流里的陌生人公开动态 —— 传 feedId（stellar_qzone_read scope=public 列表里方括号那串）。评论回复某人时：回复一级评论传 commentId + commentUin；回复楼中楼再传 replyUin + replyName。自己的空间能改的只有主人和她自己；公开动态只能赞/评，不能删。话要像她自己说，别写"AI"、别贴隐私、别刷屏。说错了想收回 → 用 stellar_qzone_delete_comment。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    action: z.enum(['like', 'unlike', 'comment']).describe('like=点赞 / unlike=取消赞 / comment=发评论或回复'),
    tid: z.string().optional().describe('说说 id（先用 stellar_qzone_read 看）；和 feedId 二选一'),
    feedId: z.string().optional().describe('好友爱看/推荐流里那条公开动态的 id（stellar_qzone_read scope=public 列表里方括号那串，前 8 位就够）；和 tid 二选一'),
    text: z.string().optional().describe('action=comment 时必填：评论内容'),
    uin: z.string().optional().describe('这条说说属于谁（主人的说说要传主人 QQ；自己的不传）'),
    time: z.union([z.number(), z.string()]).optional().describe('可选：说说的发布时间戳（点赞偶尔需要），一般不用传'),
    commentId: z.string().optional().describe('回复某条一级评论时：那条评论的 id（详情里的 #1 这种）'),
    commentUin: z.string().optional().describe('回复某条一级评论时：那条评论作者的 QQ'),
    replyUin: z.string().optional().describe('回复楼中楼时：被回复那个人的 QQ'),
    replyName: z.string().optional().describe('回复楼中楼时：被回复那个人的昵称'),
    go: z.boolean().optional().describe('action=comment 时：不传=只演练，true=真正发出去')
  },
  async ({ key, token, action, tid, feedId, text, uin, time, commentId, commentUin, replyUin, replyName, go }) => {
    try {
      if (!capabilityEnabled('qzoneReact')) {
        return { content: [{ type: 'text', text: '控制台把「自动点赞 / 评论」关了，空间互动先停一停；读说说不受影响。' }], isError: true };
      }
      const act = String(action ?? '').trim().toLowerCase();
      if (!['like', 'unlike', 'comment'].includes(act)) {
        return { content: [{ type: 'text', text: 'action 只能是 like / unlike / comment' }], isError: true };
      }
      const targetTid = String(tid ?? '').trim();
      const targetFeed = String(feedId ?? '').trim();

      // ── 公开动态（好友爱看/推荐流）：只能赞/评，走 qzone public 子命令 ───────
      // 这里刻意不走 qzoneAllowedUins 白名单 —— 公开流里全是陌生人，白名单会把它
      // 拦死；能赞/评谁由「主人配的每日上限 + approvalGate + 她自己的判断」共同决定。
      if (targetFeed) {
        if (targetTid) return { content: [{ type: 'text', text: 'tid 和 feedId 只能给一个：说说传 tid，公开动态传 feedId' }], isError: true };
        if (act === 'comment') {
          const body = String(text ?? '').trim();
          if (!body) return { content: [{ type: 'text', text: '评论要给 text' }], isError: true };
          if (body.length > 400) return { content: [{ type: 'text', text: '评论太长（' + body.length + ' 字），压到 400 字以内' }], isError: true };
          if (go === true) {
            const gate = await approvalGate({
              key,
              token,
              action: 'qzone_react',
              args: { action: 'comment', feedId: targetFeed, text: body }
            });
            if (gate) return gate;
          }
          const scriptArgs = ['qzone', 'public', 'comment', '--id', targetFeed, '--text', body, go === true ? '--go' : '--dry'];
          const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 120000 });
          const prefix = go === true ? '【已尝试评论公开动态】' : '【仅演练，没发出去；确认后带 go=true 再调一次】';
          return { content: [{ type: 'text', text: clip(prefix + '\n退出码: ' + code + '\n' + (output || '（脚本无输出）')) }], isError: code !== 0 };
        }
        const gate = await approvalGate({
          key,
          token,
          action: 'qzone_react',
          args: { action: act, feedId: targetFeed }
        });
        if (gate) return gate;
        const scriptArgs = ['qzone', 'public', act, '--id', targetFeed, '--go'];
        const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 90000 });
        return { content: [{ type: 'text', text: clip('退出码: ' + code + '\n' + (output || '（脚本无输出）')) }], isError: code !== 0 };
      }

      if (!targetTid) return { content: [{ type: 'text', text: '需要 tid（自己/主人的说说）或 feedId（好友爱看里的公开动态）：先用 stellar_qzone_read 读一下再说' }], isError: true };
      const hasUin = uin != null && String(uin).trim() !== '';
      if (hasUin) {
        const allowed = await qzoneAllowedUins();
        if (!allowed.has(Number(uin))) {
          return { content: [{ type: 'text', text: '只能互动通讯录里的人（主人 / 她自己 / 好友 / 测试号），' + uin + ' 不在通讯录里（现在收的是 ' + [...allowed].join('/') + '）。想加人：控制台 → 通讯录' }], isError: true };
        }
      }
      if (act === 'comment') {
        const body = String(text ?? '').trim();
        if (!body) return { content: [{ type: 'text', text: '评论要给 text' }], isError: true };
        if (body.length > 400) return { content: [{ type: 'text', text: '评论太长（' + body.length + ' 字），压到 400 字以内' }], isError: true };
        const hasCid = commentId != null && String(commentId).trim() !== '';
        const hasCuin = commentUin != null && String(commentUin).trim() !== '';
        if (hasCid !== hasCuin) return { content: [{ type: 'text', text: 'commentId 和 commentUin 要成对给（回复某条一级评论）' }], isError: true };
        const hasRuin = replyUin != null && String(replyUin).trim() !== '';
        const hasRname = replyName != null && String(replyName).trim() !== '';
        if (hasRuin !== hasRname) return { content: [{ type: 'text', text: 'replyUin 和 replyName 要成对给（回复楼中楼）' }], isError: true };
        if (hasRuin && !hasCid) return { content: [{ type: 'text', text: '回复楼中楼还要给 commentId/commentUin（父评论）' }], isError: true };
        if (go === true) {
          const gate = await approvalGate({
            key,
            token,
            action: 'qzone_react',
            args: {
              action: 'comment', tid: targetTid, text: body,
              uin: hasUin ? String(Number(uin)) : '',
              commentId: hasCid ? String(commentId) : '',
              commentUin: hasCuin ? String(Number(commentUin)) : '',
              replyUin: hasRuin ? String(Number(replyUin)) : '',
              replyName: hasRname ? String(replyName) : ''
            }
          });
          if (gate) return gate;
        }
        const scriptArgs = ['qzone', 'comment', '--tid', targetTid, '--text', body];
        if (hasUin) scriptArgs.push('--uin', String(Number(uin)));
        if (hasCid) scriptArgs.push('--cid', String(commentId), '--cuin', String(Number(commentUin)));
        if (hasRuin) scriptArgs.push('--ruin', String(Number(replyUin)), '--rname', String(replyName));
        scriptArgs.push(go === true ? '--go' : '--dry');
        const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 120000 });
        const prefix = go === true ? '【已尝试真实评论】' : '【仅演练，没发出去；确认后带 go=true 再调一次】';
        return {
          content: [{ type: 'text', text: clip(prefix + '\n退出码: ' + code + '\n' + (output || '（脚本无输出）')) }],
          isError: code !== 0
        };
      }
      const gate = await approvalGate({
        key,
        token,
        action: 'qzone_react',
        args: {
          action: act, tid: targetTid,
          uin: hasUin ? String(Number(uin)) : '',
          time: time != null && String(time).trim() !== '' ? String(Number(time)) : ''
        }
      });
      if (gate) return gate;
      const scriptArgs = ['qzone', act, '--tid', targetTid];
      if (hasUin) scriptArgs.push('--uin', String(Number(uin)));
      if (time != null && String(time).trim() !== '') scriptArgs.push('--time', String(Number(time)));
      scriptArgs.push('--go');
      const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 90000 });
      return {
        content: [{ type: 'text', text: clip('退出码: ' + code + '\n' + (output || '（脚本无输出）')) }],
        isError: code !== 0
      };
    } catch (error) {
      return { content: [{ type: 'text', text: '空间互动失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 删掉自己发在说说评论区的评论 ──────────────────────────────────────────
server.tool(
  'stellar_qzone_delete_comment',
  '删掉她自己发在 QQ 空间说说评论区里的评论或楼中楼回复（只给主人用，key=private:<主人QQ>）。不给 commentId / replyId 就先列出这条说说下面的评论（★= 她发的），给了就删；默认只演练，go=true 才真删。别人发的评论删不了（会直接报错）。发错了、说错话了、主人让收回时才用，别乱删。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    tid: z.string().describe('说说 id（stellar_qzone_read 里 [tid] 那串）'),
    commentId: z.string().optional().describe('要删的一级评论 id（列表里的 #3 这种）'),
    replyId: z.string().optional().describe('要删的楼中楼回复 id；删回复时必须同时给 parentCommentId'),
    parentCommentId: z.string().optional().describe('楼中楼回复所在的一级评论 id'),
    go: z.boolean().optional().describe('不传=只演练（不真删），true=真正删除')
  },
  async ({ key, token, tid, commentId, replyId, parentCommentId, go }) => {
    try {
      const targetTid = String(tid ?? '').trim();
      if (!targetTid) return { content: [{ type: 'text', text: '需要 tid：先用 stellar_qzone_read 看是哪条说说' }], isError: true };
      const hasComment = commentId != null && String(commentId).trim() !== '';
      const hasReply = replyId != null && String(replyId).trim() !== '';
      const hasParent = parentCommentId != null && String(parentCommentId).trim() !== '';
      if (!hasComment && !hasReply) {
        const { code, text: output } = await runLocalScript(['qzone', 'comments', '--tid', targetTid], { timeoutMs: 120000 });
        return {
          content: [{ type: 'text', text: clip('这条说说下面的评论（★= 她发的，可删）：\n退出码: ' + code + '\n' + (output || '（脚本无输出）')) }],
          isError: code !== 0
        };
      }
      if (hasReply && !hasParent) return { content: [{ type: 'text', text: '删楼中楼回复还要给 parentCommentId（父评论 id）' }], isError: true };
      if (go === true) {
        const gate = await approvalGate({
          key,
          token,
          action: 'qzone_delete_comment',
          args: {
            tid: targetTid,
            commentId: hasComment ? String(commentId) : '',
            replyId: hasReply ? String(replyId) : '',
            parentCommentId: hasParent ? String(parentCommentId) : ''
          }
        });
        if (gate) return gate;
      }
      const scriptArgs = ['qzone', 'uncomment', '--tid', targetTid];
      if (hasReply) scriptArgs.push('--reply', String(replyId), '--parent', String(parentCommentId));
      else scriptArgs.push('--comment', String(commentId));
      scriptArgs.push(go === true ? '--go' : '--dry');
      const { code, text: output } = await runLocalScript(scriptArgs, { timeoutMs: 120000 });
      const prefix = go === true ? '【已尝试真实删除】' : '【仅演练，没删；确认后带 go=true 再调一次】';
      return {
        content: [{ type: 'text', text: clip(prefix + '\n退出码: ' + code + '\n' + (output || '（脚本无输出）')) }],
        isError: code !== 0
      };
    } catch (error) {
      return { content: [{ type: 'text', text: '删评论失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 今日图片池：发说说/动态时挑一张贴合的图 ────────────────────────────────
//
// 背景（主人 2026-11-11）：她 B站看视频时 debrief 已经把封面存下来，评论图、
// 空间图也都能下到本地；但过一天这些图就该清掉。所以池子按日期分目录，
// 写入/读取时顺手删别的日期目录 —— 「每天结束就清空」，不靠定时器。
server.tool(
  'stellar_image_pool',
  '看/用「今天手边能用的图」（只给主人用，key=private:<主人QQ>）。她发说说/动态想配图时先 action=list 看今天有哪些图（B站封面、评论图、空间图都可能在），挑一张贴合文案的用 action=pick（会把图直接附在结果里让她看见，最多 2 张）；没有合适的就别硬配。action=clear 清空今天的池子。池子里的图跨天自动清空（不需要她管）。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    action: z.enum(['list', 'pick', 'clear']).describe('list=看今天有哪些图（不附图）/ pick=挑一张并把原图附上 / clear=清空今天的池子'),
    file: z.string().optional().describe('action=pick 时：要哪张图（list 给出的路径，或只给文件名）'),
    n: z.number().int().min(1).max(20).optional().describe('action=list 时最多列几张，默认 20')
  },
  async ({ key, token, action, file, n }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const mod = await import(pathToFileURL(path.join(TOOLS_DIR, 'lib', 'image-pool.mjs')).href);
      const act = String(action ?? 'list').trim().toLowerCase();
      if (act === 'clear') {
        const removed = mod.clearPool({});
        return { content: [{ type: 'text', text: removed ? '今天的图片池已清空。' : '今天池子里本来就没有图。' }] };
      }
      const pool = mod.listImages({});
      const images = Array.isArray(pool.images) ? pool.images : [];
      if (act === 'pick') {
        const want = String(file ?? '').trim();
        if (!want) return { content: [{ type: 'text', text: 'action=pick 要给 file：先用 action=list 看有哪些图' }], isError: true };
        const hit = images.find((i) => i.file === want || i.name === want || i.file.endsWith(path.sep + want)) ?? null;
        if (!hit) {
          return { content: [{ type: 'text', text: '今天池子里没有这张图：' + want + '（先用 action=list 看看有哪些；图跨天就清掉了）' }], isError: true };
        }
        const blk = mediaImageBlock(hit.file);
        if (!blk) return { content: [{ type: 'text', text: '这张图没法附（可能太大或格式不支持 AVIF/HEIC）：' + hit.file }], isError: true };
        return {
          content: [
            { type: 'text', text: '用这张：' + hit.file + (hit.caption ? '\n拍/配的是：' + clip(hit.caption, 300) : '') },
            blk
          ]
        };
      }
      const limit = Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : 20;
      if (!images.length) {
        return { content: [{ type: 'text', text: '今天的图片池是空的（她刷 B站/看空间时的图才会进池子；跨天自动清空）。没有合适的图就别硬配，纯文字发也行。' }] };
      }
      const lines = images.slice(-limit).map((i, idx) => {
        const cap = String(i.caption ?? '').replace(/\s+/g, ' ').slice(0, 60);
        const mb = (Number(i.bytes ?? 0) / 1024 / 1024).toFixed(1);
        return '#' + (idx + 1) + ' ' + i.file + '  [' + (i.origin || 'img') + ' ' + mb + 'MB]' + (cap ? ' ' + cap : '');
      });
      return { content: [{ type: 'text', text: '今天是 ' + (pool.day || '') + '，池子里 ' + images.length + ' 张图（最多列 ' + limit + ' 张，新的在后）：\n' + lines.join('\n') + '\n\n要配图：action=pick file=<上面某个路径>，图会附在结果里；没有贴合文案的就别配。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '图片池操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 她自己上网找的图：独立目录、每天清空、最多 30 张（owner 2026-11-11 22:25）──
//
// 和 B站封面那个「今日图片池」是**两个目录**：主人明确要求别混在一起。
// 她搜到的图落在 ~/.dsh/stellar/web-images/<日期>/，第二天自动清空；
// 但索引 index.jsonl 留着 —— 所以控制台能看到「今天找了什么、删了哪几张」。
server.tool(
  'stellar_web_image',
  '她自己上网找图。action=search 会真的去 Bing 图片搜、把图下载到本地（每天最多 30 张，第二天清空，和控制台里那张「她自己找的图」是同一个目录），返回里带文件名和前两张预览图——**先看清图对不对**，再用 qq_send_image 的 imagePath 传**本地完整路径**发给对方（别传网址）。action=list 看今天有哪些；action=del 删一张（只给主人，控制台会留删除记录）；action=clear 全删（只给主人）；action=path 只报目录。别人让你「找张 XX 的图」时就用它，别拿搜索页链接糊弄。',
  {
    key: z.string().describe('当前会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    action: z.enum(['search', 'list', 'del', 'clear', 'path']).describe('search=搜图并下载 / list=看今天找了哪些 / del=删一张 / clear=全删 / path=只报目录'),
    query: z.string().optional().describe('action=search 时的关键词（中文更准，比如「雪山下的小镇」「橘猫 表情包」）'),
    n: z.number().int().min(1).max(10).optional().describe('action=search 时下几张，默认 3，最多 10'),
    name: z.string().optional().describe('action=del 时：要删哪个文件（list 给出的文件名）')
  },
  async ({ key, token, action, query, n, name }) => {
    try {
      // 2026-11-12：找图从「只给主人」放宽到「会话内谁要求都行」，但**删图仍然只给主人**。
      // 起因：通讯录好友让「帮我去网上找一张 XX 的图」时她没有这个工具，只能用 web_search
      // 拿到一串图片直链、再让 qq_send_image 去抓 —— 外链抓取有大小/格式/防盗链一堆坑，
      // 表现出来就是「图搜到一堆但发不出去」。让她先在服务端把图落地，再发本地文件，稳得多。
      const act = String(action ?? 'list').trim().toLowerCase();
      if (act === 'del' || act === 'clear') {
        const denied = await ownerOnlyError(key, token);
        if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      }
      const args = ['webimg']
      if (act === 'search') {
        const q = String(query ?? '').trim();
        if (!q) return { content: [{ type: 'text', text: 'action=search 要给 query：想找什么图？' }], isError: true };
        const want = Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : 3;
        args.push('search', q, '--n', String(want), '--by', 'her', '--json');
      } else if (act === 'del') {
        const want = String(name ?? '').trim();
        if (!want) return { content: [{ type: 'text', text: 'action=del 要给 name：先用 action=list 看她今天找了哪些图' }], isError: true };
        args.push('del', '--name', want, '--by', 'her');
      } else if (act === 'clear') {
        args.push('clear', '--by', 'her');
      } else if (act === 'path') {
        args.push('path');
      } else {
        args.push('list', '--json');
      }
      const { code, text: output } = await runLocalScript(args, { timeoutMs: 180000 });
      const payload = String(output || '').trim() || '（脚本无输出）';
      // search/list 的 --json 直接用；其余给人读的输出原样返回。
      if ((act === 'search' || act === 'list') && payload.startsWith('{')) {
        let data = null
        try { data = JSON.parse(payload.slice(payload.indexOf('{'))) } catch {}
        if (data && data.ok === false) {
          return { content: [{ type: 'text', text: '没找到可用结果：' + (data.reason || data.message || '') }], isError: true };
        }
        const imgs = Array.isArray(data?.images) ? data.images : (Array.isArray(data?.saved) ? data.saved : []);
        if (!imgs.length) {
          return { content: [{ type: 'text', text: (act === 'search' ? '这次一张都没下下来（可能关键词太冷门、图都是 SVG/GIF，或者今天已经 30 张）。' : '今天她还没在网上找图。') + '\n目录：' + (data?.dir || '') }] };
        }
        const rows = imgs.slice(0, 12).map((it, idx) => '#' + (idx + 1) + ' ' + (it.name || '') + '  ' + Math.round((Number(it.bytes) || 0) / 1024) + 'KB' + (it.title ? '  ' + clip(it.title, 50) : ''));
        // 给你自己（模型）看一眼图对不对：只附前 2 张，多了太费 token。
        const previewBlocks = [];
        for (const it of imgs.slice(0, 2)) {
          const blk = mediaImageBlock(it.file);
          if (blk) previewBlocks.push(blk);
        }
        const feedHint = '\n\n发出去：qq_send_image 的 imagePath 直接填上面某个完整路径（本地文件，别填网址）。'
          + '\n想删哪张就用 action=del name=<文件名>；控制台里也会留着这条删除记录。';
        return { content: [{ type: 'text', text: (act === 'search' ? '搜「' + String(query || '').trim() + '」→ 存了 ' + imgs.length + ' 张（今天共 ' + (data?.count ?? imgs.length) + '/' + (data?.max || 30) + ' 张）\n' : '今天找了 ' + imgs.length + ' 张（最多 30 张，明天清空）\n') + '目录：' + (data?.dir || '') + '\n' + rows.join('\n') + feedHint }, ...previewBlocks] };
      }
      return { content: [{ type: 'text', text: clip(payload, 4000) }], isError: code !== 0 };
    } catch (error) {
      return { content: [{ type: 'text', text: '找图失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 花费预估：接到大任务先报价，别闷头烧钱 ──────────────────────────────────
//
// 主人 2026-11-08 的要求：每天总额度 ¥10，而且「遇到可能需要大量 token 的任务
// 要先请示，并给出预估消费金额」。所以给她一个只读工具：读今天的账单 + 按
// cost-estimate.js 的预设估一件事要多少钱，并且直接告诉她该不该先问。
server.tool(
  'stellar_cost',
  '查今天花了多少钱、还剩多少额度，并估算一件事大概要花多少。只给主人用（key=private:<ownerQQ>）。用法：不带参数 = 今日账单 + 常见任务价目表；带 preset（chat-turn / qzone-post / bili-watch / bili-watch-deep / web-research / code-task / long-article）或 tokens+outputTokens 估具体任务。**判断大任务要不要做之前必须先用它估一遍，然后把金额报给主人等同意。**',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    preset: z.string().optional().describe('任务预设：chat-turn / qzone-post / bili-watch / bili-watch-deep / web-research / code-task / long-article'),
    tokens: z.union([z.number(), z.string()]).optional().describe('自定义：每轮上下文的 token 数'),
    outputTokens: z.union([z.number(), z.string()]).optional().describe('自定义：总产出 token 数'),
    turns: z.union([z.number(), z.string()]).optional().describe('自定义：轮数（默认 1）'),
    chars: z.union([z.number(), z.string()]).optional().describe('自定义：用字数粗估（中文），会自动换算成 token'),
    kind: z.string().optional().describe('chars 的口径：zh（默认，1 字≈0.7 token）或 code（4 字符≈1 token）')
  },
  async ({ key, token, preset, tokens, outputTokens, turns, chars, kind }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const snap = budgetSnapshot();
      const hasCustom = [preset, tokens, outputTokens, turns, chars].some((v) => v != null && String(v).trim() !== '');
      if (!hasCustom) {
        const table = Object.entries(TASK_PRESETS).map(([id, p]) => {
          const est = estimateTask({ preset: id });
          return '- ' + id.padEnd(16) + ' ' + p.label.padEnd(22, ' ') + ' ' + formatEstimate(est);
        }).join('\n');
        const text = [
          '今天的账：',
          formatSnapshot(snap),
          '按金额：QQ 已花 ' + formatCny(snap.remaining.qq.usedCny)
            + '；B站 ' + formatCny(snap.remaining.bili.usedCny)
            + '；其他 ' + formatCny(snap.remaining.other.usedCny),
          '',
          '常见任务的估价（' + snap.rates.tierLabel + '，单价' + (snap.rates.tier === 'peak' ? '×2' : '正常') + '）：',
          table,
          '',
          '要估具体任务就再调一次，带 preset 或 tokens/outputTokens/chars。'
        ].join('\n');
        return { content: [{ type: 'text', text: clip(text) }] };
      }
      const opts = {};
      if (preset != null && String(preset).trim()) {
        const id = String(preset).trim();
        if (!TASK_PRESETS[id]) {
          return { content: [{ type: 'text', text: '没有这个预设：' + id + '。可选：' + Object.keys(TASK_PRESETS).join(' / ') }], isError: true };
        }
        opts.preset = id;
      }
      if (chars != null && String(chars).trim()) opts.contextTokens = charsToTokens(Number(chars), String(kind || 'zh').trim() || 'zh');
      if (tokens != null && String(tokens).trim()) opts.contextTokens = Number(tokens);
      if (outputTokens != null && String(outputTokens).trim()) opts.outputTokens = Number(outputTokens);
      if (turns != null && String(turns).trim()) opts.turns = Number(turns);
      if (!opts.preset && opts.contextTokens == null && opts.outputTokens == null) {
        return { content: [{ type: 'text', text: '要估具体任务得给 preset，或者 tokens / outputTokens / chars 之一' }], isError: true };
      }
      const est = estimateTask(opts);
      return { content: [{ type: 'text', text: clip(describePlan(est, snap)) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '估算失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// ── 读文件：PDF / Word / PPT / Excel / WPS ────────────────────────────────
// 主人发来的文档，bridge 只把定位信息（files[]）存进会话状态；正文在这里下载 + 解析。
// 解析器在 plugins/stellar/tools/lib/doc-extract.mjs（zip/PDF 纯 JS，老格式借本机 Office/WPS 转换）。
// 允许用 STELLAR_SOCIAL_STATE 指向另一份状态文件：测试（离线夹具）时不必改动线上 state。
const SOCIAL_STATE_FILE = process.env.STELLAR_SOCIAL_STATE || path.join(ROOT, 'state', 'social-v2.json');
const FILE_MAX_BYTES = 60 * 1024 * 1024;
let docExtractPromise = null;

function loadDocExtract() {
  if (!docExtractPromise) {
    docExtractPromise = import(pathToFileURL(path.join(TOOLS_DIR, 'lib', 'doc-extract.mjs')).href);
  }
  return docExtractPromise;
}

function findFileEntry(key, opts) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(SOCIAL_STATE_FILE, 'utf8')); } catch {}
  const conv = state && state.conversations ? state.conversations[String(key || '')] : null;
  if (!conv) return { error: '会话状态里没有这个 key（要传本会话的 private:<主人QQ>）' };
  const pool = [...(Array.isArray(conv.unread) ? conv.unread : []), ...(Array.isArray(conv.recentMessages) ? conv.recentMessages : [])];
  const files = [];
  for (const m of pool) {
    for (const f of Array.isArray(m && m.files) ? m.files : []) {
      files.push({ ...f, messageId: (m && m.messageId) || null, seq: m && m.seq });
    }
  }
  // 合并转发里的文件（2026-11-20）：转发内部消息不进 unread/recentMessages，
  // 桥接读转发时把定位信息单独写进 conv.forwardFiles，这里并进来一起找。
  const forwarded = (Array.isArray(conv.forwardFiles) ? conv.forwardFiles : [])
    .filter((f) => f && (f.name || f.fileId))
    .map((f) => ({ ...f, forwardId: f.forwardId || '', fromForward: true }));
  const wantForward = String((opts && opts.forwardId) || '').trim();
  const wantFileId = String((opts && opts.fileId) || '').trim();
  if (!files.length && !forwarded.length) {
    return { error: '状态里没找到文件记录（可能是很久以前的消息，或文件已被清理；让对方重发一次）。' };
  }
  const wantMid = String((opts && opts.messageId) || '').trim();
  const wantName = String((opts && opts.name) || '').trim().toLowerCase();
  let pool2 = files;
  if (wantForward || wantFileId) {
    pool2 = forwarded.filter((f) => {
      if (wantForward && String(f.forwardId || '') !== wantForward) return false;
      if (wantFileId && String(f.fileId || '') !== wantFileId) return false;
      return true;
    });
    if (!pool2.length && wantFileId) pool2 = forwarded.filter((f) => String(f.fileId || '') === wantFileId);
  } else if (!wantMid && !wantName) {
    // 没点名时，优先最近一次转发里的文件（正文提示就是这么引导的）。
    pool2 = [...files, ...forwarded];
  }
  let hit = null;
  if (wantMid) hit = files.find((f) => f.messageId && String(f.messageId) === wantMid) || null;
  if (!hit && wantFileId) hit = forwarded.find((f) => String(f.fileId || '') === wantFileId) || null;
  if (!hit && wantName) hit = pool2.find((f) => String(f.name || '').toLowerCase().includes(wantName)) || null;
  if (!hit && (wantForward || wantFileId)) hit = pool2[0] || null;
  const explicit = Boolean(wantMid || wantName || wantForward || wantFileId);
  if (!hit && explicit) {
    // 明确点名了却没找到：宁可报错，也不要静默读成「最近一个文件」——那会把 A 文件的内容
    // 当成 B 文件答出来，比读不到更糟。
    const knownPool = (pool2 && pool2.length ? pool2 : [...files, ...forwarded]).slice(-5);
    const known = knownPool.map((f) => (f.name || '未命名') + (f.messageId ? '（messageId=' + f.messageId + '）' : (f.forwardId ? '（在转发 ' + f.forwardId + ' 里）' : ''))).join('、');
    return { error: '没找到你说的那个文件（' + (wantMid ? 'messageId=' + wantMid : wantFileId ? 'fileId=' + wantFileId : wantForward ? 'forwardId=' + wantForward : 'name≈' + wantName) + '）。最近这几个是：' + (known || '无') };
  }
  if (!hit) hit = pool2[pool2.length - 1];
  return { file: hit, total: pool2.length, explicit };
}

async function fileDownloadUrl(file, key, { allowOwnerFallback = true } = {}) {
  const direct = String((file && file.url) || '').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  // 2026-11-20：合并转发里的文件可能是群成员发的，get_private_file_url 拿不到（它按主人私聊
  // 的 user_id 去查）。先试通用 get_file —— 它只认 file_id，群/私聊都能用。
  const fileId = String((file && file.fileId) || '').trim();
  if (fileId) {
    try {
      const data = await onebot('get_file', {
        file_id: fileId,
        ...(String((file && file.fileHash) || '').trim() ? { file_hash: String(file.fileHash) } : {})
      });
      const got = typeof data === 'string' ? data : String((data && (data.url || data.file)) || '').trim();
      if (/^https?:\/\//i.test(got)) return got;
    } catch (error) {
      if (!allowOwnerFallback) throw new Error('拿不到下载链接：' + (error && error.message ? error.message : error));
    }
  }
  if (!allowOwnerFallback) throw new Error('拿不到下载链接（文件可能已过期，让对方重发一次）');
  const owner = String(String(key || '').replace(/^private:/, '') || getConfig().ownerQQ || '').trim();
  const userId = Number(owner) || Number(getConfig().ownerQQ) || 0;
  const data = await onebot('get_private_file_url', {
    user_id: userId,
    file_id: String((file && file.fileId) || ''),
    file_hash: String((file && file.fileHash) || '')
  });
  const url = typeof data === 'string' ? data : String((data && data.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('拿不到下载链接（文件可能已过期，让主人重发一次）');
  return url;
}

async function fetchFileBuffer(url, { allowPrivate = false, maxBytes = FILE_MAX_BYTES } = {}) {
  if (!allowPrivate) await assertPublicHttpUrl(url);
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : FILE_MAX_BYTES;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > cap) throw new Error('文件太大（' + (declared / 1048576).toFixed(1) + ' MB），上限 ' + (cap >= 1048576 ? (cap / 1048576) + ' MB' : (cap / 1024) + ' KB'));
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到的是空文件');
  if (buf.length > cap) throw new Error('文件太大（' + (buf.length / 1048576).toFixed(1) + ' MB），上限 ' + (cap >= 1048576 ? (cap / 1048576) + ' MB' : (cap / 1024) + ' KB'));
  return buf;
}

server.tool(
  'stellar_chat_history',
  '查她最近发给别人（非主人）和群的消息记录。只在主人私聊里可用，只读。可按 QQ 号/群号筛选。回答“她跟谁说了什么 / 有没有背着我聊天”时用这个，不要猜。',
  {
    key: z.string().describe('会话 key，必须是 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    target: z.string().optional().describe('按 QQ 号或群号筛选；留空看全部'),
    limit: z.number().int().min(1).max(80).optional().describe('返回条数，默认 20')
  },
  async ({ key, token, target, limit }) => {
    const denied = await ownerOnlyError(key, token);
    if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
    const want = String(target || '').replace(/[^\d]/g, '');
    const n = Math.max(1, Math.min(80, Number(limit) || 20));
    const file = path.join(dshHome(), 'stellar', 'state', 'outbound-messages.jsonl');
    let text = '';
    try {
      const st = fs.statSync(file);
      const start = Math.max(0, st.size - 4 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } catch {
      return { content: [{ type: 'text', text: '还没有发件记录（state/outbound-messages.jsonl 不存在）。' }] };
    }
    const lines = text.split('\n').filter(Boolean);
    const items = [];
    for (let i = lines.length - 1; i >= 0 && items.length < n; i -= 1) {
      let e = null;
      try { e = JSON.parse(lines[i]); } catch { continue }
      if (!e || !e.at) continue;
      if (want) {
        const t = String(e.target || '');
        if (t !== want && !t.endsWith(':' + want)) continue;
      }
      items.push(e);
    }
    const fmtTime = (iso) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso || '');
      return d.toLocaleString('zh-CN', { hour12: false });
    };
    const body = items.length
      ? items.map((e) => (fmtTime(e.at) + ' → ' + (e.kind === 'group' ? '群 ' : '') + (e.target || '?') + '：' + (e.text || (e.image ? '［图片］' : '（空）')).slice(0, 300))).join('\n')
      : ('没有' + (want ? ('发给 ' + want + ' 的') : '') + '发件记录。');
    try {
      fs.mkdirSync(path.join(dshHome(), 'stellar', 'state'), { recursive: true });
      fs.appendFileSync(path.join(dshHome(), 'stellar', 'state', 'chat-history-audit.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), by: 'qq:owner', target: want, limit: n, count: items.length }) + '\n');
    } catch {}
    return { content: [{ type: 'text', text: clip('她最近发出去的消息（' + items.length + ' 条）：\n' + body, 6000) }] };
  }
);

server.tool(
  'stellar_file_list',
  '列出「主人的文件柜」里的文件（名字 / 类型 / 大小 / 改动时间）。文件柜是主人在控制台放文档的地方（Word/Excel/PPT/PDF/图片都行），内容不会自动进你的上下文——需要看某个文件时先列一遍拿到准确文件名，再用 stellar_file_read(path="<dir>/<文件名>") 读那一个；没让你看的文件不要主动读，白花时间也白花 token。只给主人用。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    limit: z.union([z.number(), z.string()]).optional().describe('最多列几个（默认 80，上限 200）')
  },
  async ({ key, token, limit }) => {
    try {
      const denied = await ownerOnlyError(key, token);
      if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
      const dir = path.join(dshHome(), 'stellar', 'files');
      const max = Math.min(200, Math.max(1, Number(limit) || 80));
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'index.jsonl'); } catch { names = []; }
      if (!names.length) {
        return {
          content: [{
            type: 'text',
            text: '文件柜现在是空的：' + dir + '\n主人还没往这里放东西。他要是在聊天里直接发文件，照旧用 messageId 读。'
          }]
        };
      }
      const EXT = {
        doc: 'Word', docx: 'Word', wps: 'Word', rtf: 'Word', odt: 'Word',
        xls: 'Excel', xlsx: 'Excel', et: 'Excel', csv: 'Excel', ods: 'Excel',
        ppt: 'PPT', pptx: 'PPT', dps: 'PPT', odp: 'PPT',
        pdf: 'PDF', txt: '文本', md: '文本', json: '文本', log: '文本',
        png: '图片', jpg: '图片', jpeg: '图片', webp: '图片', gif: '图片',
        zip: '压缩包', '7z': '压缩包', rar: '压缩包'
      };
      const rows = [];
      for (const n of names) {
        let st = null;
        try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
        if (!st.isFile()) continue;
        const ext = String(path.extname(n) || '').slice(1).toLowerCase();
        rows.push({ n, size: st.size, at: st.mtimeMs, kind: EXT[ext] || '文件' });
      }
      rows.sort((a, b) => b.at - a.at);
      const shown = rows.slice(0, max);
      const stamp = (ms) => {
        const d = new Date(ms);
        const p2 = (x) => String(x).padStart(2, '0');
        return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
      };
      const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
      const body = shown.map((r) => '- ' + r.n + '（' + r.kind + ' · ' + kb(r.size) + ' · ' + stamp(r.at) + '）').join('\n');
      const more = rows.length > shown.length ? '\n（还有 ' + (rows.length - shown.length) + ' 个没列，加 limit 再看）' : '';
      return {
        content: [{
          type: 'text',
          text: '主人的文件柜：' + dir + '\n共 ' + rows.length + ' 个文件：\n' + body + more +
            '\n\n要看正文就用 stellar_file_read(path="' + dir + '/<上面那个名字>")；一次只读你要看的那一份，别整个柜子都读。'
        }]
      };
    } catch (e) {
      return { content: [{ type: 'text', text: '列文件柜失败：' + String(e && e.message || e) }], isError: true };
    }
  }
);
server.tool(
  'stellar_file_read',
  '读文档正文。支持 PDF / Word(doc/docx) / PPT(ppt/pptx) / Excel(xls/xlsx) / WPS(wps/et/dps)，以及 txt/csv/md/rtf/html。主人能用全部来源（messageId / name / path / url）；群聊或非主人会话只能用「这个会话里合并转发过来的文件」——传 forwardId + name（提示里【合并转发的聊天记录 id】那段会给）。用 messageId 或 name 定位刚发来的文件（消息提示里 files[].messageId）。返回提取出的文字；长文档只给开头并把全文存成 spill 文件，要通读就按返回里的路径用 stellar_spill_read 分段读（每次 8000 字），读完再总结，不许只凭开头下结论。扫描件 PDF 没有文字层会读不出来 —— 那就直说看不到，别编。',
  {
    key: z.string().describe('当前会话 key，必须形如 private:<主人QQ>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    messageId: z.string().optional().describe('文件所在消息的 QQ messageId（消息提示里的 files[].messageId）'),
    forwardId: z.string().optional().describe('合并转发的 id（提示里【合并转发的聊天记录 <id>】那个 id）；转发里的文档用这个 + name 定位'),
    fileId: z.string().optional().describe('文件的 file_id（一般不用传，有 fileId 时可直接定位）'),
    name: z.string().optional().describe('文件名（含扩展名，可只写一部分）；没给 messageId/forwardId 时用它匹配'),
    path: z.string().optional().describe('本地文件路径（工作区相对路径或绝对路径都行）'),
    url: z.string().optional().describe('文件的 http(s) 下载地址'),
    maxChars: z.union([z.number(), z.string()]).optional().describe('最多返回多少字：默认 12000，上限 20000')
  },
  async ({ key, token, messageId, forwardId, fileId, name, path: filePath, url, maxChars }) => {
    try {
      const keyStr = String(key || '').trim();
      // 两种身份（2026-11-20）：
      //  · 主人：全部来源（messageId/name/path/url）都能读；
      //  · 非主人（群聊/别人的私聊）：只允许读「这个会话里合并转发过来的文件」——
      //    那些文档本来就在这个会话里公开传过，读它不越权。凭会话令牌确认「你是这个会话的自己」。
      const denied = await ownerOnlyError(key, token);
      const isOwner = !denied;
      let ident = null;
      if (!isOwner) {
        ident = await resolveAgentIdentity(token);
        if (!ident || !ident.key) {
          return { content: [{ type: 'text', text: denied }], isError: true };
        }
        if (ident.key !== keyStr) {
          return {
            content: [{ type: 'text', text: 'key 和会话令牌对不上（令牌属于 ' + ident.key + '），不读。' }],
            isError: true
          };
        }
        if (String(filePath || '').trim() || String(url || '').trim()) {
          return {
            content: [{ type: 'text', text: '只有主人能用 path/url 读任意文件。合并转发里的文件请传 forwardId + name（提示里【合并转发的聊天记录 <id>】那段会给）。' }],
            isError: true
          };
        }
      }
      const max = Math.min(20000, Math.max(1000, Number(maxChars) || 12000));
      const wantedPath = String(filePath || '').trim();
      const wantedUrl = String(url || '').trim();
      let fileName = String(name || '').trim();
      const notes = [];
      let buffer = null;
      if (!wantedPath && !wantedUrl && !String(messageId || '').trim() && !fileName) {
        return { content: [{ type: 'text', text: '要读哪个文件？传 messageId、name、path、url 之一（一般用消息提示里的 files[0].messageId）。' }], isError: true };
      }
      if (wantedUrl) {
        buffer = await fetchFileBuffer(wantedUrl);
        if (!fileName) fileName = decodeURIComponent(wantedUrl.split('?')[0].split('/').pop() || '文件');
      } else if (wantedPath) {
        const abs = assertReadableLocalPath(wantedPath, { workspaceRoot: WORKSPACE_ROOT, stellarRoot: ROOT, dshHome: dshHome() });
        const stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error('path 不是文件：' + wantedPath);
        if (stat.size > FILE_MAX_BYTES) throw new Error('文件太大（' + (stat.size / 1048576).toFixed(1) + ' MB），上限 60 MB');
        buffer = fs.readFileSync(abs);
        if (!fileName) fileName = path.basename(abs);
      } else {
        const found = findFileEntry(key, { messageId, forwardId, fileId, name });
        if (found.error) return { content: [{ type: 'text', text: found.error }], isError: true };
        const file = found.file;
        if (!isOwner && file.fromForward !== true) {
          return {
            content: [{ type: 'text', text: '这个会话里只有合并转发过来的文件能读（这是别人直接发的文件，只有主人能读）。' }],
            isError: true
          };
        }
        fileName = String(file.name || fileName || '').trim() || '未命名文件';
        if (!found.explicit) notes.push('没指定具体文件，读的是最近一个：' + fileName);
        else if (found.total > 1) notes.push('状态里有 ' + found.total + ' 个文件，这次读的是「' + fileName + '」');
        // 这个 URL 是 OneBot 自己给的（不是模型传的），可能指向本机端口 → 不再做公网校验
        buffer = await fetchFileBuffer(
          await fileDownloadUrl(file, key, { allowOwnerFallback: isOwner }),
          { allowPrivate: true }
        );
      }
      const { extractDocument } = await loadDocExtract();
      // 取全文（上限 40 万字）再决定给模型看多少：长文档整本落盘，模型只看开头 +
      // spill 路径，需要细节时用 stellar_spill_read 分段读。
      const FULL = 400000;
      const result = buffer && buffer.length
        ? await extractDocument({ buffer, fileName, maxChars: FULL })
        : await extractDocument({ filePath: assertReadableLocalPath(wantedPath, { workspaceRoot: WORKSPACE_ROOT, stellarRoot: ROOT, dshHome: dshHome() }), fileName, maxChars: FULL });
      if (!result || result.ok !== true) {
        return { content: [{ type: 'text', text: '读不了「' + (fileName || '这个文件') + '」：' + ((result && result.error) || '未知错误') }], isError: true };
      }
      const shown = Math.min(max, 12000);
      const head = ['已读：' + (fileName || '未命名文件') + '｜格式 ' + result.kind + '｜' + result.chars + ' 字' + (result.clipped ? '（超过 40 万字上限，只抽了前 40 万字）' : '')];
      if (result.note) head.push('说明：' + result.note);
      if (notes.length) head.push(...notes);
      if (result.meta) {
        const metaText = Object.keys(result.meta)
          .filter((k) => result.meta[k] != null && result.meta[k] !== '')
          .map((k) => k + '=' + result.meta[k])
          .join(' ');
        if (metaText) head.push('细节：' + metaText);
      }
      const bodyText = String(result.text || '').trim();
      head.push('---');
      if (!bodyText) {
        head.push('（没有提取到文字：可能是扫描件/纯图片，或文档是空的。别编内容，直说看不到。）');
        return { content: [{ type: 'text', text: head.join('\n') }] };
      }
      if (bodyText.length > shown) {
        const saved = writeSpill(bodyText, { tool: 'file_read' });
        head.push(bodyText.slice(0, shown));
        head.push(
          '\n…（这里只给了开头 ' + shown + ' 字，全文 ' + bodyText.length + ' 字已存到 ' + saved.file + '）\n' +
          '要通读整本/整篇就用 stellar_spill_read(path="' + saved.file + '", offset=0, maxChars=8000) 一段段读：' +
          '每段 offset 加 8000，读到返回「已到末尾」为止，再下结论。' +
          '只凭开头总结会被主人抓包：先说明「我接着往下读」，读够了再回答。'
        );
        return { content: [{ type: 'text', text: head.join('\n') }] };
      }
      head.push(bodyText);
      return { content: [{ type: 'text', text: head.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '读文件失败：' + (error && error.message ? error.message : error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_file_save',
  '把文件正式存进文件柜（长期保存；主人之后能在面板的文件柜里看到、下载、再读）。主人说「存下来 / 收好 / 先放着 / 存进文件柜」时必须真的调这个工具——只回一句「收好了」而没调过它就是骗人。来源按优先级取一个：text（你手上已有的正文，要和 name 一起给）＞ path（本机文件）＞ url（直链）＞ messageId / forwardId / fileId / name（聊天里的附件）。同名不覆盖，自动改成「名字 (2)」。非主人只能用本会话里传过的附件和 text，不能用 path/url。',
  {
    key: z.string().describe('当前会话 key，形如 private:<QQ> 或 group:<群号>'),
    token: z.string().optional().describe('会话令牌（唤醒提示/调度提示里【会话令牌】那一行的值原样传入；没有就不传）'),
    messageId: z.string().optional().describe('文件所在消息的 QQ messageId（消息提示里的 files[].messageId）'),
    forwardId: z.string().optional().describe('合并转发的 id；转发里的文件用这个 + name 定位'),
    fileId: z.union([z.string(), z.number()]).optional().describe('文件的 file_id（一般不用传）'),
    name: z.string().optional().describe('文件名：给 text 时是存进柜子用的名字；定位聊天附件时可只写一部分'),
    saveAs: z.string().optional().describe('存进柜子时改用的名字（不改就用原文件名）'),
    path: z.string().optional().describe('本机文件路径（主人专属）'),
    url: z.string().optional().describe('文件的 http(s) 直链（主人专属）'),
    text: z.string().optional().describe('直接存的正文（笔记、配额、清单这类；配合 name 指定文件名）'),
    note: z.string().optional().describe('一句备注，会写进文件柜索引')
  },
  async ({ key, token, messageId, forwardId, fileId, name, saveAs, path: filePath, url, text, note }) => {
    try {
      const keyStr = String(key || '').trim();
      const denied = await ownerOnlyError(key, token);
      const isOwner = !denied;
      let ident = null;
      if (!isOwner) {
        ident = await resolveAgentIdentity(token);
        if (!ident || !ident.key) return { content: [{ type: 'text', text: denied }], isError: true };
        if (ident.key !== keyStr) {
          return { content: [{ type: 'text', text: 'key 和会话令牌对不上（令牌属于 ' + ident.key + '），不存。' }], isError: true };
        }
        if (String(filePath || '').trim() || String(url || '').trim()) {
          return { content: [{ type: 'text', text: '只有主人能用 path/url 存本机或网上的文件。本会话里收到的附件请传 messageId / forwardId / name。' }], isError: true };
        }
      }
      const wantedPath = String(filePath || '').trim();
      const wantedUrl = String(url || '').trim();
      const wantedText = text == null ? '' : String(text);
      const wantName = String(saveAs || name || '').trim();
      const hasMessage = Boolean(String(messageId || '').trim() || String(forwardId || '').trim() || String(fileId || '').trim());
      let buffer = null;
      let fileName = wantName;
      let via = '';
      if (wantedText) {
        buffer = Buffer.from(wantedText, 'utf8');
        via = 'text';
        if (!fileName) {
          const d = new Date();
          const p2 = (x) => String(x).padStart(2, '0');
          fileName = '记录-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + '.txt';
        }
      } else if (wantedPath) {
        const abs = assertReadableLocalPath(wantedPath, { workspaceRoot: WORKSPACE_ROOT, stellarRoot: ROOT, dshHome: dshHome() });
        const stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error('path 不是文件：' + wantedPath);
        if (stat.size > CABINET_MAX_BYTES) throw new Error('文件太大（' + humanBytes(stat.size) + '），文件柜上限 ' + humanBytes(CABINET_MAX_BYTES));
        buffer = fs.readFileSync(abs);
        if (!fileName) fileName = path.basename(abs);
        via = 'path';
      } else if (wantedUrl) {
        buffer = await fetchFileBuffer(wantedUrl, { maxBytes: CABINET_MAX_BYTES });
        if (!fileName) fileName = decodeURIComponent(wantedUrl.split('?')[0].split('/').pop() || '文件');
        via = 'url';
      } else if (hasMessage || fileName) {
        const found = findFileEntry(key, { messageId, forwardId, fileId, name });
        if (found.error) return { content: [{ type: 'text', text: '存不了：' + found.error }], isError: true };
        const file = found.file;
        // name 在这里可能只是「用来定位的一部分名字」，不能拿来当文件名；只有 saveAs 才改名字。
        fileName = String(saveAs || '').trim() || String(file.name || '').trim() || '未命名文件';
        buffer = await fetchFileBuffer(await fileDownloadUrl(file, key, { allowOwnerFallback: isOwner }), { allowPrivate: true, maxBytes: CABINET_MAX_BYTES });
        via = 'message';
      } else {
        return { content: [{ type: 'text', text: '要存哪一份？传 messageId / name（聊天里的附件）、path、url 或 text 之一。' }], isError: true };
      }
      if (!buffer || !buffer.length) throw new Error('拿到的是空内容');
      if (buffer.length > CABINET_MAX_BYTES) throw new Error('文件太大（' + humanBytes(buffer.length) + '），文件柜上限 ' + humanBytes(CABINET_MAX_BYTES));
      const dir = cabinetDir(dshHome());
      const saved = saveToCabinet(dir, fileName, buffer, { by: isOwner ? 'owner' : 'stellar', note: String(note || '').trim() });
      if (!saved || saved.ok !== true) {
        return { content: [{ type: 'text', text: '没存成：' + ((saved && saved.message) || '未知错误') }], isError: true };
      }
      let count = 0;
      try { count = listCabinetNames(dir).length; } catch { count = 0; }
      const head = ['已存进文件柜：' + saved.name + '（' + humanBytes(saved.bytes) + ' · ' + saved.kind + '）'];
      if (saved.name !== fileName) head.push('柜里本来就有同名的，这个存成了「' + saved.name + '」（旧的那份没动）');
      head.push('位置：' + dir + '（柜子里现在 ' + count + ' 个文件）');
      head.push('主人问起或者要读内容时：stellar_file_read(path="' + saved.path + '")。');
      return { content: [{ type: 'text', text: head.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '存文件失败：' + (error && error.message ? error.message : error) }], isError: true };
    }
  }
);

server.tool(
  'stellar_prompt_file',
  '读桥接发给你的提示词附件（只读、只能读你自己那两个）。file="stickers" 是你的收藏表情完整清单（编号/情绪/内容），要发表情前先读；file="snapshot" 是本次唤醒的消息快照正文（谁说了什么、seq、时间），唤醒提示里让你先读它再说话。返回纯文本，长文件会截断提示。',
  {
    key: z.string().describe('当前会话 key，形如 private:<QQ> 或 group:<群号>'),
    token: z.string().optional().describe('会话令牌（唤醒提示【会话令牌】那一行的值原样传入）；群聊里也必须传，否则不知道这份快照是谁的'),
    file: z.enum(['stickers', 'snapshot']).describe('stickers = 表情完整清单；snapshot = 本次唤醒的消息快照')
  },
  async ({ key, token, file }) => {
    const wanted = String(file ?? '').trim();
    if (wanted !== 'stickers' && wanted !== 'snapshot') {
      return { content: [{ type: 'text', text: 'file 只能是 stickers 或 snapshot。' }], isError: true };
    }
    // 只认令牌换来的身份，绝不按调用方给的 key 猜——否则谁都能读别人的快照。
    const ident = await resolveAgentIdentity(token);
    if (!ident || !ident.key) {
      return { content: [{ type: 'text', text: '需要会话令牌才能读提示词附件：把提示里【会话令牌】那一行的值原样传到 token。' }], isError: true };
    }
    if (String(key || '').trim() && String(key).trim() !== ident.key) {
      return { content: [{ type: 'text', text: 'key 和令牌对不上（令牌属于 ' + ident.key + '），不读。' }], isError: true };
    }
    const dir = path.join(ROOT, 'state', 'prompt');
    const name = wanted === 'stickers'
      ? 'stickers.md'
      : 'snapshot-' + String(ident.key).replace(/[^A-Za-z0-9:_-]/g, '_').replace(/:/g, '-') + '.md';
    const target = path.join(dir, name);
    const base = path.resolve(dir) + path.sep;
    if (!path.resolve(target).startsWith(base)) {
      return { content: [{ type: 'text', text: '路径不合法。' }], isError: true };
    }
    let body = '';
    try {
      body = fs.readFileSync(target, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          content: [{
            type: 'text',
            text: (wanted === 'stickers'
              ? '还没有表情清单（你一个收藏表情都没有，或桥接刚重启还没生成）。用 qq_list_stickers 看线上有哪些，或先 qq_collect_sticker 收一张。'
              : '这一轮还没有快照文件（可能是没开快照注入，或桥接刚重启还没写过）。需要消息就直接 qq_get_context_snapshot / qq_get_unread_messages 现查。')
          }],
          isError: true
        };
      }
      return { content: [{ type: 'text', text: '读提示词附件失败：' + (error && error.message ? error.message : error) }], isError: true };
    }
    const MAX = 20000;
    if (body.length > MAX) {
      return { content: [{ type: 'text', text: body.slice(0, MAX) + '\n\n…（已截断，全文 ' + body.length + ' 字符）' }] };
    }
    return { content: [{ type: 'text', text: body }] };
  }
);

// 审批执行器：每 5 秒取一次「已批准」的记录，claim 后以主人权限代理执行。
setInterval(() => { tickApprovals(); }, 5000).unref?.();
recoverStaleExecutions();
tickApprovals();

await server.connect(new StdioServerTransport());
