/**
 * Host 侧热重载内核。
 *
 * 目标：磁盘源码变了以后，让**同一个 DSH 进程**用新代码重新 apply 插件，不需要重启。
 *
 * 为什么要这么做（而不是简单 `import()` 一次）：
 *  1. Node 的 ESM 模块缓存（`loader.internal.loadCache`）和 CJS 缓存（`require.cache`）
 *     会直接返回旧模块对象，必须先删掉对应条目；
 *  2. 光重新 import 不够——旧插件注册的工具/命令还挂在 registry 上，必须先 dispose，
 *     否则会出现「两份插件同时生效」；
 *  3. dispose 的顺序很关键：DSH 的 Loader 监听 `internal/plugin`，一旦发现某个 fiber
 *     在 registry 里还有记录地被销毁，就会把该 entry 标记 `disabled: true` 并写回配置。
 *     所以必须**先从 registry 删掉旧 plugin，再等 fiber 卸载**，然后才 apply 新模块。
 *
 * 上面的第 3 点是本文件存在的核心原因，序列与宿主内置 HMR（`@deepseek-ai/dsh-hmr`
 * 的 `partialReload`）保持一致。
 */
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** 统一成「小写、正斜杠、无尾斜杠」的路径键，便于跨平台比较。 */
export function normalizePath(value) {
  return String(value ?? '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** target 是否等于 root 或位于 root 之下。 */
export function isUnder(target, root) {
  const left = normalizePath(target);
  const right = normalizePath(root);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`);
}

/** file URL 转本地路径；非 file URL 或转换失败时退化为「去掉查询串的原文」。 */
export function urlToPathSafe(url) {
  const raw = String(url ?? '');
  if (!raw.startsWith('file:')) return raw.replace(/[?#].*$/, '');
  try {
    return fileURLToPath(raw);
  } catch {
    return raw.replace(/[?#].*$/, '');
  }
}

/** 路径的 realpath（失败时退回规范化原值），用来穿透 `link:` 造成的 junction/符号链接。 */
export function realPathOf(value) {
  const norm = normalizePath(value);
  if (!norm) return '';
  try {
    return normalizePath(realpathSync.native(value));
  } catch {
    return norm;
  }
}

/**
 * 组装一次缓存比对的「线索集」。
 *
 * 为什么不能只比路径前缀：`link:` 装入的插件在宿主里的模块标识可能是
 * `<profile>/node_modules/<pkg>/lib/index.js`（junction 路径），而配置里监视的是
 * 真实目录 `<...>/experiments/<name>`，两者字面不同 → 前缀比较必然漏。
 * 所以线索里同时带上：根路径、根的 basename、根的 realpath、插件包名。
 */
function buildIndex(roots, packages) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  const hints = new Set();
  for (const root of list) {
    const norm = normalizePath(root);
    if (!norm) continue;
    hints.add(norm);
    const base = norm.split('/').filter(Boolean).pop();
    if (base) hints.add(base);
    const real = realPathOf(root);
    if (real) hints.add(real);
  }
  for (const pkg of (Array.isArray(packages) ? packages : []).filter(Boolean)) {
    const norm = normalizePath(pkg);
    if (norm) hints.add(norm);
  }
  return { roots: list.map((root) => normalizePath(root)).filter(Boolean), hints: [...hints].filter(Boolean) };
}

/**
 * 判断某个缓存键是否属于被监视的插件。
 * @returns {'under'|'realpath'|'hint'|null} 命中的策略名
 */
export function matchCacheKey(key, index) {
  if (typeof key !== 'string' || !key) return null;
  const raw = normalizePath(key);
  const norm = normalizePath(urlToPathSafe(key));
  for (const root of index.roots) {
    if (isUnder(norm, root) || isUnder(raw, root)) return 'under';
  }
  const real = realPathOf(urlToPathSafe(key));
  if (real) {
    for (const root of index.roots) {
      if (isUnder(real, root)) return 'realpath';
    }
  }
  for (const hint of index.hints) {
    if (norm === hint || raw === hint) return 'hint';
    if (norm.includes(`/${hint}/`) || raw.includes(`/${hint}/`)) return 'hint';
    // 裸标识符（例如 entry name 本身就是包名）
    if (norm.startsWith(`${hint}/`)) return 'hint';
  }
  return null;
}

/**
 * 删掉所有属于被监视插件的模块缓存条目（ESM loadCache + CJS require.cache）。
 * @returns {{ esm: string[], cjs: string[], skipped: string[], strategies: Record<string, number> }}
 */
export function purgeModuleCaches(loader, roots, options = {}) {
  const result = { esm: [], cjs: [], skipped: [], strategies: {} };
  const index = buildIndex(roots, options.packages);
  if (!index.roots.length && !index.hints.length) return result;
  const note = (name) => {
    result.strategies[name] = (result.strategies[name] ?? 0) + 1;
  };

  const cache = loader?.internal?.loadCache;
  if (cache && typeof cache.keys === 'function') {
    let keys = [];
    try {
      keys = [...Map.prototype.keys.call(cache)];
    } catch (error) {
      result.skipped.push(`loadCache keys: ${error?.message ?? error}`);
    }
    for (const url of keys) {
      const hit = matchCacheKey(url, index);
      if (!hit) continue;
      try {
        // Node 24 的 LoadCache.delete 只把槽位置为 undefined，必须用 Map 原生删除。
        Map.prototype.delete.call(cache, url);
        result.esm.push(String(url));
        note(hit);
      } catch (error) {
        result.skipped.push(`loadCache delete ${url}: ${error?.message ?? error}`);
      }
    }
  } else {
    result.skipped.push('loader.internal.loadCache unavailable');
  }

  for (const key of Object.keys(require.cache)) {
    const hit = matchCacheKey(key, index);
    if (!hit) continue;
    try {
      Reflect.deleteProperty(require.cache, key);
      result.cjs.push(key);
      note(hit);
    } catch (error) {
      result.skipped.push(`require.cache ${key}: ${error?.message ?? error}`);
    }
  }
  return result;
}

/**
 * 只读诊断：把「缓存里到底挂了哪些键」摊开，用于排查「报告成功但代码没换」。
 * 不删任何东西。
 */
export function probeModuleCaches(loader, { roots = [], packages = [], sampleLimit = 8 } = {}) {
  const index = buildIndex(roots, packages);
  const cache = loader?.internal?.loadCache;
  const info = {
    hasInternal: Boolean(loader?.internal),
    hasLoadCache: Boolean(cache && typeof cache.keys === 'function'),
    esmKeys: 0,
    cjsKeys: 0,
    matched: [],
    samples: [],
    hints: index.hints.slice(0, 12),
    skipped: [],
  };
  if (info.hasLoadCache) {
    try {
      const keys = [...Map.prototype.keys.call(cache)].map(String);
      info.esmKeys = keys.length;
      for (const key of keys) {
        if (matchCacheKey(key, index)) info.matched.push(key.length > 200 ? `${key.slice(0, 200)}…` : key);
      }
      info.samples = keys.slice(0, sampleLimit).map((key) => (key.length > 200 ? `${key.slice(0, 200)}…` : key));
    } catch (error) {
      info.skipped.push(String(error?.message ?? error));
    }
  }
  const cjsKeys = Object.keys(require.cache);
  info.cjsKeys = cjsKeys.length;
  for (const key of cjsKeys) {
    if (matchCacheKey(key, index)) info.matched.push(key);
  }
  return info;
}

/** 用 profile 的解析规则把一个插件模块标识解析到磁盘文件（失败返回 undefined）。 */
export function resolveEntryFile(name, profileDir) {
  if (typeof name !== 'string') return undefined;
  const raw = name.trim();
  if (!raw) return undefined;
  if (raw.startsWith('file:')) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\')) return raw;
  if (profileDir) {
    try {
      return createRequire(join(profileDir, 'package.json')).resolve(raw);
    } catch {
      /* 继续尝试本插件的解析规则 */
    }
  }
  try {
    return require.resolve(raw);
  } catch {
    return undefined;
  }
}

/** 取 entry 的 getOuterStack（Loader 期望「返回调用栈数组的函数」）。 */
function outerStackOf(entry) {
  const value = typeof entry?.getOuterStack === 'function' ? entry.getOuterStack : undefined;
  if (!value) return () => [];
  return value.bind(entry);
}

/** 从 loader 的 entry 树里挑出「本次变更涉及的 entry」。 */
export function pickEntries(entries, { names = [], roots = [], targets = [] } = {}) {
  const wanted = names.map((name) => normalizePath(name)).filter(Boolean);
  const filters = targets.map((target) => normalizePath(target)).filter(Boolean);
  const matched = [];
  for (const entry of entries ?? []) {
    const name = entry?.options?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    const key = normalizePath(name);
    let hit = filters.some((filter) => key.includes(filter));
    if (!hit && wanted.length) {
      hit = wanted.includes(key) || wanted.some((item) => key.startsWith(`${item}/`));
    }
    if (!hit && roots.length) {
      hit = roots.some((root) => isUnder(urlToPathSafe(name), root));
    }
    if (hit) matched.push(entry);
  }
  return matched;
}

/** 描述一个 entry 的当前状态，用于日志与工具输出。 */
export function describeEntry(entry) {
  const fiber = entry?.fiber;
  return {
    id: entry?.options?.id,
    name: entry?.options?.name,
    disabled: Boolean(entry?.options?.disabled),
    loaded: Boolean(fiber),
    uid: fiber?.uid ?? null,
    state: fiber?.state,
  };
}

/**
 * 用磁盘上的最新代码重新 apply 一个 loader entry。
 *
 * @param {any} entry        loader entry（`entry.options.name` 是插件模块标识）
 * @param {any} ctx          插件上下文（用于 `ctx.get('loader')`）
 * @param {{ purgeRoots?: string[], packages?: string[], profileDir?: string, logger?: any, force?: boolean }} options
 * @returns {Promise<{ ok: boolean, name?: string, reason?: string, mode?: string, cacheEmpty?: boolean, esmPurged?: number, cjsPurged?: number, error?: unknown }>}
 */
export async function reloadEntry(entry, ctx, options = {}) {
  const { purgeRoots = [], packages = [], profileDir, logger, force = false } = options;
  const name = entry?.options?.name;
  if (typeof name !== 'string' || !name.trim()) return { ok: false, reason: 'entry-has-no-name' };
  if (entry?.options?.disabled && !force) return { ok: false, name, reason: 'entry-disabled' };

  const loader = ctx?.get?.('loader') ?? ctx?.loader;
  if (!loader) return { ok: false, name, reason: 'loader-unavailable' };

  const before = entry.fiber ?? null;
  if (!before && !force) return { ok: false, name, reason: 'entry-not-loaded' };

  const stack = outerStackOf(entry);
  const config = entry.options?.config;

  // 1) 先清缓存：否则 import 回来的还是旧模块对象。
  const purged = purgeModuleCaches(loader, purgeRoots.length ? purgeRoots : [], { packages });
  const cacheEmpty = purged.esm.length === 0 && purged.cjs.length === 0;

  // 1.5) 兜底：一条缓存都没清掉时（宿主没有 --expose-internals、或模块标识与监视目录
  //      字面对不上），改用「带版本号的模块 URL」重新 import —— 新 URL 必然产生新的
  //      模块实例，因此即便清不掉缓存也能拿到新代码。这是「报告成功但代码没换」的解药。
  let mode = 'purge';
  let specifier = name;
  if (cacheEmpty) {
    const file = resolveEntryFile(name, profileDir);
    if (file) {
      specifier = `${pathToFileURL(file).href}?dshlr=${Date.now().toString(36)}`;
      mode = 'bust';
    } else {
      mode = 'none';
    }
  }

  // 2) 先把新模块 import 回来（失败就原样保留旧插件，什么都不动）。
  let replacement;
  try {
    if (mode === 'bust') {
      try {
        replacement = loader.unwrapExports(await entry.parent.tree.import(specifier, stack));
      } catch {
        // 宿主的 tree.import 不认带查询串的 URL 时，退回原生动态 import。
        replacement = loader.unwrapExports(await import(specifier));
      }
    } else {
      replacement = loader.unwrapExports(await entry.parent.tree.import(specifier, stack));
    }
  } catch (error) {
    logger?.warn?.(`live-reload: import failed for ${name}`);
    logger?.warn?.(error);
    return { ok: false, name, reason: 'import-failed', mode, cacheEmpty, error, esmPurged: purged.esm.length, cjsPurged: purged.cjs.length };
  }
  if (!replacement) {
    return { ok: false, name, reason: 'no-exports', mode, cacheEmpty, esmPurged: purged.esm.length, cjsPurged: purged.cjs.length };
  }

  // 3) 换血：registry 先删旧 plugin（这一步让 Loader 认为「是按插件删除而销毁」，
  //    因此不会把 entry 写成 disabled），等旧 fiber 卸载干净，再 apply 新模块。
  const oldPlugin = before?.runtime?.callback;
  const registry = before?.parent?.registry ?? entry.parent?.ctx?.registry;
  const fibers = oldPlugin && typeof registry?.get === 'function'
    ? [...(registry.get(oldPlugin)?.fibers ?? [])]
    : (before ? [before] : []);

  try {
    if (oldPlugin && registry) registry.delete(oldPlugin);
    await Promise.allSettled(fibers.map((fiber) => (typeof fiber?.await === 'function' ? fiber.await() : Promise.resolve())));
    const fiber = registry.plugin(replacement, config, stack).ctx.fiber;
    fiber.entry = entry;
    entry.fiber = fiber;
    if (typeof fiber.await === 'function') await fiber.await();
    if (typeof loader.await === 'function') await loader.await();
    return {
      ok: true,
      name,
      mode,
      cacheEmpty,
      esmPurged: purged.esm.length,
      cjsPurged: purged.cjs.length,
      strategies: purged.strategies,
      fibers: fibers.length,
    };
  } catch (error) {
    logger?.warn?.(`live-reload: apply failed for ${name}, rolling back`);
    logger?.warn?.(error);
    // 4) 回滚：把旧模块对象重新 apply 回去，至少恢复到「能用的上一版」。
    let rolledBack = false;
    try {
      if (oldPlugin && registry) {
        const fiber = registry.plugin(oldPlugin, config, stack).ctx.fiber;
        fiber.entry = entry;
        entry.fiber = fiber;
        rolledBack = true;
      }
    } catch (rollbackError) {
      logger?.warn?.(rollbackError);
    }
    return { ok: false, name, reason: 'apply-failed', mode, cacheEmpty, error, rolledBack, esmPurged: purged.esm.length, cjsPurged: purged.cjs.length };
  }
}

/**
 * 批量重载：按 entry 去重，逐个重载，单个失败不影响其它。
 * @returns {Promise<{ results: any[], ok: number, failed: number }>}
 */
export async function reloadEntries(entries, ctx, options = {}) {
  const seen = new Set();
  const results = [];
  for (const entry of entries ?? []) {
    const key = entry?.options?.id ?? entry?.options?.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push(await reloadEntry(entry, ctx, options));
  }
  return {
    results,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
  };
}
