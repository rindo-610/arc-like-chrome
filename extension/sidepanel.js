// サイドパネルの UI（Arc に寄せる）
// - 操作は文字ボタンにしない。ホバーで出る ×、ダブルクリックで名前変更、右クリックのメニュー、ドラッグで行う
// - 閉じる・外す・削除は Cmd+Z で戻せる
// 一覧はウィンドウ単位ではなく全体で 1 つ。ブックマークとタブの対応の書き換えは Service Worker に頼む。
// ?overlay を付けて開くと、左端ホバーで重ねて出す表示（edge.js の iframe）になる。

const $ = (id) => document.getElementById(id);
if (new URLSearchParams(location.search).has('overlay')) document.documentElement.classList.add('overlay');

let structure = null;
let myWindowId = null;
let editing = false;
let pendingRenameId = null;
let renderTimer = null;
let holdUntil = 0;
let dragData = null; // { kind: 'bookmark' | 'tab', id, isFolder }
let prevKeys = null;
let spaces = []; // [{ id, title, color }]
let currentSpaceId = null;
let spaceFavoritesId = null; // 今のスペースの Favorites フォルダ（まだなければ null）
const FAVORITES_TITLE = 'Favorites';
let view = 'main'; // 'main' | 'archive'
let slideDirection = null; // スペースを切り替えた直後だけ 'left' / 'right'
const undoStack = [];

// スペースの色名と、サイドバーで使う色
const GROUP_HEX = {
  grey: '#8a8f98', blue: '#3b82f6', red: '#e5484d', yellow: '#e2a400', green: '#30a46c',
  pink: '#d6409f', purple: '#8e4ec6', cyan: '#12a5b8', orange: '#f76b15',
};

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? '応答がありません');
  return res.result;
}

function showError(e) {
  const toast = $('toast');
  toast.textContent = String(e?.message ?? e);
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 4000);
}
const run = (promise) => Promise.resolve(promise).catch(showError);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// ---- アイコン（SVG を DOM で組み立てる）----

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
  minus: ['M4 8h8'],
  plus: ['M8 3.5v9', 'M3.5 8h9'],
  folder: ['M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z'],
  folderOpen: ['M2.5 12V4.5a1 1 0 0 1 1-1h3l1.5 1.5h4a1 1 0 0 1 1 1v1', 'M2.5 12.5l1.6-4.8a1 1 0 0 1 .95-.7h8.4a.6.6 0 0 1 .57.8l-1.5 4.2a.75.75 0 0 1-.7.5z'],
  archive: ['M2.5 3.5h11v3h-11z', 'M3.5 6.5v6a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-6', 'M6.5 9h3'],
  back: ['M10 3.5L5.5 8l4.5 4.5'],
  down: ['M8 3.5v9', 'M4.5 9L8 12.5 11.5 9'],
};

function svg(name, className = '') {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('class', `icon ${className}`.trim());
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

function favicon(pageUrl) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl || 'about:blank');
  url.searchParams.set('size', '32');
  return el('img', { src: url.toString(), alt: '', draggable: false });
}

// 行にカーソルを当てたときだけ出るボタン（× や −）
function hoverButton(iconName, onClick) {
  const b = el('button', { type: 'button', className: 'close', tabIndex: -1 }, svg(iconName));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    run(onClick());
  });
  return b;
}

const isActive = (tab) => tab?.active && tab.windowId === myWindowId;

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== myWindowId) await chrome.windows.update(tab.windowId, { focused: true });
}

// ---- 状態の読み込みと描画 ----

async function loadState() {
  let tabSpace;
  ({ spaces, currentSpaceId, tabSpace } = await send('getSpaceState', { windowId: myWindowId }));
  const [shared, [spaceTree], tabs, { links = {}, tabTitles = {} }, { collapsed = [], splitFolders = [], liveFolders = {} }] = await Promise.all([
    chrome.bookmarks.getChildren(structure.favoritesId),
    chrome.bookmarks.getSubTree(currentSpaceId),
    chrome.tabs.query({ windowType: 'normal' }),
    chrome.storage.session.get(['links', 'tabTitles']),
    chrome.storage.local.get(['collapsed', 'splitFolders', 'liveFolders']),
  ]);
  const tabsById = new Map(tabs.map((t) => [t.id, t]));
  const spaceIds = new Set(spaces.map((sp) => sp.id));
  // タブのスペース。どのスペースにも入っていなければ null（今のスペースに出す）
  const spaceOfTab = (t) => (spaceIds.has(tabSpace[t.id]) ? tabSpace[t.id] : null);
  // Favorites はスペースごと（スペースの中の「Favorites」フォルダ）。以前の共通 Favorites は、移すまで後ろに並べる
  const favFolder = (spaceTree.children ?? []).find((n) => !n.url && n.title === FAVORITES_TITLE);
  spaceFavoritesId = favFolder?.id ?? null;
  return {
    spaceOfTab,
    favorites: [...(favFolder?.children ?? []), ...shared].filter((n) => n.url),
    pinnedChildren: (spaceTree.children ?? []).filter((n) => n !== favFolder),
    spaceTree,
    tabs,
    links,
    tabTitles,
    linkedTab: (bookmarkId) => tabsById.get(links[bookmarkId]),
    linkedTabIds: new Set(Object.values(links)),
    collapsed: new Set(collapsed),
    splitFolders: new Set(splitFolders),
    liveFolders: new Set(Object.values(liveFolders.folders ?? {})),
  };
}

