// Live Folders（sw.js から読み込む）
// GitHub の PR（レビュー依頼・自分の PR）を、スペースの中のブックマークのフォルダに書き出す。
// サイドバーはそのフォルダを普通のフォルダとして表示する。
// 外へ通信するのはここだけで、相手は api.github.com だけ（manifest の CSP の connect-src でも絞っている）。
// トークン（fine-grained PAT、Pull requests: Read-only）は storage.local の githubToken に置き、設定ページへは返さない。

const ALARM = 'live-folders';
const DEFAULT_INTERVAL = 10; // 分
const FOLDERS = [
  { key: 'review', title: 'レビュー依頼', query: 'is:pr is:open archived:false review-requested:@me' },
  { key: 'mine', title: '自分の PR', query: 'is:pr is:open archived:false author:@me' },
];

async function getConfig() {
  const { liveFolders = {} } = await chrome.storage.local.get('liveFolders');
  return { interval: DEFAULT_INTERVAL, spaceId: null, folders: {}, ...liveFolders };
}

async function setConfig(patch) {
  await chrome.storage.local.set({ liveFolders: { ...(await getConfig()), ...patch } });
}

async function setStatus(status) {
  await chrome.storage.local.set({ liveFoldersStatus: { at: Date.now(), ...status } });
}

async function searchPulls(token, query) {
  const url = new URL('https://api.github.com/search/issues');
  url.search = new URLSearchParams({ q: query, sort: 'updated', order: 'desc', per_page: '50' }).toString();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('トークンが無効です（期限切れか、取り消された可能性があります）');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub の利用制限に当たりました。しばらく待ってから更新します');
  if (!res.ok) throw new Error(`GitHub から ${res.status} が返りました`);
  const body = await res.json();
  return (body.items ?? []).map((pr) => {
    const repo = pr.repository_url?.split('/').pop() ?? '';
    return { url: pr.html_url, title: `${repo}#${pr.number} ${pr.title}` };
  });
}

// フォルダの中身を items（新しい順）に合わせる。URL が同じものは残して名前と順番だけ直す。
// 自分で入れたサブフォルダには触らない（末尾に回る）
export async function writeFolder(folderId, items) {
  const children = await chrome.bookmarks.getChildren(folderId);
  const wanted = new Set(items.map((i) => i.url));
  for (const c of children) if (c.url && !wanted.has(c.url)) await chrome.bookmarks.remove(c.id);
  const byUrl = new Map(children.filter((c) => c.url && wanted.has(c.url)).map((c) => [c.url, c]));
  for (const [index, item] of items.entries()) {
    const existing = byUrl.get(item.url);
    if (!existing) {
      await chrome.bookmarks.create({ parentId: folderId, index, title: item.title, url: item.url });
      continue;
    }
    if (existing.title !== item.title) await chrome.bookmarks.update(existing.id, { title: item.title });
    const [now] = await chrome.bookmarks.get(existing.id);
    if (now.index !== index) await chrome.bookmarks.move(existing.id, { parentId: folderId, index });
  }
}

// スペースの中にフォルダを用意する。消されていたら作り直し、別のスペースにあれば移す
async function ensureFolders(spaceId) {
  const config = await getConfig();
  const folders = { ...config.folders };
  for (const [i, f] of FOLDERS.entries()) {
    const [node] = folders[f.key] ? await chrome.bookmarks.get(folders[f.key]).catch(() => []) : [];
    if (!node) {
      folders[f.key] = (await chrome.bookmarks.create({ parentId: spaceId, index: i, title: f.title })).id;
    } else if (node.parentId !== spaceId) {
      await chrome.bookmarks.move(node.id, { parentId: spaceId });
    }
  }
  await setConfig({ folders });
  return folders;
}

// 書き出し先を選んでいないときは、最初のスペース（Arc/Spaces の最初のフォルダ）
async function firstSpaceId() {
  for (const spaces of (await chrome.bookmarks.search({ title: 'Spaces' })).filter((n) => !n.url)) {
    const [parent] = await chrome.bookmarks.get(spaces.parentId);
    if (parent?.title !== 'Arc') continue;
    const [space] = (await chrome.bookmarks.getChildren(spaces.id)).filter((n) => !n.url);
    if (space) return space.id;
  }
  return null;
}

let running = null;
async function refresh() {
  // 同時に 2 回走らないようにする（アラームと「今すぐ更新」が重なったとき）
  running ??= (async () => {
    const { githubToken } = await chrome.storage.local.get('githubToken');
    if (!githubToken) return setStatus({ ok: false, error: 'トークンが未設定です' });
    try {
      const config = await getConfig();
      const spaceId = config.spaceId ?? (await firstSpaceId());
      if (!spaceId) throw new Error('書き出し先のスペースがありません');
      const results = await Promise.all(FOLDERS.map((f) => searchPulls(githubToken, f.query)));
      const folders = await ensureFolders(spaceId);
      for (const [i, f] of FOLDERS.entries()) await writeFolder(folders[f.key], results[i]);
      await setStatus({ ok: true, counts: Object.fromEntries(FOLDERS.map((f, i) => [f.key, results[i].length])) });
    } catch (e) {
      await setStatus({ ok: false, error: String(e?.message ?? e) });
    }
  })().finally(() => (running = null));
  return running;
}

async function schedule() {
  const { githubToken } = await chrome.storage.local.get('githubToken');
  await chrome.alarms.clear(ALARM);
  if (!githubToken) return;
  const { interval } = await getConfig();
  await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, interval) });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refresh();
});
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);

const handlers = {
  // 設定ページから。token は空文字なら消す、undefined なら変えない
  async liveFoldersSave({ token, interval, spaceId }) {
    if (token === '') {
      await chrome.storage.local.remove('githubToken');
      const config = await getConfig();
      for (const id of Object.values(config.folders)) await chrome.bookmarks.removeTree(id).catch(() => {});
      await setConfig({ folders: {} });
      await chrome.storage.local.remove('liveFoldersStatus');
    } else if (typeof token === 'string') {
      await chrome.storage.local.set({ githubToken: token.trim() });
    }
    const patch = {};
    if (Number.isFinite(interval)) patch.interval = interval;
    if (spaceId !== undefined) patch.spaceId = spaceId || null;
    await setConfig(patch);
    await schedule();
    if (typeof token === 'string' && token) await refresh();
    else if (spaceId !== undefined && (await chrome.storage.local.get('githubToken')).githubToken) await refresh();
    return null;
  },

  async liveFoldersRefresh() {
    await refresh();
    return null;
  },

  // トークンそのものは返さない
  async liveFoldersState() {
    const { githubToken, liveFoldersStatus = null } = await chrome.storage.local.get(['githubToken', 'liveFoldersStatus']);
    const config = await getConfig();
    return { hasToken: Boolean(githubToken), interval: config.interval, spaceId: config.spaceId, folders: config.folders, status: liveFoldersStatus };
  },

  // 開発用（dev/selftest.html から）: ダミーのトークンで api.github.com に届くか（CSP で止まらないか）を試す
  async devLiveFoldersProbe() {
    return searchPulls('invalid-token-for-selftest', 'is:pr is:open author:@me').then(
      () => 'ok',
      (e) => String(e?.message ?? e),
    );
  },

  // 開発用（dev/selftest.html から）: GitHub に問い合わせずに、フォルダへの書き出しだけを試す
  async devLiveFoldersWrite({ folderId, items }) {
    await writeFolder(folderId, items);
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
