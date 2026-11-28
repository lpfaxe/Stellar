// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  // P0 身份闸（2026-11-11 方案 2）：stellar_* 主人工具只认会话令牌。旧实现用
  // state/turn-context.json 判断「最近说话的是不是主人」—— 主人在 15 分钟内说过话，
  // 群友就能诱导模型把 key 写成 private:<主人QQ>，11 个主人读工具（含任意文件读取）
  // 与 6 个写工具全开。这条测试把判定矩阵钉死，防止「没有快照就信任 key」被加回来。
  'test-owner-identity-token.mjs',
  // 2026-11-13：file_read 原来能读任意绝对路径、能请求任意 URL（含 127.0.0.1:3300），
  // 现在两道闸都在 src/file-read-guard.js，这条钉子防止有人把白名单放宽。
  'test-file-read-guards.mjs',
  // 2026-11-20：主人说「先存下」，她只能空口回「收好了」——文件柜没有写入口。
  // 这条钉住写入规则与面板一致（同名不覆盖 / 索引 / 512MB / 目录穿越），以及提示里真的教她调工具。
  'test-file-cabinet.mjs',
  // 2026-11-20：扫描版 PDF 走 Windows 自带 OCR（零安装）。
  'test-ocr-fallback.mjs',
  // 敏感文件（config.json / bili.config.json / panel-token.txt）写完必须重新收紧 ACL ——
  // 2026-11-13 事故：桥接回写 dsh 端口后，手工加固过的 config.json 十分钟内退回 Authenticated Users:M。
  'test-sensitive-acl-hardening.mjs',
  // 通讯录成员（2026-11-11 主人要）：她能去朋友的说说里点赞/评论/回复、能看图。
  // 以前 qzoneAllowedUins 只认主人和自己，且 read 只有 owner/mine/friends 三个 scope；
  // 这条把「person scope 的参数透传 + 白名单边界」钉住：进了通讯录能互动，没进的一律拒。
  'test-qzone-person-scope.mjs',