async function render() {
  if (editing || !structure) return;
  const s = await loadState();
  const space = spaces.find((sp) => sp.id === currentSpaceId);
  document.documentElement.style.setProperty('--space', GROUP_HEX[space?.color] ?? 'transparent');
  renderSpaceBar();
  if (view === 'archive') return renderArchive();
  renderFavorites(s);
  renderSpaceName(space);
  $('pinned').replaceChildren(...s.pinnedChildren.map((n) => renderNode(n, s)));
  renderToday(s);
  if (slideDirection) {
    for (const id of ['space-name', 'pinned', 'today-section']) {
      const node = $(id);
      node.classList.remove('slide-left', 'slide-right');
      void node.offsetWidth; // アニメーションをやり直す
      node.classList.add(`slide-${slideDirection}`);
    }
    slideDirection = null;
    prevKeys = null; // スペースを切り替えたときは行ごとのアニメーションはしない
  }
  animateNewRows();
  if (pendingRenameId) {
    const id = pendingRenameId;
    pendingRenameId = null;
    startRename(id);
  }
}

function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => run(render()), Math.max(40, holdUntil - Date.now()));
}

// 前回の描画になかった行だけ、ふわっと出す
function animateNewRows() {
  const nodes = [...document.querySelectorAll('[data-key]')];
  const keys = new Set(nodes.map((n) => n.dataset.key));
  if (prevKeys) for (const n of nodes) if (!prevKeys.has(n.dataset.key)) n.classList.add('enter');
  prevKeys = keys;
}

function renderFavorites(s) {
  $('favorites').replaceChildren(
    ...s.favorites.map((bm) => {
      const tab = s.linkedTab(bm.id);
      const tile = el('button', {
        type: 'button',
        className: 'tile',
        title: bm.title || bm.url,
        dataset: { bookmarkId: bm.id, key: `b${bm.id}` },
      });
      tile.append(favicon(tab?.url ?? bm.url));
      if (!tab) tile.classList.add('closed');
      if (isActive(tab)) tile.classList.add('active');
      tile.addEventListener('click', () => run(send('openItem', { bookmarkId: bm.id, windowId: myWindowId })));
      tile.addEventListener('contextmenu', (e) =>
        openMenu(e, [
          tab && ['タブを閉じる', () => closeTab(tab, bm.id)],
          ['Favorites から外す', () => unpin(bm.id)],
        ]),
      );
      makeDraggable(tile, { kind: 'bookmark', id: bm.id, isFolder: false });
      dropTarget(tile, (e) => horizontal(e, tile), (data, pos) =>
        placeAt(data, bm.parentId, bm.index + (pos === 'after' ? 1 : 0)),
      );
      return tile;
    }),
  );
}

function renderNode(node, s) {
  if (!node.url && s.splitFolders.has(node.id)) return renderSplit(node, s);
  return node.url ? renderItem(node, s) : renderFolder(node, s);
}

// 2 つのアイコンを重ねて並べる（Split View のペア）
function faviconPair(urls) {
  return el('span', { className: 'favicon-pair' }, ...urls.map((u) => favicon(u)));
}

// 保存した Split View のペア（ピン留めの中のフォルダ）。押すと分割で開く
function renderSplit(folder, s) {
  const pair = (folder.children ?? []).filter((n) => n.url).slice(0, 2);
  const tabs = pair.map((bm) => s.linkedTab(bm.id));
  const open = tabs.some(Boolean);
  const title = el('span', { className: 'title', textContent: folder.title || pair.map((b) => b.title).join(' | ') });
  const closeBoth = () => closeTabs(pair.map((bm, i) => [tabs[i], bm.id]).filter(([t]) => t));
  const row = el(
    'div',
    { className: 'row item split', title: pair.map((b) => b.url).join('\n'), dataset: { bookmarkId: folder.id, key: `b${folder.id}` } },
    faviconPair(pair.map((bm, i) => tabs[i]?.url ?? bm.url)),
    title,
    open ? hoverButton('minus', closeBoth) : hoverButton('close', () => unpin(folder.id)),
  );
  if (!open) row.classList.add('closed');
  if (tabs.some(isActive)) row.classList.add('active');
  row.addEventListener('click', () => run(send('openSplit', { folderId: folder.id, windowId: myWindowId })));
  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(folder.id);
  });
  row.addEventListener('contextmenu', (e) =>
    openMenu(e, [
      ['名前を変更', () => startRename(folder.id)],
      open && ['タブを閉じる', closeBoth],
      null,
      ['ピン留めを外す', () => unpin(folder.id)],
    ]),
  );
  makeDraggable(row, { kind: 'bookmark', id: folder.id, isFolder: true, isSplit: true });
  dropTarget(row, (e) => (dragData?.kind === 'split' ? null : vertical(e, row, false)), (data, pos) =>
    placeAt(data, folder.parentId, folder.index + (pos === 'after' ? 1 : 0)),
  );
  return row;
}

// Live Folders（GitHub の PR を書き出すフォルダ）は、フォルダの絵ではなく GitHub のアイコンにする（Arc と同じ）
function folderIcon(folder, collapsed, live) {
  return live ? favicon('https://github.com/') : svg(collapsed ? 'folder' : 'folderOpen', 'folder-icon');
}

