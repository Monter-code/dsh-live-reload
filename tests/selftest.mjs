/**
 * dsh-live-reload —— 自检脚本（零测试依赖，Node 直跑）
 *   node tests/selftest.mjs
 *
 * 覆盖五类风险点：
 *  A. 监视逻辑：忽略规则、目录指纹扫描、差异比较——错了会误重载或漏重载。
 *  B. 根目录发现：profile 的 link: 依赖解析、去重、排除、包名读取。
 *  C. 重载内核：清模块缓存的边界、entry 匹配、以及最关键的「先删 registry 再 apply」
 *     顺序（顺序错了会被 Loader 把 entry 写成 disabled，插件从此不再加载）。
 *  D. 轮询监视器：首次基线不触发、变更才触发、去抖合批、换根目录重建基线。
 *  E. 界面刷新：rev 递增、注入脚本、index.html 注入位置。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeEntry, isUnder, matchCacheKey, normalizePath, pickEntries, purgeModuleCaches, reloadEntry, resolveEntryFile, urlToPathSafe } from '../lib/reloader.mjs';
import { collectWatchRoots, linkTargetsFromManifest, packageNameOf } from '../lib/roots.mjs';
import { DEFAULT_IGNORE, diffSnapshots, diffRootSnapshots, scanRoot, scanRoots, shouldIgnore } from '../lib/snapshot.mjs';
import { createUiState, injectIntoIndex, renderClientScript } from '../lib/ui.mjs';
import { createWatcher } from '../lib/watcher.mjs';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const tempDirs = [];
async function makeTemp(prefix = 'dshr-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 造一个「形状与真实宿主一致」的假宿主，用来验证 reloadEntry 的调用顺序。 */
function makeHost({ importImpl, applyThrowsFor, noInternal = false } = {}) {
  const events = [];
  const specifiers = [];
  let counter = 0;
  const registry = {
    records: new Map(),
    get(plugin) {
      return this.records.get(plugin);
    },
    delete(plugin) {
      events.push(`delete:${plugin.id}`);
      this.records.delete(plugin);
    },
    plugin(plugin) {
      events.push(`apply:${plugin.id}`);
      if (applyThrowsFor && plugin.id === applyThrowsFor) throw new Error('apply exploded');
      const fiber = {
        uid: (counter += 1),
        runtime: { callback: plugin },
        parent: null,
        await: async () => {},
        dispose: async () => {},
      };
      fiber.parent = { registry };
      this.records.set(plugin, { fibers: [fiber] });
      return { ctx: { fiber } };
    },
  };

  const oldPlugin = { id: 'old' };
  const freshPlugin = { id: 'fresh' };
  const oldFiber = {
    uid: 1,
    runtime: { callback: oldPlugin },
    parent: { registry },
    await: async () => {
      events.push('await-old-fiber');
    },
  };
  registry.records.set(oldPlugin, { fibers: [oldFiber] });

  const entry = {
    options: { id: 'demo', name: 'demo-plugin', config: { flag: true } },
    fiber: oldFiber,
    getOuterStack: () => () => [],
    parent: {
      ctx: { registry },
      tree: {
        import: async (specifier) => {
          specifiers.push(specifier);
          events.push('import');
          if (importImpl) return importImpl();
          return { default: freshPlugin };
        },
      },
    },
  };

  const loadCache = new Map();
  const loader = {
    internal: noInternal ? undefined : { loadCache },
    unwrapExports: (exports) => exports?.default ?? exports,
    await: async () => {
      events.push('loader-await');
    },
  };
  const ctx = { get: (name) => (name === 'loader' ? loader : undefined) };
  return { entry, ctx, loader, loadCache, events, specifiers, oldPlugin, freshPlugin, oldFiber, registry };
}

section('A. 忽略规则 / 指纹扫描 / 差异比较');
await test('shouldIgnore：目录段精确匹配、通配符匹配文件名', () => {
  assert.equal(shouldIgnore('node_modules/foo/index.js'), true);
  assert.equal(shouldIgnore('src/.git/config'), true);
  assert.equal(shouldIgnore('lib/index.js'), false);
  assert.equal(shouldIgnore('build.log'), true, '通配符 *.log 应命中文件名');
  assert.equal(shouldIgnore('src/notes/log.md'), false, '目录名不叫 *.log 就不该命中');
  assert.equal(shouldIgnore('distribution/a.js'), false, 'dist 不该命中 distribution');
});

