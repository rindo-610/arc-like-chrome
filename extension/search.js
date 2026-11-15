// コマンドバーの検索。点数付け（純粋な関数）と、タブ・ブックマーク・履歴の集め方。

// ---- 点数付け ----

// 1 語ぶんの一致の点数。0 は一致なし。
// 先頭一致 > 単語の頭での一致 > 途中の一致 > 飛び飛びの一致（あいまい）の順に高い
export function scoreToken(token, text) {
  if (!token) return 1;
  if (!text) return 0;
  const t = text.toLowerCase();
  const i = t.indexOf(token);
  if (i === 0) return 100;
  if (i > 0) return /[\s\-_/.:?#=&|・（(「]/.test(t[i - 1]) ? 80 : 60;
  // 飛び飛びの一致: 文字が順番に出てくれば一致。間が空くほど低い
  let pos = -1;
  let gaps = 0;
  for (const ch of token) {
    const next = t.indexOf(ch, pos + 1);
    if (next < 0) return 0;
    if (pos >= 0) gaps += next - pos - 1;
    pos = next;
  }
  return Math.max(10, 40 - gaps);
}

// 空白で区切った全部の語が、タイトルか URL のどちらかに一致したときだけ点数を返す
export function scoreItem(query, title, url) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  let total = 0;
  const host = hostOf(url);
  for (const token of tokens) {
    const s = Math.max(scoreToken(token, title), scoreToken(token, host) * 0.95, scoreToken(token, url) * 0.7);
    if (!s) return 0;
    total += s;
  }
  return total / tokens.length;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// 同じページを 1 つにまとめるための URL（末尾の / と # 以降を無視）
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

// URL として開けそうな入力か（スキームあり、または example.com のような形）
export function looksLikeUrl(text) {
  const q = text.trim();
  if (!q || /\s/.test(q)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^(about|chrome|chrome-extension):/i.test(q)) return true;
  if (/^localhost(:\d+)?(\/|$)/i.test(q)) return true;
  return /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q);
}

export function toUrl(text) {
  const q = text.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(q) && !/^localhost:/i.test(q) ? q : `https://${q}`;
}

// 候補（kind: tab / bookmark / history）を点数順に並べ、同じページは 1 つにまとめる（タブ > ブックマーク > 履歴）
const KIND_WEIGHT = { tab: 1.3, bookmark: 1.15, history: 1 };
const KIND_RANK = { tab: 0, bookmark: 1, history: 2 };

export function rank(query, candidates, limit = 8) {
  const scored = [];
  for (const c of candidates) {
    const s = scoreItem(query, c.title, c.url);
    if (!s) continue;
    const visits = c.visitCount ? Math.log10(1 + c.visitCount) * 6 : 0;
    scored.push({ ...c, score: s * KIND_WEIGHT[c.kind] + visits });
  }
  scored.sort((a, b) => b.score - a.score || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  const seen = new Map();
  for (const item of scored) {
    const key = normalizeUrl(item.url);
    const prev = seen.get(key);
    if (!prev) seen.set(key, item);
    else if (KIND_RANK[item.kind] < KIND_RANK[prev.kind]) seen.set(key, { ...item, score: prev.score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---- 候補を集める（拡張のページから呼ぶ）----

let bookmarkCache = null;

async function allBookmarks() {
  if (bookmarkCache) return bookmarkCache;
  const out = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) out.push({ kind: 'bookmark', title: n.title || n.url, url: n.url, path });
      if (n.children) walk(n.children, n.title ? [...path, n.title] : path);
    }
  };
  walk(await chrome.bookmarks.getTree(), []);
  bookmarkCache = out;
  return out;
}

export async function searchAll(query, { excludeTabId } = {}) {
  const [tabs, bookmarks, history] = await Promise.all([
    chrome.tabs.query({}),
    allBookmarks(),
    chrome.history.search({ text: query, maxResults: 40, startTime: 0 }),
  ]);
  const candidates = [
    ...tabs
      .filter((t) => t.id !== excludeTabId && (t.url || t.pendingUrl))
      .map((t) => ({ kind: 'tab', title: t.title || t.url, url: t.url || t.pendingUrl, tabId: t.id, windowId: t.windowId })),
    ...bookmarks,
    ...history.map((h) => ({ kind: 'history', title: h.title || h.url, url: h.url, visitCount: h.visitCount })),
  ];
  return rank(query, candidates);
}

// 何も入力していないとき: 最近使ったタブ（今のタブを除く）。先頭で Enter を押すと直前のタブに戻る
export async function recentTabs({ excludeTabId, limit = 8 } = {}) {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.id !== excludeTabId && (t.url || t.pendingUrl) && !/^chrome:\/\/newtab/.test(t.url || ''))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .slice(0, limit)
    .map((t) => ({ kind: 'tab', title: t.title || t.url, url: t.url || t.pendingUrl, tabId: t.id, windowId: t.windowId }));
}