function renderFolder(folder, s) {
  const collapsed = s.collapsed.has(folder.id);
  const live = s.liveFolders.has(folder.id);
  const iconHolder = el('span', { className: 'favicon' }, folderIcon(folder, collapsed, live));
  const title = el('span', { className: 'title', textContent: folder.title || 'フォルダ' });
  const row = el('div', { className: `row folder${live ? ' live' : ''}`, dataset: { bookmarkId: folder.id, key: `b${folder.id}` } }, iconHolder, title);
  const children = el(
    'div',
    { className: `children${collapsed ? ' collapsed' : ''}` },
    el('div', { className: 'inner' }, ...(folder.children ?? []).map((n) => renderNode(n, s))),
  );

  row.addEventListener('click', () => {
    // DOM をその場で切り替えてアニメーションさせ、保存後の再描画は少し待つ
    const nowCollapsed = children.classList.toggle('collapsed');
    iconHolder.replaceChildren(folderIcon(folder, nowCollapsed, live));
    holdUntil = Date.now() + 260;
    run(toggleCollapsed(folder.id));
  });
  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(folder.id);
  });
  row.addEventListener('contextmenu', (e) =>
    openMenu(e, [
      ['名前を変更', () => startRename(folder.id)],
      ['中に新しいフォルダ', () => newFolder(folder.id)],
      null,
      ['削除', () => unpin(folder.id), true],
    ]),
  );
  makeDraggable(row, { kind: 'bookmark', id: folder.id, isFolder: true });
  dropTarget(row, (e) => vertical(e, row, true), (data, pos) =>
    pos === 'into'
      ? placeAt(data, folder.id, undefined)
      : placeAt(data, folder.parentId, folder.index + (pos === 'after' ? 1 : 0)),
  );
  return el('div', { className: 'node' }, row, children);
}

function renderItem(bm, s) {
  const tab = s.linkedTab(bm.id);
  const navigated = Boolean(tab?.url && tab.url !== bm.url);
  const title = el('span', { className: 'title', textContent: bm.title || bm.url });
  // Arc と同じく、タブが開いていれば −（タブだけ閉じる）、閉じていれば ×（ピン留めから外す）
  const row = el(
    'div',
    { className: 'row item', title: bm.url, dataset: { bookmarkId: bm.id, key: `b${bm.id}` } },
    el('span', { className: 'favicon' }, favicon(tab?.url ?? bm.url)),
    title,
    tab ? hoverButton('minus', () => closeTab(tab, bm.id)) : hoverButton('close', () => unpin(bm.id)),
  );
  if (!tab) row.classList.add('closed');
  if (isActive(tab)) row.classList.add('active');

  row.addEventListener('click', () => run(send('openItem', { bookmarkId: bm.id, windowId: myWindowId })));
  title.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(bm.id);
  });
  row.addEventListener('contextmenu', (e) =>
    openMenu(e, [
      navigated && ['元のページに戻す', () => send('resetItem', { bookmarkId: bm.id })],
      ['名前を変更', () => startRename(bm.id)],
      !isActive(tab) && ['今のタブと分割表示', () => splitWithActive({ bookmarkId: bm.id })],
      tab && ['タブを閉じる', () => closeTab(tab, bm.id)],
      null,
      ['ピン留めを外す', () => unpin(bm.id)],
    ]),
  );
  makeDraggable(row, { kind: 'bookmark', id: bm.id, isFolder: false });
  dropTarget(row, (e) => vertical(e, row, false), (data, pos) =>
    placeAt(data, bm.parentId, bm.index + (pos === 'after' ? 1 : 0)),
  );
  return row;
}

function renderToday(s) {
  const tabs = s.tabs
    .filter((t) => !s.linkedTabIds.has(t.id) && [currentSpaceId, null].includes(s.spaceOfTab(t)))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  // Split View で並べている 2 つのタブは 1 行にまとめる
  const rows = [];
  const doneSplits = new Set();
  for (const tab of tabs) {
    const sid = tab.splitViewId ?? -1;
    if (sid === -1) {
      rows.push(tab);
      continue;
    }
    if (doneSplits.has(sid)) continue;
    const pair = tabs.filter((t) => t.splitViewId === sid);
    doneSplits.add(sid);
    rows.push(pair.length >= 2 ? { split: pair.slice(0, 2) } : tab);
  }
  $('today').replaceChildren(
    ...rows.map((tab) => {
      if (tab.split) return renderTodaySplit(tab.split, s);
      const title = el('span', { className: 'title', textContent: s.tabTitles[tab.id] || tab.title || tab.url || '新しいタブ' });
      const row = el(
        'div',
        { className: 'row tab', title: tab.url ?? '', dataset: { tabId: String(tab.id), key: `t${tab.id}` } },
        el('span', { className: 'favicon' }, favicon(tab.url || tab.pendingUrl)),
        title,
        hoverButton('close', () => closeTab(tab)),
      );
      if (isActive(tab)) row.classList.add('active');
      row.addEventListener('click', () => run(focusTab(tab)));
      title.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRenameTab(tab.id);
      });
      row.addEventListener('auxclick', (e) => {
        if (e.button === 1) run(closeTab(tab)); // 中クリックで閉じる
      });
      row.addEventListener('contextmenu', (e) =>
        openMenu(e, [
          ['ピン留め', () => send('pinTab', { tabId: tab.id, parentId: currentSpaceId })],
          ['Favorites に追加', async () => send('pinTab', { tabId: tab.id, parentId: await ensureSpaceFavorites() })],
          ['名前を変更', () => startRenameTab(tab.id)],
          !isActive(tab) && ['今のタブと分割表示', () => splitWithActive({ tabId: tab.id })],
          null,
          ['タブを閉じる', () => closeTab(tab)],
        ]),
      );
      makeDraggable(row, { kind: 'tab', id: tab.id });
      // 今日のタブの行の前後に落とすと、その位置へ並べる（ピン留めなら外してから並べる）
      dropTarget(
        row,
        (e) => (canDropToday(dragData) ? vertical(e, row, false) : null),
        (data, pos) => dropIntoToday(data, dropPosition([tab], pos)),
      );
      return row;
    }),
  );
}

