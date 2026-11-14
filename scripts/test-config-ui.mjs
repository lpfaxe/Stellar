#!/usr/bin/env node
// 配置编辑器的判据。
// 只测能确定性验证的部分：合并/校验/落盘/备份、以及「它不会做哪些事」的静态约束。
// 原生文件对话框（PowerShell -STA）依赖桌面环境，这里不碰；那属于打开页面后的手工验收。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deepMerge, checkConfigPath, readConfigFile, writeConfigFile, backupName,
  validateConfig, countPreserved, isPlainObject,
} from './config-ui-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
  if (condition) { pass += 1; console.log('✅ ' + name); } else { fail += 1; console.log('❌ ' + name + (detail ? '  → ' + detail : '')); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), '实得 ' + JSON.stringify(actual));
const section = (name) => console.log('## ' + name);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-config-ui-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

section('1. 深合并：表单没覆盖的键必须活下来');
{
  const base = { a: { b: 1, c: 2 }, list: [1, 2], name: 'x', keep: { deep: { v: true } } };
  const patch = { a: { b: 9 }, list: [3] };
  const merged = deepMerge(base, patch);
  eq('不相关的兄弟键保留', merged.a.c, 2);
  eq('被覆盖的键生效', merged.a.b, 9);
  eq('数组整体替换（不是拼接）', merged.list, [3]);
  eq('顶层未提及的键保留', merged.name, 'x');
  eq('深层未提及的键保留', merged.keep.deep.v, true);
  eq('原对象没被就地改动', base.a.b, 1);
  eq('patch 里 undefined 不覆盖', deepMerge({ a: 1 }, { a: undefined }).a, 1);
  const created = deepMerge({}, { role: { maxInjectChars: 6000 } });
  eq('空对象也能长出嵌套结构', created.role.maxInjectChars, 6000);
}

section('2. 路径检查：不猜、不自动找');
{
  const missing = fs.mkdtempSync(path.join(TMP, 'no-such-'));
  fs.rmSync(missing, { recursive: true, force: true });
  ok('空路径被拒', checkConfigPath('').ok === false);
  ok('相对路径被拒（不会拿 cwd 去猜）', checkConfigPath('config.json').ok === false);
  ok('非 .json 被拒', checkConfigPath(path.join(TMP, 'a.txt')).ok === false);
  ok('不存在的目录被拒', checkConfigPath(path.join(missing, 'config.json')).ok === false);
  const okPath = checkConfigPath(path.join(TMP, 'config.json'));
  ok('目录存在但文件还没建 → 允许（用于新建）', okPath.ok === true, okPath.error);
}

section('3. 读写：脏文件、BOM、非对象');
{
  const file = path.join(TMP, 'good.json');
  fs.writeFileSync(file, '\uFEFF{"a":1}\n', 'utf8');
  const read = readConfigFile(file);
  ok('带 BOM 也能读（记事本存过的文件很常见）', read.ok && read.config.a === 1, read.error);

  const broken = path.join(TMP, 'broken.json');
  fs.writeFileSync(broken, '{"a":1,}', 'utf8');
  const bad = readConfigFile(broken);
  ok('坏 JSON 报错而不是抛异常', bad.ok === false && /JSON/.test(bad.error), bad.error);

  const arr = path.join(TMP, 'array.json');
  fs.writeFileSync(arr, '[1,2]', 'utf8');
  ok('顶层不是对象 → 拒绝（桥接读不了这种）', readConfigFile(arr).ok === false);

  const empty = path.join(TMP, 'empty.json');
  fs.writeFileSync(empty, '   ', 'utf8');
  ok('空文件 → 明确说空', readConfigFile(empty).ok === false);
}

section('4. 写入：备份、幂等、原子');
{
  const file = path.join(TMP, 'write.json');
  const first = writeConfigFile(file, { a: 1 });
  ok('新建文件记为有变化', first.ok && first.changed === true);
  ok('新建时没有备份（原本就不存在）', first.backup === '');
  ok('文件真的写出来了', readConfigFile(file).ok);

  const now = new Date(2026, 10, 14, 0, 45, 3);
  const second = writeConfigFile(file, { a: 2 }, { now });
  ok('改内容 → 有变化', second.changed === true);
  ok('备份名带时间戳', path.basename(second.backup) === 'write.json.bak-20261114-004503', path.basename(second.backup));
  ok('备份文件存在且是旧内容', JSON.parse(fs.readFileSync(second.backup, 'utf8')).a === 1);

  const third = writeConfigFile(file, { a: 2 });
  ok('内容没变 → 不写盘、不产生新备份', third.changed === false && third.backup === '');
  eq('文件内容是 2 空格缩进 + 尾随换行', fs.readFileSync(file, 'utf8'), '{\n  "a": 2\n}\n');
  const leftovers = fs.readdirSync(TMP).filter((n) => n.includes('.tmp-'));
  eq('没有留下临时文件', leftovers, []);
  ok('backupName 与日期无关时稳定', backupName('x.json', new Date(2026, 0, 2, 3, 4, 5)).endsWith('.bak-20260102-030405'));
}