await test('scanRoot 统计嵌套文件，忽略 node_modules 与 *.log', async () => {
  const dir = await makeTemp();
  await mkdir(join(dir, 'lib'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(dir, 'lib', 'a.mjs'), 'export const a = 1;\n');
  await writeFile(join(dir, 'lib', 'b.mjs'), 'export const b = 2;\n');
  await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(dir, 'debug.log'), 'noise\n');
  const snap = await scanRoot(dir, { ignore: DEFAULT_IGNORE });
  assert.deepEqual([...snap.files.keys()].sort(), ['lib/a.mjs', 'lib/b.mjs']);
  assert.equal(snap.truncated, false);
  assert.equal(snap.count, 2);
});

await test('scanRoot 对不存在的目录不抛异常，只记 error', async () => {
  const snap = await scanRoot(join(tmpdir(), `dshr-not-exists-${Date.now()}`));
  assert.equal(snap.count, 0);
  assert.ok(typeof snap.error === 'string' && snap.error.length > 0);
});

await test('diffSnapshots 分辨 changed / added / removed', async () => {
  const dir = await makeTemp();
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'lib', 'keep.mjs'), 'export const k = 1;\n');
  await writeFile(join(dir, 'lib', 'edit.mjs'), 'export const e = 1;\n');
  await writeFile(join(dir, 'lib', 'gone.mjs'), 'export const g = 1;\n');
  const before = await scanRoot(dir);
  await writeFile(join(dir, 'lib', 'edit.mjs'), 'export const e = 2222222;\n');
  await rm(join(dir, 'lib', 'gone.mjs'));
  await writeFile(join(dir, 'lib', 'fresh.mjs'), 'export const f = 1;\n');
  const after = await scanRoot(dir);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.changed.sort(), ['lib/edit.mjs']);
  assert.deepEqual(diff.added, ['lib/fresh.mjs']);
  assert.deepEqual(diff.removed, ['lib/gone.mjs']);
  assert.equal(diff.total, 3);
});

await test('diffRootSnapshots 只报变化的根目录', async () => {
  const a = await makeTemp();
  const b = await makeTemp();
  await writeFile(join(a, 'x.mjs'), 'export const x = 1;\n');
  await writeFile(join(b, 'y.mjs'), 'export const y = 1;\n');
  const before = await scanRoots([a, b]);
  await writeFile(join(b, 'y.mjs'), 'export const y = 200000;\n');
  const after = await scanRoots([a, b]);
  const touched = diffRootSnapshots(before, after);
  assert.equal(touched.length, 1);
  assert.equal(touched[0].root, b);
  assert.deepEqual(touched[0].changed, ['y.mjs']);
});

section('B. 根目录发现');
await test('linkTargetsFromManifest 只认 link: 依赖，相对路径按 profile 目录解析', () => {
  const manifest = {
    dependencies: {
      'dsh-image-insight': 'link:D:/test-dsh/dsh-image-insight',
      'dsh-live-reload': 'link:../dsh-live-reload',
      semver: '^7.0.0',
    },
  };
  const profileDir = 'D:/test-dsh/profile';
  const targets = linkTargetsFromManifest(manifest, profileDir);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].name, 'dsh-image-insight');
  assert.match(targets[0].dir.replace(/\\/g, '/'), /^D:\/test-dsh\/dsh-image-insight$/);
  assert.match(targets[1].dir.replace(/\\/g, '/'), /dsh-live-reload$/);
});

