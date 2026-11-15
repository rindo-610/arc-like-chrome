// サイドバーの今の状態を 1 画面にまとめて表示する（手動テストの結果確認用）

const out = document.getElementById('out');

async function main() {
  const structure = (await chrome.runtime.sendMessage({ type: 'init' })).result;
  const [tree] = await chrome.bookmarks.getSubTree(structure.rootId);
  const { links = {}, openWindows = [] } = await chrome.storage.session.get(['links', 'openWindows']);
  const { collapsed = [], overlayDiag, overlayWidth, edgeDiag, injectDiag } = await chrome.storage.local.get(['collapsed', 'overlayDiag', 'overlayWidth', 'edgeDiag', 'injectDiag']);
  const tabs = await chrome.tabs.query({});
  const tabsById = new Map(tabs.map((t) => [t.id, t]));
  const layout = await chrome.sidePanel.getLayout().catch((e) => String(e));
  const windows = await chrome.windows.getAll();

  const lines = [];
  lines.push(`サイドパネルの位置: ${JSON.stringify(layout)}`);
  lines.push(`サイドパネルが開いているウィンドウ: ${JSON.stringify(openWindows)} / 通常ウィンドウ: ${JSON.stringify(windows.filter((w) => w.type === 'normal').map((w) => w.id))}`);
  lines.push(`閉じているフォルダ: ${JSON.stringify(collapsed)}`);
  lines.push(`同期フォルダ: ${structure.syncing}`);
  lines.push(`重ねて出すサイドバー: 最後の読み込み ${JSON.stringify(overlayDiag ?? null)} / 幅 ${overlayWidth ?? '既定'}`);
  lines.push(`左端ホバー: 最後の反応 ${JSON.stringify(edgeDiag ?? null)}`);
  lines.push(`開いているタブへの入れ直し: ${JSON.stringify(injectDiag ?? null)}`);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
  lines.push(`runtime.getContexts(SIDE_PANEL): ${JSON.stringify(contexts.map((c) => ({ windowId: c.windowId, tabId: c.tabId, url: c.documentUrl?.split('?')[0] })))}`);
  lines.push('');

  const walk = (node, depth) => {
    const pad = '  '.repeat(depth);
    if (!node.url) {
      const mark = collapsed.includes(node.id) ? '▸' : '▾';
      lines.push(`${pad}${mark} [${node.id}] ${node.title}/`);
      for (const c of node.children ?? []) walk(c, depth + 1);
      return;
    }
    const tab = tabsById.get(links[node.id]);
    let state = '閉じている';
    if (tab) state = tab.url === node.url ? `開いている(tab ${tab.id}, win ${tab.windowId})` : `移動中(今: ${tab.url})`;
    lines.push(`${pad}- [${node.id}] ${node.title} <${node.url}> … ${state}`);
  };
  walk(tree, 0);
  out.textContent = lines.join('\n');
  document.title = 'SIDEBAR STATE';
}

main().catch((e) => (out.textContent = String(e)));
