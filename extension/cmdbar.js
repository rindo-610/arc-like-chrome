// ページの上にコマンドバー（palette.html の iframe）を重ねて出す。URL コピーの通知もここで出す。
// 入力は iframe（拡張のページ）の中で受けるので、ページの JavaScript からは打った文字が見えない。
// 要素は closed な Shadow DOM の中に置き、ページの CSS の影響を受けないようにする。

(() => {
  if (window.top !== window) return;
  // 拡張を更新して入れ直したときは、古い要素を消して作り直す
  for (const old of document.querySelectorAll('arc-like-cmdbar')) old.remove();

  const host = document.createElement('arc-like-cmdbar');
  const root = host.attachShadow({ mode: 'closed' });
  // <style> 要素はページの CSP（style-src）で止められることがあるので、構築済みスタイルシートで当てる
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0, 0, 0, 0.16);
      opacity: 0; transition: opacity .14s ease;
    }
    .backdrop.open { opacity: 1; }
    .frame {
      position: fixed; z-index: 2147483647; left: 50%; top: 18vh;
      width: min(680px, 92vw); height: 56px;
      transform: translateX(-50%) scale(.98); opacity: 0;
      transition: transform .16s cubic-bezier(.2,.8,.2,1), opacity .14s ease, height .12s ease;
      border: 0; border-radius: 14px; background: transparent; color-scheme: normal;
      box-shadow: 0 18px 60px rgba(0,0,0,.28), 0 0 0 .5px rgba(0,0,0,.18);
    }
    .frame.open { transform: translateX(-50%) scale(1); opacity: 1; }
    .toast {
      position: fixed; z-index: 2147483647; right: 18px; bottom: 18px;
      display: flex; align-items: center; gap: 8px;
      padding: 9px 14px; border-radius: 10px;
      background: rgba(30, 30, 32, .92); color: #fff;
      font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif;
      box-shadow: 0 8px 28px rgba(0,0,0,.25);
      opacity: 0; transform: translateY(6px);
      transition: opacity .16s ease, transform .16s cubic-bezier(.2,.8,.2,1);
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: none; }
    .toast svg { width: 14px; height: 14px; fill: none; stroke: #7ee2a8; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  `);
  root.adoptedStyleSheets = [sheet];
  document.documentElement.append(host);

  let backdrop = null;
  let frame = null;

  function closeBar() {
    if (!frame) return;
    const [b, f] = [backdrop, frame];
    backdrop = frame = null;
    b.classList.remove('open');
    f.classList.remove('open');
    setTimeout(() => {
      b.remove();
      f.remove();
    }, 160);
  }

  async function openBar(mode, url) {
    if (frame) closeBar();
    const res = await chrome.runtime.sendMessage({ type: 'issueToken' }).catch(() => null);
    if (!res?.ok) return false;
    backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.addEventListener('mousedown', closeBar);
    frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.allow = 'clipboard-write';
    const params = new URLSearchParams({ mode, token: res.result, url: url ?? '' });
    frame.src = chrome.runtime.getURL(`palette.html?${params}`);
    frame.addEventListener('load', () => frame?.focus());
    root.append(backdrop, frame);
    requestAnimationFrame(() => {
      backdrop?.classList.add('open');
      frame?.classList.add('open');
    });
    return true;
  }

  // iframe からの合図（閉じる、高さ）。自分の iframe から来たものだけ受け付ける
  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow || e.data?.source !== 'arc-like-cmdbar') return;
    if (e.data.type === 'close') closeBar();
    if (e.data.type === 'height' && Number.isFinite(e.data.height)) frame.style.height = `${Math.min(e.data.height, window.innerHeight * 0.7)}px`;
  });
  // フォーカスがページ側にあるときの Esc
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && frame) closeBar();
  }, true);

  let toastTimer = null;
  function toast(text) {
    root.querySelector('.toast')?.remove();
    const box = document.createElement('div');
    box.className = 'toast';
    const ns = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(ns, 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M3.5 8.5l3 3 6-7');
    icon.append(path);
    box.append(icon, document.createTextNode(text));
    root.append(box);
    requestAnimationFrame(() => box.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      box.classList.remove('show');
      setTimeout(() => box.remove(), 200);
    }, 1600);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'open-command-bar') {
      openBar(msg.mode, msg.url).then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg?.type === 'toast') {
      toast(msg.text);
      sendResponse({ ok: true });
    }
    return false;
  });
})();
