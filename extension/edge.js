// 画面の左端にカーソルを当てると、サイドバーをページの上に重ねて出す（Arc の非表示サイドバー）。
// Chrome のサイドパネルが開いているウィンドウでは出さない。幅は右端のつまみをドラッグして変えられる。
// 中身は sidepanel.html を iframe で読み込む。ページ側からは closed な Shadow DOM の中なので触れない。

(() => {
  if (window.top !== window) return;
  // 拡張を更新すると古い content script は動かなくなるが、要素は残る。
  // Service Worker が開いているタブへ入れ直したときは、古いものを消して作り直す
  for (const old of document.querySelectorAll('arc-like-edge')) old.remove();

  const HOT_WIDTH = 4;
  const SHOW_DELAY = 70;
  const HIDE_DELAY = 280;
  const EXIT_EDGE = 80; // ページの左端から何 px 以内で外へ出たら「縦タブに乗った」とみなすか（素早く動かしたときのずれを見込む）
  const MIN_WIDTH = 160;
  const MAX_WIDTH = 480;
  const DEFAULT_WIDTH = 240;

  const host = document.createElement('arc-like-edge');
  const root = host.attachShadow({ mode: 'closed' });
  // 拡張が更新されると、この古い content script からは拡張の API を呼べなくなる（呼ぶとエラーになる）
  const alive = () => Boolean(chrome.runtime?.id);
  // <style> 要素はページの CSP（style-src）で止められることがあるので、構築済みスタイルシートで当てる
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .hot { position: fixed; left: 0; top: 0; bottom: 0; width: ${HOT_WIDTH}px; z-index: 2147483646; }
    .panel {
      position: fixed; left: 6px; top: 6px; bottom: 6px; width: var(--w, ${DEFAULT_WIDTH}px);
      z-index: 2147483647; border-radius: 12px; overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,.28), 0 0 0 .5px rgba(0,0,0,.18);
      transform: translateX(calc(-100% - 16px)); opacity: 0;
      transition: transform .2s cubic-bezier(.2,.8,.2,1), opacity .2s;
      visibility: hidden;
    }
    .panel.open { transform: none; opacity: 1; visibility: visible; }
    .panel.resizing { transition: none; }
    iframe { display: block; width: 100%; height: 100%; border: 0; }
    .panel.resizing iframe { pointer-events: none; }
    .grip { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: ew-resize; }
  `);
  root.adoptedStyleSheets = [sheet];
  const hot = document.createElement('div');
  hot.className = 'hot';
  const panel = document.createElement('div');
  panel.className = 'panel';
  const grip = document.createElement('div');
  grip.className = 'grip';
  panel.append(grip);
  root.append(hot, panel);
  document.documentElement.append(host);

  let iframe = null;
  let showTimer = null;
  let hideTimer = null;
  let outsideTimer = null; // ページ上でサイドバーの外にカーソルがあるときの引っ込めタイマー

  chrome.storage.local
    .get('overlayWidth')
    .then(({ overlayWidth }) => {
      if (overlayWidth) panel.style.setProperty('--w', `${overlayWidth}px`);
    })
    .catch(() => {});

  // 出した・出さなかった理由を残す（dev/state.html で見る）
  const note = (result) => alive() && chrome.storage.local.set({ edgeDiag: { at: new Date().toISOString(), result } }).catch(() => {});

  async function reveal() {
    if (!alive()) return; // 更新前の古い content script（入れ直したものが代わりに動く）
    // サイドパネルが開いているウィンドウでは出さない
    const res = await chrome.runtime.sendMessage({ type: 'panelOpenHere' }).catch((e) => ({ error: String(e) }));
    if (res?.error) return note(`問い合わせ失敗: ${res.error}`);
    if (res?.result) return note('サイドパネルが開いているので出さない');
    if (!iframe) {
      const token = (await chrome.runtime.sendMessage({ type: 'issueOverlayToken' }).catch(() => null))?.result;
      if (!token) return note('トークンを受け取れない');
      iframe = document.createElement('iframe');
      iframe.src = chrome.runtime.getURL(`sidepanel.html?overlay=1&token=${encodeURIComponent(token)}`);
      iframe.allow = '';
      panel.prepend(iframe);
    }
    panel.classList.add('open');
    note('出した');
  }

  function hide() {
    panel.classList.remove('open');
  }

  hot.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    showTimer = setTimeout(reveal, SHOW_DELAY);
  });
  hot.addEventListener('mouseleave', () => clearTimeout(showTimer));
  panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  panel.addEventListener('mouseleave', () => {
    if (panel.classList.contains('resizing')) return;
    hideTimer = setTimeout(hide, HIDE_DELAY);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) hide();
  });

  // Chrome の縦タブ（左に置き、自動で開かない設定）の上にカーソルが乗ったら出す。
  // 拡張から Chrome の画面部分は見えないが、カーソルがページの左端から外へ出た瞬間は分かるので、
  // 「左端から外へ出た = 縦タブの列に乗った」とみなす。上（タブやアドレスバー）や右から出たときは出さない。
  // 素早く動かすと、Chrome が最後に報告する位置は左端の数十 px 手前になることがあるので、
  // 「いちばん近い辺が左で、左端から EXIT_EDGE 以内」なら左へ出たとみなす。
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget) return;
    const x = Math.max(0, e.clientX);
    const y = e.clientY;
    const nearest = Math.min(x, Math.max(0, y), Math.max(0, window.innerWidth - x), Math.max(0, window.innerHeight - y));
    if (x > EXIT_EDGE || x !== nearest || y <= 0 || y >= window.innerHeight) return;
    if (panel.classList.contains('open')) return;
    clearTimeout(hideTimer);
    reveal();
  });

  // 出したあと、サイドバーに入らずにページへ戻ったら引っ込める（左端から出して縦タブへ行き、戻ってきた場合など）
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!panel.classList.contains('open') || panel.classList.contains('resizing')) return;
      const r = panel.getBoundingClientRect();
      const inside = e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
      if (inside) {
        clearTimeout(outsideTimer);
        outsideTimer = null;
      } else if (!outsideTimer) {
        outsideTimer = setTimeout(() => {
          outsideTimer = null;
          hide();
        }, HIDE_DELAY);
      }
    },
    true,
  );

  // 幅の変更
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    panel.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!panel.classList.contains('resizing')) return;
    const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX - 6)));
    panel.style.setProperty('--w', `${width}px`);
  });
  grip.addEventListener('pointerup', (e) => {
    grip.releasePointerCapture(e.pointerId);
    panel.classList.remove('resizing');
    const width = parseInt(panel.style.getPropertyValue('--w'), 10);
    if (width && alive()) chrome.storage.local.set({ overlayWidth: width }).catch(() => {});
  });

  // 別のタブで幅を変えたら合わせる
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.overlayWidth?.newValue) {
      panel.style.setProperty('--w', `${changes.overlayWidth.newValue}px`);
    }
  });
})();
