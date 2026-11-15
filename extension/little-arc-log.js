const DEFAULT_SETTINGS = { enabled: true, windowType: 'popup', width: 960, height: 720 };

const form = document.getElementById('settings');
const rows = document.getElementById('rows');
const json = document.getElementById('json');

async function loadSettings() {
  const { littleArcSettings } = await chrome.storage.local.get('littleArcSettings');
  const s = { ...DEFAULT_SETTINGS, ...littleArcSettings };
  form.enabled.checked = s.enabled;
  form.windowType.value = s.windowType;
  form.width.value = s.width;
  form.height.value = s.height;
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text ?? '';
  return td;
}

async function render() {
  const all = (await chrome.storage.local.get('littleArcLogs')).littleArcLogs ?? [];
  // little-arc-log.html?type=little,move のように種類で絞り込める
  const types = new URLSearchParams(location.search).get('type')?.split(',');
  const logs = types ? all.filter((l) => types.includes(l.type)) : all;
  rows.replaceChildren(
    ...logs.map((l) => {
      const tr = document.createElement('tr');
      tr.className = l.type;
      tr.append(
        cell(new Date(l.at).toLocaleTimeString('ja-JP')),
        cell(l.type),
        cell(l.reason ?? l.result ?? l.windowType ?? l.error),
        cell(l.url),
        cell(l.signals ? JSON.stringify(l.signals) : l.error ?? ''),
      );
      return tr;
    }),
  );
  json.textContent = JSON.stringify(logs, null, 2);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({
    littleArcSettings: {
      enabled: form.enabled.checked,
      windowType: form.windowType.value,
      width: Number(form.width.value),
      height: Number(form.height.value),
    },
  });
  const saved = document.getElementById('saved');
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 1500);
});

document.getElementById('refresh').addEventListener('click', render);
document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ littleArcLogs: [] });
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.littleArcLogs) render();
});

chrome.commands.getAll().then((cmds) => {
  document.getElementById('commands').textContent =
    'ショートカット: ' + cmds.map((c) => `${c.description || c.name} = ${c.shortcut || '未割り当て'}`).join(' / ');
});

loadSettings();
render();

// 開発用: little-arc-log.html?reload=1 で拡張を再読み込みする（Service Worker の変更を反映するため）
if (new URLSearchParams(location.search).has('reload')) chrome.runtime.reload();
