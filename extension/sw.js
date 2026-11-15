// Service Worker（拡張は 1 つ。コマンドバー・Peek は cmdbar-sw.js、Little Arc は little-arc-sw.js、Live Folders は live-folders-sw.js に分けてある）
// - ブックマーク上のフォルダ構成（その他のブックマーク/Arc/...）を用意する
// - ブックマークとタブの対応（storage.session の links）はここだけで書き換える
// - ショートカットでサイドパネルを開閉する
// - Spaces: Spaces/ の下のフォルダ 1 つが 1 スペース。どのタブがどのスペースかは拡張が覚えておく
// - 自動アーカイブ: しばらく触っていない今日のタブを閉じて、アーカイブ（storage.local）に残す

import './cmdbar-sw.js';
import './little-arc-sw.js';
import './live-folders-sw.js';

const ROOT_TITLE = 'Arc';
const FAVORITES_TITLE = 'Favorites';
const SPACES_TITLE = 'Spaces';
const DEFAULT_SPACE_TITLE = 'Home';

// ---- フォルダ構成 ----

async function findOtherBookmarks() {
  const [root] = await chrome.bookmarks.getTree();
  const others = root.children.filter((n) => n.folderType === 'other' || n.id === '2');
  // 同期される方を優先する（iPhone の Chrome から見えるように）
  return others.find((n) => n.syncing) ?? others[0];
}

async function ensureChildFolder(parentId, title) {
  const children = await chrome.bookmarks.getChildren(parentId);
  return children.find((c) => !c.url && c.title === title) ?? chrome.bookmarks.create({ parentId, title });
}

async function buildStructure() {
  const other = await findOtherBookmarks();
  const root = await ensureChildFolder(other.id, ROOT_TITLE);
  const favorites = await ensureChildFolder(root.id, FAVORITES_TITLE);
  const spaces = await ensureChildFolder(root.id, SPACES_TITLE);
  // 既定のスペースは Spaces の最初のフォルダ。名前を変えても作り直さない。1 つもなければ Home を作る
  const space =
    (await chrome.bookmarks.getChildren(spaces.id)).find((c) => !c.url) ??
    (await chrome.bookmarks.create({ parentId: spaces.id, title: DEFAULT_SPACE_TITLE }));
  return {
    rootId: root.id,
    favoritesId: favorites.id,
    spacesId: spaces.id,
    spaceId: space.id,
    syncing: Boolean(other.syncing),
  };
}

// 同時に作ってフォルダが重複しないよう、作成は 1 本の鎖で順番に行う
let structurePromise = null;
let buildChain = Promise.resolve();
function getStructure() {
  if (!structurePromise) {
    structurePromise = buildChain = buildChain.catch(() => {}).then(buildStructure);
    structurePromise.catch(() => (structurePromise = null));
  }
  return structurePromise;
}

// ---- ブックマークとタブの対応（bookmarkId -> tabId）----

async function getLinks() {
  return (await chrome.storage.session.get('links')).links ?? {};
}

let linkChain = Promise.resolve();
function updateLinks(mutate) {
  linkChain = linkChain.catch(() => {}).then(async () => {
    const links = await getLinks();
    mutate(links);
    await chrome.storage.session.set({ links });
    return links;
  });
  return linkChain;
}

function link(bookmarkId, tabId) {
  return updateLinks((links) => {
    // 1 つのタブは 1 つのブックマークにだけ対応させる
    for (const [bid, tid] of Object.entries(links)) if (tid === tabId) delete links[bid];
    links[bookmarkId] = tabId;
  });
}

function flatten(node, out = []) {
  out.push(node);
  for (const c of node.children ?? []) flatten(c, out);
  return out;
}

