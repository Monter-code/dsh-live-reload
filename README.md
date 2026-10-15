# dsh-live-reload

让 **DSH 桌面端不重启就能生效**：插件源码一变，host 侧插件模块立刻重新加载；有 Web 界面时页面会收到刷新提示。

装好本插件并重启一次之后，**其它插件**的改动都不再需要重启 DSH —— 改完代码 1 秒内自动生效，界面自动刷新（可配置）。

- 零依赖（只用 Node 内置模块）
- 只用宿主公开契约（`ctx.tools` / `loader` / `webServer` / `ctx.provide`）
- 监视走轮询而不是 `fs.watch`（见下文「为什么不用 fs.watch」）

---

## 1. 它做什么

| 能力 | 说明 |
| --- | --- |
| 热重载 host 插件模块 | 监视 profile 里用 `link:` 装入的插件目录，磁盘一变就重新 import 对应模块并重新 `apply`，等价于宿主内置 HMR 的那套「清缓存 → 重 import → 换 registry 绑定」 |
| 界面刷新 | 通过 `/__dsh-live-reload/state` 让页面知道有插件更新了；`auto`/`idle` 模式下页面空闲时自动 `location.reload()`，忙时弹「插件已热更新：…／立即刷新」胶囊，不会打断正在输入的对话 |
| 工具入口 | 工具 `live_reload`：`status` / `check` / `reload` / `start` / `stop` / `roots` |
| 服务入口 | 服务 `liveReload`，供其它插件订阅 `onChange` 或主动触发重载 |

**边界**（务必先读）：

- 只管 **host 半边**（Node 里跑的插件模块）。浏览器半边的 bundle 由宿主自己的 client-hmr 负责，本插件的做法是「提示页面刷新」。
- 只管 **`link:` 装入的插件目录**（开发/自研插件正是这种）。DSH 自带的插件在 `app.asar` 里，不在监视范围。
- 默认**不重载自己**（`reloadSelf: false`）：改本插件源码时请手动重启一次，避免自己把自己换掉。
- 不会把 `disabled` 的插件顶起来：自动路径按「只重载本来就在跑的 entry」处理；显式 `action=reload` 才允许强制。

## 2. 安装

```powershell
# 装进桌面 profile（本机示例路径，换成你自己的插件目录）
dsh plugin --profile desktop add link:D:/path/to/dsh-live-reload
```

或者直接用插件管理器：`plugin_manager action=install_bundle target=<插件目录绝对路径>`。

装完 **重启一次 DSH**（让本插件自己先跑起来）。此后改别的插件 → 不用重启。

## 3. 工具 `live_reload`

| action | 作用 |
| --- | --- |
| `status` | 看监视了哪些目录、对应哪些 loader entry、最近重载记录、界面刷新状态、统计 |
| `check` | 立刻比对一次磁盘指纹；有变化就重载（不用等轮询） |
| `reload` | 立即重载。可带 `target` / `targets` 子串筛选；不带就重载所有被监视插件 |
| `start` / `stop` | 开/关自动监视（`stop` 之后手动 `reload`/`check` 仍可用） |
| `roots` | 只列监视目录与来源 |
| `cache` | 诊断：把宿主模块缓存里的键摊开（ESM/CJS 各有多少、命中哪些、`loader.internal` 是否可用）。排查「报告成功但代码没换」时先看它 |

典型用法：改完代码发现还没生效（比如刚写的文件 mtime 太新、或插件本身被排除），直接

```
live_reload( action = "reload", target = "dsh-image-insight" )
```

## 4. 配置

写在 profile 的 `cordis.patch.yml` 里（或插件设置界面）：

```yaml
- id: dsh-live-reload
  name: dsh-live-reload
  config:
    pollMs: 400              # 扫描间隔，默认 700ms（150–60000）
    debounceMs: 300          # 变更去抖，默认 300ms（50–10000）
    autoWatch: true          # 是否自动监视
    reloadSelf: false        # 是否允许热重载本插件
    refreshUi: idle          # auto|idle|always|manual|never
    watch:                   # 额外监视的目录（绝对路径）
      - D:/test-dsh/experiments/lr-victim
    exclude:                 # 排除的目录
      - D:/test-dsh/scratch
    reloadTargets:           # 白名单：只有命中的插件才会被（自动）重载
      - dsh-image-insight
    ignore:                  # 追加忽略规则（在默认列表之上）
      - '*.tmp'
```

