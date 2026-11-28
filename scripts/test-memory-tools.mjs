// 回归（P3 2026-11-13）：三个记忆读工具 —— stellar_memory_catalog / _topic / _search。
//
// 这三个工具是「唤醒只给标题、正文按需查」的查询入口。它们有两条容易坏的地方：
//  1) 身份闸：必须照旧先过 await ownerOnlyError(key, token)，否则群友能借模型翻主人记忆；
//  2) 参数闸：ownerId 只接受 数字QQ / group:<号> / owner:xxx，search 至少 2 字。
// 本测试同时钉住「真的读得到库里的内容」——只测拒绝的话，工具全返回固定字符串也能过。
//
// 注意：DSH_HOME 必须在**任何 src 模块被 import 之前**设好（character-persona.js 在模块加载时算路径），
// 所以本文件先设 env、再顶层 await 动态 import，禁止改成静态 import。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import yaml from 'js-yaml';

const OWNER = '3025145051';
const OWNER_KEY = 'private:' + OWNER;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-memtools-'));
const PREV_DSH_HOME = process.env.DSH_HOME;
process.env.DSH_HOME = ROOT;

const CHAR_DIR = path.join(ROOT, 'stellar', 'characters', 'deepseek');
fs.mkdirSync(path.join(CHAR_DIR, 'memory'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'state', 'turn-context'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'stellar', 'characters', 'current.json'), JSON.stringify({ id: 'deepseek', name: 'DeepSeek恶魔娘', epoch: 1 }), 'utf8');
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
  ownerQQ: OWNER,
  consoleToken: 'fixture-console-token-0001',
  allow: { groups: [], private: [OWNER] }
}), 'utf8');

// 工具里的 memoryDbModule() 是 import(path.join(__dirname,'memory-db.js'))：把 __dirname 指到 fixture src，
// 于是这里必须放一个转发壳，否则会去 import 真实 src 的 memory-db.js（那份连接的是真实库，测试会污染线上记忆）。
// 用 fileURLToPath 而不是 url.pathname：中文目录会被百分号编码，pathname 拿到的是 %E6%A1%8C…
const REAL_SRC = path.dirname(fileURLToPath(import.meta.url));
fs.writeFileSync(path.join(ROOT, 'src', 'memory-db.js'),
  'export * from ' + JSON.stringify(pathToFileURL(path.join(REAL_SRC, '..', 'src', 'memory-db.js')).href) + ';\n', 'utf8');

const approvals = await import('file:///D:/桌面/Dsh/Robot/stellar/src/approvals.js');
const capabilities = await import('file:///D:/桌面/Dsh/Robot/stellar/src/capabilities.js');
const todos = await import('file:///D:/桌面/Dsh/Robot/stellar/src/todos.js');
const ownerQuestions = await import('file:///D:/桌面/Dsh/Robot/stellar/src/owner-questions.js');
const qqModelView = await import('file:///D:/桌面/Dsh/Robot/stellar/src/qq-model-view.js');
const stickerSemantics = await import('file:///D:/桌面/Dsh/Robot/stellar/src/sticker-semantics.js');
const costEstimate = await import('file:///D:/桌面/Dsh/Robot/stellar/src/cost-estimate.js');
const toolSpill = await import('file:///D:/桌面/Dsh/Robot/stellar/src/tool-spill.js');
const memoryDb = await import('file:///D:/桌面/Dsh/Robot/stellar/src/memory-db.js');

test.after(() => {
  try { memoryDb.closeDb(); } catch {}
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
});

/** 多行 import 也要剥掉（源码里有多行 import 块）。 */
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

const IDENTITIES = {
  'owner-token-aaaa': { key: OWNER_KEY, kind: 'private', isOwner: true },
  'group-token-bbbb': { key: 'group:123456', kind: 'group', isOwner: false },
  'friend-token-cccc': { key: 'private:2493502782', kind: 'private', isOwner: false }
};

function loadTools({ mode = 'reserved2' } = {}) {
  const tools = new Map();
  const source = stripImports(fs.readFileSync('D:/桌面/Dsh/Robot/stellar/src/mcp-snowluma-safe.js', 'utf8'))
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '" + path.join(ROOT, 'src').replace(/\\/g, '/') + "';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/api/agent/identity')) {
      const token = JSON.parse(String(init.body ?? '{}')).token;
      const hit = IDENTITIES[token];
      if (!hit) return { ok: false, status: 403, async json() { return { ok: false, error: '会话令牌无效或已轮换' }; } };
      return { ok: true, status: 200, async json() { return { ok: true, ownerQQ: OWNER, ...hit }; } };
    }
    if (target.includes('/api/status')) return { ok: true, status: 200, async json() { return { mode }; } };
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
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    console,
    Buffer,
    path,
    fs,
    os,
    crypto,
    pathToFileURL,
    ...approvals,
    ...capabilities,
    ...todos,
    ...ownerQuestions,
    ...qqModelView,
    ...stickerSemantics,
    ...costEstimate,
    ...toolSpill
  }, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { tools };
}

