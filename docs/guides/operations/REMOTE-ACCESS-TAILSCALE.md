# 远程访问：Tailscale 内网通道（方案 A）

> 主人 2026-11-13 21:04 选了 **A**：用 Tailscale 组网，不走公网、不要域名。
> 这一篇是操作手册；代码侧的配合已经做完（见文末「已就绪」）。

## 为什么选它

- 设备之间直连（打不通才走 DERP 中继），**不经过公网**，不会被搜索引擎扫到。
- 地址是固定的 `100.x.y.z`，重启不变，不像 quick tunnel 每次都换域名。
- 不用买域名、不用配 Access 策略，登录同一账号即可。
- 代价：每台设备都要装客户端并登录一次。

## 电脑上装（这台跑面板的机器，装一次）

1. 打开 https://tailscale.com/download/windows 下载安装包，或用 winget：
   ```
   winget install --id Tailscale.Tailscale -e
   ```
2. 装完任务栏出现 Tailscale 图标，点 **Log in**，用 Google/Microsoft/GitHub 任一账号登录（这个账号就是你的「网络」）。
3. 记下这台机器的 tailnet 地址（Tailscale 面板或托盘里能看到，形如 `100.101.102.103`）。
4. 回到 Stellar 面板「设置 → 手机访问」，**刷新**：`tailnetUrls` 会出现 `http://100.x.y.z:3300/`，那段「怎么装」的说明会自动消失。

## 手机上用

1. App Store / Play 搜 **Tailscale** 装上。
2. 登录**同一个账号**（同一个网络才会互相看见）。
3. 打开面板那张卡上的 tailnet 地址 → 第一次要口令（就是 `stellar-manager/panel-token.txt` 里那串数字）。
4. 可以「添加到主屏幕」，用起来跟 App 一样。

## 安全边界（这套代码里已经生效的）

- **公网只读，唯一例外是「重启 DSH」**：`requestScope()` 见 `cf-ray` / `cf-connecting-ip` / `x-forwarded-for` / `https` 就判 `public` → `canWrite=false`；
  写动作里只有 `restart-dsh` 被 `lib/remote-restart.js` 单独放行（人不在家、DSH 卡死时它是唯一必须能做的事），
  且有 60 秒冷却 + 每次一行审计。其余写动作仍然 403 `readonly-public`。
- **tailnet 可写**：`100.64.0.0/10` 判 `lan`。依据是「能出现在这个网段里，说明设备已经在你的 Tailscale 账号里认证过」。
- **临时登录码**：`POST /api/login-code` 生成 5 分钟一次性码，链接里不放长期口令。
- **口令不出内网**：`/api/status` 对非回环请求把 token 打码（`前2位••••后2位`）；明文只在 `127.0.0.1` 上显示。
- **阶梯锁**：同一 IP 连续失败 5 次锁 60 秒 / 10 次 5 分钟 / 15 次 30 分钟。
- **改通道只能在本机**：`/api/action {action:"tunnel-named"|"tunnel-quick"}` 只接受 loopback，公网/tailnet 一律 403。

## 和 Cloudflare 隧道的关系

- 两条路可以并存：隧道给「临时在外面看一眼」（只读），Tailscale 给「长期稳定的入口」（可写）。
- 装了 Tailscale 之后建议**关掉 quick 隧道**，减少一个公网暴露面：面板「手机访问」里点「关闭远程访问」。
- 如果以后还是想要固定公网域名，再走命名隧道（面板已支持填 token/域名）。

## 排障

| 现象 | 先查什么 |
| --- | --- |
| 手机上打不开 100.x 地址 | 两端 `tailscale status` 是否都 online；手机是否在同一个 tailnet（不是同一个账号就是两个网络） |
| 打开是只读，按钮点不动 | 看是不是走了隧道域名（`trycloudflare.com`）；隧道永远只读，要用 100.x 地址 |
| `tailnetUrls` 一直是空 | 面板进程启动时网卡还没有 100.x 地址；装完 Tailscale 后重启面板（或用托盘确认 Tailscale 已连接） |
| 能打开但一直要口令 | 那是正常的：口令在 `stellar-manager/panel-token.txt`，或者在本机面板上点「复制带口令链接」 |

## 已就绪（代码侧，2026-11-13 21:2x）

- `stellar-manager/lib/auth.js`：`isPrivateIp()` 认 `100.64.0.0/10`；`tailnetAddresses()` 扫网卡挑这段。
- `stellar-manager/lib/status.js`：`access.tailnetUrls`。
- `stellar-manager/public/index.html` + `public/js/access.js`：`#tailnetBox` 显示地址、`#tailnetSetup` 显示「还没装」的步骤，装好后自动隐藏。
- `stellar/scripts/test-tailnet-scope.mjs`：4 条边界断言（三个端点算内网、100.63/100.128 不算、带 CF 头仍只读、地址只挑 CGNAT）。
---

