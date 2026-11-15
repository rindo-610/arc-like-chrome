// 新しいタブページでも、左端ホバーでサイドバー（sidepanel.html）を重ねて出す。
// 新しいタブページは拡張のページなので、content script（edge.js）は動かない。同じ動きをここで行う。
const SHOW_DELAY = 70;
const HIDE_DELAY = 280;
const EXIT_EDGE = 80;

const hot = document.createElement('div');
hot.className = 'edge-hot';
const panel = document.createElement('div');
panel.className = 'edge-panel';
document.body.append(hot, panel);

let iframe = null;
let showTimer = null;
let outsideTimer = null;

async function ask(type) {
  const res = await chrome.runtime.sendMessage({ type }).catch(() => null);
  return res?.ok ? res.result : null;
}

chrome.storage.local.get('overlayWidth').then(({ overlayWidth: width }) => {
  if (width) panel.style.setProperty('--w', `${width}px`);
});

async function reveal() {
  if (panel.classList.contains('open')) return;
  if (await ask('panelOpenHere')) return; // サイドパネルが開いているウィンドウでは出さない
  if (!iframe) {
    const token = await ask('issueOverlayToken');
    if (!token) return;
    iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL(`sidepanel.html?overlay=1&token=${encodeURIComponent(token)}`);
    panel.append(iframe);
  }
  panel.classList.add('open');
}

function hide() {
  panel.classList.remove('open');
}

hot.addEventListener('mouseenter', () => {
  showTimer = setTimeout(reveal, SHOW_DELAY);
});
hot.addEventListener('mouseleave', () => clearTimeout(showTimer));

// 縦タブの列（ページの左の外）へ出たら出す。いちばん近い辺が左で、左端から EXIT_EDGE 以内なら左へ出たとみなす
document.addEventListener('mouseout', (e) => {
  if (e.relatedTarget) return;
  const x = Math.max(0, e.clientX);
  const y = e.clientY;
  const nearest = Math.min(x, Math.max(0, y), Math.max(0, window.innerWidth - x), Math.max(0, window.innerHeight - y));
  if (x > EXIT_EDGE || x !== nearest || y <= 0 || y >= window.innerHeight) return;
  reveal();
});

// サイドバーの外でマウスが動いたら引っ込める
document.addEventListener(
  'mousemove',
  (e) => {
    if (!panel.classList.contains('open')) return;
    const r = panel.getBoundingClientRect();
    if (e.clientX <= r.right + 8) {
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panel.classList.contains('open')) hide();
});

// 開発用: newtab.html?edge-test で開くと、すぐ出す（見た目の確認用）
if (new URLSearchParams(location.search).has('edge-test')) setTimeout(reveal, 300);
