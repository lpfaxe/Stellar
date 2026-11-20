// B站生物钟会话归组：新会话走 workspaceId；旧会话不强行迁移。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BILI_WORKSPACE_TITLE, biliSessionCreateParams, biliWorkspacePath } from '../plugins/stellar/lib/bili-workspace.js';

const base = '%USERPROFILE%\\.dsh';
assert.equal(biliWorkspacePath(base), path.join(base, 'stellar', 'state', 'bili-agents'));
assert.equal(BILI_WORKSPACE_TITLE, 'B站生物钟');
assert.deepEqual(biliSessionCreateParams({ workspaceId: 'ws-1', cwd: 'C:\\tmp' }), { workspaceId: 'ws-1' },
  '有 workspaceId 时不能再传 cwd（两者互斥）');
assert.deepEqual(biliSessionCreateParams({ workspaceId: 'ws-1', agentPreset: 'standard' }), { workspaceId: 'ws-1', agentPreset: 'standard' },
  'workspace 与 preset 可以同时存在');
assert.deepEqual(biliSessionCreateParams({ cwd: 'C:\\tmp' }), { cwd: 'C:\\tmp' },
  '旧版没有工作区服务时才退回 cwd');

const scheduler = fs.readFileSync('plugins/stellar/lib/scheduler.js', 'utf8');
assert.ok(scheduler.includes('ensureBiliWorkspace'), 'scheduler 必须创建工作区');
assert.ok(scheduler.includes('resolveBiliAgentPreset'), 'scheduler 必须解析 DSH preset');
assert.ok(scheduler.includes('agentPreset: await resolveBiliAgentPreset()'), '建会话必须带 agentPreset');
assert.ok(scheduler.includes('biliSessionCreateParams'), 'scheduler 必须走 workspaceId/cwd 选择器');
assert.ok(scheduler.includes('workspaceController'), '必须使用 DSH workspaceController');
assert.ok(!scheduler.includes('sessionController.create({ sessionId, cwd })'), '不能只传 cwd 创建新会话');
// 2026-11-20：ready 从单变量改成按会话 id 的 Set（好友爱看有了自己的 feed-whale 会话），
// 语义不变——创建失败的那个 id 绝不能进集合，否则后续 prompt 会打到不存在的会话上。
assert.ok(scheduler.includes('if (sessionsReady.has(targetId)) return'), 'ready 必须按会话 id 记');
assert.ok(scheduler.includes('不要在这里把它标成 ready'), '创建失败不能标 ready');
assert.ok(scheduler.includes("path.join(biliDir, 'whale-diary.md')"), '日记提示词必须用角色级 platformDir');
assert.ok(!scheduler.includes('~/.dsh/stellar/bili/whale-diary.md'), '日记提示词不能再写账号级硬路径');

const index = fs.readFileSync('plugins/stellar/lib/index.js', 'utf8');
assert.ok(index.includes('workspacePath: biliWorkspace'), 'index 必须传专用 workspacePath');
assert.ok(index.includes('cwd: biliWorkspace'), '旧版 fallback cwd 也不能再是用户主目录');
assert.ok(!index.includes('cwd: os.homedir()'), '不能再用 os.homedir() 当 B站会话 cwd');

const bridge = fs.readFileSync('src/bridge.js', 'utf8');
const memory = fs.readFileSync('src/bili-memory.js', 'utf8');
assert.ok(bridge.includes('biliDir: CHARACTER_ID ? characterPaths(CHARACTER_ID).biliDir : null'),
  'bridge 必须把当前角色的 biliDir 传给记忆');
assert.ok(memory.includes('if (biliDir) paths.bili = biliDir'),
  '记忆模块必须支持角色级 biliDir');
assert.ok(memory.includes("ledgerFile('whale-diary.md')") && memory.includes("ledgerFile('scores.json')"),
  '角色级缺文件时必须回退账号级账本');
console.log('✅ B站会话工作区归组测试通过');