// Chrome の再起動などで対応が消えたとき、URL が一致する開いているタブと結び直す
async function relinkByUrl() {
  const { rootId } = await getStructure();
  const [tree] = await chrome.bookmarks.getSubTree(rootId);
  const bookmarks = flatten(tree).filter((n) => n.url);
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const tabIds = new Set(tabs.map((t) => t.id));
  await updateLinks((links) => {
    for (const [bid, tid] of Object.entries(links)) if (!tabIds.has(tid)) delete links[bid];
    const used = new Set(Object.values(links));
    for (const bm of bookmarks) {
      if (links[bm.id] != null) continue;
      const tab = tabs.find((t) => !used.has(t.id) && t.url === bm.url);
      if (tab) {
        links[bm.id] = tab.id;
        used.add(tab.id);
      }
    }
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  updateLinks((links) => {
    for (const [bid, tid] of Object.entries(links)) if (tid === tabId) delete links[bid];
  });
  updateTabSpace((tabSpace) => {
    delete tabSpace[tabId];
  });
  const { overlayTokens = {}, tabTitles = {} } = await chrome.storage.session.get(['overlayTokens', 'tabTitles']);
  const kept = Object.fromEntries(Object.entries(overlayTokens).filter(([, tid]) => tid !== tabId));
  if (Object.keys(kept).length !== Object.keys(overlayTokens).length) await chrome.storage.session.set({ overlayTokens: kept });
  if (tabTitles[tabId] !== undefined) {
    delete tabTitles[tabId];
    await chrome.storage.session.set({ tabTitles });
  }
});

chrome.bookmarks.onRemoved.addListener((id, { node }) => {
  structurePromise = null; // 構成フォルダが消された場合に作り直す
  const ids = new Set(flatten(node).map((n) => n.id));
  ids.add(id);
  updateLinks((links) => {
    for (const bid of Object.keys(links)) if (ids.has(bid)) delete links[bid];
  });
  // 消したフォルダが保存したペアなら、印も消す
  getSplitFolders().then((set) => {
    if ([...ids].some((i) => set.has(i))) chrome.storage.local.set({ splitFolders: [...set].filter((i) => !ids.has(i)) });
  });
});

// ---- Spaces ----
// スペース = Spaces/ の下のフォルダ。どのタブがどのスペースかは拡張が覚えておく（storage.session の tabSpace）。
// Chrome のタブグループは使わない（グループは Chrome に自動保存されて溜まり、拡張からは消せないため）。
// タブの ID は Chrome を再起動すると変わるので、URL → スペースも storage.local に控え、起動後に振り直す。

const SPACE_COLORS = ['blue', 'purple', 'pink', 'orange', 'green', 'cyan', 'red', 'yellow', 'grey'];

async function listSpaces() {
  const { spacesId } = await getStructure();
  const folders = (await chrome.bookmarks.getChildren(spacesId)).filter((n) => !n.url);
  const { spaceColors = {}, spaceIcons = {} } = await chrome.storage.local.get(['spaceColors', 'spaceIcons']);
  let changed = false;
  const spaces = folders.map((f, i) => {
    if (!spaceColors[f.id]) {
      spaceColors[f.id] = SPACE_COLORS[i % SPACE_COLORS.length];
      changed = true;
    }
    return { id: f.id, title: f.title, color: spaceColors[f.id], icon: spaceIcons[f.id] ?? null };
  });
  if (changed) await chrome.storage.local.set({ spaceColors });
  return spaces;
}

async function getCurrentSpaceId(windowId, spaces) {
  const { currentSpace = {} } = await chrome.storage.session.get('currentSpace');
  const id = currentSpace[windowId];
  if (id && spaces.some((s) => s.id === id)) return id;
  return spaces[0]?.id ?? (await getStructure()).spaceId;
}

async function setCurrentSpaceId(windowId, spaceId) {
  const { currentSpace = {} } = await chrome.storage.session.get('currentSpace');
  currentSpace[windowId] = spaceId;
  await chrome.storage.session.set({ currentSpace });
}

// ブックマークがどのスペースの下にあるか（Favorites なら null）
async function spaceOfBookmark(bookmarkId) {
  const { spacesId } = await getStructure();
  let node = (await chrome.bookmarks.get(bookmarkId))[0];
  while (node?.parentId) {
    if (node.parentId === spacesId) return node.id;
    node = (await chrome.bookmarks.get(node.parentId))[0];
  }
  return null;
}

// tabSpace（tabId -> spaceId）の書き換えは 1 本の鎖で順番に行う
let tabSpaceChain = Promise.resolve();
function updateTabSpace(mutate) {
  tabSpaceChain = tabSpaceChain.catch(() => {}).then(async () => {
    const { tabSpace = {} } = await chrome.storage.session.get('tabSpace');
    await mutate(tabSpace);
    await chrome.storage.session.set({ tabSpace });
    return tabSpace;
  });
  return tabSpaceChain;
}

async function getTabSpace() {
  return (await chrome.storage.session.get('tabSpace')).tabSpace ?? {};
}

// 再起動後に振り直すための控え（URL -> spaceId）
async function rememberUrl(url, spaceId) {
  if (!url || !/^https?:/.test(url)) return;
  const { spaceByUrl = {} } = await chrome.storage.local.get('spaceByUrl');
  if (spaceId) spaceByUrl[url] = spaceId;
  else delete spaceByUrl[url];
  // 増えすぎないよう、古いものから捨てる
  const keys = Object.keys(spaceByUrl);
  for (const k of keys.slice(0, Math.max(0, keys.length - 1000))) delete spaceByUrl[k];
  await chrome.storage.local.set({ spaceByUrl });
}

async function assignTab(tabId, spaceId) {
  await updateTabSpace((tabSpace) => {
    if (spaceId) tabSpace[tabId] = spaceId;
    else delete tabSpace[tabId];
  });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await rememberUrl(tab.url || tab.pendingUrl, spaceId);
}

// スペースごとの Favorites = スペースのフォルダの中の「Favorites」フォルダ（Arc はプロファイルごとに Favorites が分かれていたため）。
// Arc/Favorites（全スペース共通）は以前の形で、設定ページから各スペースへ移すまで全スペースに出す。
async function getSpaceFavoritesFolder(spaceId, create) {
  const children = await chrome.bookmarks.getChildren(spaceId);
  const found = children.find((c) => !c.url && c.title === FAVORITES_TITLE);
  if (found || !create) return found ?? null;
  return chrome.bookmarks.create({ parentId: spaceId, index: 0, title: FAVORITES_TITLE });
}

// 以前の共通 Favorites のタブかどうか（スペースへ自動で入れない）
async function isFavoriteTab(tabId) {
  const { favoritesId } = await getStructure();
  const links = await getLinks();
  const bid = Object.keys(links).find((k) => links[k] === tabId);
  if (!bid) return false;
  const [bm] = await chrome.bookmarks.get(bid).catch(() => []);
  return bm?.parentId === favoritesId;
}

// どのスペースにも入っていないタブを、そのウィンドウの今のスペースへ入れる
async function adoptIntoCurrentSpace(tab) {
  if (!tab || (await getTabSpace())[tab.id]) return;
  if (await isFavoriteTab(tab.id)) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win?.type !== 'normal') return;
  const spaces = await listSpaces();
  await assignTab(tab.id, await getCurrentSpaceId(tab.windowId, spaces));
}

