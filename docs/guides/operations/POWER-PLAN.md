# 夜间电源（控制台开关）

> 2026-11-27 新增。主人原话：「晚上我不用她，让她关掉或者休眠，但这个开关要装在控制台」。
> 控制台「她 → 停 / 唤醒 / 传话」卡片下面多了「夜间电源」：到点让**整台电脑**睡眠，
> 早上按设定时间唤醒。它不是「停机器人」——强制休眠只停自动唤醒，主机、风扇、Wi-Fi 还在跑。

## 1. 两条计划任务，各管各的

| 任务名 | 默认时间 | 动作 | 设置 |
| --- | --- | --- | --- |
| `Stellar Night Sleep` | 23:50 | `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`（睡眠）或 `shutdown.exe /h`（休眠） | 允许电池启动、错过后补跑 |
| `Stellar Night Wake` | 06:05 | `cmd.exe /c exit` | 额外 `WakeToRun`，到点把机器从睡眠叫醒 |

这台机器上原本还有一条 `Stellar Morning Wake`（06:00、断电恢复用）。夜间电源**不覆盖、不删除**
它：启用时只建上面两条 `Night` 任务，关闭时也只删这两条。所以关掉开关不会把早上的保活唤醒一起弄丢。

## 2. 接口与状态

| 接口 | 作用 | 权限 |
| --- | --- | --- |
| `GET /api/power` | 返回 plan、能力（睡眠/休眠）、两条任务是否已注册、下次时间 | 本机/局域网/公网都可读 |
| `POST /api/power` | 保存并立即应用：先建唤醒再建睡眠；关闭时先删睡眠再删唤醒 | `requireWrite`：公网 403 |
| `POST /api/power/now` | 3 秒后立即睡眠/休眠（写一次性任务 `Stellar Power Now`） | `requireWrite`：公网 403 |

请求体：

```json
{ "enabled": true, "sleepAt": "23:50", "wakeAt": "06:05", "mode": "sleep" }
```

- `mode` 只认 `sleep` / `hibernate`；时间必须是 `HH:MM`，两项不能同一分钟。
- 状态文件：`~/.dsh/stellar/state/power-plan.json`，形状
  `{ version:1, enabled, sleepAt, wakeAt, mode, updatedAt, updatedBy }`。
- 写入走 `atomicWriteJson`（临时文件 + fsync + rename），面板日志 `audit.jsonl`
  记 `power-plan` / `power-plan-rejected` / `power-now` / `power-now-rejected`。

## 3. 顺序为什么是硬规定

- **启用**：先建唤醒任务，再建睡眠任务。反过来一旦唤醒建失败，机器会进入
  「今晚会睡、明早不会醒」的状态。
- **关闭**：先删睡眠任务，删失败直接报错，计划文件保持原样；绝不能出现
  「面板显示已关闭，晚上照旧睡」。
- **休眠**：先查 `HKLM\SYSTEM\CurrentControlSet\Control\Power` 的 `HibernateEnabled`；
  本机是 `0`，所以下拉框里的「休眠」是灰的，强行选会被拒绝并提示
  `powercfg /hibernate on`（需要管理员）。面板不会偷偷改注册表。
- **立即睡**：面板先回包，再由一次性任务在 3 秒后执行——如果面板进程自己先睡下去，
  HTTP 响应就发不出来了。

## 4. 怎么用

1. 打开控制台 →「她」→「停 / 唤醒 / 传话」→「夜间电源」。
2. 勾上开关，填睡眠/唤醒时间，选睡眠或休眠，点「保存电源计划」。
3. 状态行会显示「已启用 · 每天 23:50 睡眠 → 06:05 唤醒」和两条任务是否注册。
4. 「现在睡眠」会二次确认，3 秒后整机睡眠，远程连接立刻断。

公网隧道打开时这块是只读的（按钮禁用、提示「公网只读」）；要改计划必须在本机或同一 WiFi。

## 5. 断电 / 电池的现实

- 睡眠不是关机：内存仍供电，电池会持续掉电。40Wh 电池、16–17W 放电大约 2.5 小时，
  关屏 + 限 CPU 后也更长不了多少；0 点到 6 点能否撑住取决于电池健康和当晚负载。
- 路由器如果也断电，Wi-Fi 会断，人在外面就连不上；笔记本电池救不了路由器。
- 06:05 的唤醒依赖 RTC 唤醒（`powercfg` 的 `RTCWAKE` 已开）和电池还有电；
  断电期间机器可能已经因电池耗尽而关机，醒来后仍需登录才能让 keepalive 拉起 DSH。
- 不要合盖：合盖动作在隐藏电源设置里，当前没改；合盖很可能直接睡眠或关机。
- 休眠比睡眠更省电，但本机没启用；启用后唤醒恢复会慢一些。

## 6. 验证

```bash
# 单测：默认值、坏输入、任务顺序、路由权限、前端接线；不碰真实任务
node scripts/test-panel-power.mjs

# 真机看两条任务（启用后）
schtasks /query /tn "Stellar Night Sleep" /fo LIST /v
schtasks /query /tn "Stellar Night Wake" /xml | grep -E "StartBoundary|WakeToRun"

# 面板接口（先登录拿 Cookie）
curl.exe -s -b cookie.txt http://127.0.0.1:3300/api/power
```

测试模式 `STELLAR_POWER_DRY=1` 只写计划文件，不查注册表、不建任务、不睡眠。

## 7. 失败模式

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 保存报「注册计划任务失败」 | `schtasks` 权限/任务名冲突 | 看返回的原始 stderr；删掉同名任务重试 |
| 保存报「休眠没启用」 | `HibernateEnabled=0` | 改用睡眠，或管理员 `powercfg /hibernate on` |
| 关闭报「删除睡眠计划任务失败」 | 任务被占用/权限不足 | 计划文件不会写成 disabled；手动 `schtasks /delete` 后重试 |
| 到点没睡 | 任务未注册、机器已睡眠、或电源策略阻止 | 看「任务：睡眠已注册/未注册」；`schtasks /query /tn ...` |
| 早上没醒 | 电池耗尽、RTC 唤醒被关、或任务没 `WakeToRun` | 查 XML 的 `WakeToRun`；确认还有电 |
| 公网按钮全灰 | 公网来源只读 | 本机或同一 WiFi 打开面板 |

## 8. 文件

- `stellar-manager/lib/power-plan.js`：计划读写、任务建删、能力检查、立即睡眠。
- `stellar-manager/server.mjs`：三个路由、审计、日志。
- `stellar-manager/public/index.html`、`public/js/power.js`、`public/style.css`、`public/js/boot.js`：卡片与轮询。
- `stellar/scripts/test-panel-power.mjs`：7 组断言。
- 运行时：`~/.dsh/stellar/state/power-plan.json`、`state/power-now.cmd`。

## 9. 已知边界

- 只支持 Windows 计划任务；睡眠/休眠的具体行为由本机电源策略决定。
- 任务是当前用户身份、交互式运行：注销/切换用户后可能不执行；要更可靠需改成 SYSTEM 任务（要管理员）。
- 没有做「关机」：Windows 计划任务能从睡眠/休眠唤醒，但**不能从关机（S5）唤醒**；关机后早上不会自己开机，除非主板 RTC 闹钟/WOL。
- 面板只负责「到点睡、到点醒」，不判断她是否正在跑任务；要她先收工再睡，需要另外的协调。
- 没有「远程改计划」：公网始终只读；这是现有安全边界，不为了一个开关破例。
- 计划任务由面板进程创建；面板被卸载后任务仍在，需要手动 `schtasks /delete`。
