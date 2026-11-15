# Arc-like for Chrome

Arc ブラウザの使い心地を Google Chrome の上で再現する拡張機能です。サイドバー、スペース、コマンドバー、Peek、Little Arc、Live Folders を 1 つの拡張にまとめています。

Arc は 2026-12-22 で終了します。Chrome に移っても Arc と同じ手の動きで使えることを目指して作りました。

> English summary: A Chrome extension (Manifest V3) that brings Arc-style workflows to Chrome: a sidebar with Favorites, pinned tabs, folders and Today tabs, Spaces, auto-archive, a command bar, Peek, Little Arc, Split View pairs and GitHub Live Folders. No build step, no runtime dependencies, no telemetry. The only network access is to `api.github.com` for Live Folders. The UI is in Japanese.

この拡張は The Browser Company とは関係ありません。「Arc」は同社の製品名です。

## できること

- サイドバー
  - Favorites（アイコンのグリッド）、ピン留め、フォルダ、今日のタブ。ピン留めとフォルダは Chrome のブックマークに保存するので、Chrome の同期でほかのパソコンにも届きます。
  - ドラッグで並べ替え・ピン留め・ピン留めを外す。右クリックのメニュー、ダブルクリックで名前の変更、Cmd+Z で取り消し。
  - ピン留めは、タブが開いていれば −（タブだけ閉じる）、閉じていれば ×（ピン留めから外す）。Arc と同じ使い分けです。
  - 画面の左端にカーソルを当てると、ページの上にサイドバーが出ます（Arc のサイドバーを隠しているときと同じ）。Cmd+S で Chrome のサイドパネルとして固定表示もできます。
- スペース
  - サイドバーの下端の点か、サイドバーの上での 2 本指の横スワイプで切り替えます。スペースごとに色と絵文字のアイコン、ピン留め、Favorites を持ちます。
- 自動アーカイブ
  - しばらく触っていない今日のタブを閉じて、アーカイブに残します（既定 24 時間）。アーカイブから検索して開き直せます。
- コマンドバー（Cmd+T、Cmd+L）
  - 開いているタブ、ブックマーク、履歴をまとめて探します。新しいタブのページも同じコマンドバーになります。
- URL のコピー（Cmd+Shift+C）
- Peek
  - Option+クリックで、リンク先を浮いた小さなウィンドウで開きます。ピン留めのタブから別のサイトへのリンクを押したときも Peek で開きます。
- Little Arc
  - ほかのアプリから開いたリンクを小窓で開きます。Cmd+O でメインのウィンドウへ移します。
- Split View
  - Chrome の Split View で並べた 2 つのタブを、ペアとしてピン留めできます。サイドバーの右クリックから「今のタブと分割表示」で分割を作れます。Chrome を再起動すると解ける分割も、起動後に組み直します。
- Live Folders（GitHub）
  - レビュー依頼と自分の PR をスペースの中のフォルダに書き出して定期的に更新します。
- Arc からの取り込み
  - Arc の `StorableSidebar.json` から、スペース・アイコン・Favorites・ピン留め・フォルダを取り込みます（Split View のペアは、2 つのピン留めに分けて取り込みます）。

## 動作環境

- Google Chrome 155 以降（Split View の API を使うため）
- macOS で作って確かめています。Windows と Linux では、ショートカットの表記などが合わないところがあるかもしれません。

## 入れ方

Chrome ウェブストアには出していません。ソースをそのまま読み込みます（ビルドは要りません）。

1. このリポジトリをクローンするか、ZIP で落として展開します。
2. Chrome で `chrome://extensions` を開き、右上の「デベロッパー モード」をオンにします。
3. 「パッケージ化されていない拡張機能を読み込む」を押し、`extension` フォルダを選びます。
4. サイドパネルを左に出すため、Chrome の 設定 > デザイン >「サイドパネル」で「左側に表示」を選びます。
5. 下の表のとおり、`chrome://extensions/shortcuts` でショートカットを設定します。

読み込んだフォルダを動かすと、拡張の ID が変わって設定が引き継がれません。動かす前に、設定ページの「書き出す」で保存しておき、読み込み直したあとに「読み込む」で戻してください。

### ショートカット

