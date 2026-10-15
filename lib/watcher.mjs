/**
 * 轮询式目录监视器。
 *
 * 为什么用轮询而不是 `fs.watch`：
 *  - Windows 上 `fs.watch` 对「编辑器先写临时文件再改名」的保存方式经常漏事件，
 *    而漏一次就等于「改了代码却没生效」，用户会以为插件坏了；
 *  - 插件源码目录很小（几 KB~几百 KB），每 700ms 扫一次指纹的开销可以忽略；
 *  - 指纹扫描已由 `snapshot.mjs` 实现并单测覆盖，行为完全可预测。
 */
import { DEFAULT_IGNORE, diffRootSnapshots, scanRoots } from './snapshot.mjs';

/**
 * @param {{
 *   roots?: string[],
 *   pollMs?: number,
 *   debounceMs?: number,
 *   ignore?: string[],
 *   maxFiles?: number,
 *   logger?: any,
 *   onReload: (touched: Array<{root: string, changed: string[], added: string[], removed: string[]}>) => Promise<void> | void,
 * }} options
 */
export function createWatcher(options) {
  const {
    roots = [],
    pollMs = 700,
    debounceMs = 300,
    ignore = DEFAULT_IGNORE,
    maxFiles = 5000,
    logger,
    onReload,
  } = options;

  let list = [...roots];
  let snapshot = null;
  let timer = null;
  let debounceTimer = null;
  let busy = false;
  let stopped = true;
  const pending = new Map();
  const stats = {
    ticks: 0,
    triggers: 0,
    reloads: 0,
    failures: 0,
    lastTouched: [],
    lastReloadAt: null,
    lastError: null,
  };

  const clearDebounce = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const mergeTouched = (touched) => {
    for (const item of touched) {
      const previous = pending.get(item.root);
      if (!previous) {
        pending.set(item.root, { ...item });
        continue;
      }
      previous.changed = [...new Set([...previous.changed, ...item.changed])];
      previous.added = [...new Set([...previous.added, ...item.added])];
      previous.removed = [...new Set([...previous.removed, ...item.removed])];
      previous.total = previous.changed.length + previous.added.length + previous.removed.length;
    }
  };

  async function flush() {
    debounceTimer = null;
    if (!pending.size) return;
    if (busy) {
      // 上一轮重载还没结束，等它结束后再合并处理这批（避免重入 loader 事务）。
      debounceTimer = setTimeout(flush, Math.max(80, debounceMs));
      debounceTimer.unref?.();
      return;
    }
    const touched = [...pending.values()];
    pending.clear();
    busy = true;
    try {
      // onReload 返回「真正被重载的插件个数」：变更可能落在豁免目录（例如本插件自己、
      // reloadSelf=false）或匹配不到任何 entry，那种情况下不算一次重载。
      const applied = await onReload?.(touched);
      const count = Number(applied);
      stats.reloads += Number.isFinite(count) && count > 0 ? count : 0;
      stats.lastReloadAt = new Date().toISOString();
      stats.lastTouched = touched.map((item) => ({
        root: item.root,
        changed: item.changed.slice(0, 20),
        added: item.added.slice(0, 20),
        removed: item.removed.slice(0, 20),
      }));
    } catch (error) {
      stats.failures += 1;
      stats.lastError = String(error?.message ?? error);
      logger?.warn?.('live-reload: reload batch failed');
      logger?.warn?.(error);
    } finally {
      busy = false;
    }
  }

  function schedule() {
    stats.triggers += 1;
    clearDebounce();
    debounceTimer = setTimeout(flush, debounceMs);
    debounceTimer.unref?.();
  }

  async function scan() {
    return scanRoots(list, { ignore, maxFiles });
  }

  async function tick() {
    if (stopped || busy || !list.length) return;
    stats.ticks += 1;
    let after;
    try {
      after = await scan();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
      return;
    }
    const touched = diffRootSnapshots(snapshot, after);
    snapshot = after;
    if (!touched.length) return;
    mergeTouched(touched);
    schedule();
  }

  return {
    stats,
    get roots() {
      return [...list];
    },
    /** 首次建立基线指纹（不会触发重载）。 */
    async prime() {
      snapshot = await scan();
      return snapshot;
    },
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(() => {
        tick().catch(() => {});
      }, Math.max(120, pollMs));
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearDebounce();
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 换一组监视根目录（先重建基线，避免把「新加入的目录」当成变更）。 */
    async setRoots(nextRoots) {
      list = [...new Set((nextRoots ?? []).filter(Boolean))];
      pending.clear();
      await this.prime();
      return list;
    },
    /** 立刻扫描一次（工具手动触发时用）。 */
    async checkNow() {
      const before = snapshot;
      const after = await scan();
      snapshot = after;
      const touched = diffRootSnapshots(before, after);
      if (touched.length) mergeTouched(touched);
      return touched;
    },
    /** 直接触发一次重载（不看指纹，用于手动按钮）。 */
    async forceReload(touched = [...pending.values()]) {
      pending.clear();
      return onReload?.(touched.length ? touched : list.map((root) => ({ root, changed: [], added: [], removed: [], total: 0 })));
    },
  };
}
