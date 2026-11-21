// 回归（2026-11-11）：她能不能去通讯录成员的空间看动态、点赞、评论、回复？
//
// 以前只有「主人 + 她自己」两个号能互动（qzoneAllowedUins 白名单），通讯录里的
// 朋友/测试号一律被拒；qzone read 也只有 owner/mine/friends 三个 scope，
// 而 friends 流只给第一页、按时间混排，别人的说说稍微旧一点就翻不到了。
// 这一版加 scope=person + uin，并把白名单放开到整个通讯录。
//
// 本测试只验「MCP 层把参数拼对、白名单放对」：CLI 用桩替换（不连 OneBot），
// 真实链路用 node bili.mjs qzone read --scope person --uin <QQ> 手工验过。
import assert from 'node:assert/strict';
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
const FRIEND = '3909220047';
const TESTER = '2493502782';
const OWNER_TOKEN = 'owner-token-fixture';
// 主人私聊的会话令牌：桥接 /api/agent/identity 会把它解析成 private:<ownerQQ>。
const OWNER_IDENTITIES = { [OWNER_TOKEN]: { key: OWNER_KEY, token: OWNER_TOKEN, kind: 'private', isOwner: true } };

const fixtureRoots = [];
test.after(() => {
  for (const dir of fixtureRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-person-'));
  fixtureRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'turn-context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    ownerQQ: OWNER,
    consoleToken: 'fixture-console-token-0001',
    allow: { groups: [], private: [OWNER] }
  }), 'utf8');
  // 通讯录 fixture：主人、一个朋友、一个测试号（stranger）
  fs.writeFileSync(path.join(root, 'state', 'friends.json'), JSON.stringify({
    people: [
      { uin: OWNER, nickname: '主人', type: 'owner' },
      { uin: FRIEND, nickname: '朋友', type: 'friend' },
      { uin: TESTER, nickname: '测试员A', type: 'stranger' }
    ],
    groups: []
  }), 'utf8');
  return root;
}

/**
 * 加载工具回调。spawn 用桩：把每次 CLI 调用记下来直接返回固定输出，
 * 这样不用连 OneBot 也能验「MCP 有没有把 --scope person --uin 拼对」。
 */
function loadTools({ root, scriptOutput = '', scriptCode = 0, identities = {}, mode = 'reserved2' } = {}) {
  const calls = [];
  const tools = new Map();
  const source = stripImports(fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8'))
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', 'const __dirname = ' + JSON.stringify(path.join(root, 'src')) + ';')
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  const fakeSpawn = () => {
    const handlers = {};
    const child = {
      stdout: { on: (ev, fn) => { handlers['out:' + ev] = fn; } },
      stderr: { on: (ev, fn) => { handlers['err:' + ev] = fn; } },
      on: (ev, fn) => { handlers['c:' + ev] = fn; },
      kill: () => {}
    };
    setImmediate(() => {
      if (scriptOutput) handlers['out:data']?.(Buffer.from(scriptOutput));
      handlers['c:close']?.(scriptCode);
    });
    return child;
  };
  const spawnSpy = (bin, argv, opts) => { calls.push({ bin, argv, opts }); return fakeSpawn(); };
  class McpServer {
    constructor() { this.tool = (name, description, schema, callback) => tools.set(name, { schema, callback }); }
    connect() {}
  }
  vm.runInNewContext(source, {
    McpServer,
    StdioServerTransport: class {},
    // 小镇工具整块在独立模块里（2026-11-21 拆分）：这里给桩，真要测它请跑专测。
    registerTownTools: () => {},
    z, yaml, URL, URLSearchParams, AbortSignal, process, setTimeout, clearTimeout, console, Buffer, path, fs, os,
    // 身份闸：identities 里没有的 token 一律 403（失败关闭），与真实桥接一致。
    fetch: async (url, init = {}) => {
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
      return { ok: false, status: 503, async json() { return {}; } };
    },
    http: { request: () => { throw new Error('fixture 未注入 http'); } },
    spawn: spawnSpy,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    ...approvals, ...capabilities, ...todos, ...ownerQuestions, ...qqModelView,
    ...stickerSemantics, ...costEstimate, ...toolSpill,
    SENSITIVE_RE: { test: () => false },
    serializeModelData: (value) => JSON.stringify(value)
  });
  const call = async (name, args) => {
    const tool = tools.get(name);
    assert.ok(tool, 'tool ' + name + ' 应已注册');
    return tool.callback(z.object(tool.schema).parse(args));
  };
  return { call, calls };
}

const textOf = (result) => String(result.content?.[0]?.text ?? '');

test('scope=person 会把 --scope person --uin 传给 CLI（读某个人的空间）', async () => {
  const root = makeFixture();
  const { call, calls } = loadTools({ root, scriptOutput: TESTER + ' 的空间：共 1 条' , identities: OWNER_IDENTITIES });
  const result = await call('stellar_qzone_read', { key: OWNER_KEY, token: OWNER_TOKEN, scope: 'person', uin: TESTER, attachImages: false });
  assert.notEqual(result.isError, true, textOf(result));
  const qz = calls.filter((c) => c.argv.includes('qzone'));
  assert.ok(qz.length, '应该调到 qzone 脚本');
  const readCall = qz.find((c) => c.argv.includes('read'));
  assert.ok(readCall, '应该调 read');
  assert.ok(readCall.argv.includes('person'), '应带 person scope');
  const i = readCall.argv.indexOf('--uin');
  assert.ok(i > 0 && readCall.argv[i + 1] === TESTER, '应把那个人的 QQ 传下去');
});

test('scope=person 不给 uin → 直接拒绝并说明要给谁', async () => {
  const root = makeFixture();
  const { call } = loadTools({ root , identities: OWNER_IDENTITIES });
  const result = await call('stellar_qzone_read', { key: OWNER_KEY, token: OWNER_TOKEN, scope: 'person', attachImages: false });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /uin/, '要告诉调用方缺 uin');
});

