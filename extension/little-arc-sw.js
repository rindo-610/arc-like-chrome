// Little Arc（sw.js から読み込む）
// 外部アプリから開かれたタブを推定し、小窓（popup / 小さい normal ウィンドウ）へ移す。
// 判定に使った材料と結果は storage.local にログとして残し、little-arc-log.html で確認する。
// storage のキーはサイドバーとぶつからないよう littleArc で始める。
//
// 実機（Chrome 156）で分かったこと:
// - 外部アプリから開いたタブにも openerTabId が付く。値はその時点のアクティブタブ。
// - 拡張が tabs.create で作ったタブには opener が付かない（Claude in Chrome は chrome://newtab/ で作ってから遷移する）。
// そのため「opener がアクティブタブ」かつ「直前に Chrome にフォーカスがなかった」を外部リンクの条件にする。
// - ただし Chrome が非フォーカスのときに Claude in Chrome がページ内リンクを新しいタブで開くと、上の条件をすべて満たしてしまう。
//   ページ内リンク・window.open から作られたタブには webNavigation.onCreatedNavigationTarget が飛ぶので、それで除外する。

const STARTUP_GRACE_MS = 5000;
// 他アプリからリンクを開くと、Chrome がウィンドウを前面に出すので
// onCreated より先に onFocusChanged が来ることがある。その猶予。
const UNFOCUSED_WINDOW_MS = 1500;
const LOG_LIMIT = 300;
// onCreatedNavigationTarget は tabs.onCreated の前後どちらにも来うるので、判定前に少し待つ
const NAV_TARGET_WAIT_MS = 300;

// ページから作られたタブ（tabId -> sourceTabId）。Service Worker が止まれば消えてよい短命の情報
const navTargets = new Map();
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ tabId, sourceTabId }) => {
  navTargets.set(tabId, sourceTabId);
  setTimeout(() => navTargets.delete(tabId), 10_000);
});

const DEFAULT_SETTINGS = {
  enabled: true,
  windowType: 'popup', // 'popup' | 'normal'
  width: 960,
  height: 720,
};

// Service Worker は止まるので、状態は storage.session にも書く。
// イベント同士の読み書きが前後しないよう、読み込み後はメモリ上のオブジェクトを同期的に更新する。
const statePromise = chrome.storage.session.get('littleArcState').then(({ littleArcState: state }) => ({
  focusedWindowId: chrome.windows.WINDOW_ID_NONE,
  unfocusedSince: 0, // Chrome 全体がフォーカスを失った時刻（0 = 不明）
  refocusedAt: 0, // フォーカスが戻った時刻
  lastNormalWindowId: null,
  startedAt: 0,
  littleWindowIds: [],
  activeTabByWindow: {}, // windowId -> 直前のアクティブタブ
  ...state,
}));

statePromise.then(async (state) => {
  if (Object.keys(state.activeTabByWindow).length > 0) return;
  const tabs = await chrome.tabs.query({ active: true });
  const map = {};
  for (const t of tabs) map[t.windowId] = t.id;
  await setState({ activeTabByWindow: { ...map, ...state.activeTabByWindow } });
});

function getState() {
  return statePromise;
}

async function setState(patch) {
  const state = await statePromise;
  Object.assign(state, patch);
  await chrome.storage.session.set({ littleArcState: state });
}

async function getSettings() {
  const { littleArcSettings } = await chrome.storage.local.get('littleArcSettings');
  return { ...DEFAULT_SETTINGS, ...littleArcSettings };
}

async function log(entry) {
  const { littleArcLogs: logs = [] } = await chrome.storage.local.get('littleArcLogs');
  logs.unshift({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ littleArcLogs: logs.slice(0, LOG_LIMIT) });
}

// クエリ文字列は残さない
function shortUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol.startsWith('http') ? u.origin + u.pathname : u.protocol + '//' + u.host + u.pathname;
  } catch {
    return String(raw).slice(0, 80);
  }
}