// 新しいタブ: リンクから開いたタブは開いたタブと同じスペース、それ以外は今のスペース
chrome.tabs.onCreated.addListener(async (tab) => {
  const tabSpace = await getTabSpace();
  if (tab.openerTabId != null && tabSpace[tab.openerTabId]) return assignTab(tab.id, tabSpace[tab.openerTabId]);
  // 拡張（openItem / restoreArchived）が作ったタブは、そちらで割り当てる
  setTimeout(async () => adoptIntoCurrentSpace(await chrome.tabs.get(tab.id).catch(() => null)), 300);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await adoptIntoCurrentSpace(tab);
  // スペースごとに最後に見ていたタブを覚えておく（切り替えたときにそこへ戻る）
  const spaceId = (await getTabSpace())[tabId];
  if (spaceId) {
    const { lastTabBySpace = {} } = await chrome.storage.session.get('lastTabBySpace');
    lastTabBySpace[`${tab.windowId}:${spaceId}`] = tabId;
    await chrome.storage.session.set({ lastTabBySpace });
  }
});

// URL が変わったら控えも更新する
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const spaceId = (await getTabSpace())[tabId];
  if (spaceId) await rememberUrl(info.url, spaceId);
});

// Chrome の再起動などで対応が消えたタブを、URL の控えからスペースへ戻す
async function reassignByUrl() {
  const { spaceByUrl = {} } = await chrome.storage.local.get('spaceByUrl');
  const spaces = new Set((await listSpaces()).map((s) => s.id));
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const alive = new Set(tabs.map((t) => t.id));
  await updateTabSpace((tabSpace) => {
    for (const id of Object.keys(tabSpace)) if (!alive.has(Number(id)) || !spaces.has(tabSpace[id])) delete tabSpace[id];
    for (const t of tabs) {
      const sid = spaceByUrl[t.url];
      if (!tabSpace[t.id] && sid && spaces.has(sid)) tabSpace[t.id] = sid;
    }
  });
}

// スペースを切り替える: そのスペースで最後に見ていたタブ（なければそのスペースのタブ、それもなければ新しいタブ）を表示する
async function switchSpace(windowId, spaceId) {
  const spaces = await listSpaces();
  if (!spaces.some((s) => s.id === spaceId)) return null;
  await setCurrentSpaceId(windowId, spaceId);
  const tabSpace = await getTabSpace();
  const inSpace = (t) => tabSpace[t.id] === spaceId;
  const { lastTabBySpace = {} } = await chrome.storage.session.get('lastTabBySpace');
  const linked = new Set(Object.values(await getLinks()));
  const tabs = await chrome.tabs.query({ windowId });
  let target = tabs.find((t) => t.id === lastTabBySpace[`${windowId}:${spaceId}`] && inSpace(t));
  target ??= tabs.find((t) => inSpace(t) && !linked.has(t.id)) ?? tabs.find(inSpace);
  if (target) await chrome.tabs.update(target.id, { active: true });
  else {
    const created = await chrome.tabs.create({ windowId, active: true });
    await assignTab(created.id, spaceId);
  }
  return spaceId;
}