await test('collectWatchRoots 去重、可排除、带上来源', async () => {
  const profileDir = 'D:/test-dsh/profile';
  const { roots, sources } = await collectWatchRoots({
    profileDir,
    linkTargets: [
      { name: 'a', dir: 'D:/test-dsh/plugins/a' },
      { name: 'b', dir: 'D:/test-dsh/plugins/a' },
    ],
    extraWatch: ['D:/test-dsh/extra'],
    exclude: ['D:/test-dsh/plugins/skip'],
  });
  assert.equal(roots.length, 2, '重复目录只留一个');
  assert.equal(roots[0], 'D:/test-dsh/plugins/a');
  assert.equal(roots[1].replace(/\\/g, '/'), 'D:/test-dsh/extra');
  assert.equal(sources['d:/test-dsh/plugins/a'], 'a');
  assert.equal(sources['d:/test-dsh/extra'], 'watch');
});

await test('packageNameOf 读取插件目录的包名，坏目录返回 undefined', async () => {
  const dir = await makeTemp('dshr-pkg-');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo-plugin' }));
  assert.equal(await packageNameOf(dir), 'demo-plugin');
  const broken = await makeTemp('dshr-pkg-bad-');
  await writeFile(join(broken, 'package.json'), '{ not json');
  assert.equal(await packageNameOf(broken), undefined);
  assert.equal(await packageNameOf(join(tmpdir(), 'dshr-missing-dir')), undefined);
});

section('C. 重载内核');
await test('normalizePath / isUnder 跨平台判定', () => {
  assert.equal(normalizePath('D:\\test-dsh\\Plugin\\'), 'd:/test-dsh/plugin');
  assert.equal(isUnder('D:\\test-dsh\\p\\lib\\a.mjs', 'D:/test-dsh/p'), true);
  assert.equal(isUnder('D:/test-dsh/p', 'D:/test-dsh/p'), true);
  assert.equal(isUnder('D:/test-dsh/pp/a.mjs', 'D:/test-dsh/p'), false, '不能把前缀相同的兄弟目录算进去');
  assert.equal(isUnder('', 'D:/x'), false);
});

await test('urlToPathSafe 处理 file URL、查询串与非 file 输入', () => {
  assert.equal(urlToPathSafe('file:///D:/x/a.mjs').replace(/\\/g, '/'), 'D:/x/a.mjs');
  assert.equal(urlToPathSafe('file:///D:/x/a.mjs?dshr=3').replace(/\\/g, '/'), 'D:/x/a.mjs');
  assert.equal(urlToPathSafe('node:fs'), 'node:fs');
});

await test('purgeModuleCaches 只删监视根下的 ESM/CJS 条目', () => {
  const hit = 'file:///D:/test-dsh/demo/lib/index.js';
  const miss = 'file:///D:/other/keep.js';
  const loadCache = new Map([
    [hit, { module: {} }],
    [miss, { module: {} }],
  ]);
  const result = purgeModuleCaches({ internal: { loadCache } }, ['D:\\test-dsh\\demo']);
  assert.deepEqual(result.esm, [hit]);
  assert.equal(loadCache.has(hit), false);
  assert.equal(loadCache.has(miss), true, '监视范围外的模块不能动');
  const empty = purgeModuleCaches({}, ['D:/x']);
  assert.equal(empty.esm.length, 0);
  assert.ok(empty.skipped.length > 0, '没有 loadCache 时要记 skipped');
});

// 真机回归：`link:` 装入的插件在宿主里的模块键是 profile 的 junction 路径，
// 与配置里监视的真实目录字面对不上。旧版只用前缀比较 → 一条都删不到 →
// 重新 import 拿回旧模块 →「报告成功但代码没换」。
await test('purgeModuleCaches 认得 junction 路径与被监视目录的对应关系', () => {
  const junctionKey = 'file:///C:/Users/x/.dsh/profiles/headless/node_modules/dsh-lr-victim/lib/index.js';
  const bareKey = 'dsh-lr-victim';
  const unrelated = 'file:///C:/Users/x/.dsh/profiles/headless/node_modules/other-thing/lib/index.js';
  const loadCache = new Map([
    [junctionKey, {}],
    [bareKey, {}],
    [unrelated, {}],
  ]);
  const result = purgeModuleCaches({ internal: { loadCache } }, ['D:/test-dsh/experiments/lr-victim'], {
    packages: ['dsh-lr-victim'],
  });
  assert.deepEqual(result.esm.sort(), [bareKey, junctionKey].sort());
  assert.equal(loadCache.has(unrelated), true, '无关插件不能误删');
  assert.equal(result.strategies.hint, 2, '两个键都应通过 hint 策略命中');
});

