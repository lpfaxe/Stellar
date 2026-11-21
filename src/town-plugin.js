/**
 * Stellar —— 小镇「官方插件」这一侧：只做三件事，供面板与同步脚本共用。
 *
 * 为什么单独一份文件：小镇迟早要从本项目里整个剔掉（2026-11-21 定），所以凡是
 * 跟那个插件的往来都收在这一个文件里 —— 只碰两个东西：
 *   1. 插件自己那份 settings.json（%DSH_HOME%/fishbowl-town/settings.json）里的
 *      persona（人设）与 fish[].enabled（进不进镇）；
 *   2. 它有没有装（看 DSH profile 的 package.json / node_modules）。
 *
 * 不 import 插件、不读它的内部状态、不碰它的日记；访问码在这份文件里一律不落日志。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 官方插件的包名。 */
export const PLUGIN_ID = 'dsh-fishbowl-town';
/** 插件设置文件的相对位置（%DSH_HOME%/fishbowl-town/settings.json）。 */
export const PLUGIN_SETTINGS_REL = path.join('fishbowl-town', 'settings.json');
/** 插件可能落在几个地方：DSH 自己的 node_modules，或者某个 profile 的 node_modules 里。 */
const PROFILE_ROOT = 'profiles';

/**
 * 人设长度上限：插件自己是 slice(0, 2000)，但小镇的每一步都要带上它，
 * 800 字足够把「她是谁、怎么说话」说清，又不至于每回合烧掉一堆 token。
 */
export const PERSONA_MAX_CHARS = 800;

/** 插件设置文件的绝对路径。 */
export function pluginSettingsPath(dshHome) {
  return path.join(String(dshHome || ''), PLUGIN_SETTINGS_REL);
}

/**
 * 找插件装在哪儿（只看文件系统）：先看 %DSH_HOME%/node_modules，再看
 * %DSH_HOME%/profiles/<profile>/node_modules。找到就回那个目录 + 版本。
 * 找不到回 null —— 那就当它不在场，我们自己的只读/动作照常。
 */
