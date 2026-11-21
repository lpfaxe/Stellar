// 回归（P0 2026-11-11，方案 2）：stellar_* 主人工具的**身份只认会话令牌**。
//
// 旧实现用 state/turn-context.json 判断「最近说话的是不是主人」：主人在 15 分钟内说过话，
// 群友就能诱导模型把 key 写成 private:<主人QQ>，于是 11 个主人专属读工具（含任意文件读取）
// 与 6 个写工具全开。本测试钉住新的判定矩阵，防止以后有人把「没有快照就信任 key」加回来。
//
// 只加载工具回调，不连桥接、不连 OneBot：fetch / fs 都是 fixture。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { z } from 'zod';
import yaml from 'js-yaml';
import * as approvals from '../src/approvals.js';
import * as capabilities from '../src/capabilities.js';
import * as todos from '../src/todos.js';
import * as ownerQuestions from '../src/owner-questions.js';
import * as qqModelView from '../src/qq-model-view.js';
import * as stickerSemantics from '../src/sticker-semantics.js';
import * as costEstimate from '../src/cost-estimate.js';
import * as toolSpill from '../src/tool-spill.js';

const OWNER = '3025145051';
const OWNER_KEY = 'private:' + OWNER;

/**
 * 多行 import 也要剥掉：源码 1396-1408 处有 `import {\n approvalsEnabled,\n ...\n} from './approvals.js';`，
 * 现有 harness 的单行正则会把那一段残留在 vm 里，直接 SyntaxError。
 */
function stripImports(source) {
  const lines = source.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^import\b/.test(lines[i])) { out.push(lines[i]); continue; }
    let j = i;
    while (j < lines.length && !/;\s*$/.test(lines[j])) j += 1;
    i = j;
  }
  return out.join('\n');
}

const fixtureRoots = [];
test.after(() => {
  for (const dir of fixtureRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-identity-'));
  fixtureRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'turn-context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    ownerQQ: OWNER,
    consoleToken: 'fixture-console-token-0001',
    allow: { groups: [], private: [OWNER] }
  }), 'utf8');
  return root;
}

/**
 * 加载 mcp-snowluma-safe.js 的工具回调。
 * identities: 令牌 → { key, kind, isOwner }；mode: /api/status 返回的 mode。
 */
function loadTools({ root, identities, mode, foreignTurnContext, failBridge }) {
  const tools = new Map();
  const source = stripImports(fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8'))
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', `const __dirname = '${path.join(root, 'src').replace(/\\/g, '/')}';`)
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  if (foreignTurnContext) {
    fs.writeFileSync(path.join(root, 'state', 'turn-context.json'), JSON.stringify({
      key: foreignTurnContext,
      kind: foreignTurnContext.startsWith('group:') ? 'group' : 'private',
      isOwner: false,
      userId: '999',
      nickname: '群友',
      at: Date.now()
    }), 'utf8');
  } else {
    try { fs.unlinkSync(path.join(root, 'state', 'turn-context.json')); } catch {}
  }
  const fetchImpl = async (url, init = {}) => {
    if (failBridge) throw new Error('connect ECONNREFUSED');
    const target = String(url);
    if (target.includes('/api/agent/identity')) {
      const token = JSON.parse(String(init.body ?? '{}')).token;
      const hit = identities[token];
      if (!hit) return { ok: false, status: 403, async json() { return { ok: false, error: '会话令牌无效或已轮换' }; } };
      return { ok: true, status: 200, async json() { return { ok: true, ownerQQ: OWNER, ...hit }; } };
    }
    if (target.includes('/api/status')) {
      return { ok: true, status: 200, async json() { return { mode }; } };
    }
    throw new Error('fixture 未预期的桥接调用：' + target);
  };
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    // 小镇工具整块在独立模块里（2026-11-21 拆分）：这里给桩，真要测它请跑专测。
    registerTownTools: () => {},
    z,
    yaml,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    AbortSignal,
    http: { request: () => { throw new Error('fixture 未注入 http'); } },
    process,
    setTimeout,
    clearTimeout,
    // 源码底部有 setInterval(tickApprovals, 5000).unref?.()：测试里不需要后台心跳，
    // 也不能让它把测试进程挂住 —— 给一个立即返回假 handle 的桩。
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    console,
    Buffer,
    path,
    fs,
    os,
    crypto,
    ...approvals,
    ...capabilities,
    ...todos,
    ...ownerQuestions,
    ...qqModelView,
    ...stickerSemantics,
    ...costEstimate,
    ...toolSpill,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value)
  });
  return async (name, args) => {
    const tool = tools.get(name);
    assert.ok(tool, 'tool ' + name + ' 应已注册');
    return tool.callback(z.object(tool.schema).parse(args));
  };
}