await test('matchCacheKey 的策略判定与 realpath 穿透', () => {
  const index = { roots: ['d:/test-dsh/experiments/lr-victim'], hints: ['d:/test-dsh/experiments/lr-victim', 'lr-victim', 'dsh-lr-victim'] };
  assert.equal(matchCacheKey('file:///D:/test-dsh/experiments/lr-victim/lib/index.js', index), 'under');
  assert.equal(matchCacheKey('C:\\Users\\x\\.dsh\\profiles\\headless\\node_modules\\dsh-lr-victim\\lib\\index.js', index), 'hint');
  assert.equal(matchCacheKey('D:/test-dsh/experiments/other/lib/a.js', index), null);
  assert.equal(matchCacheKey('', index), null);
});

await test('resolveEntryFile 认出 file URL / 绝对路径 / profile 解析', async () => {
  const dir = await makeTemp('dshr-profile-');
  const pkgDir = join(dir, 'node_modules', 'demo-plugin');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', main: 'index.js' }));
  await writeFile(join(pkgDir, 'index.js'), 'export const a = 1;\n');
  const resolved = resolveEntryFile('demo-plugin', dir);
  assert.ok(resolved && resolved.endsWith('index.js'), `应解析到 index.js，实际 ${resolved}`);
  assert.equal(resolveEntryFile('file:///D:/x/y.js', dir).replace(/\\/g, '/'), 'D:/x/y.js');
  assert.equal(resolveEntryFile('D:\\x\\y.js', dir), 'D:\\x\\y.js');
  assert.equal(resolveEntryFile('no-such-plugin-xyz', dir), undefined);
  assert.equal(resolveEntryFile('', dir), undefined);
});

await test('reloadEntry：清不掉任何缓存时退化为「带版本号重新导入」', async () => {
  const dir = await makeTemp('dshr-profile-');
  const pkgDir = join(dir, 'node_modules', 'demo-plugin');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', main: 'index.js' }));
  const file = join(pkgDir, 'index.js');
  await writeFile(file, 'export const a = 1;\n');
  const host = makeHost({ noInternal: true });
  const result = await reloadEntry(host.entry, host.ctx, { purgeRoots: ['D:/test-dsh/experiments/lr-victim'], profileDir: dir });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'bust');
  assert.equal(result.cacheEmpty, true);
  assert.match(host.specifiers[0], /index\.js\?dshlr=/, `应带上破缓存查询串，实际 ${host.specifiers[0]}`);
  assert.deepEqual(host.events, ['import', 'delete:old', 'await-old-fiber', 'apply:fresh', 'loader-await']);
});

await test('pickEntries 支持包名、包名子路径、目录前缀与子串过滤', () => {
  const entries = [
    { options: { id: '1', name: 'demo-plugin' } },
    { options: { id: '2', name: 'demo-plugin/tools' } },
    { options: { id: '3', name: 'D:/test-dsh/demo/lib/index.js' } },
    { options: { id: '4', name: 'other-plugin' } },
    { options: { id: '5', name: '' } },
  ];
  const byName = pickEntries(entries, { names: ['demo-plugin'] }).map((e) => e.options.id);
  assert.deepEqual(byName, ['1', '2']);
  const byRoot = pickEntries(entries, { roots: ['D:/test-dsh/demo'] }).map((e) => e.options.id);
  assert.deepEqual(byRoot, ['3']);
  const byTarget = pickEntries(entries, { targets: ['other'] }).map((e) => e.options.id);
  assert.deepEqual(byTarget, ['4']);
  assert.deepEqual(pickEntries(entries, {}), []);
});

await test('describeEntry 汇报 entry 状态', () => {
  const info = describeEntry({ options: { id: 'x', name: 'demo', disabled: false }, fiber: { uid: 7, state: 5 } });
  assert.deepEqual(info, { id: 'x', name: 'demo', disabled: false, loaded: true, uid: 7, state: 5 });
  assert.equal(describeEntry({ options: {} }).loaded, false);
});

