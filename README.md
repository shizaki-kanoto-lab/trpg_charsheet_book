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

公開URL: https://g16qa.github.io/charsheet-book/