function renderTodaySplit(pair, s) {
  const names = pair.map((t) => s.tabTitles[t.id] || t.title || t.url || '新しいタブ');
  const row = el(
    'div',
    { className: 'row tab split', title: pair.map((t) => t.url ?? '').join('\n'), dataset: { tabId: String(pair[0].id), key: `s${pair[0].id}-${pair[1].id}` } },
    faviconPair(pair.map((t) => t.url || t.pendingUrl)),
    el('span', { className: 'title', textContent: names.join(' | ') }),
    hoverButton('close', () => closeTabs(pair.map((t) => [t]))),
  );
  if (pair.some(isActive)) row.classList.add('active');
  row.addEventListener('click', () => run(focusTab(pair[0])));
  row.addEventListener('contextmenu', (e) =>
    openMenu(e, [
      ['ピン留め', () => send('pinSplit', { tabIds: pair.map((t) => t.id), parentId: currentSpaceId })],
      ['分割を解除', () => unsplit(pair)],
      null,
      ['タブを閉じる', () => closeTabs(pair.map((t) => [t]))],
    ]),
  );
  makeDraggable(row, { kind: 'split', ids: pair.map((t) => t.id) });
  dropTarget(
    row,
    (e) => (canDropToday(dragData) ? vertical(e, row, false) : null),
    (data, pos) => dropIntoToday(data, dropPosition(pair, pos)),
  );
  return row;
}

// 複数のタブをまとめて閉じる（[tab, bookmarkId?] の並び）。Cmd+Z でまとめて戻る
async function closeTabs(entries) {
  const infos = entries.map(([t, bookmarkId]) => ({ url: t.url || t.pendingUrl, windowId: t.windowId, index: t.index, bookmarkId }));
  const pinned = entries.filter(([, b]) => b).map(([t]) => t.id);
  const today = entries.filter(([, b]) => !b).map(([t]) => t.id);
  if (pinned.length) await chrome.tabs.remove(pinned);
  if (today.length) await send('archiveTabs', { tabIds: today, reason: 'closed' });
  pushUndo(async () => {
    for (const info of infos) {
      await reopenClosed(info);
      if (!info.bookmarkId) await send('unarchiveLatest', { url: info.url }).catch(() => {});
    }
  });
}

// 今日のタブの欄へ落とせるもの: タブ・分割のペア・ピン留め・保存したペア（普通のフォルダは Arc と同じく不可）
function canDropToday(d) {
  return Boolean(d) && (d.kind !== 'bookmark' || !d.isFolder || d.isSplit);
}

// 今日のタブの欄へ落とす。at は落とした位置（{ windowId, index }）、欄の空いているところなら null。
// ピン留めは外して今日のタブにする（閉じていれば開く）。Cmd+Z でピン留めに戻り、開いたタブは閉じる
async function dropIntoToday(data, at) {
  if (data.kind === 'bookmark') {
    const [tree] = await chrome.bookmarks.getSubTree(data.id);
    const { links = {} } = await chrome.storage.session.get('links');
    const { splitFolders = [] } = await chrome.storage.local.get('splitFolders');
    const res = await send('unpinToToday', { bookmarkId: data.id, windowId: myWindowId, spaceId: currentSpaceId, at });
    if (!res) return;
    pushUndo(async () => {
      await restoreTree(tree, links, tree.parentId, tree.index, new Set(splitFolders));
      if (res.opened.length) await chrome.tabs.remove(res.opened).catch(() => {});
    });
    return;
  }
  if (!at) return;
  await send('moveTabs', { tabIds: data.kind === 'split' ? data.ids : [data.id], at });
}

// 行の前後どちらに落としたかから、並べる位置を決める（分割のペアは 2 つの外側）
function dropPosition(tabs, pos) {
  const indexes = tabs.map((t) => t.index);
  return { windowId: tabs[0].windowId, index: pos === 'after' ? Math.max(...indexes) + 1 : Math.min(...indexes) };
}

async function splitWithActive(target) {
  await send('splitWithActive', { ...target, windowId: myWindowId });
  const [active] = await chrome.tabs.query({ active: true, windowId: myWindowId });
  if (active) pushUndo(() => send('unsplit', { tabId: active.id }));
}

async function unsplit(pair) {
  await send('unsplit', { tabId: pair[0].id });
  pushUndo(() => send('splitTabs', { tabIds: pair.map((t) => t.id) }));
}

// ---- 操作（取り消せるものは undoStack に戻し方を積む）----

function pushUndo(fn) {
  undoStack.push(fn);
  if (undoStack.length > 50) undoStack.shift();
}

// ピン留め・Favorites のタブは閉じるだけ。今日のタブは閉じてアーカイブに残す（Arc と同じ）
async function closeTab(tab, bookmarkId) {
  const info = { url: tab.url || tab.pendingUrl, windowId: tab.windowId, index: tab.index, bookmarkId };
  if (bookmarkId) await chrome.tabs.remove(tab.id);
  else await send('archiveTabs', { tabIds: [tab.id], reason: 'closed' });
  pushUndo(async () => {
    await reopenClosed(info);
    if (!bookmarkId) await send('unarchiveLatest', { url: info.url }).catch(() => {});
  });
}

