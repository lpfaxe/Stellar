// 配置编辑器的纯逻辑：不碰网络、不读全局状态，全部函数可单测。
// 单独拆出来的理由：config-ui.mjs 要起 HTTP 服务，测试只想验合并/校验/落盘这一层。
import fs from 'node:fs';
import path from 'node:path';

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 深合并：对象逐层合并，数组与标量整体替换。
// 存在的意义是「表单里没出现的键必须原样活下来」——user 的 config.json 里有大量本 UI 不展示的段
// （pricing / fishGuard / slang / social / socialV2 的大部分 / purpose / greetings），
// 整份覆盖会把它们抹掉，所以写入一律走「读旧 → 合并 → 校验 → 落盘」。
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (next === undefined) continue;
    out[key] = isPlainObject(next) && isPlainObject(base[key]) ? deepMerge(base[key], next) : next;
  }
  return out;
}

// 路径检查：必须绝对、必须 .json、父目录必须存在。
// 刻意不做任何「自动找 config.json」——用户要求自己选路径，程序不去猜磁盘上的文件。
export function checkConfigPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: '还没有选择配置文件路径' };
  if (raw.includes('\u0000')) return { ok: false, error: '路径里有非法字符' };
  if (!path.isAbsolute(raw)) return { ok: false, error: '请填绝对路径，例如 C:\\Users\\你\\.dsh\\stellar\\config.json' };
  const ext = path.extname(raw).toLowerCase();
  if (ext !== '.json') return { ok: false, error: '配置文件必须是 .json' };
  const dir = path.dirname(raw);
  if (!fs.existsSync(dir)) return { ok: false, error: '目录不存在：' + dir };
  if (!fs.statSync(dir).isDirectory()) return { ok: false, error: '上级路径不是目录：' + dir };
  if (fs.existsSync(raw)) {
    const st = fs.statSync(raw);
    if (st.isDirectory()) return { ok: false, error: '这是一个目录，不是文件：' + raw };
    if (!st.isFile()) return { ok: false, error: '不是普通文件：' + raw };
  }
  return { ok: true, path: path.resolve(raw) };
}

export function readConfigFile(file) {
  if (!fs.existsSync(file)) return { ok: false, missing: true, error: '文件还不存在：' + file };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: '读不了这个文件：' + String(error?.message ?? error) };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return { ok: false, error: '文件是空的' };
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: '不是合法的 JSON：' + String(error?.message ?? error) };
  }
  if (!isPlainObject(config)) return { ok: false, error: 'JSON 顶层必须是对象' };
  return { ok: true, config };
}

const pad = (n) => String(n).padStart(2, '0');

// 备份名沿用仓库既有习惯：config.json.bak-20261114-004500
export function backupName(file, date = new Date()) {
  const stamp = String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  return file + '.bak-' + stamp;
}

// 写入：有变化才备份；先写同目录临时文件再 rename，避免写一半断电留下半个 JSON。
export function writeConfigFile(file, config, options = {}) {
  const text = JSON.stringify(config, null, 2) + '\n';
  let backup = '';
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8');
    if (current === text) return { ok: true, changed: false, backup: '' };
    backup = backupName(file, options.now instanceof Date ? options.now : new Date());
    fs.copyFileSync(file, backup);
  }
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now());
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return { ok: true, changed: true, backup };
}

const DIGITS = /^\d{5,12}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

function qqProblem(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim();
  if (!DIGITS.test(text)) return '要填纯数字的 QQ 号（5~12 位），或者留空';
  return '';
}

function idList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

// 表单能填错的地方给出可执行的中文提示；这里不追求覆盖全部字段，
// 只挡「填进去桥接会起不来」的那几类（端口、令牌、URL、QQ 号、白名单）。
export function validateConfig(config) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!isPlainObject(config)) {
    add('', '配置必须是一个 JSON 对象');
    return { ok: false, errors };
  }
  const dsh = isPlainObject(config.dsh) ? config.dsh : {};
  const baseUrl = String(dsh.baseUrl ?? '').trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) add('dsh.baseUrl', '要以 http:// 或 https:// 开头');
  if (dsh.allowRemote !== undefined && typeof dsh.allowRemote !== 'boolean') add('dsh.allowRemote', '只能是 true / false');

  const ownerProblem = qqProblem(config.ownerQQ);
  if (ownerProblem) add('ownerQQ', '主人 QQ：' + ownerProblem);
  const adminProblem = qqProblem(config.admin);
  if (adminProblem) add('admin', '管理员 QQ：' + adminProblem);

  const allow = isPlainObject(config.allow) ? config.allow : {};
  for (const key of ['private', 'groups']) {
    if (allow[key] === undefined) continue;
    const list = idList(allow[key]);
    if (list === null) { add('allow.' + key, '必须是数组'); continue; }
    const bad = list.filter((item) => !DIGITS.test(item));
    if (bad.length) add('allow.' + key, '这些不是数字：' + bad.slice(0, 3).join('、'));
  }

  const snow = isPlainObject(config.snowluma) ? config.snowluma : {};
  if (snow.wsUrl && !/^wss?:\/\//i.test(String(snow.wsUrl))) add('snowluma.wsUrl', '要以 ws:// 或 wss:// 开头');
  if (snow.httpUrl && !/^https?:\/\//i.test(String(snow.httpUrl))) add('snowluma.httpUrl', '要以 http:// 或 https:// 开头');

  const port = Number(config.consolePort);
  if (config.consolePort !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    add('consolePort', '端口要在 0~65535 之间（0 表示自动挑一个）');
  }
  const token = String(config.consoleToken ?? '').trim();
  if (token && !TOKEN.test(token)) add('consoleToken', '只能有字母、数字、下划线、连字符，长度 16~128；想让程序自动生成就留空');

  for (const [field, key, min, max] of [
    ['sendDelayMs', 'sendDelayMs', 0, 600000],
    ['questionTimeoutMs', 'questionTimeoutMs', 1000, 86400000],
    ['role.maxInjectChars', 'role', 0, 0],
  ]) {
    if (field === 'role.maxInjectChars') {
      const role = isPlainObject(config.role) ? config.role : {};
      if (role.maxInjectChars === undefined) continue;
      const value = Number(role.maxInjectChars);
      if (!Number.isInteger(value) || value < 1000 || value > 100000) add('role.maxInjectChars', '建议 1000~100000');
      continue;
    }
    const value = config[key];
    if (value === undefined) continue;
    const num = Number(value);
    if (!Number.isInteger(num) || num < min || num > max) add(field, '要是 ' + min + '~' + max + ' 的整数');
  }
  return { ok: errors.length === 0, errors };
}

// 只读统计：告诉用户「表单没覆盖多少键」，避免他以为保存会丢掉这些内容。
export function countPreserved(config, coveredPaths) {
  const covered = new Set(coveredPaths);
  const coveredPrefixes = new Set();
  for (const p of covered) {
    const parts = p.split('.');
    for (let i = 1; i < parts.length; i += 1) coveredPrefixes.add(parts.slice(0, i).join('.'));
  }
  let total = 0;
  let coveredCount = 0;
  const walk = (node, prefix) => {
    if (!isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      const full = prefix ? prefix + '.' + key : key;
      if (isPlainObject(node[key])) { walk(node[key], full); continue; }
      total += 1;
      if (covered.has(full)) coveredCount += 1;
      else if (coveredPrefixes.has(full)) coveredCount += 1;
    }
  };
  walk(config, '');
  return { total, covered: coveredCount, preserved: total - coveredCount };
}