// ---- Split View の保存と復元 ----
// 保存したペア = ピン留めの中のフォルダ（中に URL が 2 つ）。どのフォルダがペアかは storage.local の splitFolders に控える。
// 控えが消えても、フォルダと 2 つのリンクとしては残る（iPhone の Chrome からもフォルダに見える）。

async function getSplitFolders() {
  return new Set((await chrome.storage.local.get('splitFolders')).splitFolders ?? []);
}

async function markSplit(folderId, on) {
  const set = await getSplitFolders();
  if (on) set.add(folderId);
  else set.delete(folderId);
  await chrome.storage.local.set({ splitFolders: [...set] });
}

// 2 つのタブを隣に並べて分割する（すでに同じ分割にいれば何もしない）
async function ensureSplit(a, b) {
  if (a.splitViewId !== -1 && a.splitViewId === b.splitViewId) return a.splitViewId;
  if (a.splitViewId !== -1) await chrome.tabs.unsplit(a.splitViewId).catch(() => {});
  if (b.splitViewId !== -1 && b.splitViewId !== a.splitViewId) await chrome.tabs.unsplit(b.splitViewId).catch(() => {});
  const first = await chrome.tabs.get(a.id);
  // 同じウィンドウの隣（a の右）へ動かす。分割の条件（隣どうし・同じウィンドウ・ピン状態とグループが同じ）をそろえる
  await chrome.tabs.move(b.id, { windowId: first.windowId, index: first.index + 1 });
  return chrome.tabs.createSplit([a.id, b.id]);
}

async function splitPair(folderId) {
  const [folder] = await chrome.bookmarks.getSubTree(folderId);
  const links = folder.children.filter((n) => n.url).slice(0, 2);
  return links.length === 2 ? links : null;
}

// 保存したペアを開く。閉じていれば分割で開き、片方だけ・分割が解けていれば組み直す
async function openSplit(folderId, windowId) {
  const pair = await splitPair(folderId);
  if (!pair) return null;
  const linksMap = await getLinks();
  const tabOf = async (bm) => (linksMap[bm.id] != null ? chrome.tabs.get(linksMap[bm.id]).catch(() => null) : null);
  let a = await tabOf(pair[0]);
  let b = await tabOf(pair[1]);
  const spaceId = await spaceOfBookmark(folderId);
  if (!a) {
    a = await chrome.tabs.create({ url: pair[0].url, windowId: b?.windowId ?? windowId, active: true });
    await link(pair[0].id, a.id);
    await assignTab(a.id, spaceId);
  }
  if (!b) {
    // 分割は同じウィンドウの中でしかできないので、1 枚目と同じウィンドウに作る
    b = await chrome.tabs.create({ url: pair[1].url, windowId: a.windowId, splitWithTabId: a.id });
    await link(pair[1].id, b.id);
    await assignTab(b.id, spaceId);
  } else {
    await ensureSplit(await chrome.tabs.get(a.id), b);
  }
  await chrome.tabs.update(a.id, { active: true });
  await chrome.windows.update((await chrome.tabs.get(a.id)).windowId, { focused: true });
  return [a.id, b.id];
}

// タブ（分割のペアなら 2 つまとめて）を at（{ windowId, index }。index は動かす前の並びでの位置）へ並べる
async function moveTabsTo(tabIds, at) {
  const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  // 同じウィンドウで前にあるタブが抜けると、その分だけ位置が詰まる
  const shift = tabs.filter((t) => t.windowId === at.windowId && t.index < at.index).length;
  await chrome.tabs.move(tabIds, { windowId: at.windowId, index: at.index - shift });
  // 分割のタブを動かすと Chrome が分割を解くので、組み直す
  if (tabs.length === 2 && tabs[0].splitViewId !== -1 && tabs[0].splitViewId === tabs[1].splitViewId) {
    const [a, b] = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
    await ensureSplit(a, b);
  }
}

// 保存したペアの 2 つのタブ、またはピン留めのタブを用意する（閉じていれば裏で開く）。開いたタブの ID も返す
async function tabsOfPin(node, windowId) {
  const items = node.url ? [node] : (node.children ?? []).filter((n) => n.url).slice(0, 2);
  const linksMap = await getLinks();
  const tabs = await Promise.all(items.map((bm) => (linksMap[bm.id] != null ? chrome.tabs.get(linksMap[bm.id]).catch(() => null) : null)));
  const opened = [];
  for (let i = 0; i < items.length; i++) {
    if (tabs[i]) continue;
    const other = tabs.find(Boolean);
    tabs[i] = await chrome.tabs.create({ url: items[i].url, windowId: other?.windowId ?? windowId, active: false });
    opened.push(tabs[i].id);
  }
  return { tabs, opened };
}