Arc と同じキーは Chrome 自身のショートカットと重なるので、拡張の既定キーにはできません。`chrome://extensions/shortcuts` で手で設定すると、Chrome の動作より拡張が優先されます。

| 項目 | Arc と同じキー | 既定キー |
| --- | --- | --- |
| サイドバーを開閉する | Cmd+S | Option+S |
| コマンドバーを開く（新しいタブで開く） | Cmd+T | Option+T |
| 今のタブの URL を変えるコマンドバーを開く | Cmd+L | なし |
| 今のページの URL をコピーする | Cmd+Shift+C | なし |
| 小窓のタブをメインのウィンドウへ移す | Cmd+O | Option+O |
| 今のスペースのフォルダをすべて閉じる | （好きなキー） | なし |
| 今のスペースのフォルダをすべて開く | （好きなキー） | なし |

## Arc から移る

1. Arc を最新版にして、念のため Arc の設定から Export Data もしておきます。
2. この拡張の設定ページ（`chrome://extensions` の「拡張機能のオプション」）の「Arc から取り込む」で、`~/Library/Application Support/Arc/StorableSidebar.json` を選びます。ファイルを選ぶ画面で Cmd+Shift+G を押し、この場所を貼り付けると開けます。
3. 取り込むスペースを選んで「取り込む」を押します。今あるものは消さず、足すだけです。

Arc はスペースごとにログインを分けられましたが、拡張ではできません。分けたい場合は、Chrome のプロファイルをスペースごとに作り、それぞれにこの拡張を入れて、プロファイルごとに取り込むスペースを選んでください。

## Live Folders を使う

1. GitHub で fine-grained personal access token を作ります。Repository access で見たいリポジトリを選び、Repository permissions の Pull requests を Read-only にします。ほかの権限は要りません。
2. 設定ページの「Live Folders（GitHub）」にトークンを入れ、書き出すスペースと更新の間隔を選んで「保存」を押します。
3. そのスペースに「レビュー依頼」と「自分の PR」のフォルダができます。

見えるのはトークンに許可したリポジトリの PR だけです。

## プライバシーとセキュリティ

- テレメトリはありません。外への通信は、Live Folders が `https://api.github.com` に問い合わせるときだけです。拡張のページと Service Worker の CSP を `connect-src https://api.github.com` にして、ほかへは通信できないようにしています。
- リモートのコード、`eval`、外部の CDN は使いません。npm のパッケージも使っていません（ランタイムの依存ゼロ、ビルドなし）。
- GitHub のトークンは `chrome.storage.local` にだけ保存し、設定ページにも返しません。ただし `chrome.storage.local` は暗号化されないので、同じパソコンのユーザー権限があれば読めます。
- 設定の書き出しファイルにはトークンを含めません。

### 権限とその理由

| 権限 | 使い道 |
| --- | --- |
| `<all_urls>`（host_permissions と content script） | 左端ホバーのサイドバー、ページに重ねて出すコマンドバー、Peek のクリックの判定。どれも任意のサイトの上で動かす必要があります。拡張を更新したときに、開いているタブへ入れ直すためにも使います |
| `sidePanel` | Cmd+S で固定表示するサイドバー |
| `tabs` | タブの一覧、切り替え、移動、分割 |
| `bookmarks` | ピン留め・フォルダ・Favorites・Live Folders の保存先 |
| `history` `search` | コマンドバーで履歴を探す、検索エンジンで検索する |
| `storage` | 設定、スペースの色とアイコン、アーカイブなど |
| `favicon` | サイトのアイコンの表示 |
| `sessions` | 閉じたタブを Cmd+Z で戻す |
| `scripting` | 拡張を入れた・更新したときに、開いているタブへ content script を入れる |
| `alarms` | 自動アーカイブと Live Folders の定期実行 |
| `offscreen` `clipboardWrite` | URL のコピー |
| `webNavigation` | Little Arc で、ページの中のリンクから開いたタブを見分ける |

重ねて出すサイドバー（`sidepanel.html`）とコマンドバー（`palette.html`）は、ページの中に iframe で出すため `web_accessible_resources` に入れています。ほかのサイトがこれらを iframe で読み込んでも中身が出ないよう、content script が Service Worker から受け取ったトークンを持っているときだけ表示します。

