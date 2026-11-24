// 无令牌发送的兜底判定（2026-11-22，主人 m04974 选 B）。
//
// 背景：reserved2 模式下发送类 MCP 工具要求带 `token`，模型偶尔漏填 —— zod 在 MCP 层就
// 把整条请求拒了（`expected string, received undefined at token`），消息直接丢。2026-11-21~22
// 有 16 次这种丢失。主人拍板：允许桥接「按 key 兜底」，但只兜一个很窄的口子。
//
// 放行必须同时满足三条，缺一不可：
//   1. 请求里**没有**令牌（带了令牌就必须照常校验，不能因为兜底而放宽）；
//   2. 请求声明了 `x-agent-call`（说明是 MCP 工具发起的，不是随便一个本机脚本）；
//   3. 这个 key **此刻**正处在唤醒回合里（pendingWakeKeys），也就是模型确实在替这个会话说话。
// 这样即使有人拿到本机权限乱发，也只能落到「正在跑的那一轮」的那一个 key 上，不能跨会话冒充。
export const AGENT_CALL_HEADER = 'x-agent-call';
export const AGENT_TOKEN_HEADER = 'x-agent-token';

/** 从一个 header 袋子里取字符串（Node 的 req.headers 可能是数组/未定义）。 */
function headerText(bag, name) {
  const value = bag && (bag[name] ?? bag[String(name).toLowerCase()]);
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/**
 * 纯判定：不发请求、不改状态。
 * @param {{ headers?: Record<string, unknown>, key?: string, pendingKeys?: { has: (k: string) => boolean } }} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export function tokenlessTurnDecision(input = {}) {
  const headers = input.headers ?? {};
  const presented = headerText(headers, AGENT_TOKEN_HEADER);
  if (presented) return { allowed: false, reason: 'token-presented' };
  if (headerText(headers, AGENT_CALL_HEADER) === '') return { allowed: false, reason: 'no-agent-call' };
  const key = String(input.key ?? '').trim();
  if (!key) return { allowed: false, reason: 'no-key' };
  const pending = input.pendingKeys;
  if (!pending || typeof pending.has !== 'function') return { allowed: false, reason: 'no-pending-set' };
  if (!pending.has(key)) return { allowed: false, reason: 'key-not-waking' };
  return { allowed: true, reason: 'tokenless-wake-turn' };
}

/** 给 HTTP 层用的一句话解释（写进 403 的 message，方便以后排查）。 */
export function tokenlessDeniedHint(reason) {
  switch (reason) {
    case 'token-presented':
      return '本次请求带了会话令牌，但校验没通过（令牌可能已被轮换）';
    case 'no-agent-call':
      return '请求既没带会话令牌，也没声明 x-agent-call';
    case 'key-not-waking':
      return '这个会话此刻没有正在跑的唤醒回合，桥接无法按 key 兜底';
    default:
      return '缺少会话令牌';
  }
}