## 她也能报地址：`stellar_panel_link`（2026-11-23）

主人在 QQ 里说一句「把控制台地址发我」，她自己就能把它报出来，不用主人跑到那台电脑上翻面板。

| 谁问 | 她能做什么 |
| --- | --- |
| 主人私聊（`private:<主人QQ>`） | 调 `stellar_panel_link`：列出现有地址，并**真开一次 TCP 连接**说是连得上还是连不上 |
| 主人私聊 + `link=true` | 额外给一条 **5 分钟、一次性**的登录链接（`?code=`，等价于一次登录） |
| 别人（群友 / 陌生人） | 调不动：工具第一步 `ownerOnlyError(key, token)` 直接拒 |

链路只有两跳，不新开端口：

```
她（stellar_panel_link） --POST /api/remote-link--> 面板（127.0.0.1:3300）
                                                    └─ lib/access-link.js：找地址 → 探活 → 可选发一次性码
```

**面板那道门外加三把锁**（`stellar-manager/server.mjs` 的 `POST /api/remote-link`）：

1. **只认本机来源**：`requestScope(req) !== 'local'` → 403 `local-only`。她与面板在同一台机器上，走回环；
   局域网、tailnet、公网来的请求全被拒 —— 这条路由**不是新的远程入口**。
2. **同源标记**：`crossSite(req)` 要求 `x-panel-request: panel`，网页里被诱导的跨站 POST 打不进来。
3. **码不落日志**：`appendAudit('remote-link', { withCode, ip })` 只记「这次带没带码」。

**没要码时返回体里没有任何凭据**（`login: null`）；要码时才 `issueLoginCode()`，明文只出现这一次，
磁盘只存 sha256，5 分钟后自己失效。她排版时会明写一句「只能发给主人本人，别发到群里」。

### 排障

| 现象 | 先查什么 |
| --- | --- |
| 她回「拿不到远控地址：…」 | 面板没跑 / 端口不是 3300：先看 `Get-NetTCPConnection -LocalPort 3300`，或用 `STELLAR_PANEL_PORT` 告诉她端口 |
| 她回「远控地址只能在本机上取」 | 有人用局域网地址打这条路由（或者她被换到了别的主机）——这是设计 |
| 链接点开说码无效 | 超过 5 分钟或已经用过一次；再调一次带 `link=true` |
| 只有「局域网 + 本机」两行 | 隧道没开（控制台「手机访问」里点一次「开启远程访问」）。另外没装/没连 Tailscale，面板跑默认 `HOST='0.0.0.0'`（只开 IPv4）；要 IPv6 那行就设 `STELLAR_PANEL_HOST='::'` 再重启面板 |
| 工具根本不出现 | 要**重启 DSH** 才会注册（`src/mcp-snowluma-safe.js` 的改动属进程内） |

### 手机流量也能打开的那一条：把隧道算进候选（2026-11-23 补）

入口表原来只扫网卡（tailnet / 局域网 / IPv6 / 本机），**手机上用流量时一条都打不开**——
主人在外面问「把控制台地址发我」，她只会报 `http://192.168.0.3:3300/` 这种出了门就废的地址。
现在面板把 `lib/tunnel.js` 的隧道状态一起算进候选，**排序第一**：

| 候选 | 从哪来 | 出了家门能用吗 |
| --- | --- | --- |
| `tunnel` 公网隧道 | `tunnelState().url`（cloudflared 快速/命名隧道） | ✅ 手机流量可以；走 Cloudflare，**只读** |
| `tailnet` | Tailscale 100.x | ✅ 装了且两端都登同一账号时 |
| `lan` | 内网网卡 | ❌ 只在同一 WiFi |
| `v6` | 公网 IPv6（要 `HOST='::'`） | 看运营商与对方网络 |
| `local` | 127.0.0.1 | ❌ 只有本机 |

- 隧道那条探测的是 **hostname:443**（不是面板端口 3300），因为它是 Cloudflare 边缘的 https 入口——
  探测端口按候选自己的协议选（`buildRemoteLink` 里 `it.https ? 443 : port`）。
- 隧道跟面板绑哪张网卡无关（cloudflared 自己连出去、回转到 `127.0.0.1:3300`），所以**不做** `binds()` 过滤：
  哪怕面板只听回环，隧道那条照样要报。
- 隧道没开 / 开着但没拿到地址 / 被 Cloudflare 回收，她那边分别说清「去控制台『手机访问』开一次」/
  「还在起，十几秒后再问」/「现在连不上，可能被回收了」——不沉默，也不报死链。
- 快速隧道（quick）地址会变，她排版时补一句「地址会变，要固定地址得配命名隧道」；
  要稳定的公网入口就在面板里填命名隧道 token。

