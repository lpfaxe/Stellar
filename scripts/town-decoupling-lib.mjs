// town-decoupling-lib.mjs —— 「小镇功能能不能整块删掉」的判据（2026-11-21）。
//
// 小镇迟早要剔除（用户 2026-11-21 的原话），所以核心文件里只允许出现**接线**，
// 逻辑一律住在 town 独占文件里。这里把「谁能提到 town」写成白名单：
//   · TOWN_OWNED_PATTERNS：这些文件整个属于小镇，删掉就没了；
//   · CORE_TOWN_ALLOW：核心文件里允许出现的那几行（按子串认，多一行就报错）；
//   · coreTownLines()/scan()：把工作区扫一遍，给出实际用到 town 的核心行。
// 测试 scripts/test-town-decoupling.mjs 用它做断言，scripts/town-remove.mjs 用它出拆除清单。
import fs from 'node:fs';
import path from 'node:path';

export const TOWN_OWNED_PATTERNS = [
  /^src\/town-[a-z-]+\.js$/,
  /^scripts\/test-town-[a-z-]+\.mjs$/,
  /^scripts\/town-remove\.mjs$/,
  /^scripts\/town-plugin-sync\.mjs$/,
  /^scripts\/town-decoupling-lib\.mjs$/,
  /^plugins\/stellar\/lib\/town-jobs\.js$/,
  /^plugins\/stellar\/tools\/rules\/town\.md$/,
  /^plugins\/stellar\/town-tool-restrict\.mjs$/,
  /^plugins\/stellar\/presets\/town-act\.patch\.yml$/,
  /^dsh\/agent-presets\/town-act\//,
  /^docs\/guides\/(?:subsystems\/)?SUBSYSTEM-TOWN\.md$/,
  // 控制台那一页：整页都是小镇的（面板在发布树里也有一份副本）
  /^stellar-manager\/lib\/town\.js$/,
  /^stellar-manager\/public\/js\/town\.js$/
];

// 核心文件里允许提到 town 的行（子串白名单）。任何新出现的写法都要先想清楚：
// 这是接线还是逻辑？逻辑请搬进 town 独占文件。
export const CORE_TOWN_ALLOW = {
  'src/bridge.js': [
    "import { townPromptLine } from './town-prompt.js'",
    'snapshot.town',
    'town: town ?? { cost: 0, tokens: 0 }',
    '(town?.cost ?? 0)',
    '(town?.tokens ?? 0)',
    '整段在 src/town-prompt.js',
    'townPromptLine({ stellarDir: STELLAR_DIR })',
    'biliLine + townLine',
    '小镇（2026-11-21）：整段提示在 src/town-prompt.js',
    '拆除：删 town-prompt.js'
  ],
  'src/mcp-snowluma-safe.js': [
    "import { registerTownTools } from './town-tools.js'",
    "town: '小镇：这三天在小镇做了什么、碰见过谁'",
    "stellar_town_recall: 'town'",
    // 2026-11-22 按需取信息：一次给全的小镇现状 + 相册（两条也进 GATED_TOPICS）
    "stellar_town_now: 'town',",
    "stellar_town_album: 'town'",
    // 2026-11-22 token 账：stellar_cost 里多打一行小镇（模型 token 的钱，别和游戏里的钱混了）
    "'；小镇 ' + formatCny(snap.remaining.town.usedCny)",
    "'小镇那栏是模型 token 的钱",
    '整块在 src/town-tools.js 里',
    'scripts/town-remove.mjs 会列全',
    'registerTownTools(server, { dshHome, z, ownerOnlyError })',
    'group / town'
  ],
  'plugins/stellar/lib/scheduler.js': [
    "import { createTownJobs } from './town-jobs.js'",
    '实现整块在 ./town-jobs.js',
    '拆除：删 town-jobs.js + 这三行',
    'const town = createTownJobs({',
    'town.collectTick().catch(() => {}) }, 35_000)',
    'town.tick().catch(() => {}) }, 38_000)',
    'town.ensurePump().catch(() => {}) }, 44_000)',
    '鱼缸小镇：每分钟看一眼',
    'const timerTown = setInterval(',
    'stop() { town.stop();',
    'sessionId: town.sessionId'
  ],
  'plugins/stellar/lib/run-mode.js': [
    "加 'town'：小镇是她自己的日子",
    '次数由 townPlanDay 在 idle 下压到 1 次',
    "'town'（鱼缸小镇）也放行",
    '次数由 townPlanDay 在 idle 下压成 1',
    "return ['diary', 'chat', 'watch', 'qzone-public', 'wake', 'todo', 'town'].includes(act)"
  ],
  'src/capabilities.js': ["id: 'town',", "path: 'town.enabled',"],
  'plugins/stellar/tools/lib/config.mjs': ['fishbowl-town/settings.json', 'town: { enabled:', '把 actions 改成 true'],
  'scripts/test-audit.mjs': [
    '鱼缸小镇（2026-11-21）',
    "'test-town-memory-pure.mjs', 'test-town-client.mjs', 'test-town-store.mjs',",
    "'test-town-collector.mjs', 'test-town-scheduler.mjs', 'test-town-tools.mjs', 'test-town-turns.mjs',",
    "'test-town-actions.mjs', 'test-town-snapshot.mjs',",
    "'test-town-guard.mjs',",
    // 官方插件（dsh-fishbowl-town）那一层：让位 + 人设同步
    '官方插件（dsh-fishbowl-town）',
    "'test-town-plugin.mjs',",
    // 解耦契约自己也要在 tests[] 里（它守着这份清单）
    "'test-town-decoupling.mjs',",
    // 相册镜像（2026-11-22）
    "'test-town-album.mjs',",
    // 发布树的 tests[] 是每行一条（历史原因），逐条认领
    "'test-town-memory-pure.mjs',", "'test-town-client.mjs',", "'test-town-store.mjs',",
    "'test-town-collector.mjs',", "'test-town-scheduler.mjs',", "'test-town-tools.mjs',", "'test-town-turns.mjs',",
    "'test-town-actions.mjs',", "'test-town-snapshot.mjs',", "'test-town-decoupling.mjs',",
    "'test-town-plugin.mjs',", '官方插件（dsh-fishbowl-town）',
    '鱼缸小镇（2026-11-21）'
  ]
};

