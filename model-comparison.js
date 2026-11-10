/* 現場の空 v0.27 — 複数モデルの雨・風比較。個人情報・現場名は送信しない。 */
(function(){
'use strict';
const ROOT='https://api.open-meteo.com/v1/forecast';
const STATIONS=[
  {id:'jma_msm',label:'気象庁 MSM',gust:false},
  {id:'ecmwf_ifs',label:'ECMWF IFS',gust:true},
  {id:'icon_seamless',label:'DWD ICON',gust:true}
];
const STORAGE='genbanosora.modelhistory.v1';
const MAX_RECORDS=120,TTL=20*60*1000,KEEP_DAYS=14;
const one=id=>document.getElementById(id);
const memory=new Map();
let point=null,requestID=0,activeModels=[],activeTime='',retrievedAt='',isStale=false;
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const value=v=>num(v)===null?'—':v.toFixed(1);
const roundPoint=(lat,lon)=>[Number(lat.toFixed(3)),Number(lon.toFixed(3))];
const keyOf=(lat,lon)=>roundPoint(lat,lon).join(',');
function readHistory(){
  try{const x=JSON.parse(localStorage.getItem(STORAGE)||'[]');return Array.isArray(x)?x.filter(r=>r&&r.model&&Array.isArray(r.forecast)):[]}
  catch(_){return []}
}
function saveHistory(lat,lon,models){
  const at=new Date().toISOString(),position=roundPoint(lat,lon);
  let saved=readHistory();
  for(const model of models){
    if(!model.ok)continue;
    saved.push({at,point:position,model:model.id,forecast:model.hours.slice(0,30)});
  }
  const cutoff=Date.now()-KEEP_DAYS*86400000;
  saved=saved.filter(r=>Date.parse(r.at)>=cutoff).slice(-MAX_RECORDS);
  try{localStorage.setItem(STORAGE,JSON.stringify(saved))}catch(_){}
}
function restoreModels(lat,lon){
  const position=keyOf(lat,lon),latest=new Map();
  for(const record of readHistory()){
    if(!Array.isArray(record.point)||record.point.join(',')!==position)continue;
    const prev=latest.get(record.model);
    if(!prev||record.at>prev.at)latest.set(record.model,record);
  }
  const models=STATIONS.map(s=>{
    const old=latest.get(s.id);
    return old?{...s,ok:true,hours:old.forecast}:{...s,ok:false,hours:[]};
  });
  const times=[...latest.values()].map(r=>r.at).sort();
  return {models,at:times[times.length-1]||''};
}
function normalized(id,json){
  if(!json||json.error||!json.hourly||!Array.isArray(json.hourly.time))throw Error('missing hourly data');
  const h=json.hourly;
  const get=(name,i)=>Array.isArray(h[name])?num(h[name][i]):null;
  return {id,ok:true,hours:h.time.map((time,i)=>({
    time:String(time),
    wind:get('wind_speed_10m',i),
    gust:get('wind_gusts_10m',i),
    rain:get('precipitation',i),
    direction:get('wind_direction_10m',i)
  }))};
}
async function requestModel(s,lat,lon){
  const names=['wind_speed_10m','wind_direction_10m','precipitation'];
  if(s.gust)names.push('wind_gusts_10m');
  async function request(fields){
    const query=new URLSearchParams({
      latitude:lat.toFixed(5),longitude:lon.toFixed(5),
      hourly:fields.join(','),models:s.id,forecast_days:'2',
      timezone:'Asia/Tokyo',wind_speed_unit:'ms',precipitation_unit:'mm'
    });
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),13000);
    try{
      const response=await fetch(ROOT+'?'+query.toString(),{signal:controller.signal,cache:'no-store'});
      if(!response.ok)throw Error('Weather API '+response.status);
      return normalized(s.id,await response.json());
    }finally{clearTimeout(timer)}
  }
  // When a model doesn't publish gusts, retry once without that unsupported field.
  try{return await request(names)}
  catch(error){
    if(!s.gust)return {...s,ok:false,hours:[]};
    try{return await request(names.filter(n=>n!=='wind_gusts_10m'))}
    catch(_){return {...s,ok:false,hours:[]}}
  }
}
function labelJST(at){
  if(!at)return '日時不明';
  const d=new Date(at);
  return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d):'日時不明';
}
function rangeFor(models,field,time){
  const available=models.filter(m=>m.ok).map(m=>m.hours.find(h=>h.time===time)?.[field])
    .filter(v=>num(v)!==null&&v>=0);
  return available.length?{min:Math.min(...available),max:Math.max(...available),count:available.length}:null;
}
function outputRange(range,unit){
  if(!range)return '取得できません';
  return value(range.min)+(range.min===range.max?'':'〜'+value(range.max))+unit;
}
function directionText(degrees){
  if(num(degrees)===null)return '';
  return ['北','北東','東','南東','南','南西','西','北西'][Math.round(((degrees%360)+360)%360/45)%8]+'風';
}
function display(){
  const status=one('model-compare-status'),choices=one('model-compare-times');
  const headline=one('model-compare-headline'),rows=one('model-compare-rows');
  const windBox=one('model-compare-wind'),rainBox=one('model-compare-rain');
  const gustBox=one('model-compare-gust'),note=one('model-compare-note');
  if(!status||!choices||!rows||!headline)return;
  choices.replaceChildren();rows.replaceChildren();
  const successful=activeModels.filter(m=>m.ok).length;
  // Forecast precipitation is the total for the preceding hour, so start with the next hour ending.
  const nowHour=new Date(Date.now()+10*3600000).toISOString().slice(0,13);
  const keys=[...new Set(activeModels.filter(m=>m.ok).flatMap(m=>m.hours.map(h=>h.time)))].filter(t=>t.slice(0,13)>=nowHour).sort().slice(0,6);
  status.textContent=successful+'/3モデル取得 · '+(isStale?'保存済み・最新ではありません · ':'取得 ')+labelJST(retrievedAt);
  headline.textContent=successful>1?'風と雨の予測差を比較':successful===1?'1モデルのみ取得':'比較データなし';
  if(!successful||!keys.length){
    status.textContent=successful?'比較できる時刻の予測がないよ。':'比較データを取得できなかったよ。通信を確認してね。';
    windBox.textContent='—';rainBox.textContent='—';gustBox.textContent='—';
    note.textContent='モデルがそろわない場合、比較結果や精度を推定しないよ。';
    return;
  }
  if(!keys.includes(activeTime))activeTime=keys[0];
  for(const time of keys){
    const b=document.createElement('button');b.type='button';
    b.className='model-compare-time'+(time===activeTime?' active':'');
    b.textContent=time.slice(11,13)+'時';
    b.setAttribute('aria-pressed',String(time===activeTime));
    b.addEventListener('click',()=>{activeTime=time;display()});
    choices.append(b);
  }
  const wind=rangeFor(activeModels,'wind',activeTime);
  const rain=rangeFor(activeModels,'rain',activeTime);
  const gust=rangeFor(activeModels,'gust',activeTime);
  windBox.textContent=outputRange(wind,' m/s');
  rainBox.textContent=outputRange(rain,' mm');
  gustBox.textContent=outputRange(gust,' m/s');
  const difference=wind&&wind.count>=2?wind.max-wind.min:null;
  const rainDifference=rain&&rain.count>=2?rain.max-rain.min:null;
  const phrases=[];
  if(difference!==null)phrases.push('風速の差 '+value(difference)+' m/s');
  if(rainDifference!==null)phrases.push('降水量の差 '+value(rainDifference)+' mm');
  note.textContent=(phrases.length?phrases.join(' ／ '):'比較に必要な数値がそろっていません。')+
    '。単純平均ではなく各モデルの範囲を表示。突風は対応モデルのみ、欠測は0扱いしません。';
  for(const station of STATIONS){
    const model=activeModels.find(m=>m.id===station.id);
    const h=model?.ok?model.hours.find(h=>h.time===activeTime):null;
    const row=document.createElement('div');row.className='model-compare-row';
    const name=document.createElement('div');name.className='model-compare-source';name.textContent=station.label;
    const windCell=document.createElement('div');windCell.textContent=h?value(h.wind):'—';
    const gustCell=document.createElement('div');gustCell.textContent=h?value(h.gust):'—';
    const rainCell=document.createElement('div');rainCell.textContent=h?value(h.rain):'—';
    row.append(name,windCell,gustCell,rainCell);
    if(!h)row.classList.add('unavailable');
    if(h&&h.direction!==null){
      const dir=document.createElement('small');dir.textContent=directionText(h.direction);name.append(dir);
    }
    rows.append(row);
  }
}
function showFailure(){
  activeModels=STATIONS.map(s=>({...s,ok:false,hours:[]}));
  retrievedAt='';isStale=false;activeTime='';display();
}
async function update(lat,lon){
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
  point=keyOf(lat,lon);
  const id=++requestID;
  const known=memory.get(point);
  if(known&&Date.now()-Date.parse(known.at)<TTL){
    activeModels=known.models;retrievedAt=known.at;isStale=false;display();return;
  }
  const status=one('model-compare-status');
  if(status)status.textContent='3つの予報モデルを照合中…';
  if(!navigator.onLine){restore(lat,lon);return}
  const models=await Promise.all(STATIONS.map(s=>requestModel(s,lat,lon)));
  if(id!==requestID)return;
  if(!models.some(m=>m.ok)){
    const old=restoreModels(lat,lon);
    if(old.at){activeModels=old.models;retrievedAt=old.at;isStale=true;activeTime='';display();return}
  }
  activeModels=models;retrievedAt=new Date().toISOString();isStale=false;activeTime='';
  if(models.some(m=>m.ok)){
    memory.set(point,{models,at:retrievedAt});
    saveHistory(lat,lon,models);
  }
  display();
}
function restore(lat,lon){
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
  ++requestID;point=keyOf(lat,lon);
  const old=restoreModels(lat,lon);
  activeModels=old.models;retrievedAt=old.at;isStale=true;activeTime='';
  if(old.at)display();else showFailure();
}
function prepare(lat,lon){
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
  const target=keyOf(lat,lon);
  if(target===point)return;
  ++requestID;point=target;activeModels=[];activeTime='';retrievedAt='';isStale=false;
  display();
  const status=one('model-compare-status');
  if(status)status.textContent='この地点の予報を確認するよ…';
}
function clear(){
  ++requestID;point=null;activeModels=[];activeTime='';retrievedAt='';isStale=false;
  display();
}
window.SoraCompare={update,restore,prepare,clear};
})();