**只读是硬闸**：走隧道进来一律 `requestScope() === 'public'`，`requireWrite()` 回 403 `readonly-public`
（能看、能点审批，改数据要回本机或同一 WiFi）。

### 本机实测（2026-11-23，隧道在跑）

| 请求 | 结果 |
| --- | --- |
| 回环 `POST /api/remote-link {"code":false}` | 200，`best: "tunnel"`；第一条是「公网隧道（手机流量）`https://….trycloudflare.com/`（连得上）」，后面才是局域网、本机；`login: null` |
| 同一端点 `{"code":true}` | 200 + `login.via = "tunnel"`、`ttlSec: 300`，链接落在隧道域名上 |
| 从**公网**打开那条带码链接 | **302 + Set-Cookie**（真能换会话） |
| 拿这个 Cookie 走隧道 `GET /api/status` | 200（能看） |
| 拿这个 Cookie 走隧道 `POST /api/action` | 403 `readonly-public`「公网隧道只能查看和审批」 |
| 从局域网地址访问 `/api/remote-link` | 403 `local-only`（来源被判 lan，正是设计） |
| 不带 `x-panel-request: panel` | 403（防跨站） |

---

## 备选且更省事的一条：公网 IPv6 直连（2026-11-13 已做）

Tailscale 要先装客户端、还要外区 Apple ID；这台机器本身就有一条公网 IPv6（移动宽带 RA 下发 `2409:8d30:d001:4194::/64`），
所以面板已经改成**双栈监听**（`HOST='::'`），手机不用装任何东西。

### 手机怎么开

1. 面板 →「手机访问」→ 复制 `http://[2409:....]:3300/` 这条（或看 `GET /api/status` 的 `access.v6Urls`）。
2. 手机用 4G/5G 直接访问（三大运营商移动网络都给 IPv6）；家里 WiFi 也行。
3. 第一次要输口令（`panel-token.txt` 那 8 位）。

### 安全模型（重要）

| 来源 | 能做什么 |
| --- | --- |
| 本机回环 `127.0.0.1` / `::1` | 全权限；**但要有会话**（启动时打印的「本机入口」带 `?code=`，打开一次即得 Cookie，30 天有效） |
| 局域网 `192.168.x.x` | 全权限（要口令） |
| **公网 IPv6** | **默认只读**：能看状态、点审批，改不了通讯录/记忆/配置 |
| 公网 IPv6 且命中白名单 | 全权限（要口令） |
| Cloudflare 隧道转发的请求 | 一律只读（不可信代理头） |

白名单：`state/panel-remote-allow.json`，也可以在面板「手机访问」卡里加/删。
**只能在跑面板的这台电脑上改**——远程端拿到口令也改不了自己的权限。

防爆破：按 IPv6 `/64` 归并计数（换地址不换桶），另外公网来源 10 分钟内 20 次失败会全局锁 10 分钟。

### 手机用流量能不能连？怎么自己判定

本机没法证明外部可达（自己连自己的全局地址走的是本机栈）。**唯一终验是手机用 4G/5G 打开一次**。

三步判定：

1. 手机浏览器先开 `https://test-ipv6.com/` —— 如果它显示「你没有 IPv6」，那这台手机当前网络就是 IPv4-only，
   直连必然失败，改用局域网或隧道，不用怀疑面板。
2. 打开 `http://[2409:8d30:d001:4194:25fa:3faf:baad:6e21]:3300/`。
   - 出现登录页 → 通路正常（拿到 cookie 后若能看状态就是成功）。
   - **一直转圈/超时** → 大概率是运营商或路由器拦了入站；先试另一个地址（`…69ca:a923:1133:ad2`）。
   - **立刻拒绝/连不上** → 多半是手机没有 IPv6。
3. 能开但只能看（改了没反应）→ 到电脑上把这台手机的网段加进白名单（面板「手机访问」卡里填 `/64`）。

两个地址的区别：`…25fa:3faf:baad:6e21` 是 Link 后缀（由网卡 MAC 派生，稳定）；
`…69ca:a923:1133:ad2` 是 Random 后缀（隐私地址，会过期轮换）。**优先用 Link 那个**。
两个的 `ValidLifetime` 都只有约 2 小时（路由器每小时续租），前缀本身由宽带下发，重拨会变。
### 已知限制

- **宽带重拨后前缀会变**：地址变了要重新复制一次；要固定就得配 DDNS（本机还没配）。
- **没有 HTTPS**：本机没有 openssl，公网路径上口令是明文；不要在公共 WiFi 里开。
- 公司/酒店 WiFi 常常没有 IPv6 → 那种网络下只能走局域网或临时隧道。
- 手机运营商若给你的是 IPv4-only（少见），直连也不通。
