// 하늘 ♡ 現在地の天気 — Scriptable ロック画面ウィジェット v1.0
// 設置：Scriptableで新規スクリプトに貼り付け、ロック画面の
// Scriptable「長方形」ウィジェットに割り当ててください。
// 位置情報はその都度Scriptableが取得し、Open-Meteoに概略座標
// （小数3桁、約100m単位）を送信して現在地の予報を取得します。
// 場所・現場情報・認証情報を「하늘」のサーバーへ送信しません。
// iOSがウィジェットを更新する時だけ実行されます。常時追跡ではありません。

const APP_URL = "https://kinakomotitto.github.io/genba-no-sora/";
const family = config.widgetFamily || "accessoryRectangular";
const widget = new ListWidget();
widget.url = APP_URL; // タップすると「하늘」のWebページ（Safariで開く場合あり）
widget.setPadding(1, 3, 1, 3);
widget.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);
// iOSはこの時刻での更新を保証しません。

const fm = FileManager.local();
const cacheFile = fm.joinPath(fm.cacheDirectory(), "haneul-lockscreen-weather-v1.json");
function loadCache() {
  try {
    if (fm.fileExists(cacheFile)) return JSON.parse(fm.readString(cacheFile));
  } catch (_) {}
  return null;
}
function saveCache(value) {
  try { fm.writeString(cacheFile, JSON.stringify(value)); } catch (_) {}
}
function weatherName(code, daytime) {
  if (code === 0) return {symbol: daytime ? "☀︎" : "☾", label:"晴れ"};
  if (code === 1 || code === 2) return {symbol:"⛅︎", label:"晴れ時々曇り"};
  if (code === 3) return {symbol:"☁︎", label:"曇り"};
  if (code === 45 || code === 48) return {symbol:"☁︎", label:"霧"};
  if (code >= 51 && code <= 57) return {symbol:"☂︎", label:"霧雨"};
  if (code >= 61 && code <= 67) return {symbol:"☂︎", label:"雨"};
  if (code >= 71 && code <= 77) return {symbol:"❄︎", label:"雪"};
  if (code >= 80 && code <= 82) return {symbol:"☂︎", label:"にわか雨"};
  if (code >= 85 && code <= 86) return {symbol:"❄︎", label:"にわか雪"};
  if (code >= 95) return {symbol:"⚡︎", label:"雷雨"};
  return {symbol:"☁︎", label:"天気"};
}
function rainAtCurrentHour(data) {
  try {
    const prefix = data.current.time.slice(0, 13);
    const i = data.hourly.time.findIndex(t => t.slice(0, 13) === prefix);
    const n = data.hourly.precipitation_probability[i];
    return Number.isFinite(n) ? Math.round(n) : null;
  } catch (_) { return null; }
}
let reading = null;
let fromCache = false;
let cache = loadCache();
try {
  // ロック画面は限られた時間しか実行されないため、省電力の位置精度。
  Location.setAccuracyToHundredMeters();
  const pos = await Location.current();
  if (!Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) {
    throw new Error("Location unavailable");
  }
  const lat = pos.latitude.toFixed(3);
  const lon = pos.longitude.toFixed(3);
  const url = "https://api.open-meteo.com/v1/forecast"
    + "?latitude=" + encodeURIComponent(lat)
    + "&longitude=" + encodeURIComponent(lon)
    + "&current=temperature_2m,weather_code,is_day"
    + "&hourly=precipitation_probability"
    + "&forecast_days=1&timezone=auto";
  const req = new Request(url);
  req.timeoutInterval = 10;
  const data = await req.loadJSON();
  const current = data.current || {};
  if (!Number.isFinite(current.temperature_2m) || !Number.isFinite(current.weather_code)) {
    throw new Error("Incomplete forecast");
  }
  reading = {
    temp: Math.round(current.temperature_2m),
    code: current.weather_code,
    isDay: current.is_day === 1,
    rain: rainAtCurrentHour(data),
    weatherTime: String(current.time || "").slice(11, 16),
    fetchedAt: Date.now()
  };
  saveCache(reading); // 保存するのは天気だけ。緯度・経度は保存しません。
} catch (_) {
  // GPSが使えない場合、直近のデータのみ「前回」と明記して表示。
  if (cache && Number.isFinite(cache.temp) && Number.isFinite(cache.fetchedAt)
      && Date.now() - cache.fetchedAt < 2 * 60 * 60 * 1000) {
    reading = cache;
    fromCache = true;
  }
}

const state = reading ? weatherName(reading.code, reading.isDay) : null;
const temp = reading ? String(reading.temp) + "°" : "--°";
const condition = state ? state.symbol + " " + state.label : "位置情報を確認";
const time = reading && reading.weatherTime ? reading.weatherTime : "--:--";
const update = fromCache ? "前回 " + time : time;
const rain = reading && reading.rain !== null ? ("雨" + reading.rain + "%") : "降水確率 --";
const textColor = new Color("#FFFFFF"); // ロック画面ではiOSが色を調整する場合があります。

if (family === "accessoryInline") {
  const line = widget.addText("♡ 하늘  " + temp + " " + condition);
  line.font = Font.semiboldSystemFont(13);
  line.lineLimit = 1;
} else if (family === "accessoryCircular") {
  const title = widget.addText("♡ 하늘");
  title.font = Font.mediumSystemFont(9);
  title.centerAlignText();
  const main = widget.addText(temp);
  main.font = Font.boldRoundedSystemFont(21);
  main.centerAlignText();
  const symbol = widget.addText(state ? state.symbol : "☁︎");
  symbol.font = Font.mediumSystemFont(11);
  symbol.centerAlignText();
} else if (family === "accessoryRectangular") {
  const title = widget.addText("♡ 하늘 · " + (fromCache ? "前回取得" : "現在地"));
  title.font = Font.semiboldSystemFont(11);
  title.lineLimit = 1;
  const main = widget.addText(condition + "  " + temp);
  main.font = Font.boldRoundedSystemFont(17);
  main.lineLimit = 1;
  main.minimumScaleFactor = 0.75;
  const foot = widget.addText(rain + " · " + update);
  foot.font = Font.mediumSystemFont(10);
  foot.lineLimit = 1;
} else {
  // ホーム画面用も同じスクリプトで使用できます。
  widget.backgroundColor = new Color("#F6E4F1");
  widget.setPadding(13, 12, 13, 12);
  const title = widget.addText("♡ 하늘　現在地の空");
  title.font = Font.semiboldRoundedSystemFont(13);
  title.textColor = new Color("#895D7D");
  widget.addSpacer(8);
  const main = widget.addText(condition + "   " + temp);
  main.font = Font.boldRoundedSystemFont(22);
  main.textColor = new Color("#6C6079");
  widget.addSpacer(6);
  const foot = widget.addText(rain + "  ·  " + update + (fromCache ? "（前回）" : ""));
  foot.font = Font.mediumSystemFont(11);
  foot.textColor = new Color("#907B94");
}
Script.setWidget(widget);
if (!config.runsInWidget) {
  await widget.presentAccessoryRectangular();
}
Script.complete();
