/* Stellar 控制台入口：路由 + 启动。业务逻辑都在 lib/ 里。 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { BRIDGE_CFG, CFG_FILE, HOST, PORT } from './lib/paths.js'
import { appendAudit, atomicWriteJson, clampNum, logLine, maskText, readBody, readJson, sendJson } from './lib/util.js'
import { applySecurity, clientIp, crossSite, currentToken, gate, handleLogin, handleLogout, isAuthed, isLoopback, issueLoginCode, lanAddresses, publicV6Addresses, requestScope, requireWrite, rotateToken, securitySnapshot, sessionInfo, setPassphrase } from './lib/auth.js'
import { addPrefix, clearPrefixes, isAllowedRemote, readAllow, removePrefix } from './lib/remote-allow.js'
import { actionCleanSnowluma, actionKeepalive, actionQzone, actionReplan, actionStartBridge, actionStartSnowluma, actionStop, applyPatch, buildJsonlLog, buildStatus, invalidateStatus, readLog, statusCacheStats, summarizeConfig } from './lib/status.js'
import { buildCost, buildUsageRanges } from './lib/cost.js'
import { addMemoryItem, buildLexicon, buildMemory, buildMemoryTiers, buildStickers, clearMemoryTier, memoryItem, queueMemoryForget, updateMemoryItem } from './lib/memory.js'
import { buildAgentState } from './lib/her.js'
import { actionReportRequest, readReports } from './lib/report.js'
import { readTodos, addTodoFromPanel, removeTodoFromPanel } from './lib/todos.js'
import { buildDynamics } from './lib/dynamics.js'
import { buildQzonePublic, clearQzoneShots, qzoneShotFile } from './lib/qzone-public.js'
import { biliCoverFile, buildBiliVideos, clearBiliCovers, deleteBiliVideo } from './lib/bili-videos.js'
import { buildDailyTasks } from './lib/daily-tasks.js'
import { buildDailyPlan, saveDailyPlan } from './lib/daily-plan.js'
import { buildVlog, vlogAction, vlogMedia, vlogScript } from './lib/vlog.js'
import { readAccess, saveAccess } from './lib/access.js'
import { actOnApproval, readApprovals } from './lib/approvals.js'
import { capabilitiesSnapshot, saveCapabilities } from './lib/capabilities.js'
import { buildTown, townPluginStatus, setTownPluginEnabled, listTownAlbum, townAlbumFile, townAlbumThumb } from './lib/town.js'
import { clearNamedTunnel, ensureTunnel, resumeTunnel, setNamedTunnel, startTunnel, stopTunnel } from './lib/tunnel.js'
import { restartDsh, resumeRestartPolling, reconcileRestartState } from './lib/dsh.js'
import { ensureContacts, loadAllowPrivate, loadContacts, saveContacts, setContactAllow, syncContacts } from './lib/contacts.js'
import { readChatAudit, readOutbox, seedOutboxFromToolCalls } from './lib/outbox.js'
import { contactIndex, nameForKey, relationFor } from './lib/people.js'
import { readTaskState, sendOwnerCommand, setPaused, wakeOwner } from './lib/task.js'
import { readRunMode, saveRunMode } from './lib/run-mode.js'
import { buildWebImages, clearWebImages, deleteWebImage, webImageFile } from './lib/web-images.js'
import { deleteFile as deleteCabinetFile, filePath as cabinetFilePath, listFiles as listCabinetFiles, saveFile as saveCabinetFile, saveStream as saveCabinetStream } from './lib/files.js'
import { buildMemoryDb, clearZoneNotes, deleteFact, deleteZoneNote, forgetMemory, listFacts, listFragments, listProfiles, listStyleRefs, listTopics, listZoneNotes, readTopicDetail, requestMemoryJob, runMemoryJob, saveFact, saveProfile, setMemoryTier, setStyleRefEnabled } from './lib/memory-db.js'
import { readVoicePanel, restoreVoicePanel, saveVoicePanel } from './lib/voice-style.js'
import { MANIFEST, servePublic } from './lib/static.js'
import { logEvent, metricsSnapshot, recordRequest } from './lib/metrics.js'

const server = http.createServer(async (req, res) => {
  try {
    applySecurity(res)
    const url = new URL(req.url, 'http://127.0.0.1')
    const mutating = req.method !== 'GET' && req.method !== 'HEAD'
    // 指标只统计到「写回响应」为止：res.finish 在 sendJson 之后触发，不会拖慢请求。
    // 参数缺失时要用默认值：clampNum(Number(null)=0) 会把「没传」压成最小值，
    // 之前 /api/memory-db/topics 不带 limit 会返回 1 条。这里显式区分「没传」。
    // 注意：必须定义在所有路由之前——原先它在文件后半段，前半段 /api/memory/tiers、
    // /api/lexicon、/api/stickers 先用到它，直接 TDZ 崩（2026-11-14 修）。
    const numParam = (u, key, min, max, dflt) => {
      const raw = u.searchParams.get(key)
      if (raw === null || raw === '') return dflt
      const n = Number(raw)
      if (!Number.isFinite(n)) return dflt
      return Math.max(min, Math.min(max, Math.round(n)))
    }
    const startedHr = process.hrtime.bigint()
    res.on('finish', () => {
      try { recordRequest(url.pathname, res.statusCode, Number(process.hrtime.bigint() - startedHr) / 1e6) } catch {}
    })

    if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res)
    if (url.pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res)
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(MANIFEST))
    }
    if (!gate(req, res, url)) return

    // 改数据必须同源；所有 /api/ POST 都过这一关（登录除外，它本来就没凭据）
    if (mutating && url.pathname.startsWith('/api/')) {
      const bad = crossSite(req)
      if (bad) return sendJson(res, 403, { ok: false, message: bad })
      // 写操作可能改配置/停止状态：让缓存立刻失效，前端紧接着的 loadStatus 看到的是新值。
      invalidateStatus()
    }

    if (url.pathname === '/api/status') {
      const s = await buildStatus()
      // 当前这次请求能不能写（公网 IPv6 默认只读，白名单命中才可写）
      s.access = { ...s.access, scope: requestScope(req), remoteAllowed: isAllowedRemote(clientIp(req)) }
      if (s.access && !isLoopback(req)) {
        // 不能就地改缓存对象，否则下一个本机请求会拿到被打码的 token。
        const masked = s.access.token ? String(s.access.token).slice(0, 2) + '••••' + String(s.access.token).slice(-2) : ''
        return sendJson(res, 200, { ...s, access: { ...s.access, token: masked, localOnly: true } })
      }
      return sendJson(res, 200, s)
    }
    if (url.pathname === '/api/login-code' && req.method === 'POST') {
      if (!isAuthed(req)) return sendJson(res, 401, { ok: false, message: '需要先登录面板才能生成登录链接' })
      const r = issueLoginCode()
      logEvent('login-code', { ip: clientIp(req) })
      appendAudit('login-code', { ip: clientIp(req) })
      return sendJson(res, 200, { ok: true, code: r.code, expiresAt: r.expiresAt, ttlSec: 300 })
    }
    if (url.pathname === '/api/remote-allow') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          prefixes: readAllow().prefixes,
          canManage: isLoopback(req),
          v6: publicV6Addresses().map((a) => ({ name: a.name, address: a.address, block: a.address.split(':').slice(0, 4).join(':') + '::/64' })),
        })
      }
      // 改白名单只能在跑面板的这台电脑上做：远程端就算拿到口令也改不了自己的权限
      if (!isLoopback(req)) return sendJson(res, 403, { ok: false, message: '改远程白名单只能在这台电脑上做' })
      if (!requireWrite(req, res)) return true
      const body = await readBody(req)
      const action = String(body && body.action || 'add')
      let r
      if (action === 'add') r = addPrefix({ cidr: body && body.cidr, label: body && body.label })
      else if (action === 'remove') r = removePrefix(body && body.cidr)
      else if (action === 'clear') r = clearPrefixes()
      else r = { ok: false, message: 'action 只能是 add / remove / clear' }
      logLine('remote-allow ' + action + ' ' + String(body && body.cidr || '') + ' -> ' + (r.ok ? 'ok' : r.message))
      appendAudit('remote-allow-' + action, { cidr: String(body && body.cidr || ''), ok: Boolean(r.ok) })
      return sendJson(res, r.ok ? 200 : 400, r.ok ? { ...r, canManage: true } : r)
    }
    if (url.pathname === '/api/security') {
      return sendJson(res, 200, {
        loopback: isLoopback(req),
        token: isLoopback(req) ? currentToken() : '',
        sessions: sessionInfo(),
        login: securitySnapshot(),
        rotateSupported: true,
      })
    }
    if (url.pathname === '/api/metrics') {
      return sendJson(res, 200, {
        ...metricsSnapshot(),
        statusCache: statusCacheStats(),
        sessions: sessionInfo(),
        tunnel: process.env.STELLAR_NO_TUNNEL !== '1',
      })
    }
    if (url.pathname === '/api/cost') {
      const cost = await buildCost()
      cost.ranges = buildUsageRanges()
      return sendJson(res, 200, cost)
    }
    if (url.pathname === '/api/agent') return sendJson(res, 200, buildAgentState())
    if (url.pathname === '/api/memory/tiers') return sendJson(res, 200, buildMemoryTiers({
      tier: String(url.searchParams.get('tier') || '').toUpperCase(),
      object: String(url.searchParams.get('object') || ''),
      q: url.searchParams.get('q') || '',
      limit: numParam(url, 'limit', 1, 100, 20),
      offset: numParam(url, 'offset', 0, 100000, 0),
    }))
    if (url.pathname === '/api/memory/item') return sendJson(res, 200, memoryItem(url.searchParams.get('id') || ''))
    if (url.pathname === '/api/memory/forget' && req.method === 'POST') {
      // 删记忆是写操作：公网隧道不给删（审计实测它能排进删除队列）
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      if (body.confirm !== true) return sendJson(res, 400, { ok: false, message: '要删记忆必须带 confirm:true（二次确认）' })
      if (!body.id) return sendJson(res, 400, { ok: false, message: '缺少 id' })
      return sendJson(res, 200, queueMemoryForget(body.id))
    }
    if (url.pathname === '/api/lexicon') return sendJson(res, 200, buildLexicon({
      q: url.searchParams.get('q') || '',
      limit: numParam(url, 'limit', 1, 100, 20),
      offset: numParam(url, 'offset', 0, 100000, 0),
    }))
    if (url.pathname === '/api/stickers') return sendJson(res, 200, buildStickers({
      q: url.searchParams.get('q') || '',
      limit: clampNum(url.searchParams.get('limit'), 1, 200, 24),
      offset: numParam(url, 'offset', 0, 100000, 0),
    }))
    if (url.pathname === '/api/logs/jsonl') return sendJson(res, 200, buildJsonlLog({
      name: url.searchParams.get('name') || 'toolcalls',
      type: url.searchParams.get('type') || '',
      q: url.searchParams.get('q') || '',
      limit: clampNum(url.searchParams.get('limit'), 1, 200, 50),
      offset: numParam(url, 'offset', 0, 100000, 0),
    }))
    if (url.pathname === '/api/memory') return sendJson(res, 200, buildMemory())
    if (url.pathname === '/api/reports') return sendJson(res, 200, { items: readReports(clampNum(url.searchParams.get('days'), 1, 365, 30)) })
    if (url.pathname === '/api/todos') return sendJson(res, 200, { ...readTodos(), canWrite: requestScope(req) !== 'public' })
    // 控制台代她加 / 删待办：写的是她调度器正在读的那份 todos.json，下一分钟就按新表跑
    if (url.pathname === '/api/todo-add' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      try {
        const body = await readBody(req)
        const row = addTodoFromPanel(body)
        appendAudit('todo-add', { id: row?.id, dueAt: row?.dueAt, targetKey: row?.targetKey, by: clientIp(req) })
        logLine('todo add #' + (row?.id || '?') + ' ' + String(row?.text || '').slice(0, 40))
        return sendJson(res, 200, { ok: true, item: row, todos: readTodos() })
      } catch (e) {
        const message = String(e && e.message || e)
        appendAudit('todo-add-rejected', { by: clientIp(req), error: message })
        return sendJson(res, 400, { ok: false, message })
      }
    }
    if (url.pathname === '/api/todo-delete' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      try {
        const body = await readBody(req)
        const row = removeTodoFromPanel(body.id)
        appendAudit('todo-delete', { id: row?.id, text: String(row?.text || '').slice(0, 60), by: clientIp(req) })
        logLine('todo delete #' + (row?.id || '?'))
        return sendJson(res, 200, { ok: true, item: row, todos: readTodos() })
      } catch (e) {
        const message = String(e && e.message || e)
        appendAudit('todo-delete-rejected', { by: clientIp(req), error: message })
        return sendJson(res, 400, { ok: false, message })
      }
    }
    if (url.pathname === '/api/dynamics') return sendJson(res, 200, buildDynamics(clampNum(url.searchParams.get('limit'), 1, 50, 12)))
    // 她今天的任务清单：只读汇总（看视频/刷动态/说说/三连/日报/搭话/记忆……）
    if (url.pathname === '/api/daily-tasks') return sendJson(res, 200, buildDailyTasks())
    // 她每天做什么：可改的每日任务开关与数量（写 bili.config.json / 仓库 config.json）
    if (url.pathname === '/api/daily-plan' && req.method === 'GET') return sendJson(res, 200, buildDailyPlan())
    // 今天刷的公开动态（好友爱看）：数据来自 qzone.mjs 写的 state/qzone-public-day.json
    if (url.pathname === '/api/qzone-public') return sendJson(res, 200, buildQzonePublic())
    // 她看动态时截下来的图（只服务 state/qzone-public-shots/<今天>/ 里真实存在的文件）
    if (url.pathname === '/api/qzone-public/shot') {
      const hit = qzoneShotFile(new Date().toLocaleDateString('sv-SE'), url.searchParams.get('name') || '')
      if (!hit) return sendJson(res, 404, { ok: false, message: '这张截图已经不在了（每天清空）' })
      const type = /\.png$/i.test(hit) ? 'image/png' : (/\.webp$/i.test(hit) ? 'image/webp' : (/\.gif$/i.test(hit) ? 'image/gif' : 'image/jpeg'))
      const stat = fs.statSync(hit)
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' })
      return fs.createReadStream(hit).pipe(res)
    }
    // 今天刷的 B站视频：观看历史（文字）+ 今日图片池里的封面
    if (url.pathname === '/api/bili-videos') return sendJson(res, 200, buildBiliVideos({ day: url.searchParams.get('day') || undefined }))
    if (url.pathname === '/api/bili-videos/cover') {
      const hit = biliCoverFile(new Date().toLocaleDateString('sv-SE'), url.searchParams.get('name') || '')
      if (!hit) return sendJson(res, 404, { ok: false, message: '封面已经清掉了（每天清空，文字还在）' })
      const type = /\.png$/i.test(hit) ? 'image/png' : (/\.webp$/i.test(hit) ? 'image/webp' : (/\.gif$/i.test(hit) ? 'image/gif' : 'image/jpeg'))
      const stat = fs.statSync(hit)
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' })
      return fs.createReadStream(hit).pipe(res)
    }
    // ── 每日 vlog（2026-11-10）：队列 + 花费 + 成片预览 ────────────────────
    if (url.pathname === '/api/vlog') return sendJson(res, 200, { ...buildVlog({ limit: clampNum(url.searchParams.get('limit'), 1, 50, 20) }), scope: requestScope(req) })
    if (url.pathname === '/api/vlog/script') return sendJson(res, 200, { ok: true, script: vlogScript(url.searchParams.get('date') || '') })
    if (url.pathname === '/api/vlog/media' || url.pathname === '/api/vlog/cover') {
      const kind = url.pathname.endsWith('/cover') ? 'cover' : 'video'
      const hit = vlogMedia(url.searchParams.get('id') || '', kind)
      if (!hit) return sendJson(res, 404, { ok: false, message: '找不到这个文件（可能还没渲染完）' })
      const type = kind === 'cover' ? (/.png$/i.test(hit.file) ? 'image/png' : 'image/jpeg') : 'video/mp4'
      const stat = fs.statSync(hit.file)
      const range = String(req.headers.range || '')
      // 支持 Range：手机上的 <video> 拖动进度条会带 Range，不回 206 就只能从头播
      const m = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (m) {
        const start = m[1] ? Number(m[1]) : 0
        const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1
        if (start >= stat.size || end < start) { res.writeHead(416, { 'content-range': 'bytes */' + stat.size }); return res.end() }
        res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': 'bytes ' + start + '-' + end + '/' + stat.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
        return fs.createReadStream(hit.file, { start, end }).pipe(res)
      }
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' })
      return fs.createReadStream(hit.file).pipe(res)
    }
    if (url.pathname === '/api/vlog/action' && req.method === 'POST') {
      const body = await readBody(req)
      const action = String(body.action || '')
      // 公网隧道只放行审批类动作（发布/驳回/重试/叫她处理）；改文案、标完成属于写数据，必须本机或局域网
      if (!['publish', 'reject', 'retry', 'manual', 'fix-request'].includes(action) && !requireWrite(req, res)) return
      try {
        const r = await vlogAction(body)
        appendAudit('vlog-action', { action, id: String(body.id || ''), by: clientIp(req), ok: r.ok })
        logEvent('vlog-' + action, { id: String(body.id || ''), ok: r.ok })
        logLine('vlog ' + action + ' ' + String(body.id || '') + ' -> ' + (r.ok ? 'ok' : 'fail'))
        invalidateStatus()
        return sendJson(res, r.ok ? 200 : 400, r)
      } catch (e) {
        appendAudit('vlog-action-rejected', { action, by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/logs') return sendJson(res, 200, { name: url.searchParams.get('name') || 'keepalive', text: readLog(url.searchParams.get('name') || 'keepalive', clampNum(url.searchParams.get('lines'), 20, 2000, 200)) })
    if (url.pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, readJson(CFG_FILE, {}))
    if (url.pathname === '/api/config' && req.method === 'POST') {
      // 公网隧道只读：配置写入必须本机或同一 WiFi（owner 2026-11-10 审计发现）
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      // 并发保护（owner 2026-11-09 选择「刷新」）：页面读到的 mtime 和磁盘不一致就不写，让主人刷新重来。
      const baseMtime = Number(body && body.__baseMtime) || 0
      const force = body && body.__force === true
      let currentMtime = 0
      try { currentMtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
      if (baseMtime && currentMtime && !force && Math.abs(currentMtime - baseMtime) > 50) {
        appendAudit('config-conflict', { at: currentMtime, base: baseMtime })
        return sendJson(res, 409, {
          ok: false,
          code: 'config-conflict',
          message: '配置刚被别处改过（可能是桥接或另一个页面），这次没有写入。刷新页面再保存即可。',
          mtime: currentMtime,
        })
      }
      const patch = { ...(body || {}) }
      delete patch.__baseMtime
      delete patch.__force
      const cfg = applyPatch(readJson(CFG_FILE, {}), patch)
      atomicWriteJson(CFG_FILE, cfg)
      let nextMtime = 0
      try { nextMtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
      logLine('config patched')
      appendAudit('config-patch', { keys: Object.keys(patch || {}) })
      return sendJson(res, 200, { ok: true, config: summarizeConfig(cfg), mtime: nextMtime })
    }
    // ── 说话方式（「鱼八股」，2026-11-22）：她每轮唤醒都会看到的那段话，由主人在这里改 ──
    //    数据落 <DSH_HOME>/stellar/state/voice-style.json，桥接每轮读一次（改完下一轮生效，不用重启）。
    //    写盘只能走这里：她没有任何写配置的工具，群友诱导不了她改自己的说话方式。
    if (url.pathname === '/api/voice-style' && req.method === 'GET') {
      return sendJson(res, 200, await readVoicePanel())
    }
    if (url.pathname === '/api/voice-style' && req.method === 'POST') {
      // 公网隧道只读：改她说话的方式算改配置，必须本机或同一 WiFi
      if (!requireWrite(req, res)) return
      const bad = crossSite(req)
      if (bad) return sendJson(res, 403, { ok: false, message: bad })
      const body = await readBody(req)
      const r = await saveVoicePanel(body || {})
      const st = r.style || (body && typeof body === 'object' ? body : {}) || {}
      appendAudit('voice-style-save', {
        ok: r.ok,
        enabled: st.enabled !== false,
        stats: st.stats !== false,
        principles: Array.isArray(st.principles) ? st.principles.length : 0,
        entries: Array.isArray(st.entries) ? st.entries.length : 0,
      })
      logLine('voice-style save ' + (r.ok ? 'ok' : 'rejected'))
      return sendJson(res, r.ok ? 200 : 400, r)
    }
    if (url.pathname === '/api/voice-style/restore' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const bad = crossSite(req)
      if (bad) return sendJson(res, 403, { ok: false, message: bad })
      const r = await restoreVoicePanel()
      appendAudit('voice-style-restore', { ok: r.ok, restored: String(r.restored || '') })
      logLine('voice-style restore ' + (r.ok ? 'ok' : 'rejected'))
      return sendJson(res, r.ok ? 200 : 400, r)
    }
    // ── 鱼缸小镇：她自己的日子（只读快照 + 3 天记忆；开关走 /api/capabilities 的 town）──
    if (url.pathname === '/api/town' && req.method === 'GET') {
      const scope = requestScope(req)
      const snap = capabilitiesSnapshot()
      const item = (snap.items || []).find((x) => x && x.id === 'town') || null
      const ours = !!(item && item.enabled)
      const data = buildTown()
      // 快照里那份是「调度器上次采集时看到的」，插件刚装/刚关时不新鲜，所以先问文件。
      const plugin = (await townPluginStatus()) || (data.snapshot && data.snapshot.plugin) || null
      return sendJson(res, 200, {
        ...data,
        plugin,
        cap: {
          enabled: ours || Boolean(plugin && plugin.takesTurns),
          mtime: (item && item.mtime) ?? snap.mtime,
          ours,
          plugin: Boolean(plugin && plugin.takesTurns),
        },
        scope,
        canWrite: scope !== 'public'
      })
    }

    // ── 小镇相册（2026-11-22）：她拍的照片/请人画的画，调度器镜像到 state/town/album/ ──
    //    可见性：本机 → 原图；局域网 → 只能拿缩略图；公网 → 一律不给（她的照片，不在隧道上摊）。
    if (url.pathname === '/api/town/album' && req.method === 'GET') {
      const scope = requestScope(req)
      if (scope === 'public') {
        return sendJson(res, 403, { ok: false, code: 'readonly-public', message: '小镇相册只在本机或同一 WiFi 下看' })
      }
      const data = listTownAlbum()
      return sendJson(res, 200, {
        ...data,
        scope,
        canSeeOriginal: scope === 'local',
        canWrite: scope !== 'public',
      })
    }
    if (url.pathname === '/api/town/album/file') {
      const scope = requestScope(req)
      if (scope === 'public') return sendJson(res, 403, { ok: false, code: 'readonly-public', message: '小镇相册只在本机或同一 WiFi 下看' })
      const name = String(url.searchParams.get('name') || '')
      const wantThumb = String(url.searchParams.get('thumb') || '') === '1'
      const file = scope === 'local' && !wantThumb ? townAlbumFile(name) : townAlbumThumb(name)
      if (!file) return sendJson(res, 404, { ok: false, message: scope === 'local' ? '这张照片已经不在了（相册按 60 张 / 120MB 轮换）' : '这张还没有缩略图，原图只在本机看' })
      const type = /\.png$/i.test(file) ? 'image/png' : (/\.webp$/i.test(file) ? 'image/webp' : (/\.gif$/i.test(file) ? 'image/gif' : 'image/jpeg'))
      const stat = fs.statSync(file)
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' })
      return fs.createReadStream(file).pipe(res)
    }

    // ── 她的能力：一组真实生效的开关（写 bili.config.json，调度器/MCP 下轮就生效）──
    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      const scope = requestScope(req)
      return sendJson(res, 200, { ...capabilitiesSnapshot(), scope, canWrite: scope !== 'public' })
    }
    if (url.pathname === '/api/capabilities' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const baseMtime = Number(body && body.__baseMtime) || 0
      const force = body && body.__force === true
      let currentMtime = 0
      try { currentMtime = fs.statSync(CFG_FILE).mtimeMs } catch {}
      if (baseMtime && currentMtime && !force && Math.abs(currentMtime - baseMtime) > 50) {
        appendAudit('capability-conflict', { at: currentMtime, base: baseMtime })
        return sendJson(res, 409, {
          ok: false,
          code: 'config-conflict',
          message: '配置刚被别处改过，这次没有写入。刷新页面再保存即可。',
          mtime: currentMtime,
        })
      }
      try {
        const r = saveCapabilities(body.updates)
        appendAudit('capability-save', { by: clientIp(req), updated: r.updated })
        logEvent('capability-save', { by: clientIp(req), count: r.updated.length })
        logLine('capabilities updated: ' + r.updated.map((x) => x.id + '=' + x.enabled).join(','))
        // 「进镇」这个开关要写两处：我们的 town.enabled + 官方插件那条鱼的 enabled。
        // 只写一边的后果是「面板关了但它还在镇里」。
        let plugin = null
        if (body && body.updates && Object.prototype.hasOwnProperty.call(body.updates, 'town')) {
          plugin = await setTownPluginEnabled(Boolean(body.updates.town))
          appendAudit('town-plugin-switch', { on: Boolean(body.updates.town), result: plugin && (plugin.ok ? (plugin.changed ? 'written' : 'same') : 'failed') })
          logLine('town plugin switch -> ' + (plugin && plugin.ok ? (plugin.changed ? 'written' : 'same') : 'skipped/failed'))
        }
        invalidateStatus()
        return sendJson(res, 200, { ...capabilitiesSnapshot(), ...r, ...(plugin ? { plugin } : {}) })
      } catch (e) {
        appendAudit('capability-save-rejected', { by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/approvals' && req.method === 'GET') {
      return sendJson(res, 200, readApprovals({ status: url.searchParams.get('status') || '', limit: clampNum(url.searchParams.get('limit'), 1, 100, 30) }))
    }
    // ── 她每天做什么：开关 + 数量（白名单字段，冲突用 409）──
    if (url.pathname === '/api/daily-plan' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const baseMtime = Number(body && body.__baseMtime) || 0
      try {
        const r = saveDailyPlan(body && body.values, baseMtime)
        appendAudit('daily-plan-save', { by: clientIp(req), updated: r.updated, wrote: r.wrote })
        logEvent('daily-plan-save', { by: clientIp(req), count: r.updated })
        logLine('daily plan updated: ' + r.updated + ' fields, wrote ' + r.wrote.join('+'))
        invalidateStatus()
        return sendJson(res, 200, { ...buildDailyPlan(), saved: r })
      } catch (e) {
        const conflict = Boolean(e && e.code === 'plan-conflict')
        appendAudit('daily-plan-save-rejected', { by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, conflict ? 409 : 400, { ok: false, code: (e && e.code) || 'plan-invalid', message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/approvals/action' && req.method === 'POST') {
      const body = await readBody(req)
      const by = 'panel:' + clientIp(req)
      const r = actOnApproval(body.id, body.action, by)
      appendAudit('approval-action', { id: String(body.id || ''), action: String(body.action || ''), by, ok: r.ok, code: r.code || '' })
      logEvent('approval-action', { action: String(body.action || ''), by, ok: r.ok })
      logLine('approval ' + String(body.action || '') + ' ' + String(body.id || '') + ' -> ' + (r.ok ? 'ok' : r.message))
      invalidateStatus()
      return sendJson(res, r.ok ? 200 : 400, r)
    }
    // ── 通讯录（谁能跟她说话 · 人物档案）────────────────────────────────────
    if (url.pathname === '/api/contacts' && req.method === 'GET') {
      await ensureContacts()
      const book = loadContacts()
      const scope = requestScope(req)
      return sendJson(res, 200, {
        ok: true,
        ...book,
        scope,
        canWrite: scope !== 'public',
        allowPrivate: loadAllowPrivate(),
        ownerQQ: book.people.find((p) => p.type === 'owner')?.uin || null,
        roles: ['owner', 'friend', 'stranger', 'group']
      })
    }
    if (url.pathname === '/api/contacts/sync' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const r = await syncContacts({ force: true })
      appendAudit('contact-sync', { by: clientIp(req), people: (r.people || []).length, groups: (r.groups || []).length })
      logLine('contacts synced from OneBot')
      return sendJson(res, 200, { ok: true, ...r })
    }
    // 2026-11-11 主人要求：私聊白名单改成从通讯录里点（不再手填 QQ 号）
    if (url.pathname === '/api/contacts/allow' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      try {
        const r = await setContactAllow({ uin: body?.uin, allow: body?.allow !== false }, { by: 'panel:' + clientIp(req), source: 'contacts' })
        logEvent('contact-allow', { by: clientIp(req), uin: r.uin, allow: r.allow, changed: r.changed })
        logLine('contacts whitelist ' + (r.allow ? 'add ' : 'remove ') + r.uin + ' (changed=' + r.changed + ')')
        invalidateStatus()
        return sendJson(res, 200, r)
      } catch (e) {
        appendAudit('contact-allow-rejected', { by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/contacts' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      try {
        const r = saveContacts(body || {}, { by: 'panel:' + clientIp(req), source: 'panel' })
        logEvent('contact-save', { by: clientIp(req), count: r.count })
        logLine('contacts updated by panel')
        invalidateStatus()
        return sendJson(res, 200, r)
      } catch (e) {
        appendAudit('contact-save-rejected', { by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }

    // ── 发件箱 / 查岗审计 ──────────────────────────────────────────────────
    if (url.pathname === '/api/outbox' && req.method === 'GET') {
      seedOutboxFromToolCalls()
      const target = String(url.searchParams.get('target') || '').trim()
      const limit = clampNum(url.searchParams.get('limit'), 1, 200, 50)
      const offset = clampNum(url.searchParams.get('offset'), 0, 100000, 0)
      const owner = String((readJson(BRIDGE_CFG, {}) || {}).ownerQQ || '')
      const data = readOutbox({ target, limit, offset, excludeTarget: target ? '' : owner })
      const index = contactIndex()
      const decorate = (e) => {
        const k = (e.kind === 'group' ? 'group:' : 'private:') + e.target
        return { ...e, name: nameForKey(index, k), relation: relationFor(index, k) }
      }
      return sendJson(res, 200, {
        ok: true,
        ...data,
        items: data.items.map(decorate),
        targets: data.targets.map(decorate),
        audit: readChatAudit({ limit: 30 })
      })
    }

    // ── 状态控制：强制休眠 / 立即唤醒 / 主人快捷指令 ────────────────────────
    if (url.pathname === '/api/task' && req.method === 'GET') {
      const t = await readTaskState()
      const scope = requestScope(req)
      return sendJson(res, 200, { ...t, ok: true, bridgeOk: t.ok === true, canWrite: scope !== 'public', scope })
    }
    // ── 她自己上网找的图：列表 / 原图 / 删一张 / 清空（owner 2026-11-11）──
    // 与 B站封面分开放（状态在 ~/.dsh/stellar/web-images/<日期>/），每天清空但索引留着，
    // 所以控制台能看到「今天她找了什么、删了哪几张」。
    if (url.pathname === '/api/web-images' && req.method === 'GET') {
      const scope = requestScope(req)
      return sendJson(res, 200, { ...buildWebImages(), canWrite: scope !== 'public' })
    }
    if (url.pathname === '/api/web-images/file') {
      const name = String(url.searchParams.get('name') || '')
      const file = webImageFile(name)
      if (!file) return sendJson(res, 404, { ok: false, message: '这张图已经不在了（每天清空）' })
      const type = /\.png$/i.test(file) ? 'image/png' : (/\.webp$/i.test(file) ? 'image/webp' : (/\.gif$/i.test(file) ? 'image/gif' : 'image/jpeg'))
      const stat = fs.statSync(file)
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-store' })
      return fs.createReadStream(file).pipe(res)
    }
    if (url.pathname === '/api/web-images/delete' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = 'panel:' + clientIp(req)
      try {
        const r = deleteWebImage(String(body.name || ''), { by })
        if (!r.ok) return sendJson(res, 404, r)
        appendAudit('web-image-delete', { name: String(body.name || ''), by })
        logLine('web-image delete ' + String(body.name || ''))
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/web-images/clear' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const by = 'panel:' + clientIp(req)
      try {
        const r = clearWebImages({ by })
        appendAudit('web-image-clear', { removed: r.removed, by })
        logLine('web-image clear removed=' + r.removed)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }

    // ── 主人的文件柜：她和我聊天要用的文档/图片放一处（owner 2026-11-20）──
// 目录 ~/.dsh/stellar/files/，跨天保留。她不主动读；需要时用 stellar_file_list 现查、
// 用 stellar_file_read(path=...) 读单个文件，所以这里不需要往提示词里灌清单。
if (url.pathname === '/api/files' && req.method === 'GET') {
  const scope = requestScope(req)
  try {
    return sendJson(res, 200, { ...listCabinetFiles(), canWrite: scope !== 'public' })
  } catch (e) {
    return sendJson(res, 500, { ok: false, message: '读取文件柜失败：' + String(e && e.message || e) })
  }
}
if (url.pathname === '/api/files/download') {
  const file = cabinetFilePath(url.searchParams.get('name') || '')
  if (!file) return sendJson(res, 404, { ok: false, message: '这个文件已经不在了' })
  const ext = path.extname(file).toLowerCase()
  const TYPE = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
    '.zip': 'application/zip',
  }
  const type = TYPE[ext] || 'application/octet-stream'
  const stat = fs.statSync(file)
  const inline = /^image\//.test(type) || /^text\//.test(type) || type === 'application/pdf'
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'no-store',
    'content-disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(path.basename(file)),
  })
  return fs.createReadStream(file).pipe(res)
}
if (url.pathname === '/api/files/upload' && req.method === 'POST') {
  if (!requireWrite(req, res)) return
  const by = 'panel:' + clientIp(req)
  // 大文件走原始字节体（2026-11-20，上限 512 MB）：base64 JSON 会把内存翻一倍多，
  // 几百 MB 的文件在面板进程里直接吃满。非 JSON 请求一律按流式收。
  const isJson = /application\/json/i.test(String(req.headers['content-type'] || ''))
  if (!isJson) {
    const name = String(url.searchParams.get('name') || req.headers['x-file-name'] || '')
    try {
      const r = await saveCabinetStream(name, req, { by })
      if (!r.ok) return sendJson(res, 400, r)
      appendAudit('file-upload', { name: r.name, bytes: r.bytes, by })
      logLine('file upload ' + r.name + ' (' + r.bytes + ' B)')
      return sendJson(res, 200, r)
    } catch (e) {
      return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
    }
  }
  const body = await readJsonBody(req)
  try {
    const r = saveCabinetFile(String(body.name || ''), String(body.base64 || ''), { by })
    if (!r.ok) return sendJson(res, 400, r)
    appendAudit('file-upload', { name: r.name, bytes: r.bytes, by })
    logLine('file upload ' + r.name + ' (' + r.bytes + ' B)')
    return sendJson(res, 200, r)
  } catch (e) {
    return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
  }
}
if (url.pathname === '/api/files/delete' && req.method === 'POST') {
  if (!requireWrite(req, res)) return
  const by = 'panel:' + clientIp(req)
  const body = await readBody(req)
  try {
    const r = deleteCabinetFile(String(body.name || ''), { by })
    if (!r.ok) return sendJson(res, 404, r)
    appendAudit('file-delete', { name: r.name, by })
    logLine('file delete ' + r.name)
    return sendJson(res, 200, r)
  } catch (e) {
    return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
  }
}
// ── 新记忆库（SQLite）：概览 / 话题 / 零碎 / 侧写 / 参考库（owner 2026-11-13）──
    // 库文件与桥接共用一份（characters/<角色>/memory/memory.db）；这里只读 + 三个写操作，
    // 判定逻辑全在 stellar/src/memory-db.js 与 memory-worker.js，面板不重写规则。
    if (url.pathname === '/api/memory-db' && req.method === 'GET') {
      const scope = requestScope(req)
      return sendJson(res, 200, { ...buildMemoryDb(), canWrite: scope !== 'public' })
    }
    if (url.pathname === '/api/memory-db/topics') return sendJson(res, 200, listTopics({
      owner: url.searchParams.get('owner') || '',
      tier: url.searchParams.get('tier') || '',
      day: url.searchParams.get('day') || '',
      q: url.searchParams.get('q') || '',
      offset: numParam(url, 'offset', 0, 100000, 0),
      limit: numParam(url, 'limit', 1, 100, 20),
    }))
    if (url.pathname === '/api/memory-db/topic') return sendJson(res, 200, readTopicDetail(url.searchParams.get('id') || ''))
    if (url.pathname === '/api/memory-db/fragments') return sendJson(res, 200, listFragments({
      owner: url.searchParams.get('owner') || '',
      tier: url.searchParams.get('tier') || '',
      day: url.searchParams.get('day') || '',
      limit: numParam(url, 'limit', 1, 200, 60),
    }))
    if (url.pathname === '/api/memory-db/tier' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = setMemoryTier({ type: body.type, id: body.id, tier: body.tier })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('memory-tier', { type: r.type, id: String(r.id), tier: r.tier, by })
        logLine('memory-tier ' + r.type + ' ' + r.id + ' -> ' + r.tier)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/memory-db/forget' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = forgetMemory({ type: body.type, id: body.id })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('memory-forget', { type: r.type, id: String(r.id), by, exported: r.exported })
        logLine('memory-forget ' + r.type + ' ' + r.id)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/memory-db/run' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = await runMemoryJob({ job: body.job })
        appendAudit('memory-job', { job: String(body.job || 'split'), by, ok: r.ok })
        logLine('memory-job ' + String(body.job || 'split') + ' ok=' + r.ok)
        return sendJson(res, r.ok ? 200 : 400, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    // ── 见闻区：B站 / 好友爱看（owner 2026-11-13）：她自己写、控制台只看和删 ──
    if (url.pathname === '/api/memory-db/zones' && req.method === 'GET') {
      const scope = requestScope(req)
      const zone = url.searchParams.get('zone') || 'bili'
      return sendJson(res, 200, { ...listZoneNotes({
        zone,
        day: url.searchParams.get('day') || '',
        limit: numParam(url, 'limit', 1, 200, 20),
      }), canWrite: scope !== 'public' })
    }
    if (url.pathname === '/api/memory-db/zone-delete' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = deleteZoneNote({ id: body.id })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('memory-zone-delete', { id: r.id, zone: r.zone, by, exported: r.exported })
        logLine('memory-zone-delete ' + r.zone + ' #' + r.id)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/memory-db/zone-clear' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = clearZoneNotes({ zone: body.zone, day: body.day })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('memory-zone-clear', { zone: r.zone, deleted: r.deleted, by, exported: r.exported })
        logLine('memory-zone-clear ' + r.zone + ' deleted=' + r.deleted)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    // ── 重要事实（主人 2026-11-13）：生日/忌口/联系方式按人对号存，面板可注入、可改、可删 ──
    if (url.pathname === '/api/memory-db/facts' && req.method === 'GET') {
      const scope = requestScope(req)
      return sendJson(res, 200, { ...listFacts({
        owner: url.searchParams.get('owner') || '',
        privacy: url.searchParams.get('privacy') || '',
        limit: numParam(url, 'limit', 1, 200, 50),
      }), canWrite: scope !== 'public' })
    }
    if (url.pathname === '/api/memory-db/fact-save' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = saveFact({ id: body.id, ownerId: body.ownerId, kind: body.kind, label: body.label, text: body.text, privacy: body.privacy, weight: body.weight })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('memory-fact-save', { id: r.id, ownerId: String(body.ownerId || ''), kind: String(body.kind || ''), privacy: String(body.privacy || ''), by, created: !!r.created, merged: !!r.merged })
        logLine('memory-fact-save ' + String(body.ownerId || '') + ' ' + String(body.kind || '') + ' #' + r.id)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/memory-db/fact-delete' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = deleteFact({ id: body.id })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('memory-fact-delete', { id: r.id, by, exported: r.exported })
        logLine('memory-fact-delete #' + r.id)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/profiles' && req.method === 'GET') return sendJson(res, 200, listProfiles())
    if (url.pathname === '/api/profiles' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = saveProfile({ ownerId: body.ownerId, persona: body.persona, detail: body.detail, tags: body.tags })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('profile-save', { ownerId: r.ownerId, before: maskText(r.before, 50), after: maskText(r.after, 50), by })
        logLine('profile-save ' + r.ownerId)
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/profiles/generate' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const by = clientIp(req)
      try {
        const r = requestMemoryJob({ job: 'profile' })
        appendAudit('profile-generate', { by, queued: r.ok })
        logLine('profile-generate queued=' + r.ok)
        return sendJson(res, r.ok ? 200 : 400, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/style-refs' && req.method === 'GET') return sendJson(res, 200, listStyleRefs())
    if (url.pathname === '/api/style-refs' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const by = clientIp(req)
      try {
        const r = setStyleRefEnabled({ id: body.id, source: body.source, enabled: Boolean(body.enabled) })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('style-ref-toggle', { id: r.id === undefined ? null : r.id, source: r.source || String(body.source || ''), part: r.part || '', enabled: r.enabled, changed: r.changed, by })
        return sendJson(res, 200, r)
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    // ── 运行模式：正常 / 摸鱼 / 最低限度（owner 2026-11-11 22:25）──────────
    if (url.pathname === '/api/run-mode' && req.method === 'GET') {
      const scope = requestScope(req)
      return sendJson(res, 200, { ...readRunMode(), ok: true, canWrite: scope !== 'public' })
    }
    if (url.pathname === '/api/run-mode' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const mode = String(body.mode || '')
      const by = 'panel:' + clientIp(req)
      try {
        const r = saveRunMode(mode, { by })
        appendAudit('run-mode', { mode, by })
        logEvent('run-mode', { mode, by })
        logLine('run-mode ' + mode + ' by ' + by)
        invalidateStatus()
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/task/action' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const action = String(body.action || '')
      const by = 'panel:' + clientIp(req)
      try {
        let r
        if (action === 'pause') r = await setPaused(true)
        else if (action === 'resume') r = await setPaused(false)
        else if (action === 'wake') r = await wakeOwner()
        else if (action === 'command') r = await sendOwnerCommand(String(body.text || ''))
        else return sendJson(res, 400, { ok: false, message: '未知操作' })
        appendAudit('task-action', { action, by, text: maskText(body.text || '', 60) })
        logEvent('task-action', { action, by })
        logLine('task ' + action + ' by ' + by)
        invalidateStatus()
        return sendJson(res, 200, { ok: true, action, ...r })
      } catch (e) {
        appendAudit('task-action-rejected', { action, by, text: maskText(body.text || '', 60), error: String(e && e.message || e) })
        logLine('task ' + action + ' failed: ' + String(e && e.message || e))
        return sendJson(res, 400, { ok: false, action, message: String(e && e.message || e) })
      }
    }

    // ── 记忆热修改（同时更新 card 和 full）────────────────────────────────
    if (url.pathname === '/api/memory/save' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      try {
        const r = updateMemoryItem(String(body.id || ''), body.patch || {})
        if (r.changed) appendAudit('memory-save', { id: r.id, before: r.before, after: r.after, by: clientIp(req) })
        logLine('memory ' + r.id + ' saved by panel' + (r.changed ? '' : ' (no change)'))
        invalidateStatus()
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        appendAudit('memory-save-rejected', { id: String(body.id || ''), by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    if (url.pathname === '/api/memory/add' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      try {
        const r = addMemoryItem(body || {})
        appendAudit('memory-add', { id: r.record.id, text: maskText(r.record.text || '', 80), importance: r.record.importance, by: clientIp(req) })
        logLine('memory added ' + r.record.id + ' by panel')
        invalidateStatus()
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        appendAudit('memory-add-rejected', { by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }
    // 手动清空分层记忆（2026-11-11）：写操作 + 二次确认；隧道里也拦（同 /api/memory/forget）。
    if (url.pathname === '/api/memory/tier-clear' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      try {
        const r = await clearMemoryTier({ tier: body.tier || 'L3', confirm: body.confirm === true })
        if (!r.ok) return sendJson(res, 400, r)
        appendAudit('memory-tier-clear', { tier: r.tier, cleared: r.cleared.length, promoted: r.promoted.length, by: clientIp(req) })
        logLine('memory tier ' + r.tier + ' cleared by panel: ' + r.cleared.length + ' records')
        invalidateStatus()
        return sendJson(res, 200, r)
      } catch (e) {
        appendAudit('memory-tier-clear-rejected', { by: clientIp(req), error: String(e && e.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e && e.message || e) })
      }
    }

    // 清空今天的截图（文字账本不动）—— 主人要的是「图没了字还在」
    if (url.pathname === '/api/qzone-public/shots-clear' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const r = clearQzoneShots({})
      appendAudit('qzone-shots-clear', { removed: r.removed, by: clientIp(req) })
      logLine('qzone scan shots cleared: ' + r.removed)
      invalidateStatus()
      return sendJson(res, 200, r)
    }
    // B站视频模块：删一条记录 / 清空今天的封面（文字保留）
    if (url.pathname === '/api/bili-videos/delete' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const r = deleteBiliVideo({ bvid: body.bvid })
      appendAudit('bili-videos-delete', { bvid: String(body.bvid || ''), ok: r.ok, removed: r.removed || 0, by: clientIp(req) })
      if (!r.ok) return sendJson(res, 400, r)
      logLine('bili video record deleted by panel: ' + String(body.bvid || ''))
      invalidateStatus()
      return sendJson(res, 200, r)
    }
    if (url.pathname === '/api/bili-videos/covers-clear' && req.method === 'POST') {
      if (!requireWrite(req, res)) return
      const r = clearBiliCovers({})
      appendAudit('bili-covers-clear', { removed: r.removed, by: clientIp(req) })
      logLine('bili covers cleared: ' + r.removed)
      invalidateStatus()
      return sendJson(res, 200, r)
    }

    if (url.pathname === '/api/access' && req.method === 'GET') return sendJson(res, 200, await readAccess())
    if (url.pathname === '/api/access' && req.method === 'POST') {
      // 能否跟她说上话决定她被谁唤醒，属于写操作，公网隧道不给改
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      try {
        const r = await saveAccess(body || {})
        appendAudit('access-save', {
          by: clientIp(req),
          ownerQQ: r.ownerQQ,
          allow: r.allow,
          deny: r.deny,
        })
        logEvent('access-save', { by: clientIp(req), allow: r.allow, deny: r.deny })
        logLine('access updated (bridge hot reload)')
        invalidateStatus()
        return sendJson(res, 200, r)
      } catch (e) {
        appendAudit('access-save-rejected', { by: clientIp(req), error: String(e?.message || e) })
        return sendJson(res, 400, { ok: false, message: String(e?.message || e) })
      }
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      // 快捷操作会重启 DSH、停机器人、改写生物钟计划 —— 公网隧道只读，审批请走 /api/approvals/action
      if (!requireWrite(req, res)) return
      const body = await readBody(req)
      const action = String(body.action || '')
      appendAudit('action', { action, text: maskText(body.text || '', 60) })
      logEvent('action', { action, by: clientIp(req) })
      if (action === 'keepalive') return sendJson(res, 200, await actionKeepalive())
      if (action === 'start-snowluma') return sendJson(res, 200, await actionStartSnowluma())
      if (action === 'clean-snowluma') return sendJson(res, 200, await actionCleanSnowluma())
      if (action === 'start-bridge') return sendJson(res, 200, await actionStartBridge())
      if (action === 'restart-dsh') {
        const result = await restartDsh('panel:' + clientIp(req), { delayMs: Number(body.delaySeconds || 0) * 1000 })
        return sendJson(res, result.ok ? 200 : 400, result)
      }
      if (action === 'qzone') return sendJson(res, 200, await actionQzone(body))
      if (action === 'stop') return sendJson(res, 200, actionStop({ active: true, by: 'panel:' + clientIp(req), reason: String(body.reason || '') }))
      if (action === 'resume') return sendJson(res, 200, actionStop({ active: false, by: 'panel:' + clientIp(req) }))
      if (action === 'set-passphrase') {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, message: '换口令只能在这台电脑上做' })
        const r = setPassphrase(String(body.passphrase || ''))
        return sendJson(res, r.ok ? 200 : 400, r)
      }
      if (action === 'replan') return sendJson(res, 200, await actionReplan())
      if (action === 'report-request') return sendJson(res, 200, await actionReportRequest())
      if (action === 'tunnel-start') return sendJson(res, 200, startTunnel())
      if (action === 'tunnel-stop') return sendJson(res, 200, stopTunnel())
      // 命名隧道（固定域名）：token 只有本机能填，公网进来的人不能改这条通道。
      if (action === 'tunnel-named') {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, message: '改远程通道只能在跑面板的这台电脑上做' })
        const r = setNamedTunnel({ token: String(body.token || ''), hostname: String(body.hostname || '') })
        if (r.ok) appendAudit('tunnel-named', { hostname: String(body.hostname || '').slice(0, 80), token: body.token ? 'set' : 'kept' })
        return sendJson(res, r.ok ? 200 : 400, r)
      }
      if (action === 'tunnel-quick') {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, message: '改远程通道只能在跑面板的这台电脑上做' })
        appendAudit('tunnel-quick', {})
        return sendJson(res, 200, clearNamedTunnel())
      }
      if (action === 'rotate-token') {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, message: '换口令只能在这台电脑上做' })
        const next = rotateToken()
        return sendJson(res, 200, { ok: true, message: '新口令：' + next + '（其他设备需要重新输入）', token: next })
      }
      return sendJson(res, 400, { ok: false, message: 'unknown action' })
    }
    if (servePublic(res, url.pathname)) return
    sendJson(res, 404, { ok: false, message: 'not found' })
  } catch (error) {
    logLine('error ' + (error && error.stack ? error.stack : error))
    // 只记路径，不记 query：旧版 ?token= 链接里的口令不能落到日志里。
    logEvent('server-error', { path: String(req.url || '').split('?')[0], message: String(error && error.message || error) })
    if (!res.headersSent) sendJson(res, 500, { ok: false, message: String(error && error.message || error) })
    else try { res.end() } catch {}
  }
})

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.log('面板已经在运行: http://' + HOST + ':' + PORT)
    process.exit(0)
  }
  console.log('panel error: ' + (error && error.message || error))
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const local = 'http://127.0.0.1:' + PORT
  const lan = lanAddresses().map((a) => 'http://' + a.address + ':' + PORT)
  console.log('')
  console.log('  ✦ Stellar 控制台')
  console.log('    她的世界 · QQ / B站 / 空间 / 守护')
  console.log('')
  console.log('Stellar 控制台: ' + local)
  // 口令一律不打印（2026-11-21 安全审计 S10）：console 会被重定向进 panel.log，
  // 而 panel.log 的 ACL 不由本程序控制，同机别的账户可能读得到（PITFALLS #208）。
  // 需要口令时读 panel-token.txt，或在面板「手机访问」里点复制链接生成一次性登录码。
  // 只听本机时，局域网地址没意义（别的设备连不上），所以不打印。
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(String(HOST))
  if (!loopbackOnly) {
    for (const u of lan) console.log('手机访问: ' + u + '（口令见 panel-token.txt，或在面板里点复制登录链接）')
  } else {
    console.log('只监听本机（127.0.0.1）。想让同一 WiFi 的手机连，设 STELLAR_PANEL_HOST=0.0.0.0 再启动。')
  }
  console.log('本机入口: ' + local + '（快捷方式里带 ?code=<panel-token.txt 里的口令>）')
  // 不要把口令写进日志：panel.log 的 ACL 不受这里控制，同机别的账户可能读得到（PITFALLS #208）
  logLine('panel started on ' + PORT + ' host=' + HOST + ' lan=' + lan.join(','))
  resumeRestartPolling()
  reconcileRestartState()
  if (process.env.STELLAR_NO_TUNNEL !== '1') {
    resumeTunnel()
    setInterval(ensureTunnel, 20000).unref()
  } else {
    logLine('tunnel disabled by STELLAR_NO_TUNNEL=1')
  }
})
// 上传文件走 base64 JSON，2 MB 的 readBody 装不下；只给 /api/files/upload 用。
async function readJsonBody(req, maxBytes = 60 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) { overflow = true; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (overflow) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
    })
  })
}
