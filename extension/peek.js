// Peek: リンクを浮いた小さなウィンドウで開く（Arc の Peek）。ウィンドウを作るのは Service Worker。
// - Option+クリック（ほかの修飾キーなし）: どのタブでも Peek で開く。Chrome 標準の Option+クリック（ダウンロード）は止める
// - 普通のクリック: ピン留め・Favorites のタブから別のサイトへのリンクなら Peek で開く（Arc の既定の動き）
// - Peek のウィンドウの中で Esc: 閉じる（ページが Esc を使った場合は閉じない）

(() => {
  if (window.top !== window) return;
  const alive = () => Boolean(chrome.runtime?.id);

  // このタブで普通のクリックを Peek にするか。クリックの処理は同期的に決める必要があるので、先に聞いておく
  let peekOnClick = false;
  const refresh = () => {
    if (!alive()) return;
    chrome.runtime
      .sendMessage({ type: 'shouldPeekOnClick' })
      .then((res) => (peekOnClick = res?.ok === true && res.result === true))
      .catch(() => {});
  };
  refresh();
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
  // ピン留めした直後のクリックにも間に合うよう、押し始めにも聞き直す（クリックの確定より先に返ってくる）
  window.addEventListener('mousedown', refresh, true);

  // 登録できるドメイン（example.co.jp の co.jp のような 2 段のものも大まかに扱う）
  function siteOf(hostname) {
    const parts = hostname.replace(/^www\./, '').split('.');
    if (parts.length <= 2) return parts.join('.');
    const second = parts[parts.length - 2];
    const take = parts[parts.length - 1].length === 2 && /^(co|ac|ne|or|go|ed|gr|lg|com|net|org|gov|edu)$/.test(second) ? 3 : 2;
    return parts.slice(-take).join('.');
  }

  function linkUrl(e) {
    const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement && n.href);
    if (!a || a.hasAttribute('download')) return null;
    try {
      const url = new URL(a.href, location.href);
      return /^https?:$/.test(url.protocol) ? url : null;
    } catch {
      return null;
    }
  }

  function peek(e, url) {
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: 'peekOpen', url: url.toString() }).catch(() => {});
  }

  window.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || !alive()) return;
      const url = linkUrl(e);
      if (!url) return;
      // 同じページ内のリンク（# だけ違う）は普通の動きに任せる
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return;
      if (e.altKey) return peek(e, url);
      if (peekOnClick && siteOf(url.hostname) !== siteOf(location.hostname)) peek(e, url);
    },
    true,
  );

  // Peek のウィンドウの中なら Service Worker が閉じる（普通のタブなら何もしない）
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && alive()) chrome.runtime.sendMessage({ type: 'peekEscape' }).catch(() => {});
  });
})();