await test('reloadEntry：先删 registry 旧 plugin → 等旧 fiber → 再 apply 新模块', async () => {
  const host = makeHost();
  const result = await reloadEntry(host.entry, host.ctx, { purgeRoots: ['D:/test-dsh/demo'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.name, 'demo-plugin');
  assert.deepEqual(host.events, ['import', 'delete:old', 'await-old-fiber', 'apply:fresh', 'loader-await']);
  assert.notEqual(host.entry.fiber, host.oldFiber, 'entry.fiber 必须指向新 fiber');
  assert.equal(host.registry.get(host.freshPlugin).fibers[0], host.entry.fiber);
  assert.equal(host.registry.get(host.oldPlugin), undefined, '旧 plugin 必须从 registry 移除');
});

await test('reloadEntry：新模块 import 失败时不动正在运行的插件', async () => {
  const host = makeHost({ importImpl: () => { throw new Error('syntax error in new code'); } });
  const result = await reloadEntry(host.entry, host.ctx, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'import-failed');
  assert.deepEqual(host.events, ['import'], '失败时不能删旧插件');
  assert.equal(host.entry.fiber, host.oldFiber);
  assert.ok(host.registry.get(host.oldPlugin));
});

await test('reloadEntry：新模块 apply 抛错时回滚旧插件', async () => {
  const host = makeHost({ applyThrowsFor: 'fresh' });
  const result = await reloadEntry(host.entry, host.ctx, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'apply-failed');
  assert.equal(result.rolledBack, true);
  assert.deepEqual(host.events, ['import', 'delete:old', 'await-old-fiber', 'apply:fresh', 'apply:old']);
  assert.equal(host.entry.fiber.runtime.callback, host.oldPlugin, '回滚后 entry.fiber 必须挂回旧插件');
});

await test('reloadEntry：缺 name / 未加载 / 无 loader 时都给出明确 reason', async () => {
  const host = makeHost();
  assert.equal((await reloadEntry({ options: {} }, host.ctx)).reason, 'entry-has-no-name');
  assert.equal((await reloadEntry({ options: { name: 'x' } }, host.ctx)).reason, 'entry-not-loaded');
  assert.equal((await reloadEntry(host.entry, { get: () => undefined })).reason, 'loader-unavailable');
});

section('D. 轮询监视器');
await test('prime 后未改动不触发；改动后 checkNow 报出该文件', async () => {
  const dir = await makeTemp('dshr-watch-');
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(join(dir, 'lib', 'a.mjs'), 'export const a = 1;\n');
  const batches = [];
  const watcher = createWatcher({
    roots: [dir],
    pollMs: 150,
    debounceMs: 50,
    onReload: (touched) => {
      batches.push(touched);
    },
  });
  await watcher.prime();
  assert.deepEqual(await watcher.checkNow(), [], '没有改动就不该报告变更');
  await writeFile(join(dir, 'lib', 'a.mjs'), 'export const a = 2222222;\n');
  const touched = await watcher.checkNow();
  assert.equal(touched.length, 1);
  assert.deepEqual(touched[0].changed, ['lib/a.mjs']);
  assert.deepEqual(await watcher.checkNow(), [], '第二次不该重复报告');
  watcher.stop();
  assert.equal(batches.length, 0, 'checkNow 不直接触发重载');
});

await test('start 后自动发现变更并去抖合批触发一次', async () => {
  const dir = await makeTemp('dshr-watch-auto-');
  await writeFile(join(dir, 'a.mjs'), 'export const a = 1;\n');
  const batches = [];
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const watcher = createWatcher({
    roots: [dir],
    pollMs: 120,
    debounceMs: 60,
    onReload: (touched) => {
      batches.push(touched);
      resolveFirst?.();
      // 返回「真正被重载的插件个数」：watcher 用它累计统计，不再每次去抖都 +1。
      return 2;
    },
  });
  await watcher.prime();
  watcher.start();
  await writeFile(join(dir, 'a.mjs'), 'export const a = 2;\n');
  await writeFile(join(dir, 'b.mjs'), 'export const b = 1;\n');
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 3000))]);
  watcher.stop();
  assert.equal(batches.length, 1, `去抖后应只触发一次，实际 ${batches.length}`);
  const files = [...batches[0][0].changed, ...batches[0][0].added].sort();
  assert.deepEqual(files, ['a.mjs', 'b.mjs']);
  assert.equal(watcher.stats.reloads, 2, `统计应等于回调返回的重载个数，实际 ${watcher.stats.reloads}`);
});

