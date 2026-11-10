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
function reset(){
  for(const key of ['amedas-wind-value','amedas-rain-value'])e(key).textContent='—';
  for(const key of ['amedas-wind-station','amedas-rain-station'])e(key).textContent='観測所を確認中';
}
function setLocation(lat,lon){
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
  const newPoint=lat.toFixed(4)+','+lon.toFixed(4);
  if(locationPoint?.id===newPoint)return;
  locationPoint={id:newPoint,lat,lon};
  ++requestId;reset();
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
    let nearestWind=null,nearestRain=null;
    for(const [id,obs] of Object.entries(data.map)){
      const meta=data.catalog[id];
      if(!meta||!obs||typeof obs!=='object')continue;
      const lat=deg(meta.lat),lon=deg(meta.lon);
      if(lat===null||lon===null)continue;
      const distance=km(site.lat,site.lon,lat,lon);
      if(distance>RANGE_KM)continue;
      const wind=valid(obs.wind),rain=valid(obs.precipitation1h),windDir=valid(obs.windDirection);
      const station={name:String(meta.kjName||id),distance,wind,rain,windDir};
      if(wind!==null&&wind>=0&&(!nearestWind||distance<nearestWind.distance))nearestWind=station;
      if(rain!==null&&rain>=0&&(!nearestRain||distance<nearestRain.distance))nearestRain=station;
    }
    displayStation(nearestWind,'wind');displayStation(nearestRain,'rain');
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
function clear(){
  ++requestId;locationPoint=null;reset();
  e('amedas-status').textContent='現在地を取得すると近くの観測所を表示できるよ。';
}
window.SoraAmedas={setLocation,refresh:load,clear};
})();