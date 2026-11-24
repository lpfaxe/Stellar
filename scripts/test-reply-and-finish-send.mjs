// 回归（2026-11-22）：qq_reply_and_finish 的单条路径把字段写成了 message（单数），
// 而桥接只读 messages（复数）⇒ 400「key 和 messages 不能为空」。
//
// 证据（state/tool-calls.jsonl + .1，2026-11-10 至 11-22）：
//   messages 是普通字符串 → 50 次调用 **0 成功**
//   messages 是真数组     → 79 次调用 77 成功（2 次是敏感信息拦截，属于设计内）
//   messages 是数组字符串 → 14 次调用 14 成功
// 模型于是学会「拆成 qq_send_message + qq_close_conversation 两步」，多付一倍上下文。
//
// 这条钉子同时钉住另一件事：qq_send_message 与 qq_reply_and_finish 必须**共用**
// 同一个归一函数，发出去的字段名只能是 messages —— 两个工具各写一份归一逻辑正是本次漂移的根因。
//
// 只加载工具回调（vm + fixture），不连桥接、不连 OneBot。
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-reply-send-'));
  fixtureRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    ownerQQ: OWNER,
    consolePort: 3100,
    consoleToken: 'fixture-console-token-0001',
    allow: { groups: [], private: [OWNER] }
  }), 'utf8');
  return root;
}

/** 加载工具回调，fetch 全部拦下来记进 posts（桥接零依赖）。 */
function loadTools(root) {
  const tools = new Map();
  const posts = [];
  const source = stripImports(fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8'))
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', `const __dirname = '${path.join(root, 'src').replace(/\\/g, '/')}';`)
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    posts.push({
      path: target.replace(/^https?:\/\/[^/]+/, ''),
      body: init.body ? JSON.parse(String(init.body)) : null
    });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
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
  return {
    posts,
    call: async (name, args) => {
      const tool = tools.get(name);
      assert.ok(tool, 'tool ' + name + ' 应已注册');
      return tool.callback(z.object(tool.schema).parse(args));
    }
  };
}

const text = (result) => String(result.content?.[0]?.text ?? '');
const find = (posts, p) => posts.filter((x) => x.path === p);

test('单条字符串 → 走 send-message，字段是 messages（复数），并接着收尾', async () => {
  const { call, posts } = loadTools(makeFixture());
  const result = await call('qq_reply_and_finish', {
    key: OWNER_KEY, token: 'owner-token', messages: '对，21号，就是明天~', summary: '确认日期', throughSeq: 483
  });
  assert.notEqual(result.isError, true, text(result));
  const sends = find(posts, '/api/socialV2/send-message');
  assert.equal(sends.length, 1, '单条必须走 send-message 一次');
  assert.equal(find(posts, '/api/socialV2/send-burst').length, 0, '单条不该走 send-burst');
  assert.equal(sends[0].body.messages, '对，21号，就是明天~', '字段名必须是 messages，值就是那句话');
  assert.equal(sends[0].body.message, undefined, '不许再出现 message（单数）字段');
  assert.equal(find(posts, '/api/socialV2/close').length, 1, '发完必须收尾');
});

test('真数组（多条）→ send-burst，messages 保持数组', async () => {
  const { call, posts } = loadTools(makeFixture());
  const result = await call('qq_reply_and_finish', {
    key: OWNER_KEY, token: 'owner-token', messages: ['第一句', '第二句']
  });
  assert.notEqual(result.isError, true, text(result));
  const bursts = find(posts, '/api/socialV2/send-burst');
  assert.equal(bursts.length, 1);
  assert.deepEqual(bursts[0].body.messages, ['第一句', '第二句']);
  assert.equal(find(posts, '/api/socialV2/send-message').length, 0, '多条不该走单发');
});

test('数组的 JSON 字符串 → 按多条发', async () => {
  const { call, posts } = loadTools(makeFixture());
  const result = await call('qq_reply_and_finish', {
    key: OWNER_KEY, token: 'owner-token', messages: '["记好啦，明早8:30叫你", "活动中心一楼"]'
  });
  assert.notEqual(result.isError, true, text(result));
  const bursts = find(posts, '/api/socialV2/send-burst');
  assert.equal(bursts.length, 1);
  assert.deepEqual(bursts[0].body.messages, ['记好啦，明早8:30叫你', '活动中心一楼']);
});

test('单条的 JSON 字符串（"\"你好\""）→ 拆成一句话发，不把引号发出去', async () => {
  const { call, posts } = loadTools(makeFixture());
  const result = await call('qq_reply_and_finish', {
    key: OWNER_KEY, token: 'owner-token', messages: '"你好"'
  });
  assert.notEqual(result.isError, true, text(result));
  const sends = find(posts, '/api/socialV2/send-message');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.messages, '你好');
});

test('空字符串 messages → 明确失败且一个请求都不发（不能假装发过）', async () => {
  for (const bad of ['', '   ', '["", "  "]']) {
    const { call, posts } = loadTools(makeFixture());
    const result = await call('qq_reply_and_finish', { key: OWNER_KEY, token: 'owner-token', messages: bad });
    assert.equal(result.isError, true, '空内容必须报错');
    assert.match(text(result), /没有可发送的内容/, '错误要说明没发出去');
    assert.equal(posts.length, 0, '空内容不许碰桥接');
  }
});

test('空数组被 schema 拦下（数组至少一条，不会落到桥接）', async () => {
  const { call, posts } = loadTools(makeFixture());
  await assert.rejects(
    () => call('qq_reply_and_finish', { key: OWNER_KEY, token: 'owner-token', messages: [] }),
    /Too small|>=1 items/,
    '空数组应该在入参校验就失败'
  );
  assert.equal(posts.length, 0);
});

test('qq_send_message 与 reply_and_finish 发的字段名一致（都是 messages）', async () => {
  const { call, posts } = loadTools(makeFixture());
  const result = await call('qq_send_message', { key: OWNER_KEY, token: 'owner-token', messages: '只有一句' });
  assert.notEqual(result.isError, true, text(result));
  const sends = find(posts, '/api/socialV2/send-message');
  assert.equal(sends.length, 1);
  assert.ok(sends[0].body.messages, 'qq_send_message 也必须带 messages');
  assert.equal(sends[0].body.message, undefined);
});
