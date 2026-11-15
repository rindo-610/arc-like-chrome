// コマンドバーの検索と、重ねて出す表示・URL コピーの動きを確かめる（開発用）

import { scoreToken, scoreItem, rank, looksLikeUrl, toUrl, searchAll, recentTabs } from '../search.js';

const out = document.getElementById('out');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(ok, name, detail = '') {
  results.push(ok);
  out.textContent += `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' … ' + detail : ''}\n`;
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
async function check(name, fn) {
  try {
    line(true, name, (await fn()) ?? '');
  } catch (e) {
    line(false, name, String(e?.message ?? e));
  }
}
async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? '応答がありません');
  return res.result;
}
async function waitComplete(tabId, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.status === 'complete') return t;
    await sleep(200);
  }
  return chrome.tabs.get(tabId);
}

async function runAll() {
  out.textContent = '';
  const me = await chrome.tabs.getCurrent();
  const cleanup = { bookmarks: [], tabs: [] };

  await check('点数付け: 先頭一致 > 途中、飛び飛びの一致、1 語でも外れたら 0', async () => {
    assert(scoreToken('git', 'github') > scoreToken('hub', 'github'), '先頭一致が高くない');
    assert(scoreToken('gh', 'github') > 0 && scoreToken('xz', 'github') === 0, 'あいまい一致がおかしい');
    assert(scoreItem('git docs', 'GitHub Docs', 'https://docs.github.com/') > 0, '複数語で一致しない');
    assert(scoreItem('git zzz', 'GitHub Docs', 'https://docs.github.com/') === 0, '外れた語があるのに一致した');
  });

  await check('並べ替え: 同じページはタブにまとめる', async () => {
    const r = rank('git', [
      { kind: 'history', title: 'GitHub', url: 'https://github.com/', visitCount: 50 },
      { kind: 'tab', title: 'GitHub', url: 'https://github.com', tabId: 1 },
      { kind: 'bookmark', title: 'GitLab', url: 'https://gitlab.com/' },
    ]);
    assert(r[0].kind === 'tab' && r.length === 2, JSON.stringify(r.map((x) => x.kind)));
  });

  await check('URL の判定と補完', async () => {
    assert(looksLikeUrl('example.com') && looksLikeUrl('localhost:3000') && !looksLikeUrl('how to git'), '判定がおかしい');
    assert(toUrl('example.com') === 'https://example.com', '補完がおかしい');
  });

  let tab;
  await check('検索: 実際のブックマークと開いているタブから見つかる', async () => {
    const bm = await chrome.bookmarks.create({ title: 'selftest-cmdbar-bookmark', url: 'https://example.org/?cmdbar-bm=1' });
    cleanup.bookmarks.push(bm.id);
    tab = await chrome.tabs.create({ windowId: me.windowId, url: 'https://example.com/?cmdbar-tab=1', active: false });
    cleanup.tabs.push(tab.id);
    await waitComplete(tab.id);
    const r1 = await searchAll('selftest-cmdbar');
    assert(r1.some((x) => x.kind === 'bookmark' && x.url.includes('cmdbar-bm=1')), 'ブックマークが見つからない');
    const r2 = await searchAll('cmdbar-tab');
    assert(r2[0]?.kind === 'tab' && r2[0].tabId === tab.id, `タブが先頭にない: ${JSON.stringify(r2.slice(0, 2).map((x) => x.kind + ':' + x.url))}`);
    const r3 = await searchAll('exmpl cmdbar'); // 飛び飛びの一致
    assert(r3.length > 0, 'あいまい検索で見つからない');
    return `件数 ${r1.length} / ${r2.length} / ${r3.length}`;
  });

  await check('最近のタブ: 自分のタブを除いて、最近使った順に並ぶ', async () => {
    const r = await recentTabs({ excludeTabId: me.id });
    assert(r.length > 0 && !r.some((x) => x.tabId === me.id), '自分のタブが入っている／空');
    return `${r.length} 件`;
  });

  await check('重ねて出す表示: ページのタブでコマンドバーが開く', async () => {
    const res = await send('devOpen', { tabId: tab.id, mode: 'new' });
    assert(res?.ok === true, `開けない: ${JSON.stringify(res)}`);
  });

  await check('Peek: 浮いた小さなウィンドウ（popup）で開き、ほかのウィンドウを選ぶと閉じる', async () => {
    const winId = await send('devPeekOpen', { url: 'https://example.org/?peek-test=1', tabId: tab.id });
    const win = await chrome.windows.get(winId, { populate: true });
    assert(win.type === 'popup', `ウィンドウの種類が違う: ${win.type}`);
    assert((win.tabs[0].pendingUrl || win.tabs[0].url).includes('peek-test=1'), 'URL が違う');
    assert((await send('devPeekWindows'))[winId], 'Peek として記録されていない');
    await sleep(700); // 開いた直後（0.6 秒）はフォーカスが戻っても閉じない猶予がある
    await chrome.windows.update(me.windowId, { focused: true });
    await sleep(600);
    assert(!(await chrome.windows.get(winId).catch(() => null)), 'ほかのウィンドウを選んでも閉じない');
    assert(!(await send('devPeekWindows'))[winId], '記録が残っている');
  });

  await check('Peek: ピン留めでないタブでは、普通のクリックを Peek にしない', async () => {
    const pinned = await send('devIsPinnedTab', { tabId: tab.id });
    assert(pinned === false, `ピン留めでないのに true: ${pinned}`);
  });

  await check('URL コピー: offscreen document でクリップボードに書ける', async () => {
    const ok = await send('devCopyUrl');
    assert(ok === true, 'コピーに失敗');
  });

  for (const id of cleanup.tabs) await chrome.tabs.remove(id).catch(() => {});
  for (const id of cleanup.bookmarks) await chrome.bookmarks.remove(id).catch(() => {});
  const passed = results.filter(Boolean).length;
  out.textContent += `\n結果: ${passed}/${results.length}\n`;
  document.title = `SELFTEST ${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length}`;
}

const params = new URLSearchParams(location.search);
if (params.has('reload')) chrome.runtime.reload();
// 開発用: ?open=<タブID>&mode=new|current で、そのタブを前面に出してコマンドバーを開く（見た目の確認用）
else if (params.has('open')) {
  send('devOpen', { tabId: Number(params.get('open')), mode: params.get('mode') ?? 'new', activate: true })
    .then((r) => (out.textContent = `opened: ${JSON.stringify(r)}`))
    .catch((e) => (out.textContent = String(e)));
}
// 開発用: ?peek=<タブID>&url=... で、そのタブから Peek を開く（見た目の確認用）
else if (params.has('peek')) {
  send('devPeekOpen', { tabId: Number(params.get('peek')), url: params.get('url') })
    .then((r) => (out.textContent = `peek window: ${r}`))
    .catch((e) => (out.textContent = String(e)));
}
else if (params.has('auto')) setTimeout(runAll, 1500);