// 閉じたタブを戻す。履歴ごと戻せるよう sessions.restore を優先する
async function reopenClosed(info) {
  let tabId;
  const recent = await chrome.sessions.getRecentlyClosed({ maxResults: 25 }).catch(() => []);
  const entry = recent.find((e) => e.tab?.url === info.url);
  if (entry) tabId = (await chrome.sessions.restore(entry.tab.sessionId).catch(() => null))?.tab?.id;
  if (tabId == null) {
    const tab = await chrome.tabs
      .create({ url: info.url, windowId: info.windowId, index: info.index })
      .catch(() => chrome.tabs.create({ url: info.url }));
    tabId = tab.id;
  }
  if (info.bookmarkId) await send('link', { bookmarkId: info.bookmarkId, tabId }).catch(() => {});
}

// ピン留め・フォルダ・Favorites を外す。タブは閉じない
async function unpin(bookmarkId) {
  const [tree] = await chrome.bookmarks.getSubTree(bookmarkId);
  const { links = {} } = await chrome.storage.session.get('links');
  const { splitFolders = [] } = await chrome.storage.local.get('splitFolders');
  const splits = new Set(splitFolders);
  await send('unpin', { bookmarkId });
  pushUndo(() => restoreTree(tree, links, tree.parentId, tree.index, splits));
}

async function restoreTree(node, links, parentId, index, splits = new Set()) {
  const created = await chrome.bookmarks.create({ parentId, index, title: node.title, url: node.url });
  if (splits.has(node.id)) await send('markSplit', { folderId: created.id });
  const tabId = links[node.id];
  if (node.url && tabId != null && (await chrome.tabs.get(tabId).catch(() => null))) {
    await send('link', { bookmarkId: created.id, tabId });
  }
  for (const child of node.children ?? []) await restoreTree(child, links, created.id, undefined, splits);
}

async function newFolder(parentId) {
  const folder = await chrome.bookmarks.create({ parentId, title: '新しいフォルダ' });
  pendingRenameId = folder.id;
  scheduleRender();
}

// ショートカットやメニューでまとめて開閉したときも、その場で滑らかに開閉させてから描き直す
function animateFolders(collapsedIds) {
  let changed = false;
  for (const row of document.querySelectorAll('.row.folder')) {
    const children = row.nextElementSibling;
    if (!children?.classList.contains('children')) continue;
    const want = collapsedIds.has(row.dataset.bookmarkId);
    if (children.classList.contains('collapsed') === want) continue;
    children.classList.toggle('collapsed', want);
    if (!row.classList.contains('live')) row.querySelector('.favicon')?.replaceChildren(svg(want ? 'folder' : 'folderOpen', 'folder-icon'));
    changed = true;
  }
  if (changed) holdUntil = Date.now() + 260;
}

async function toggleCollapsed(id) {
  const { collapsed = [] } = await chrome.storage.local.get('collapsed');
  const set = new Set(collapsed);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  await chrome.storage.local.set({ collapsed: [...set] });
}

function startRename(bookmarkId) {
  const row = document.querySelector(`.row[data-bookmark-id="${CSS.escape(bookmarkId)}"]`);
  editTitle(row, (value) => chrome.bookmarks.update(bookmarkId, { title: value }));
}

// 今日のタブの名前はサイドバー上の表示名として持つ（タブ自体の title は変えられない）
function startRenameTab(tabId) {
  const row = document.querySelector(`.row[data-tab-id="${tabId}"]`);
  editTitle(row, (value) => send('renameTab', { tabId, title: value }));
}

function editTitle(row, save) {
  const title = row?.querySelector('.title');
  if (!title) return;
  editing = true;
  row.draggable = false;
  const input = el('input', { className: 'rename', value: title.textContent, spellcheck: false });
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    editing = false;
    const value = input.value.trim();
    if (commit && value && value !== title.textContent) await save(value);
    scheduleRender();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') run(finish(true));
    if (e.key === 'Escape') run(finish(false));
  });
  input.addEventListener('blur', () => run(finish(true)));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---- Spaces ----

function renderSpaceBar() {
  const bar = $('space-bar');
  const archiveButton = el('button', { type: 'button', className: 'icon-button', tabIndex: -1, title: 'アーカイブ' }, svg('archive'));
  archiveButton.addEventListener('click', () => setView(view === 'archive' ? 'main' : 'archive'));
  archiveButton.addEventListener('contextmenu', (e) => openMenu(e, [['設定', () => chrome.runtime.openOptionsPage()]]));

  // スペースが 1 つのとき（1 プロファイル = 1 スペースで使うとき）は点を出さない。場所だけ残してボタンの位置は変えない
  const dots = el(
    'div',
    { className: 'space-dots' },
    ...(spaces.length <= 1 ? [] : spaces).map((sp) => {
      const dot = el(
        'button',
        { type: 'button', className: `space-dot${sp.id === currentSpaceId ? ' current' : ''}${sp.icon ? ' has-icon' : ''}`, title: sp.title, tabIndex: -1 },
        sp.icon ? el('span', { className: 'space-emoji', textContent: sp.icon }) : null,
      );
      dot.style.setProperty('--dot', GROUP_HEX[sp.color] ?? 'var(--muted)');
      dot.addEventListener('click', () => run(goToSpace(sp.id)));
      dot.addEventListener('contextmenu', (e) =>
        openMenu(e, [
          ['名前を変更', () => goToSpace(sp.id).then(() => startRenameSpace())],
          ['アイコンを変更', () => openIconPicker(sp.id, dot)],
          spaces.length > 1 && null,
          spaces.length > 1 && ['スペースを削除', () => deleteSpace(sp.id), true],
        ]),
      );
      // タブをスペースの点へ落とすと、そのスペースへ移す
      dropTarget(dot, () => (dragData?.kind === 'tab' ? 'into' : null), (data) => moveTabToSpace(data.id, sp.id));
      return dot;
    }),
  );

  const add = el('button', { type: 'button', className: 'icon-button', tabIndex: -1, title: '新しいスペース' }, svg('plus'));
  add.addEventListener('click', () => run(createSpace()));
  bar.replaceChildren(archiveButton, dots, add);
}