async function call(tools, name, args) {
  const tool = tools.get(name);
  assert.ok(tool, '工具没注册：' + name);
  const parsed = z.object(tool.schema).parse(args);
  return tool.callback(parsed);
}

function textOf(result) {
  return (result.content || []).map((c) => c.text || '').join('\n');
}

const { tools } = loadTools();

test('三个工具都注册了，且都带 token 参数（身份闸不能漏）', () => {
  for (const name of ['stellar_memory_catalog', 'stellar_memory_topic', 'stellar_memory_page', 'stellar_memory_search']) {
    const tool = tools.get(name);
    assert.ok(tool, name + ' 没注册');
    assert.ok(tool.schema.token, name + ' schema 缺 token');
    assert.ok(tool.schema.key, name + ' schema 缺 key');
  }
});

test('没有令牌 + 存在外来新鲜 turn-context：三个工具全部拒绝', async () => {
  fs.writeFileSync(path.join(ROOT, 'state', 'turn-context.json'), JSON.stringify({
    key: 'group:123456', kind: 'group', isOwner: false, userId: '999', nickname: '群友', at: Date.now()
  }), 'utf8');
  const calls = [
    ['stellar_memory_catalog', { key: OWNER_KEY, limit: 5 }],
    ['stellar_memory_topic', { key: OWNER_KEY, topicId: 'tp_20261113_0001' }],
    ['stellar_memory_search', { key: OWNER_KEY, q: '晚饭' }]
  ];
  for (const [name, args] of calls) {
    const res = await call(tools, name, args);
    assert.equal(res.isError, true, name + ' 应该拒绝');
    assert.match(textOf(res), /【会话令牌】/, name + ' 的拒绝文案要给出下一步');
  }
  fs.unlinkSync(path.join(ROOT, 'state', 'turn-context.json'));
});

test('群会话令牌去读主人 key 的记忆目录：拒绝', async () => {
  const res = await call(tools, 'stellar_memory_catalog', { key: OWNER_KEY, token: 'group-token-bbbb', limit: 5 });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /只有主人/);
});

test('空库：目录说「还没有这条 owner 的话题」，不报错', async () => {
  const res = await call(tools, 'stellar_memory_catalog', { key: OWNER_KEY, token: 'owner-token-aaaa' });
  assert.equal(res.isError, undefined);
  assert.match(textOf(res), new RegExp('还没有 ' + OWNER + ' 的话题'));
});

test('朋友用自己的令牌查自己的记忆：放行（主人举的「A 问你知道我生日吗」场景）', async () => {
  const res = await call(tools, 'stellar_memory_catalog', { key: 'private:2493502782', token: 'friend-token-cccc' });
  assert.equal(res.isError, undefined, '自己的记忆必须能查，否则她只能回「不记得」');
  assert.doesNotMatch(textOf(res), /只有主人/);
});

test('朋友借自己的令牌去查主人口子：拒绝（confused deputy）', async () => {
  const one = await call(tools, 'stellar_memory_catalog', { key: OWNER_KEY, token: 'friend-token-cccc' });
  assert.equal(one.isError, true);
  assert.match(textOf(one), /只有主人/);
  const two = await call(tools, 'stellar_memory_catalog', { key: 'private:2493502782', token: 'friend-token-cccc', ownerId: OWNER });
  assert.equal(two.isError, true);
  assert.match(textOf(two), /只有主人/);
});

test('stellar_memory_fact 注册了，且写操作仍然只给主人', async () => {
  const tool = tools.get('stellar_memory_fact');
  assert.ok(tool, 'stellar_memory_fact 没注册');
  assert.ok(tool.schema.token && tool.schema.key && tool.schema.action);
  const friend = await call(tools, 'stellar_memory_fact', { key: 'private:2493502782', token: 'friend-token-cccc', action: 'write', text: '生日是1月2日', kind: 'birthday', label: '生日' });
  assert.equal(friend.isError, true);
  assert.match(textOf(friend), /只有主人/);
});

