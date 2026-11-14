// 首次启动程序的判定层回归（纯函数，不读仓库、不装依赖、不联网）。
//
// 为什么要有这几组断言：
//   1. Node 版本比较写错会**误判为满足**，然后在 npm install 阶段炸出难懂的 ESM 报错；
//   2. 「已就绪就跳过」这条如果写反，重跑会覆盖用户已经填好的 config.json —— 这是最贵的错误；
//   3. bootstrap 必须在 npm install 之前跑得起来，所以它只能 import node: 内置模块。
//      这条靠静态扫描 import 行钉住（真去跑一遍要依赖，反而测不了）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIN_NODE, REQUIRED_DEPS, buildPlan, compareVersions, nodeSatisfies, parseArgs, parseVersion, summarize,
} from './bootstrap-plan.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log('✅ ' + label);
  else { failures += 1; console.error('❌ ' + label); }
};

console.log('## 1. 版本比较');
{
  ok(parseVersion('v22.13.0')?.major === 22, 'parseVersion 能吃掉 v 前缀');
  ok(parseVersion('22.13')?.patch === 0, '缺 patch 段按 0');
  ok(parseVersion('nonsense') === null, '非法版本 → null（不编造 0.0.0）');
  ok(compareVersions('22.13.0', '22.9.0') === 1, '22.13 > 22.9（按数字比，不是按字符串）');
  ok(compareVersions('22.13.0', '22.13.0') === 0, '相等');
  ok(compareVersions('21.99.99', '22.13.0') === -1, '主版本低就是低');
  ok(nodeSatisfies('22.13.0') === true, '恰好等于下限 → 满足');
  ok(nodeSatisfies('22.12.9') === false, '差一个 patch → 不满足');
  ok(nodeSatisfies('23.0.1') === true, '主版本更高 → 满足');
  ok(nodeSatisfies('') === false, '空版本 → 不满足（宁可报红也别放过）');
  ok(nodeSatisfies(MIN_NODE) === true, 'MIN_NODE 自身满足');
}

console.log('## 2. 命令行参数');
{
  const a = parseArgs(['--yes', '--json', '--dry-run']);
  ok(a.yes && a.json && a.dryRun, '三个布尔开关都认');
  const b = parseArgs(['--registry=https://registry.npmmirror.com']);
  ok(b.registry === 'https://registry.npmmirror.com', '--registry= 带值');
  const d = parseArgs(['-h']);
  ok(d.help === true, '-h 认');
  const e = parseArgs(['--skip-dsh', '--skip-acl', '--no-install']);
  ok(e.skipDsh && e.skipAcl && e.noInstall, '三个跳过开关都认');
  const f = parseArgs(['--unknown-flag']);
  ok(f.yes === false && f.dryRun === false, '不认识的参数被忽略（不静默当成 yes）');
}

/** 一份「全都没配」的初始状态：用来验证会给出完整的待办清单。 */
const bare = {
  nodeVersion: '22.13.0',
  missingDeps: ['js-yaml', 'zod'],
  hasConfig: false,
  ownerQQ: '',
  allowCount: 0,
  hasStateDir: false,
  hasDshHome: true,
  dshProfile: '',
  hasSnowlumaSdk: false,
  snowluma: false,
};

/** 一份「全都就绪」的状态：用来验证重跑不会动任何东西。 */
const ready = {
  nodeVersion: '24.12.0',
  missingDeps: [],
  hasConfig: true,
  ownerQQ: '1000000001',
  allowCount: 2,
  hasStateDir: true,
  hasDshHome: true,
  dshProfile: 'desktop',
  hasSnowlumaSdk: true,
  sdkNeedsPatch: false,
  aclHardened: true,
  dshReachable: true,
  snowluma: true,
};

console.log('## 3. 干净状态下的计划');
{
  const steps = buildPlan(bare, {});
  const keys = steps.map((s) => s.key);
  ok(steps.find((s) => s.key === 'deps')?.status === 'todo', '缺依赖 → deps 步骤是 todo（会真去装）');
  ok(steps.find((s) => s.key === 'config')?.status === 'todo', '没配置 → config 步骤是 todo（从 example 复制）');
  ok(steps.find((s) => s.key === 'state')?.status === 'todo', '没 state → state 步骤是 todo');
  ok(keys.includes('harden-acl'), '默认要加固 ACL');
  ok(keys.includes('identity') && steps.find((s) => s.key === 'identity').status === 'warn',
    'ownerQQ/白名单为空 → warn（要人填，不能自动猜）');
  ok(steps.find((s) => s.key === 'dsh')?.status === 'skip',
    '依赖没装 → dsh 步骤先跳过（setup-dsh 要 import js-yaml）');
  ok(steps.find((s) => s.key === 'patch-sdk')?.status === 'skip', '依赖没装 → patch-sdk 标 skip（列表里仍显示，说明为什么跳过）');
  ok(steps.every((s) => s.status !== 'fail'), '没有硬失败项（Node 和 DSH 都在）');
  const sum = summarize(steps);
  ok(sum.ok === true && sum.todo > 0, '汇总：可继续（有待办但没有 fail）');
  ok(sum.nextAction && sum.nextAction.status === 'todo', 'nextAction 指向第一个待办');
}

