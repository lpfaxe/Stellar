// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as selfIdentity from '../src/self-identity.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as allowlist from '../src/allowlist.js';
import * as callname from '../src/callname.js';
import * as personaIdentity from '../src/persona-identity.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as fishGuard from '../src/fish-guard.js';
import * as tokenGuard from '../src/token-guard.js';
import * as tokenBudget from '../src/token-budget.js';
import * as turnGuard from '../src/turn-guard.js';
import * as gateEvents from '../src/gate-events.js';
import * as dshModelFollow from '../src/dsh-model-follow.js';
import * as commandSpam from '../src/command-spam.js';
import * as adminIdentity from '../src/admin-identity.js';
import * as questionAnswers from '../src/question-answers.js';
import * as ownerAudit from '../src/owner-audit.js';
import * as roleCard from '../src/role-card.js';
import * as personaLayers from '../src/persona-layers.js';
import * as wakePolicy from '../src/wake-policy.js';
import * as groupPolicy from '../src/group-policy.js';
import * as actionPlanner from '../src/action-planner.js';
import * as sessionMap from '../src/session-map.js';
import * as dshHealth from '../src/dsh-health.js';
import * as contextTelemetry from '../src/context-telemetry.js';
import * as memoryCard from '../src/memory-card.js';
import * as vectorMemory from '../src/vector-memory.js';
import * as memoryTiers from '../src/memory-tiers.js';
import * as memoryStore from '../src/memory-store.js';
import * as agentState from '../src/agent-state.js';
import * as replyPlan from '../src/reply-plan.js';
import * as contextSnapshot from '../src/context-snapshot.js';
import * as characterStore from '../src/character-persona.js';
import * as biliCard from '../src/bili-card.js';
import * as historyCatchup from '../src/history-catchup.js';
import * as purposeEngine from '../src/purpose-engine.js';
import * as sessionRollover from '../src/session-rollover.js';
import * as wakeBatch from '../src/wake-batch.js';
import * as wakeFilter from '../src/wake-filter.js';
import * as conversationClosure from '../src/conversation-closure.js';
import { fetchVideoInfo } from '../src/bili-api.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as qqAt from '../src/qq-at.js';
import * as modelOptions from '../src/model-options.js';
import { createBiliMemory } from '../src/bili-memory.js';
import { createOutbox } from '../src/outbox.js';
import { isLoopbackBaseUrl } from '../src/dsh-port.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** 0.1s / 16k 单声道的最小 wav（只要头正确，voice-tts 就不会当成空文件）。 */
function wavFixture() {
  const n = 1600;
  const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// 解析 bridge.js 的顶层 import，拿到「本地名 -> 模块说明符」。
// 背景：vm 里没有真的模块系统，靠 context 注入提供绑定。以前每加一个 src 模块都要
// 记得在 context 里手动 `import * as x` 再展开，漏了就变成 ReferenceError:
// `normalizeHybridConfig is not defined` 这类「测试挂、生产没事」的幽灵失败。
// 现在改成：凡是 bridge.js import 了的 src 模块，只要 context 里还缺某个裸名，就自动补。
// 手写的桩（更真实的替换）永远优先——自动补只填空位。
function parseBridgeImports(code) {
  const out = [];
  const re = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm;
  let m;
  while ((m = re.exec(code))) {
    const clause = m[1].trim();
    const spec = m[2];
    // 相对 src/ 的 ./* 与跨目录的 ../plugins/* 都要补：后者以前被跳过，
    // 导致 checkPrivacy / privacyRejectText 这类跨目录导出在 vm 里恒为 undefined，
    // 一到真实发送路径就冒 `checkPrivacy is not defined`（测试挂、生产没事）。
    if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
    const bindings = [];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        // `auditAccessBlock as auditAccessBlockAt` 这种别名：本地名与导出名不同，
        // 补绑定必须按导出名取（按本地名取会永远取不到，报 xxx is not defined）。
        const as = t.split(/\s+as\s+/);
        bindings.push({ local: (as[1] ?? as[0]).trim(), imported: as[0].trim() });
      }
    }
    const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (head) {
      const nsMatch = head.match(/^\*\s+as\s+(\S+)$/);
      if (nsMatch) bindings.push({ local: nsMatch[1], namespace: true });
      else for (const id of head.split(/\s+/).filter(Boolean)) bindings.push({ local: id, imported: 'default' });
    }
    if (bindings.length) out.push({ spec, bindings });
  }
  return out;
}

