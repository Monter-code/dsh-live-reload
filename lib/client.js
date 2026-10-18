// dsh-live-reload 的浏览器半边：会话标题栏右侧的那颗「刷新界面」按钮。
//
// 为什么需要它：插件源码改完后，host 半边能把新代码热装进去，但浏览器里已经加载的
// 页面还是旧的 —— 新注册的工具、新的 client bundle、被替换掉的界面组件都不会出现。
// 0.2.x 的页面刷新只能由页面自己发起（全库没有 location.reload()），所以给页面一个
// 按钮就是最短的路：点一下 → 顺带让 host 比对一次磁盘 → 刷新页面。
//
// 为什么是手写的 lazy-CJS bundle：与 host 半边一致，零构建、零依赖。
// `window.__ModuleLoader__.load` 的 factory 返回的就是一个 cordis 插件对象
// （`apply` + `inject`）；`react` 由浏览器模块表通过 `require` 提供，本包不自带。
// `dsh.client.immediately` 必须为 true：客户端模块表是惰性的，没有其它模块 import
// 我们的 id，不开这个开关文件只会被「提供」而永远不会被执行。
//
// 为什么不往 index.html 注入脚本：桌面壳的 index.html 由安装包静态直出，`tapIndex`
// 不参与渲染；`webserver/index-inject` 的结构化行只在宿主启动时收集一次、之后没有
// 刷新路径。client half 是 0.2.x 的正式通道，随页面启动挂载。
window.__ModuleLoader__.load({
  id: 'dsh-live-reload',
  factory: (require) => {
    const exports = {}
    const SLOT = 'conversation.session.header.utilities'
    const ENTRY_ID = 'dsh-live-reload:refresh'
    const DEFAULT_PATH = '/__dsh-live-reload'
    const POLL_FALLBACK = 1500

    let React = null
    try {
      React = require('react')
    } catch (error) {
      console.error('[live-reload] React 不可用，刷新按钮不会出现：' + error)
    }

    /** 端点 URL：tail 是 `/state`、`/check` 这样的尾段。 */
    function endpoint(tail) {
      return DEFAULT_PATH.replace(/\/+$/, '') + tail
    }

    async function readJson(url, signal) {
      try {
        const response = await fetch(url, { cache: 'no-store', signal })
        if (!response.ok) return null
        const payload = await response.json()
        return payload && typeof payload === 'object' ? payload : null
      } catch {
        return null
      }
    }

    /** 用户此刻是不是「空闲」：没有正在输入/选中文字，也没有可见的对话框。 */
    function isIdle() {
      try {
        const active = document.activeElement
        if (active && typeof active.tagName === 'string') {
          const tag = active.tagName.toLowerCase()
          if (tag === 'textarea') return false
          if (tag === 'input' && String(active.type || 'text') !== 'checkbox' && String(active.type || 'text') !== 'radio') return false
          if (active.isContentEditable) return false
        }
        return true
      } catch {
        return true
      }
    }

    /** 刷新图标（箭头绕一圈），busy 时淡一点。 */
    function renderIcon(h, busy) {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: busy ? 0.45 : 1 },
        },
        h('path', {
          d: 'M21 12a9 9 0 1 1-2.64-6.36',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M21 3v6h-6',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function createButton(React) {
      const h = React.createElement
      return function LiveReloadRefreshButton() {
        const [state, setState] = React.useState({ busy: false, stale: false, hover: false })
        const latest = React.useRef(state)
        latest.current = state

        const refresh = React.useCallback(async (event) => {
          if (latest.current.busy) return
          setState((prev) => ({ ...prev, busy: true }))
          const skipCheck = Boolean(event && (event.shiftKey || event.altKey))
          if (!skipCheck) {
            // 顺带让 host 比对一次磁盘：改过源码就顺手热重载，再刷新页面拿新 bundle。
            // 端点不可用、超时、插件自己正在重载 —— 都不阻止刷新页面。
            let timer = null
            try {
              const controller = typeof AbortController === 'function' ? new AbortController() : null
              if (controller) timer = setTimeout(() => controller.abort(), 5000)
              await readJson(endpoint('/check'), controller ? controller.signal : undefined)
            } catch {
              /* ignore */
            } finally {
              if (timer) clearTimeout(timer)
            }
          }
          try {
            window.location.reload()
          } catch (error) {
            console.error('[live-reload] 刷新页面失败：' + error)
            setState((prev) => ({ ...prev, busy: false }))
          }
        }, [])

        React.useEffect(() => {
          let disposed = false
          let seen = null
          let timer = null
          let pollMs = POLL_FALLBACK
          let mode = 'auto'

          const tick = async () => {
            if (disposed) return
            const payload = await readJson(endpoint('/state'))
            if (disposed || !payload) return
            if (payload.ui && typeof payload.ui.mode === 'string') mode = payload.ui.mode
            if (payload.ui && Number.isFinite(payload.ui.pollMs)) pollMs = Math.max(500, payload.ui.pollMs)
            if (typeof payload.rev !== 'number') return
            if (seen === null) {
              seen = payload.rev
              return
            }
            if (payload.rev === seen) return
            seen = payload.rev
            if (mode === 'never') return
            setState((prev) => (prev.stale ? prev : { ...prev, stale: true }))
            if (mode === 'always' || (mode === 'auto' && isIdle())) {
              setTimeout(() => {
                if (disposed) return
                try {
                  window.location.reload()
                } catch {
                  /* ignore */
                }
              }, 600)
            }
          }

          const loop = () => {
            tick().finally(() => {
              if (!disposed) timer = setTimeout(loop, pollMs)
            })
          }
          loop()
          return () => {
            disposed = true
            if (timer) clearTimeout(timer)
          }
        }, [])

        const label = state.busy
          ? '正在检查插件更新…'
          : state.stale
            ? '插件已热更新，点击刷新界面'
            : '刷新界面'
        const title = state.stale ? `${label}（Shift+点击只刷新页面）` : '刷新界面：先检查插件更新，再刷新页面（Shift+点击只刷新页面）'

        return h(
          'button',
          {
            type: 'button',
            title,
            'aria-label': '刷新界面',
            'data-dsh-live-reload': 'refresh',
            'data-stale': state.stale ? 'true' : 'false',
            onClick: refresh,
            onMouseEnter: () => setState((prev) => ({ ...prev, hover: true })),
            onMouseLeave: () => setState((prev) => ({ ...prev, hover: false })),
            style: {
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              margin: 0,
              borderRadius: 8,
              cursor: state.busy ? 'progress' : 'pointer',
              border: `1px solid ${state.hover ? 'var(--dsw-alias-border-l2, rgba(128,128,128,.35))' : 'transparent'}`,
              background: state.hover ? 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12))' : 'transparent',
              color: state.stale
                ? 'var(--dsw-alias-brand-primary, #3b82f6)'
                : 'var(--dsw-alias-label-secondary, currentColor)',
              transition: 'background .12s ease, border-color .12s ease, color .12s ease',
              boxSizing: 'border-box',
            },
          },
          renderIcon(h, state.busy),
          state.stale
            ? h('span', {
                'aria-hidden': 'true',
                style: {
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--dsw-alias-brand-primary, #3b82f6)',
                  boxShadow: '0 0 0 2px var(--dsw-alias-bg-base, #fff)',
                },
              })
            : null,
        )
      }
    }

    function apply(ctx) {
      if (!React) {
        console.error('[live-reload] 跳过刷新按钮：React 不可用')
        return
      }
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
        // 声明式 inject 已经保证了 slots 存在；这条只在宿主契约变化时才会出现。
        console.error('[live-reload] 跳过刷新按钮：上下文里没有 slots 服务')
        return
      }
      const Button = createButton(React)
      ctx.slots.inject(SLOT, function* () {
        yield ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 30, label: '刷新界面' }, Button)
      })
    }

    exports.apply = apply
    // 声明而不是嗅探：cordis 会等到 slot 注册表就绪再 apply。
    exports.inject = ['slots']
    return exports
  },
})
