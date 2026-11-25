# 唤醒合并窗口与「正在输入」（WAKE-BATCH）

> 代码：`src/wake-batch.js`（窗口基准值，纯逻辑零 I/O）、`src/typing-watch.js`（打字观测与顺延，纯逻辑）。
> 桥接侧的挂点：`rearmPendingWakeV2()` / `sendWakePromptV2()`；控制台汇总走 `typingSummaryV2()`。
> 本文只讲「什么时候醒」；醒了之后说什么，见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 3 节。

## 1 为什么要合并

唤醒一次 = 重发一整轮上下文，贵的是上下文不是那条消息。对方连发三条「在吗 / 你看这个 / 哈哈哈哈」，
如果每条都醒一次，就是三份完整上下文的钱。所以：**触发唤醒后先等几秒，把这期间的消息收进同一个唤醒包，只醒一次。**

## 2 三个窗口（基准值）

| 场景 | 基准等待 | 配置键 | 为什么 |
| --- | --- | --- | --- |
| 被点名（@ / 叫名字 / 拍一拍 / 管理员） | 3 秒 | `wake.batchWindowDirectMs` | 被点名要立刻应；哪怕在大群里也走最短窗口 |
| 私聊 | 2 秒 | `wake.batchWindowPrivateMs` | 私聊节奏快，8 秒会显得迟钝（2026-11-25 主人定 2 秒） |
| 群聊普通触发 | 6 秒 | `wake.batchWindowMs` | 群里本来就不该秒回，多等一会儿能多合并几条 |

- 判定顺序是固定的：先看是不是「被点名」（`isDirectReason()`），再看是不是私聊 key（`isPrivateKey()`），最后才落到群聊。
  私聊的 reason 恒为 `private`，不会被误判成 direct。
- 三个值都夹在 **1 秒 ~ 1 小时**：比 1 秒短等于没有窗口，比 1 小时长等于永远不醒。坏值回落默认，不抛错。
- `wake.batchWindowMs` 是老字段（一直是群聊窗口），保留兼容；没写新字段时它就是群聊窗口。

## 3 滑动窗口：又来一条就顺延

窗口不是固定的「等 2 秒」，而是**滑动**的（`pendingWakeFirstAt` 记第一条的到达时刻）：

1. 第一条到 → 排一个 2 秒后的唤醒；
2. 2 秒内又来一条 → 取消定时器，重新排（顺延 `typing.extendMs`，默认 2 秒）；
3. 顺延有硬上限：普通连发封顶 `maxWindowMs`（默认 15 秒），
   对方一直在打字则封顶 `maxTypingMs`（默认 60 秒）。到顶就按原计划醒，不再等。

为什么必须有上限：对方把输入框打开去吃饭，无上限顺延会让她**永远不回**。
这条在打字窗口设计时就被明确否掉了，不是疏漏。

## 4 「正在输入」怎么用

SnowLuma 会把 QQ 的输入状态翻成 OneBot 通知：`post_type=notice`、`notice_type=notify`、`sub_type=input_status`，
`event_type` 取值 **0=停手 / 1=打字 / 3=说话**（3 在 QQ 里显示「对方正在讲话」）。

- **只认私聊**：群聊没有这个推送，就算有也说不清是谁在打，`typingEventOf()` 对带 `group_id` 的通知一律返回 null。
- **只加速唤醒，不产生唤醒**：打字事件不进未读、不升级唤醒原因、不额外计费；
  它的作用只有两个 —— 窗口到期时「对方还在打字」就再等一会儿；对方停手则立刻按当前计划醒。
- 每来一个事件就 `rearmPendingWakeV2()` 重排定时器；等待原因会记进 `pendingWakeReason`（如「对方在打字」），
  控制台 `/api/social-v2` 的 `typing` 字段能看到「现在有没有人在打字」。

## 5 观测日志

- 落盘 `state/typing-log.jsonl`，一行一个事件：**只记 QQ 号、时间、状态**，不记正文、不记 token。
- 保留 `typing.logKeepDays`（默认 7 天，夹 1~30），每次启动与每 6 小时整理一次（`pruneTypingLog()`）。
- `typing.logEnabled=false` 可整体关掉；`typing.enabled=false` 才是关掉「顺延」本身（窗口退回固定值）。

## 6 配置全貌

```json
{
  "wake": {
    "batchWindowMs": 6000,
    "batchWindowPrivateMs": 2000,
    "batchWindowDirectMs": 3000
  },
  "typing": {
    "enabled": true,
    "logEnabled": true,
    "logKeepDays": 7,
    "extendMs": 2000,
    "maxWindowMs": 15000,
    "maxTypingMs": 60000
  }
}
```

## 7 已知边界

- **多等就是慢一点**：窗口越长合并越省，但对方会觉得「怎么不回」。2 秒是踩过的平衡点，别随手调大。
- **上限到了不会补醒**：如果对方在上限之后继续发，那是一条新消息、新窗口、新唤醒 —— 合并只发生在同一次等待里。
- **打字状态不可靠**：QQ 不保证每次都推 STOP，所以「打字中」封顶（60 秒）是必需的兜底；客户端不发事件时行为与没有这项功能完全一致。
- 纯逻辑模块（无 I/O、无定时器）是为了能直接单测：`scripts/test-typing-watch.mjs` 钉住窗口计算、顺延上限与事件识别。
