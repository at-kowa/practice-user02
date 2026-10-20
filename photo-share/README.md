# 写真共有（練習版） v1

スマホ（iPhone・Safari）で撮った／選んだ写真を送り、ログインした全員が同じ一覧で見て、PC（Windows・Edge）から1枚ずつ、またはzipでまとめて保存する練習用アプリです。

> **練習版の注意**
> - 使うのは架空のテスト画像だけです。業務の写真・社内の実データは送らないでください。
> - このリポジトリは公開です。接続先URL・キー・会社のメールドメイン・社名・個人名は、コード・コミット・READMEのどこにも書きません。
> - 各部署で維持・保守する前提です。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `index.html` | 画面の骨組み。`config.js`（あれば）→ `app.js` の順に読む。インラインscriptなし |
| `app.js` | API層（本番 `RealApi`／モック `MockApi`）、画面、縮小、zip、片付け |
| `style.css` | スマホ・PC両対応のレイアウト |
| `build.mjs` | 環境変数を確かめて `dist/` を作る（Node標準モジュールのみ） |
| `vercel.json` | ビルドコマンド・出力先・セキュリティ用ヘッダー |
| `.gitignore` | `config.js`・`dist/`・`.env*` などを入れない |
| `sql/setup.sql` | Supabase側の設定（スキーマ・表・関数・RLS・ポリシー・GRANT・バケット） |

npm の依存・外部CDNはありません。Supabaseへは `fetch`（送信の進捗だけ `XMLHttpRequest`）で直接つなぎます。

## ローカルでのモック起動（通信なし）

`config.js` が無い状態で `index.html` を Edge で開くと、モックモードで動きます（ヘッダーに「モックモード」と出ます）。通信は一切しません。データはブラウザの localStorage（`photoShareMock.v1`）に入ります。

- ログインには `@mock.example` で終わるメール（例 `user-a@mock.example`）を入れ、「（モック）リンクを開いたことにする」を押します。
- URLに付けられる指定

| 指定 | 内容 |
|---|---|
| `?mock=1` | config.js があってもモックにする |
| `&reset=1` | 擬似データ（架空画像8件）を作り直す。自動片付けの実行日も消す |
| `&now=2026-10-20T09:00:00+09:00` | 現在時刻を固定する（読み込み後の経過分だけ進む） |
| `&domain=example.test` | モックの許可ドメインを変える |
| `&fail=upload` / `list` / `purge` | 送信の2枚目／一覧取得／片付けを失敗させる |
| `&autopurge=0` | 「見る」を開いたときの自動片付けを止める（手動片付けの確認用） |

例：`index.html?mock=1&reset=1&now=2026-10-20T09:00:00+09:00`

## 利用者が管理画面で設定する項目

操作手順は書いていません。項目名と値の例だけです。

### Supabase

| 区分 | 項目 | 値の例 |
|---|---|---|
| Authentication／URL設定 | Site URL | 変更しない（複数のアプリで共有しているプロジェクトでは、他のアプリのログインに影響するため） |
| Authentication／URL設定 | Redirect URLs | `https://<Vercelのプロジェクト名>.vercel.app/**` を追加（既存の行は消さない） |
| Authentication／Providers | Email | 有効 |
| Authentication／Providers（Email） | 新規利用者の登録を許可 | 有効（初回ログインで利用者が作られるため） |
| Authentication／Email | 確認メール・マジックリンクの送信元 | 既定のまま、または会社で認められた送信設定 |
| Data API（API設定） | 公開するスキーマ（Exposed schemas） | 既存の値に `photo_share` を追加 |
| SQL Editor | `app_settings` への1行 | 下の「SQLの実行」の手順2 |

### Vercel

