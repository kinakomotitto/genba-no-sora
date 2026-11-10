// 하늘 ♡ · 現在地の空 — Scriptable ロック画面ウィジェット v1.2
// 「長方形」のロック画面ウィジェットで現在の天気とこの先3時間を表示。
// ホーム画面の小・中ウィジェットなら最大5時間分まで表示。
// ※ ロック画面の色・背景・形はiOS側が調整するため、完全なガラス調
//    （自由な背景ぼかしや大きなカード）は再現できません。
// ※ iOSの判断で更新されます。リアルタイム追跡・毎時の更新保証はありません。
// ※ 位置はScriptableで現在地を取得。概略座標だけOpen-Meteoへ送ります。
//    現場の保存地点・メモ・認証情報は参照も送信もしません。

const APP_URL = "https://kinakomotitto.github.io/genba-no-sora/";
const family = config.widgetFamily || "accessoryRectangular";
const widget = new ListWidget();
widget.url = APP_URL; // タップするとサイトを開く（iOSによってSafariになる）。
widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
// この時刻は最短更新の目安。実際の更新間隔はiOSが決定。

const fm = FileManager.local();
const cacheFile = fm.joinPath(fm.cacheDirectory(), "haneul-lockscreen-weather-v2.json");
function getCachedWeather() {
  try { if (fm.fileExists(cacheFile)) return JSON.parse(fm.readString(cacheFile)); } catch (_) {}
  return null;
}
function storeWeather(data) {
  try { fm.writeString(cacheFile, JSON.stringify(data)); } catch (_) {}
}
function sky(code, day) {
  if (code === 0) return {mark:day ? "☀" : "☾",ko:"맑음"};
  if (code === 1 || code === 2) return {mark:"⛅",ko:"구름 조금"};
  if (code === 3) return {mark:"☁",ko:"흐림"};
  if (code === 45 || code === 48) return {mark:"☁",ko:"안개"};
  if (code >= 51 && code <= 57) return {mark:"☂",ko:"이슬비"};
  if (code >= 61 && code <= 67) return {mark:"☂",ko:"비"};
  if (code >= 71 && code <= 77) return {mark:"❄",ko:"눈"};
  if (code >= 80 && code <= 82) return {mark:"☂",ko:"소나기"};
  if (code >= 85 && code <= 86) return {mark:"❄",ko:"눈"};
  if (code >= 95) return {mark:"⚡",ko:"천둥"};
  return {mark:"☁",ko:"날씨"};
}
function currentRain(data) {
  const times = data.hourly && data.hourly.time;
  const probs = data.hourly && data.hourly.precipitation_probability;
  const hour = String(data.current.time || "").slice(0,13);
  if (!Array.isArray(times)||!Array.isArray(probs)) return null;
  const i = times.findIndex(t=>String(t).slice(0,13)===hour);
  const value = i>=0?probs[i]:null;
  return Number.isFinite(value)?Math.round(value):null;
}
function futureForecast(data) {
  const h=data.hourly || {};
  const now=String(data.current.time || "").slice(0,13);
  if (!Array.isArray(h.time)||!Array.isArray(h.weather_code)||!Array.isArray(h.temperature_2m)) return [];
  const result=[];
  for (let i=0; i<h.time.length && result.length<5; i++) {
    const t=String(h.time[i]);
    if (t.slice(0,13)<=now) continue; // いまの時刻より後の時間帯だけ
    const temp=h.temperature_2m[i],code=h.weather_code[i];
    if (!Number.isFinite(temp)||!Number.isFinite(code)) continue;
    result.push({hour:Number(t.slice(11,13)),temp:Math.round(temp),mark:sky(code,true).mark});
  }
  return result;
}
let reading=null,fromCache=false;
const cached=getCachedWeather();
try {
  // 端末の現在地。GPS取得や通信が失敗したときは過去の結果を明示。
  Location.setAccuracyToHundredMeters();
  const pos=await Location.current();
  if(!Number.isFinite(pos.latitude)||!Number.isFinite(pos.longitude))throw Error("No GPS");
  const lat=pos.latitude.toFixed(3),lon=pos.longitude.toFixed(3);
  const url="https://api.open-meteo.com/v1/forecast"
    +"?latitude="+encodeURIComponent(lat)+"&longitude="+encodeURIComponent(lon)
    +"&current=temperature_2m,weather_code,is_day"
    +"&hourly=temperature_2m,weather_code,precipitation_probability"
    +"&forecast_days=2&timezone=auto";
  const request=new Request(url);
  request.timeoutInterval=12;
  const data=await request.loadJSON();
  const now=data.current||{};
  if(!Number.isFinite(now.temperature_2m)||!Number.isFinite(now.weather_code))throw Error("Weather unavailable");
  reading={
    temp:Math.round(now.temperature_2m),code:now.weather_code,
    isDay:now.is_day===1,rain:currentRain(data),
    weatherTime:String(now.time||"").slice(11,16),
    hours:futureForecast(data),fetchedAt:Date.now()
  };
  storeWeather(reading); // 位置情報・座標・現場データは保存しません。
}catch(_){
  if(cached&&Number.isFinite(cached.temp)&&Number.isFinite(cached.fetchedAt)
    &&Date.now()-cached.fetchedAt<2*60*60*1000){
    reading=cached;
    fromCache=true;
  }
}
const desc=reading?sky(reading.code,reading.isDay):{mark:"☁",ko:"확인 필요"};
const temperature=reading?String(reading.temp)+"°":"--°";
const currentText=desc.mark+" "+temperature+" "+desc.ko;
const hours=reading&&Array.isArray(reading.hours)?reading.hours.slice(0,5):[];
const rainText=reading&&reading.rain!==null?"강수 "+reading.rain+"%":"강수 --";
const timeLabel=reading&&reading.weatherTime?reading.weatherTime:"--:--";
const updated=fromCache?"前回 "+timeLabel:timeLabel;
function textLine(parent,content,size,bold){
  const item=parent.addText(content);
  item.font=bold?Font.semiboldSystemFont(size):Font.mediumSystemFont(size);
  item.lineLimit=1;
  item.minimumScaleFactor=0.68;
  return item;
}
function futureText(f){
  return String(f.hour)+"시 "+f.mark+String(f.temp)+"°";
}
if(family==="accessoryInline"){
  widget.setPadding(0,0,0,0);
  textLine(widget,"♡ 하늘 · "+temperature+" "+desc.mark,13,true);
}else if(family==="accessoryCircular"){
  widget.setPadding(0,0,0,0);
  const head=textLine(widget,"♡ 하늘",9,false);head.centerAlignText();
  const center=textLine(widget,temperature,21,true);center.centerAlignText();
  const foot=textLine(widget,desc.mark,10,false);foot.centerAlignText();
}else if(family==="accessoryRectangular"){
  // iOSの小さな長方形枠は3行だけ。気温を最大にして、3時間予報を優先。
  // より大きいガラス調カードはホーム画面「中」ウィジェットで利用できます。
  widget.setPadding(0,0,0,0);
  widget.spacing=0;
  const shortKorean=desc.ko==="구름 조금"?"구름":desc.ko;
  const heading=textLine(widget,"♡ 하늘  📍현재 위치 · "+(fromCache?"前回":shortKorean),10,true);
  heading.minimumScaleFactor=0.84;
  const big=textLine(widget,desc.mark+"  "+temperature,25,true);
  big.minimumScaleFactor=0.9;
  const future=widget.addStack();
  future.layoutHorizontally();
  future.centerAlignContent();
  const upcoming=hours.slice(0,3);
  if(upcoming.length){
    upcoming.forEach((f,i)=>{
      const line=textLine(future,f.hour+"시"+f.mark+f.temp+"°",10,true);
      line.minimumScaleFactor=0.84;
      if(i<upcoming.length-1)future.addSpacer(3);
    });
  }else{
    textLine(future,"시간별 예보 없음",10,false);
  }
}else{
  // ホーム画面用：透明感のある淡いピンク・ラベンダーのカード。
  const gradient=new LinearGradient();
  gradient.colors=[new Color("#F7E9F5"),new Color("#E5ECFD")];
  gradient.locations=[0,1];
  widget.backgroundGradient=gradient;
  widget.setPadding(14,14,14,14);
  widget.spacing=4;
  const title=textLine(widget,"♡ 하늘  📍 현재 위치"+(fromCache?"（前回）":""),12,true);
  title.textColor=new Color("#8D6989");
  const current=textLine(widget,currentText,21,true);
  current.textColor=new Color("#655D7C");
  const details=textLine(widget,rainText+" · "+updated,11,false);
  details.textColor=new Color("#987F96");
  widget.addSpacer(5);
  const num=family==="medium"?5:3;
  if(family==="medium"){
    const row=widget.addStack();row.layoutHorizontally();
    hours.slice(0,num).forEach((f,i)=>{
      const col=row.addStack();
      col.layoutVertically();
      col.setPadding(5,6,5,6);
      const hour=textLine(col,f.hour+"시",10,true);hour.textColor=new Color("#987F96");
      const mark=textLine(col,f.mark,16,true);mark.textColor=new Color("#766581");
      const temp=textLine(col,f.temp+"°",13,true);temp.textColor=new Color("#766581");
      if(i<num-1)row.addSpacer(5);
    });
  }else{
    hours.slice(0,num).forEach(f=>{
      const line=textLine(widget,futureText(f),11,false);
      line.textColor=new Color("#766581");
    });
  }
}
Script.setWidget(widget);
if(!config.runsInWidget)await widget.presentAccessoryRectangular();
Script.complete();
