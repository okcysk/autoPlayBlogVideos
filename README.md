# autoPlayBlogVideos

ブログの記事一覧ページを指定すると、各記事に埋め込まれた動画を抽出して順番に自動再生するローカルツールです。

## 必要なもの

- Node.js 18 以上（依存パッケージなし）

## 使い方（ローカル）

```bash
npm start
```

1. http://localhost:3000 を開く
2. プリセットを選ぶか、記事一覧ページの URL を入力する
3. 「読み込んで再生」を押す

| 項目 | 説明 |
|---|---|
| ページ数 | 「次のページ」リンクをたどって読み込むページ数（最大 50） |
| 記事URLの正規表現 | 記事以外のリンクを拾ってしまう場合に記事 URL を絞り込む（例: `/20\d\d/`） |
| シャッフル | キューからランダムに再生する |

## Cloudflare Workers で動かす

Worker（`src/worker.js`）が `/api/*` を処理し、それ以外は `index.html` を返します（`index.html` はデプロイ時に Worker に同梱されます）。

```bash
npm install
npx wrangler login   # 初回のみ。ブラウザで Cloudflare にログイン
npm run deploy       # https://auto-play-blog-videos.<アカウント>.workers.dev に公開
```

デプロイ前にローカルで確認するには `npm run dev:cf`（http://localhost:8787）を使います。

### 取得できるサイトの制限

公開すると誰でもこの Worker 経由でページを取得できてしまうため、`wrangler.toml` の `ALLOWED_HOSTS` に書いたホスト（とそのサブドメイン）だけを取得するようにしています。使いたいサイトを追加してから `npm run deploy` してください。空文字にすると制限なしになります。

```toml
[vars]
ALLOWED_HOSTS = "bazurecipe.com,automaton-media.com"
```

ローカルの `npm start` では制限はありません（環境変数 `ALLOWED_HOSTS` を設定すると同じ制限がかかります）。

### 無料プランの制限

- 1 リクエストあたりの外部取得は 50 回まで → 「ページ数」は 50 が上限です。
- 1 リクエストあたりの CPU 時間は 10ms まで → 非常に大きなページの解析は失敗する場合があります。

## 対応している動画

- YouTube（`embed` / `watch` / `youtu.be` / `shorts`）
- Vimeo
- `<video>` / `<source>` の動画ファイル（拡張子のない URL も可）
- `og:video` メタタグの動画ファイル

同じ動画は 1 回だけ再生します（サイドバーなどに毎回出る動画の重複を防ぐため）。埋め込み再生が禁止された YouTube 動画や再生できない動画ファイルは自動でスキップします。

## キーボード操作

| キー | 動作 |
|---|---|
| `B` / `N` | 前 / 次の動画 |
| `Z` / `X` | 5 秒戻る / 進む |
| `C` / `V` | 30 秒戻る / 進む |
| `↑` / `↓` | 音量 ±10% |
| `M` | ミュート切り替え |
| `F` | 等速 |
| `G` | 2.5 倍 ⇄ 等速 |
| `H` | 10 倍 ⇄ 等速 |
| `Space` | 再生 / 停止 |

音量・ミュート・速度は次の動画にも引き継がれます。YouTube / Vimeo は 2 倍速までしか対応していないため、それを超える速度はシークで補っています（10 倍指定で実測約 6.7 倍）。

## 構成

- `src/core.js` — 一覧ページから記事リンクを集め、各記事から動画を抽出する処理（共通）
  - `GET /api/list?url=...&pages=N&filter=...`
  - `GET /api/videos?url=...`
- `server.js` — ローカル用の Node サーバー（API と `index.html` の配信。ほかのファイルは配信しない）
- `src/worker.js` / `wrangler.toml` — Cloudflare Workers 用
- `index.html` — プレイヤー画面

## 既知の制限

- 直リンク対策（Referer チェック）をしている配信元の動画ファイルは再生できず、スキップされます。
- 対象サイトの利用規約でスクレイピングや埋め込みの利用が認められているか確認したうえで使ってください。