// 控制台（发布树里的 stellar-manager 副本）：只允许路由挂载与开关那几行
// 白名单本身就是「谁能用这份插件」的声明，前缀必须原样写在这里；只允许这两行。
// 2026-11-21 安全审计 S1 之后，这里从「整前缀放行」变成「逐名放行只读五件 + 其余 fail-closed」，
// 所以白名单本身也要认领新写的那些行（工具名清单、守卫分支、注释）。
CORE_TOWN_ALLOW['plugins/stellar/qq-tool-restrict.mjs'] = [
  'FISHBOWL_READONLY_TOOLS',
  'FISHBOWL_BLOCKED_TOOLS',
  'FISHBOWL_READONLY',
  'FISHBOWL_BLOCKED',
  "name.startsWith('fishbowl_town_')",
  'fishbowl_town_)/i',
  'fishbowl_town_',
  'fishbowl-town',
  'stellar_town_',   // 拒绝时提示「改用我们自己的动作工具」
  '小镇'
];
CORE_TOWN_ALLOW['scripts/test-preset-local-tools.mjs'] = [
  'FISHBOWL_READONLY',
  'fishbowl_town_',
  '小镇'
];
// 敏感文件白名单里多了两项（插件设置含 fbo_、town.db 是她的私事）：只认领这两行与注释。
CORE_TOWN_ALLOW['src/state-acl.mjs'] = [
  "'settings.json',",
  "'town.db',",
  '小镇插件设置',
  '小镇记忆库'
];

// 敏感文件白名单的测试：town.db 只是被测的路径样本，不是小镇逻辑
CORE_TOWN_ALLOW['scripts/test-sensitive-acl-hardening.mjs'] = [
  'town.db 是她在镇上的私事',
  "'town.db'",
  "state/town/town.db"
];

CORE_TOWN_ALLOW['stellar-manager/server.mjs'] = [
  "import { buildTown } from './lib/town.js'",
  "import { buildTown, townPluginStatus, setTownPluginEnabled } from './lib/town.js'",
  // 相册镜像（2026-11-22）：server 只做「把本机文件流出去」这一层接线。
  'listTownAlbum, townAlbumFile, townAlbumThumb',
  '调度器镜像到 state/town/album',
  "'/api/town/album",
  'townAlbumFile(name) : townAlbumThumb(name)',
  'await townPluginStatus()',
  'hasOwnProperty.call(body.updates, \'town\')',
  'plugin = await setTownPluginEnabled(Boolean(body.updates.town))',
  "appendAudit('town-plugin-switch'",
  "logLine('town plugin switch -> '",
  '「进镇」这个开关要写两处',
  "鱼缸小镇：她自己的日子（只读快照",
  "'/api/town'",
  "x.id === 'town'"
];
CORE_TOWN_ALLOW['stellar-manager/public/js/core.js'] = ["'town'", 'memory', 'TABS'];
CORE_TOWN_ALLOW['stellar-manager/public/js/boot.js'] = ["state.tab === 'town'", 'loadTown'];
// 面板的「她在跑什么」要把会话 id / preset 翻成人话（2026-11-21 新增，B 档不动它）。
CORE_TOWN_ALLOW['stellar-manager/lib/turns.js'] = ['stellar_town_', 'town-whale', 'town-act', '小镇'];
CORE_TOWN_ALLOW['stellar-manager/public/style.css'] = ['#townHeadCard', '.now-icon.kind-town'];