await test('onReload 报告 0 个插件时不计入 reloads（豁免目录/匹配不到 entry）', async () => {
  const dir = await makeTemp('dshr-watch-zero-');
  await writeFile(join(dir, 'a.mjs'), 'export const a = 1;\n');
  let calls = 0;
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const watcher = createWatcher({
    roots: [dir],
    pollMs: 120,
    debounceMs: 60,
    onReload: () => {
      calls += 1;
      resolveFirst?.();
      return 0;
    },
  });
  await watcher.prime();
  watcher.start();
  await writeFile(join(dir, 'a.mjs'), 'export const a = 2;\n');
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 3000))]);
  watcher.stop();
  assert.equal(calls, 1, '变更应触发一次回调');
  assert.ok(watcher.stats.triggers >= 1, '触发次数照常统计');
  assert.equal(watcher.stats.reloads, 0, `没有插件被换掉就不该记重载，实际 ${watcher.stats.reloads}`);
});

await test('setRoots 重建基线，不会把新目录里的旧文件当变更', async () => {
  const a = await makeTemp('dshr-watch-a-');
  const b = await makeTemp('dshr-watch-b-');
  await writeFile(join(a, 'a.mjs'), 'export const a = 1;\n');
  await writeFile(join(b, 'b.mjs'), 'export const b = 1;\n');
  const watcher = createWatcher({ roots: [a], pollMs: 120, debounceMs: 40, onReload: () => {} });
  await watcher.prime();
  await watcher.setRoots([a, b]);
  assert.deepEqual(watcher.roots, [a, b]);
  assert.deepEqual(await watcher.checkNow(), [], '新加入的目录必须先建立基线');
  watcher.stop();
});

section('E. 界面刷新');
await test('createUiState 每次 bump 递增 rev 并记录插件名', () => {
  const state = createUiState();
  assert.equal(state.rev, 0);
  assert.equal(state.snapshot().rev, 0);
  assert.equal(state.bump([{ name: 'demo' }]), 1);
  assert.equal(state.bump([{ name: 'demo2' }]), 2);
  const snap = state.snapshot();
  assert.equal(snap.rev, 2);
  assert.deepEqual(snap.items, [{ name: 'demo2' }]);
});

await test('renderClientScript 里含端点、轮询间隔与刷新模式', () => {
  const script = renderClientScript({ path: '/__dsh-live-reload', pollMs: 1200, mode: 'auto' });
  assert.ok(script.startsWith('<script>') && script.trimEnd().endsWith('</script>'));
  assert.ok(script.includes('"/__dsh-live-reload/state"'));
  assert.ok(script.includes('var POLL = 1200'));
  assert.ok(script.includes('var MODE = "idle"'), 'auto 应归一化成 idle');
  assert.ok(!script.includes('</script>\n<script'), '脚本内部不能出现提前闭合');
});

await test('injectIntoIndex 插到 </body> 前，没有 body 就追加', () => {
  const script = '<script>x</script>';
  const withBody = injectIntoIndex('<html><body><div/></body></html>', script);
  assert.equal(withBody, `<html><body><div/>${script}\n</body></html>`);
  const withoutBody = injectIntoIndex('<html><div/></html>', script);
  assert.ok(withoutBody.endsWith(script));
  assert.equal(injectIntoIndex('', script), '');
});

for (const dir of tempDirs) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${failed === 0 ? '✅' : '❌'} selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.error(`- ${item.name}: ${item.error?.stack ?? item.error}`);
  process.exitCode = 1;
}