// Chrome の再起動で分割が解けた、保存済みのペアを組み直す（両方とも同じウィンドウで開いているものだけ）
async function restoreSplits() {
  const folders = await getSplitFolders();
  const linksMap = await getLinks();
  for (const folderId of folders) {
    const pair = await splitPair(folderId).catch(() => null);
    if (!pair) continue;
    const [a, b] = await Promise.all(pair.map((bm) => (linksMap[bm.id] != null ? chrome.tabs.get(linksMap[bm.id]).catch(() => null) : null)));
    if (a && b && a.windowId === b.windowId) await ensureSplit(a, b).catch(() => {});
  }
}

// ---- 自動アーカイブ ----

const ARCHIVE_LIMIT = 500;
const DEFAULT_SETTINGS = { archiveAfterHours: 24 };

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function addToArchive(entries) {
  if (!entries.length) return;
  const { archive = [] } = await chrome.storage.local.get('archive');
  const now = Date.now();
  const added = entries.map((e) => ({ id: crypto.randomUUID(), archivedAt: now, ...e }));
  await chrome.storage.local.set({ archive: [...added, ...archive].slice(0, ARCHIVE_LIMIT) });
}

async function archiveEntryOf(tab, reason) {
  const { tabTitles = {} } = await chrome.storage.session.get('tabTitles');
  return {
    url: tab.url || tab.pendingUrl,
    title: tabTitles[tab.id] || tab.title || tab.url,
    spaceId: (await getTabSpace())[tab.id] ?? null,
    reason,
  };
}

// しばらく触っていない今日のタブを閉じてアーカイブに残す
async function runAutoArchive() {
  const { archiveAfterHours } = await getSettings();
  if (!archiveAfterHours) return [];
  const cutoff = Date.now() - archiveAfterHours * 3600 * 1000;
  const linked = new Set(Object.values(await getLinks()));
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const remaining = new Map();
  for (const t of tabs) remaining.set(t.windowId, (remaining.get(t.windowId) ?? 0) + 1);
  const targets = [];
  for (const t of tabs) {
    const old = t.lastAccessed && t.lastAccessed < cutoff;
    const skip = linked.has(t.id) || t.active || t.audible || t.pinned || (t.splitViewId ?? -1) !== -1 || !/^https?:/.test(t.url ?? '');
    // ウィンドウの最後の 1 枚は閉じない（ウィンドウごと消えるため）
    if (old && !skip && remaining.get(t.windowId) > 1) {
      targets.push(t);
      remaining.set(t.windowId, remaining.get(t.windowId) - 1);
    }
  }
  await addToArchive(await Promise.all(targets.map((t) => archiveEntryOf(t, 'auto'))));
  if (targets.length) await chrome.tabs.remove(targets.map((t) => t.id)).catch(() => {});
  return targets.map((t) => t.id);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'auto-archive') runAutoArchive();
});

function ensureAlarm() {
  chrome.alarms.create('auto-archive', { periodInMinutes: 15 });
}

// ---- サイドパネルからの操作 ----

async function focusTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