test('塞一条真话题后：目录给 id + 标题，topic 工具读得到双方原话', async () => {
  const a = memoryDb.append({ conversationKey: OWNER_KEY, ownerId: OWNER, speakerId: OWNER, speakerName: '主人', role: 'user', text: '晚上吃点啥', at: Date.now() - 60000 });
  const b = memoryDb.appendSelf({ conversationKey: OWNER_KEY, speakerId: '2601728971', speakerName: '她', role: 'self', text: '吃火锅吧，冷。', at: Date.now() - 30000 });
  const ins = memoryDb.insertTopic({
    topic: { ownerId: OWNER, conversationKey: OWNER_KEY, title: '晚上吃点啥', summary: '挑晚饭', importance: 0 },
    rows: [
      { id: a.id, role: 'user', speaker_id: OWNER, speaker_name: '主人', text: '晚上吃点啥', at: a.at, ck: OWNER_KEY, oid: OWNER, day_key: memoryDb.dayKey(a.at) },
      { id: b.id, role: 'self', speaker_id: '2601728971', speaker_name: '她', text: '吃火锅吧，冷。', at: b.at, ck: OWNER_KEY, oid: OWNER, day_key: memoryDb.dayKey(b.at) }
    ]
  });
  assert.equal(ins.ok, true);

  const cat = await call(tools, 'stellar_memory_catalog', { key: OWNER_KEY, token: 'owner-token-aaaa', limit: 5 });
  const catText = textOf(cat);
  assert.match(catText, new RegExp('对象：' + OWNER));
  assert.match(catText, new RegExp(ins.id));
  assert.match(catText, /晚上吃点啥/);
  assert.match(catText, /stellar_memory_topic/);

  const tp = await call(tools, 'stellar_memory_topic', { key: OWNER_KEY, token: 'owner-token-aaaa', topicId: ins.id });
  const tpText = textOf(tp);
  assert.equal(tp.isError, undefined);
  assert.match(tpText, /晚上吃点啥/);
  assert.match(tpText, /吃火锅吧/, '话题正文必须包含她说的那句（出站双写）');

  const miss = await call(tools, 'stellar_memory_topic', { key: OWNER_KEY, token: 'owner-token-aaaa', topicId: 'tp_20990101_9999' });
  assert.equal(miss.isError, true);
  assert.match(textOf(miss), /没有 id=/);
});

test('参数闸：ownerId 非法 / 关键词 1 个字', async () => {
  const bad = await call(tools, 'stellar_memory_catalog', { key: OWNER_KEY, token: 'owner-token-aaaa', ownerId: 'abc' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /ownerId 格式不对/);

  const short = await call(tools, 'stellar_memory_search', { key: OWNER_KEY, token: 'owner-token-aaaa', q: '饭' });
  assert.equal(short.isError, true);
  assert.match(textOf(short), /至少 2 个字/);

  const ok = await call(tools, 'stellar_memory_search', { key: OWNER_KEY, token: 'owner-token-aaaa', q: '火锅' });
  assert.equal(ok.isError, undefined);
  assert.match(textOf(ok), /火锅|没搜到|没有/, '搜到或明确说没搜到，不能空回复');
});


test('主体页：目录给标题、page 工具读正文；朋友不能读主人的私有页', async () => {
  const sub = memoryDb.subjectForOwner(OWNER, { db: memoryDb.openDb({}) });
  assert.ok(sub, '话题落库后主体必须已经建好');
  const page = memoryDb.upsertPage({
    subjectId: sub.id, title: '关于他的学习', body: '他在准备无机化学第七章的思维导图。',
    links: ['无机化学'], sources: ['tp_20261113_0001'], updatedBy: 'dream', db: memoryDb.openDb({}),
  });
  assert.equal(page.ok, true, JSON.stringify(page));

  const cat = await call(tools, 'stellar_memory_catalog', { key: OWNER_KEY, token: 'owner-token-aaaa', limit: 5 });
  assert.match(textOf(cat), /关于他的学习/);
  assert.match(textOf(cat), /stellar_memory_page/);

  const one = await call(tools, 'stellar_memory_page', { key: OWNER_KEY, token: 'owner-token-aaaa', pageId: page.id });
  assert.equal(one.isError, undefined);
  assert.match(textOf(one), /无机化学第七章/);
  assert.match(textOf(one), /来源：tp_20261113_0001/);

  const friend = await call(tools, 'stellar_memory_page', { key: 'private:2493502782', token: 'friend-token-cccc', pageId: page.id });
  assert.equal(friend.isError, true, '朋友不能读主人主体下的页');
  assert.match(textOf(friend), /只有主人|不能|不允许|不是给你的/);
});
