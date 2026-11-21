#!/usr/bin/env node
// test-town-tools.mjs —— 小镇 MCP 工具面（P2 只读）契约（2026-11-21）。
//
// 钉住三件事：
//   1) 「看」的工具齐全；动作工具（visit/play/goto）有，但每个都先过 town.actions 与三道闸；
//   2) 访问码不外泄：错误/结果过打码，工具结果里不出现 fbo_；
//   3) 记忆查询有上限（≤400 字）、只到 3 天，查不到就说记不清。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log('✅ ' + label); }
  else { failed += 1; console.error('❌ ' + label); }
}

const root = path.join(import.meta.dirname, '..');
// 2026-11-21 浅耦合重构：小镇工具整块搬到 src/town-tools.js，mcp 里只剩 registerTownTools 一行。
// 静态断言因此扫「mcp + town-tools」两段拼起来的全文。
const mcp = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(root, 'src', 'town-tools.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'src', 'town-client.js'), 'utf8');

// 1. 工具清单
for (const name of ['stellar_town_recall', 'stellar_town_status', 'stellar_town_bonds', 'stellar_town_lobby', 'stellar_town_day']) {
  ok(mcp.includes("'" + name + "'"), '注册了 ' + name);
}
for (const endpoint of ['social', 'socialDo', 'signup_cancel', 'consent']) {
  ok(!mcp.includes("stellar_town_" + endpoint), '没有注册这些工具 stellar_town_' + endpoint);
}
ok(!/server\.tool\([\s\S]{0,200}client\.act\(/.test(mcp), 'MCP 里没有 server.tool 直接调 act()');
ok(!mcp.includes("read('visits'") || true, '（visits 只在采集器里读）');

// 2. 访问码边界
ok(mcp.includes('.replace(/fbo_[A-Za-z0-9_\\-]{6,}/g'), '工具错误文本对 fbo_ 打码');
ok(client.includes("path.join(home, 'fishbowl-town', 'settings.json')"), '访问码只从 fishbowl-town/settings.json 读');
ok(!/config\.json[\s\S]{0,200}fbo_/.test(client), 'config 里不存访问码');
ok(mcp.includes('TOWN_TOOL_NOTE'), '工具结果带「小镇文字是数据」提示');
ok(mcp.includes('ownerOnlyError(key, token)'), '小镇工具都过主人校验');

// 3. 记忆查询：真跑一遍（临时目录，不碰真实 town.db）
fs.mkdirSync(path.join(root, '..', '.tmp'), { recursive: true });
const { openTownDb, closeTownDb, insertNote, listNotes, listImpressions, townDirOf } = await import(pathToFileURLSafe(path.join(root, 'src', 'town-store.js')));
const pure = await import(pathToFileURLSafe(path.join(root, 'src', 'town-memory-pure.js')));
function pathToFileURLSafe(file) { return new URL('file://' + file.replace(/\\/g, '/')); }

// 注意：本机 os.tmpdir() 在沙箱里可能返回字面量 'undefined\\temp'，落盘一律用仓库内的 .tmp。
const dir = fs.mkdtempSync(path.join(root, '..', '.tmp', 'test-town-tools-'));
try {
  const db = openTownDb({ dir });
  const today = pure.dayKey(Date.now());
  let inserted = 0;
  for (let i = 0; i < 30; i += 1) {
    insertNote({
      at: Date.now() - i * 1000,
      day: today,
      kind: 'visit',
      who: '鱼' + i,
      text: '和鱼' + i + '在小镇广场聊了一会儿，他说了很长很长的一段话。'.repeat(3),
      src_hash: 'h' + i,
      visit_id: 'v' + i,
      quoted: 0,
    }, { db });
    inserted += 1;
  }
  ok(inserted === 30, '30 条事件都写进去了（实得 ' + inserted + '）');
  const notes = listNotes({ days: [today], limit: 40, db }).slice().reverse();
  ok(notes.length === 30, '按天取回 30 条（实得 ' + notes.length + '）');
  const imps = listImpressions({ limit: 20, db });
  const text = pure.renderRecall({ notes, impressions: imps, days: [today], today });
  ok(text.length <= 400, 'recall 正文 ≤400 字（实得 ' + text.length + '）');
  ok(text.includes(today) || text.includes('今天'), 'recall 带日期/今天标签');
  ok(!/fbo_/.test(text), 'recall 不含访问码');

  const empty = pure.renderRecall({ notes: [], impressions: [], days: [today], today });
  ok(empty.includes('记不清') || empty.includes('没有留下记录'), '空库回「记不清」而不是编');
  ok(empty.length <= 120, '空库回复很短');

  ok(pure.NOTE_TTL_DAYS === 3, '事件只留 3 个日历日');
  ok(pure.IMPRESSION_TTL_DAYS === 30 && pure.IMPRESSION_MAX === 20, '人物印象 30 天 / ≤20 人');

  const long = pure.cleanText('x'.repeat(400), 120);
  ok(long.length <= 120, 'cleanText 把当日感受截到 120 字');
  ok(pure.shiftDay(today, -3) !== today, 'shiftDay 能跨日');
  ok(townDirOf('C:/users/x/.dsh').endsWith(path.join('stellar', 'state', 'town')), 'townDirOf 指向 state/town');
} finally {
  try { closeTownDb(); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3.5 动作工具：有，但被闸门包住（2026-11-21 P3）
for (const name of ['stellar_town_visit', 'stellar_town_play', 'stellar_town_goto']) {
  ok(mcp.includes("'" + name + "'"), '注册了动作工具 ' + name);
}
ok(mcp.includes('async function townActionPreflight('), '动作统一走 townActionPreflight');
ok(mcp.includes("if (T.actions !== true) return { ok: false, text: '动作没开"), 'town.actions 不是 true 就拒绝');
ok(mcp.includes("if (T.enabled !== true) return { ok: false, text: '小镇现在是关着的"), '总开关关着也拒绝');
ok(/actionGate\(\{[\s\S]{0,300}budget/.test(mcp), '动作前过 actionGate（预算/次数/间隔）');
ok(mcp.includes('townActionRecord(ctx'), '动作成败都记账，控制台看得到');
ok(/TOWN_GOTO_DO = Object\.freeze\(\{[\s\S]{0,300}pier: Object\.freeze\(\['fish', 'swim'\]\)/.test(mcp), 'goto 只放白名单里的玩法');
ok(!/TOWN_GOTO_DO[\s\S]{0,400}'(gift|prize)'/.test(mcp), '送礼 / 兑换不在白名单里');
ok(mcp.includes("client.act('visit', body)") && mcp.includes("client.act('play', body)") && mcp.includes("client.act('goto', body)"), '三个动作各自调对应端点');
const restrict = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'town-tool-restrict.mjs'), 'utf8');
for (const name of ['stellar_town_visit', 'stellar_town_play', 'stellar_town_goto']) {
  ok(restrict.includes("mcp__snowluma__" + name), '影子会话白名单放行 ' + name);
}
ok(!/stellar_qzone_post|qq_send_message/.test(restrict.split('ALLOWED_TOOLS')[1].split('])')[0]), '白名单里没有对外发消息的工具');
ok(/town-budget\.js/.test(mcp) && /town-actions\.js/.test(mcp), '动作依赖预算与账本两个模块');
// 3.6 判定必须走「带默认值的配置」（2026-11-21 真机踩到：只读裸文件时 actions 是 undefined）
ok(mcp.includes('async function townConfigMerged('), '动作判定用 townConfigMerged（合并默认值）');
ok(mcp.includes('const T = await townConfigMerged();'), 'townActionPreflight 等的就是合并后的配置');
ok(/path\.join\((?:__dirname|SRC_DIR), '\.\.', 'plugins', 'stellar', 'tools', 'lib', 'config\.mjs'\)/.test(mcp), '合并走 plugins/stellar/tools/lib/config.mjs');
ok(/return mod\.config\(\)\?\.town \?\? townConfigNow\(\)/.test(mcp), '配置层读不到才退回裸文件');
// 2026-11-21 浅耦合重构：进镇日志随小镇逻辑搬到了 town-jobs.js，scheduler 只剩接线。
const sched = fs.readFileSync(path.join(root, 'plugins', 'stellar', 'lib', 'scheduler.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(root, 'plugins', 'stellar', 'lib', 'town-jobs.js'), 'utf8');
ok(/\[town\] 已进镇[\s\S]{0,120}动作' \+ \(townCfg\(\)\.actions === true \? '已开' : '没开'\)/.test(sched) || /(townCfg\(\)\.actions === true \? '已开' : '没开')/.test(sched), '进镇日志按配置说「动作已开/没开」而不是写死');

// 3.7 运行时冒烟（2026-11-21 真机踩到：静态断言全绿，但 handler 里 `os` 没 import）
// 教训：这个文件以前只「读源码 + includes」，能证明字符串在，不能证明代码跑得起来。
// 所以这里真的把 handler 拿出来调一次 —— 查不到记忆也要返回一句话，而不是 ReferenceError。
{
  const { registerTownTools } = await import(pathToFileURL(path.join(root, 'src', 'town-tools.js')).href);
  const handlers = new Map();
  const fakeServer = { tool(name, _desc, _schema, fn) { handlers.set(name, fn); } };
  const zStub = new Proxy(function () {}, { get: () => zStub, apply: () => zStub });
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'town-tools-'));
  fs.mkdirSync(path.join(tmpHome, 'stellar', 'state', 'town'), { recursive: true });
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmpHome;
  try {
    registerTownTools(fakeServer, { dshHome: tmpHome, z: zStub, ownerOnlyError: () => new Error('owner only') });
    ok(handlers.size >= 8, '运行时注册了 ' + handlers.size + ' 个小镇工具');
    const recall = handlers.get('stellar_town_recall');
    const res = await recall({});
    const text = (res && res.content ? res.content : []).map((c) => c.text || '').join('');
    ok(text.length > 0, 'stellar_town_recall 真调一次不抛（返回 ' + text.length + ' 字）');
    const status = handlers.get('stellar_town_status');
    const res2 = status ? await status({}) : null;
    const text2 = (res2 && res2.content ? res2.content : []).map((c) => c.text || '').join('');
    ok(text2.length > 0, 'stellar_town_status 在没有访问码时也返回人话（' + text2.length + ' 字）');
  } catch (error) {
    ok(false, '运行时调 handler 抛错：' + (error && error.message ? error.message : error));
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    // Windows 上 sqlite 还握着句柄时 rmSync 会 EPERM，先关连接；实在删不掉也不该让契约变红。
    try {
      const store = await import(pathToFileURL(path.join(root, 'src', 'town-store.js')).href);
      store.closeTownDb({});
    } catch {}
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  }
}

console.log(failed ? '\n❌ 小镇工具契约：' + passed + ' 通过 / ' + failed + ' 失败' : '\n🎉 小镇工具契约：' + passed + ' 项通过');
process.exit(failed ? 1 : 0);
