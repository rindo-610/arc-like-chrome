// コマンドバー・URL コピー・Peek（sw.js から読み込む）
// - ショートカットで、今のページにコマンドバーを重ねて出す（cmdbar.js に頼む）。出せないページでは小さなウィンドウで出す
// - URL をコピーする（offscreen document で書き込み、cmdbar.js に通知を出してもらう）
// - 重ねて出すコマンドバー（palette.html の iframe）用のトークンを発行・確認する
// 外部への通信は一切しない。

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

// ---- コマンドバーを開く ----

async function openCommandBar(mode) {
  const tab = await activeTab();
  if (!tab) return;
  const delivered = await chrome.tabs
    .sendMessage(tab.id, { type: 'open-command-bar', mode, url: tab.url })
    .then((r) => r?.ok === true)
    .catch(() => false);
  if (delivered) return;
  // chrome:// や新しいタブページなど content script が動かないページでは、小さなウィンドウで出す
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  const width = 680;
  const height = 460;
  const left = Math.round((win?.left ?? 0) + ((win?.width ?? width) - width) / 2);
  const top = Math.round((win?.top ?? 0) + Math.min(160, ((win?.height ?? height) - height) / 3));
  const params = new URLSearchParams({ mode, target: String(tab.id), popup: '1' });
  await chrome.windows.create({ url: chrome.runtime.getURL(`palette.html?${params}`), type: 'popup', width, height, left, top, focused: true });
}

// ---- URL コピー ----

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'ショートカットで今のページの URL をクリップボードへコピーするため',
  });
}

async function copyUrl() {
  const tab = await activeTab();
  const url = tab?.url || tab?.pendingUrl;
  if (!url) return false;
  await ensureOffscreen();
  const ok = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text: url }).catch(() => false);
  await chrome.tabs.sendMessage(tab.id, { type: 'toast', text: ok ? 'URL をコピーしました' : 'コピーできませんでした' }).catch(() => {});
  return ok === true;
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-command-bar') openCommandBar('new');
  if (command === 'open-command-bar-current') openCommandBar('current');
  if (command === 'copy-url') copyUrl();
});

// ---- Peek ----
// Peek は、今のウィンドウの中央に重ねて浮かぶ小さなウィンドウ（type: popup）で開く。
// 普通のタブと同じ扱いなので、ログインが必要なサイト（X など）もそのまま動き、ヘッダを外す必要もない。
// Little Arc の小窓と同じ種類のウィンドウなので、Peek を選んで Cmd+O でメインのウィンドウへタブとして移せる。
// 外（ほかの Chrome のウィンドウ）をクリックしたら閉じる。

async function getPeekWindows() {
  return (await chrome.storage.session.get('peekWindows')).peekWindows ?? {};
}

async function setPeekWindows(map) {
  await chrome.storage.session.set({ peekWindows: map });
}

async function openPeek(url, openerTab) {
  const peeks = await getPeekWindows();
  // Peek の中からさらに Peek を開いたときは、同じウィンドウで開き直す
  if (peeks[openerTab.windowId]) {
    await chrome.tabs.update(openerTab.id, { url });
    return openerTab.windowId;
  }
  const win = await chrome.windows.get(openerTab.windowId);
  const width = Math.round(Math.min(1280, (win.width ?? 1280) * 0.82));
  const height = Math.round((win.height ?? 900) * 0.86);
  const left = Math.round((win.left ?? 0) + ((win.width ?? width) - width) / 2);
  const top = Math.round((win.top ?? 0) + ((win.height ?? height) - height) / 2);
  const peek = await chrome.windows.create({ url, type: 'popup', width, height, left, top, focused: true });
  peeks[peek.id] = { openerWindowId: openerTab.windowId, openerTabId: openerTab.id, createdAt: Date.now() };
  await setPeekWindows(peeks);
  return peek.id;
}