const deniedText = (result) => String(result.content?.[0]?.text ?? '');

test('没有令牌、且 QQ 侧有别人的新鲜会话 → 拒绝，并给出可行动的下一步', async () => {
  const root = makeFixture();
  const call = loadTools({ root, identities: {}, mode: 'reserved2', foreignTurnContext: 'group:123456' });
  const result = await call('stellar_rules', { key: OWNER_KEY });
  assert.equal(result.isError, true, '主人 key + 无令牌 + 外来会话 必须被拒');
  const text = deniedText(result);
  assert.match(text, /【会话令牌】/, '必须指出令牌在哪里');
  assert.match(text, /下一步/, '错误必须可行动（AGENTS.md §1.7）');
  assert.match(text, /没有执行/, '必须明确「没有执行」');
});

test('令牌属于群会话，却声明主人 key → 拒绝（confused deputy）', async () => {
  const root = makeFixture();
  const call = loadTools({
    root,
    identities: { 'group-token-fixture': { key: 'group:123456', kind: 'group', isOwner: false } },
    mode: 'reserved2'
  });
  const result = await call('stellar_rules', { key: OWNER_KEY, token: 'group-token-fixture' });
  assert.equal(result.isError, true, '群令牌不能借主人 key 提权');
});

test('令牌解析为主人私聊 → 放行', async () => {
  const root = makeFixture();
  const call = loadTools({
    root,
    identities: { 'owner-token-fixture': { key: OWNER_KEY, kind: 'private', isOwner: true } },
    mode: 'reserved2'
  });
  const result = await call('stellar_rules', { key: OWNER_KEY, token: 'owner-token-fixture' });
  assert.notEqual(result.isError, true, deniedText(result));
  assert.match(deniedText(result), /可查的规则分类/, '应真的执行到 handler');
});

test('内部调度令牌（owner:internal）可以写主人私聊 key', async () => {
  const root = makeFixture();
  const call = loadTools({
    root,
    identities: { 'operator-token-fixture': { key: 'owner:internal', kind: 'internal', isOwner: true } },
    mode: 'reserved2'
  });
  const result = await call('stellar_rules', { key: OWNER_KEY, token: 'operator-token-fixture' });
  assert.notEqual(result.isError, true, deniedText(result));
});

test('主人令牌 + 别人的 key → 拒绝（身份以令牌所属会话为准）', async () => {
  const root = makeFixture();
  const call = loadTools({
    root,
    identities: { 'owner-token-fixture': { key: OWNER_KEY, kind: 'private', isOwner: true } },
    mode: 'reserved2'
  });
  const result = await call('stellar_rules', { key: 'private:999999', token: 'owner-token-fixture' });
  assert.equal(result.isError, true, '令牌与 key 对不上就拒绝');
});

test('桥接不可达 → 失败关闭（不因为连不上就当主人）', async () => {
  const root = makeFixture();
  const call = loadTools({ root, identities: {}, mode: 'reserved2', failBridge: true });
  const result = await call('stellar_rules', { key: OWNER_KEY, token: 'any-token' });
  assert.equal(result.isError, true, '身份无法确认时必须拒绝');
  assert.match(deniedText(result), /下一步/);
});

test('封闭 agent 模式、无令牌、无外来会话 → 放行（主人在面板里直接对话）', async () => {
  const root = makeFixture();
  const call = loadTools({ root, identities: {}, mode: 'closed-agent' });
  const result = await call('stellar_rules', { key: OWNER_KEY });
  assert.notEqual(result.isError, true, deniedText(result));
});

test('reserved2、无令牌、无外来会话 → 放行（主人面板对话的另一条路径）', async () => {
  const root = makeFixture();
  const call = loadTools({ root, identities: {}, mode: 'reserved2' });
  const result = await call('stellar_rules', { key: OWNER_KEY });
  assert.notEqual(result.isError, true, deniedText(result));
});

test('无令牌 + 群 key → 拒绝（不给群友主人工具）', async () => {
  const root = makeFixture();
  const call = loadTools({ root, identities: {}, mode: 'reserved2' });
  const result = await call('stellar_rules', { key: 'group:123456' });
  assert.equal(result.isError, true);
});