ページを読める権限（`<all_urls>`）と外への通信（`api.github.com`）が 1 つの拡張に同居しています。Live Folders を使わない場合も、通信先は GitHub の API だけに絞られています。気になる場合は `live-folders-sw.js` の読み込みを `sw.js` から外し、manifest の CSP を `connect-src 'none'` に戻してください。

## できないこと

Chrome の拡張で作っているため、Arc と同じにはできないところがあります。

### まったくできないもの

- スペースごとのログイン分離。拡張にはそのための API がありません。分けたい場合は、上の「Arc から移る」のとおり Chrome のプロファイルをスペースごとに作ってください。その場合、スペースの切り替えはプロファイル（ウィンドウ）の切り替えになり、スワイプでは切り替えられません。
- Chrome の上のタブバーを隠すこと。Chrome の「タブを縦に表示」と合わせて使うことはできます。
- 自動のピクチャ・イン・ピクチャ。拡張から発動できるのは、ユーザーが操作したときだけです。代わりに `chrome://flags/#browser-initiated-automatic-picture-in-picture` を有効にしてください。
- 3 つ以上の分割表示。Chrome の Split View は 2 分割までです。
- `chrome://` のページ、Chrome ウェブストア、PDF の上での表示。左端ホバーのサイドバー、ページに重ねるコマンドバー、Peek が出ません。
- Boosts、Easel、Notes など、ブラウザ本体の機能に近いものは作っていません。

### 近いことはできるが Arc どおりではないもの

- サイドバーの幅: Cmd+S で開く Chrome のサイドパネルは最小幅が約 320px で、拡張からは細くできません。細く使いたいときは左端ホバーの表示を使ってください（幅はドラッグで 160〜480px）。
- Peek: ページの中に重ねる表示ではなく、浮いた小さなウィンドウです。埋め込まれるのを嫌うサイト（X など）は、中身が出ないことがあります。
- Little Arc: 「直前に Chrome が前面になかった」などの手がかりで外部のリンクを推測するので、見分けられないことがあります（Chrome が前面のときに来たリンクなど）。小窓がほかのアプリのウィンドウの後ろに隠れることもあります。設定ページから開く「Little Arc のログと設定」で、判定のログを見たり、機能を止めたりできます。
- Split View: Chrome を再起動すると分割が解けます。ピン留めしたペアは、起動後に拡張が組み直します。
- ショートカット: Cmd+T など Chrome と重なるキーは、`chrome://extensions/shortcuts` で手で設定する必要があります。
- スペースの切り替え: 2 本指の横スワイプは Chrome の「戻る」とぶつかるので、サイドバーの上でだけ効きます。

## 開発

- ビルドはありません。`extension` を読み込み直せば反映されます。
- セルフテスト: `chrome-extension://<拡張の ID>/dev/selftest.html?auto`（サイドバー、スペース、アーカイブ、Split View、Live Folders）と `dev/cmdbar-selftest.html?auto`（コマンドバー、Peek、URL のコピー）。テスト用のブックマークとタブを一時的に作り、最後に消します。普段使いのプロファイルで流すときは、ブックマークが一時的に増える点に気をつけてください。
- `dev/state.html` で、内部の状態と診断の情報を見られます。
- 手で確かめる項目は [docs/manual-tests.md](docs/manual-tests.md) にあります。

### ファイルの構成

| ファイル | 役割 |
| --- | --- |
| `sw.js` | Service Worker。ブックマークの構成、ピン留めとタブの対応、スペース、アーカイブ、Split View |
| `cmdbar-sw.js` | コマンドバー、URL のコピー、Peek |
| `little-arc-sw.js` | Little Arc |
| `live-folders-sw.js` | Live Folders（GitHub） |
| `sidepanel.*` | サイドバーの画面（サイドパネルと左端ホバーの両方） |
| `edge.js` `ntp-edge.js` | 左端ホバー（ページと新しいタブのページ） |
| `cmdbar.js` `palette.*` `search.js` `newtab.html` | コマンドバー |
| `peek.js` | Peek のクリックの判定 |
| `options.*` `arc-import.js` | 設定ページ、Arc からの取り込み |

## ライセンス

[MIT](LICENSE)
