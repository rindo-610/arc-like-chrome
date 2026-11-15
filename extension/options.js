import { parseArcSidebar, countTree, importArc, selectSpaces, profileLabel } from './arc-import.js';

const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) throw new Error(res?.error ?? '応答がありません');
  return res.result;
}

// ---- 自動アーカイブ ----

const { settings = {} } = await chrome.storage.local.get('settings');
$('archive').value = String(settings.archiveAfterHours ?? 24);

$('archive').addEventListener('change', async () => {
  const { settings: current = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...current, archiveAfterHours: Number($('archive').value) } });
  $('saved').textContent = '保存しました';
  setTimeout(() => ($('saved').textContent = ''), 1500);
});

// ---- 以前の共通 Favorites をスペースへ移す ----

async function renderShared() {
  const structure = await send('init');
  const shared = (await chrome.bookmarks.getChildren(structure.favoritesId)).filter((n) => n.url);
  $('shared').hidden = shared.length === 0;
  if (!shared.length) return;
  $('shared-count').textContent = String(shared.length);
  const { id: windowId } = await chrome.windows.getCurrent();
  const { spaces } = await send('getSpaceState', { windowId });
  $('shared-target').replaceChildren(
    ...spaces.map((sp) => {
      const option = document.createElement('option');
      option.value = sp.id;
      option.textContent = `${sp.icon ? `${sp.icon} ` : ''}${sp.title}`;
      return option;
    }),
  );
}

$('shared-move').addEventListener('click', async () => {
  $('shared-move').disabled = true;
  try {
    const moved = await send('moveSharedFavorites', { spaceId: $('shared-target').value });
    $('shared-status').textContent = `${moved} 件を移しました`;
    await renderShared();
  } catch (e) {
    $('shared-status').textContent = `移せませんでした: ${e.message}`;
    $('shared-status').className = 'status error';
  } finally {
    $('shared-move').disabled = false;
  }
});

renderShared();

// ---- Arc から取り込む ----

let parsed = null;

function li(text) {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}

$('arc-file').addEventListener('change', async () => {
  const file = $('arc-file').files[0];
  $('arc-status').textContent = '';
  $('arc-status').className = 'status';
  $('arc-preview').hidden = true;
  $('arc-import').hidden = true;
  parsed = null;
  if (!file) return;
  try {
    parsed = parseArcSidebar(JSON.parse(await file.text()));
  } catch (e) {
    $('arc-status').textContent = `読み込めませんでした: ${e.message}`;
    $('arc-status').className = 'status error';
    return;
  }
  // スペースごとにチェックを付けて、取り込むものを選べるようにする（1 プロファイル = 1 スペースで使うとき用）
  const list = document.createElement('ul');
  list.className = 'space-list';
  parsed.spaces.forEach((space, i) => {
    const c = countTree(space.pinned);
    const parts = [`Favorites ${countTree(space.favorites).links} 件`, `ピン留め ${c.links} 件`, `フォルダ ${c.folders} 個`];
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.index = String(i);
    box.addEventListener('change', updateImportButton);
    const label = document.createElement('label');
    label.className = 'space-choice';
    const name = document.createElement('span');
    name.textContent = `${space.icon ? `${space.icon} ` : ''}${space.title}`;
    const meta = document.createElement('span');
    meta.className = 'note';
    meta.textContent = `${profileLabel(space.profile)}・${parts.join('、')}`;
    label.append(box, name, meta);
    const item = document.createElement('li');
    item.append(label);
    list.append(item);
  });
  const heading = document.createElement('div');
  heading.textContent = '取り込むスペース（Arc ではスペースごとのプロファイルを右に表示）';
  $('arc-preview').replaceChildren(heading, list);
  $('arc-preview').hidden = false;
  $('arc-import').hidden = false;
});

function checkedIndexes() {
  return [...document.querySelectorAll('.space-list input[type=checkbox]')].filter((b) => b.checked).map((b) => Number(b.dataset.index));
}

function updateImportButton() {
  $('arc-import').disabled = checkedIndexes().length === 0;
}

