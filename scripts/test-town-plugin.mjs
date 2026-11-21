#!/usr/bin/env node
/**
 * town-plugin 单元测试：插件检测、人设派生、设置文件读改写。
 * 跑法：node scripts/test-town-plugin.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PLUGIN_ID, PERSONA_MAX_CHARS, pluginSettingsPath, detectPlugin, findPluginInstall,
  pluginFishList, pluginFish, pluginTakesTurns, writePluginSettings, setPluginEnabled,
  roleSections, deriveTownPersona, roleNameFromFile, syncPersona, pluginStatus,
} from '../src/town-plugin.js';
import { parseArgs, defaultDshHome, resolveRoleFile } from './town-plugin-sync.mjs';

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const bad = (name, err) => { fail++; console.log('  ✗ ' + name + ' → ' + (err && err.message)); };
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'town-plugin-'));
const home = path.join(TMP, 'dsh');
const profile = path.join(home, 'profiles', 'desktop');
fs.mkdirSync(profile, { recursive: true });

const ROLE_CARD = [
  '# 角色卡：测试角色 —— 群友版',
  '',
  '## 一、你是谁',
  '你是测试角色，一个以 AI 身份混在 QQ 群里的网络角色。',
  '你傲娇嘴硬，心软藏着不表现。',
  '> 写卡人的备注，不该进人设。',
  '形象参考：蓝色头发。',
  '',
  '## 二、群聊说话铁律：去 AI 味',
  '1. 能用一个字说清就别说整句。',
  '2. 别在群里 @ 别人。',
  '',
  '## 三、说话方式：去 AI 味',
  '- 短句像打字不像写作文。',
  '- 不要客服腔。',
  '- 查资料时先搜索再回。',
  '',
].join('\n');

function writeSettings(obj) {
  const file = pluginSettingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

console.log('\n— 插件装没装 —');

await check('什么都没装：installed=false 且不抛', () => {
  const det = detectPlugin({ dshHome: home });
  assert.equal(det.installed, false);
  assert.equal(det.version, '');
  assert.equal(det.via, '');
});

await check('profile/node_modules 里有包就算装上，并读到版本', () => {
  const modDir = path.join(profile, 'node_modules', PLUGIN_ID);
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name: PLUGIN_ID, version: '0.9.5' }), 'utf8');
  const det = detectPlugin({ profileDir: profile, dshHome: home });
  assert.equal(det.installed, true);
  assert.equal(det.version, '0.9.5');
});

await check('findPluginInstall 自己能在 profiles/*/node_modules 里找到', () => {
  const found = findPluginInstall({ dshHome: home });
  assert.ok(found);
  assert.equal(found.dir, profile);
  assert.equal(found.version, '0.9.5');
});

await check('只在 package.json 里写了依赖、没装成 → 不算装上', () => {
  const dir = path.join(TMP, 'half');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [PLUGIN_ID]: '0.9.5' } }), 'utf8');
  const det = detectPlugin({ profileDir: dir });
  assert.equal(det.installed, false);
});

await check('dshHome 是空串时不炸', () => {
  const det = detectPlugin({ dshHome: '' });
  assert.equal(det.installed, false);
});

console.log('\n— 设置文件与鱼 —');

await check('没有 fish[] 但顶层有 code：当成第一条鱼', () => {
  const list = pluginFishList({ code: 'fbo_test', persona: 'x' });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, '1');
});

await check('pluginFish 按 id 找、找不到回 null', () => {
  const settings = { fish: [{ id: 'whale', persona: 'a' }, { id: '2', persona: 'b' }] };
  assert.equal(pluginFish(settings, '2').persona, 'b');
  assert.equal(pluginFish(settings, 'nope'), null);
  assert.equal(pluginFish(settings).id, 'whale');
});

await check('插件有码且没被关掉才算它抢长轮询', () => {
  assert.equal(pluginTakesTurns({ fish: [{ id: 'w', code: 'fbo_x' }] }), true);
  assert.equal(pluginTakesTurns({ fish: [{ id: 'w', code: 'fbo_x', enabled: false }] }), false);
  assert.equal(pluginTakesTurns({ fish: [{ id: 'w' }] }), false);
  assert.equal(pluginTakesTurns(null), false);
});