async function goToSpace(spaceId) {
  if (spaceId === currentSpaceId) return setView('main');
  const from = spaces.findIndex((sp) => sp.id === currentSpaceId);
  const to = spaces.findIndex((sp) => sp.id === spaceId);
  slideDirection = to > from ? 'left' : 'right';
  spaceFavoritesId = null;
  view = 'main';
  showView();
  await send('switchSpace', { windowId: myWindowId, spaceId });
  scheduleRender();
}

async function switchSpaceBy(step) {
  const i = spaces.findIndex((sp) => sp.id === currentSpaceId);
  const next = spaces[i + step];
  if (next) await goToSpace(next.id);
}

async function createSpace() {
  slideDirection = 'left';
  await send('createSpace', { windowId: myWindowId, title: '新しいスペース' });
  await render();
  startRenameSpace();
}

// スペース名の行: アイコン（あれば）と名前。アイコンを押すと選び直せる
function renderSpaceName(space) {
  const label = $('space-name');
  if (!space) return label.replaceChildren();
  const icon = space.icon ? el('span', { className: 'space-icon', textContent: space.icon, title: 'アイコンを変更' }) : null;
  icon?.addEventListener('click', (e) => {
    e.stopPropagation();
    openIconPicker(space.id, icon);
  });
  label.replaceChildren(...[icon, el('span', { className: 'space-title', textContent: space.title })].filter(Boolean));
}

function startRenameSpace() {
  const title = $('space-name').querySelector('.space-title');
  const space = spaces.find((sp) => sp.id === currentSpaceId);
  if (!title || !space || editing) return;
  editing = true;
  const input = el('input', { className: 'rename', value: space.title, spellcheck: false });
  input.style.margin = '0';
  title.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    editing = false;
    const value = input.value.trim();
    if (commit && value && !spaces.some((sp) => sp.title === value)) {
      await send('renameSpace', { spaceId: currentSpaceId, title: value });
    }
    scheduleRender();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') run(finish(true));
    if (e.key === 'Escape') run(finish(false));
  });
  input.addEventListener('blur', () => run(finish(true)));
}

// ---- スペースのアイコン（絵文字）----

const ICON_PRESETS = ['🏠', '💼', '🚀', '🪐', '⭐', '❤️', '🔥', '⚡', '🌸', '🍃', '🌙', '☀️', '📚', '🎓', '🎨', '🎮', '🎵', '📷', '✈️', '☕', '💡', '📈', '🛒', '🐾'];

// 入力された文字列の最初の 1 文字（絵文字は複数のコードポイントでできていることがあるので書記素で数える）
function firstGrapheme(text) {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...seg.segment(text.trim())][0]?.segment ?? '';
}

function closeIconPicker() {
  document.getElementById('icon-picker')?.remove();
}

function openIconPicker(spaceId, anchor) {
  closeIconPicker();
  closeMenu();
  const choose = (icon) => {
    closeIconPicker();
    run(send('setSpaceIcon', { spaceId, icon }));
  };
  const grid = el(
    'div',
    { className: 'icon-grid' },
    ...ICON_PRESETS.map((emoji) => {
      const b = el('button', { type: 'button', className: 'icon-choice', textContent: emoji, tabIndex: -1 });
      b.addEventListener('click', () => choose(emoji));
      return b;
    }),
  );
  // 一覧にない絵文字は入力欄から（Ctrl+Cmd+Space で macOS の絵文字ピッカーが開く）
  const input = el('input', { className: 'search', placeholder: '絵文字', spellcheck: false });
  input.addEventListener('input', () => {
    const g = firstGrapheme(input.value);
    if (g && /\p{Extended_Pictographic}/u.test(g)) choose(g);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeIconPicker();
    if (e.key === 'Enter' && firstGrapheme(input.value)) choose(firstGrapheme(input.value));
  });
  const none = el('button', { type: 'button', className: 'icon-button', title: 'アイコンなし', tabIndex: -1 }, svg('close'));
  none.addEventListener('click', () => choose(null));
  const picker = el('div', { id: 'icon-picker', className: 'icon-picker' }, grid, el('div', { className: 'icon-picker-foot' }, input, none));
  picker.addEventListener('click', (e) => e.stopPropagation());
  document.body.append(picker);
  const r = anchor.getBoundingClientRect();
  const p = picker.getBoundingClientRect();
  picker.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - p.width - 4))}px`;
  picker.style.top = `${r.bottom + p.height + 4 < window.innerHeight ? r.bottom + 4 : Math.max(4, r.top - p.height - 4)}px`;
  input.focus();
}

// スペースを消す。ピン留めは消えるが、タブは閉じない。Cmd+Z で戻せる
async function deleteSpace(spaceId) {
  if (spaces.length <= 1) return;
  if (spaceId === currentSpaceId) {
    const other = spaces.find((sp) => sp.id !== spaceId);
    await goToSpace(other.id);
  }
  await unpin(spaceId);
}

async function moveTabToSpace(tabId, spaceId) {
  await send('moveTabToSpace', { tabId, spaceId });
}

// ---- アーカイブ ----

function setView(next) {
  view = next;
  showView();
  if (view === 'archive') {
    $('archive-search').value = '';
    $('archive-search').focus();
  }
  run(render());
}

function showView() {
  $('main-view').hidden = view !== 'main';
  $('archive-view').hidden = view !== 'archive';
}

function relativeTime(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}時間前`;
  return `${Math.round(h / 24)}日前`;
}