const handlers = {
  async init() {
    const structure = await getStructure();
    await relinkByUrl();
    await reassignByUrl();
    return structure;
  },

  // Favorites / ピン留めを押したとき。開いていればそのタブへ、閉じていれば開いて対応づける
  async openItem({ bookmarkId, windowId }) {
    const [bm] = await chrome.bookmarks.get(bookmarkId);
    if (!bm?.url) return null;
    const tabId = (await getLinks())[bookmarkId];
    const existing = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (existing) {
      await focusTab(existing);
      return existing.id;
    }
    const tab = await chrome.tabs.create({ url: bm.url, windowId, active: true });
    await link(bookmarkId, tab.id);
    // スペースのピン留めならそのスペースのグループへ（Favorites はどのスペースにも入れない）
    await assignTab(tab.id, await spaceOfBookmark(bookmarkId));
    return tab.id;
  },

  // ---- Spaces ----

  async getSpaceState({ windowId }) {
    const spaces = await listSpaces();
    return { spaces, currentSpaceId: await getCurrentSpaceId(windowId, spaces), tabSpace: await getTabSpace() };
  },

  async switchSpace({ windowId, spaceId }) {
    return switchSpace(windowId, spaceId);
  },

  async createSpace({ windowId, title }) {
    const { spacesId } = await getStructure();
    const folder = await chrome.bookmarks.create({ parentId: spacesId, title });
    await listSpaces(); // 色を割り当てる
    await switchSpace(windowId, folder.id);
    return folder.id;
  },

  async renameSpace({ spaceId, title }) {
    await chrome.bookmarks.update(spaceId, { title });
    return null;
  },

  // スペースのフォルダをまとめて開閉する（右クリックのメニューとセルフテストから）
  async setAllFolders({ spaceId, collapsed }) {
    return setAllFolders(spaceId, collapsed);
  },

  // スペースの Favorites フォルダの id（なければ作る）
  async ensureSpaceFavorites({ spaceId }) {
    return (await getSpaceFavoritesFolder(spaceId, true)).id;
  },

  // 以前の共通 Favorites を、指定したスペースの Favorites へ移す（同じ URL は重ねない）
  async moveSharedFavorites({ spaceId }) {
    const { favoritesId } = await getStructure();
    const target = await getSpaceFavoritesFolder(spaceId, true);
    const existing = new Set((await chrome.bookmarks.getChildren(target.id)).map((c) => c.url));
    let moved = 0;
    for (const bm of await chrome.bookmarks.getChildren(favoritesId)) {
      if (bm.url && existing.has(bm.url)) await chrome.bookmarks.remove(bm.id);
      else {
        await chrome.bookmarks.move(bm.id, { parentId: target.id });
        moved += 1;
      }
    }
    return moved;
  },

  // スペースのアイコン（絵文字 1 つ）。icon が空なら外す。onlyIfEmpty は取り込みで既存のアイコンを上書きしないため
  async setSpaceIcon({ spaceId, icon, onlyIfEmpty }) {
    const { spaceIcons = {} } = await chrome.storage.local.get('spaceIcons');
    if (onlyIfEmpty && spaceIcons[spaceId]) return null;
    if (icon) spaceIcons[spaceId] = icon;
    else delete spaceIcons[spaceId];
    await chrome.storage.local.set({ spaceIcons });
    return null;
  },

  // タブを別のスペースへ移す
  async moveTabToSpace({ tabId, spaceId }) {
    await assignTab(tabId, spaceId);
    return null;
  },

  // ---- アーカイブ ----

  // サイドバーで閉じたタブ・Clear で閉じたタブもアーカイブに残す
  async archiveTabs({ tabIds, reason }) {
    const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
    await addToArchive(await Promise.all(tabs.map((t) => archiveEntryOf(t, reason))));
    await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
    return tabs.length;
  },

  // アーカイブから開き直す（今のスペースに入れる）
  async restoreArchived({ id, windowId }) {
    const { archive = [] } = await chrome.storage.local.get('archive');
    const entry = archive.find((e) => e.id === id);
    if (!entry) return null;
    const tab = await chrome.tabs.create({ url: entry.url, windowId, active: true });
    await assignTab(tab.id, await getCurrentSpaceId(windowId, await listSpaces()));
    await chrome.storage.local.set({ archive: archive.filter((e) => e.id !== id) });
    return tab.id;
  },

  async deleteArchived({ id }) {
    const { archive = [] } = await chrome.storage.local.get('archive');
    await chrome.storage.local.set({ archive: archive.filter((e) => e.id !== id) });
    return null;
  },

  // Cmd+Z で閉じたタブを戻したときは、アーカイブの記録も消す
  async unarchiveLatest({ url }) {
    const { archive = [] } = await chrome.storage.local.get('archive');
    const i = archive.findIndex((e) => e.url === url);
    if (i >= 0) {
      archive.splice(i, 1);
      await chrome.storage.local.set({ archive });
    }
    return null;
  },

  // セルフテスト用: 指定したタブだけを対象に自動アーカイブを走らせる（ほかのタブには触らない）
  async testAutoArchive({ tabIds, seconds }) {
    const cutoff = Date.now() - seconds * 1000;
    const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(
      (t) => t && !t.active && t.lastAccessed && t.lastAccessed < cutoff,
    );
    await addToArchive(await Promise.all(tabs.map((t) => archiveEntryOf(t, 'auto'))));
    if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id));
    return tabs.map((t) => t.id);
  },

  // 今のタブをピン留め（または Favorites）にする。サイドバーで付けた名前があればそれを使う
  // 分割している 2 つのタブを、ペアとしてピン留めする（フォルダ 1 つと URL 2 つ）
  async pinSplit({ tabIds, parentId, index }) {
    const tabs = await Promise.all(tabIds.slice(0, 2).map((id) => chrome.tabs.get(id)));
    const { tabTitles = {} } = await chrome.storage.session.get('tabTitles');
    const nameOf = (t) => tabTitles[t.id] || t.title || t.url;
    const folder = await chrome.bookmarks.create({ parentId, index, title: tabs.map(nameOf).join(' | ') });
    await markSplit(folder.id, true);
    for (const t of tabs) {
      const bm = await chrome.bookmarks.create({ parentId: folder.id, title: nameOf(t), url: t.url || t.pendingUrl });
      await link(bm.id, t.id);
    }
    return folder.id;
  },

  async openSplit({ folderId, windowId }) {
    return openSplit(folderId, windowId);
  },

  // セルフテスト用: 起動時に行う「保存済みのペアを分割に戻す」を今すぐ行う
  async devRestoreSplits() {
    await restoreSplits();
    return null;
  },

  // Cmd+Z でフォルダを戻したときに、ペアの印も付け直す
  async markSplit({ folderId }) {
    await markSplit(folderId, true);
    return null;
  },

  async pinTab({ tabId, parentId, index }) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl;
    const { tabTitles = {} } = await chrome.storage.session.get('tabTitles');
    const bm = await chrome.bookmarks.create({ parentId, index, title: tabTitles[tabId] || tab.title || url, url });
    await link(bm.id, tab.id);
    return bm.id;
  },

  // ピン留めを今日のタブへ下ろす。タブが閉じていれば開いて、落とした位置（at）に並べる。
  // 保存したペアは分割のまま下ろす。普通のフォルダは下ろせない（Arc と同じ）
  async unpinToToday({ bookmarkId, windowId, spaceId, at }) {
    const [node] = await chrome.bookmarks.getSubTree(bookmarkId);
    const isSplit = !node.url && (await getSplitFolders()).has(node.id);
    if (!node.url && !isSplit) return null;
    const { tabs, opened } = await tabsOfPin(node, windowId);
    if (isSplit && tabs.length === 2) await ensureSplit(await chrome.tabs.get(tabs[0].id), await chrome.tabs.get(tabs[1].id));
    for (const t of tabs) await assignTab(t.id, spaceId);
    await chrome.bookmarks.removeTree(bookmarkId);
    if (at) await moveTabsTo(tabs.map((t) => t.id), at);
    return { opened };
  },

  // 今日のタブの並べ替え（分割のペアは 2 つまとめて動かす）
  async moveTabs({ tabIds, at }) {
    await moveTabsTo(tabIds, at);
    return null;
  },

  // 今見ているタブの右に、指定のタブ（またはピン留めのタブ）を並べて分割する
  async splitWithActive({ tabId, bookmarkId, windowId }) {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (!active) return null;
    let tab;
    if (bookmarkId) {
      const [node] = await chrome.bookmarks.get(bookmarkId);
      const { tabs, opened } = await tabsOfPin(node, windowId);
      tab = tabs[0];
      if (opened.length) {
        await link(bookmarkId, tab.id);
        await assignTab(tab.id, await spaceOfBookmark(bookmarkId));
      }
    } else {
      tab = await chrome.tabs.get(tabId);
    }
    if (tab.id === active.id) return null;
    await ensureSplit(active, await chrome.tabs.get(tab.id));
    return null;
  },

  // Cmd+Z で分割の解除を戻す
  async splitTabs({ tabIds }) {
    const [a, b] = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
    await ensureSplit(a, b);
    return null;
  },

  async unsplit({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.splitViewId !== -1) await chrome.tabs.unsplit(tab.splitViewId);
    return null;
  },

  // ピン留めを外す。ブックマークは消すが、タブは閉じずに「今日のタブ」に戻る
  async unpin({ bookmarkId }) {
    const [node] = await chrome.bookmarks.get(bookmarkId);
    if (node.url) await chrome.bookmarks.remove(bookmarkId);
    else await chrome.bookmarks.removeTree(bookmarkId);
    return null;
  },

  // 左端ホバー（edge.js）から: このタブのウィンドウでサイドパネルが開いているか
  // 自前の記録（openWindows）はずれることがあるので、Chrome に実際のサイドパネルの有無を問い合わせる
  // サイドパネルの情報にウィンドウの ID が入らない（-1 になる）ことがあるので、2 段構えで判定する:
  // Chrome が「このウィンドウにある」と返せば開いている。どのウィンドウか分からなければ、開閉のイベントで付けた記録に従う。
  // サイドパネルがどこにもなければ閉じていると確定し、記録も消す（記録がずれたまま残るのを防ぐ）
  async panelOpenHere(_msg, sender) {
    if (!sender.tab) return false;
    const windowId = sender.tab.windowId;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    if (contexts.some((c) => c.windowId === windowId)) {
      openWindows.add(windowId);
      return true;
    }
    if (contexts.length === 0) {
      if (openWindows.size) {
        openWindows.clear();
        saveOpenWindows();
      }
      return false;
    }
    return openWindows.has(windowId);
  },

  // 重ねて出すサイドバー（iframe）用のトークン。sidepanel.html はどのサイトからも iframe で読めてしまうので、
  // edge.js が受け取ったトークンを持っているときだけ中身を出す。ページの JavaScript はこの拡張にメッセージを送れない
  async issueOverlayToken(_msg, sender) {
    if (!sender.tab) throw new Error('content script からのみ');
    const token = crypto.randomUUID();
    const { overlayTokens = {} } = await chrome.storage.session.get('overlayTokens');
    overlayTokens[token] = sender.tab.id;
    await chrome.storage.session.set({ overlayTokens });
    return token;
  },

  async checkOverlayToken({ token }, sender) {
    const { overlayTokens = {} } = await chrome.storage.session.get('overlayTokens');
    // iframe の中のページから呼ばれるので、sender.tab は埋め込まれているタブになる
    return Boolean(token && overlayTokens[token] != null && overlayTokens[token] === sender.tab?.id);
  },

  // 今日のタブの表示名（サイドバー上だけの名前）
  async renameTab({ tabId, title }) {
    const { tabTitles = {} } = await chrome.storage.session.get('tabTitles');
    tabTitles[tabId] = title;
    await chrome.storage.session.set({ tabTitles });
    return null;
  },

  // Cmd+Z で戻したタブやピン留めを、対応づけ直す
  async link({ bookmarkId, tabId }) {
    await link(bookmarkId, tabId);
    return null;
  },

  // 元の URL に戻す
  async resetItem({ bookmarkId }) {
    const [bm] = await chrome.bookmarks.get(bookmarkId);
    const tabId = (await getLinks())[bookmarkId];
    if (tabId == null || !bm?.url) return null;
    await chrome.tabs.update(tabId, { url: bm.url });
    return tabId;
  },

  // ピン留めのタブだけ閉じる（ピン留め自体は残る）
  async closeItemTab({ bookmarkId }) {
    const tabId = (await getLinks())[bookmarkId];
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    return null;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true;
});

