// bootstrap-plan.mjs — 「首次启动」要检查/补齐什么（纯函数，不碰 IO）。
//
// 为什么单独一层：判定规则要能被测试钉住（哪项该红、缺什么、给什么修复提示），
// 而读文件/装依赖/起子进程这些副作用留在 scripts/bootstrap.mjs 里。
// 与插件侧的 plugins/stellar/lib/doctor.js 是同一套思路：判定与执行分开。
//
// 这一层**不能引入任何第三方依赖**：它在 npm install 之前就要跑得起来。

export const MIN_NODE = '22.13.0';

/** 运行时真正会 import 的包（缺一个桥接就起不来）。 */
export const REQUIRED_DEPS = [
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/schemastery',
  '@modelcontextprotocol/sdk',
  '@snowluma/mcp',
  '@snowluma/sdk',
  'js-yaml',
  'zod',
];

/** 解析 'v22.13.0' / '22.13.0' / '22.13' → { major, minor, patch }；非法返回 null。 */
export function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(input ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

/** 逐段比较：a < b → -1，a === b → 0，a > b → 1；解析失败按 0 处理（不误判为满足）。 */
export function compareVersions(a, b) {
  // 既接受字符串也接受 parseVersion() 的结果：nodeSatisfies 内部会先 parse 一次，
  // 再把对象喂回来（早期版本这里只吃字符串，导致对象被 String 成 '[object Object]'、
  // 解析失败、返回 0 —— 「越低越满足」，Node 20 会被判成合格）。
  const x = a && typeof a === 'object' ? a : parseVersion(a);
  const y = b && typeof b === 'object' ? b : parseVersion(b);
  if (!x || !y) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return 0;
}

export function nodeSatisfies(version, min = MIN_NODE) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return compareVersions(parsed, min) >= 0;
}

/**
 * 解析命令行。
 * 默认行为是「问一句再动手」；--yes 表示非交互（CI / 双击启动器用）。
 */
export function parseArgs(argv = []) {
  const out = {
    yes: false, dryRun: false, json: false, verbose: false,
    noInstall: false, skipDsh: false, skipAcl: false,
    registry: '', help: false,
  };
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '-y' || arg === '--yes') out.yes = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--verbose') out.verbose = true;
    else if (arg === '--no-install') out.noInstall = true;
    else if (arg === '--skip-dsh') out.skipDsh = true;
    else if (arg === '--skip-acl') out.skipAcl = true;
    else if (arg.startsWith('--registry=')) out.registry = arg.slice('--registry='.length);
  }
  return out;
}

function step(key, name, status, detail, fix = '') {
  return { key, name, status, detail, fix };
}

/**
 * 把「现在是什么状态」翻译成「要做什么」。
 *
 * @param {object} s
 * @param {string} s.nodeVersion
 * @param {string[]} s.missingDeps
 * @param {boolean} s.hasConfig
 * @param {string} s.ownerQQ       config.json 里的 ownerQQ（空 = 没填）
 * @param {number} s.allowCount    白名单条数（群 + 私聊）
 * @param {boolean} s.hasStateDir
 * @param {boolean} [s.dshReachable] config.json 里 dsh.baseUrl 指向的端口是否在监听
 * @param {boolean} [s.aclHardened] state/ 的 ACL 是否已收紧（undefined = 没探测到，按未收紧处理）
 * @param {boolean} s.hasDshHome   ~/.dsh 是否存在
 * @param {string} s.dshProfile    已注册 stellar 的 profile（空 = 没注册）
 * @param {boolean} [s.sdkNeedsPatch] dist 里还有缺扩展名的相对导入（false = 已补过）
 * @param {boolean} s.hasSnowlumaSdk  node_modules/@snowluma/sdk 是否在
 * @param {object} flags           parseArgs() 的结果
 * @returns {Array<{key:string,name:string,status:string,detail:string,fix:string}>}
 *   status: 'todo' 待执行 / 'skip' 已就绪 / 'warn' 需人工 / 'fail' 硬失败
 */