| 項目 | 値の例 | 対象環境 |
|---|---|---|
| 環境変数 `SUPABASE_URL` | `https://xxxx.supabase.co` | Production（プレビューも使うならPreview） |
| 環境変数 `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…`（公開用キー。秘密用キー `sb_secret_…` は入れない） | 同上 |
| 環境変数 `ALLOWED_EMAIL_DOMAIN` | 会社のメールドメイン（@なし） | 同上 |
| Build Command／Output Directory | `vercel.json` で指定（`node build.mjs`／`dist`）。管理画面で上書きしない | — |

練習版は会社のメールアドレスで登録した無償プラン（Hobby）で試作・学習目的に限って使います。業務での本番運用は会社が管理する有償チームで行います。

## SQLの実行と再実行

1. Supabase の SQL Editor で `sql/setup.sql` の全文を実行します。何度実行しても同じ結果になります（設定を直したいときもそのまま再実行してよい）。
2. 続けて、次の1文の `<会社のメールドメイン>` を自分で書き換えて実行します（@は付けない・小文字）。この値はリポジトリに入れません。

   ```sql
   insert into photo_share.app_settings (key, value)
   values ('allowed_email_domain', '<会社のメールドメイン>')
   on conflict (key) do update set value = excluded.value;
   ```

3. この1行が無い・空のときは、誰も読み書きできません（閉じる側に倒す設計）。

## 設定の場所（変えるときはここ）

| 変えたいこと | 場所 |
|---|---|
| 接続先・公開用キー・許可ドメイン（画面側） | Vercel の環境変数（`build.mjs` が `dist/config.js` を作る） |
| 許可ドメイン（データ側の最終判定） | `photo_share.app_settings` の `allowed_email_domain` |
| スキーマ名・バケット名 | `app.js` 冒頭の `DB_SCHEMA`・`BUCKET` と `sql/setup.sql` |
| 保存期間（30日） | `app.js` 冒頭の `KEEP_DAYS` と `sql/setup.sql` の `interval '30 days'`（4か所） |
| 送信枚数・zip枚数・縮小の値 | `app.js` 冒頭の `MAX_SEND`・`MAX_ZIP`・`FULL_EDGE` など |
| 練習版の注意帯 | `app.js` 冒頭の `PRACTICE_NOTICE` |
| セッションの保存先 | `app.js` の `saveSession`・`loadSession`・`clearSession` |

## 期限切れ写真の片付けの仕組み

- 一覧には30日以内の写真だけが出ます（RLSの条件 `created_at > now() - interval '30 days'`）。
- ファイルの実体は、ログイン中の利用者がStorage APIで消します。秘密用キー・サーバー側の処理は使いません。
  - 自動：誰かが「見る」タブを開いたとき、1日1回だけ（実行日は localStorage の `photoShare.lastPurge`）。
  - 手動：「見る」タブ下部の「30日を過ぎた写真の片付け」ボタン（確認あり）。
- 流れ：`photo_share.list_expired`（期限切れの行を最大100件）→ Storage の削除API で原寸・サムネイルを消す → `photo_share.delete_expired` で行を消す。削除APIが失敗したら行は消さず、次回やり直します。1回で最大5周。
- 開く人がいない期間は溜まるだけで、一覧には出ません。

## 実データ版への移行チェックリスト

- [ ] 秘密保持契約・社内規定の確認（所属長→情報システム部）
- [ ] Vercel を会社管理の有償チームへ移し、IP制限を設定（コード変更なし）
- [ ] Supabase を実データ用のプロジェクト（またはスキーマ）へ。接続先は環境変数、スキーマ・バケット名は `app.js` 冒頭の定数と `sql/setup.sql`
- [ ] 許可ドメインを `app_settings` と環境変数で設定
- [ ] 保存期間を変えるなら `KEEP_DAYS` と SQL の `interval '30 days'`
- [ ] セッション保存先の見直し（localStorage → sessionStorage 等）は `saveSession` などの3関数
- [ ] 練習版の注意帯（`PRACTICE_NOTICE`）を外す
- [ ] 送信者本人の削除が必要なら、ポリシーとボタンを追加（練習版には入れていない）
