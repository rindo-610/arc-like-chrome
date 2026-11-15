// サイドバーの Service Worker の操作を順に実行して確かめる（開発用）

const out = document.getElementById('out');
const results = [];

function line(ok, name, detail = '') {
  results.push(ok);
  out.textContent += `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' … ' + detail : ''}\n`;
}

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? '応答がありません');
  return res.result;
}

const links = async () => (await chrome.storage.session.get('links')).links ?? {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// タブの読み込み完了（URL 確定）を待つ
async function waitForUrl(tabId, prefix, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url?.startsWith(prefix)) return tab;
    await sleep(200);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    line(true, name, detail ?? '');
  } catch (e) {
    line(false, name, String(e?.message ?? e));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function runAll() {
  out.textContent = '';
  results.length = 0;
  const me = await chrome.tabs.getCurrent();
  const cleanup = { bookmarks: [], tabs: [] };
  let structure;
  let pinnedId;
  let tabId;

  await check('init: フォルダ構成ができる', async () => {
    structure = await send('init');
    const [space] = await chrome.bookmarks.get(structure.spaceId);
    const [root] = await chrome.bookmarks.get(structure.rootId);
    // 既定のスペースは名前を変えられるので、名前ではなく置き場所で確かめる
    assert(root.title === 'Arc' && space.parentId === structure.spacesId && !space.url, '構成が違う');
    return `root=${structure.rootId} favorites=${structure.favoritesId} space=${structure.spaceId} 同期フォルダ=${structure.syncing}`;
  });
  if (!structure) return finish();

  await check('init を 2 回呼んでもフォルダが増えない', async () => {
    const again = await send('init');
    assert(again.spaceId === structure.spaceId, 'space の ID が変わった');
    const children = await chrome.bookmarks.getChildren(structure.rootId);
    const titles = children.filter((c) => !c.url).map((c) => c.title);
    assert(titles.filter((t) => t === 'Favorites').length === 1, 'Favorites が重複');
    return titles.join(',');
  });

  await check('pinTab: 今のタブをピン留めにすると対応づく', async () => {
    const tab = await chrome.tabs.create({ windowId: me.windowId, url: 'https://example.com/?sidebar-selftest=1', active: false });
    tabId = tab.id;
    cleanup.tabs.push(tab.id);
    await waitForUrl(tab.id, 'https://example.com/');
    pinnedId = await send('pinTab', { tabId, parentId: structure.spaceId });
    cleanup.bookmarks.push(pinnedId);
    const [bm] = await chrome.bookmarks.get(pinnedId);
    assert(bm.parentId === structure.spaceId, '保存先が違う');
    assert((await links())[pinnedId] === tabId, '対応がない');
    return bm.url;
  });

  await check('resetItem: 別のページへ移動したタブを元の URL に戻す', async () => {
    await chrome.tabs.update(tabId, { url: 'https://example.org/?moved=1' });
    await waitForUrl(tabId, 'https://example.org/');
    await send('resetItem', { bookmarkId: pinnedId });
    const tab = await waitForUrl(tabId, 'https://example.com/');
    assert(tab.url.startsWith('https://example.com/?sidebar-selftest=1'), `戻っていない: ${tab.url}`);
    return tab.url;
  });

  await check('closeItemTab: タブを閉じてもピン留めは残り、対応は消える', async () => {
    await send('closeItemTab', { bookmarkId: pinnedId });
    await sleep(300);
    const gone = !(await chrome.tabs.get(tabId).catch(() => null));
    assert(gone, 'タブが残っている');
    assert((await chrome.bookmarks.get(pinnedId))[0], 'ブックマークが消えた');
    assert((await links())[pinnedId] === undefined, '対応が残っている');
  });

  await check('openItem: 閉じたピン留めを開くと新しいタブで開いて対応づく', async () => {
    tabId = await send('openItem', { bookmarkId: pinnedId, windowId: me.windowId });
    cleanup.tabs.push(tabId);
    assert((await links())[pinnedId] === tabId, '対応がない');
    // 2 回目は同じタブに切り替わるだけ
    const again = await send('openItem', { bookmarkId: pinnedId, windowId: me.windowId });
    assert(again === tabId, `別のタブが開いた: ${again}`);
    await chrome.tabs.update(me.id, { active: true });
    return `tab=${tabId}`;
  });

  let folderId;
  await check('フォルダを作ってピン留めを中へ移す（ネスト）', async () => {
    const folder = await chrome.bookmarks.create({ parentId: structure.spaceId, title: 'selftest-folder' });
    folderId = folder.id;
    cleanup.bookmarks.push(folder.id);
    const inner = await chrome.bookmarks.create({ parentId: folder.id, title: 'selftest-inner' });
    await chrome.bookmarks.move(pinnedId, { parentId: inner.id });
    const [bm] = await chrome.bookmarks.get(pinnedId);
    assert(bm.parentId === inner.id, '移動していない');
    assert((await links())[pinnedId] === tabId, '移動で対応が消えた');
  });

  await check('unpin: フォルダごと外すとブックマークは消え、タブは残る', async () => {
    await send('unpin', { bookmarkId: folderId });
    await sleep(300);
    assert(!(await chrome.bookmarks.get(pinnedId).catch(() => null)), 'ブックマークが残っている');
    assert(await chrome.tabs.get(tabId).catch(() => null), 'タブまで消えた');
    assert((await links())[pinnedId] === undefined, '対応が残っている');
  });

  await check('Favorites: スペースの Favorites にタブを入れて開閉でき、ピン留めの一覧とは別に持つ', async () => {
    const hadFolder = (await chrome.bookmarks.getChildren(structure.spaceId)).some((n) => !n.url && n.title === 'Favorites');
    const favFolderId = await send('ensureSpaceFavorites', { spaceId: structure.spaceId });
    if (!hadFolder) cleanup.bookmarks.push(favFolderId);
    const [folder] = await chrome.bookmarks.get(favFolderId);
    assert(folder.parentId === structure.spaceId && folder.title === 'Favorites', 'スペースの中に Favorites フォルダがない');
    const favId = await send('pinTab', { tabId, parentId: favFolderId });
    cleanup.bookmarks.push(favId);
    assert((await links())[favId] === tabId, '対応がない');
    await send('closeItemTab', { bookmarkId: favId });
    await sleep(300);
    const reopened = await send('openItem', { bookmarkId: favId, windowId: me.windowId });
    cleanup.tabs.push(reopened);
    tabId = reopened;
    await chrome.tabs.update(me.id, { active: true });
    await send('unpin', { bookmarkId: favId });
    assert(await chrome.tabs.get(reopened).catch(() => null), 'タブが消えた');
    return `reopened=${reopened}`;
  });

  await check('renameTab: 今日のタブに付けた名前がピン留めの名前になる', async () => {
    await send('renameTab', { tabId, title: 'selftest-renamed' });
    const { tabTitles = {} } = await chrome.storage.session.get('tabTitles');
    assert(tabTitles[tabId] === 'selftest-renamed', '表示名が保存されていない');
    const bid = await send('pinTab', { tabId, parentId: structure.spaceId });
    cleanup.bookmarks.push(bid);
    const [bm] = await chrome.bookmarks.get(bid);
    assert(bm.title === 'selftest-renamed', `名前が違う: ${bm.title}`);
    await send('unpin', { bookmarkId: bid });
  });

  await check('フォルダをまとめて開閉: スペースの中のフォルダ（ネスト含む）だけが対象で、Favorites は対象外', async () => {
    const space = await chrome.bookmarks.create({ parentId: structure.spacesId, title: 'selftest-fold-space' });
    cleanup.bookmarks.push(space.id);
    const a = await chrome.bookmarks.create({ parentId: space.id, title: 'a' });
    const b = await chrome.bookmarks.create({ parentId: a.id, title: 'b' });
    const fav = await chrome.bookmarks.create({ parentId: space.id, title: 'Favorites' });
    const count = await send('setAllFolders', { spaceId: space.id, collapsed: true });
    let { collapsed = [] } = await chrome.storage.local.get('collapsed');
    assert(count === 2 && collapsed.includes(a.id) && collapsed.includes(b.id), `閉じていない: ${count}`);
    assert(!collapsed.includes(fav.id) && !collapsed.includes(space.id), 'Favorites かスペース自体まで閉じた');
    await send('setAllFolders', { spaceId: space.id, collapsed: false });
    ({ collapsed = [] } = await chrome.storage.local.get('collapsed'));
    assert(!collapsed.includes(a.id) && !collapsed.includes(b.id), '開いていない');
  });

  // ---- Arc からの取り込み（テスト用に作った小さなデータで行う）----
  await check('Arc 取り込み: スペース・アイコン・フォルダ・Split View・Favorites が入り、2 回目は重複しない', async () => {
    const { parseArcSidebar, importArc } = await import('../arc-import.js');
    const tab = (id, parentID, url, title = null) => [id, { id, parentID, title, childrenIds: [], data: { tab: { savedURL: url, savedTitle: `saved ${id}` } } }];
    const sample = {
      sidebar: {
        containers: [
          { global: {} },
          {
            spaces: [
              'sp1', { id: 'sp1', title: 'selftest-arc', profile: { default: true }, customInfo: { iconType: { emoji_v2: '🧪' } }, containerIDs: ['pinned', 'p1', 'unpinned', 'u1'] },
              'sp2', { id: 'sp2', title: 'selftest-arc-2', profile: { custom: { _0: { directoryBasename: 'Profile 9' } } }, customInfo: { iconType: { icon: 'planet' } }, containerIDs: ['pinned', 'p2', 'unpinned', 'u2'] },
            ],
            topAppsContainerIDs: [{ default: true }, 'fav-d', { custom: { _0: { directoryBasename: 'Profile 9' } } }, 'fav-9'],
            items: [
              'p1', { id: 'p1', childrenIds: ['f1', 't3', 'sv1'], data: { itemContainer: {} } },
              'f1', { id: 'f1', parentID: 'p1', title: 'selftest-folder', childrenIds: ['t1', 't2'], data: { list: {} } },
              ...tab('t1', 'f1', 'https://example.com/?arc-import=1', 'renamed in arc'),
              ...tab('t2', 'f1', 'https://example.com/?arc-import=2'),
              ...tab('t3', 'p1', 'https://example.com/?arc-import=3'),
              'sv1', { id: 'sv1', parentID: 'p1', childrenIds: ['t4', 't5'], data: { splitView: {} } },
              ...tab('t4', 'sv1', 'https://example.com/?arc-import=4'),
              ...tab('t5', 'sv1', 'https://example.com/?arc-import=5'),
              'u1', { id: 'u1', childrenIds: ['t6'], data: { itemContainer: {} } },
              ...tab('t6', 'u1', 'https://example.com/?arc-import=today'),
              'p2', { id: 'p2', childrenIds: [], data: { itemContainer: {} } },
              'u2', { id: 'u2', childrenIds: [], data: { itemContainer: {} } },
              'fav-d', { id: 'fav-d', childrenIds: ['t7'], data: { itemContainer: {} } },
              ...tab('t7', 'fav-d', 'https://example.com/?arc-import=fav'),
              'fav-9', { id: 'fav-9', childrenIds: ['t8'], data: { itemContainer: {} } },
              ...tab('t8', 'fav-9', 'https://example.com/?arc-import=fav9'),
            ],
          },
        ],
      },
    };
    const parsed = parseArcSidebar(sample);
    const first = await importArc(parsed, { structure, send });
    const spacesNow = await chrome.bookmarks.getChildren(structure.spacesId);
    const sp1 = spacesNow.find((n) => n.title === 'selftest-arc');
    const sp2 = spacesNow.find((n) => n.title === 'selftest-arc-2');
    if (sp1) cleanup.bookmarks.push(sp1.id);
    if (sp2) cleanup.bookmarks.push(sp2.id);
    assert(sp1 && sp2, 'スペースができていない');
    const [tree1] = await chrome.bookmarks.getSubTree(sp1.id);
    const folder = tree1.children.find((n) => n.title === 'selftest-folder');
    const fav1 = tree1.children.find((n) => n.title === 'Favorites');
    assert(fav1?.children.some((c) => c.url === 'https://example.com/?arc-import=fav'), '既定のプロファイルの Favorites がスペースの Favorites に入っていない');
    assert(folder?.children.length === 2 && folder.children[0].title === 'renamed in arc', 'フォルダの中身か名前が違う');
    const topUrls = tree1.children.filter((n) => n.url).map((n) => n.url);
    assert(!(await chrome.bookmarks.getChildren(structure.favoritesId)).some((n) => n.url?.includes('arc-import')), '共通の Favorites に入ってしまった');
    assert(topUrls.length === 3, `ピン留めの数が違う（Split View は 2 つに分かれる）: ${topUrls.length}`);
    assert(!JSON.stringify(tree1).includes('arc-import=today'), '今日のタブまで取り込んだ');
    const [tree2] = await chrome.bookmarks.getSubTree(sp2.id);
    assert(tree2.children.some((n) => n.title === 'Favorites' && n.children.some((c) => c.url.includes('fav9'))), '別プロファイルの Favorites がそのスペースにない');
    const { spaceIcons = {} } = await chrome.storage.local.get('spaceIcons');
    assert(spaceIcons[sp1.id] === '🧪' && spaceIcons[sp2.id] === '🪐', `アイコンが違う: ${spaceIcons[sp1.id]} ${spaceIcons[sp2.id]}`);
    const second = await importArc(parsed, { structure, send });
    assert(second.links === 0 && second.spacesCreated === 0 && second.duplicates === first.links, `2 回目に重複して入った: ${JSON.stringify(second)}`);
    await send('setSpaceIcon', { spaceId: sp1.id, icon: null });
    await send('setSpaceIcon', { spaceId: sp2.id, icon: null });
    return `1 回目 ${JSON.stringify(first)}`;
  });

  await check('Arc 取り込み: スペースを選べ、同じプロファイルの最初のスペースを外すと Favorites は残したスペースに入る', async () => {
    const { parseArcSidebar, selectSpaces } = await import('../arc-import.js');
    const item = (id, children, data) => [id, { id, childrenIds: children, data }];
    const sample = {
      sidebar: {
        containers: [
          { global: {} },
          {
            spaces: [
              'a', { id: 'a', title: 'A', profile: { default: true }, containerIDs: ['pinned', 'pa', 'unpinned', 'ua'] },
              'b', { id: 'b', title: 'B', profile: { default: true }, containerIDs: ['pinned', 'pb', 'unpinned', 'ub'] },
              'c', { id: 'c', title: 'C', profile: { custom: { _0: { directoryBasename: 'Profile 3' } } }, containerIDs: ['pinned', 'pc', 'unpinned', 'uc'] },
            ],
            topAppsContainerIDs: [{ default: true }, 'fd', { custom: { _0: { directoryBasename: 'Profile 3' } } }, 'f3'],
            items: [
              ...item('pa', [], { itemContainer: {} }), ...item('pb', [], { itemContainer: {} }), ...item('pc', [], { itemContainer: {} }),
              ...item('ua', [], { itemContainer: {} }), ...item('ub', [], { itemContainer: {} }), ...item('uc', [], { itemContainer: {} }),
              ...item('fd', ['x'], { itemContainer: {} }), ...item('x', [], { tab: { savedURL: 'https://example.com/?fd', savedTitle: 'fd' } }),
              ...item('f3', ['y'], { itemContainer: {} }), ...item('y', [], { tab: { savedURL: 'https://example.com/?f3', savedTitle: 'f3' } }),
            ],
          },
        ],
      },
    };
    const parsed = parseArcSidebar(sample);
    assert(parsed.spaces[0].favorites.length === 1 && parsed.spaces[1].favorites.length === 0, '最初のスペースにだけ Favorites が付いていない');
    const onlyB = selectSpaces(parsed, [1]);
    assert(onlyB.spaces.length === 1 && onlyB.spaces[0].title === 'B' && onlyB.spaces[0].favorites.length === 1, 'B に Favorites が移っていない');
    const onlyC = selectSpaces(parsed, [2]);
    assert(onlyC.spaces[0].favorites[0]?.url === 'https://example.com/?f3', 'C の Favorites が違う');
    assert(parsed.spaces[1].favorites.length === 0, '選び直しで元の解析結果が書き換わった');
  });

  await check('共通 Favorites の移動: スペースの Favorites へ移り、同じ URL は重ねない', async () => {
    const shared = (await chrome.bookmarks.getChildren(structure.favoritesId)).filter((n) => n.url);
    // 実データ（以前の共通 Favorites）が残っているときは、全部動いてしまうので試さない
    if (shared.length) return `スキップ（以前の共通 Favorites が ${shared.length} 件残っているため）`;
    const space = await chrome.bookmarks.create({ parentId: structure.spacesId, title: 'selftest-move-space' });
    cleanup.bookmarks.push(space.id);
    await chrome.bookmarks.create({ parentId: structure.favoritesId, title: 'a', url: 'https://example.com/?move=a' });
    await chrome.bookmarks.create({ parentId: structure.favoritesId, title: 'b', url: 'https://example.com/?move=b' });
    const favFolder = await send('ensureSpaceFavorites', { spaceId: space.id });
    await chrome.bookmarks.create({ parentId: favFolder, title: 'b', url: 'https://example.com/?move=b' });
    const moved = await send('moveSharedFavorites', { spaceId: space.id });
    const inSpace = (await chrome.bookmarks.getChildren(favFolder)).map((n) => n.url);
    assert(moved === 1 && inSpace.length === 2, `移動結果が違う: moved=${moved} inSpace=${inSpace.length}`);
    assert((await chrome.bookmarks.getChildren(structure.favoritesId)).length === 0, '共通 Favorites が残っている');
  });

  // ---- Spaces とアーカイブ（ユーザーのウィンドウに触れないよう、テスト用のウィンドウで行う）----
  const testWin = await chrome.windows.create({ url: 'https://example.com/?space-test=1', focused: false, width: 900, height: 600 });
  const tabA = testWin.tabs[0].id;
  const archivedIds = [];
  let defaultSpace;
  let newSpaceId;

  const spaceOf = async (tabId) => (await send('getSpaceState', { windowId: testWin.id })).tabSpace[tabId];

  await check('Spaces: 新しいウィンドウのタブが今のスペースに入る（タブグループは作らない）', async () => {
    await sleep(1200);
    const state = await send('getSpaceState', { windowId: testWin.id });
    defaultSpace = state.spaces.find((sp) => sp.id === state.currentSpaceId);
    assert(state.tabSpace[tabA] === defaultSpace.id, `スペースが違う: ${state.tabSpace[tabA]}`);
    const tab = await chrome.tabs.get(tabA);
    assert(tab.groupId === -1, 'タブグループに入っている');
    return `space=${defaultSpace.title}`;
  });

  await check('Spaces: スペースを作ると切り替わり、そのスペースの新しいタブが表示される', async () => {
    newSpaceId = await send('createSpace', { windowId: testWin.id, title: 'selftest-space' });
    const state = await send('getSpaceState', { windowId: testWin.id });
    assert(state.currentSpaceId === newSpaceId, '切り替わっていない');
    const active = (await chrome.tabs.query({ windowId: testWin.id, active: true }))[0];
    assert(active.id !== tabA && state.tabSpace[active.id] === newSpaceId, '表示中のタブが新しいスペースにない');
  });

  await check('Spaces: 元のスペースに戻ると、最後に見ていたタブが表示される', async () => {
    await send('switchSpace', { windowId: testWin.id, spaceId: defaultSpace.id });
    const active = (await chrome.tabs.query({ windowId: testWin.id, active: true }))[0];
    assert(active.id === tabA, `表示中のタブが違う: ${active.id}`);
  });

  await check('Spaces: リンクから開いたタブは開いたタブと同じスペースに入る', async () => {
    const child = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.org/?opener-test=1', openerTabId: tabA, active: false });
    await sleep(500);
    assert((await spaceOf(child.id)) === defaultSpace.id, 'スペースが違う');
    await chrome.tabs.remove(child.id);
  });

  await check('Spaces: タブを別のスペースへ移せる。名前を変えても対応は変わらない', async () => {
    await send('moveTabToSpace', { tabId: tabA, spaceId: newSpaceId });
    assert((await spaceOf(tabA)) === newSpaceId, '移っていない');
    await send('renameSpace', { spaceId: newSpaceId, title: 'selftest-space-2' });
    assert((await chrome.bookmarks.get(newSpaceId))[0].title === 'selftest-space-2', 'フォルダ名が変わっていない');
    assert((await spaceOf(tabA)) === newSpaceId, '名前を変えたら対応が外れた');
    await send('moveTabToSpace', { tabId: tabA, spaceId: defaultSpace.id });
  });

  let splitFolderId;
  await check('Split View: 分割した 2 つのタブをペアとしてピン留めでき、閉じてから押すと分割で開く', async () => {
    const a = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.com/?split-a=1', active: true });
    await waitForUrl(a.id, 'https://example.com/');
    const b = await chrome.tabs.create({ url: 'https://example.org/?split-b=1', windowId: testWin.id, splitWithTabId: a.id });
    await waitForUrl(b.id, 'https://example.org/');
    const [ta, tb] = await Promise.all([chrome.tabs.get(a.id), chrome.tabs.get(b.id)]);
    assert(ta.splitViewId !== -1 && ta.splitViewId === tb.splitViewId, '分割できていない');
    splitFolderId = await send('pinSplit', { tabIds: [a.id, b.id], parentId: structure.spaceId });
    cleanup.bookmarks.push(splitFolderId);
    const [folder] = await chrome.bookmarks.getSubTree(splitFolderId);
    assert(folder.children.length === 2 && folder.children[0].url.includes('split-a'), 'フォルダの中身が違う');
    const { splitFolders = [] } = await chrome.storage.local.get('splitFolders');
    assert(splitFolders.includes(splitFolderId), 'ペアの印が付いていない');
    assert((await links())[folder.children[0].id] === a.id && (await links())[folder.children[1].id] === b.id, 'タブと対応づいていない');
    await chrome.tabs.remove([a.id, b.id]);
    await sleep(300);
    const [x, y] = await send('openSplit', { folderId: splitFolderId, windowId: testWin.id });
    await sleep(500);
    const [tx, ty] = await Promise.all([chrome.tabs.get(x), chrome.tabs.get(y)]);
    assert(tx.splitViewId !== -1 && tx.splitViewId === ty.splitViewId, '閉じたペアが分割で開かない');
    assert((tx.pendingUrl || tx.url).includes('split-a') && (ty.pendingUrl || ty.url).includes('split-b'), '開いた URL が違う');
  });

  await check('Split View: 分割が解けたペアは、押すと・起動時の処理で分割に戻る', async () => {
    const pairTabs = async () => {
      const l = await links();
      const [folder] = await chrome.bookmarks.getSubTree(splitFolderId);
      return Promise.all(folder.children.map((c) => chrome.tabs.get(l[c.id])));
    };
    let [p, q] = await pairTabs();
    await chrome.tabs.unsplit(p.splitViewId);
    await send('openSplit', { folderId: splitFolderId, windowId: testWin.id });
    [p, q] = await pairTabs();
    assert(p.splitViewId !== -1 && p.splitViewId === q.splitViewId, '押しても分割に戻らない');
    await chrome.tabs.unsplit(p.splitViewId);
    await send('devRestoreSplits');
    [p, q] = await pairTabs();
    assert(p.splitViewId !== -1 && p.splitViewId === q.splitViewId, '起動時の処理で分割に戻らない');
  });

  let splitPairTabs;
  await check('今日のタブへ下ろす: 閉じたピン留めは開いて、落とした位置に並ぶ（消えない）', async () => {
    const t1 = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.com/?today-a=1', active: false });
    const t2 = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.org/?today-b=1', active: false });
    await waitForUrl(t2.id, 'https://example.org/');
    const bm = await chrome.bookmarks.create({ parentId: structure.spaceId, title: 'today-drop', url: 'https://example.net/?today-drop=1' });
    cleanup.bookmarks.push(bm.id);
    const at = { windowId: testWin.id, index: (await chrome.tabs.get(t2.id)).index }; // t1 と t2 のあいだ
    const { opened } = await send('unpinToToday', { bookmarkId: bm.id, windowId: testWin.id, spaceId: defaultSpace.id, at });
    assert(opened.length === 1, `タブが開いていない: ${opened.length}`);
    assert(!(await chrome.bookmarks.get(bm.id).catch(() => null)), 'ピン留めが外れていない');
    const [n, a, b] = await Promise.all([opened[0], t1.id, t2.id].map((id) => chrome.tabs.get(id)));
    assert(n.windowId === testWin.id && n.index === a.index + 1 && b.index === n.index + 1, `位置が違う: ${a.index},${n.index},${b.index}`);
    assert((await spaceOf(n.id)) === defaultSpace.id, '今のスペースに入っていない');
    await chrome.tabs.remove([n.id, t1.id, t2.id]);
  });

  await check('今日のタブへ下ろす: 保存したペアは分割のまま下ろせる。普通のフォルダは下ろせない', async () => {
    const folder = await chrome.bookmarks.create({ parentId: structure.spaceId, title: 'plain-folder' });
    cleanup.bookmarks.push(folder.id);
    assert((await send('unpinToToday', { bookmarkId: folder.id, windowId: testWin.id, spaceId: defaultSpace.id, at: null })) === null, '普通のフォルダが下ろせてしまう');
    assert(await chrome.bookmarks.get(folder.id).catch(() => null), '普通のフォルダが消えた');
    const l = await links();
    const [pairFolder] = await chrome.bookmarks.getSubTree(splitFolderId);
    const ids = pairFolder.children.map((c) => l[c.id]);
    await chrome.tabs.remove(ids[1]); // 片方だけ閉じておく
    await sleep(300);
    const { opened } = await send('unpinToToday', { bookmarkId: splitFolderId, windowId: testWin.id, spaceId: defaultSpace.id, at: null });
    assert(opened.length === 1, `閉じていた側が開いていない: ${opened.length}`);
    assert(!(await chrome.bookmarks.get(splitFolderId).catch(() => null)), 'ペアが外れていない');
    const [p, q] = await Promise.all([ids[0], opened[0]].map((id) => chrome.tabs.get(id)));
    assert(p.splitViewId !== -1 && p.splitViewId === q.splitViewId, '分割になっていない');
    const { splitFolders = [] } = await chrome.storage.local.get('splitFolders');
    assert(!splitFolders.includes(splitFolderId), 'ペアの印が残っている');
    splitPairTabs = [p.id, q.id];
  });

  await check('今日のタブの並べ替え: 分割のペアは 2 つまとめて動く', async () => {
    const t = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.com/?reorder=1', index: 0, active: false });
    await send('moveTabs', { tabIds: splitPairTabs, at: { windowId: testWin.id, index: 0 } });
    const [p, q, x] = await Promise.all([...splitPairTabs, t.id].map((id) => chrome.tabs.get(id)));
    assert(p.index === 0 && q.index === 1 && x.index === 2, `位置が違う: ${p.index},${q.index},${x.index}`);
    assert(p.splitViewId !== -1 && p.splitViewId === q.splitViewId, '動かしたら分割が解けた');
    await send('moveTabs', { tabIds: [t.id], at: { windowId: testWin.id, index: 0 } });
    assert((await chrome.tabs.get(t.id)).index === 0, '1 つのタブを前へ動かせない');
    await chrome.tabs.remove(t.id);
  });

  await check('今のタブと分割表示: 今見ているタブの右に並べて分割し、解除できる', async () => {
    await chrome.tabs.remove(splitPairTabs);
    const a = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.com/?with-active=1', active: true });
    const b = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.org/?with-active=2', index: 0, active: false });
    await waitForUrl(a.id, 'https://example.com/');
    await send('splitWithActive', { tabId: b.id, windowId: testWin.id });
    let [p, q] = await Promise.all([a.id, b.id].map((id) => chrome.tabs.get(id)));
    assert(p.splitViewId !== -1 && p.splitViewId === q.splitViewId && q.index === p.index + 1, '分割になっていない');
    await send('unsplit', { tabId: a.id });
    [p, q] = await Promise.all([a.id, b.id].map((id) => chrome.tabs.get(id)));
    assert(p.splitViewId === -1 && q.splitViewId === -1, '解除できない');
    // ピン留め（閉じている）とも分割できる
    const bm = await chrome.bookmarks.create({ parentId: structure.spaceId, title: 'split-pin', url: 'https://example.net/?split-pin=1' });
    cleanup.bookmarks.push(bm.id);
    await send('splitWithActive', { bookmarkId: bm.id, windowId: testWin.id });
    const pinTab = await chrome.tabs.get((await links())[bm.id]);
    p = await chrome.tabs.get(a.id);
    assert(p.splitViewId !== -1 && p.splitViewId === pinTab.splitViewId, 'ピン留めと分割できない');
    await chrome.tabs.remove([a.id, b.id, pinTab.id]);
  });

  await check('Live Folders: 新しい順に書き出し、消えた PR は外し、同じ URL は名前と順番だけ直す', async () => {
    const folder = await chrome.bookmarks.create({ parentId: structure.spaceId, title: 'live-folder-test' });
    cleanup.bookmarks.push(folder.id);
    const sub = await chrome.bookmarks.create({ parentId: folder.id, title: '自分で作ったフォルダ' });
    const pr = (n, title) => ({ url: `https://github.com/o/r/pull/${n}`, title: `r#${n} ${title}` });
    await send('devLiveFoldersWrite', { folderId: folder.id, items: [pr(1, 'a'), pr(2, 'b'), pr(3, 'c')] });
    let kids = await chrome.bookmarks.getChildren(folder.id);
    assert(kids.slice(0, 3).map((k) => k.title).join(',') === 'r#1 a,r#2 b,r#3 c', `最初の書き出しが違う: ${kids.map((k) => k.title)}`);
    const keepId = kids[2].id;
    await send('devLiveFoldersWrite', { folderId: folder.id, items: [pr(3, 'c2'), pr(4, 'd'), pr(1, 'a')] });
    kids = await chrome.bookmarks.getChildren(folder.id);
    assert(kids.map((k) => k.title).join(',') === 'r#3 c2,r#4 d,r#1 a,自分で作ったフォルダ', `更新後が違う: ${kids.map((k) => k.title)}`);
    assert(kids[0].id === keepId, '同じ URL のブックマークが作り直された（タブとの対応が外れる）');
    assert(kids[3].id === sub.id, '自分で作ったフォルダが消えた');
  });

  await check('Live Folders: トークンがなければ GitHub に問い合わせず、状態にトークンを含めない', async () => {
    const state = await send('liveFoldersState');
    assert(!('token' in state) && !('githubToken' in state), '状態にトークンが入っている');
    if (state.hasToken) return 'トークン設定済みのため、未設定時の確認は省略';
    await send('liveFoldersRefresh');
    const { liveFoldersStatus } = await chrome.storage.local.get('liveFoldersStatus');
    assert(liveFoldersStatus?.ok === false && /未設定/.test(liveFoldersStatus.error), `状態が違う: ${JSON.stringify(liveFoldersStatus)}`);
    await chrome.storage.local.remove('liveFoldersStatus');
  });

  await check('Live Folders: api.github.com には届く（ダミーのトークンなので 401 が返る）', async () => {
    const result = await send('devLiveFoldersProbe');
    assert(/トークンが無効/.test(result), `401 以外: ${result}`);
  });

  await check('アーカイブ: 閉じたタブがアーカイブに残り、開き直すと今のスペースに入る', async () => {
    const t = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.org/?archive-test=1', active: false });
    await waitForUrl(t.id, 'https://example.org/');
    await send('archiveTabs', { tabIds: [t.id], reason: 'closed' });
    const { archive = [] } = await chrome.storage.local.get('archive');
    const entry = archive.find((e) => e.url.includes('archive-test=1'));
    assert(entry, 'アーカイブにない');
    assert(!(await chrome.tabs.get(t.id).catch(() => null)), 'タブが閉じていない');
    const restored = await send('restoreArchived', { id: entry.id, windowId: testWin.id });
    assert((await spaceOf(restored)) === defaultSpace.id, '開き直したタブのスペースが違う');
    const after = (await chrome.storage.local.get('archive')).archive ?? [];
    assert(!after.some((e) => e.id === entry.id), 'アーカイブから消えていない');
  });

  await check('自動アーカイブ: しばらく触っていないタブが閉じてアーカイブに残る', async () => {
    const t = await chrome.tabs.create({ windowId: testWin.id, url: 'https://example.net/?auto-archive-test=1', active: false });
    await waitForUrl(t.id, 'https://example.net/');
    await sleep(1500);
    const closed = await send('testAutoArchive', { tabIds: [t.id], seconds: 1 });
    assert(closed.includes(t.id), '閉じられていない');
    const { archive = [] } = await chrome.storage.local.get('archive');
    const entry = archive.find((e) => e.url.includes('auto-archive-test=1'));
    assert(entry?.reason === 'auto', 'アーカイブにない');
    archivedIds.push(entry.id);
  });

  for (const id of archivedIds) await send('deleteArchived', { id }).catch(() => {});
  if (newSpaceId) await send('unpin', { bookmarkId: newSpaceId }).catch(() => {});
  await chrome.windows.remove(testWin.id).catch(() => {});

  // 後片付け
  for (const id of cleanup.tabs) await chrome.tabs.remove(id).catch(() => {});
  for (const id of cleanup.bookmarks) {
    const node = await chrome.bookmarks.get(id).catch(() => null);
    if (node) await chrome.bookmarks.removeTree(id).catch(() => chrome.bookmarks.remove(id).catch(() => {}));
  }
  finish();
}

async function finish() {
  const passed = results.filter(Boolean).length;
  const summary = `${passed}/${results.length}`;
  out.textContent += `\n結果: ${summary}\n`;
  document.title = `SELFTEST ${passed === results.length ? 'PASS' : 'FAIL'} ${summary}`;
  await chrome.storage.local.set({ selftest: { at: new Date().toISOString(), summary, text: out.textContent } });
}

document.getElementById('run').addEventListener('click', () => runAll());
const params = new URLSearchParams(location.search);
// 開発用: ?reload=1 で拡張を再読み込みする（Service Worker の変更を反映するため）
if (params.has('reload')) chrome.runtime.reload();
else if (params.has('auto')) setTimeout(runAll, 3000);