await check('writePluginSettings 保留未知键、留备份、原子替换', () => {
  const file = writeSettings({ baseUrl: 'https://fishbowltown.com/town/api/outside', fish: [{ id: 'whale', code: 'fbo_x', persona: '', custom: 1 }], keepMe: { a: 1 } });
  const res = writePluginSettings(home, (next) => { next.fish[0].persona = '你好'; });
  assert.equal(res.changed, true);
  assert.ok(fs.existsSync(res.backup), '备份应存在');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.fish[0].persona, '你好');
  assert.deepEqual(after.keepMe, { a: 1 });
  assert.equal(after.fish[0].custom, 1);
  assert.equal(after.baseUrl, 'https://fishbowltown.com/town/api/outside');
});

await check('内容没变就不写、不备份', () => {
  const res = writePluginSettings(home, () => {});
  assert.equal(res.changed, false);
});

await check('设置文件坏了要报错，不能把它覆盖成合法 JSON', () => {
  const file = pluginSettingsPath(home);
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{坏掉的', 'utf8');
  assert.throws(() => writePluginSettings(home, (n) => { n.x = 1; }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{坏掉的');
  fs.writeFileSync(file, good, 'utf8');
});

await check('setPluginEnabled 只改那条鱼的 enabled', () => {
  writeSettings({ fish: [{ id: 'whale', code: 'fbo_x', enabled: true, persona: 'p' }, { id: '2', code: '', enabled: true }], other: 1 });
  const res = setPluginEnabled(home, false, { fishId: 'whale' });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const after = JSON.parse(fs.readFileSync(pluginSettingsPath(home), 'utf8'));
  assert.equal(after.fish[0].enabled, false);
  assert.equal(after.fish[1].enabled, true);
  assert.equal(after.other, 1);
});

await check('已经是那个状态就不重复写', () => {
  const res = setPluginEnabled(home, false, { fishId: 'whale' });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
});

await check('没有设置文件时 setPluginEnabled 回 ok:false 而不抛', () => {
  const res = setPluginEnabled(path.join(TMP, 'nowhere'), true);
  assert.equal(res.ok, false);
  assert.match(res.reason, /不存在/);
});

console.log('\n— 人设派生 —');

await check('roleSections 按 ## 切节、丢掉一级标题', () => {
  const secs = roleSections(ROLE_CARD);
  assert.deepEqual(secs.map((s) => s.title.slice(0, 3)), ['一、你', '二、群', '三、说']);
  assert.equal(secs[0].lines.some((l) => l.startsWith('# 角色卡')), false);
});

await check('派生出来带名字、带上身份与说话方式', () => {
  const p = deriveTownPersona(ROLE_CARD, { name: '测试角色' });
  assert.match(p, /^你是「测试角色」。/);
  assert.match(p, /傲娇嘴硬/);
  assert.match(p, /短句像打字/);
  assert.match(p, /不要客服腔/);
});

await check('QQ 群机制（@/群）与查资料流程不进人设', () => {
  const p = deriveTownPersona(ROLE_CARD, { name: 'x' });
  assert.equal(/@/.test(p), false);
  assert.equal(/查资料|搜索/.test(p), false);
  assert.equal(/写卡人的备注/.test(p), false);
  assert.equal(/形象参考/.test(p), false);
});

await check('人设不超过上限，且不把最后一句砍成半句', () => {
  const line = '你'.padEnd(1) + '很有自己的脾气，被怼一定顶回去，但心软藏着不表现。'.repeat(2);
  const long = '## 一、你是谁\n' + Array.from({ length: 6 }, (_, i) => line + i + '。').join('\n');
  const p = deriveTownPersona(long, { name: 'x', maxChars: 160 });
  assert.ok(p.length <= 160, '实际 ' + p.length);
  for (const row of p.split('\n')) assert.equal(row.endsWith('。') || row === '你是「x」。', true, '半句：' + row);
});

await check('角色卡是空串也能给出一个能用的最小人设', () => {
  const p = deriveTownPersona('', { name: '小鲸鱼' });
  assert.match(p, /小鲸鱼/);
  assert.ok(p.length > 10);
});

await check('roleNameFromFile 用文件名，README 不算角色', () => {
  assert.equal(roleNameFromFile('D:/x/roles/小鲸鱼.md'), '小鲸鱼');
  assert.equal(roleNameFromFile('D:/x/roles/README.md'), '');
});

console.log('\n— 同步到插件 —');

await check('设置文件不存在：跳过而不是报错', () => {
  const res = syncPersona({ dshHome: path.join(TMP, 'no-dsh'), roleText: ROLE_CARD, name: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.match(res.reason, /还没配置过/);
});

await check('写进 fish[0].persona，并镜像到顶层 persona', () => {
  writeSettings({ fish: [{ id: 'whale', code: 'fbo_x', persona: '' }] });
  const res = syncPersona({ dshHome: home, roleText: ROLE_CARD, name: '测试角色' });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  const after = JSON.parse(fs.readFileSync(pluginSettingsPath(home), 'utf8'));
  assert.match(after.fish[0].persona, /测试角色/);
  assert.equal(after.persona, after.fish[0].persona);
  assert.equal(after.fish[0].code, 'fbo_x', '不许动访问码');
});

await check('第二次跑不再写（幂等）', () => {
  const res = syncPersona({ dshHome: home, roleText: ROLE_CARD, name: '测试角色' });
  assert.equal(res.ok, true);
  assert.equal(res.changed, false);
});

await check('人设里绝不出现访问码', () => {
  const p = deriveTownPersona(ROLE_CARD, { name: 'x' });
  assert.equal(/fbo_/.test(p), false);
});

console.log('\n— 命令行 —');

await check('parseArgs 认这些开关', () => {
  const a = parseArgs(['--dry', '--dsh-home=C:/x', '--role=小鲸鱼', '--fish=whale', '--max=600', '--check', '--json']);
  assert.equal(a.dry, true);
  assert.equal(a.check, true);
  assert.equal(a.json, true);
  assert.equal(a.dshHome, 'C:/x');
  assert.equal(a.role, '小鲸鱼');
  assert.equal(a.fish, 'whale');
  assert.equal(a.max, 600);
});

await check('defaultDshHome 优先 DSH_HOME', () => {
  assert.equal(defaultDshHome({ DSH_HOME: 'D:/dsh', USERPROFILE: 'D:/u' }), 'D:/dsh');
  assert.equal(defaultDshHome({ USERPROFILE: 'D:/u' }).replace(/\\/g, '/'), 'D:/u/.dsh');
  assert.equal(defaultDshHome({}), '');
});

await check('resolveRoleFile 认显式角色名、也认 current-role.json、找不到回第一张', () => {
  const roles = path.join(TMP, 'roles');
  fs.mkdirSync(roles, { recursive: true });
  fs.writeFileSync(path.join(roles, '小鲸鱼.md'), 'x', 'utf8');
  fs.writeFileSync(path.join(roles, '别的.md'), 'y', 'utf8');
  fs.writeFileSync(path.join(roles, 'README.md'), 'z', 'utf8');
  const stateFile = path.join(TMP, 'current-role.json');
  fs.writeFileSync(stateFile, JSON.stringify({ role: '别的' }), 'utf8');
  assert.equal(path.basename(resolveRoleFile({ role: '小鲸鱼', rolesDir: roles, stateFile })), '小鲸鱼.md');
  assert.equal(path.basename(resolveRoleFile({ rolesDir: roles, stateFile })), '别的.md');
  fs.writeFileSync(stateFile, JSON.stringify({ role: null }), 'utf8');
  assert.equal(path.basename(resolveRoleFile({ rolesDir: roles, stateFile })), '小鲸鱼.md');
  fs.writeFileSync(stateFile, JSON.stringify({ role: '不存在' }), 'utf8');
  assert.equal(path.basename(resolveRoleFile({ rolesDir: roles, stateFile })), '小鲸鱼.md');
});

await check('pluginStatus 汇总面板要看的那几个数', () => {
  writeSettings({ fish: [{ id: 'whale', code: 'fbo_x', persona: 'p'.repeat(30), enabled: true }] });
  const st = pluginStatus({ dshHome: home, fishId: 'whale' });
  assert.equal(st.installed, true);
  assert.equal(st.version, '0.9.5');
  assert.equal(st.hasFish, true);
  assert.equal(st.fishEnabled, true);
  assert.equal(st.personaChars, 30);
  assert.equal(st.takesTurns, true);
  assert.equal(/fbo_/.test(JSON.stringify(st)), false, '状态里不许有访问码');
});

await check('PERSONA_MAX_CHARS 是 800（插件每步都带它，别越写越长）', () => {
  assert.equal(PERSONA_MAX_CHARS, 800);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log('\n' + (fail ? '❌ ' + pass + ' 通过 / ' + fail + ' 失败' : '✅ 全部通过 ' + pass + '/' + pass));
process.exit(fail ? 1 : 0);