默认忽略：`node_modules`、`.git`、`.github`、`dist`、`build`、`out`、`coverage`、`.cache`、`.turbo`、`.next`、`*.log`、`*.tmp`、`*.swp`、`*~`、`.DS_Store`。

## 5. 服务 `liveReload`

```js
// 在其它插件里
const live = ctx.get('liveReload');
const off = live.onChange((items) => console.log('热重载完成', items));
await live.reload({ target: 'my-plugin' });   // 立刻重载
live.status();                                 // 与工具 status 同一份数据
live.roots();                                  // 监视目录数组
```

## 6. 界面刷新怎么工作

- 插件用 `webServer.register({ kind: 'prefix', path: '/__dsh-live-reload' })` 挂了两个端点：
  - `GET /__dsh-live-reload/state` → `{ rev, at, items, startedAt, roots }`（几十字节 JSON，`no-store`）
  - `GET /__dsh-live-reload/reload` → 触发一次手动重载
- 同时用 `webServer.tapIndex()` 往 index.html 注入一段脚本：轮询 `/state`，`rev` 变了就按 `refreshUi` 策略刷新或提示。
- 为什么是轮询而不是 SSE/WebSocket：几十字节的 JSON 最不容易被代理、休眠、页面隐藏打断，断线自动恢复，也不需要重连状态机。

## 7. 实现要点（为什么这么写）

1. **必须「先删 registry，再 apply 新模块」**。宿主 `Fiber.dispose` 里有一句
   `if (this.ctx.registry.has(runtime.callback))`：如果先 dispose 旧 fiber 再删 registry，Loader 的
   `internal/plugin` 监听会走到 case 6，把 entry 写成 `disabled: true` 并持久化 —— 插件从此不再加载。
   顺序错了就是这个后果，所以代码里把它写成显式步骤并加了断言测试。
2. **必须清 Node 的模块缓存**。ESM/CJS 缓存不清，重新 import 拿到的还是旧模块（Node 24 的 LoadCache 用 `Map`，
   而且它的 `delete` 只是把槽位置空，所以用 `Map.prototype.delete.call()`）。
   而且**键未必是监视目录的路径**：`link:` 装入的插件在宿主里的模块标识常常是
   `<profile>/node_modules/<pkg>/...`（junction 路径），与配置里监视的真实目录字面不同。
   所以匹配同时用四层线索：路径前缀、realpath 穿透、目录 basename、插件包名。
   真机上「一次都没有清掉」曾导致**报告成功但代码没换**，这正是 `cache` action 存在的原因。
2.5. **清不掉缓存时退化为「带版本号重新导入」**：给模块 URL 加 `?dshlr=<时间戳>` 会强制 Node 产生新的模块实例，
   于是即使宿主没有 `--expose-internals`（`loadCache` 不可见）也能拿到新代码。代价是旧的模块实例会留在
   缓存里（开发期可接受）；工具输出会明确告诉你这一次用的是哪种方式（`mode: purge | bust | none`）。
   两种方式都拿不到新代码时不会假装成功：卡片上会打出显式警告。
3. **用宿主自己的 `entry.parent.tree.import(name, stack)` 重新加载**，而不是自己 `import()` 一个 URL：
   这条路径就是宿主 HMR 用的那条，`--expose-internals` 存在时走 `loader.internal.import`，不存在时退化为普通
   `import`，行为一致。
4. **import 失败绝不碰正在运行的插件**：先把新模块 import 成功，才动 registry；apply 抛错则把旧插件装回去
   （`rolledBack: true`）。
5. **为什么不用 `fs.watch`**：Windows 上编辑器普遍「写临时文件 → 改名覆盖」，`fs.watch` 经常漏事件；漏一次就等于
   改了代码不生效。插件源码目录很小（默认最多 5000 文件），700ms 扫一次指纹的开销可以忽略。
6. **不 `inject: ['webServer']`**：headless profile 没有 webServer 服务，硬注入会让插件在 headless 里起不来；
   改成可选获取（`ctx.get('webServer', false)`），没有就只跑 host 半边。

## 8. 自测