chrome.runtime.onStartup.addListener(() => setState({ startedAt: Date.now() }));
chrome.runtime.onInstalled.addListener(async () => {
  const win = await chrome.windows.getLastFocused().catch(() => null);
  await setState({ lastNormalWindowId: win?.type === 'normal' ? win.id : null });
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  const now = Date.now();
  const state = await getState();
  const patch = { focusedWindowId: windowId };
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    patch.unfocusedSince = now;
  } else if (state.focusedWindowId === chrome.windows.WINDOW_ID_NONE) {
    patch.refocusedAt = now;
  }
  await setState(patch);
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (win?.type === 'normal' && !state.littleWindowIds.includes(windowId)) {
    await setState({ lastNormalWindowId: windowId });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const state = await getState();
  await setState({ activeTabByWindow: { ...state.activeTabByWindow, [windowId]: tabId } });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const state = await getState();
  await setState({
    littleWindowIds: state.littleWindowIds.filter((id) => id !== windowId),
    lastNormalWindowId: state.lastNormalWindowId === windowId ? null : state.lastNormalWindowId,
  });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const now = Date.now();
  const state = await getState();
  // ここで判定材料を固定する（後続の await 中に focus イベントで書き換わるため）
  const focusedWindowId = state.focusedWindowId;
  const refocusedAt = state.refocusedAt;
  const activeBefore = state.activeTabByWindow[tab.windowId];
  const settings = await getSettings();
  const url = tab.pendingUrl || tab.url || '';
  const win = await chrome.windows.get(tab.windowId, { populate: true }).catch(() => null);

  const chromeUnfocused =
    focusedWindowId === chrome.windows.WINDOW_ID_NONE ||
    (refocusedAt > 0 && now - refocusedAt < UNFOCUSED_WINDOW_MS);

  const signals = {
    opener: tab.openerTabId ?? null,
    activeBefore: activeBefore ?? null,
    scheme: url.split(':')[0] || '(empty)',
    focusedWindowId,
    msSinceRefocus: refocusedAt ? now - refocusedAt : null,
    msSinceStartup: state.startedAt ? now - state.startedAt : null,
    windowType: win?.type,
    tabsInWindow: win?.tabs?.length ?? null,
    inLittleWindow: state.littleWindowIds.includes(tab.windowId),
  };

  let reason = null;
  if (!settings.enabled) reason = 'disabled';
  else if (!/^https?:\/\//.test(url)) reason = 'not-http';
  else if (tab.openerTabId === undefined) reason = 'no-opener';
  // activeBefore が分からない（Service Worker 起動直後など）ときは opener の一致は問わない
  else if (activeBefore !== undefined && tab.openerTabId !== activeBefore) reason = 'opener-not-active';
  else if (state.startedAt && now - state.startedAt < STARTUP_GRACE_MS) reason = 'startup-grace';
  else if (win && win.type !== 'normal') reason = 'not-normal-window';
  else if (signals.inLittleWindow) reason = 'already-little';
  else if (!chromeUnfocused) reason = 'chrome-was-focused';

  if (!reason) {
    await new Promise((r) => setTimeout(r, NAV_TARGET_WAIT_MS));
    if (navTargets.has(tab.id)) {
      signals.sourceTabId = navTargets.get(tab.id);
      reason = 'link-from-page';
    }
  }

  if (reason) {
    await log({ type: 'skip', tabId: tab.id, url: shortUrl(url), reason, signals });
    return;
  }

  try {
    const base = win ?? (await chrome.windows.getLastFocused());
    const width = settings.width;
    const height = settings.height;
    const left = Math.round((base.left ?? 0) + ((base.width ?? width) - width) / 2);
    const top = Math.round((base.top ?? 0) + ((base.height ?? height) - height) / 3);
    const little = await chrome.windows.create({
      tabId: tab.id,
      type: settings.windowType,
      width,
      height,
      left,
      top,
      focused: true,
    });
    const latest = await getState();
    await setState({ littleWindowIds: [...latest.littleWindowIds, little.id] });
    await log({ type: 'little', tabId: tab.id, url: shortUrl(url), windowType: settings.windowType, signals });
  } catch (e) {
    await log({ type: 'error', step: 'windows.create', tabId: tab.id, url: shortUrl(url), error: String(e), signals });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'move-to-main') return;
  const state = await getState();
  const current = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!current) return;
  // Chrome の再起動や拡張の更新で littleWindowIds は消えるので、popup ウィンドウなら小窓とみなす
  const currentWin = await chrome.windows.get(current.windowId).catch(() => null);
  if (!state.littleWindowIds.includes(current.windowId) && currentWin?.type !== 'popup') {
    await log({ type: 'move', result: 'not-little-window', tabId: current.id });
    return;
  }

  let target = state.lastNormalWindowId;
  if (target == null) {
    const normals = await chrome.windows.getAll({ windowTypes: ['normal'] });
    target = normals.find((w) => !state.littleWindowIds.includes(w.id))?.id ?? null;
  }
  if (target == null) {
    const w = await chrome.windows.create({ tabId: current.id, type: 'normal', focused: true }).catch(() => null);
    await log({ type: 'move', result: w ? 'new-normal-window' : 'failed', tabId: current.id });
    return;
  }

  // まず tabs.move を試す。popup からは動かせない可能性があるので、失敗したら開き直す
  try {
    await chrome.tabs.move(current.id, { windowId: target, index: -1 });
    await chrome.tabs.update(current.id, { active: true });
    await chrome.windows.update(target, { focused: true });
    await log({ type: 'move', result: 'tabs.move', tabId: current.id });
  } catch (e) {
    const url = current.url || current.pendingUrl;
    await chrome.tabs.create({ windowId: target, url, active: true });
    await chrome.windows.update(target, { focused: true });
    await chrome.windows.remove(current.windowId).catch(() => {});
    await log({ type: 'move', result: 'reopened', tabId: current.id, error: String(e) });
  }
});
