/**
 * 记忆配置源解析 —— 桥接与插件必须读同一份。
 *
 * 背景（2026-11-22，PITFALLS #303）：桥接读 `<仓库根>/config.json`，插件读
 * `<DSH_HOME>/stellar/config.json`，两份文件里 `memory.engine` 一个有、一个没有，
 * 于是「退役旧记忆卡」的开关只生效了一半：QQ 侧退役了，B站 侧每轮还在注入旧卡，
 * 向量记忆与 embedding 也照旧跑。同一份解释逻辑放在这里，两边都调，别再各写一套。
 *
 * 解析顺序（与 2026-11-13 定的桥接口径一致）：
 *   1. `rootFile`（仓库根 config.json）：能解析且 `memory` 是对象 → 用它。
 *   2. 否则回退 `fallbackFile`（$DSH_HOME/stellar/config.json，旧布局）。
 * 两份都不行时抛错，由调用方决定降级方式（桥接降级旧卡片、插件当作未退役）。
 */
import fs from 'node:fs';

/** engine 只有两个取值：'db'（新记忆库）与 'card'（旧记忆卡）。其它一律当 card。 */
export function normalizeMemoryEngine(value) {
  return String(value || '').trim().toLowerCase() === 'db' ? 'db' : 'card';
}

/** 只做「选哪份文件」，不解析内容；找不到可用文件时抛错。 */
export function resolveMemoryConfigFile({ rootFile, fallbackFile, fsImpl = fs } = {}) {
  const tryRoot = () => {
    if (!rootFile) return false;
    const raw = JSON.parse(fsImpl.readFileSync(rootFile, 'utf8'));
    return Boolean(raw && typeof raw.memory === 'object' && raw.memory !== null);
  };
  let rootOk = false;
  try { rootOk = tryRoot(); } catch { rootOk = false; }
  if (rootOk) return { file: rootFile, source: 'root' };
  if (!fallbackFile) return { file: rootFile, source: 'root' };
  return { file: fallbackFile, source: 'fallback' };
}

/**
 * 读一份记忆配置，返回文件、来源与规范化后的开关。
 * 调用方要缓存就按 `file + mtimeMs + size` 做键（桥接与插件都是这么做的）。
 */
export function readMemoryConfig({ rootFile, fallbackFile, fsImpl = fs } = {}) {
  const { file, source } = resolveMemoryConfigFile({ rootFile, fallbackFile, fsImpl });
  if (!file) throw new Error('没有可用的 config.json 路径');
  const stat = fsImpl.statSync(file);
  const config = JSON.parse(fsImpl.readFileSync(file, 'utf8')) ?? {};
  const memory = (config && typeof config.memory === 'object' && config.memory !== null) ? config.memory : {};
  return {
    file,
    source,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    config,
    memory,
    mode: typeof memory.mode === 'string' ? memory.mode : 'narrative',
    engine: normalizeMemoryEngine(memory.engine),
  };
}

export default { normalizeMemoryEngine, readMemoryConfig, resolveMemoryConfigFile };