console.log('## 4. 已经就绪时不该有任何动作（幂等）');
{
  const steps = buildPlan(ready, {});
  ok(steps.every((s) => s.status !== 'todo'), '全 skip → 一个动作都没有（不会覆盖 config.json）');
  ok(steps.every((s) => s.status !== 'fail'), '没有失败项');
  const sum = summarize(steps);
  ok(sum.todo === 0 && sum.fail === 0, '汇总干净');
}

console.log('## 5. 开关与边界');
{
  const noInstall = buildPlan(bare, { noInstall: true });
  ok(noInstall.find((s) => s.key === 'deps')?.status === 'warn', '--no-install → 依赖项变 warn 而不是 todo');
  const skipAcl = buildPlan(ready, { skipAcl: true });
  ok(skipAcl.find((s) => s.key === 'harden-acl')?.status === 'skip', '--skip-acl → ACL 步骤标 skip');
  const skipDsh = buildPlan(ready, { skipDsh: true });
  ok(skipDsh.find((s) => s.key === 'dsh')?.status === 'skip', '--skip-dsh → DSH 步骤标 skip');
  const noDsh = buildPlan({ ...ready, hasDshHome: false }, {});
  ok(noDsh.find((s) => s.key === 'dsh')?.status === 'fail', '没有 ~/.dsh → dsh 项 fail 并给装 DSH 的提示');
  const old = buildPlan({ ...ready, nodeVersion: '20.11.1' }, {});
  ok(old.find((s) => s.key === 'node')?.status === 'fail', 'Node 太旧 → fail');
  ok(summarize(old).ok === false, '汇总把 fail 反映成 ok=false');
  const portChanged = buildPlan({ ...ready, dshReachable: false }, {});
  ok(portChanged.find((s) => s.key === 'sync-port')?.status === 'todo',
    'DSH 端口连不上 → 排 sync-port（它每次启动都会变）');
  const portOk = buildPlan(ready, {});
  ok(portOk.find((s) => s.key === 'sync-port')?.status === 'skip', 'DSH 端口在监听 → sync-port 跳过');
  const snow = buildPlan({ ...ready, snowluma: false }, {});
  ok(snow.find((s) => s.key === 'snowluma')?.status === 'warn', 'SnowLuma 没探测到 → warn（第三方，不代装）');
  const snowUnknown = buildPlan({ ...ready, snowluma: undefined }, {});
  ok(snowUnknown.find((s) => s.key === 'snowluma')?.status === 'todo', 'SnowLuma 状态未知 → 排探测步骤');
  const aclUnknown = buildPlan({ ...ready, aclHardened: undefined }, {});
  ok(aclUnknown.find((s) => s.key === 'harden-acl')?.status === 'todo',
    'ACL 没探测到 → 仍然排加固（宁可多跑一次，也不要漏掉）');
}

console.log('## 6. bootstrap 必须能在 npm install 之前跑');
{
  const onlyBuiltins = (file) => {
    const text = fs.readFileSync(path.join(root, 'scripts', file), 'utf8');
    const specs = [];
    const re = /^\s*import\s[^;]*?from\s+'([^']+)'/gm;
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
    return { specs, foreign: specs.filter((s) => !s.startsWith('node:') && !s.startsWith('.')) };
  };
  const plan = onlyBuiltins('bootstrap-plan.mjs');
  ok(plan.specs.length === 0, 'bootstrap-plan.mjs 零 import（实得 ' + plan.specs.length + ' 个）');
  const boot = onlyBuiltins('bootstrap.mjs');
  ok(boot.foreign.length === 0, 'bootstrap.mjs 只 import node: 内置与相对路径（实得 ' + JSON.stringify(boot.foreign) + '）');
  const text = fs.readFileSync(path.join(root, 'scripts', 'bootstrap.mjs'), 'utf8');
  // 2026-11-14：只有 DSH 的机器上没有 npm（DSH 只带 pnpm），所以装依赖变成两条路：
  // 有 npm 走 npm.cmd + shell（否则 ENOENT），没有就拿 node 去跑 DSH 自带的 pnpm.cjs。
  ok(/shell:\s*plan\.shell/.test(text) && /findDshPnpm/.test(text), 'npm 走 shell，缺 npm 时退回 DSH 自带 pnpm');
  // postinstall 是 `node scripts/patch-snowluma-sdk.mjs`：node 不在 PATH 时它会报「'node' 不是内部或外部命令」，
  // 所以安装环境必须先把找到的 node 目录塞进 PATH。
  ok(/function installEnv/.test(text) && /env\.PATH = dir \+ path\.delimiter/.test(text), '装依赖时把 node 目录前置进 PATH（postinstall 要用）');
  ok(/fs\.copyFileSync\(EXAMPLE, CONFIG\)/.test(text) && !/writeFileSync\(CONFIG/.test(text),
    'config.json 只从 example 复制、从不直接写（不覆盖用户配置）');
}

console.log('## 7. 依赖清单与 package.json 不漂移');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  const missing = REQUIRED_DEPS.filter((n) => !deps.includes(n));
  ok(missing.length === 0, 'REQUIRED_DEPS 全部在 package.json dependencies 里' + (missing.length ? '（缺 ' + missing.join(', ') + '）' : ''));
  const engines = String((pkg.engines && pkg.engines.node) || '');
  ok(engines.includes(MIN_NODE), 'engines.node 与 MIN_NODE 一致（' + engines + '）');
}

console.log(failures === 0 ? '\n✅ 首次启动判据通过' : '\n❌ ' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
