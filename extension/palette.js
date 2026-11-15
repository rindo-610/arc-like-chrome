// コマンドバーの画面。3 つの出し方がある:
// - overlay: cmdbar.js がページの上に iframe で重ねる（?token= を持つときだけ中身を出す）
// - popup:   content script が動かないページ（chrome:// など）では Service Worker が小さなウィンドウで開く（?popup=1&target=タブ）
// - newtab:  新しいタブページ（newtab.html）
// mode=new は Enter で新しいタブ、mode=current は Enter で今のタブ。Shift+Enter でその逆。開いているタブは切り替えるだけ。

import { searchAll, recentTabs, looksLikeUrl, toUrl, hostOf } from './search.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isNewtab = location.pathname.endsWith('/newtab.html');
const isPopup = params.has('popup');
const isOverlay = window.top !== window;
const mode = isNewtab ? 'current' : params.get('mode') === 'current' ? 'current' : 'new';

let target = null; // コマンドバーを開いたタブ（今のタブ）
let items = [];
let selected = 0;
let seq = 0;

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? '応答がありません');
  return res.result;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children.filter((c) => c != null));
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(paths) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('class', 'icon');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}
const searchIcon = () => svg(['M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M10.5 10.5l3 3']);
const globeIcon = () => svg(['M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z', 'M2 8h12', 'M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14c-1.8-1.8-2.6-3.8-2.6-6S6.2 3.8 8 2z']);

function favicon(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl || 'about:blank');
  url.searchParams.set('size', '32');
  return el('img', { src: url.toString(), alt: '' });
}

// ---- 閉じる ----

function close() {
  if (isOverlay) window.parent.postMessage({ source: 'arc-like-cmdbar', type: 'close' }, '*');
  else if (isPopup) window.close();
  else {
    $('q').value = '';
    run();
  }
}

// iframe の高さを中身に合わせてもらう
function reportHeight() {
  if (isOverlay) window.parent.postMessage({ source: 'arc-like-cmdbar', type: 'height', height: $('bar').offsetHeight }, '*');
}

// ---- 開く ----

async function openItem(item, alternate) {
  const inCurrent = (mode === 'current') !== alternate;
  if (item.kind === 'tab') {
    await chrome.tabs.update(item.tabId, { active: true });
    await chrome.windows.update(item.windowId, { focused: true });
  } else if (item.kind === 'search') {
    // 既定の検索エンジンで検索する（新しいタブのときは、空のタブを作ってそこで検索）
    const tabId = inCurrent ? target.id : (await chrome.tabs.create({ windowId: target.windowId, index: target.index + 1, url: 'about:blank' })).id;
    await chrome.search.query({ text: item.query, tabId });
  } else if (inCurrent) {
    await chrome.tabs.update(target.id, { url: item.url });
  } else {
    await chrome.tabs.create({ windowId: target.windowId, index: target.index + 1, url: item.url, active: true });
  }
  if (!isNewtab || !inCurrent) close();
}

// ---- 描画 ----

function render() {
  const list = $('results');
  list.replaceChildren(
    ...items.map((item, i) => {
      let icon;
      let title;
      let sub = '';
      let tag = '';
      if (item.kind === 'search') {
        icon = searchIcon();
        title = item.query;
        sub = '検索';
      } else if (item.kind === 'url') {
        icon = globeIcon();
        title = item.url;
        sub = '開く';
      } else {
        icon = favicon(item.url);
        title = item.title;
        sub = hostOf(item.url) || item.url;
        if (item.kind === 'tab') tag = 'タブに切り替え';
      }
      const row = el(
        'div',
        { className: `row${i === selected ? ' selected' : ''}`, title: item.url ?? '' },
        icon,
        el('span', { className: 'title', textContent: title }),
        el('span', { className: 'sub', textContent: sub }),
        tag ? el('span', { className: 'tag', textContent: tag }) : null,
      );
      row.addEventListener('mousemove', () => {
        if (selected !== i) {
          selected = i;
          render();
        }
      });
      row.addEventListener('click', (e) => openItem(item, e.shiftKey));
      return row;
    }),
  );
  reportHeight();
}

async function run() {
  const my = ++seq;
  const q = $('q').value.trim();
  let next;
  if (!q) {
    next = await recentTabs({ excludeTabId: target?.id });
  } else {
    const found = await searchAll(q, { excludeTabId: target?.id });
    next = [...found];
    if (looksLikeUrl(q)) next.unshift({ kind: 'url', url: toUrl(q) });
    // 見つからなくても検索できるよう、最後に検索の行を置く（候補がなければ先頭）
    next.push({ kind: 'search', query: q });
  }
  if (my !== seq) return; // 打ち続けている間に古い結果が後から来たら捨てる
  items = next;
  selected = 0;
  render();
}

let timer = null;
function scheduleRun() {
  clearTimeout(timer);
  timer = setTimeout(run, 40);
}

// ---- はじめに ----

async function init() {
  if (isOverlay) {
    const ok = await send('checkToken', { token: params.get('token') }).catch(() => false);
    if (ok !== true) return; // トークンがなければ何も出さない（ほかのサイトに埋め込まれた場合）
  }
  if (isPopup) document.body.classList.add('popup');
  target = isPopup ? await chrome.tabs.get(Number(params.get('target'))).catch(() => null) : await chrome.tabs.getCurrent();
  if (!target) return;

  const q = $('q');
  // 今のタブの URL を変えるコマンドバーは、今の URL を入れた状態で開く（Arc の Cmd+L）
  if (mode === 'current' && !isNewtab && target.url) {
    q.value = params.get('url') || target.url;
    $('lead').append(favicon(target.url));
  } else {
    $('lead').append(searchIcon());
  }
  $('bar').hidden = false;
  q.focus();
  q.select();

  q.addEventListener('input', scheduleRun);
  q.addEventListener('keydown', (e) => {
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
    if (down || up) {
      e.preventDefault();
      if (!items.length) return;
      selected = (selected + (down ? 1 : -1) + items.length) % items.length;
      render();
      $('results').children[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.isComposing) return; // 日本語の変換中の Enter は確定に使う
      const item = items[selected];
      if (item) openItem(item, e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  // iframe にフォーカスが戻ったら入力欄へ
  window.addEventListener('focus', () => q.focus());
  // 小さなウィンドウは、ほかを触ったら閉じる
  if (isPopup) window.addEventListener('blur', () => window.close());

  await run();
}

init();
