# キャラクターシート帳

シートはNotionのデータベースで管理しています: https://app.notion.com/p/b47dc79665f54fdeb8df5e2afdb134a5

- `extension/` — Chrome 拡張機能「シート帳へ送る」。各サイトのシートをNotionへ直接追加します。インストール方法は `extension/README.md` を参照してください。
- `tools/migrate-to-notion.js` — 旧シート帳の書き出しデータをNotionへコピーしたスクリプト（移行済み）。
- `web/index.html` — Notionのシート帳を見るための閲覧ページ。Claude の Artifact として公開しています: https://claude.ai/artifact/HvFLARgaM8KXybS1poceCN
  - 見る人のNotionコネクタでデータベースを読みます（読み取りのみ）。HPやメモの編集はNotionで行います。

## GitHub Pages で公開する

`.github/workflows/pages.yml` が3時間ごと（と手動実行・mainへのpush時）にNotionを読み、`tools/build-site.js` で `site/index.html` と `site/data.json` を作ってGitHub Pagesに置きます。公開ページはURLを知っていれば誰でも見られます（検索エンジンには noindex を指定）。

1. リポジトリの Settings → Secrets and variables → Actions に `NOTION_TOKEN`（拡張機能と同じNotionの連携トークン）を登録する
2. Settings → Pages の Source を「GitHub Actions」にする
3. Actions タブの「シート帳をGitHub Pagesに公開」を Run workflow で実行する

公開ページの「Notionから更新」ボタンでも、このワークフローを実行できます。最初に押したときに GitHub のトークンを聞かれるので、公開リポジトリだけを対象に「Actions: Read and write」の権限を付けた fine-grained トークンを作って貼り付けてください。トークンはそのブラウザの localStorage にだけ保存されます（Shift を押しながらボタンを押すと設定画面が開き、消せます）。

公開リポジトリ: https://github.com/shizaki-kanoto-lab/trpg_charsheet_book （このリポジトリ g16qa/charsheet-book は非公開。mainを両方にpushする）

公開URL: https://shizaki-kanoto-lab.github.io/trpg_charsheet_book/

## Notion のデータベース

- **タグ**（マルチセレクト）: 6版・7版・〇〇コンバート・CoC転生・要確認だけ。選択肢が増えすぎないようにしている
- **シナリオ**（テキスト）: シナリオ名とHOなど。1行に1つ。公開ページのシナリオ一覧はここから作る
- **立ち絵**（URL）: シートの画像。いあきゃら・キャラッシュ・vinsanet・ゆとシートは拡張機能が入れる

## 一度だけ使う整理用スクリプト

どれも起動するとNotionのトークンを聞きます（入力は表示されません）。`--dry-run` を付けると書き込まずに内容だけ表示します。

- `node tools/move-scenarios.js` … タグに入っているシナリオ名・HOを「シナリオ」へ移す
- `node tools/fill-images.js` … 立ち絵が空のシートに、元のサイトから画像URLを入れる
- `node tools/fix-tags.js tools/tag-fixes.json` … 分かれてしまったタグをつなぐ・表記ゆれを直す
