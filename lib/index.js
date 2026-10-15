/**
 * dsh-live-reload —— DSH 免重启热刷新插件（host 半边）。
 *
 * 做两件事：
 *  1. 插件源码一变就重新加载对应的 host 侧插件模块（清 Node 模块缓存 + 重新 apply），
 *     于是「改代码 → 立刻生效」，不需要重启 DSH 桌面端；
 *  2. 有 Web 界面时通知页面刷新（注入轮询脚本 + 一个 /state 端点），
 *     于是工具列表/卡片/侧边栏也能马上看到新版。
 *
 * 对外同时提供：
 *  - 工具 `live_reload`（status / check / reload / start / stop / roots）
 *  - 服务 `liveReload`（同一个 API，供其它插件调用）
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_IGNORE } from './snapshot.mjs';
import { collectWatchRoots, packageNameOf } from './roots.mjs';
import { describeEntry, pickEntries, probeModuleCaches, reloadEntries } from './reloader.mjs';
import { createUiState, injectIntoIndex, renderClientScript } from './ui.mjs';
import { createWatcher } from './watcher.mjs';

export const name = 'dsh-live-reload';
export const inject = ['tools', 'loader'];

const DEFAULTS = {
  watch: [],
  exclude: [],
  autoWatch: true,
  reloadSelf: false,
  pollMs: 700,
  debounceMs: 300,
  maxFiles: 5000,
  maxReloads: 20,
  reloadTargets: [],
  refreshUi: 'auto',
  uiPath: '/__dsh-live-reload',
  uiPollMs: 1500,
  ignore: [],
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'action'],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    message: { type: 'string' },
    running: { type: 'boolean' },
    hint: { type: 'string' },
    reloaded: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          id: { type: 'string' },
          ok: { type: 'boolean' },
          reason: { type: 'string' },
          error: { type: 'string' },
          esmPurged: { type: 'number' },
          cjsPurged: { type: 'number' },
          mode: { type: 'string' },
          cacheEmpty: { type: 'boolean' },
          fibers: { type: 'number' },
          rolledBack: { type: 'boolean' },
        },
        required: ['name', 'ok'],
      },
    },
    cache: {
      type: 'object',
      additionalProperties: false,
      properties: {
        hasInternal: { type: 'boolean' },
        hasLoadCache: { type: 'boolean' },
        esmKeys: { type: 'number' },
        cjsKeys: { type: 'number' },
        matched: { type: 'array', items: { type: 'string' } },
        samples: { type: 'array', items: { type: 'string' } },
        hints: { type: 'array', items: { type: 'string' } },
        skipped: { type: 'array', items: { type: 'string' } },
      },
      required: ['hasInternal'],
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          id: { type: 'string' },
          loaded: { type: 'boolean' },
          disabled: { type: 'boolean' },
          watched: { type: 'boolean' },
          uid: { type: 'number' },
          state: { type: 'number' },
        },
        required: ['name'],
      },
    },
    roots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          source: { type: 'string' },
          package: { type: 'string' },
        },
        required: ['dir'],
      },
    },
    touched: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string' },
          changed: { type: 'array', items: { type: 'string' } },
          added: { type: 'array', items: { type: 'string' } },
          removed: { type: 'array', items: { type: 'string' } },
        },
        required: ['root'],
      },
    },
    stats: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ticks: { type: 'number' },
        triggers: { type: 'number' },
        reloads: { type: 'number' },
        failures: { type: 'number' },
        lastReloadAt: { type: 'string' },
        lastError: { type: 'string' },
      },
    },
    ui: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        injected: { type: 'boolean' },
        path: { type: 'string' },
        mode: { type: 'string' },
        rev: { type: 'number' },
        clients: { type: 'number' },
      },
      required: ['enabled'],
    },
    config: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pollMs: { type: 'number' },
        debounceMs: { type: 'number' },
        autoWatch: { type: 'boolean' },
        reloadSelf: { type: 'boolean' },
        refreshUi: { type: 'string' },
        maxReloads: { type: 'number' },
      },
    },
  },
};

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'check', 'reload', 'start', 'stop', 'roots', 'cache'],
      description:
        'status=查看监视状态；check=立刻比对一次磁盘指纹并按需重载；reload=立即重载（可带 target）；start/stop=开关自动监视；roots=列出被监视的插件目录；cache=诊断用的模块缓存快照（排查「报告成功但代码没换」时用）。',
    },
    target: {
      type: 'string',
      description: '只重载名字或目录里包含这个子串的插件（可选）。',
    },
    targets: {
      type: 'array',
      items: { type: 'string' },
      description: '同上，可一次指定多个子串（可选）。',
    },
    reason: {
      type: 'string',
      description: '这次重载的原因，会显示在界面刷新提示里（可选）。',
    },
  },
  required: [],
};

/** 去掉 undefined 字段，保证返回值是无损 JSON。 */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = prune(item);
    }
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function textBlock(text) {
  return { type: 'text', text: String(text ?? '') };
}

