# Embedding 包（可选）

> **先看这一句**：默认的记忆系统不需要它。记忆库是 `memory/memory.db`，检索走 SQLite 全文索引 + 关键词，不依赖向量。
> 这份文档只在你**主动把记忆切回旧的向量模式**（`memory.engine=card` 且 `memory.mode=vector` 或 `hybrid`）时才相关。

> ⛔ **本地 18765 的 shim 已退役（2026-11-22）**：`memory.engine='db'` 时向量记忆管线整体不启动，
> `~/.dsh/stellar/keepalive.ps1` 里负责探活并拉起 18765 的块已删除，`embedding-shim.mjs` 进程已停、脚本文件保留。
> 那个 shim **不是本地模型**：它把请求原样转发给云端 embeddings 接口，记忆文本因此会离开本机；
> 默认 `db` 路径上这条外发通道已经关掉。云端包仍在，但只有你自己显式启用并切回旧管线时才会用到。
>
> **恢复三步**（缺一步会静默降级）：① 仓库根 `config.json` 的 `memory.engine` 改回 `"card"`；
> ② 在 `keepalive.ps1` 恢复 18765 探活块，或手动 `node ~/.dsh/stellar/embedding-shim.mjs`；
> ③ 确认 `vectorMemory.enabled` 没被关掉，再跑 `node scripts/test-vector-memory.mjs` 验一遍。

## 1. 它解决什么

把「她记得的事」按语义检索：拿这句话去向量库里找最像的旧记忆。优点是换个说法也能召回，缺点是得有一个 embedding 模型常驻，还得多存一份索引。

默认路径（`memory.db`）不需要这个。用它的场景只有两种：你想做语义召回实验；或者你把 `engine` 显式改回 `card`。

## 2. 为什么不打包进本仓库

| 东西 | 体积 | 塞进本体会怎样 |
| --- | --- | --- |
| bge-small-zh-v1.5 | ~48 MB | 不装向量记忆的人也得下载 |
| qwen3-embedding-0.6b | ~639 MB | 更新包翻倍 |
| bge-m3 | ~1.2 GB | 低配机器根本用不到 |
| Embedding 运行时 | 几十~几百 MB | 拖着 Python/Ollama 依赖，还得跟本体版本解耦 |
| 云端 provider | 0 权重 | 只是 endpoint + 模型名 + 密钥 |

所以本体只留**适配器代码 + 安装器 + 设置页**，模型与运行时按需装到 `state/embedding-packs/`。

## 3. 三类包

| 类型 | 内容 | 是否必需 |
| --- | --- | --- |
| `runtime` | Node `embedding-service.mjs` + Ollama CPU 运行时 + `run.bat` / `stop.bat` | 本地与云端都要（云端也经这个服务转发） |
| `model` | 一个 GGUF 模型 + `pack.json` | 至少装一个，或只用云端 |
| `cloud` | 无权重，只有 provider 预设 + 密钥 | 可选 |

## 4. 装在哪

```
state/embedding-packs/
  runtime/            # 运行时 + embedding-runtime.json
  bge-small-zh-v1.5/  # pack.json + model.gguf
  bge-m3/
  cloud/              # pack.json + config.json（密钥单独存，ACL 限制）
```

三点约定：不与本仓库文件混放；`release/install-manifest.json` **不包含**这里；卸载是 rename 到 `_quarantine/`，不硬删。

## 5. pack.json 长什么样

```json
{
  "schema": 1,
  "id": "bge-small-zh-v1.5",
  "kind": "model",
  "name": "bge-small-zh-v1.5（低配）",
  "model": "bge-small-zh-v1.5",
  "modelSpace": "bge-small-zh-v1.5@512-f16-v1",
  "dimension": 512,
  "sizeBytes": 48326944,
  "license": "MIT",
  "requires": ["runtime>=1.0.0"],
  "files": [{ "path": "model.gguf", "sha256": "…", "size": 48326944 }]
}
```

校验顺序：`schema` → `kind` → `id` 与目录名一致 → 每个文件的 sha256 与大小 → `modelSpace` → `requires`。任何一步不过就不覆盖现有包，并把原因显示在设置页。

## 6. 怎么用

设置页「B站」或「扩展」里那一块「Embedding 功能（可选安装）」：

1. 装 `runtime`（一次）；
2. 选一个本地模型装好，或填云端 endpoint / 模型名 / 空间 / 密钥；
3. 点「一键启动 runtime + 选中模型」——启动后监听 `127.0.0.1` 的本地端口，模型包会自动注册；
4. 点「测试服务」：它会真的编码一条短文本，回 model / dimension / latency，不是只看健康检查；
5. 需要的话把记忆方式切到 `vector`（或在 `hybrid` 下让向量块只补漏项）。

**换模型必须重建索引**：不同模型的 `modelSpace` 不同，空间对不上时检索会拒答并在日志里提示重建。

## 7. 常见失败

| 现象 | 原因 |
| --- | --- |
| 状态显示「运行中」但检索没结果 | 索引与当前模型空间不一致 → 重建索引 |
| 装了模型但服务起不来 | runtime 没装，或端口被占（换端口） |
| 检索一直空 | 记忆方式没切到 `vector`/`hybrid`；或者库里本来就没有索引过的旧记忆 |
| 云端报错 | 密钥与 endpoint 不匹配（不同厂商的 key 不通用）；维度不要手写，以「测试服务」自检为准 |

## 8. 数据边界

- 模型、运行时、云端配置都在 `state/embedding-packs/`，不随仓库走，也不进安装清单；
- 云端密钥只在本机 `cloud/config.json`（权限 0600），设置页只显示掩码；
- 卸载 = 移到 `_quarantine/`，随时可以删掉而不影响主程序。
