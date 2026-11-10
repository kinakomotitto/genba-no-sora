# 現場の空 — 全国観測・3モデル検証の運用状況

**2026-11-10 / 機能段階：収集・照合の試験稼働を準備中（v0.34）**

## データの扱い
- 観測値：気象庁の全国アメダス公開Web JSONを1日4回以下、毎回全国まとめて最大3リクエストで取得。約1,300地点のデータを個別に巡回しない
- 予報値：全国に分散した代表的な**公開観測所9地点**について、気象庁MSM・ECMWF IFS・DWD ICONの各モデルをOpen-Meteoからモデルごとに**一括取得（最大3リクエスト／実行）**
- 日本全国の全観測所を対象にした予報収集は**まだ行わない**。アプリの現在地／保存現場の通常の天気表示とは別の研究データ
- 観測地点は公開気象観測所に限定。ユーザーGPS、保存現場、現場名、通知購読の情報をGitHubの公開研究データへ混ぜない
- 予報を取得した時間と予報対象時刻を区別。1時間降水量は積算終了時刻で揃え、品質フラグ0以外の実測は正解として使わない
- プログラムは**自動で最良モデルを選んだり、予報補正を有効化したりしない**。有意な改善には季節・気候・時系列ホールドアウトが必要
- 公開気象データは観測所周囲のもの。伐採現場、樹上、山稜の風や安全判断は現地条件が優先

## 自動化
GitHub Actions \`.github/workflows/amedas-national.yml\` を6時間ごとに起動。GitHub側の遅延・実行失敗を考慮し、稼働成否はGitHub Actionsの実行履歴で確認する。

各実行は最大3回のJMA GET、3回のOpen-Meteo予報モデルGET（9地点をまとめて取得）、観測と予報の検証指標計算、その結果の保存を試みる。

- \`data/amedas/latest.json\`：最新の全国観測（取得できた場合）
- \`data/amedas/recent/YYYY-MM-DD.jsonl\`：直近14日の公開観測値（予定）
- \`data/model-validation/forecasts/YYYY-MM-DD.jsonl\`：直近21日の予報スナップショット
- \`data/model-validation/collection-status.json\`：モデル別取得成功/失敗と収集件数
- \`data/model-validation/status.json\`：品質確認済み実測との共通サンプル・暫定誤差指標

**重要：コードやワークフローの登録だけでは、全国の収集成功を証明できない。** 実行ログとデータファイルが生成されたことを確認すること。将来の全国大量取得には予算、API契約、レート制限、Git履歴肥大対策が必要。

## Open-Meteoの非商用制限
Open-Meteo Free APIは非商用用途のみ。非販売の個人開発アプリでも企業業務への利用がすべて自動許諾されるわけではない。現在の定期収集は少数の公開観測所に限定している。商用・会社正式運用や大量収集に切り替える際は、提供元と料金・許諾を確認し、勝手な有料契約はしない。

- https://open-meteo.com/en/terms
- https://open-meteo.com/en/pricing

## 通知（Cloudflare Workers Builds）の安定化
**ユーザーのiPhoneでは実際のサーバーテスト通知と17:45の定時通知を受信済み。既存の本番Workerは動いている証拠がある。**

一方、GitHubのCommit Checkには別の **Workers Builds: genba-no-sora-noon-push / failure** が繰り返し表示されている。GitHubから取得できるCheckの要約にはCloudflareの詳細ビルドログが含まれないため、**原因は未確定**。この状態だけで本番通知の停止と断定しない。

本RepoはGitHub Pages PWAがルート、Cloudflare Workerのコードは\`push-backend/\`配下のモノレポ構造。CloudflareのGit連携設定を確認すること：

1. Cloudflare > Workers & Pages > \`genba-no-sora-noon-push\` > Settings > Build
2. **Root directory**：\`/push-backend\`（このフォルダーの中に\`wrangler.toml\`と\`package.json\`がある）
3. Build command：空欄（必要なら\`npm install --no-audit --no-fund\`）。Deploy command：\`npx wrangler deploy\`。**失敗ログを見てから**この値を調整
4. **Build watch paths**：Includes \`push-backend/*\`、Excludes 空欄。これでホームの文言変更や定期収集データの更新ごとに通知Workerをビルドしない
5. Cloudflare > Deployments / Builds の**直近失敗ログ**で失敗したステップを確認。認証/D1/Secretsの設定は既存の動作している値を保持
6. GitHubの \`.github/workflows/push-backend-check.yml\` はWorkerコードのテスト用。Cloudflare実環境の成功/失敗とは別に判断する

**Cloudflareの設定画面はGitHubコネクターから変更できない。** 本番動作中のD1、秘密鍵、Cronをログも見ずに上書きしない。

## 現在の画面・通知チェック
- ホーム：現在地のGPS、保存現場は「現場」一覧から詳細へ
- 風・雨の3モデル比較：取得件数と欠測を表示
- アメダス：近くの観測値は折りたたみを開くと取得。全国収集された過去の蓄積データを直接読み込む方式ではない
- 通知：選んだ時間のPushが届くことを実機確認済み。安全警報とは別の任意の記録リマインダー
- UIの公開（GitHub Pages）とサーバーの配信（Cloudflare Workers）は独立

## 出典
- 気象庁アメダス：https://www.jma.go.jp/jma/kishou/know/amedas/kaisetsu.html
- 気象庁公開時刻：https://www.jma.go.jp/bosai/amedas/data/latest_time.txt
- Cloudflare Workers Builds設定：https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Cloudflare Build watch paths：https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/
- Open-Meteo利用規約：https://open-meteo.com/en/terms