function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const extraIgnore = Array.isArray(config.ignore) ? config.ignore.filter((item) => typeof item === 'string' && item) : [];
  const watch = Array.isArray(config.watch) ? config.watch.filter((item) => typeof item === 'string' && item.trim()) : [];
  const exclude = Array.isArray(config.exclude) ? config.exclude.filter((item) => typeof item === 'string' && item.trim()) : [];
  const targets = Array.isArray(config.reloadTargets)
    ? config.reloadTargets.filter((item) => typeof item === 'string' && item.trim())
    : [];
  return {
    watch,
    exclude,
    reloadTargets: targets,
    ignore: [...DEFAULT_IGNORE, ...extraIgnore],
    autoWatch: config.autoWatch !== false,
    reloadSelf: config.reloadSelf === true,
    refreshUi: ['auto', 'idle', 'always', 'manual', 'never'].includes(config.refreshUi) ? config.refreshUi : 'auto',
    uiPath: typeof config.uiPath === 'string' && config.uiPath.startsWith('/') ? config.uiPath : DEFAULTS.uiPath,
    pollMs: clampNumber(config.pollMs, DEFAULTS.pollMs, 150, 60000),
    debounceMs: clampNumber(config.debounceMs, DEFAULTS.debounceMs, 50, 10000),
    uiPollMs: clampNumber(config.uiPollMs, DEFAULTS.uiPollMs, 500, 60000),
    maxFiles: clampNumber(config.maxFiles, DEFAULTS.maxFiles, 100, 50000),
    maxReloads: clampNumber(config.maxReloads, DEFAULTS.maxReloads, 1, 200),
  };
}

