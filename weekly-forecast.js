/* 現場の空: 7-day forecast, standalone from research model pipeline. */
(()=>{
'use strict';
const root=document.getElementById('weekly-forecast');
if(!root)return;
const $=id=>document.getElementById(id);
const key='genbanosora.weekly.v1', choiceKey='genbanosora.weekly.choice.v1', hour=3600000;
let store={},choice='current',activeDay=-1,expanded=false,busy=false,request=null,shown=null;
try{store=JSON.parse(localStorage.getItem(key)||'{}')||{};choice=localStorage.getItem(choiceKey)||'current'}catch{}
const today=()=>new Date(Date.now()+9*hour).toISOString().slice(0,10);
const time=()=>new Date(Date.now()+9*hour).toISOString().slice(11,13);
const dateLabel=d=>{const x=new Date(d+'T12:00:00+09:00');return x.toLocaleDateString('ja-JP',{month:'numeric',day:'numeric',weekday:'short',timeZone:'Asia/Tokyo'})};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const codeIcon=c=>c==null?'☁️':c===0?'☀️':c<=2?'🌤️':c===3?'☁️':c<=48?'🌫️':c<=67?'🌧️':c<=77?'🌨️':c<=82?'🌦️':c<=86?'🌨️':'⛈️';
const fmt=(v,s='')=>Number.isFinite(v)?Math.round(v*10)/10+s:'—';
const hue=(kind,v)=>{if(!Number.isFinite(v))return '';let thresholds=kind==='prob'?[50,80,Infinity]:kind==='rain'?[1,10,20]:kind==='wind'?[5,10,15]:kind==='gust'?[10,15,20]:[Infinity,Infinity,Infinity];return v>=thresholds[2]?'warn-strong':v>=thresholds[1]?'warn-mid':v>=thresholds[0]?'warn-soft':''};
const coords=()=>{const ctx=window.SoraWeeklyContext?.();if(!ctx)return null;const sites=ctx.sites||[];const opts=[{id:'current',name:'現在地',lat:ctx.gps?.lat,lon:ctx.gps?.lon},...sites.map(s=>({id:'site:'+s.id,name:s.name,lat:s.lat,lon:s.lon}))];if(!opts.some(o=>o.id===choice))choice='current';return {opts,place:opts.find(o=>o.id===choice)}};
const coordKey=p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)?p.lat.toFixed(3)+','+p.lon.toFixed(3):null;
const entry=()=>{const p=coords()?.place;return store[coordKey(p)]};
const valid=e=>e&&e.data&&Array.isArray(e.data.daily?.time)&&Array.isArray(e.data.hourly?.time);
const status=(msg,fail=false)=>{$('weekly-status').textContent=msg||'';$('weekly-status').classList.toggle('error',fail)};
function persist(){try{const keys=Object.keys(store).sort((a,b)=>(store[b]?.fetched||0)-(store[a]?.fetched||0));for(const k of keys.slice(8))delete store[k];localStorage.setItem(key,JSON.stringify(store))}catch{status('保存容量が不足しています。次回は再取得が必要です。',true)}}
function skeleton(){return Array.from({length:7},()=>'<div class="weekly-skeleton" aria-hidden="true"></div>').join('')}
function draw(){
 const info=coords();const place=info?.place;const select=$('weekly-place');
 select.innerHTML=info.opts.map(o=>'<option value="'+esc(o.id)+'">'+esc(o.name)+'</option>').join('');select.value=choice;
 const e=entry(),d=e?.data?.daily;shown=e;
 if(!valid(e)){ $('weekly-days').innerHTML=skeleton();$('weekly-updated').textContent='';status(place&&coordKey(place)?'週間天気を取得中…':'GPSの取得を待っています');return}
 const rows=d.time.map((day,i)=>({day,i})).filter(o=>o.day>=today()).slice(0,7);
 $('weekly-days').innerHTML=rows.map(({day,i})=>{
 const hi=d.temperature_2m_max?.[i],lo=d.temperature_2m_min?.[i],wc=d.weather_code?.[i];
 const h=e.data.hourly,probs=h.time.map((t,j)=>t.slice(0,10)===day?h.precipitation_probability?.[j]:null).filter(Number.isFinite);
 const prob=probs.length?Math.max(...probs):null;
 return '<button type="button" class="weekly-day" data-day="'+i+'"><span class="weekly-day-date">'+(day===today()?'今日 · ':'')+esc(dateLabel(day))+'</span><span class="weekly-day-icon">'+codeIcon(wc)+'</span><span class="weekly-day-temps">'+fmt(hi,'℃')+' <small>/ '+fmt(lo,'℃')+'</small></span><span class="weekly-day-prob '+hue('prob',prob)+'">☂ '+fmt(prob,'%')+'</span><span aria-hidden="true">›</span></button>'
 }).join('')||'<p>保存された予報に未来の日付がありません。</p>';
 $('weekly-updated').textContent='最終取得：'+new Date(e.fetched).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
 if(Date.now()-e.fetched>=hour)status('保存済みの予報です。最新情報ではありません。',true);else status('');
 $('weekly-days').querySelectorAll('[data-day]').forEach(b=>b.addEventListener('click',()=>openDay(Number(b.dataset.day))));
 if(activeDay>=0){if(!d.time[activeDay]||d.time[activeDay]<today())close();else renderPanel()}
}
async function refresh(force=false){
 const info=coords(),p=info?.place,k=coordKey(p);if(!k){draw();return}
 const old=store[k];if(!force&&valid(old)&&Date.now()-old.fetched<hour){draw();return}
 if(busy&&request?.key===k)return;
 request?.controller.abort();const controller=new AbortController();request={controller,key:k};busy=true;
 $('weekly-refresh').classList.add('spinning');draw();
 const timeout=setTimeout(()=>controller.abort(),14000);
 try{
 const q=new URLSearchParams({latitude:p.lat.toFixed(5),longitude:p.lon.toFixed(5),timezone:'Asia/Tokyo',forecast_days:'7',wind_speed_unit:'ms',hourly:'temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m',daily:'weather_code,temperature_2m_max,temperature_2m_min'});
 const response=await fetch('https://api.open-meteo.com/v1/forecast?'+q,{signal:controller.signal});
 if(!response.ok)throw Error('HTTP '+response.status);
 const data=await response.json();
 if(!Array.isArray(data.daily?.time)||data.daily.time.length<7||!Array.isArray(data.hourly?.time)||!Array.isArray(data.hourly?.wind_gusts_10m))throw Error('週間データが不完全');
 if(request?.controller!==controller)return;
 store[k]={data,fetched:Date.now()};persist();draw();status('');
 }catch(err){if(controller.signal.aborted&&request?.controller!==controller)return;draw();status(valid(old)?'更新できませんでした。保存済みの予報を表示中です。':'週間天気を取得できませんでした。再取得してください。',true)}
 finally{clearTimeout(timeout);if(request?.controller===controller){busy=false;request=null;$('weekly-refresh').classList.remove('spinning')}}
}
function openDay(i){activeDay=i;expanded=false;$('weekly-sheet').classList.remove('expanded');$('weekly-overlay').hidden=false;document.body.classList.add('weekly-open');renderPanel()}
function close(){activeDay=-1;$('weekly-overlay').hidden=true;document.body.classList.remove('weekly-open')}
function renderPanel(){
 const e=entry();if(!valid(e)||activeDay<0)return;
 const day=e.data.daily.time[activeDay],h=e.data.hourly;
 $('weekly-sheet-date').textContent=dateLabel(day);
 $('weekly-prev').disabled=activeDay===0||e.data.daily.time[activeDay-1]<today();
 $('weekly-next').disabled=activeDay>=e.data.daily.time.length-1;
 const indexes=h.time.map((t,i)=>t.slice(0,10)===day?i:-1).filter(i=>i>=0);
 const cols=indexes.map(i=>'<div class="weekly-hour-col"><div class="weekly-hour-cell head">'+esc(h.time[i].slice(11,13))+'時</div>'+
 [['temp',h.temperature_2m?.[i],'℃'],['prob',h.precipitation_probability?.[i],'%'],['rain',h.precipitation?.[i],'mm'],['wind',h.wind_speed_10m?.[i],'m/s'],['gust',h.wind_gusts_10m?.[i],'m/s']].map(([kind,v,u])=>'<div class="weekly-hour-cell '+hue(kind,v)+'">'+fmt(v,u)+'</div>').join('')+'</div>').join('');
 $('weekly-hour-data').innerHTML=cols;
 requestAnimationFrame(()=>{const scroll=$('weekly-hour-scroll');if(!scroll)return;const h0=day===today()?Number(time()):6;scroll.scrollLeft=Math.max(0,h0*74-6)});
}
$('weekly-place').addEventListener('change',e=>{choice=e.target.value;try{localStorage.setItem(choiceKey,choice)}catch{}close();draw();refresh()});
$('weekly-refresh').addEventListener('click',()=>refresh(true));
$('weekly-close').addEventListener('click',close);
$('weekly-backdrop').addEventListener('click',close);
$('weekly-prev').addEventListener('click',()=>{if(activeDay>0){activeDay--;renderPanel()}});
$('weekly-next').addEventListener('click',()=>{if(activeDay<6){activeDay++;renderPanel()}});
$('weekly-expand').addEventListener('click',()=>{expanded=!expanded;$('weekly-sheet').classList.toggle('expanded',expanded)});
let touchY=null;
$('weekly-handle').addEventListener('touchstart',e=>{touchY=e.touches[0].clientY},{passive:true});
$('weekly-handle').addEventListener('touchend',e=>{if(touchY===null)return;const delta=e.changedTouches[0].clientY-touchY;touchY=null;if(delta>60){if(expanded){expanded=false;$('weekly-sheet').classList.remove('expanded')}else close()}else if(delta< -60){expanded=true;$('weekly-sheet').classList.add('expanded')}},{passive:true});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&activeDay>=0)close()});
window.SoraWeekly={update(){draw();refresh()},refresh,render:draw};
draw();refresh();
setInterval(()=>{if(document.visibilityState==='visible')refresh()},60000);
window.addEventListener('online',()=>refresh());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh()});
window.addEventListener('pageshow',()=>refresh());
})();