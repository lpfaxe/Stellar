/**
 * 插件侧的记忆引擎判定 —— 与桥接读同一份配置、用同一套解释。
 *
 * 2026-11-22 之前插件读 `$DSH_HOME/stellar/config.json`（旧壳，没有 memory.engine），
 * 于是桥接已经判定「记忆库接管」时，插件仍以为旧记忆卡在役：B站 每轮注入旧卡、
 * 向量记忆每 10 分钟跑一次、embedding 打到云端（PITFALLS #303）。
 * 现在两边都走 src/unified-memory-config.js 的 resolveMemoryConfigFile。
 */
import path from 'node:path';
import { QQBOT_ROOT, UNIFIED_FILE } from './paths.js';
import { readMemoryConfig } from '../../../src/unified-memory-config.js';

const ROOT_CONFIG = path.join(QQBOT_ROOT, 'config.json');
let cache = { key: '', result: null };

function fallbackResult(rootFile, error) {
  return {
    file: rootFile,
    source: 'root',
    engine: 'card',
    mode: 'narrative',
    mtimeMs: 0,
    size: 0,
    config: {},
    memory: {},
    error: error ? String(error.message || error) : '',
  };
}

/**
 * 当前生效的记忆引擎（'db' | 'card'）与配置摘要。
 * 读不到配置时按 'card' 处理：宁可多跑一遍旧卡，也不要在配置损坏时把她的记忆全关掉。
 */
export function memoryEngineNow(options = {}) {
  const rootFile = options.rootFile || ROOT_CONFIG;
  const fallbackFile = options.fallbackFile || UNIFIED_FILE;
  const useCache = options.cache !== false;
  try {
    const cfg = readMemoryConfig({ rootFile, fallbackFile });
    const key = `${cfg.file}:${cfg.mtimeMs}:${cfg.size}`;
    if (useCache && cache.key === key && cache.result) return cache.result;
    const result = {
      file: cfg.file,
      source: cfg.source,
      engine: cfg.engine,
      mode: cfg.mode,
      mtimeMs: cfg.mtimeMs,
      size: cfg.size,
      config: cfg.config,
      memory: cfg.memory,
    };
    if (useCache) cache = { key, result };
    return result;
  } catch (error) {
    cache = { key: '', result: null };
    return fallbackResult(rootFile, error);
  }
}

/** engine === 'db'：新记忆库是唯一真相，记忆卡/向量两条旧管线一律不启动。 */
export function memoryPipelineRetiredNow(options = {}) {
  return memoryEngineNow(options).engine === 'db';
}

/** 测试与切角色用：丢掉缓存，下次重新读文件。 */
export function resetMemoryEngineCache() {
  cache = { key: '', result: null };
}

export default { memoryEngineNow, memoryPipelineRetiredNow, resetMemoryEngineCache };
