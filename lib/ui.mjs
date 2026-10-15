/**
 * Web 界面刷新通道。
 *
 * host 侧把「刚热重载了哪几个插件」记在内存里并自增一个 rev；
 * 页面里注入的小脚本轮询 `/state`，发现 rev 变了就刷新界面
 * （默认「空闲才自动刷新」，正在输入时弹一个「立即刷新」小胶囊）。
 *
 * 为什么不用 SSE/WebSocket：轮询一个几十字节的 JSON 端点最不容易被
 * 代理、休眠、页面隐藏等情况打断，而且断线后自动恢复，不需要重连逻辑。
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

function quote(value) {
  return JSON.stringify(String(value ?? ''));
}

/**
 * 生成注入到 index.html 的客户端脚本。
 * @param {{ path: string, pollMs?: number, mode?: 'auto' | 'idle' | 'always' | 'manual' | 'never' }} options
 */
export function renderClientScript({ path = '/__dsh-live-reload', pollMs = 1500, mode = 'auto' } = {}) {
  const endpoint = `${path.replace(/\/+$/, '')}/state`;
  const normalized = mode === 'auto' ? 'idle' : mode;
  return `<script>
(function () {
  var ENDPOINT = ${quote(endpoint)};
  var POLL = ${Number.isFinite(pollMs) && pollMs >= 300 ? Math.round(pollMs) : 1500};
  var MODE = ${quote(normalized)};
  var seen = null;
  var ready = false;
  var pill = null;

  function makePill(text, onAction) {
    if (pill) pill.remove();
    var box = document.createElement('div');
    box.setAttribute('data-dsh-live-reload', 'pill');
    box.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'max-width:340px', 'padding:10px 12px', 'border-radius:10px',
      'background:rgba(28,30,34,.96)', 'color:#f2f3f5', 'font:12px/1.5 system-ui,sans-serif',
      'box-shadow:0 8px 26px rgba(0,0,0,.38)', 'display:flex', 'gap:10px', 'align-items:center'
    ].join(';');
    var label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0;';
    label.textContent = text;
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '立即刷新';
    button.style.cssText = [
      'flex:none', 'padding:5px 10px', 'border-radius:7px', 'border:0',
      'background:#3b82f6', 'color:#fff', 'font:inherit', 'cursor:pointer'
    ].join(';');
    button.addEventListener('click', onAction);
    box.appendChild(label);
    box.appendChild(button);
    document.body.appendChild(box);
    pill = box;
    return box;
  }

  function reload() {
    try { window.location.reload(); } catch (error) { /* ignore */ }
  }

  function isIdle() {
    var nodes = document.querySelectorAll('textarea, input[type=text], input[type=search], [contenteditable=true]');
    for (var i = 0; i < nodes.length; i += 1) {
      var value = nodes[i].value;
      if (typeof value === 'string' && value.trim()) return false;
      if (nodes[i].isContentEditable && nodes[i].textContent && nodes[i].textContent.trim()) return false;
    }
    return true;
  }

  function tick() {
    if (MODE === 'never') return;
    fetch(ENDPOINT + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (state) {
        if (!state || typeof state.rev !== 'number') return;
        if (seen === null) { seen = state.rev; ready = true; return; }
        if (state.rev === seen) return;
        seen = state.rev;
        var names = (state.items || []).map(function (item) { return item.name || item.entry || '插件'; });
        var text = names.length ? '插件已热更新：' + names.join('、') : '插件已热更新';
        if (MODE === 'always' || (MODE === 'idle' && isIdle())) { reload(); return; }
        makePill(text, reload);
      })
      .catch(function () { /* 端点暂时不可用（例如插件自身正在重载）：下个周期再试 */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setInterval(tick, POLL); tick(); });
  } else {
    setInterval(tick, POLL);
    tick();
  }
  void ready;
})();
</script>`;
}

/** 把脚本插到 </body> 前（没有 </body> 就补在后面）。 */
export function injectIntoIndex(html, script) {
  const source = String(html ?? '');
  if (!source) return source;
  const index = source.toLowerCase().lastIndexOf('</body>');
  if (index === -1) return `${source}\n${script}`;
  return `${source.slice(0, index)}${script}\n${source.slice(index)}`;
}