/** 从 ctx.baseUrl 推出 profile 目录（`link:` 依赖写在这里）。 */
function profileDirOf(ctx) {
  const base = ctx?.baseUrl;
  if (!base) return undefined;
  const raw = String(base);
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
      const url = new URL(raw.endsWith('/') ? raw : `${raw}/`);
      if (url.protocol === 'file:') return fileURLToPath(url);
    }
  } catch {
    /* 落到下面的路径解析 */
  }
  try {
    return resolve(raw);
  } catch {
    return undefined;
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  const uiState = createUiState();
  const ui = { enabled: false, injected: false, clients: 0 };
  const listeners = new Set();
  const notify = (items) => {
    for (const listener of [...listeners]) {
      try {
        listener(items);
      } catch {
        /* 监听者自己出错不能影响热重载 */
      }
    }
  };

  const logger = (() => {
    try {
      const scoped = ctx.logger?.('live-reload');
      return scoped ?? ctx.logger ?? null;
    } catch {
      return null;
    }
  })();
  const log = (level, message, error) => {
    try {
      const fn = logger?.[level];
      if (typeof fn !== 'function') return;
      if (error === undefined) fn.call(logger, message);
      else fn.call(logger, message, error);
    } catch {
      /* 日志失败不能影响热重载 */
    }
  };

  const state = {
    ready: null,
    watcher: null,
    roots: [],
    sources: {},
    packages: {},
    reloads: [],
    lastTouched: [],
    lastError: null,
    startedAt: new Date().toISOString(),
    selfDir: undefined,
    profileDir: undefined,
  };

  const loader = () => ctx.get('loader') ?? null;

  /** 被监视目录对应的插件包名（用来把目录映射到 loader entry）。 */
  function watchedNames() {
    return state.roots.map((root) => state.packages[root]).filter(Boolean);
  }

  /**
   * 挑出该重载的 loader entry。
   * 语义：显式给了 target 就只按 target 选（否则「指定 target 但没匹配上」会被监视目录
   * 兜住，变成看起来成功、其实重载了别的插件）；没给就按被监视目录选；配置项
   * reloadTargets 始终作为一层白名单收窄。
   */
  function findEntries({ targets = [], roots = [] } = {}) {
    const instance = loader();
    if (!instance || typeof instance.entries !== 'function') return [];
    const all = [...instance.entries()];
    const explicit = (Array.isArray(targets) ? targets : []).filter((item) => typeof item === 'string' && item.trim());
    let matched;
    if (explicit.length) {
      matched = pickEntries(all, { targets: explicit });
    } else {
      const names = roots.length
        ? roots.map((root) => state.packages[root]).filter(Boolean)
        : watchedNames();
      matched = pickEntries(all, { names, roots });
    }
    if (config.reloadTargets.length) {
      const allowed = new Set(pickEntries(all, { targets: config.reloadTargets }));
      matched = matched.filter((entry) => allowed.has(entry));
    }
    const self = state.selfDir ? state.selfDir.toLowerCase() : null;
    return matched.filter((entry) => {
      const entryName = String(entry?.options?.name ?? '');
      if (!config.reloadSelf && self && entryName.toLowerCase().includes('dsh-live-reload')) return false;
      return true;
    });
  }

  /** 变更处理：挑 entry → 逐个重载 → 记状态 → 通知界面。 */
  async function handleTouched(touched, { reason } = {}) {
    const roots = (touched ?? []).map((item) => item.root).filter(Boolean);
    state.lastTouched = (touched ?? []).map((item) => ({
      root: item.root,
      changed: item.changed ?? [],
      added: item.added ?? [],
      removed: item.removed ?? [],
    }));
    const entries = findEntries({ roots }).slice(0, config.maxReloads);
    if (!entries.length) {
      log('info', `live-reload: 检测到变更但没找到对应插件（${roots.join(', ')}）`);
      return { reloaded: [], entries: [] };
    }
    const { results } = await reloadEntries(entries, ctx, {
      purgeRoots: roots,
      packages: watchedNames(),
      profileDir: state.profileDir,
      logger,
    });
    const reloaded = results.map((item) => ({
      name: item.name,
      ok: item.ok,
      reason: item.reason,
      error: item.error ? String(item.error?.message ?? item.error) : undefined,
      esmPurged: item.esmPurged,
      cjsPurged: item.cjsPurged,
      mode: item.mode,
      cacheEmpty: item.cacheEmpty,
      fibers: item.fibers,
      rolledBack: item.rolledBack,
    }));
    const succeeded = reloaded.filter((item) => item.ok);
    if (succeeded.length) {
      const changed = succeeded.map((item) => ({ name: item.name, at: new Date().toISOString(), reason }));
      uiState.bump(changed);
      notify(changed);
      log('info', `live-reload: 已热重载 ${succeeded.map((item) => item.name).join(', ')}`);
    }
    for (const item of reloaded) {
      if (!item.ok) log('warn', `live-reload: ${item.name} 重载失败（${item.reason ?? 'unknown'}）`);
    }
    state.reloads = [...reloaded, ...state.reloads].slice(0, 20);
    return { reloaded, entries: entries.map((entry) => describeEntry(entry)) };
  }

  function statusReport() {
    const instance = loader();
    const entries = instance && typeof instance.entries === 'function' ? [...instance.entries()] : [];
    const names = watchedNames();
    return prune({
      ok: true,
      action: 'status',
      running: Boolean(state.watcher && config.autoWatch),
      roots: state.roots.map((root) => ({
        dir: root,
        source: state.sources[root],
        package: state.packages[root],
      })),
      entries: entries
        .filter((entry) => {
          const entryName = String(entry?.options?.name ?? '');
          return names.some((item) => entryName === item || entryName.startsWith(`${item}/`));
        })
        .map((entry) => {
          const info = describeEntry(entry);
          return prune({
            name: info.name,
            id: info.id,
            loaded: info.loaded,
            disabled: info.disabled,
            watched: true,
            uid: typeof info.uid === 'number' ? info.uid : undefined,
            state: typeof info.state === 'number' ? info.state : undefined,
          });
        }),
      reloaded: state.reloads,
      touched: state.lastTouched,
      stats: state.watcher?.stats
        ? {
            ticks: state.watcher.stats.ticks,
            triggers: state.watcher.stats.triggers,
            reloads: state.watcher.stats.reloads,
            failures: state.watcher.stats.failures,
            lastReloadAt: state.watcher.stats.lastReloadAt ?? undefined,
            lastError: state.watcher.stats.lastError ?? state.lastError ?? undefined,
          }
        : undefined,
      ui: {
        enabled: ui.enabled,
        injected: ui.injected,
        path: config.uiPath,
        mode: config.refreshUi,
        rev: uiState.rev,
        clients: ui.clients,
      },
      config: {
        pollMs: config.pollMs,
        debounceMs: config.debounceMs,
        autoWatch: config.autoWatch,
        reloadSelf: config.reloadSelf,
        refreshUi: config.refreshUi,
        maxReloads: config.maxReloads,
      },
      message: state.roots.length
        ? `正在监视 ${state.roots.length} 个插件目录，已热重载 ${state.watcher?.stats?.reloads ?? 0} 次。`
        : '没有发现可监视的 link: 插件目录（可用 watch 配置项手工指定）。',
    });
  }

  async function bootstrap() {
    const profileDir = profileDirOf(ctx);
    state.profileDir = profileDir;
    state.selfDir = (() => {
      try {
        return fileURLToPath(new URL('..', import.meta.url));
      } catch {
        return undefined;
      }
    })();
    const { roots, sources } = await collectWatchRoots({
      profileDir,
      extraWatch: config.watch,
      exclude: config.exclude,
    }).catch((error) => {
      state.lastError = String(error?.message ?? error);
      return { roots: [], sources: {} };
    });
    state.roots = roots;
    state.sources = sources;
    state.packages = {};
    for (const root of roots) {
      const pkg = await packageNameOf(root);
      if (pkg) state.packages[root] = pkg;
      const normalized = root.replace(/\\/g, '/').toLowerCase();
      if (state.selfDir && normalized === state.selfDir.replace(/\\/g, '/').toLowerCase()) {
        state.packages[root] = 'dsh-live-reload';
      }
    }
    log('info', `live-reload: 监视 ${roots.length} 个目录（poll=${config.pollMs}ms，debounce=${config.debounceMs}ms）`);

    state.watcher = createWatcher({
      roots,
      pollMs: config.pollMs,
      debounceMs: config.debounceMs,
      ignore: config.ignore,
      maxFiles: config.maxFiles,
      logger,
      onReload: async (touched) => {
        const { reloaded } = await handleTouched(touched, { reason: 'watch' });
        // 返回真正被换掉的插件个数：变更落在豁免目录（本插件自己）或匹配不到 entry 时
        // 不算一次重载，统计数字才不会虚高。
        return reloaded.filter((item) => item.ok).length;
      },
    });
    await state.watcher.prime();
    if (config.autoWatch) state.watcher.start();
    return roots;
  }

  async function reloadNow({ target, targets: rawTargets, reason } = {}) {
    const list = Array.isArray(rawTargets) ? rawTargets : target ? [target] : [];
    const targets = list.filter((item) => typeof item === 'string' && item.trim());
    const entries = findEntries({ targets });
    if (!entries.length) {
      return prune({
        ok: false,
        action: 'reload',
        message: targets.length ? `没有匹配「${targets.join(', ')}」的插件` : '没有可重载的插件',
        roots: state.roots.map((root) => ({ dir: root, source: state.sources[root], package: state.packages[root] })),
        hint: '用 live_reload action=status 看当前监视的目录与插件。',
      });
    }
    const { results } = await reloadEntries(entries.slice(0, config.maxReloads), ctx, {
      purgeRoots: state.roots,
      packages: watchedNames(),
      profileDir: state.profileDir,
      logger,
      force: true,
    });
    const reloaded = results.map((item) => ({
      name: item.name,
      ok: item.ok,
      reason: item.reason,
      error: item.error ? String(item.error?.message ?? item.error) : undefined,
      esmPurged: item.esmPurged,
      cjsPurged: item.cjsPurged,
      mode: item.mode,
      cacheEmpty: item.cacheEmpty,
      fibers: item.fibers,
      rolledBack: item.rolledBack,
    }));
    const succeeded = reloaded.filter((item) => item.ok);
    if (succeeded.length) {
      const changed = succeeded.map((item) => ({ name: item.name, at: new Date().toISOString(), reason }));
      uiState.bump(changed);
      notify(changed);
    }
    state.reloads = [...reloaded, ...state.reloads].slice(0, 20);
    return prune({
      ok: reloaded.every((item) => item.ok),
      action: 'reload',
      message: succeeded.length
        ? `已热重载 ${succeeded.length} 个插件：${succeeded.map((item) => item.name).join('、')}`
        : '重载失败，详见 reloaded 字段',
      reloaded,
    });
  }

  // ------------------------------------------------------------------ 工具
  const toolApi = {
    name: 'live_reload',
    description:
      '免重启热刷新：查看/触发 DSH 插件热重载。改完插件源码后调用本工具（或等它自动生效）即可让新代码立即运行，不需要重启 DSH 桌面端；有 Web 界面时界面会自动提示刷新。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(args, value) {
        const action = value?.action ?? args?.action ?? 'status';
        const lines = [];
        const head = action === 'status' ? '♻️ 热重载状态' : `♻️ 热重载 · ${action}`;
        lines.push(head);
        if (value?.message) lines.push(String(value.message));
        if (value?.running !== undefined) lines.push(`自动监视：${value.running ? '开' : '关'}`);
        if (Array.isArray(value?.roots)) {
          for (const root of value.roots.slice(0, 12)) {
            lines.push(`· ${root.package ?? '(未知包)'} → ${root.dir}`);
          }
        }
        if (Array.isArray(value?.reloaded)) {
          for (const item of value.reloaded.slice(0, 20)) {
            const mark = item.ok ? '✅' : '❌';
            const how = item.mode === 'bust' ? '带版本号重新导入' : item.mode === 'none' ? '无法定位模块文件' : '清缓存后重新导入';
            const detail = item.ok
              ? `清理 ESM ${item.esmPurged ?? 0} / CJS ${item.cjsPurged ?? 0}（${how}）`
              : `失败：${item.reason ?? item.error ?? 'unknown'}`;
            lines.push(`${mark} ${item.name}：${detail}`);
          }
          if (value.reloaded.some((item) => item.ok && item.cacheEmpty)) {
            lines.push('⚠️ 有插件一条缓存都没清掉：已改用带版本号的重新导入。若它的工具行为没变化，说明新代码没进去，请重启一次 DSH。');
          }
        }
        if (value?.cache) {
          const info = value.cache;
          lines.push(`ESM 缓存键 ${info.esmKeys ?? 0} 个 · CJS ${info.cjsKeys ?? 0} 个 · 命中 ${(info.matched ?? []).length} 个 · loader.internal ${info.hasInternal ? '可用' : '不可用'}`);
          for (const key of (info.matched ?? []).slice(0, 6)) lines.push(`· 命中 ${key}`);
          if (!(info.matched ?? []).length) {
            for (const key of (info.samples ?? []).slice(0, 4)) lines.push(`· 样例 ${key}`);
          }
          for (const hint of info.hints ?? []) lines.push(`· 比对线索 ${hint}`);
        }
        if (Array.isArray(value?.touched) && value.touched.length) {
          for (const item of value.touched.slice(0, 8)) {
            const files = [...(item.changed ?? []), ...(item.added ?? []), ...(item.removed ?? [])].slice(0, 6);
            lines.push(`· 变更 ${item.root}：${files.join(', ') || '(目录结构变化)'}`);
          }
        }
        if (value?.ui) lines.push(`界面刷新：${value.ui.enabled ? `已启用（${value.ui.path}，rev=${value.ui.rev}）` : '未启用'}`);
        if (value?.stats && (value.stats.reloads || value.stats.triggers)) {
          lines.push(`统计：扫描 ${value.stats.ticks ?? 0} 次 · 触发 ${value.stats.triggers ?? 0} 次 · 重载 ${value.stats.reloads ?? 0} 次 · 失败 ${value.stats.failures ?? 0} 次`);
        }
        if (value?.hint) lines.push(String(value.hint));
        return [textBlock(lines.join('\n'))];
      },
    },
    presentCall(args) {
      const action = args?.action ?? 'status';
      return { card: 'generic', title: `热重载：${action}`, content: [textBlock(`action=${action}`)] };
    },
    presentResult(args, result) {
      return {
        card: 'generic',
        title: '插件热重载',
        content: Array.isArray(result?.content) ? result.content : [],
      };
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const action = typeof args.action === 'string' ? args.action : 'status';
      await state.ready?.catch(() => {});
      if (action === 'status') return statusReport();
      if (action === 'roots') {
        return prune({
          ok: true,
          action: 'roots',
          message: state.roots.length ? `共 ${state.roots.length} 个监视目录` : '没有监视目录',
          roots: state.roots.map((root) => ({ dir: root, source: state.sources[root], package: state.packages[root] })),
          hint: '在插件设置或用 profile 的 link: 依赖（link: 目录）增加可热重载的插件。',
        });
      }
      if (action === 'check') {
        if (!state.watcher) return { ok: false, action: 'check', message: '监视器尚未就绪' };
        const touched = await state.watcher.checkNow();
        if (!touched.length) {
          return prune({ ok: true, action: 'check', message: '磁盘上没有检测到新的改动', touched: [] });
        }
        const { reloaded } = await handleTouched(touched, { reason: args.reason ?? 'check' });
        return prune({
          ok: reloaded.every((item) => item.ok),
          action: 'check',
          message: reloaded.length ? `检测到变更并重载 ${reloaded.length} 个插件` : '检测到变更但没有匹配到插件',
          touched: touched.map((item) => ({
            root: item.root,
            changed: item.changed,
            added: item.added,
            removed: item.removed,
          })),
          reloaded,
        });
      }
      if (action === 'reload') {
        return reloadNow({ target: args.target, targets: args.targets, reason: args.reason ?? 'manual' });
      }
      if (action === 'cache') {
        const instance = loader();
        if (!instance) return { ok: false, action: 'cache', message: 'loader 服务不可用' };
        const info = probeModuleCaches(instance, { roots: state.roots, packages: watchedNames() });
        return prune({
          ok: true,
          action: 'cache',
          message:
            `模块缓存快照：ESM 键 ${info.esmKeys} 个（命中 ${info.matched.length} 个）· CJS 键 ${info.cjsKeys} 个 · ` +
            `loader.internal ${info.hasInternal ? '可用' : '不可用'}${info.hasLoadCache ? '' : '（loadCache 不可见）'}`,
          cache: info,
          hint: info.matched.length
            ? '命中的键就是重载时会删掉的条目。'
            : '没有命中任何键：重载会退化为「带版本号重新导入」（mode=bust），若仍不生效请重启一次。',
        });
      }
      if (action === 'start') {
        if (!state.watcher) return { ok: false, action: 'start', message: '监视器尚未就绪' };
        await state.watcher.prime();
        state.watcher.start();
        return { ok: true, action: 'start', running: true, message: '已开启自动监视' };
      }
      if (action === 'stop') {
        state.watcher?.stop();
        return { ok: true, action: 'stop', running: false, message: '已暂停自动监视（手动 reload 仍可用）' };
      }
      return { ok: false, action, message: `未知 action：${action}` };
    },
  };

  const disposers = [];
  disposers.push(ctx.tools.register(toolApi));

  // ------------------------------------------------------- 服务（供其它插件）
  const service = {
    status: () => statusReport(),
    check: () => toolApi.execute({ action: 'check' }),
    reload: (options = {}) => reloadNow(options),
    roots: () => [...state.roots],
    stats: () => ({ ...state.watcher?.stats }),
    onChange: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  try {
    if (typeof ctx.provide === 'function') disposers.push(ctx.provide('liveReload', service));
  } catch (error) {
    log('warn', 'live-reload: 注册 liveReload 服务失败', error);
  }

  // ------------------------------------------------------------- Web 界面刷新
  const webServer = (() => {
    try {
      return ctx.get('webServer', false) ?? ctx.get('webserver', false) ?? null;
    } catch {
      return null;
    }
  })();

  if (webServer && config.refreshUi !== 'never') {
    const script = renderClientScript({ path: config.uiPath, pollMs: config.uiPollMs, mode: config.refreshUi });
    try {
      disposers.push(
        webServer.register({
          kind: 'prefix',
          path: config.uiPath,
          handler: (req, res) => {
            let pathname = '/';
            try {
              pathname = new URL(req?.url ?? '/', 'http://localhost').pathname;
            } catch {
              pathname = String(req?.url ?? '/');
            }
            const tail = pathname.slice(config.uiPath.length).replace(/\/+$/, '');
            if (tail === '/state' || tail === '') {
              ui.clients += 1;
              const payload = JSON.stringify({ ...uiState.snapshot(), startedAt: state.startedAt, roots: state.roots.length });
              res.writeHead?.(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
              });
              res.end?.(payload);
              return;
            }
            if (tail === '/reload') {
              reloadNow({ reason: 'ui' })
                .then((result) => {
                  res.writeHead?.(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
                  res.end?.(JSON.stringify({ ok: Boolean(result?.ok), message: result?.message ?? '' }));
                })
                .catch((error) => {
                  res.writeHead?.(500, { 'Content-Type': 'application/json; charset=utf-8' });
                  res.end?.(JSON.stringify({ ok: false, message: String(error?.message ?? error) }));
                });
              return;
            }
            res.writeHead?.(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end?.('not found');
          },
        }),
      );
      disposers.push(webServer.tapIndex((html) => injectIntoIndex(html, script)));
      ui.enabled = true;
      ui.injected = true;
    } catch (error) {
      ui.enabled = false;
      log('warn', 'live-reload: 无法挂载界面刷新端点', error);
    }
  }

  // ------------------------------------------------------------------- 启动
  state.ready = bootstrap().catch((error) => {
    state.lastError = String(error?.message ?? error);
    log('warn', 'live-reload: 初始化失败', error);
  });

  const cleanup = () => {
    try {
      state.watcher?.stop();
    } catch {
      /* ignore */
    }
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
  };
  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', cleanup);
  } catch {
    /* ignore */
  }

  return cleanup;
}
