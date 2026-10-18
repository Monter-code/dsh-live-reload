/**
 * dsh-live-reload —— 集成测试（零依赖，Node 直跑）
 *   node tests/integration.mjs
 *
 * 与 selftest 的分工：selftest 验证纯逻辑与调用顺序；这里用「形状与真实宿主一致」的
 * 假宿主把插件真正 apply 起来，跑完整链路：
 *   apply → 注册工具 → status/check/reload/roots/start/stop → 改磁盘文件 → 自动重载
 *   → 界面端点与注入脚本 → 事件通知其它插件。
 * 并额外用最小 JSON Schema 校验器守住宿主那道「无损 JSON + 严格校验」的关卡。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { apply } from '../lib/index.js';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ 最小校验器 */

function validate(schema, value, path = 'value') {
  if (!schema || typeof schema !== 'object') return;
  const type = schema.type;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type && actual !== type) throw new Error(`${path}: 期望 ${type}，实际 ${actual}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path}: ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)} 里`);
  }
  if (type === 'object') {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new Error(`${path}.${key}: 缺少必填字段`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!(key in props)) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${key}: schema 未声明该字段`);
        continue;
      }
      validate(props[key], item, `${path}.${key}`);
    }
  }
  if (type === 'array' && schema.items) {
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
  }
}

/* --------------------------------------------------------------- 假宿主工厂 */

function makeFakeHost({ pluginDir, profileDir, entryName = 'demo-plugin', extraEntries = [], importImpl, noInternal = false } = {}) {
  const events = [];
  const specifiers = [];
  const modules = { old: { id: 'old', apply() {} }, fresh: { id: 'fresh', apply() {} } };
  const oldPlugin = modules.old;
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
      if (plugin.__throws) throw new Error('apply exploded');
      const fiber = { uid: 90 + this.records.size, runtime: { callback: plugin }, parent: null, await: async () => {} };
      fiber.parent = { registry };
      this.records.set(plugin, { fibers: [fiber] });
      return { ctx: { fiber } };
    },
  };
  const oldFiber = {
    uid: 1,
    runtime: { callback: oldPlugin },
    parent: { registry },
    await: async () => {
      events.push('await-old');
    },
  };
  registry.records.set(oldPlugin, { fibers: [oldFiber] });

  const makeEntry = (name) => {
    const fiber = {
      uid: 1,
      runtime: { callback: oldPlugin },
      parent: { registry },
      await: async () => {
        events.push('await-old');
      },
    };
    return {
      options: { id: name, name, config: { from: name }, disabled: false },
      fiber,
      getOuterStack: () => () => [],
      parent: {
        ctx: { registry },
        tree: {
          import: async (specifier) => {
            events.push('import');
            specifiers.push(specifier);
            if (importImpl) return importImpl(name);
            return { default: modules.fresh };
          },
        },
      },
    };
  };

  const entry = makeEntry(entryName);
  const entries = [entry, ...extraEntries.map((item) => makeEntry(item.name))];
  const loadCache = new Map();
  if (pluginDir) loadCache.set(pathToFileURL(join(pluginDir, 'index.mjs')).href, { module: {} });

  const loader = {
    internal: noInternal ? undefined : { loadCache },
    unwrapExports: (exports) => exports?.default ?? exports,
    await: async () => {
      events.push('loader-await');
    },
    *entries() {
      yield* entries;
    },
  };

  const registered = [];
  const provided = new Map();
  const webRoutes = [];
  const indexTaps = [];
  const lifecycle = [];
  const webServer = {
    register(route) {
      webRoutes.push(route);
      return () => {};
    },
    tapIndex(transform) {
      indexTaps.push(transform);
      return () => {};
    },
  };

  const ctx = {
    baseUrl: profileDir ? pathToFileURL(`${profileDir}\\`).href : undefined,
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    // 复刻 cordis 的延迟注入：依赖就绪后回调拿到 sub 上下文；sub.effect 立即执行并返回清理器。
    inject(deps, callback) {
      const sub = {
        ...ctx,
        webServer: deps.includes('webServer') ? webServer : undefined,
        effect(fn) {
          const dispose = fn();
          return () => {
            try {
              dispose?.();
            } catch {
              /* ignore */
            }
          };
        },
      };
      callback(sub);
      return { dispose() {} };
    },
    get(name) {
      if (name === 'loader') return loader;
      return undefined;
    },
    provide(name, value) {
      provided.set(name, value);
      return () => {};
    },
    on(event, handler) {
      lifecycle.push({ event, handler });
      return () => {};
    },
    logger: () => ({ info() {}, warn() {}, error() {} }),
  };

  return { ctx, loader, entry, entries, registry, events, specifiers, registered, provided, webRoutes, indexTaps, modules, oldPlugin, loadCache, webServer, lifecycle };
}

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'dshlr-'));
  const profileDir = join(root, 'profile');
  const pluginDir = join(root, 'demo-plugin');
  await mkdir(profileDir, { recursive: true });
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'fake-profile',
      private: true,
      dependencies: { 'demo-plugin': `link:${pluginDir.replace(/\\/g, '/')}`, semver: '^7.0.0' },
    }),
  );
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', main: 'index.mjs' }));
  await writeFile(join(pluginDir, 'index.mjs'), 'export default () => ({ version: 1 });\n');
  // 真实 profile 里 `link:` 依赖会被装成 node_modules 下的 junction；这里同样造一个，
  // 好让「缓存清不掉时的兜底重新导入」能按 profile 的解析规则找到插件文件。
  await mkdir(join(profileDir, 'node_modules'), { recursive: true });
  try {
    await symlink(pluginDir, join(profileDir, 'node_modules', 'demo-plugin'), 'junction');
  } catch {
    /* 某些环境不允许建 junction：相关用例会自行跳过断言 */
  }
  return { root, profileDir, pluginDir };
}

function makeReqRes(url) {
  const captured = { status: 0, headers: null, body: '' };
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(body) {
      captured.body = body ?? '';
    },
  };
  return { req: { url }, res, captured };
}

const cleanups = [];

async function callTool(host, args) {
  const tool = host.registered.find((item) => item.name === 'live_reload');
  assert.ok(tool, 'live_reload 工具应已注册');
  const value = await tool.execute(args, {});
  const detached = JSON.parse(JSON.stringify(value));
  validate(tool.output.schema, detached);
  const content = tool.output.render(args, detached);
  assert.ok(Array.isArray(content) && content.length > 0, 'output.render 必须返回 ContentBlock[]');
  return { value: detached, content, tool };
}

/* -------------------------------------------------------------------- 用例 */

const space = await makeWorkspace();
cleanups.push(space.root);

section('1. 插件挂载与工具契约');
const host = makeFakeHost({ pluginDir: space.pluginDir, profileDir: space.profileDir });
const dispose = apply(host.ctx, { pollMs: 200, debounceMs: 60, autoWatch: false });
await sleep(250);

await test('apply 返回 cleanup，注册了 live_reload 工具与 liveReload 服务', () => {
  assert.equal(typeof dispose, 'function');
  const tool = host.registered.find((item) => item.name === 'live_reload');
  assert.ok(tool, 'live_reload 未注册');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(typeof tool.presentCall, 'function');
  assert.equal(typeof tool.presentResult, 'function');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.output.schema.type, 'object');
  assert.equal(tool.output.schema.additionalProperties, false);
  assert.ok(host.provided.has('liveReload'), 'liveReload 服务未 provide');
  assert.ok(host.lifecycle.some((item) => item.event === 'dispose'), '应挂 dispose 清理');
});

await test('工具渲染：render 返回 TextBlock，presentCall/presentResult 返回 generic 卡片', async () => {
  const { content, tool } = await callTool(host, { action: 'status' });
  assert.equal(content[0].type, 'text');
  assert.ok(content[0].text.includes('热重载'));
  const call = tool.presentCall({ action: 'status' });
  assert.equal(call.card, 'generic');
  const view = tool.presentResult({ action: 'status' }, { content });
  assert.equal(view.card, 'generic');
  assert.deepEqual(view.content, content);
});

section('2. 目录发现与状态');
await test('status：识别 link: 插件目录、包名与对应 entry', async () => {
  const { value } = await callTool(host, { action: 'status' });
  assert.equal(value.ok, true);
  assert.equal(value.roots.length, 1, JSON.stringify(value.roots));
  assert.match(value.roots[0].dir.replace(/\\/g, '/'), /demo-plugin$/);
  assert.equal(value.roots[0].package, 'demo-plugin');
  assert.equal(value.config.autoWatch, false);
  assert.equal(value.running, false);
  assert.ok(value.entries.some((item) => item.name === 'demo-plugin' && item.watched));
});

await test('roots：列出被监视目录，并给出配置提示', async () => {
  const { value } = await callTool(host, { action: 'roots' });
  assert.equal(value.action, 'roots');
  assert.equal(value.roots.length, 1);
  assert.ok(value.hint.length > 0);
});

await test('check：磁盘无改动时不重载', async () => {
  const { value } = await callTool(host, { action: 'check' });
  assert.equal(value.ok, true);
  assert.deepEqual(value.touched, []);
  assert.equal(host.events.length, 0, '不该有任何重载动作');
});

section('3. 热重载主链路');
await test('check：改动源码后按「import → 删旧 → 等旧 fiber → apply 新」重载', async () => {
  await writeFile(join(space.pluginDir, 'index.mjs'), 'export default () => ({ version: 2 });\n');
  const { value } = await callTool(host, { action: 'check' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.ok(value.touched.length === 1, '应报告一个目录的变更');
  assert.deepEqual(value.touched[0].changed, ['index.mjs']);
  assert.equal(value.reloaded.length, 1);
  assert.equal(value.reloaded[0].name, 'demo-plugin');
  assert.equal(value.reloaded[0].ok, true);
  assert.equal(value.reloaded[0].esmPurged, 1, '应清掉该目录下 1 个 ESM 缓存条目');
  assert.deepEqual(host.events, ['import', 'delete:old', 'await-old', 'apply:fresh', 'loader-await']);
  assert.equal(host.loadCache.size, 0, '缓存条目应被清掉');
  assert.equal(host.entry.fiber.runtime.callback.id, 'fresh', 'entry.fiber 应指向新模块');
});

await test('check：没有新改动时第二次不再重载', async () => {
  host.events.length = 0;
  const { value } = await callTool(host, { action: 'check' });
  assert.equal(value.ok, true);
  assert.deepEqual(value.touched, []);
  assert.equal(host.events.length, 0);
});

await test('reload：手动重载可以指定 target，并忽略 disabled 状态', async () => {
  host.events.length = 0;
  const { value } = await callTool(host, { action: 'reload', target: 'demo', reason: 'manual-test' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.reloaded[0].ok, true);
  // 上一轮重载后 entry.fiber 指向的是上一轮的 fresh 模块，所以这次删掉的是它。
  assert.deepEqual(host.events, ['import', 'delete:fresh', 'apply:fresh', 'loader-await']);
});

await test('reload：target 不匹配时失败并给提示', async () => {
  const { value } = await callTool(host, { action: 'reload', target: 'not-a-plugin' });
  assert.equal(value.ok, false);
  assert.match(value.message, /not-a-plugin/);
  assert.ok(value.hint.includes('live_reload'));
});

section('4. 失败与危险路径');
await test('新模块 apply 抛错时回滚旧插件，entry.fiber 仍可用', async () => {
  const broken = makeFakeHost({
    pluginDir: space.pluginDir,
    profileDir: space.profileDir,
    importImpl: () => ({ default: { id: 'boom', __throws: true } }),
  });
  const stop = apply(broken.ctx, { autoWatch: false, pollMs: 200 });
  await sleep(200);
  const { value } = await callTool(broken, { action: 'reload', target: 'demo' });
  assert.equal(value.ok, false);
  assert.equal(value.reloaded[0].reason, 'apply-failed');
  assert.equal(value.reloaded[0].rolledBack, true);
  assert.equal(broken.entry.fiber.runtime.callback.id, 'old', '必须回滚到旧插件');
  stop();
});

await test('新模块 import 失败时不动正在运行的插件', async () => {
  const broken = makeFakeHost({
    pluginDir: space.pluginDir,
    profileDir: space.profileDir,
    importImpl: () => {
      throw new Error('SyntaxError: unexpected token');
    },
  });
  const stop = apply(broken.ctx, { autoWatch: false, pollMs: 200 });
  await sleep(200);
  const { value } = await callTool(broken, { action: 'reload', target: 'demo' });
  assert.equal(value.ok, false);
  assert.equal(value.reloaded[0].reason, 'import-failed');
  assert.deepEqual(broken.events, ['import']);
  assert.equal(broken.entry.fiber.runtime.callback.id, 'old');
  stop();
});

await test('没有 loader 服务时 status/reload 都不崩', async () => {
  const bare = makeFakeHost({ pluginDir: space.pluginDir, profileDir: space.profileDir });
  bare.ctx.get = () => undefined;
  const stop = apply(bare.ctx, { autoWatch: false, pollMs: 200 });
  await sleep(200);
  const status = await callTool(bare, { action: 'status' });
  assert.equal(status.value.ok, true);
  assert.deepEqual(status.value.entries, []);
  const reload = await callTool(bare, { action: 'reload' });
  assert.equal(reload.value.ok, false);
  stop();
});

await test('自身插件默认不被热重载，reloadSelf=true 才允许', async () => {
  const withSelf = makeFakeHost({
    pluginDir: space.pluginDir,
    profileDir: space.profileDir,
    extraEntries: [{ name: 'D:/x/dsh-live-reload/lib/index.js' }],
  });
  const stop1 = apply(withSelf.ctx, { autoWatch: false, reloadTargets: ['dsh-live-reload'], pollMs: 200 });
  await sleep(200);
  const blocked = await callTool(withSelf, { action: 'reload', target: 'dsh-live-reload' });
  assert.equal(blocked.value.ok, false, '默认必须跳过自身');
  stop1();

  const withSelf2 = makeFakeHost({
    pluginDir: space.pluginDir,
    profileDir: space.profileDir,
    extraEntries: [{ name: 'D:/x/dsh-live-reload/lib/index.js' }],
  });
  const stop2 = apply(withSelf2.ctx, { autoWatch: false, reloadSelf: true, reloadTargets: ['dsh-live-reload'], pollMs: 200 });
  await sleep(200);
  const allowed = await callTool(withSelf2, { action: 'reload', target: 'dsh-live-reload' });
  assert.equal(allowed.value.ok, true, JSON.stringify(allowed.value));
  assert.equal(allowed.value.reloaded.length, 1);
  stop2();
});

section('5. 自动监视与界面刷新');
await test('autoWatch：写盘后自动触发一次重载，并通知 onChange 订阅者', async () => {
  const auto = makeFakeHost({ pluginDir: space.pluginDir, profileDir: space.profileDir });
  const stop = apply(auto.ctx, { pollMs: 180, debounceMs: 60, autoWatch: true });
  const notices = [];
  auto.provided.get('liveReload').onChange((items) => notices.push(items));
  await sleep(250);
  auto.events.length = 0;
  await writeFile(join(space.pluginDir, 'index.mjs'), 'export default () => ({ version: 33 });\n');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && auto.events.length === 0) await sleep(80);
  assert.ok(auto.events.length > 0, '自动监视没有触发重载');
  const status = await callTool(auto, { action: 'status' });
  assert.ok(status.value.stats.reloads >= 1, JSON.stringify(status.value.stats));
  assert.ok(notices.length >= 1, 'onChange 订阅者应收到通知');
  assert.equal(notices[0][0].name, 'demo-plugin');
  stop();
});

await test('start/stop：可暂停与恢复自动监视', async () => {
  const { value: stopped } = await callTool(host, { action: 'stop' });
  assert.equal(stopped.running, false);
  const { value: started } = await callTool(host, { action: 'start' });
  assert.equal(started.running, true);
  await callTool(host, { action: 'stop' });
});

await test('界面：延迟注入后注册 prefix 路由、/state 返回 rev、/check 比对磁盘、/reload 触发重载', async () => {
  assert.equal(host.webRoutes.length, 1, '应通过 ctx.inject 拿到 webServer 并注册一条路由');
  assert.equal(host.webRoutes[0].kind, 'prefix');
  assert.equal(host.webRoutes[0].path, '/__dsh-live-reload');
  assert.equal(host.indexTaps.length, 0, '不再注入 index.html（桌面壳静态直出，tapIndex 无效）');

  const state = makeReqRes('/__dsh-live-reload/state');
  host.webRoutes[0].handler(state.req, state.res);
  const payload = JSON.parse(state.captured.body);
  assert.equal(state.captured.status, 200);
  assert.equal(typeof payload.rev, 'number');
  assert.ok(payload.rev >= 1, '之前的手动重载应推高 rev');
  assert.equal(payload.ui.mode, 'auto');
  assert.equal(payload.ui.enabled, true, '端点挂载后 ui.enabled 应为真');

  host.events.length = 0;
  const check = makeReqRes('/__dsh-live-reload/check');
  host.webRoutes[0].handler(check.req, check.res);
  const deadline0 = Date.now() + 3000;
  while (Date.now() < deadline0 && !check.captured.body) await sleep(50);
  assert.ok(check.captured.body, '/check 应有响应');
  assert.equal(JSON.parse(check.captured.body).ok, true);

  host.events.length = 0;
  const reload = makeReqRes('/__dsh-live-reload/reload');
  host.webRoutes[0].handler(reload.req, reload.res);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (!host.events.length || !reload.captured.body)) await sleep(50);
  assert.ok(host.events.length > 0, 'POST /reload 应触发一次重载');
  assert.equal(JSON.parse(reload.captured.body).ok, true);

  const unknown = makeReqRes('/__dsh-live-reload/nope');
  host.webRoutes[0].handler(unknown.req, unknown.res);
  assert.equal(unknown.captured.status, 404);
});

await test('界面：refreshUi=never 不注册路由', async () => {
  const silent = makeFakeHost({ pluginDir: space.pluginDir, profileDir: space.profileDir });
  const stop = apply(silent.ctx, { autoWatch: false, refreshUi: 'never' });
  await sleep(150);
  assert.equal(silent.webRoutes.length, 0);
  assert.equal(silent.indexTaps.length, 0);
  stop();
});

await test('cleanup：调用后停止监视并释放注册', async () => {
  const temp = makeFakeHost({ pluginDir: space.pluginDir, profileDir: space.profileDir });
  const stop = apply(temp.ctx, { pollMs: 180, debounceMs: 60, autoWatch: true });
  await sleep(200);
  assert.equal(temp.lifecycle.some((item) => item.event === 'dispose'), true);
  stop();
  await writeFile(join(space.pluginDir, 'index.mjs'), 'export default () => ({ version: 44 });\n');
  temp.events.length = 0;
  await sleep(500);
  assert.equal(temp.events.length, 0, 'cleanup 之后不该再自动重载');
});

await test('cache：诊断 action 报出缓存键与命中情况', async () => {
  const probeHost = makeFakeHost({ pluginDir: space.pluginDir, profileDir: space.profileDir });
  const stop = apply(probeHost.ctx, { autoWatch: false });
  await sleep(200);
  const { value } = await callTool(probeHost, { action: 'cache' });
  assert.equal(value.ok, true);
  assert.equal(value.action, 'cache');
  assert.equal(value.cache.hasInternal, true);
  assert.equal(value.cache.esmKeys, 1, JSON.stringify(value.cache));
  assert.equal(value.cache.matched.length, 1);
  assert.match(value.cache.matched[0], /demo-plugin/);
  assert.ok(value.hint.length > 0);
  stop();
});

section('6. 缓存清不掉时的兜底（真机回归：link: 的 junction 路径对不上监视目录）');
await test('cacheEmpty 时改用带版本号的重新导入，仍能 apply 新模块', async () => {
  const blind = makeFakeHost({ pluginDir: undefined, profileDir: space.profileDir, noInternal: true });
  const stop = apply(blind.ctx, { autoWatch: false });
  await sleep(200);
  const { value } = await callTool(blind, { action: 'reload', target: 'demo-plugin' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.reloaded[0].mode, 'bust');
  assert.equal(value.reloaded[0].cacheEmpty, true);
  assert.match(blind.specifiers[0], /index\.mjs\?dshlr=/);
  assert.deepEqual(blind.events, ['import', 'delete:old', 'await-old', 'apply:fresh', 'loader-await']);
  stop();
});

await test('渲染层会对「没清掉缓存」的插件给出显式警告', async () => {
  const blind = makeFakeHost({ pluginDir: undefined, profileDir: space.profileDir, noInternal: true });
  const stop = apply(blind.ctx, { autoWatch: false });
  await sleep(200);
  const { content } = await callTool(blind, { action: 'reload', target: 'demo-plugin' });
  assert.match(content[0].text, /没有清掉|一条缓存都没清掉/);
  assert.match(content[0].text, /带版本号/);
  stop();
});

dispose();

for (const dir of cleanups) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${failed === 0 ? '✅' : '❌'} integration: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.error(`- ${item.name}: ${item.error?.stack ?? item.error}`);
  process.exitCode = 1;
}