test('通讯录里的朋友也能点赞（白名单放开到整个通讯录）', async () => {
  const root = makeFixture();
  const { call, calls } = loadTools({ root, scriptOutput: '✓ 已点赞' , identities: OWNER_IDENTITIES });
  const result = await call('stellar_qzone_react', { key: OWNER_KEY, token: OWNER_TOKEN, action: 'like', tid: '3ed59f945c6cf46adf5a0500', uin: TESTER });
  assert.doesNotMatch(textOf(result), /不在通讯录里/, '不该再被白名单拦下：' + textOf(result));
  const likeCall = calls.find((c) => c.argv.includes('like'));
  assert.ok(likeCall, '应该真的去点赞');
  assert.ok(likeCall.argv.includes('--uin') && likeCall.argv.includes(TESTER), '点赞要带 target_uin');
});

test('通讯录外的号仍然被拒（白名单没有全放开）', async () => {
  const root = makeFixture();
  const { call } = loadTools({ root, scriptOutput: '✓ 已点赞' , identities: OWNER_IDENTITIES });
  const result = await call('stellar_qzone_react', { key: OWNER_KEY, token: OWNER_TOKEN, action: 'like', tid: 'x', uin: '123456789' });
  assert.equal(result.isError, true, '不在通讯录里的人不该能赞');
  assert.match(textOf(result), /不在通讯录里/);
});

test('评论会走 --dry（演练）而不是直接发出去', async () => {
  const root = makeFixture();
  const { call, calls } = loadTools({ root, scriptOutput: '=== 评论 ===' , identities: OWNER_IDENTITIES });
  await call('stellar_qzone_react', { key: OWNER_KEY, token: OWNER_TOKEN, action: 'comment', tid: '3ed59f945c6cf46adf5a0500', uin: TESTER, text: '看着不错' });
  const cc = calls.find((c) => c.argv.includes('comment') && c.argv.includes('qzone'));
  assert.ok(cc, '应该调 comment');
  assert.ok(cc.argv.includes('--dry'), '不带 go 时必须只演练');
  assert.ok(!cc.argv.includes('--go'), '不带 go 时不能真发');
});

test('回复某条评论会带 --cid/--cuin', async () => {
  const root = makeFixture();
  const { call, calls } = loadTools({ root, scriptOutput: '✓' , identities: OWNER_IDENTITIES });
  await call('stellar_qzone_react', {
    key: OWNER_KEY, action: 'comment', tid: '3ed59f945c6cf46adf5a0500', uin: TESTER,
    text: '同感', commentId: '1', commentUin: TESTER
  });
  const cc = calls.find((c) => c.argv.includes('comment') && c.argv.includes('qzone'));
  const i = cc.argv.indexOf('--cid');
  assert.ok(i > 0 && cc.argv[i + 1] === '1', '要带父评论 id');
  const j = cc.argv.indexOf('--cuin');
  assert.ok(j > 0 && cc.argv[j + 1] === TESTER, '要带父评论作者');
});