export function buildPlan(s, flags = {}) {
  const steps = [];

  if (!nodeSatisfies(s.nodeVersion)) {
    steps.push(step('node', 'Node 版本', 'fail',
      'v' + String(s.nodeVersion) + '（需要 >= ' + MIN_NODE + '）',
      '装 Node LTS（https://nodejs.org/）后**重开终端**再跑一遍'));
  } else {
    steps.push(step('node', 'Node 版本', 'skip', 'v' + String(s.nodeVersion), ''));
  }

  const missing = Array.isArray(s.missingDeps) ? s.missingDeps : [];
  if (!missing.length) {
    steps.push(step('deps', '项目依赖', 'skip', '已装齐（' + REQUIRED_DEPS.length + '/' + REQUIRED_DEPS.length + '）', ''));
  } else if (flags.noInstall) {
    steps.push(step('deps', '项目依赖', 'warn',
      '缺 ' + missing.length + ' 个：' + missing.join(', '),
      '按 --no-install 跳过了；自己跑 npm install'));
  } else {
    steps.push(step('deps', '项目依赖', 'todo',
      '缺 ' + missing.length + ' 个：' + missing.join(', '), ''));
  }

  if (s.hasConfig) {
    steps.push(step('config', '配置文件', 'skip', 'config.json 已存在（不会覆盖）', ''));
  } else {
    steps.push(step('config', '配置文件', 'todo', '没有 config.json，将从 config.example.json 复制', ''));
  }

  if (String(s.ownerQQ ?? '').trim() && (s.allowCount ?? 0) > 0) {
    steps.push(step('identity', '主人与白名单', 'skip', '已填（不回显）', ''));
  } else {
    const lack = [];
    if (!String(s.ownerQQ ?? '').trim()) lack.push('ownerQQ');
    if (!(s.allowCount > 0)) lack.push('allow.groups / allow.private');
    steps.push(step('identity', '主人与白名单', 'warn',
      '还没填：' + lack.join('、') + '（白名单为空 = 谁都不理）',
      '改 config.json，或在 DSH 设置页「Stellar → 诊断 → 一键配置」里填'));
  }

  if (s.hasStateDir) {
    steps.push(step('state', 'state/ 目录', 'skip', '已存在', ''));
  } else {
    steps.push(step('state', 'state/ 目录', 'todo', '缺 state/（运行时状态、日志、令牌都写这里）', ''));
  }

  if (flags.skipAcl) {
    steps.push(step('harden-acl', 'state/ 权限', 'skip', '按 --skip-acl 跳过', ''));
  } else if (s.hasStateDir && s.aclHardened === true) {
    steps.push(step('harden-acl', 'state/ 权限', 'skip', '已收紧（没有继承来的权限，也没有宽松主体）', ''));
  } else {
    steps.push(step('harden-acl', 'state/ 权限', 'todo',
      '收紧 state/ 的 ACL（Windows 上默认任何登录用户都能读令牌）', ''));
  }

  if (missing.length) {
    steps.push(step('patch-sdk', '@snowluma SDK 补丁', 'skip', '等依赖装完再跑', ''));
  } else if (!s.hasSnowlumaSdk) {
    steps.push(step('patch-sdk', '@snowluma SDK 补丁', 'skip', '没装 @snowluma/sdk，跳过', ''));
  } else if (s.sdkNeedsPatch === false) {
    steps.push(step('patch-sdk', '@snowluma SDK 补丁', 'skip', 'dist 里的相对导入已带扩展名', ''));
  } else {
    steps.push(step('patch-sdk', '@snowluma SDK 补丁', 'todo',
      '给 @snowluma/* 的 dist 补 .js 扩展名（否则纯 Node ESM 解析失败）', ''));
  }

  if (!s.hasDshHome) {
    steps.push(step('dsh', '装进 DSH', 'fail',
      '没找到 DSH 数据目录（~/.dsh）',
      '先装 DeepSeek Harness 并至少启动一次，再重跑'));
  } else if (flags.skipDsh) {
    steps.push(step('dsh', '装进 DSH', 'skip', '按 --skip-dsh 跳过', ''));
  } else if (s.dshProfile) {
    steps.push(step('dsh', '装进 DSH', 'skip', 'profile ' + s.dshProfile + ' 已注册', ''));
  } else if (missing.length) {
    steps.push(step('dsh', '装进 DSH', 'skip', '等依赖装完再跑（setup-dsh 要 js-yaml）', ''));
  } else {
    steps.push(step('dsh', '装进 DSH', 'todo',
      '往 DSH profile 里写 preset / MCP / bundle', ''));
  }

  if (!s.hasConfig || !s.hasDshHome) {
    steps.push(step('sync-port', 'DSH 端口同步', 'skip', '等配置和 DSH 就绪', ''));
  } else if (missing.length) {
    steps.push(step('sync-port', 'DSH 端口同步', 'skip', '等依赖装完再跑', ''));
  } else if (s.dshReachable === true) {
    steps.push(step('sync-port', 'DSH 端口同步', 'skip', 'config.json 里的 dsh.baseUrl 正在监听，不用改', ''));
  } else {
    steps.push(step('sync-port', 'DSH 端口同步', 'todo',
      'DSH 端口每次启动都会变：把 config.json 的 dsh.baseUrl 对齐到当前运行的那一个', ''));
  }

  const snow = s.snowluma;
  if (snow === true) {
    steps.push(step('snowluma', 'SnowLuma', 'skip', '已在监听', ''));
  } else if (snow === false) {
    steps.push(step('snowluma', 'SnowLuma', 'warn',
      '没探测到（3000 / 3001 都不通）',
      'SnowLuma 是第三方运行时，本项目不代装：装好后扫码登录，再重跑本程序'));
  } else {
    steps.push(step('snowluma', 'SnowLuma', 'todo', '探测 OneBot 的 HTTP/WS 端口是否在监听', ''));
  }

  return steps;
}

/** 汇总：给最后的退出码和一句话结论用。 */
export function summarize(steps) {
  const count = { todo: 0, skip: 0, warn: 0, fail: 0 };
  for (const item of steps) count[item.status] = (count[item.status] ?? 0) + 1;
  return {
    ...count,
    ok: count.fail === 0,
    nextAction: steps.find((c) => c.status === 'todo')
      ?? steps.find((c) => c.status === 'fail')
      ?? steps.find((c) => c.status === 'warn')
      ?? null,
  };
}
