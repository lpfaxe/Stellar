// B站 登录态守门（2026-11-20）：cookie 过期了生物钟还在跑，白烧一天 token。
// 这个用例只钉住接线（真跑要看 plugin.log 与面板状态）；纯行为在 verifyStoredCredentials 那边。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginIndex = fs.readFileSync(path.join(ROOT, 'plugins', 'stellar', 'lib', 'index.js'), 'utf8');
const qrLogin = fs.readFileSync(path.join(ROOT, 'plugins', 'stellar', 'lib', 'bili-qr-login.mjs'), 'utf8');

let pass = 0;
const ok = (cond, message, detail) => {
  if (cond) { pass += 1; return; }
  console.error('✗ ' + message + (detail === undefined ? '' : '（实际：' + detail + '）'));
  process.exitCode = 1;
};

// 1) 守门函数存在，并且真的是「查凭据 → 连着两次失败 → 停生物钟」
ok(/async function biliLoginWatch/.test(pluginIndex), 'index.js 里有 biliLoginWatch');
ok(pluginIndex.includes("verifyStoredCredentials('fish')"), '查的是实际在用的那份凭据（fish = bili/credentials.json）');
ok(/biliLoginFails < 2/.test(pluginIndex), '要求连续两次失败才动手');
ok(/BILI_LOGIN_DEAD_CODES = new Set\(\['bili\.no-credentials', 'bili\.bad-credentials', 'bili\.cookie-expired', 'bili\.mid-mismatch'\]\)/.test(pluginIndex), '「明确失效」四个码列成一队');
ok(/biliLoginFails = BILI_LOGIN_DEAD_CODES\.has\(code\) \? 2 : biliLoginFails \+ 1/.test(pluginIndex), '明确失效立刻停，只有网络错误才等第二次');
ok(/if \(check && check\.ok\) \{[\s\S]{0,120}biliLoginFails = 0/.test(pluginIndex), '恢复登录后把计数清零');
ok(pluginIndex.includes('stopSchedulerNow()'), '失效时停生物钟');
ok(pluginIndex.includes("idleSchedulerStatus('cookie-expired')"), '状态写成 cookie-expired，面板能显示');
ok(/settings|设置 → B站/.test(pluginIndex) && pluginIndex.includes('重新扫码登录'), '日志里有可操作的下一步');

// 2) 频率：15 分钟一次 + 启动后 20 秒先查一遍（别空转一小时）
ok(pluginIndex.includes('BILI_LOGIN_CHECK_MS = 15 * 60_000'), '15 分钟一次');
ok(/setInterval\(biliLoginWatch, BILI_LOGIN_CHECK_MS\)/.test(pluginIndex), '定时器接上了守门函数');
ok(/setTimeout\(\(\) => \{ void biliLoginWatch\(\); \}, 20_000\)/.test(pluginIndex), '启动后 20 秒先查一次');
ok(pluginIndex.includes('biliLoginTimer.unref?.();'), '定时器 unref，不拖住进程');
ok(pluginIndex.includes("}, 20_000).unref?.();"), '20 秒兜底那次也 unref');

// 3) 依赖：verifyStoredCredentials 真的从 bili-qr-login 进来，且能区分「过期」与「网络」
ok(/import[\s\S]{0,400}verifyStoredCredentials[\s\S]{0,200}from '\.\/bili-qr-login\.mjs'/.test(pluginIndex), 'index.js 从 bili-qr-login 导入 verifyStoredCredentials');
ok(qrLogin.includes("code: 'bili.cookie-expired'"), 'bili-qr-login 能把「未登录」判成 cookie-expired');
ok(qrLogin.includes("code: 'bili.network'"), '网络不通单独给 bili.network，不冒充 cookie 过期');
ok(qrLogin.includes('NAV_NETWORK_ERROR'), 'nav 的 catch 返回网络错误哨兵，不再返回 null');
ok(/if \(account && !account\.networkError\)/.test(qrLogin), '扫码轮询遇到网络错误继续等，不把哨兵当账号');
ok(/fetch\('https:\/\/api\.bilibili\.com\/x\/web-interface\/nav'/.test(qrLogin), '核查真的打 nav 接口，不是信任本地文件');
ok(/AbortController[\s\S]{0,200}10_000/.test(qrLogin), 'nav 有 10 秒超时，网络卡住不会拖死 tick');

// 4) 守门不能把正常路径弄坏：只在跑着的时候查
ok(/if \(!scheduler \|\| !schedulerStatus\.running\) return;/.test(pluginIndex), '没在跑就不查（不打扰未启动状态）');
ok(/biliLoginChecking/.test(pluginIndex), '有重入锁，慢网络下不会叠请求');

console.log('B站 登录态守门接线：' + pass + ' 通过');
if (process.exitCode) console.log('失败数见上面的 ✗');