async function closePeek(windowId) {
  const peeks = await getPeekWindows();
  if (!peeks[windowId]) return;
  delete peeks[windowId];
  await setPeekWindows(peeks);
  await chrome.windows.remove(windowId).catch(() => {});
}

// 外（ほかの Chrome のウィンドウ）にフォーカスが移ったら閉じる。ほかのアプリへ移ったとき（NONE）は閉じない。
// 開いた直後は、クリックした元のウィンドウにフォーカスが一瞬戻ることがあるので閉じない
const OPEN_GRACE_MS = 600;
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const peeks = await getPeekWindows();
  for (const [id, info] of Object.entries(peeks)) {
    if (Number(id) === windowId || Date.now() - (info.createdAt ?? 0) < OPEN_GRACE_MS) continue;
    await closePeek(Number(id));
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const peeks = await getPeekWindows();
  if (!peeks[windowId]) return;
  delete peeks[windowId];
  await setPeekWindows(peeks);
});

// ピン留め・Favorites のタブかどうか（サイドバーがブックマークとタブの対応を storage.session の links に持っている）
async function isPinnedTab(tabId) {
  const { links = {} } = await chrome.storage.session.get('links');
  return Object.values(links).includes(tabId);
}

// ---- メッセージ ----

const handlers = {
  // palette.html はどのサイトからも iframe で読めてしまうので、cmdbar.js が受け取ったトークンがあるときだけ中身を出す
  async issueToken(_msg, sender) {
    if (!sender.tab) throw new Error('content script からのみ');
    const token = crypto.randomUUID();
    const { tokens = {} } = await chrome.storage.session.get('tokens');
    tokens[token] = sender.tab.id;
    await chrome.storage.session.set({ tokens });
    return token;
  },

  async checkToken({ token }, sender) {
    const { tokens = {} } = await chrome.storage.session.get('tokens');
    return Boolean(token && tokens[token] != null && tokens[token] === sender.tab?.id);
  },

  // Peek を開く（peek.js から）
  async peekOpen({ url }, sender) {
    if (!sender.tab) throw new Error('content script からのみ');
    return openPeek(url, sender.tab);
  },

  // Peek のウィンドウの中で Esc を押したとき（peek.js から）
  async peekEscape(_msg, sender) {
    if (sender.tab && (await getPeekWindows())[sender.tab.windowId]) await closePeek(sender.tab.windowId);
    return true;
  },

  // このタブで、別のサイトへのリンクを普通にクリックしたときに Peek で開くか（ピン留め・Favorites のタブなら開く）
  async shouldPeekOnClick(_msg, sender) {
    if (!sender.tab) return false;
    if ((await getPeekWindows())[sender.tab.windowId]) return false; // Peek の中では普通に移動する
    return isPinnedTab(sender.tab.id);
  },

  // 開発用（dev/selftest.html から）
  async devPeekOpen({ url, tabId }) {
    return openPeek(url, await chrome.tabs.get(tabId));
  },

  async devPeekWindows() {
    return getPeekWindows();
  },

  async devIsPinnedTab({ tabId }) {
    return isPinnedTab(tabId);
  },

  // 開発用: 指定したタブでコマンドバーを開く（dev/selftest.html から）
  async devOpen({ tabId, mode, activate }) {
    const tab = await chrome.tabs.get(tabId);
    if (activate) {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return chrome.tabs.sendMessage(tabId, { type: 'open-command-bar', mode, url: tab.url });
  },

  async devCopyUrl() {
    return copyUrl();
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // offscreen.js 宛て
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tokens = {} } = await chrome.storage.session.get('tokens');
  const kept = Object.fromEntries(Object.entries(tokens).filter(([, tid]) => tid !== tabId));
  if (Object.keys(kept).length !== Object.keys(tokens).length) await chrome.storage.session.set({ tokens: kept });
});

// 拡張を入れた・更新したときは、開いているタブに content script を入れ直す（Chrome は既存のタブに自動では入れない）
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['cmdbar.js', 'peek.js'] }).catch(() => {})));
});