section('5. 校验：能挡住的必须是「会让桥接起不来」的');
{
  ok('空对象合法', validateConfig({}).ok === true);
  ok('ownerQQ 写成字符串名字被拒', validateConfig({ ownerQQ: '小明' }).ok === false);
  ok('ownerQQ 空串合法（还没填）', validateConfig({ ownerQQ: '' }).ok === true);
  ok('ownerQQ 纯数字合法', validateConfig({ ownerQQ: '1000000001' }).ok === true);
  ok('allow.private 里混了字母被拒', validateConfig({ allow: { private: ['123', 'abc'] } }).ok === false);
  ok('allow.groups 不是数组被拒', validateConfig({ allow: { groups: '123' } }).ok === false);
  ok('dsUrl 缺协议被拒', validateConfig({ dsh: { baseUrl: '127.0.0.1:3080' } }).ok === false);
  ok('wsUrl 用 http 前缀被拒', validateConfig({ snowluma: { wsUrl: 'http://x' } }).ok === false);
  ok('consolePort 超范围被拒', validateConfig({ consolePort: 70000 }).ok === false);
  ok('consolePort 0 合法（自动挑端口）', validateConfig({ consolePort: 0 }).ok === true);
  ok('consoleToken 太短被拒', validateConfig({ consoleToken: 'short' }).ok === false);
  ok('consoleToken 留空合法（自动生成）', validateConfig({ consoleToken: '' }).ok === true);
  ok('consoleToken 带空格被拒', validateConfig({ consoleToken: 'abcdefghijklmnop qrstuvwx' }).ok === false);
  ok('sendDelayMs 负数被拒', validateConfig({ sendDelayMs: -1 }).ok === false);
  const many = validateConfig({ ownerQQ: 'bad', consolePort: 99999 });
  ok('多个错误一起报（不是只报第一个）', many.errors.length === 2, JSON.stringify(many.errors));
  ok('错误带字段名，页面上能定位', many.errors.every((e) => typeof e.field === 'string' && e.field.length > 0));
}

section('6. 「保留了多少键」的统计');
{
  const config = { dsh: { baseUrl: 'x', model: 'y' }, ownerQQ: '1', social: { enabled: true, prob: 0.1 } };
  const stat = countPreserved(config, ['dsh.baseUrl', 'ownerQQ']);
  eq('总数 = 叶子总数', stat.total, 5);
  eq('表单覆盖数', stat.covered, 2);
  eq('原样保留数', stat.preserved, 3);
  ok('空配置不炸', countPreserved({}, ['a']).total === 0);
}

section('7. 静态约束：它不该自己去找文件，也不该裸奔');
{
  const server = fs.readFileSync(path.join(HERE, 'config-ui.mjs'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'public', 'config-ui.html'), 'utf8');
  const core = fs.readFileSync(path.join(HERE, 'config-ui-core.mjs'), 'utf8');

  ok('只绑 127.0.0.1（不暴露到局域网）', /listen\(port, '127\.0\.0\.1'/.test(server));
  ok('每个请求都要 token', /if \(!authorized\(req\)\)/.test(server));
  ok('挡跨站请求（Origin 校验）', /sameOrigin\(req, port\)/.test(server));
  ok('token 每次运行随机', /randomBytes\(24\)\.toString\('hex'\)/.test(server));
  ok('页面里不留死 token（用占位符注入）', page.includes('__CONFIG_UI_TOKEN__'));
  ok('页面没有自动检索磁盘路径的代码', !/readdirSync\(|glob|\.dsh\/profiles/.test(server) && !/readdirSync\(|glob/.test(core));
  ok('写入前先校验，不过就不写', /validateConfig\(merged\)/.test(server) && /if \(!verdict\.ok\)/.test(server));
  ok('写入永远走「读旧 → 合并」而不是整份覆盖', /deepMerge\(existing, patch\)/.test(server));
  ok('保存前备份', /fs\.copyFileSync\(file, backup\)/.test(core));
  ok('先写临时文件再 rename（防半个 JSON）', /fs\.renameSync\(tmp, file\)/.test(core));
  ok('页面提供「按模板新建」', /api\/create/.test(server) && /id="create"/.test(page));
  ok('页面提供原生浏览按钮（不是让用户猜路径）', /id="browse"/.test(page) && /api\/pick/.test(server));
  ok('页面说明「表单没覆盖的键会保留」', page.includes('原样保留'));
  ok('核心模块不引入任何第三方依赖', !/from '(?!node:|\.\/)/.test(core));
  ok('服务端只用 node: 内置与本地相对导入', !/from '(?!node:|\.\/)/.test(server));
}

console.log('');
if (fail) { console.log('❌ 配置编辑器判据：' + pass + ' 通过，' + fail + ' 失败'); process.exit(1); }
console.log('✅ 配置编辑器判据通过（' + pass + ' 项）');
