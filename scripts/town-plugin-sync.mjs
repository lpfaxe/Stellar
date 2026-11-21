#!/usr/bin/env node
/**
 * 小镇「官方插件」的人设同步：角色卡 → 插件的 persona。
 *
 * 为什么要有它：装了 dsh-fishbowl-town 以后，小镇里的她是插件开的另一个会话。
 * persona 空着，镇上那个就只是「没有你性格和记忆的分身」（插件 README 原话）。
 * 所以人设必须同步，而且只能有一份真相 —— 角色卡。改完角色卡跑一遍这个脚本就行。
 *
 * 用法：
 *   node scripts/town-plugin-sync.mjs              # 写进插件设置，打印摘要
 *   node scripts/town-plugin-sync.mjs --dry        # 只看会写成什么，不落盘
 *   node scripts/town-plugin-sync.mjs --check      # 不一致就 exit 1（给测试/门禁用）
 *   node scripts/town-plugin-sync.mjs --json       # 机器可读
 * 选项：--dsh-home=<dir> --role=<角色名> --fish=<鱼 id> --max=<字数>
 */
import fs from 'node:fs';
import path from 'node:path';

import { deriveTownPersona, roleNameFromFile, syncPersona, pluginStatus } from '../src/town-plugin.js';

const ROOT = path.join(import.meta.dirname, '..');
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_STATE = path.join(ROOT, 'state', 'current-role.json');

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

export function parseArgs(argv = []) {
  const out = { dshHome: '', role: '', fish: '', max: 0, dry: false, check: false, json: false };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(String(arg || ''));
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'dry') out.dry = true;
    else if (key === 'check') out.check = true;
    else if (key === 'json') out.json = true;
    else if (key === 'dsh-home') out.dshHome = String(val || '');
    else if (key === 'role') out.role = String(val || '');
    else if (key === 'fish') out.fish = String(val || '');
    else if (key === 'max') out.max = Number(val) || 0;
  }
  return out;
}

/** 默认 DSH 目录：环境变量优先，其次 %USERPROFILE%/.dsh。 */
export function defaultDshHome(env = process.env) {
  const explicit = String(env.DSH_HOME || '').trim();
  if (explicit) return explicit;
  const home = String(env.USERPROFILE || env.HOME || '').trim();
  return home ? path.join(home, '.dsh') : '';
}

/**
 * 用哪张角色卡：显式 --role 优先；否则看 state/current-role.json；否则小鲸鱼；否则第一张。
 * 找不到就回空串 —— 让调用方决定是「跳过」还是「报错」。
 */
export function resolveRoleFile({ role = '', rolesDir = ROLES_DIR, stateFile = ROLE_STATE } = {}) {
  const list = fs.existsSync(rolesDir)
    ? fs.readdirSync(rolesDir).filter((f) => f.toLowerCase().endsWith('.md') && !/^readme\.md$/i.test(f))
    : [];
  const want = String(role || '').trim() || String((readJsonSafe(stateFile) || {}).role || '').trim();
  if (want) {
    const hit = list.find((f) => f.replace(/\.md$/i, '') === want);
    if (hit) return path.join(rolesDir, hit);
  }
  const fallback = list.find((f) => f.replace(/\.md$/i, '') === '小鲸鱼') || list[0] || '';
  return fallback ? path.join(rolesDir, fallback) : '';
}

function main(argv) {
  const args = parseArgs(argv);
  const dshHome = args.dshHome || defaultDshHome();
  if (!dshHome) {
    console.error('找不到 DSH 目录：请用 --dsh-home=<dir> 指定');
    return 1;
  }
  const roleFile = resolveRoleFile({ role: args.role });
  if (!roleFile) {
    console.error('roles/ 下没有可用的角色卡');
    return 1;
  }
  const roleText = fs.readFileSync(roleFile, 'utf8');
  const name = roleNameFromFile(roleFile);
  const persona = deriveTownPersona(roleText, { name, maxChars: args.max || 0 });
  const status = pluginStatus({ dshHome, fishId: args.fish });

  if (args.dry || args.check) {
    const payload = { dshHome, role: name, chars: persona.length, persona, plugin: status };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log('角色卡：' + roleFile);
      console.log('插件：' + (status.installed ? '已装 ' + (status.version || '(版本未知)') : '没装（跳过也不会报错）'));
      console.log('设置：' + (status.settingsFile || '(没有设置文件)'));
      console.log('现在的人设长度：' + status.personaChars + ' 字；这次会写成 ' + persona.length + ' 字');
      console.log('—— 会写成这样 ——');
      console.log(persona);
    }
    if (args.check) {
      const same = Boolean(payload.plugin.settingsFile) && payload.plugin.personaChars === persona.length;
      return same ? 0 : 1;
    }
    return 0;
  }

  const res = syncPersona({ dshHome, roleText, name, fishId: args.fish, maxChars: args.max || 0 });
  if (args.json) {
    console.log(JSON.stringify({ dshHome, role: name, ...res }, null, 2));
  } else if (res.skipped) {
    console.log('跳过：' + res.reason);
    console.log('（我们自己的只读采集/动作不受影响，照常跑）');
  } else {
    console.log((res.changed ? '已同步' : '已经是新的') + '：' + name + ' → ' + res.file);
    console.log('人设 ' + res.chars + ' 字' + (res.backup ? '；旧文件备份在 ' + path.basename(res.backup) : ''));
  }
  return res.ok || res.skipped ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exitCode = main(process.argv.slice(2));
}
