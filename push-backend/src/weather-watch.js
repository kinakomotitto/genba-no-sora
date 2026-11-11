/* 現場の空: opt-in weather change notification forecast evaluator.
   Not an official warning/nowcast. Japan 15-min model series is derived
   from hourly forecasts, NOT 15-minute observed radar or lightning.
   Do not claim exact rain arrival or a lightning strike. */
export const WATCH_HOURS=4;
export const WATCH_RAIN_MM=0.5;
export const WATCH_GUST_MS=15;
export const WATCH_COOLDOWN_MS=2*60*60*1000;
export const WATCH_LIMIT=20;
export const WATCH_TABLE_SQL=String.raw`CREATE TABLE IF NOT EXISTS weather_watch (
  subscription_id TEXT PRIMARY KEY,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_rain_at TEXT,
  last_wind_at TEXT,
  last_thunder_at TEXT,
  FOREIGN KEY(subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
)`;
export function validCurrentGps(data,now=Date.now()){
  if(!data||typeof data!=='object')return null;
  const {lat,lon,accuracy,at}=data;
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<24||lat>46||lon<123||lon>150)return null;
  if(!Number.isFinite(accuracy)||accuracy<=0||accuracy>300)return null;
  const stamp=Date.parse(at);
  if(typeof at!=='string'||!Number.isFinite(stamp)||stamp>now+30000||now-stamp>5*60000)return null;
  return {lat:Number(lat.toFixed(3)),lon:Number(lon.toFixed(3))};
}
export function forecastUrl(lat,lon){
  const params=new URLSearchParams({
    latitude:lat.toFixed(3),longitude:lon.toFixed(3),
    minutely_15:'precipitation,wind_gusts_10m,weather_code',
    forecast_minutely_15:'9',
    timezone:'UTC',wind_speed_unit:'ms',precipitation_unit:'mm'
  });
  return 'https://api.open-meteo.com/v1/forecast?'+params.toString();
}
function unixUtc(iso){
  if(typeof iso!=='string'||!/^20\d{2}-\d\d-\d\dT\d\d:\d\d$/.test(iso))return NaN;
  return Date.parse(iso+':00Z');
}
export function evaluateForecast(json,now=Date.now()){
  const frame=json?.minutely_15;
  if(!frame||!Array.isArray(frame.time)||frame.time.length<1)return [];
  const {time,precipitation,wind_gusts_10m,weather_code}=frame;
  if(!Array.isArray(precipitation)||!Array.isArray(wind_gusts_10m)||
    !Array.isArray(weather_code)||Math.max(precipitation.length,wind_gusts_10m.length,weather_code.length)!==time.length)return [];
  let rain=false,wind=false,thunder=false,gustMax=null;
  for(let i=0;i<time.length;i++){
    const at=unixUtc(time[i]);
    if(!Number.isFinite(at)||at<now-5*60000||at>now+2*3600000)continue;
    const mm=precipitation[i],gust=wind_gusts_10m[i],code=weather_code[i];
    if(typeof mm==='number'&&Number.isFinite(mm)&&mm>=WATCH_RAIN_MM)rain=true;
    if(typeof gust==='number'&&Number.isFinite(gust)&&gust>=WATCH_GUST_MS){
      wind=true;gustMax=Math.max(gustMax||0,gust);
    }
    if(Number.isInteger(code)&&[95,96,99].includes(code))thunder=true;
  }
  const result=[];
  if(thunder)result.push({kind:'thunder',text:'⛈️ この先2時間に雷雨の予報。実際の落雷接近を検知した通知ではありません。'});
  if(wind)result.push({kind:'wind',text:'🌬️ この先2時間に最大瞬間風速'+gustMax.toFixed(0)+'m/s前後の予報。'});
  if(rain)result.push({kind:'rain',text:'🌧️ この先2時間に雨の予報。降り始める正確な時刻は分かりません。'});
  return result;
}
export async function fetchForecast(lat,lon,fetcher=fetch){
  const res=await fetcher(forecastUrl(lat,lon),{
    signal:AbortSignal.timeout(9000),cache:'no-store'
  });
  if(!res.ok)throw Error('Weather forecast provider unavailable');
  return await res.json();
}