// ---- サイドパネルの開閉 ----

// open() はショートカットの処理の中で同期的に呼ぶ必要があるので、開いているウィンドウはメモリに持つ
const openWindows = new Set();
chrome.storage.session.get('openWindows').then(({ openWindows: saved = [] }) => {
  for (const id of saved) openWindows.add(id);
});
const saveOpenWindows = () => chrome.storage.session.set({ openWindows: [...openWindows] });

chrome.sidePanel.onOpened.addListener(({ windowId }) => {
  openWindows.add(windowId);
  saveOpenWindows();
});
chrome.sidePanel.onClosed.addListener(({ windowId }) => {
  openWindows.delete(windowId);
  saveOpenWindows();
});

// スペースのフォルダをまとめて開閉する（Favorites フォルダは一覧に出さないので対象外）
async function setAllFolders(spaceId, collapsed) {
  const [tree] = await chrome.bookmarks.getSubTree(spaceId);
  const ids = flatten(tree)
    .filter((n) => !n.url && n.id !== spaceId && !(n.parentId === spaceId && n.title === FAVORITES_TITLE))
    .map((n) => n.id);
  const { collapsed: current = [] } = await chrome.storage.local.get('collapsed');
  const set = new Set(current);
  for (const id of ids) {
    if (collapsed) set.add(id);
    else set.delete(id);
  }
  await chrome.storage.local.set({ collapsed: [...set] });
  return ids.length;
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if ((command === 'collapse-all-folders' || command === 'expand-all-folders') && tab?.windowId != null) {
    const spaceId = await getCurrentSpaceId(tab.windowId, await listSpaces());
    await setAllFolders(spaceId, command === 'collapse-all-folders');
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-sidebar' || tab?.windowId == null) return;
  if (openWindows.has(tab.windowId)) chrome.sidePanel.close({ windowId: tab.windowId }).catch(() => {});
  else chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

// 拡張を入れた・更新したときは、開いているタブに左端ホバーの content script を入れ直す
// （Chrome は既存のタブには content script を自動で入れない。更新前のものは動かなくなっている）
async function injectEdgeIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  const results = await Promise.all(
    tabs.map((t) =>
      chrome.scripting
        .executeScript({ target: { tabId: t.id }, files: ['edge.js'] })
        .then(() => 'ok', (e) => String(e)),
    ),
  );
  // 開発用の記録（dev/state.html で見る）
  const failed = results.filter((r) => r !== 'ok');
  await chrome.storage.local.set({
    injectDiag: { at: new Date().toISOString(), tabs: tabs.length, ok: results.length - failed.length, errors: [...new Set(failed)].slice(0, 3) },
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  getStructure().then(relinkByUrl);
  injectEdgeIntoOpenTabs();
  ensureAlarm();
});
chrome.runtime.onStartup.addListener(() => {
  // 起動直後はタブの復元が続いていることがあるので、少し待ってから保存済みのペアを分割に戻す
  getStructure()
    .then(relinkByUrl)
    .then(reassignByUrl)
    .then(() => new Promise((r) => setTimeout(r, 3000)))
    .then(relinkByUrl)
    .then(restoreSplits)
    .catch(() => {});
  ensureAlarm();
});
