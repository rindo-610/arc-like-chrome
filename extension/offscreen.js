// クリップボードへの書き込みだけを受け持つ offscreen document。
// Service Worker からはクリップボードに触れず、navigator.clipboard はフォーカスが要るので、execCommand('copy') を使う。

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'copy') return false;
  const buffer = document.getElementById('buffer');
  buffer.value = msg.text;
  buffer.select();
  const ok = document.execCommand('copy');
  buffer.value = '';
  sendResponse(ok);
  return false;
});
