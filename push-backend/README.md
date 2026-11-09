# 現場の空 — 12時通知サーバー（Cloudflare Workers 試作）

**状態：コード準備済み／未デプロイ／定時通知未開始。**

## できること

- iOSホーム画面からインストールしたPWAによるWeb Push購読を、秘密のCloudflare D1に保存
- 毎日 **12:00 JST = 03:00 UTC** のCronで購読端末に1回リマインダー通知を試みる
- 購読した端末が解除できる、同じ日に重複送信しない、期限切れ購読を削除する
- 端末所有者だけが試せるテスト送信（120秒の連続送信制限）
- **現場のGPS、名前、目視の天気、メモを送信・保存するAPIはない**

## 本番へ移る前の必須手順

1. **ユーザー本人がCloudflareアカウントを用意すること。** 現在GitHubだけで稼働中のアプリから自動通知は送れない。
2. [Cloudflare Workers](https://developers.cloudflare.com/workers/) と [D1](https://developers.cloudflare.com/d1/get-started/) を設定する。
3. ローカルPCにNode.jsを導入して、`push-backend` フォルダーで `npm install`。
4. `npx wrangler d1 create genba-no-sora-push-private` で **非公開D1** を作成する。
5. `wrangler.jsonc.example` を `wrangler.jsonc` にコピーし、作成されたD1のIDを自分のIDに置換。
6. `npx wrangler d1 execute genba-no-sora-push-private --remote --file=./schema.sql` でテーブルを作成。
7. `npx web-push generate-vapid-keys` でVAPID鍵を作成。
8. 次の値を、**必ずWorker Secret**として登録：`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（本人が管理する有効な `mailto:` アドレス）、`RATE_LIMIT_SALT`（十分ランダムな秘密）。
9. `npx wrangler deploy` でデプロイ。公開された **workers.dev URL** を、後でPWAの公開設定に追加する。Worker URL自体は公開可能だが、VAPID秘密鍵や利用者の購読情報は公開禁止。
10. iPhoneで購読・1件テスト通知・定時Cron・解除・圏外時の挙動を検証してから、毎日12時の通知を有効化する。

**重要：** 今回はCloudflareアカウント情報・D1 ID・鍵・本番URLを持たないため、上記の工程を勝手に実行していない。GitHubへのサーバーコード登録と、自動配信の本番稼働は別物。

## API

| メソッド | パス | データ |
|---|---|---|
| GET | /health | サーバー準備状態のみ |
| GET | /api/config | 配信可否、公開VAPID鍵、12:00/JST |
| POST | /api/subscribe | **Push購読データだけ** + 端末に保存した所有トークン |
| POST | /api/unsubscribe | 購読解除 |
| POST | /api/test | 登録済み端末への単発テスト通知 |

すべてのPOSTは `https://kinakomotitto.github.io` Originを要求する。Apple Web Pushのエンドポイントに限定し、ユーザートークンのSHA-256ハッシュだけをD1に保存。定時配信は`last_sent_day`で重複送信を抑える。Cloudflare D1はプライベートだが、購読データをクラウドへ保存する行為自体はユーザーが明示的に同意した場合に限る。

## 制限と注意

- 配信はベストエフォート。ちょうど12:00の到着保証はなく、Cloudflare側のプラン制限や障害で通知に失敗することがある。
- 本機能は「天気を記録してね」という**任意のリマインダー**専用。警報・避難・現場の作業停止判断には**使用しない**。
- サーバーのD1の個人情報（Pushのエンドポイント・鍵）は一般公開しない。秘密鍵・トークンをGitHubのIssueやChatGPT画面に貼らない。
- 正式公開前にプッシュ購読の異常連続登録・セキュリティレビュー・費用上限・Cloudflareの規約を追加確認。
- `web-push`ライブラリはCloudflare公式のWeb Pushサンプルにも登場しているが、この試作はCloudflareへの実環境デプロイによる検証前。

## 公式資料

- [AppleのWeb Push仕様](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit iPhoneホーム画面アプリ通知](https://webkit.org/blog/13878/)
- [CloudflareのWeb Pushサンプル](https://developers.cloudflare.com/agents/agent-class/communication-channels/webhooks/push-notifications/)
- [Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)