async function renderArchive() {
  const { archive = [] } = await chrome.storage.local.get('archive');
  const q = $('archive-search').value.trim().toLowerCase();
  const items = q
    ? archive.filter((e) => `${e.title} ${e.url}`.toLowerCase().includes(q))
    : archive;
  $('archive-list').replaceChildren(
    ...items.slice(0, 200).map((entry) => {
      const row = el(
        'div',
        { className: 'row', title: entry.url },
        el('span', { className: 'favicon' }, favicon(entry.url)),
        el('span', { className: 'title', textContent: entry.title || entry.url }),
        el('span', { className: 'meta', textContent: relativeTime(entry.archivedAt) }),
        hoverButton('close', () => send('deleteArchived', { id: entry.id })),
      );
      row.addEventListener('click', () =>
        run(send('restoreArchived', { id: entry.id, windowId: myWindowId }).then(() => setView('main'))),
      );
      return row;
    }),
  );
}

// 今日のタブ（このスペースの分）をまとめてアーカイブ。このウィンドウで表示中のタブは残す
async function clearToday() {
  const s = await loadState();
  const targets = s.tabs.filter(
    (t) => !s.linkedTabIds.has(t.id) && [currentSpaceId, null].includes(s.spaceOfTab(t)) && !isActive(t),
  );
  if (!targets.length) return;
  const infos = targets.map((t) => ({ url: t.url || t.pendingUrl, windowId: t.windowId, index: t.index }));
  await send('archiveTabs', { tabIds: targets.map((t) => t.id), reason: 'clear' });
  pushUndo(async () => {
    for (const info of infos.reverse()) {
      await reopenClosed(info);
      await send('unarchiveLatest', { url: info.url }).catch(() => {});
    }
  });
}

async function ensureSpaceFavorites() {
  spaceFavoritesId ??= await send('ensureSpaceFavorites', { spaceId: currentSpaceId });
  return spaceFavoritesId;
}

async function placeAt(data, parentId, index) {
  if (data.kind === 'tab') return send('pinTab', { tabId: data.id, parentId, index });
  if (data.kind === 'split') {
    if (parentId === structure.favoritesId || parentId === spaceFavoritesId) return; // Favorites にはペアを置かない
    return send('pinSplit', { tabIds: data.ids, parentId, index });
  }
  // Favorites はフォルダなしの平らな並び
  if (data.isFolder && (parentId === structure.favoritesId || parentId === spaceFavoritesId)) return;
  if (data.id === parentId) return;
  await chrome.bookmarks.move(data.id, index === undefined ? { parentId } : { parentId, index });
}

// ---- 右クリックのメニュー ----

function openMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  const menu = $('menu');
  menu.replaceChildren(
    ...items
      .filter((item) => item !== false && item !== undefined)
      .map((item) => {
        if (item === null) return el('div', { className: 'menu-sep' });
        const [label, action, danger] = item;
        const b = el('button', { type: 'button', className: `menu-item${danger ? ' danger' : ''}`, textContent: label });
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeMenu();
          run(action());
        });
        return b;
      }),
  );
  menu.hidden = false;
  const { innerWidth: w, innerHeight: h } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, w - r.width - 4)}px`;
  menu.style.top = `${Math.min(e.clientY, h - r.height - 4)}px`;
}

function closeMenu() {
  $('menu').hidden = true;
}

// ---- ドラッグ＆ドロップ ----

function clearDropMarks() {
  for (const n of document.querySelectorAll('.drop-before, .drop-after, .drop-into, .drop-zone')) {
    n.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-zone');
  }
}

function makeDraggable(node, data) {
  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    dragData = data;
    closeMenu();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${data.kind}:${data.id}`);
    // ドラッグ開始の瞬間に見た目を変えると、ドラッグ画像まで薄くなるので次のフレームで
    requestAnimationFrame(() => {
      node.classList.add('dragging');
      document.body.classList.add('is-dragging');
    });
  });
  node.addEventListener('dragend', () => {
    dragData = null;
    node.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    clearDropMarks();
  });
}

function vertical(e, node, allowInto) {
  const r = node.getBoundingClientRect();
  const ratio = (e.clientY - r.top) / r.height;
  if (allowInto) return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into';
  return ratio < 0.5 ? 'before' : 'after';
}

function horizontal(e, node) {
  const r = node.getBoundingClientRect();
  return e.clientX - r.left < r.width / 2 ? 'before' : 'after';
}

// positionOf が null を返す場所には落とせない
function dropTarget(node, positionOf, onDrop) {
  node.addEventListener('dragover', (e) => {
    if (!dragData) return;
    const pos = positionOf(e);
    if (!pos) return;
    e.preventDefault();
    e.stopPropagation();
    if (!node.classList.contains(`drop-${pos}`)) {
      clearDropMarks();
      node.classList.add(`drop-${pos}`);
    }
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-zone');
  });
  node.addEventListener('drop', (e) => {
    if (!dragData) return;
    const pos = positionOf(e);
    if (!pos) return;
    e.preventDefault();
    e.stopPropagation();
    const data = dragData;
    clearDropMarks();
    run(onDrop(data, pos));
  });
}

