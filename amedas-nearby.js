/* 現場の空 v0.30 — nearby PUBLIC JMA AMeDAS observations on demand.
   JMA web JSON is not a guaranteed public developer API. Load only on user
   expansion, cache one national map in memory, and never transmit user GPS.
*/
(()=>{
'use strict';
const JMA='https://www.jma.go.jp/bosai/amedas/';
const TTL=12*60*1000,MAX_AGE=90*60*1000,RANGE_KM=80;
const e=id=>document.getElementById(id);
const details=e('amedas-nearby');
if(!details)return;
let locationPoint=null,requestId=0,cache=null,loading=null;
let currentForecast=null,temperatureStation=null,temperatureObservedAt=null;
let groundElevation=null,elevationController=null,elevationRequestId=0;
const GSI_ELEVATION='https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php';
const OPEN_METEO_ELEVATION='https://api.open-meteo.com/v1/elevation';
const n=x=>typeof x==='number'&&Number.isFinite(x)?x:null;
function valid(entry){
  // Web JSON observations use [value,quality]; accept only quality 0.
  return Array.isArray(entry)&&entry[1]===0?n(entry[0]):null;
}
function km(lat,lon,lat2,lon2){
  const r=Math.PI/180,dLat=(lat2-lat)*r,dLon=(lon2-lon)*r;
  const a=Math.sin(dLat/2)**2+Math.cos(lat*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;
  return 12742*Math.asin(Math.min(1,Math.sqrt(a)));
}
function deg(pair){
  if(!Array.isArray(pair)||pair.length!==2)return null;
  const d=n(pair[0]),m=n(pair[1]);
  if(d===null||m===null||m<0||m>=60)return null;
  return d+m/60;
}
function displayStation(station,what){
  const field=e(what==='wind'?'amedas-wind-value':'amedas-rain-value');
  const label=e(what==='wind'?'amedas-wind-station':'amedas-rain-station');
  if(!field||!label)return;
  if(!station){
    field.textContent='—';
    label.textContent='80km圏内に有効な観測がありません';
    return;
  }
  const wind=station.wind;
  const direction=n(station.windDir);
  const dirs=['静穏','北北東','北東','東北東','東','東南東','南東','南南東','南','南南西','南西','西南西','西','西北西','北西','北北西','北'];
  field.textContent=what==='wind'
    ? wind.toFixed(1)+' m/s'+(direction!==null&&Number.isInteger(direction)&&direction>=0&&direction<=16?' · '+dirs[direction]:'')
    : station.rain.toFixed(1)+' mm';
  label.textContent=station.name+' · 約'+station.distance.toFixed(1)+'km';
}

// Side-by-side values are a *reference only*: model temperature is for the
// selected coordinate and measured temperature is from another location.
function jstForecastInstant(value){
  if(typeof value!=='string')return null;
  const stamp=/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value)?value+'+09:00':value;
  const at=new Date(stamp);
  return Number.isFinite(at.getTime())?at:null;
}
function renderTemperature(){
  const fore=e('amedas-temp-forecast'),actual=e('amedas-temp-observed');
  const delta=e('amedas-temp-difference'),station=e('amedas-temp-station');
  const note=e('amedas-temp-note');
  if(!fore||!actual||!delta||!station||!note)return;
  const fc=currentForecast,obs=temperatureStation;
  fore.textContent=fc&&n(fc.temperature)!==null?fc.temperature.toFixed(1)+'℃':'—';
  actual.textContent=obs&&n(obs.temp)!==null?obs.temp.toFixed(1)+'℃':'—';
  delta.textContent='—';
  station.textContent=obs
    ?'観測所：'+obs.name+' · 約'+obs.distance.toFixed(1)+'km'+
      (n(obs.alt)!==null?' · 標高'+Math.round(obs.alt)+'m':'')
    :'80km以内の気温観測所を確認中';
  if(!obs){note.textContent=temperatureObservedAt?'近くに有効な気温の観測値がないよ。':'観測値を見ると、近くの実測気温が分かるよ。';return}
  if(!fc||n(fc.temperature)===null){note.textContent='この地点の予報気温を取得すると比較できるよ。';return}
  if(fc.stale){note.textContent='保存済みの予報は最新ではないため、実測との差を計算しないよ。';return}
  const target=jstForecastInstant(fc.validAt);
  const stamp=temperatureObservedAt;
  const fetched=new Date(fc.fetched);
  if(!target||!stamp||!Number.isFinite(fetched.getTime())||
     Math.abs(target.getTime()-stamp.getTime())>30*60*1000||
     Date.now()-stamp.getTime()>45*60*1000||
     Date.now()-fetched.getTime()>90*60*1000){
    note.textContent='予報と実測の時刻が十分に近くないため、差は計算しないよ。';
    return;
  }
  const diff=fc.temperature-obs.temp;
  delta.textContent=(diff>0?'＋':diff<0?'−':'±')+Math.abs(diff).toFixed(1)+'℃';
  const clock=t=>t.toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'});
  note.textContent='予報 '+clock(target)+'／実測 '+clock(stamp)+'。差は別地点との参考比較で、地形や標高が違うため予報誤差とは断定できないよ。';
}
function setForecast(current,fetched,stale){
  const temp=n(current?.temperature_2m);
  currentForecast={
    temperature:temp,validAt:current?.time||null,
    fetched:typeof fetched==='string'?fetched:'',
    stale:!!stale
  };
  renderTemperature();
}
function clearForecast(){
  currentForecast=null;
  renderTemperature();
}


// Ground height at the selected GPS/site/private point, NOT GPS ellipsoid altitude
// or a forecast-model grid's elevation. A user tap is required before sending
// coordinates to an external elevation provider. No stored GPS elevation log.
function renderElevation(){
  const here=e('amedas-ground-height'),station=e('amedas-station-height');
  const difference=e('amedas-height-difference'),note=e('amedas-height-status');
  if(!here||!station||!difference||!note)return;
  const altitude=typeof temperatureStation?.alt==='number'&&Number.isFinite(temperatureStation.alt)
    ?temperatureStation.alt:null;
  const local=groundElevation?.height;
  here.textContent=Number.isFinite(local)?Math.round(local)+'m':'—';
  station.textContent=altitude!==null?Math.round(altitude)+'m':'—';
  difference.textContent='—';
  if(Number.isFinite(local)&&altitude!==null){
    const diff=Math.round(local-altitude);
    difference.textContent=(diff>0?'＋':diff<0?'−':'±')+Math.abs(diff)+'m';
  }
  if(groundElevation){
    note.textContent='出典：'+groundElevation.source+'。選択地点の地形上の標高（概算）で、建物の階数やGPS高度ではないよ。';
  }else if(locationPoint){
    note.textContent='「標高を調べる」を押すと選択地点の座標を標高サービスへ送って調べるよ。';
  }else{
    note.textContent='現在地を取得するか、地点を選ぶと標高を調べられるよ。';
  }
}
function resetElevation(){
  elevationRequestId++;
  elevationController?.abort();
  elevationController=null;
  groundElevation=null;
  const button=e('amedas-ground-lookup');
  if(button)button.disabled=false;
  renderElevation();
}
function parseGsiElevation(data){
  const elevation=data?.elevation;
  // Official API returns "-----" when terrain data is unavailable.
  if(typeof elevation!=='number'||!Number.isFinite(elevation)||elevation< -500||elevation>10000)
    return null;
  const hsrc=typeof data.hsrc==='string'&&/^(1m|5m|10m)/.test(data.hsrc)?data.hsrc:'地形データ';
  return {height:elevation,source:'国土地理院・'+hsrc};
}
function parseOpenMeteoElevation(data){
  const value=data?.elevation?.[0];
  if(typeof value!=='number'||!Number.isFinite(value)||value< -500||value>10000)return null;
  return {height:value,source:'Open-Meteo・約90m地形メッシュ（参考）'};
}
async function lookupGroundElevation(){
  if(!locationPoint)return;
  if(!navigator.onLine){e('amedas-height-status').textContent='圏外では新しい標高を取得できないよ。';return}
  const point=locationPoint,requestId=++elevationRequestId;
  elevationController?.abort();
  const controller=new AbortController();elevationController=controller;
  const button=e('amedas-ground-lookup');
  if(button)button.disabled=true;
  groundElevation=null;renderElevation();
  e('amedas-height-status').textContent='選択地点の地形上の標高を調べているよ…';
  const getJson=async(url)=>{
    const timer=setTimeout(()=>controller.abort(),9000);
    try{
      const response=await fetch(url,{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error('HTTP '+response.status);
      return await response.json();
    }finally{clearTimeout(timer)}
  };
  try{
    const lat=point.lat.toFixed(5),lon=point.lon.toFixed(5);
    let result=null;
    try{
      const qs=new URLSearchParams({lat,lon,outtype:'JSON'});
      result=parseGsiElevation(await getJson(GSI_ELEVATION+'?'+qs));
    }catch(_){
      // GSI may not permit every browser's cross-origin request, or may be down.
      // Do not execute remote JSONP; switch to a separately labeled DEM fallback.
    }
    if(!result&&!controller.signal.aborted){
      const qs=new URLSearchParams({latitude:lat,longitude:lon});
      result=parseOpenMeteoElevation(await getJson(OPEN_METEO_ELEVATION+'?'+qs));
    }
    if(requestId!==elevationRequestId||point.id!==locationPoint?.id)return;
    if(!result)throw Error('Elevation data not available');
    groundElevation=result;
    renderElevation();
  }catch(_){
    if(requestId!==elevationRequestId||point.id!==locationPoint?.id)return;
    groundElevation=null;renderElevation();
    e('amedas-height-status').textContent='標高を取得できなかったよ。通信が使える場所でもう一度試してね。';
  }finally{
    if(requestId===elevationRequestId&&point.id===locationPoint?.id){
      if(button)button.disabled=false;
      elevationController=null;
    }
  }
}

function reset(){
  for(const key of ['amedas-wind-value','amedas-rain-value'])e(key).textContent='—';
  for(const key of ['amedas-wind-station','amedas-rain-station'])e(key).textContent='観測所を確認中';
  temperatureStation=null;temperatureObservedAt=null;renderTemperature();renderElevation();
}
function setLocation(lat,lon){
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
  const newPoint=lat.toFixed(4)+','+lon.toFixed(4);
  if(locationPoint?.id===newPoint)return;
  locationPoint={id:newPoint,lat,lon};
  ++requestId;currentForecast=null;resetElevation();reset();
  e('amedas-status').textContent='選択地点の近くの観測所を確認できるよ。';
  if(details.open)load();
}
async function readText(url){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    if(!response.ok)throw Error('HTTP '+response.status);
    return await response.text();
  }finally{clearTimeout(timer)}
}
async function readJson(url){
  const text=await readText(url);
  if(text.length>2000000)throw Error('Too much data');
  return JSON.parse(text);
}
async function national(){
  if(cache&&Date.now()-cache.fetched<TTL)return cache;
  if(loading)return loading;
  loading=(async()=>{
    const [timeText,catalog]=await Promise.all([
      readText(JMA+'data/latest_time.txt'),
      readJson(JMA+'const/amedastable.json')
    ]);
    const latest=timeText.trim(),time=new Date(latest);
    if(!Number.isFinite(time.getTime())||!latest.endsWith('+09:00'))throw Error('Invalid latest time');
    if(time.getTime()>Date.now()+60000||Date.now()-time.getTime()>MAX_AGE)throw Error('Stale national observations');
    // JMA publishes 10-minute national map as a public web asset.
    const stamp=latest.slice(0,19).replace(/[-:T]/g,'');
    if(!/^\d{14}$/.test(stamp))throw Error('Invalid map time');
    const map=await readJson(JMA+'data/map/'+stamp+'.json');
    if(!map||typeof map!=='object'||Array.isArray(map)||!Object.keys(map).length)throw Error('Invalid map');
    const found={fetched:Date.now(),at:time,latest,catalog,map};
    cache=found;return found;
  })();
  try{return await loading}finally{loading=null}
}
async function load(){
  if(!details.open)return;
  const requested=++requestId,site=locationPoint;
  if(!site){e('amedas-status').textContent='まず現在地を取得するか、保存した現場を選んでね。';return}
  if(!navigator.onLine){e('amedas-status').textContent='圏外では新しい実測値を取得できないよ。';return}
  e('amedas-status').textContent='気象庁の全国観測データを照合中…';
  try{
    const data=await national();
    if(requested!==requestId)return;
    let nearestWind=null,nearestRain=null,nearestTemperature=null;
    for(const [id,obs] of Object.entries(data.map)){
      const meta=data.catalog[id];
      if(!meta||!obs||typeof obs!=='object')continue;
      const lat=deg(meta.lat),lon=deg(meta.lon);
      if(lat===null||lon===null)continue;
      const distance=km(site.lat,site.lon,lat,lon);
      if(distance>RANGE_KM)continue;
      const wind=valid(obs.wind),rain=valid(obs.precipitation1h),windDir=valid(obs.windDirection);
      const temp=valid(obs.temp);
      const station={name:String(meta.kjName||id),distance,wind,rain,windDir,temp,
        alt:typeof meta.alt==='number'&&Number.isFinite(meta.alt)?meta.alt:null};
      if(wind!==null&&wind>=0&&(!nearestWind||distance<nearestWind.distance))nearestWind=station;
      if(rain!==null&&rain>=0&&(!nearestRain||distance<nearestRain.distance))nearestRain=station;
      if(temp!==null&&temp>=-100&&temp<=65&&(!nearestTemperature||distance<nearestTemperature.distance))nearestTemperature=station;
    }
    displayStation(nearestWind,'wind');displayStation(nearestRain,'rain');
    temperatureStation=nearestTemperature;temperatureObservedAt=data.at;renderTemperature();renderElevation();
    const age=Math.max(0,Math.round((Date.now()-data.at.getTime())/60000));
    const label=data.at.toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    e('amedas-status').textContent=label+' 観測 · '+age+'分前'+(age>30?'（最新の観測ではない可能性があります）':'');
  }catch(error){
    if(requested!==requestId)return;
    reset();
    e('amedas-status').textContent='観測値を取得できなかったよ。気象庁のサイトで確認してね。';
  }
}
details.addEventListener('toggle',()=>{if(details.open)load()});
e('amedas-refresh')?.addEventListener('click',()=>{cache=null;load()});
e('amedas-ground-lookup')?.addEventListener('click',lookupGroundElevation);
function clear(){
  ++requestId;locationPoint=null;currentForecast=null;resetElevation();reset();
  e('amedas-status').textContent='現在地を取得すると近くの観測所を表示できるよ。';
}
window.SoraAmedas={setLocation,setForecast,clearForecast,refresh:load,lookupGroundElevation,clear};
})();