// 这些模块的导出要么已经被下面手写成「读取临时目录」的桩，要么 import 时有副作用，
// 不能自动补（补进来会让测试悄悄读真实 DSH_HOME）。
//
// memory-cache.js / memory-read.js 是 2026-11-13 补进来的，原因是它们会**穿透 fixture**：
//   memory-cache → 动态 import src/memory-db.js → resolveDbFile() → activeMemoryPaths()
//   而 activeMemoryPaths 是 context 里的桩，只影响 bridge 自己；memory-db 是在**主进程**
//   被 import 的，它读的是宿主的真实 DSH_HOME → 每个 audit 用例都往真实 memory.db 写夹具
//   数据（owner=group:456、123 的 2115 行垃圾就是这么来的）。
// 桩成空实现：审计关心的是桥接转发逻辑，不是记忆库落盘。
const AUTO_BIND_SKIP = new Set(['./character-persona.js', './memory-cache.js', './memory-read.js']);
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {}, history = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  const harnessConfig = {
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  };
  // 旧审计用例按“每条消息都能醒”写；Token 防爆破默认会让部分用例被 2 分钟间隔拦住。
  // 这里默认关掉，专门的 test-token-guard 覆盖开启逻辑，需要开启的用例显式覆盖。
  harnessConfig.socialV2 = { tokenGuard: { enabled: false }, ...(config.socialV2 ?? {}) };
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(harnessConfig));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // 本地 TTS（voxd）：返回一个最小合法 wav，别让测试去连真实服务。
    if (String(url).includes('/v1/speak/file')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === 'x-duration-ms' ? '1500' : null) },
        arrayBuffer: async () => wavFixture()
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    // 上线补历史：按会话 key 返回夹具消息（默认空），不访问真实 QQ。
    if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
      const key = action === 'get_group_msg_history' ? `group:${body.group_id}` : `private:${body.user_id}`;
      const messages = Array.isArray(history[key]) ? history[key] : [];
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { messages } }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    cancelTurn: async (sessionId) => { calls.cancelled.push({ cancelTurn: sessionId }); return { ok: true }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  const bridgeImports = parseBridgeImports(source);
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    fishChatWindows, evaluateConversationFishGuard, fishGuardSendBlock, recordFishWindow,
    tokenGuardWakeBlock, tokenGuardSendBlock, bridgeDailyUsage, learnerBudgetBlock,
    buildWakePromptV2, buildWakeSnapshotV2, wakeFoldedNoticeV2, sendWakePromptV2, socialV2,
    // 话题新鲜度（2026-11-16）：主人看到一周前的地狱笑话还占着提示词，
    // 这里把渲染函数也暴露给测试，直接断言过期话题不再出现。
    formatMemoryV2, trimTopicsForSave,
    currentRoleHint, currentRoleHintV2, adminPromptLine, ownerMessageTag,
    memoryCardPromptBlock, recordMemoryInboxEvent, recordSelfMemoryEvent,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    // 人的黑名单（deny.users）：入站按发送者拦截，见 test-blacklist.mjs
    senderBlocked, handlePokeNotice,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSnowlumaHealth(patch = {}) { Object.assign(snowlumaHealth, patch); },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    // 上线补历史：测试可手动触发，不依赖真实 WebSocket / QQ。
    runHistoryCatchUp, historyCatchUpConfig, appendHistoryCatchupV2, fetchOneBotHistory,
    // 目的机制：测试可只读预览 / 手动触发 / 模拟回合回执（不连真 QQ）。
    runPurpose, purposeState, notePurposeTurnEnded, notePurposeOutbound, startPurposeLoop, warmPurposeState,
    // 对话收尾判断：测试可直接调内部函数（不连真 QQ）。
    closeConversationV2, assessClosureV2, closureConfigV2, closureSuppressesWake, noteClosureReopenV2,
    // assertOutboundAuditOk 已从 bridge.js 删除（无测试消费），harness 同步移除，
    // 否则 return 对象求值时就 ReferenceError，整组套件一起挂。
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：bridge 会读 process.env 里的路径类变量。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    // DSH_HOME 指向临时目录：记忆卡的 inbox / 注入块只能写在 fixture 里，绝不能碰真实用户数据。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: { DSH_HOME: path.join(temp, 'dsh') }, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector, createBiliMemory, fetchVideoInfo,
    // DSH 端口兜底：isLoopbackBaseUrl 是真身（纯函数），两条探测是桩——
    // 测试不该在宿主机上真跑 netstat / 真去连 3080。
    isLoopbackBaseUrl,
    probeDshBaseUrl: async () => true,
    discoverDshBaseUrl: async () => null,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...selfIdentity, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...stateAcl, ...presetPrompt, ...fishGuard, ...tokenGuard,
    ...qqAt,
    ...modelOptions,
    ...dshModelFollow,
    ...commandSpam,
    createOutbox,
    ...allowlist,
    ...callname,
    ...personaIdentity,
    ...dshHealth,
    ...tokenBudget,
    ...adminIdentity, ...roleCard, ...personaLayers, ...wakePolicy, ...groupPolicy, ...actionPlanner, ...sessionMap, ...contextTelemetry, ...memoryCard, ...vectorMemory, ...memoryTiers, ...memoryStore, ...agentState, ...replyPlan, ...contextSnapshot, ...biliCard, ...characterStore, ...historyCatchup,
    ...questionAnswers, ...ownerAudit, ...turnGuard, ...gateEvents,
    ...purposeEngine,
    ...conversationClosure,
    ...sessionRollover,
    ...wakeBatch,
    ...wakeFilter,
    // 角色系统在 fixture 里等价于「没有角色」：当前角色 null，记忆卡指向 temp/dsh/stellar/memory。
    // 不能直接用真实 character-store 的 DSH_HOME（它在主进程 import 时已固定）。
    readCurrentCharacter: () => null,
    activePersonaFile: () => '',
    readPersonaLayerText: () => '',
    activeBiliDir: () => path.join(temp, 'dsh', 'stellar', 'bili'),
    activePlatformStateDir: (legacyDir) => legacyDir,
    activeMemoryPaths: () => {
      const dir = path.join(temp, 'dsh', 'stellar', 'memory');
      return {
        dir,
        json: path.join(dir, 'memory-card.json'),
        markdown: path.join(dir, 'memory-card.md'),
        promptQq: path.join(dir, 'memory-card-prompt-qq.md'),
        promptBili: path.join(dir, 'memory-card-prompt-bili.md'),
        inbox: path.join(dir, 'memory-inbox.jsonl'),
        fullJsonl: path.join(dir, 'memory-card-full.jsonl'),
        fullStats: path.join(dir, 'memory-card-full-stats.json'),
        fullJson: path.join(dir, 'memory-card-full.json'),
        fullMarkdown: path.join(dir, 'memory-card-full.md'),
      };
    },
    isCurrentEpoch: () => true,
    // 记忆库读写：不让审计用例碰真实 memory.db（见 AUTO_BIND_SKIP 注释）。
    // 目录/侧写一律"未就绪"，桥接会退回旧记忆卡，正是 fixture 期望的状态。
    cacheKind: () => 'text',
    cacheInbound: () => {},
    cacheOutbound: () => {},
    catalogSnapshot: () => null,
    // factSnapshot 也必须桩：ROOT/config.json 带 memory 段（1.0.0 起默认有）时
    // memoryDbEngine() 返回 true，桥接会去取事实快照；vm 里没有这个导出就会 ReferenceError。
    factSnapshot: () => null,
    warmFacts: async () => null,
    personaSnapshot: () => null,
    styleSliceSnapshot: () => null,
    styleRefBlockFor: () => '',
    warmCatalog: async () => null,
    warmPersona: async () => null,
    warmStyleSlices: async () => null,
    resetMemoryReadCache: () => {},
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  // 补齐 bridge.js import 了、但 context 里没人提供的裸名（见 parseBridgeImports 的注释）。
  // 只补 src 内的相对模块；解析/导入失败就跳过，让对应测试自己报它该报的错。
  for (const { spec, bindings } of bridgeImports) {
    if (AUTO_BIND_SKIP.has(spec)) continue;
    const missing = bindings.filter((b) => !(b.local in context));
    if (!missing.length) continue;
    try {
      const mod = await import(pathToFileURL(path.resolve(root, 'src', spec)).href);
      for (const b of missing) {
        if (b.namespace) context[b.local] = mod;
        else if (b.imported in mod) context[b.local] = mod[b.imported];
      }
    } catch {
      // 模块导入失败：保持原样，缺啥报啥。
    }
  }
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  // 夹具默认模拟“SnowLuma 已连接”；通道断开用例会显式 setSnowlumaHealth({connected:false})。
  bridge.setSnowlumaHealth({ connected: true, lastSendOkAt: Date.now(), lastSendFailAt: 0 });
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