function setup() {
  // 空いている場所に落としたら末尾に置く
  dropTarget($('favorites'), () => (dragData?.isFolder || dragData?.kind === 'split' ? null : 'zone'), async (data) => placeAt(data, await ensureSpaceFavorites(), undefined));
  dropTarget($('pinned'), () => 'zone', (data) => placeAt(data, currentSpaceId, undefined));
  // 今日のタブの欄（仕切り線から下の全体）へ落としたらピン留めを外して今日のタブにする（閉じていれば開く）
  dropTarget($('today-section'), () => (dragData?.kind === 'bookmark' && canDropToday(dragData) ? 'zone' : null), (data) => dropIntoToday(data, null));

  const newTab = $('new-tab');
  newTab.append(el('span', { className: 'favicon' }, svg('plus')), el('span', { className: 'title', textContent: '新しいタブ' }));
  newTab.addEventListener('click', () => run(chrome.tabs.create({ windowId: myWindowId })));

  // ピン留め欄の空いているところを右クリックするとフォルダを作れる
  $('pinned').addEventListener('contextmenu', (e) =>
    openMenu(e, [
      ['新しいフォルダ', () => newFolder(currentSpaceId)],
      null,
      ['フォルダをすべて閉じる', () => send('setAllFolders', { spaceId: currentSpaceId, collapsed: true })],
      ['フォルダをすべて開く', () => send('setAllFolders', { spaceId: currentSpaceId, collapsed: false })],
    ]),
  );
  // スペース名: ダブルクリックで名前を変える。右クリックでメニュー
  $('space-name').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.space-icon')) startRenameSpace();
  });
  $('space-name').addEventListener('contextmenu', (e) =>
    openMenu(e, [
      ['名前を変更', () => startRenameSpace()],
      ['アイコンを変更', () => openIconPicker(currentSpaceId, $('space-name'))],
      ['新しいフォルダ', () => newFolder(currentSpaceId)],
      null,
      ['フォルダをすべて閉じる', () => send('setAllFolders', { spaceId: currentSpaceId, collapsed: true })],
      ['フォルダをすべて開く', () => send('setAllFolders', { spaceId: currentSpaceId, collapsed: false })],
      spaces.length > 1 && null,
      spaces.length > 1 && ['スペースを削除', () => deleteSpace(currentSpaceId), true],
    ]),
  );

  // Clear: 今日のタブ（このスペースの分）をまとめてアーカイブ。表示中のタブだけ残す
  $('clear').append(svg('down'), document.createTextNode('Clear'));
  $('clear').addEventListener('click', (e) => {
    e.stopPropagation();
    run(clearToday());
  });

  // アーカイブ画面
  $('archive-back').append(svg('back'));
  $('archive-back').addEventListener('click', () => setView('main'));
  $('archive-search').addEventListener('input', () => run(renderArchive()));

  // 二本指の横スワイプでスペースを切り替える。
  // 横向きのスワイプはここで止め、Chrome の「スワイプで戻る」（左端ホバーの表示ではページ側の戻る）に渡さない
  let swipe = 0;
  let swipeLock = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (view !== 'main' || Date.now() < swipeLock) return;
      swipe += e.deltaX;
      if (Math.abs(swipe) > 90) {
        run(switchSpaceBy(swipe > 0 ? 1 : -1));
        swipe = 0;
        swipeLock = Date.now() + 450;
      }
    },
    { passive: false }, // preventDefault するため
  );

  document.addEventListener('click', () => {
    closeMenu();
    closeIconPicker();
  });
  window.addEventListener('blur', closeMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      closeIconPicker();
      if (view === 'archive' && !editing) setView('main');
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !editing) {
      e.preventDefault();
      const undo = undoStack.pop();
      if (undo) run(undo());
    }
  });
}

function subscribe() {
  const tabEvents = ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved', 'onAttached', 'onDetached', 'onReplaced'];
  for (const name of tabEvents) chrome.tabs[name].addListener(scheduleRender);
  for (const name of ['onCreated', 'onChanged', 'onMoved', 'onChildrenReordered']) {
    chrome.bookmarks[name].addListener(scheduleRender);
  }
  // 構成フォルダごと消された場合に備えて、構成を取り直してから描く
  chrome.bookmarks.onRemoved.addListener(() =>
    run(send('init').then((s) => {
      structure = s;
      scheduleRender();
    })),
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.collapsed) animateFolders(new Set(changes.collapsed.newValue ?? []));
    const session = area === 'session' && (changes.links || changes.tabTitles || changes.currentSpace || changes.tabSpace);
    const local = area === 'local' && (changes.collapsed || changes.splitFolders || changes.liveFolders || changes.spaceColors || changes.spaceIcons || (changes.archive && view === 'archive'));
    if (session || local) scheduleRender();
  });
}

async function init() {
  // 重ねて出す表示のときは、edge.js が発行したトークンを持っているときだけ中身を出す
  const params = new URLSearchParams(location.search);
  if (window.top !== window) {
    const ok = await send('checkOverlayToken', { token: params.get('token') }).catch((e) => String(e));
    // 開発用の記録（dev/state.html で見る）
    chrome.storage.local.set({ overlayDiag: { at: new Date().toISOString(), ok } });
    if (ok !== true) return;
  }
  myWindowId = (await chrome.windows.getCurrent()).id;
  structure = await send('init');
  setup();
  subscribe();
  await render();
}

run(init());