```powershell
node tests/selftest.mjs      # 23 例：忽略/指纹/差异、根发现、重载内核调用顺序、轮询、界面脚本
node tests/integration.mjs   # 18 例：假宿主 apply → 工具 → 改动 → 重载 → 界面端点 → 服务通知
```

integration 用的假宿主完整复刻了宿主的「无损 JSON 快照 + schema 严格校验 + render 必须返回
ContentBlock[] + presentResult 必须返回视图」，因此 schema 写错、字段漏声明都会被测出来。

## 9. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `live_reload status` 里 `roots` 是空的 | 没有 `link:` 装入的插件。用配置项 `watch` 手工指定目录，或 `exclude` 把它排除了 |
| 改了代码没重载 | `live_reload action=check` 手动催一次；或看 `ignore` 是否命中了你的文件；或该插件不在被监视目录里 |
| 报告「已热重载」但工具行为没变 | 先跑 `live_reload action=cache`：命中数为 0 说明缓存键没对上，会走 `mode=bust`；两者都没效果时重启一次 DSH 并反馈 `cache` 输出 |
| `reloaded[].mode = "none"` | 既没清掉缓存，也无法把模块名解析成文件（`dsh plugin add link:` 未装好或包名不对）；此时**没有**换代码 |
| `reloaded[].reason = "import-failed"` | 新代码有语法/导入错误，旧插件仍在运行（先修好语法） |
| `reloaded[].reason = "entry-not-loaded"` | 该插件当前没在运行（被禁用或未加载），自动路径会跳过 |
| 界面没刷新 | 桌面 profile 有 `webServer` 才会注入；`refreshUi: manual` 时只在有更新时弹提示，需手动点「立即刷新」 |

## 10. 已验证

在 headless profile（真实宿主进程，不是模拟宿主）里做过端到端验证：装入一个 `link:` 小白鼠插件
（`dsh-lr-victim`，模块级 `const VERSION`、每次求值生成随机 `LOAD_NONCE`）→ 它改写自己的源码 →
热重载 → 再次调用它的工具：拿到的是**新版本号 + 新的模块加载随机数**，而进程 PID 不变（没有重启）。

第 3 轮真机记录（`live_reload status` 与工具返回原文，节选自 `fixtures/lr-e2e-3.json`）：

```text
lr_victim_version → version=2 nonce=lbaet2tf loadedAt=2026-10-15T09:20:41.060Z pid=9072
lr_victim_bump    → 已写入 …\profiles\headless\node_modules\dsh-lr-victim\lib\index.js：2 → 3

live_reload status（自动监视触发后）
  ♻️ 热重载状态
  正在监视 3 个插件目录，已热重载 2 次。
  · dsh-lr-victim → D:/test-dsh/experiments/lr-victim
  ✅ dsh-lr-victim：清理 ESM 8 / CJS 0（清缓存后重新导入）
  · 变更 D:/test-dsh/experiments/lr-victim：lib/index.js
  统计：扫描 6 次 · 触发 2 次 · 重载 2 次 · 失败 0 次

lr_victim_version → version=3 nonce=csj16ukc loadedAt=2026-10-15T09:20:44.705Z pid=9072   ← 新代码生效

live_reload reload target=victim
  ♻️ 热重载 · reload
  ✅ dsh-lr-victim：清理 ESM 1 / CJS 0（清缓存后重新导入）

lr_victim_version → version=3 nonce=wjfzpsm3 loadedAt=2026-10-15T09:20:47.742Z pid=9072   ← 又一次全新实例
```

结论：`nonce` 每次都不同 ⟹ 每次都是**全新的模块求值**（不是复用旧实例）；`VERSION` 跟随磁盘源码
（2 → 3）⟹ 加载的确实是**磁盘上的新代码**；三次读数 `pid` 恒为 `9072` ⟹ **进程没有重启**。

一个反面记录也留在仓库里：修 bug 之前，宿主里的模块标识是 profile 的 junction 路径
（`…\profiles\headless\node_modules\dsh-lr-victim\lib\index.js`），与配置里监视的真实目录
（`D:/test-dsh/experiments/lr-victim`）字面对不上，导致缓存清了 0 条、**报告成功但代码没换**。
现在的四层匹配线索（前缀 / realpath / basename / 包名）与 `mode=bust` 兜底就是为此加的，
`live_reload action=cache` 可以在真机上直接看到命中情况。