// 别人从 App 分享来的卡片（B站视频最常见）：以前只变成「[卡片消息]」，标题和链接全丢。
// 这条钉住「卡片 → 标题 + BV/链接」的渲染，用的是测试员A 真实卡片的结构。
  'test-ark-card.mjs',
  // 成本闸（2026-11-12 主人要省 token）：330 轮里 wait 392 次、close 268 次，每次都要
  // 重发整段上下文（平均 91K），合计占账单 17.7%。预设早就写了「发完就 reply_and_finish」，
  // 但 145 轮 wait+close 同现、44 轮 wait>2 次 —— 提示词执行率不够，所以加代码兜底：
  // 同会话 90 秒内普通等待最多 2 次、45 秒内收尾最多 1 次；reply 型与沉睡前 300 秒观察不拦。
  // 这条钉住「该拦的拦得住、不该拦的一个都不能误伤」。
  'test-wait-cost-guard.mjs',
  // 记忆库（2026-11-13 记忆重构 P0）：新 SQLite 存储层。这条钉住四件最容易写坏的事：
  // ① 入站与出站都要落盘（只记一边，话题就变成单边独白）；② 话题必须同时有 user 与 self；
  // ③ candidate 正文在 topic_msg 里独立一份（2 天后删 cache 不能把重要记忆一起删）；
  // ④ 2 字中文 FTS trigram 搜不到，必须走 bigrams LIKE 兜底。
  'test-memory-db.mjs',
  // 写入侧：kind 判定、只有图也要落、出站 role=self、库不可用不抛。
  'test-memory-cache.mjs',
  // 切分器：双方都说话才建话题；单边先 held、够长降级零碎、挂满 2 小时才丢；窗口只清 D-2 且不碰 important。
  'test-memory-worker.mjs',
  // 复核/侧写：模型只许按候选白名单晋升；不给 JSON 就整批保留；手写侧写不许被自动覆盖。
  'test-memory-review.mjs',
  // 定时点：这台机器 0 点后断电断网，复核必须排在 06:30 之后且能被 config 覆盖；
  // 退回硬编码不会报错，只会安静地永远不跑。
  'test-memory-schedule.mjs',
  // 注入读侧（唤醒用的同步快照）：第一次读必须为空、预热后能拿到标题不给正文、
  // 侧写单独一行、库坏掉时保留上一份好结果（stale 比空更安全）。
  // 群聊记忆：旁观话题要能切出来、不进重要晋升，按人查要能同时捞私聊与群话题（2026-11-15）。
  'test-group-memory.mjs',
  'test-memory-inject.mjs',
  // 记忆库视图（设置页「记忆」页签的数据源）：钉住「空库也能出完整结构」与
  // 「listFacts 是 camelCase，listProfiles/listZoneNotes 是原始列名」这个不一致，
  // 它曾经让面板整块显示空白（不会抛，只是字段全 undefined）。
  'test-memory-db-view.mjs',
  // 重要事实（2026-11-13 主人加的）：生日/忌口/联系方式按人对号存，不按话题分类。
  // 这条钉住四件最容易写坏的事：① 第三人称的生日不能记到说话人头上；
  // ② 同人同 kind 同 label 只留一条且权重只升不降；③ private/secret 不许进别人的上下文
  // （主人跨人问也一样，否则「A 的生日」会被念给 B 听）；④ 改一条撞键必须报 duplicate 不许静默覆盖。
  'test-memory-facts.mjs',
  // 引擎退役（2026-11-22）：桥接与插件必须读同一份 config.json（以前插件读 $DSH_HOME 旧壳，
  // engine=db 只生效一半：B站 每轮注入旧卡、向量记忆照跑、embedding 照打云端，PITFALLS #303）。
  // 钉住：共享选文件规则 + 两条定时器启动即挡 + 维护函数早退清产物 + keepalive 不再拉起 18765。
  'test-memory-retired.mjs',
  // 记忆分区（2026-11-27）：区/主体/主体页/零碎收件箱。钉住「区域是显示维度不是第二个库」：
  // 建话题就要落区与主体、零碎必须进 inbox、目录按区过滤、主体页无来源不许写、回填可 dry-run 且幂等。
  'test-memory-regions.mjs',
  // 做梦（2026-11-27）：每天读最近 3 天原文改标题、写主体页、路由零碎；模型坏整轮不写、
  // 不打 dreamed_at，review 因此跳过 prune（原文是梦的唯一来源，先删就再也补不回来）。
  'test-memory-dream.mjs',
  // 控制台记忆工作区（2026-11-27 重组）：概览必须带 regions/pages，按区过滤不能串。
  // 以前面板只读统计，看不见记忆区/主体页；前端重做后这两个字段就是契约。
  'test-panel-memory.mjs',
  'test-voice-style.mjs',
  'test-voice-style-bili.mjs',
  'test-group-link-guard.mjs',
  'test-qq-card.mjs',
  // 等 2 秒 + 盯「正在输入」（2026-11-25）：只认私聊 input_status，窗口滑动但不越硬上限
  // （普通 15 秒 / 打字中 60 秒），日志 7 天滚动且只写枚举。群聊与点名保持固定窗口。
  'test-typing-watch.mjs',
  // 文档锚点门禁（2026-11-25）：行号锚点会随 bridge.js 变长而整体漂移（实测只有 17% 仍准确），
  // 所以锚点改成「文件 + 符号名」；这个自测同时钉住门禁本身（干净通过/strict 拦行号/越界拦/白名单豁免）。
  'test-doc-anchors.mjs',
  // 文档读取上限（2026-11-26 主人要）：PPT/PPTX 等演示文稿 256MB，其它文档 60MB。
  // 钉住：61MB pptx 能读、61MB docx 仍拦、257MB pptx 打开前就拒、MCP 两条下载都带分档上限。
  'test-doc-limits.mjs',
  // 绘图 MCP（2026-11-26 主人要）：函数图 / 参数与极坐标 / 4 层思维导图。
  // 钉住：默认 512、三角函数 [-2π,2π]、渐近线断开、切线/积分、等比曲线、节点/层级上限、
  // 非主人 20 张/天与 10 张/10 分钟、stdio 端到端真渲染、坏输入给 code+hint。
  'test-diagram-function.mjs', 'test-diagram-curve.mjs', 'test-diagram-mindmap.mjs',
  'test-diagram-budget.mjs', 'test-mcp-diagram.mjs',
  // 2026-11-27：PDF 按章读 / 插图裁切 / 深度读额度（只读测试，不依赖真实 PDF）。
  'test-pdf-parse.mjs', 'test-pdf-budget.mjs', 'test-pdf-guard.mjs', 'test-mcp-pdf.mjs',
  // 找图准确性（2026-11-27 主人要）：Bing 多词中文不可用 → 中文走百度；结构式走 PubChem；
  // 药品包装用 Windows OCR 双命中才算 [已核对]；钉住解析/元数据/排序/别名/CID/缓存/校验/schema。
  // 预加载两阶段（2026-11-27）：30–100 条候选 → 下载 20–30 → 联系表 → pick 1–5 张才占每天 30 张。
  'test-webimg-parse.mjs', 'test-webimg-meta.mjs', 'test-webimg-rank.mjs',
  'test-webimg-chem.mjs', 'test-webimg-verify.mjs', 'test-webimg-preload.mjs', 'test-mcp-web-image.mjs',
  // 素材包（2026-11-25 主人要）：日报与说说共用的记忆 / 小镇 / 配图聚合。
  // 钉住：图片来源判定、封面 6 : 相册 4 的加权、关键词命中 ×4、最近用过的图排除、
  // 兜底图每周 1 次（按 qzone-log 的 imageSources 统计）、说说不给「她记得的事」且条数收窄。
  'test-material-kit.mjs',
  // 参考引擎（方案 B）：参考角色名必须清洗（名字进提示词=模型扮演 TA）、PART1 角色档案不入库、
  // >800 字不索引、只挑命中情境的 2 片且总字符 ≤900、同一情境连续第 3 次跳过。
  // 待办「提醒谁」（2026-11-13）：targetKey/targetName 必须优先于会话 key 与 requester，
  // 否则控制台替主人加的「提醒小土豆」会发到主人私聊；面板的合法 key 白名单也不许被绕过。
  'test-todo-target.mjs',
  // 命名隧道（固定域名）：token 走单独文件并加固 ACL、不落面板展示文件；缺 token 时
  // startTunnel 必须回 ok:false（以前回 ok:true 但根本没通道）。
  'test-tunnel-named.mjs',
  // Tailscale 的 100.64/10 必须按内网算（否则手机走 tailnet 只能只读）；
  // 边界 100.63 / 100.128 不能误判成内网，带 Cloudflare 头的一律 public。
  'test-tailnet-scope.mjs',
  'test-panel-link.mjs',
  // 公网 IPv6 白名单（2026-11-13）：面板监听 :: 之后，公网来源默认必须只读；
  // 只有登记过的前缀才可写，防爆破还要按 /64 归并（否则换地址就绕过阶梯锁）。
  'test-panel-remote-allow.mjs',
  'test-panel-local-auth.mjs',
  // 公网来源也能重启 DSH（2026-11-25）：只开 restart-dsh 一个动作，60 秒冷却，
  // 其余写动作仍必须被 requireWrite 拒。也钉住「没记录过」不等于「epoch 0 点过」。
  'test-panel-remote-restart.mjs',
  // 夜间电源开关（2026-11-27）：默认 23:50 睡眠 / 06:05 唤醒，测试走 STELLAR_POWER_DRY=1
  // 不碰真实计划任务；面板三个路由都必须先过 requireWrite，休眠没启用时明确拒绝。
  'test-panel-power.mjs',
  'test-style-refs.mjs',
  // 记忆查询三工具（catalog / topic / search）：身份闸（无令牌+外来会话必须拒）、
  // ownerId 白名单、search 至少 2 字，以及「真的读得到库里的话题与双方原话」。
  // 只测拒绝的话，工具全返回固定字符串也能过。
  'test-memory-tools.mjs',
  'test-audit-setup.mjs',
  'test-audit-setup-guards.mjs',
  // QQ scoped 工具：晚注册的全局危险工具也要补装 Schema 限制。
  'test-qq-tool-restrict-events.mjs',
  // DSH Desktop 安装目录里的 node 解析；bridge/scheduler/setup 共用同一个入口。
  'test-node-path.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  // DSH 端口漂移兜底：401/200+SERVER 才算 DSH、别的 Web 服务不算、回环之外不覆盖。
  'test-dsh-port.mjs',
  // 老/内嵌宿主只给 /api/events 快照：remote.mux 404 才降级，正常用户仍走推送。
  'test-events-fallback.mjs',
  // 鱼群保护：QQ 的鱼名/密度/连续刷屏判定 + B站的鱼楼层/聚拢/点赞纯逻辑（不发真请求）。
  'test-fish-guard.mjs',
  // QQ 鱼群触发记录：social-v2 的 fishGuardLog/当前冷却/lastFishGuard → 设置页表格。
  'test-qq-fish-guard.mjs',
  // 人的黑名单（deny.users）：无论在哪个群/私聊都不响应；拦截点必须早于入库与唤醒，
  // 且旧控制台保存白名单时不得清空它（2026-10-23 用户要求）。
  'test-blacklist.mjs',
  // 跨平台自我识别 + 来源判断：转发聊天记录不能被说成 B站 内容；B站 侧要认得出
  // 自己的 QQ 资料卡（QQ 号打码）；桥接落的 self-identity.json 能被插件读到。
  'test-self-identity.mjs',
  // 早安问候：08:00 重启丢枪的补发/重试逻辑 + reserved2 必须真调发送工具的提示词。
  'test-greeting.mjs',
  // 孤立代理项：截断劈开 emoji → 提示词进模型 API 就 400（桌宠对话一直 400 的根因）。
  'test-safe-text.mjs',
  // 出站 outbox：连接失败入队、上线补发、去重、策略失败不反复重试。
  'test-outbox.mjs',
  // 出站身份闸：B站 评论/私信/动态/分享发送前拦主人/别人的账号标识（只许自己互认）。
  'test-identity-guard.mjs',
  // 观看历史：追加/去重/轮转/旧记忆回填/评分合并，以及 debrief·watch·角色迁移的接线契约。
  'test-watch-history.mjs',
  // 观看历史的「操作」：评论分类（主评论/鱼群聚拢/回复/搭话）、收藏、动态、挂到哪次观看。
  'test-watch-actions.mjs',
  // B站 选题器：偏好权重/配额/轮转搜索/去重（含观看历史）纯逻辑。
  'test-feed-core.mjs',
  // 「一键抓取偏好关键词」：抽词/停用词/标签直取/包含合并/已有偏好排除。
  'test-pref-scan.mjs',
  // B站 扫码登录：鱼号/主人号归属校验（不能互相覆盖、新用户可绑定）。
  'test-bili-qr-login.mjs',
  // B站 每日分享 → 自己的动态：和四类动态共用 daily-dynamic.json，至少隔 gapMin 分钟。
  'test-share-dynamic.mjs',
  // 生物钟 C：每窗至少 1、全天 ≤12、相邻最小间隔、skip 不结束全天、错过不补。
  'test-night-schedule.mjs',
  // Token 防爆破：每天唤醒上限、私聊更紧、最小间隔、单次发送条数、近 24h 花费。
  'test-token-guard.mjs',
  'test-token-savers.mjs',
  // 每日 token 额度：单位解析（¥8 / 8M / 2万）、双单位比例、80% 每天只提醒一次、
  // 额度文件损坏回落默认、当天/跨天文件语义（纯逻辑 + 插件 session/event 采集）。
  'test-token-budget.mjs', 'test-token-budget-bridge.mjs',
  // 好友爱看（刷 QQ 空间公开流）：自己的会话（feed-whale-*）+ 自己的记账类别 + 每日总量硬闸
  // （2026-11-20 主人发现它没单独记账、一天看了上限的 4 倍）。
  'test-feed-whale.mjs',
  // 鱼缸小镇（2026-11-21）：只读采集 + 3 天记忆 + 影子会话（town-act 预设）+ 只读工具面。
  // 分四层钉：纯逻辑（TTL/去重/renderRecall）、HTTP 边界（域名/重定向/体积）、独立库、
  // 采集器退避，以及调度器与 MCP 的静态契约（守卫顺序、零动作、无访问码不醒）。
  'test-town-memory-pure.mjs', 'test-town-client.mjs', 'test-town-store.mjs',
  'test-town-collector.mjs', 'test-town-scheduler.mjs', 'test-town-tools.mjs', 'test-town-turns.mjs',
  'test-idle-mode.mjs',
  // 自主参与（2026-11-21）：动作三道闸（日上限/冷却/预算）+ 只读快照（面板那一页的数据源）。
  'test-town-actions.mjs', 'test-town-snapshot.mjs',
  // 超支熔断（P2 watchdog，2026-11-21）：/spending 超线停插件那条鱼 + 面板横幅。
  'test-town-guard.mjs',
  // 官方插件（dsh-fishbowl-town）在场时让位：检测/人设派生/设置文件读改写（2026-11-21）。
  'test-town-plugin.mjs',
  'test-town-decoupling.mjs',
  // 相册镜像（2026-11-22）：id 白名单 / 魔数 / 不带头抓图 / 8MB 走缩略图 / 60 张与 120MB 双淘汰。
  'test-town-album.mjs',
  // 小镇近况一行（2026-11-22）：从 recall 抠今天那两句、24 小时过期不提、坏快照不炸。
  'test-town-prompt-digest.mjs',
  // 小镇近况同步回插件（2026-11-22）：只认主人私聊、同一会话不重复打、换会话加新摘旧、失败静默退避。
  'test-town-chat-sync.mjs',
  // 无令牌发送兜底（2026-11-22）：三条同时成立才放行 + MCP 不再把 token 当必填（接线级断言）。
  'test-tokenless-guard.mjs',
  // 上线补历史消息（socialV2.history）：默认开、水位/去重/黑名单、桥接启动补看离线消息、
  // history 唤醒提示与快照标记（VM 夹具网关，不连真 QQ）。
  'test-history-catchup.mjs',
  // 目的机制（主动找主人）：从近期 QQ+B站 记忆提炼目的、安静时段/每日上限/重试/去重，
  // 以及真实 bridge.js 里的预览/投递/发送回执/回合回执接线（VM 夹具，不连真 QQ）。
  'test-purpose-engine.mjs', 'test-purpose-wiring.mjs',
  // 对话收尾判断：自己/对方继续意愿、话题闭环、未答提问先答、收尾≠潜水、
  // 冷却只压普通概率唤醒；以及真实 bridge.js 的 close 接口/提示词/重开接线
  // （VM 夹具，不连真 QQ）。
  'test-conversation-closure.mjs', 'test-closure-wiring.mjs',
  // 平台启动开关：QQ/B站 各自「是否启动」的唯一真相 + 旧 bridge.autoStart 迁移
  // （2026-10-24 用户要求；只碰临时 DSH_HOME，不启停真实桥接）。
  'test-platform-start.mjs',
  // B站 会话权限：workspace-write 在 C:\Users\Mieksido 起不了命令 → 自动切 danger-full-access。
  'test-scheduler-permission.mjs',
  // B站生物钟会话归组：新会话 workspaceId，旧版无工作区服务才退回专用 cwd。
  'test-bili-workspace.mjs',
  // B站评论/@监听的 TDZ 回归：程序错误不能被 catch 吞成网络错误。
  'test-bili-listen-error.mjs',
  // B站收件箱坐标：@ 一级评论补 root=source；resolveLatestReply 按 source rpid 找。
  'test-bili-reply-coordinates.mjs',
  // B站登录态守门：cookie 过期了别让生物钟继续空转（2026-11-20）。
  'test-bili-login-watch.mjs',
  // 字幕「目录 + 命中窗口」：看视频不再把整篇字幕读进上下文（2026-11-21，A+D）。
  'test-subs-digest.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  // 表情清单/消息快照改存独立文件 + 话题新鲜度（2026-11-16 主人要求）。
  'test-prompt-files.mjs',
  'test-reply-wait.mjs', 'test-reply-and-finish-send.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // QQ 发送字段名（2026-11-22）：qq_reply_and_finish 单条路径发了 message（单数），桥接只读
  // messages ⇒ 50 次「key 和 messages 不能为空」，模型只能拆两步发。上面那条钉子把两种工具、
  // 三种入参形状锁死在同一个 messages 字段上（真数组 77 成功 / 数组字符串 14 成功是反证）。
  // 管理员身份（QQ ⇄ B站 同一个人）+「对管理员温柔 / 绝不回嘴」提示词：
  // 号码规范化、旧字段推导、保存冲突、QQ/B站 两份提示词（B站 不得带 QQ 号）；
  // 以及真实 bridge.js 源码里的接线（唤醒 / 角色提示 / 消息标记）。
  'test-admin-identity.mjs', 'test-admin-prompt-wiring.mjs',
  // 管理员温柔模式：默认关闭 / 开启风险弹窗 / 关闭时上下文取舍 / 丢弃上下文重置。
  'test-admin-gentle-ux.mjs',
  // 通知通道：桌面 toast 转义 / 捕获 stderr；QQ 推送只走控制台专用端点。
  'test-notify-channels.mjs',
  // 黑话学习：waiter 先注册、缺 turn/start 兼容、超时不再误判会话。
  'test-learner-turn-wait.mjs',
  // 四类动态：空前缀不加；旧默认前缀不复活；DSH_HOME/STELLAR_BILI_CONFIG 同源。
  'test-bili-prefix-config.mjs',
  // wait 积压：立即返回、有界批量、群聊不整段倒给模型。
  'test-v2-wait-batch.mjs',
  // 备份轮转：真实带扩展名/横线时间戳文件名必须正确分组，keep 必须生效。
  'test-backup-prune.mjs',
  // 媒体兜底：p.qpic/gxh 候选、失败标签兜底、非多模态文字路径。
  'test-media-fallback.mjs',
  // 人格层读取：tone 必须读 persona.tone.md，不能回落核心。
  'test-persona-layer-read.mjs',
  // B站 shots 缓存：超期/超量清理，不碰新文件/未知文件。
  'test-shots-cache.mjs',
  // 作息时间窗：跨午夜、全角冒号、非法时间；listenTick 不再同名 L。
  'test-time-window.mjs',
  // QQ @：@我 + @别人不能一票否决；self_id 缺失回退 selfUserId。
  'test-qq-at.mjs',
  // 模型设置：客户端 → 宿主代理 → 桥接；保存不是已应用，selectModel 回执才是。
  'test-model-settings.mjs',
  // QQ 工作区跟随 DSH 默认模型 + 不认 reasoningEffort 的模型回退。
  'test-dsh-model-follow.mjs',
  // 跟随开关的宿主代理路由（2026-11-03：前端有、宿主漏注册 → 404）。
  'test-dsh-follow-route.mjs',
  // 设置页连续保存：成功必须回传/同步 stamps，warning 不能当 error。
  'test-config-save-stamps.mjs',
  // B站沉默逛 + 评论年龄闸：工具硬拦、带 code/hint。
  'test-bili-interact.mjs',
  // 记忆卡：重要度评分 / 主人锚点 / 每日模糊与遗忘 / 80·90·100% 容量 / 提示词裁剪 / 隐私 scope。
  'test-memory-card.mjs', 'test-memory-card-wiring.mjs', 'test-memory-sharing.mjs',
  // 向量记忆：独立存储/索引/检索/敏感过滤/客户端错误；memory.mode 只影响读取。
  'test-vector-memory.mjs', 'test-vector-memory-wiring.mjs', 'test-vector-memory-plugin.mjs',
  'test-vector-memory-bridge.mjs',
  // Embedding 可选安装包：manifest/校验/安装/卸载、插件 API、Node runtime、安装清单隔离。
  'test-embedding-packs.mjs', 'test-embedding-packs-plugin.mjs', 'test-embedding-runtime.mjs',
  'test-embedding-packs-wiring.mjs',
  // 角色人格：多角色目录隔离 / 切换 epoch / 快照回档 / 旧数据迁移（含凭证不进角色包）。
  'test-character-store.mjs',
  // B站 工具链路径：有角色时行为账本进角色包，cookie/表情包仍在账号目录。
  'test-bili-state-paths.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // 表情语义层：编号分配、情绪识别、本地注意力编码、语境匹配、注入文本；
  // 以及表情库/工具面接线（编号可当 stickerId、收藏时带 emotion/content）。
  'test-sticker-semantics.mjs', 'test-forward-files.mjs',
  'test-stickers.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // web_search 凭据：DSH 0.2 records、账号凭据 endpoint 钉死官方域名。
  'test-web-search-credentials.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  // 本地 TTS 客户端（落盘复用 / 502 detail / 服务未启动 / wav 头算时长）
  // 真实 bridge.js 的 text→TTS→record 链路（假网关 + 本地假 TTS，不发 QQ）
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 体检 SnowLuma 必须读 bridge.snowluma（运行态），不能拿 config.snowluma 冒充。
  'test-doctor-snow-state.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 Stellar_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // schemastery 3.18.3+ volatile 包装：settings/测试边界必须拆成纯值。
  'test-schema-volatile.mjs',
  // SnowLuma 上游健康（被误诊成「Stellar 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // B站分享卡片（PITFALLS #22）：B站小程序在 QQ 侧下架，默认必须是
  // com.tencent.structmsg 链接卡；旧 card:true 不能继续发下架的小程序卡。
  'test-bili-card-ark.mjs',
  // preset 装配防漂移（2026-10-26 审计补登）：bundle patch（plugins/stellar/presets/*.patch.yml）
  // 必须与权威源 dsh/agent-presets/<preset>/ 逐字一致，且守卫行只用「profile 可解析」的裸说明符。
  // ⚠️ 这条以前**不在任何门禁里**（也没有 npm script），结果 qq-chat-v2.patch.yml 悄悄落后于源：
  // 工作树里的源已经有「对话收尾」段，装进 DSH 的那份没有。教训见 PITFALLS #71。
  'test-agent-preset-patches.mjs',
  // 插件 → 核心模块的引用一致性（PITFALLS #68）：`?rev=` 必须三处一致、不许裸引用，
  // 并把"改了热重载也不生效"的核心模块清单打出来（2026-10-26 新增）。
  'test-core-rev-sync.mjs',
  // 隐私扫描的判据本身（2026-10-26）：编译出的正则必须带 g —— 否则每条规则每个文件
  // 只看到第一个命中（fail-open），还会空转成"扫描不完整"。PITFALLS #74。
  'test-privacy-scan.mjs',
  // 群刷屏短指令：#sl 等非主人纯指令不唤醒；中文话题标签不误伤。
  'test-command-spam.mjs',
  // 语音包默认安装源（2026-10-26）：必须从仓库位置解析、不许硬编码盘符，
  // 且 8765/8767 两个端口与启停脚本名不能漂移（语音路由全靠它们）。
  // 离线语音包导入：校验/复制/配置保留/pyvenv 改写/回滚边界（临时夹具，不碰真实包）。
  // 云端语音包凭据边界（2026-10-29）：新装必须清空预置的火山 AppID/AccessKey，
  // 重装保留用户自己填的；没配好时 start() 要拒绝并指路（PITFALLS #79）。
  // 主人提问回答编码（2026-10-29）：DSH 单选不允许 selected+custom 并存 →
  // 单选走 custom-only、多选保留 selected；[仅主人] 只收窄谁能答，不是授权凭证。
  'test-question-answers.mjs',
  // 主人特权操作审计（2026-10-29）：1MB×5 轮转、跨文件读尾、写入失败可见、90 天清理。
  'test-owner-audit.mjs',
  // 检查更新三态（2026-10-29 事故）：无 git / 无安装记录时按版本号判断；
  // 取不到远端版本号必须是 unknown，不能显示"最新"。
  // 语音三闸门 + 配置双写（2026-10-29 复盘）：工具常注册、拒绝带 code/hint、保存带戳防覆盖。
  // 安装清单只能含 git 跟踪文件（2026-10-30：脏清单导致 zip 更新 100% 失败）。
  // 语音失败分类/换路/自检接线（2026-10-30 P0+P1）。
  // 白名单归一化 + 启动补唤醒（2026-10-31 主人私信被忽略 / 积压不唤醒）。
  // 称呼按人归属（2026-10-31 主人被叫成对象的称呼）。
  'test-callname.mjs',
  'test-allowlist.mjs',
  // DSH 升级后 profile MCP / 会话 preset 审计（2026-11-01 升级后没有 qq_* 工具）。
  'test-dsh-health.mjs',
  // 验收报告 A–D：结构化 403 / 密钥打码 / 目的历史 / 超时 code。
  'test-acceptance-abcd.mjs',
  // dev 通道 / Pre-release 发布链路（2026-11-01）。
  'test-dev-publish.mjs',
  // 主题/对比度约束（深色、浅色都不能低对比）。
  'test-theme-tokens.mjs',
  'test-release-manifest.mjs',
  'test-release-manifest-verify.mjs',
  'test-update-apply-result.mjs',
  'test-update-version-fallback.mjs',
  // 版本号单一真相：根/插件 package.json 一致、无硬编码、CHANGELOG 有当前版本。
  'test-version.mjs',
  // 插件冲突体检：已知第三方工具是否被 QQ 策略拒绝、压缩接管冲突、未知插件必须标 unknown。
  'test-plugin-compat.mjs',
  // 管理员输入框：border-box + max-width，避免 width:100% 加 padding 后超框。
  'test-admin-input-css.mjs',
  // 闸门事件中心 + 单轮止血：L0-L3 分级、去重/确认、步数/重复错误/预算熔断。
  'test-gate-events.mjs',
  // SnowLuma 断线/发送失败暂停：主动唤醒不得创建 DSH 会话（零 token）。
  'test-snowluma-channel-gate.mjs',
  // 一键启动/停止接线：QQ/B站/桌宠/语音多选、语音本地/云端分支、结构化失败。
  'test-launch-components.mjs',
  // 人格卡分层：核心/场景/日常、QQ群聊/私聊、预算裁剪、v1/v2 小节过滤。
  'test-persona-layers.mjs',
  // Phase 0A：遥测只读、模型调用去重、工具结果大小、报告聚合。
  'test-context-telemetry.mjs',
  // Phase 1A：按 wakeId 归属、bridge/plugin 去重、路径/交付/成本聚合。
  'test-context-call-chain.mjs',
  // Phase 3：启动补唤醒限量（默认 3，可配置 1~20）。
  'test-backlog-cap.mjs',
  // 唤醒硬直接：question 不再绕过每日配额。
  // 群聊续聊/插话的纯逻辑（2026-11-15）：群里没人 @ 她时，不能只靠 5% 冷概率接话。
  // 钉住「冷场不续聊、大群不插话、probability=0 等于别主动接话」这三条，否则调参数很容易把她变成刷屏机。
  'test-wake-followup.mjs',
  'test-wake-policy.mjs',
  // 群分层：小群积极、大群严格、手动覆盖、设置页。
  'test-group-policy.mjs',
  // 上下文快照：合并读取 + brief/caps/refs + tool profile。
  'test-context-snapshot.mjs',
  // 会话滚动 + 合并窗口：换会话阈值、交接块、分场景窗口、接线钉子。
  'test-session-rollover.mjs',
  // 会话映射：重复 sessionId 必须全部重建，防止上下文串成一条。
  'test-session-map.mjs',
  // 记忆卡手动操作：toast 不能阻断 reload，不能引用 item。
  'test-memory-card-act.mjs',
  // 限制失败：结构化错误 + 概览 L1 报告 + 本限制提醒。
  'test-limit-report.mjs',
  // Action Planner 第一版：close 幂等；step guard 按 assistant step。
  'test-action-planner.mjs',
  // SnowLuma 未启动时不能弹断线告警。
  'test-snowluma-startup-warning.mjs',
  // 人格语气/智能拆分：只出草稿，用户编辑保存。
  'test-persona-classify.mjs',
  // A+B 账单：角色/会话 Markdown + 自动写入服务。
  'test-billing-report.mjs',
  'test-billing-service.mjs',
  // B站分享去重：新鲜池空时不得回退旧素材（2026-10-26 修复的"同一条反复发"）。
  'test-bili-share-dedup.mjs',
  // 唤醒人格卡注入：二代唤醒必须带人格卡正文，且与 qq_get_prompt 同源（2026-11-01 A1）。
  'test-persona-wake-injection.mjs',
  // B站省 token 第一批：status 一次给全（只读、不写账本）+ 命令表抽 lib / diary append / debrief 批量
  //（2026-11-23，甲案 P0：把"每趟十几次只读调用、写命令先 --help"这类往返压掉）。
  'test-bili-status.mjs',
  'test-bili-batch.mjs',
  'test-bili-wake-budget.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;