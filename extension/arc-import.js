// Arc の StorableSidebar.json を読み解き、サイドバーのブックマーク構成へ取り込む。
// 形式（Arc 1.168 で確認）:
//   sidebar.containers[1].spaces             … [id, space, id, space, ...]
//   sidebar.containers[1].items              … [id, item, id, item, ...]
//   sidebar.containers[1].topAppsContainerIDs … [profile, containerId, ...]（Favorites はプロファイルごと）
//   space.containerIDs                       … ['pinned', id, 'unpinned', id]
//   space.customInfo.iconType                … { emoji_v2: '🚀' } / { emoji: 128640 } / { icon: 'planet' }
// Favorites はプロファイルごとなので、各プロファイルの最初のスペースの「Favorites」フォルダ（スペースごとの Favorites）に入れる。
//   item.data                                … { tab: { savedURL, savedTitle } } / { list: {} }（フォルダ）/ { splitView: {...} }
// 取り込みは足すだけで、今あるものは消さない。sidebarSyncState / firebaseSyncState は同期用のコピーなので見ない。

// Arc のアイコン名 → 絵文字（Chrome では Arc のアイコンを描けないため、近い絵文字に置き換える）
const ARC_ICON_EMOJI = {
  planet: '🪐', star: '⭐', heart: '❤️', house: '🏠', home: '🏠', briefcase: '💼', book: '📖', books: '📚',
  bolt: '⚡', flame: '🔥', fire: '🔥', leaf: '🍃', moon: '🌙', sun: '☀️', globe: '🌐', cart: '🛒',
  gamecontroller: '🎮', game: '🎮', music: '🎵', person: '👤', people: '👥', code: '💻', laptop: '💻',
  graduationcap: '🎓', school: '🎓', paintbrush: '🖌️', palette: '🎨', camera: '📷', film: '🎬',
  airplane: '✈️', car: '🚗', bicycle: '🚲', dumbbell: '🏋️', sparkles: '✨', cloud: '☁️', flag: '🚩',
  bell: '🔔', bag: '👜', gift: '🎁', cup: '☕', coffee: '☕', fork: '🍴', pawprint: '🐾', flower: '🌸',
  tree: '🌳', mountain: '⛰️', wave: '🌊', rocket: '🚀', lightbulb: '💡', chart: '📈', dollar: '💵',
  hammer: '🔨', wrench: '🔧', terminal: '💻', newspaper: '📰', envelope: '✉️', calendar: '📅', map: '🗺️',
};

const pairs = (list) => {
  const out = [];
  for (let i = 0; i + 1 < (list?.length ?? 0); i += 2) out.push([list[i], list[i + 1]]);
  return out;
};

export function arcIconToEmoji(iconType) {
  if (!iconType) return null;
  if (typeof iconType.emoji_v2 === 'string' && iconType.emoji_v2) return iconType.emoji_v2;
  if (typeof iconType.emoji === 'number') {
    try {
      return String.fromCodePoint(iconType.emoji);
    } catch {
      return null;
    }
  }
  if (typeof iconType.emoji === 'string' && iconType.emoji) return iconType.emoji;
  if (typeof iconType.icon === 'string') return ARC_ICON_EMOJI[iconType.icon.toLowerCase()] ?? null;
  return null;
}

const profileKey = (profile) =>
  profile?.default ? 'default' : (profile?.custom?._0?.directoryBasename ?? JSON.stringify(profile ?? {}));