// 面板的「她此刻在做什么」要认出小镇这一态（2026-11-22）：只是把 kind 翻成一句人话。
CORE_TOWN_ALLOW['stellar-manager/lib/activity.js'] = [
  'stellar_town_',
  'town = null',
  "=== 'town'",
  "= 'town'",
  'town.inTown',
  'town.detail',
  'town.at',
  '/小镇/',
];
CORE_TOWN_ALLOW['stellar-manager/lib/status.js'] = [
  'readTownPresence',
  'buildActivity({ turns, town })',
  'townPresence',
];
CORE_TOWN_ALLOW['stellar-manager/public/js/status.js'] = ["town: '镇'"];

// 这几个文件整个属于「小镇作为一类账 / 一个预设」的接线面，town 出现在哪一行都不算耦合：
// 账目分类是多处枚举 + 面板色板，预设构建器是 town-act 的 patch 生成器。
export const CORE_TOWN_ALLOW_ANY = [
  'package.json',                       // 只挂一个 npm script（town:plugin:sync）
  'plugins/stellar/package.json',
  'plugins/stellar/lib/token-budget-service.js',
  'plugins/stellar/lib/token-usage-pure.js',
  'src/token-budget.js',
  'src/cost-estimate.js',
  'scripts/build-agent-preset-patches.mjs',
  'scripts/test-agent-preset-patches.mjs',
  'scripts/test-token-budget.mjs',
  // 控制台那一页的挂点：整块页面属于小镇（删页时一起删）
  'stellar-manager/public/index.html'
];

/** 提到 town 的判断：t 前不能是字母（否则 auditOwner / currentOwner / firstOwnerAt 全成假阳性）。 */
export function mentionsTown(line) {
  return /(?:^|[^A-Za-z])town/i.test(String(line));
}

/** 扫一遍工作区，返回 { owned:[rel], core:[{file,line,no,text}], unknown:[{file,line,no,text}] }。 */
export function scan({ root, files }) {
  const owned = [];
  const core = [];
  const unknown = [];
  for (const rel of files) {
    const normalized = rel.split(path.sep).join('/');
    if (TOWN_OWNED_PATTERNS.some((re) => re.test(normalized))) { owned.push(normalized); continue; }
    if (!/\.(?:js|mjs|cjs|json|yml|yaml)$/.test(normalized)) continue;
    if (normalized.startsWith('node_modules/') || normalized.includes('/node_modules/')) continue;
    if (normalized === 'package-lock.json' || normalized.endsWith('/package-lock.json')) continue;
    if (normalized === 'release/install-manifest.json') continue;   // 生成物：清单里出现文件名是正常的
    if (normalized.startsWith('examples/')) continue;               // 示例角色不带任何小镇接线
    const allow = CORE_TOWN_ALLOW[normalized];
    let text = '';
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    if (!mentionsTown(text)) continue;
    text.split('\n').forEach((line, index) => {
      if (!mentionsTown(line)) return;
      const item = { file: normalized, line: index + 1, text: line.trim() };
      if (CORE_TOWN_ALLOW_ANY.includes(normalized)) { core.push(item); return; }
      if (CORE_TOWN_ALLOW_ANY.includes(normalized)) { core.push(item); return; }
      if (!allow) { unknown.push(item); return; }
      if (allow.some((needle) => line.includes(needle))) core.push(item);
      else unknown.push(item);
    });
  }
  return { owned: owned.sort(), core, unknown };
}

/** 拆除时要手工改的核心挂点（人读的说明）。 */
export const REMOVAL_NOTES = [
  'src/bridge.js：删 import { townPromptLine } + townLine 那一行',
  'src/mcp-snowluma-safe.js：删 import { registerTownTools } + registerTownTools(...) 一行 + GATED_TOPICS 的 stellar_town_recall + RULE_TOPICS 的 town',
  'plugins/stellar/lib/scheduler.js：删 import + const town = createTownJobs({...}) + 三个 setTimeout + timerTown + stop() 里的 town.stop() + retire 里的 town.sessionId',
  'plugins/stellar/lib/run-mode.js：idle 白名单去掉 town',
  'src/capabilities.js：删 town 能力项',
  'plugins/stellar/tools/lib/config.mjs：删 town 默认值',
  'scripts/test-audit.mjs：删 tests[] 里的 test-town-*.mjs',
  '面板 stellar-manager：删 lib/town.js、public/js/town.js、/api/town 路由、town 页与 nav 按钮、boot.js 里的 loadTown',
  '数据：%DSH_HOME%/stellar/state/town/（town.db、wake.json、actions.json、status.json）想留就留（她自己的记忆），删也不影响运行'
];
