/**
 * Web 界面刷新的共享状态。
 *
 * host 侧把「刚热重载了哪几个插件」记在内存里并自增一个 rev；页面里的刷新按钮
 * （`lib/client.js`，0.2.x 的 client half）轮询 `/state`，发现 rev 变了就把按钮
 * 标成「有待刷新」，空闲时也可以按 `refreshUi` 策略自动刷新。
 *
 * 为什么不再往 index.html 注入脚本：DSH 桌面壳的 index.html 由安装包静态直出，
 * `tapIndex` 在桌面端根本不参与渲染，而 `webserver/index-inject` 的结构化行只在
 * 宿主启动时收集一次、之后没有刷新路径。0.2.x 给了正式的 client half 通道
 * （`dsh.client` + `exports["./client"]`），随页面启动挂载，比注入脚本稳。
 */

/** 内存里的界面刷新状态。 */
export function createUiState() {
  let rev = 0;
  let at = null;
  let items = [];
  return {
    get rev() {
      return rev;
    },
    snapshot() {
      return { rev, at, items: items.slice(0, 20) };
    },
    bump(nextItems = []) {
      rev += 1;
      at = new Date().toISOString();
      items = nextItems;
      return rev;
    },
  };
}

/**
 * 取请求 URL 相对端点前缀的尾段（`''` 或 `/state` 这样的形式）。
 * @param {string} rawUrl
 * @param {string} base
 */
export function tailOf(rawUrl, base) {
  let pathname = '/';
  try {
    pathname = new URL(String(rawUrl ?? '/'), 'http://localhost').pathname;
  } catch {
    pathname = String(rawUrl ?? '/');
  }
  const prefix = String(base ?? '').replace(/\/+$/, '');
  if (!prefix) return pathname;
  // 前缀必须整段匹配：`/__dsh-live-reloadx/state` 不是我们的端点。
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length).replace(/\/+$/, '') || '';
}
