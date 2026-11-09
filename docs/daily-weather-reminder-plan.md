# 現場の空 — 毎日の天気記録リマインダー設計

作成: 2026-11-09 / 状態: **通知は未実装**

## 目的
- 毎日指定時刻にiPhoneへ通知し、タップするとアプリ内の「現地の天気を記録」に移動する。
- アプリ内で晴れ・曇り・雨から1つをタップし、その日時と地点を端末内に保存する。
- 記録ボタンと端末内の履歴保存はindex.htmlに実装済み。実機検証は未実施。

## iOS対応条件
- iOS 16.4以降、ホーム画面へ追加したWebアプリはWeb Pushに対応。アプリ内のユーザー操作から通知許可を求める。
- Safari on iOSではNotification.actionsのアクションボタンは非対応。通知本体に3ボタンは表示しない。
- 対応策: 通知を開くとアプリ内の大きな3ボタンが現れるようにする。
- GitHub Pagesのみではアプリを閉じている間の毎日通知送信はできず、通知購読の安全な保存とVAPID認証付き送信サービスが別途必要。

## プライバシーと運用
- Push購読endpoint、暗号鍵、VAPID秘密鍵を公開GitHubに保存しない。
- 通知本文に会社の現場名やGPS座標を含めない。
- 現地天気記録は同期を明示的に許可しない限りローカルだけに保管する。
- 現場報告は主観的な目視情報で、計器による風速実測と混同しない。
- 通知はユーザーがオン/オフや時間変更をできる仕様にする。
- GitHub Actionsの定期実行は遅延・欠落があり得るので配信時刻を保証しない。

## 実装順
1. GitHub Pages公開 → iPhoneホーム画面追加 → 天気記録の動作確認。
2. 毎日の通知時刻設定と許可画面を追加。
3. 安全な通知サーバーと購読情報の保管場所を選定して実装。
4. テスト通知 → 通知タップで記録画面を開く動線を実機確認。
5. 停止・拒否・圏外の挙動を確認してから通知を有効化。

## 参考
- Apple: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- WebKit: https://webkit.org/blog/13878/
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/Notification/actions
- Compatibility: https://caniuse.com/mdn-api_notification_actions