// JSON を、取り込みやすい木の形に直す（ブラウザの API は使わない純粋な関数）
export function parseArcSidebar(json) {
  const container = json?.sidebar?.containers?.find((c) => Array.isArray(c?.spaces) && Array.isArray(c?.items));
  if (!container) throw new Error('Arc のサイドバーのファイルではないようです（sidebar.containers が見つかりません）');
  const items = new Map();
  for (const item of container.items) if (item && typeof item === 'object' && item.id) items.set(item.id, item);

  const skipped = { unsupported: 0 };
  const toNode = (id) => {
    const item = items.get(id);
    if (!item) return [];
    const data = item.data ?? {};
    if (data.tab) {
      const url = data.tab.savedURL;
      if (!url) return [];
      return [{ type: 'link', title: item.title || data.tab.savedTitle || url, url }];
    }
    if (data.list) {
      return [{ type: 'folder', title: item.title || 'フォルダ', children: (item.childrenIds ?? []).flatMap(toNode) }];
    }
    // Split View のペアは、中のタブを 1 つずつピン留めとして取り込む
    if (data.splitView || data.itemContainer) return (item.childrenIds ?? []).flatMap(toNode);
    skipped.unsupported += 1;
    return [];
  };
  const childrenOf = (containerId) => (items.get(containerId)?.childrenIds ?? []).flatMap(toNode);

  const favoritesByProfile = new Map();
  for (const [profile, containerId] of pairs(container.topAppsContainerIDs)) {
    if (typeof containerId === 'string') favoritesByProfile.set(profileKey(profile), childrenOf(containerId));
  }

  const spaces = pairs(container.spaces)
    .map(([, space]) => space)
    .filter((space) => space && typeof space === 'object')
    .map((space) => {
      const ids = space.containerIDs ?? [];
      const pinnedId = ids[ids.indexOf('pinned') + 1];
      const unpinnedId = ids[ids.indexOf('unpinned') + 1];
      const key = profileKey(space.profile);
      return {
        title: space.title || '名前のないスペース',
        icon: arcIconToEmoji(space.customInfo?.iconType),
        profile: key,
        pinned: ids.includes('pinned') ? childrenOf(pinnedId) : [],
        unpinnedCount: ids.includes('unpinned') ? childrenOf(unpinnedId).length : 0,
        favorites: [],
      };
    });

  const parsed = { spaces, skipped, favoritesByProfile: Object.fromEntries(favoritesByProfile) };
  assignFavorites(parsed);
  return parsed;
}

// プロファイルの Favorites を、そのプロファイルのスペースのうち最初の 1 つにだけ入れる
// （同じプロファイルのスペースが複数あると、Favorites が重複して入ってしまうため）
function assignFavorites(parsed) {
  const seen = new Set();
  for (const space of parsed.spaces) {
    space.favorites = seen.has(space.profile) ? [] : (parsed.favoritesByProfile[space.profile] ?? []);
    seen.add(space.profile);
  }
}

// 取り込むスペースを選ぶ（1 プロファイル = 1 スペースで使うとき、各プロファイルに対応するスペースだけ入れるため）。
// 選んだスペースの中で、プロファイルごとに最初のスペースへ Favorites を入れ直す
export function selectSpaces(parsed, indexes) {
  const keep = new Set(indexes);
  const selected = {
    ...parsed,
    spaces: parsed.spaces.filter((_, i) => keep.has(i)).map((space) => ({ ...space })),
  };
  assignFavorites(selected);
  return selected;
}

// プロファイルの見出し（既定のプロファイルは「既定」）
export function profileLabel(key) {
  return key === 'default' ? '既定のプロファイル' : key;
}

export function countTree(nodes) {
  let links = 0;
  let folders = 0;
  for (const n of nodes) {
    if (n.type === 'link') links += 1;
    else {
      folders += 1;
      const c = countTree(n.children);
      links += c.links;
      folders += c.folders;
    }
  }
  return { links, folders };
}

// 解析結果をブックマークへ書き出す。structure は Service Worker の init が返す構成、send は SW へのメッセージ関数
export async function importArc(parsed, { structure, send, onProgress = () => {} }) {
  const total = parsed.spaces.reduce((n, s) => n + countTree([...s.pinned, ...s.favorites]).links, 0);
  const result = { spacesCreated: 0, spacesMerged: 0, links: 0, folders: 0, duplicates: 0, failed: 0 };
  let done = 0;

  const writeNodes = async (nodes, parentId) => {
    const existing = await chrome.bookmarks.getChildren(parentId);
    for (const node of nodes) {
      if (node.type === 'link') {
        done += 1;
        onProgress(done, total);
        if (existing.some((e) => e.url === node.url)) {
          result.duplicates += 1;
          continue;
        }
        try {
          await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
          result.links += 1;
        } catch {
          result.failed += 1; // arc:// など、ブックマークにできない URL
        }
      } else {
        const folder =
          existing.find((e) => !e.url && e.title === node.title) ?? (await chrome.bookmarks.create({ parentId, title: node.title }));
        result.folders += 1;
        await writeNodes(node.children, folder.id);
      }
    }
  };

  const current = await chrome.bookmarks.getChildren(structure.spacesId);
  for (const space of parsed.spaces) {
    let folder = current.find((c) => !c.url && c.title === space.title);
    if (folder) result.spacesMerged += 1;
    else {
      folder = await chrome.bookmarks.create({ parentId: structure.spacesId, title: space.title });
      current.push(folder);
      result.spacesCreated += 1;
    }
    if (space.icon) await send('setSpaceIcon', { spaceId: folder.id, icon: space.icon, onlyIfEmpty: true });
    if (space.favorites.length) {
      await writeNodes([{ type: 'folder', title: 'Favorites', children: space.favorites }], folder.id);
    }
    await writeNodes(space.pinned, folder.id);
  }
  return result;
}