export function findPluginInstall({ dshHome = '' } = {}) {
  const home = String(dshHome || '');
  if (!home) return null;
  const dirs = [home];
  try {
    for (const name of fs.readdirSync(path.join(home, PROFILE_ROOT))) {
      if (name.startsWith('.')) continue;
      dirs.push(path.join(home, PROFILE_ROOT, name));
    }
  } catch { /* 没有 profiles/ 就算了 */ }
  for (const dir of dirs) {
    const modPkg = readJsonSafe(path.join(dir, 'node_modules', PLUGIN_ID, 'package.json'));
    if (modPkg) return { dir, version: String(modPkg.version || '') };
  }
  return null;
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // 记事本存过会带 BOM
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 插件装没装。看两处：profile 的 package.json 里有没有写这条依赖、node_modules 里有没有它。
 * 两个都不看文件系统以外的东西（不问 DSH、不联网），所以面板也能自己调。
 */
export function detectPlugin({ profileDir = '', dshHome = '' } = {}) {
  const out = { installed: false, version: '', via: '', profileDir: String(profileDir || ''), settingsFile: '', settings: null };
  const dir = String(profileDir || '');
  if (dir) {
    const pkg = readJsonSafe(path.join(dir, 'package.json'));
    const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    const bundles = pkg && pkg.dsh && Array.isArray(pkg.dsh.bundles) ? pkg.dsh.bundles : [];
    if (Object.prototype.hasOwnProperty.call(deps, PLUGIN_ID)) out.via = 'dependencies';
    else if (bundles.includes(PLUGIN_ID)) out.via = 'bundles';
    const modPkg = readJsonSafe(path.join(dir, 'node_modules', PLUGIN_ID, 'package.json'));
    if (modPkg) {
      out.installed = true;
      out.version = String(modPkg.version || '');
      if (!out.via) out.via = 'node_modules';
    }
    if (out.via === 'dependencies' || out.via === 'bundles') {
      // 写了依赖但没装成（npm 没跑完）不算装上：仍然要求 node_modules 里有个包。
      out.installed = Boolean(modPkg) || out.installed;
      if (!out.version && modPkg) out.version = String(modPkg.version || '');
    }
    if (!out.installed) out.via = '';
  }
  if (dshHome) {
    const file = pluginSettingsPath(dshHome);
    if (fs.existsSync(file)) {
      out.settingsFile = file;
      out.settings = readJsonSafe(file);
      // 设置文件在、而且里面有鱼 —— 说明它至少被配置过一遍（装没装仍以 node_modules 为准）。
      if (!out.installed && out.settings) out.via = out.via || 'settings';
    }
  }
  return out;
}

/** 插件设置里的鱼列表（0.6.0 起是 fish[]；更早是顶层单条）。 */
export function pluginFishList(settings) {
  const raw = settings && typeof settings === 'object' ? settings : {};
  const list = Array.isArray(raw.fish) ? raw.fish.filter((x) => x && typeof x === 'object') : [];
  if (list.length) return list;
  if (raw.code || raw.persona) return [{ id: '1', code: raw.code, persona: raw.persona, chatSid: raw.reportSessionId }];
  return [];
}

/** 找那条鱼：给了 fishId 就按 id 找，没给就第一条。 */
export function pluginFish(settings, fishId = '') {
  const list = pluginFishList(settings);
  const want = String(fishId || '');
  if (!want) return list[0] || null;
  return list.find((x) => String(x.id || '') === want) || null;
}

/**
 * 插件现在会不会自己挂长轮询抢回合：装有、这条鱼 enabled !== false、而且有接入码。
 * 它抢着答题的时候，我们自己的 /turns 泵必须让位（同一个接入码只允许一个长轮询）。
 */
export function pluginTakesTurns(settings, fishId = '') {
  const fish = pluginFish(settings, fishId);
  if (!fish) return false;
  if (fish.enabled === false) return false;
  return Boolean(String(fish.code || '').trim());
}

/**
 * 写回插件设置：读-改-写，未知键原样保留，先备份再原子替换。
 * mutate(settings) 直接改传进去的对象；返回 {file, changed, backup}。
 */
export function writePluginSettings(dshHome, mutate, { now = Date.now() } = {}) {
  const file = pluginSettingsPath(dshHome);
  const before = readJsonSafe(file);
  if (!before) throw new Error('插件设置文件不存在或不是合法 JSON：' + file);
  const next = JSON.parse(JSON.stringify(before));
  mutate(next);
  if (JSON.stringify(next) === JSON.stringify(before)) return { file, changed: false, backup: '' };
  const stamp = new Date(Number(now) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const backup = file + '.bak-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(file, backup);
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { file, changed: true, backup };
}

/** 面板那个「进镇」开关的另一半：插件那边这条鱼开/关。 */
export function setPluginEnabled(dshHome, on, { fishId = '' } = {}) {
  const settings = readJsonSafe(pluginSettingsPath(dshHome));
  if (!settings) return { ok: false, reason: '插件设置文件不存在：' + pluginSettingsPath(dshHome) };
  const list = pluginFishList(settings);
  if (!list.length) return { ok: false, reason: '插件设置里还没有鱼（先在小镇里填一次接入码）' };
  const want = String(fishId || '');
  const idx = want ? list.findIndex((x) => String(x.id || '') === want) : 0;
  if (idx < 0) return { ok: false, reason: '插件设置里没有 id=' + want + ' 这条鱼' };
  const target = list[idx];
  if ((target.enabled !== false) === Boolean(on)) return { ok: true, changed: false, file: pluginSettingsPath(dshHome) };
  const res = writePluginSettings(dshHome, (next) => {
    const arr = Array.isArray(next.fish) ? next.fish : [];
    if (arr.length) arr[idx].enabled = Boolean(on);
    else next.enabled = Boolean(on); // 极老的单条配置
  });
  return { ok: true, changed: res.changed, file: res.file, backup: res.backup };
}

// ── 人设：从角色卡派生，只有一份真相 ───────────────────────────────────────────

/** 这些行是 QQ 群那边的机制（潜水、群里怎么读数、分几条发），搬到小镇里全是错的。 */
const CHANNEL_LINE_RE = /群|@|潜水|分几条|括号/;
/** 这些行讲的是「怎么用工具 / 怎么查资料」，属于某个通道的作业流程，不是她这个人。 */
const TOOL_LINE_RE = /查资料|搜索|搜到|搜几步|网页|引用|工具/;
/** 抽哪几节：身份 + 说话方式（「说话铁律」那节 QQ 味太重，只在没有「说话方式」时兜底）。 */
const IDENTITY_TITLE_RE = /你是谁|我是谁|身份/;
const STYLE_TITLE_RE = /说话方式|语气|性格/;
const STYLE_FALLBACK_RE = /说话铁律/;

/** 把角色卡按 '## ' 切成节：[{title, lines}]。 */
export function roleSections(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      cur = { title: line.replace(/^##\s+/, '').trim(), lines: [] };
      out.push(cur);
      continue;
    }
    if (/^#\s+/.test(line)) continue; // 一级标题（角色卡名字）不要
    if (cur) cur.lines.push(line);
  }
  return out;
}

function cleanLines(lines, { skipChannel = true, skipTool = false } = {}) {
  const keep = [];
  for (const raw of lines) {
    let line = String(raw || '').trim();
    if (!line) continue;
    if (line.startsWith('>')) continue; // 引用块是给写卡人看的说明，不是人设
    if (/^形象参考[:：]/.test(line)) continue; // 画风描述，小镇里用不上
    if (skipChannel && CHANNEL_LINE_RE.test(line)) continue;
    if (skipTool && TOOL_LINE_RE.test(line)) continue;
    if (/^\d+[.、]\s*/.test(line)) line = line.replace(/^\d+[.、]\s*/, '');
    else if (line.startsWith('- ')) line = line.slice(2).trim();
    if (line) keep.push(line);
  }
  return keep;
}

/**
 * 从角色卡派生小镇人设（纯函数）。
 * 结构：一句「你是谁」+ 身份几行 + 说话方式几行 + 两句小镇补充；总长不超过 maxChars。
 * 角色卡是唯一真相 —— 改角色卡，重跑同步脚本即可，不要在别处再写一份她。
 */
export function deriveTownPersona(roleText, { name = '', maxChars = PERSONA_MAX_CHARS } = {}) {
  const sections = roleSections(roleText);
  const who = sections.find((s) => IDENTITY_TITLE_RE.test(s.title));
  const style = sections.find((s) => STYLE_TITLE_RE.test(s.title)) || sections.find((s) => STYLE_FALLBACK_RE.test(s.title));
  const head = name ? '你是「' + name + '」。' : '你叫这个名字：';
  const idLines = cleanLines(who ? who.lines : [], { skipChannel: false }).slice(0, 6);
  const styleLines = cleanLines(style ? style.lines : [], { skipTool: true }).slice(0, 8);
  const tail = '在小镇里你还是同一个人，不是分身，也不是客服：说话短、有脾气，不解释自己是模型。';
  const parts = [head, ...idLines, ...styleLines, tail].filter(Boolean);
  let text = parts.join('\n');
  const cap = Math.max(160, Number(maxChars) || PERSONA_MAX_CHARS);
  if (text.length > cap) {
    // 按行砍，砍完补一句收尾，别留半句话。
    const lines = [];
    let used = 0;
    for (const line of parts) {
      if (used + line.length + 1 > cap - 4) break;
      lines.push(line);
      used += line.length + 1;
    }
    text = lines.join('\n');
  }
  return text;
}

/** 角色卡名字：优先用文件名（roles/小鲸鱼.md → 小鲸鱼）。 */
export function roleNameFromFile(file) {
  const base = path.basename(String(file || '')).replace(/\.md$/i, '');
  return base === 'README' ? '' : base;
}

/**
 * 把派生好的人设置写进插件（只写 persona 一处）。返回 {ok, file, changed, chars, reason}。
 * 没装插件、没有设置文件，都只是「跳过」而不是错误 —— 交给我们自己的只读模式照常跑。
 */
export function syncPersona({ dshHome, roleText, name = '', fishId = '', maxChars = PERSONA_MAX_CHARS } = {}) {
  const persona = deriveTownPersona(roleText, { name, maxChars });
  const file = pluginSettingsPath(dshHome);
  if (!fs.existsSync(file)) return { ok: false, skipped: true, reason: '插件还没配置过（' + file + ' 不存在）', file, persona, chars: persona.length };
  const settings = readJsonSafe(file);
  const fish = pluginFish(settings, fishId);
  if (!fish) return { ok: false, skipped: true, reason: '插件设置里还没有鱼（先填一次接入码）', file, persona, chars: persona.length };
  if (String(fish.persona || '') === persona) return { ok: true, skipped: false, changed: false, file, persona, chars: persona.length };
  const res = writePluginSettings(dshHome, (next) => {
    const arr = Array.isArray(next.fish) ? next.fish : [];
    if (arr.length) {
      const i = fishId ? arr.findIndex((x) => String(x.id || '') === String(fishId)) : 0;
      if (i >= 0) arr[i].persona = persona;
    } else {
      next.persona = persona;
    }
    // 老的单条配置：只有一条鱼时顺手镜像到顶层，免得旧读法看到空人设。
    if (arr.length === 1) next.persona = persona;
  });
  return { ok: true, skipped: false, changed: res.changed, file: res.file, backup: res.backup, persona, chars: persona.length };
}

/**
 * 给面板/调度器看的一行状态。全部来自文件，不联网、不带访问码。
 */
export function pluginStatus({ profileDir = '', dshHome = '', fishId = '' } = {}) {
  const found = profileDir ? null : findPluginInstall({ dshHome });
  const det = detectPlugin({ profileDir: profileDir || (found ? found.dir : ''), dshHome });
  if (!profileDir && found) {
    det.installed = true;
    det.version = det.version || found.version;
    det.via = det.via || 'node_modules';
  }
  const fish = det.settings ? pluginFish(det.settings, fishId) : null;
  return {
    installed: det.installed,
    version: det.version,
    via: det.via,
    settingsFile: det.settingsFile,
    hasFish: Boolean(fish),
    fishEnabled: Boolean(fish) && fish.enabled !== false,
    personaChars: fish ? String(fish.persona || '').length : 0,
    takesTurns: det.settings ? pluginTakesTurns(det.settings, fishId) : false,
  };
}