$('arc-import').addEventListener('click', async () => {
  if (!parsed) return;
  const selected = selectSpaces(parsed, checkedIndexes());
  if (!selected.spaces.length) return;
  $('arc-import').disabled = true;
  try {
    const structure = await send('init');
    const result = await importArc(selected, {
      structure,
      send,
      onProgress: (done, total) => ($('arc-status').textContent = `取り込み中… ${done} / ${total}`),
    });
    const parts = [
      `スペース: 新規 ${result.spacesCreated}、既存にまとめた ${result.spacesMerged}`,
      `リンク ${result.links} 件`,
      `フォルダ ${result.folders} 個`,
    ];
    if (result.duplicates) parts.push(`同じ URL のため飛ばした ${result.duplicates} 件`);
    if (result.failed) parts.push(`取り込めなかった ${result.failed} 件`);
    $('arc-status').textContent = `取り込みました（${parts.join('、')}）`;
    $('arc-import').hidden = true;
  } catch (e) {
    $('arc-status').textContent = `途中で失敗しました: ${e.message}`;
    $('arc-status').className = 'status error';
  } finally {
    $('arc-import').disabled = false;
  }
});

// ---- Live Folders（GitHub） ----

function timeText(ms) {
  return new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function renderLiveFolders() {
  const state = await send('liveFoldersState');
  const { id: windowId } = await chrome.windows.getCurrent();
  const { spaces } = await send('getSpaceState', { windowId });
  $('lf-space').replaceChildren(
    ...spaces.map((sp) => {
      const option = document.createElement('option');
      option.value = sp.id;
      option.textContent = `${sp.icon ? `${sp.icon} ` : ''}${sp.title}`;
      return option;
    }),
  );
  $('lf-space').value = state.spaceId ?? spaces[0]?.id ?? '';
  $('lf-interval').value = String(state.interval);
  $('lf-token').value = '';
  $('lf-token').placeholder = state.hasToken ? '保存済み（変えるときだけ入力）' : 'github_pat_...';
  $('lf-refresh').disabled = !state.hasToken;
  $('lf-clear').disabled = !state.hasToken;
  const st = state.status;
  $('lf-status').className = `status${st && !st.ok ? ' error' : ''}`;
  $('lf-status').textContent = !st
    ? ''
    : st.ok
      ? `${timeText(st.at)} に更新: レビュー依頼 ${st.counts.review} 件、自分の PR ${st.counts.mine} 件`
      : `${timeText(st.at)}: ${st.error}`;
}

async function lfRun(button, fn) {
  button.disabled = true;
  $('lf-status').className = 'status';
  $('lf-status').textContent = '更新しています…';
  try {
    await fn();
  } catch (e) {
    $('lf-status').className = 'status error';
    $('lf-status').textContent = String(e.message ?? e);
    return;
  } finally {
    button.disabled = false;
  }
  await renderLiveFolders();
}

$('lf-save').addEventListener('click', () =>
  lfRun($('lf-save'), () => {
    const token = $('lf-token').value.trim();
    return send('liveFoldersSave', {
      token: token || undefined,
      interval: Number($('lf-interval').value),
      spaceId: $('lf-space').value,
    });
  }),
);
$('lf-refresh').addEventListener('click', () => lfRun($('lf-refresh'), () => send('liveFoldersRefresh')));
$('lf-clear').addEventListener('click', () => lfRun($('lf-clear'), () => send('liveFoldersSave', { token: '' })));

renderLiveFolders();

// ---- 書き出しと読み込み ----
// 拡張の ID が変わる（別のフォルダから読み込み直す）と storage.local は引き継がれないので、JSON で持ち運ぶ。
// ブックマークの ID は同じプロファイルなら変わらないので、ID をキーにした値もそのまま使える

const BACKUP_KEYS = ['settings', 'collapsed', 'splitFolders', 'spaceColors', 'spaceIcons', 'spaceByUrl', 'archive', 'overlayWidth', 'littleArcSettings', 'liveFolders'];

$('backup-export').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(BACKUP_KEYS);
  const blob = new Blob([JSON.stringify({ format: 'arc-like-backup', version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `arc-like-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  $('backup-status').className = 'status';
  $('backup-status').textContent = `${Object.keys(data).length} 項目を書き出しました`;
});

$('backup-import').addEventListener('change', async () => {
  const file = $('backup-import').files[0];
  $('backup-import').value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.format !== 'arc-like-backup' || typeof parsed.data !== 'object') throw new Error('この拡張の書き出したファイルではありません');
    const data = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => BACKUP_KEYS.includes(k)));
    await chrome.storage.local.set(data);
    $('backup-status').className = 'status';
    $('backup-status').textContent = `${Object.keys(data).length} 項目を読み込みました`;
    renderLiveFolders();
  } catch (e) {
    $('backup-status').className = 'status error';
    $('backup-status').textContent = `読み込めませんでした: ${e.message}`;
  }
});
