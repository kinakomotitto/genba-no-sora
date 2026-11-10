# v0.28 — 予報の当たり外れ検証エンジン（試作）

状態：オフライン計算のみ実装。3モデルの自動収集・観測値の自動取得・自動補正は未実装。

## なぜこの3モデル？
- 気象庁MSM（jma_msm）：日本付近の約5km地域モデル。短時間の雨・風の比較基準
- ECMWF IFS（ecmwf_ifs）：約9kmの全球モデル。MSMとは異なる広域の大気の予測
- DWD ICON Seamless（icon_seamless）：日本域では約11kmのICON全球予報。第三の予測モデルで食い違いを確認

この3つは**モデルとして別**だが、取得元はすべてOpen-Meteoという**共通API事業者**。3つの独立した天気サイトから取得しているわけではない。モデルの格子サイズは山林現場の実測精度を保証しない。

## 今回追加したもの
- tools/model_verification.py：公開観測所で過去に保存された予報と、品質確認済み観測データをJSONL形式で入力して照合するオフライン計算器
- tests/test_model_verification.py：合成値による欠測、未来情報の除外、同じ観測所・同じ時刻、降雨見逃し、重複、風向角度などのテスト
- .github/workflows/model-verification-check.yml：外部APIを使わない自動テスト
- 風速MAEと過大・過小の偏り、降水量MAE・雨の見逃し件数、風向誤差を算出
- 3モデルの共通観測所・共通予報時刻でのサンプル数を集計。共通サンプル限定の誤差集計は次段階
- データが30件に満たない項目は誤差を公開しない。30件は最優秀モデルを認定する基準ではない
- 自動モデル選定・補正・重み付けはまだ行わない（optimal_model:null / auto_correction_enabled:false）
- 会社現場名・GPS・使用者データは入力不要。自動ネットワーク接続は行わない

## 入力仕様
予報行の必須キー：station_id, model, fetched_at, valid_at。任意の予報量：wind_ms, wind_direction_deg, precipitation_1h_mm。
観測行の必須キー：station_id, observed_at, quality="ok"または"confirmed"。任意の実測量：wind_ms, wind_direction_deg, precipitation_1h_mm。
実測は事前に品質情報を確認し、不適切なものに機械的にokを付与しない。
日時はタイムゾーン付きISO 8601。降水量は指定時刻までの1時間積算、風は予報と異なる測定方法に注意。

実行例：
python3 tools/model_verification.py --forecasts <PUBLIC_FORECAST_JSONL> --observations <VERIFIED_OBSERVATION_JSONL> --output <LOCAL_JSON_FILE>

## 次の開発（未完成）
1. 公開観測所の3〜5地点を選び、利用規約を確認したうえでモデル別予報を取得時点から定期収集
2. 気象庁等の観測値を品質情報つきで許諾済み取得、または手動CSV取り込み
3. 同じ観測日時・モデル共通サンプルを使って季節や地域・リードタイムごとの精度を検証
4. 未学習の期間で単独モデル以上の改善が実証された場合だけ補正案を採用
5. 強風・大雨の上振れと公式警報・現場安全基準は平均によって隠さない

※Open-Meteo無料APIは非商用用途向け。会社の現場で運用するなら利用条件と適切なライセンスを確認する。気象庁過去データダウンロードは過度な自動アクセスを控えるよう案内されている。

一次資料：
- https://www.jma.go.jp/jma/kishou/know/whitep/1-3-6.html
- https://open-meteo.com/en/docs/jma-api
- https://open-meteo.com/en/docs/ecmwf-api
- https://open-meteo.com/en/docs/dwd-api
- https://open-meteo.com/en/terms
- https://www.data.jma.go.jp/risk/obsdl/
