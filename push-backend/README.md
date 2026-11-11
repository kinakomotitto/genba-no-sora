# 現場の空 — 定時リマインダー＋任意の気象変化通知（Cloudflare Workers）

## 2026-11-11 v0.41 追加：気象変化通知（試験版）

定時リマインダーに加え、本人がホーム画面アプリの**「今の地点で4時間の天気通知をオンにする」**を押したときだけ、丸めたGPSを非公開Cloudflare D1に登録し、既存の15分CronでOpen-Meteoの**今後2時間の参考予報**を監視。雨・最大瞬間風速15m/s以上・雷雨のモデル予報を検出したら、閉じたiPhoneへWeb Pushを試みる。

**背景GPSの追跡はできない。** アプリを閉じて移動しても古い監視地点のままで、4時間で監視は期限切れ。終了時または期限後の定期処理で記録されたGPSを削除する。位置座標は小数3桁へ丸めて保存・Open-Meteoへ送信し、保存現場名、メモ、手動天気記録を送信しない。既存の定時通知だけを使う場合はGPSを送らない。

**この機能は実測ナウキャストや気象庁警報ではない。** 日本では15分値の多くが1時間予報の補間。実際の雨の到達時刻・落雷の接近・確実な通知到達・現場の作業安全を保証しない。詳しい設計、認可、データ保存、試験、限界は [v0.41の仕様](../docs/opt-in-weather-watch-v041.md) を参照。

## 従来の定時通知

**状態（2026-11-10）：ユーザーのiPhoneで単発Pushと指定時刻17:45のPush受信が確認済み。本番Workerは一度は配信できた。以前のPull Request等でWorkers Buildsの失敗があったが、2026-11-10の最新main更新・全国データ保存時の本番Workers Buildsはどちらも成功済み。再発時だけ詳細ログを確認する。**

運用・原因調査手順：[`../docs/operations-v034.md`](../docs/operations-v034.md)。

## iPhoneからのCloudflare初回デプロイ（安全な仮公開）

- GitHubの `push-backend/wrangler.toml` は **`genba-no-sora-noon-push`** というWorker名、`src/worker.js` という実行ファイルを指定済み。
- Cloudflare Workers BuildsのRoot directory（Advanced settings > Path）は `/push-backend` に設定する。
- Project nameも **`genba-no-sora-noon-push`** に一致させる。Cloudflare公式はWrangler設定とプロジェクト名の一致を要求している。
- Build commandは空、Deploy commandは `npx wrangler deploy` のまま。API tokenは初期設定の新規発行でよい。Advanced settingsのBuild variablesは空欄にする。
- この段落は**初回セットアップ当時の参考手順**。現在の`wrangler.toml`にはD1とCronが記載済みで、iPhoneへの実送信も成功している。既存の秘密鍵・D1・Cronを再作成したり上書きしたりしない。
- 初回公開を検証後、Cloudflare管理画面でD1を作成・マイグレーションし、D1バインディングを `DB` で追加。さらに4種のWorker runtime secretを追加する。
- `wrangler.toml` にD1のdatabase_idと Cron `*/15 * * * *` を追記するのは、購読テストが成功した後。**Build variableはWorker runtime secretの代わりにはならない。**
- 定時リマインダーだけなら書類・端末名・現場名・緯度経度を送らない。v0.41の気象変化通知を本人がオンにした場合に限り、丸めた緯度経度を4時間期限付きで非公開D1に保存する。秘密鍵・Push購読情報を公開GitHubに置かない。



## できること

## 通知時刻をユーザーが選ぶ新仕様（v0.13）

- アプリの「現場」→「🔔 天気記録リマインダー」→「♡ 回数・時間を選ぶ」で朝・昼・夜を個別にオン／オフ。
- **1～3回／日**。朝は05:00～10:45、昼は11:00～15:45、夜は16:00～23:00の中から**15分刻み**で選択する。
- 画面の初期候補は**朝07:00、昼12:00（オン）／夜19:00（オフ）**。時刻設定だけではプッシュは開始しない。明示的な通知オンが必要。
- 設定は端末内に保存し、配信サービスの準備ができた後は、本人が明示してプッシュ登録した端末についてのみ、選択した時刻を非公開D1に送る。
- 対応API: \`/api/subscribe\` は \`times\` を登録し、\`/api/preferences\` は本人の購読所有トークンで \`times\` を変更する。
- 非公開D1の\`schedule_json\`に時刻配列を保存し、\`push_delivery_log\` の日時・送信時刻の組み合わせで重複を防ぐ。
- 将来のCronは\`*/15 * * * *\`（UTC）。Workerが日本時間に換算してユーザーの時刻と照合する。
- **現在の`wrangler.toml`には`*/15 * * * *`のCron設定済み**。iPhoneの17:45の自動通知受信も確認済み。ただし現在のCloudflare本番設定がソースと同一か、定期実行が継続しているかはCloudflare側のTriggers/ログで確認が必要。遅延するため、到着時刻は保証しない。
- **以前の固定12:00専用スキーマは本番稼働していない**前提。既に古いDBを作ってある場合は新スキーマを上書きせず、移行手順を設計してから対応する。



- iOSホーム画面からインストールしたPWAによるWeb Push購読を、秘密のCloudflare D1に保存
- 本人の設定した**1日1～3回**の時刻にリマインダー通知を試みる（配信開始時は15分間隔Cron）
- 購読した端末が解除できる、同じ日に重複送信しない、期限切れ購読を削除する
- 端末所有者だけが試せるテスト送信（120秒の連続送信制限）
- 定時通知の購読APIは現場GPS・名前・目視の天気・メモを必要としない。v0.41の気象変化通知専用APIだけは、本人の明示操作時に丸めた現在GPSを一時保存する（詳細は仕様を参照）。

## 本番へ移る前の必須手順

1. **ユーザー本人がCloudflareアカウントを用意すること。** 現在GitHubだけで稼働中のアプリから自動通知は送れない。
2. [Cloudflare Workers](https://developers.cloudflare.com/workers/) と [D1](https://developers.cloudflare.com/d1/get-started/) を設定する。
3. ローカルPCにNode.jsを導入して、`push-backend` フォルダーで `npm install`。
4. `npx wrangler d1 create genba-no-sora-push-private` で **非公開D1** を作成する。
5. GitHubの `wrangler.toml` に、D1バインディング `DB` と作成したD1のIDを追記する。**先に `wrangler.jsonc` を重複作成しない。**
6. `npx wrangler d1 execute genba-no-sora-push-private --remote --file=./schema.sql` でテーブルを作成。
7. `npx web-push generate-vapid-keys` でVAPID鍵を作成。
8. 次の値を、**必ずWorker Secret**として登録：`VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`VAPID_SUBJECT`（本人が管理する有効な `mailto:` アドレス）、`RATE_LIMIT_SALT`（十分ランダムな秘密）。
9. Cloudflare Workers BuildsのGitHub連携で再デプロイして動作確認。公開された **workers.dev URL** を、後でPWAの公開設定に追加する。Worker URL自体は公開可能だが、VAPID秘密鍵や利用者の購読情報は公開禁止。
10. iPhoneで購読・1件テスト通知・選択した時刻のCron・解除・圏外時の挙動を検証してから、毎日12時の通知を有効化する。

**重要：** 今回はCloudflareアカウント情報・D1 ID・鍵・本番URLを持たないため、上記の工程を勝手に実行していない。GitHubへのサーバーコード登録と、自動配信の本番稼働は別物。

## API

| メソッド | パス | データ |
|---|---|---|
| GET | /health | サーバー準備状態のみ |
| GET | /api/config | 配信可否、公開VAPID鍵、12:00/JST |
| POST | /api/subscribe | **Push購読データだけ** + 端末に保存した所有トークン |
| POST | /api/unsubscribe | 購読解除 |
| POST | /api/test | 登録済み端末への単発テスト通知 |

すべてのPOSTは `https://kinakomotitto.github.io` Originを要求する。Apple Web Pushのエンドポイントに限定し、ユーザートークンのSHA-256ハッシュだけをD1に保存。定時配信は`push_delivery_log`の日時・配信枠ごとに重複送信を抑える。Cloudflare D1はプライベートだが、購読データをクラウドへ保存する行為自体はユーザーが明示的に同意した場合に限る。

## 制限と注意

- 配信はベストエフォート。指定した時刻ちょうどの到着保証はなく、Cloudflare側のプラン制限や障害で通知に失敗することがある。
- 定時リマインダーは「天気を記録してね」という通知。v0.41気象変化通知はモデル予報の参考通知であり、いずれも公式の警報・避難・現場の作業停止判断には**使用しない**。
- サーバーのD1の個人情報（Pushのエンドポイント・鍵）は一般公開しない。秘密鍵・トークンをGitHubのIssueやChatGPT画面に貼らない。
- 正式公開前にプッシュ購読の異常連続登録・セキュリティレビュー・費用上限・Cloudflareの規約を追加確認。
- `web-push`ライブラリはCloudflare公式のWeb Pushサンプルにも登場しているが、この試作はCloudflareへの実環境デプロイによる検証前。

## 公式資料

- [AppleのWeb Push仕様](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit iPhoneホーム画面アプリ通知](https://webkit.org/blog/13878/)
- [CloudflareのWeb Pushサンプル](https://developers.cloudflare.com/agents/agent-class/communication-channels/webhooks/push-notifications/)
- [Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/get-started/)
