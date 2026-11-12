/* Test nearby JMA temperature against location forecast in a fake browser.
   No GPS access, no network, and no model correction. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('amedas-nearby.js','utf8');
const html=fs.readFileSync('index.html','utf8');
for(const id of ['amedas-temp-forecast','amedas-temp-observed','amedas-temp-difference',
  'amedas-temp-station','amedas-temp-note']){
  assert.equal(html.split('id="'+id+'"').length-1,1,'missing/duplicate temperature UI '+id);
}
assert.match(html,/SoraAmedas\?\.setForecast\?\.\(c,fetched,stale\)/);
assert.match(html,/SoraAmedas\?\.clearForecast\?\.\(\)/);
assert.match(html,/表示版 v0\.45\.1/);
assert.match(html,/src="\.\/amedas-nearby\.js\?v=0\.45\.1"/);
assert.match(html,/気温表示の更新がまだ反映されていないよ/);
assert.match(source,/valid\(obs\.temp\)/,'JMA temp quality must be checked');
const now=new Date(Math.floor(Date.now()/60000)*60000);
const japanStamp=new Date(now.getTime()+9*3600000).toISOString().slice(0,19)+'+09:00';
const catalog={
  'test1':{kjName:'近いが気温は欠測',lat:[35,0],lon:[139,0],alt:40},
  'test2':{kjName:'有効な気温観測所',lat:[35,5],lon:[139,5],alt:250}
};
let map={
  'test1':{temp:[99.9,6],wind:[3,0],precipitation1h:[0,0]},
  'test2':{temp:[10.0,0],wind:[2,0],precipitation1h:[0,0]}
};
const calls=[];
const responseFor=async url=>{
  calls.push(url);
  const value=url.endsWith('latest_time.txt')?japanStamp:
    url.endsWith('amedastable.json')?JSON.stringify(catalog):
    url.includes('/data/map/')?JSON.stringify(map):null;
  if(value===null)throw Error('Unexpected JMA fetch '+url);
  return {ok:true,text:async()=>value};
};
const nodes=new Map();
function elem(id){
  if(!nodes.has(id))nodes.set(id,{id,open:false,textContent:'',events:{},
    addEventListener(type,cb){this.events[type]=cb}});
  return nodes.get(id);
}
const context={
  document:{getElementById:elem},window:{},navigator:{onLine:true},
  fetch:responseFor,AbortController,Date,Math,JSON,Object,Number,String,Promise,
  setTimeout,clearTimeout
};
vm.runInNewContext(source,context,{filename:'amedas-nearby.js'});
const api=context.window.SoraAmedas;
assert(api&&api.setLocation&&api.setForecast&&api.clearForecast&&api.refresh&&api.clear);
(async()=>{
  // Dashboard intentionally compares the nearest *valid* temperature station,
  // not a nearer site with flagged/invalid temperature.
  elem('amedas-nearby').open=true;
  api.setLocation(35,139);
  api.setForecast({temperature_2m:13.2,time:japanStamp.slice(0,16)},new Date().toISOString(),false);
  await api.refresh();
  assert.equal(elem('amedas-temp-forecast').textContent,'13.2℃');
  assert.equal(elem('amedas-temp-observed').textContent,'10.0℃');
  assert.equal(elem('amedas-temp-difference').textContent,'＋3.2℃');
  assert.match(elem('amedas-temp-station').textContent,/有効な気温観測所/);
  assert.match(elem('amedas-temp-station').textContent,/標高250m/);
  assert.doesNotMatch(elem('amedas-temp-station').textContent,/近いが気温は欠測/);
  assert.match(elem('amedas-temp-note').textContent,/予報.*実測/);
  assert.match(elem('amedas-temp-note').textContent,/予報誤差とは断定できない/);
  assert(calls.some(x=>x.includes('/data/map/')));
  api.setForecast({temperature_2m:13.2,time:japanStamp.slice(0,16)},new Date().toISOString(),true);
  assert.equal(elem('amedas-temp-difference').textContent,'—','stale saved forecast is not comparable');
  assert.match(elem('amedas-temp-note').textContent,/最新ではない/);
  const twoHoursAgo=new Date(now.getTime()-2*3600000+9*3600000).toISOString().slice(0,16);
  api.setForecast({temperature_2m:13.2,time:twoHoursAgo},new Date().toISOString(),false);
  assert.equal(elem('amedas-temp-difference').textContent,'—','mismatched valid time must not compare');
  assert.match(elem('amedas-temp-note').textContent,/時刻が十分に近くない/);
  api.setForecast({temperature_2m:NaN,time:japanStamp.slice(0,16)},new Date().toISOString(),false);
  assert.equal(elem('amedas-temp-forecast').textContent,'—','invalid forecast is unavailable');
  assert.equal(elem('amedas-temp-difference').textContent,'—');
  // Switch GPS location: never carry over nearby temperature or forecast.
  api.setLocation(45,145);
  assert.equal(elem('amedas-temp-observed').textContent,'—');
  assert.equal(elem('amedas-temp-forecast').textContent,'—');
  assert.equal(elem('amedas-temp-difference').textContent,'—');
  api.setForecast({temperature_2m:3,time:japanStamp.slice(0,16)},new Date().toISOString(),false);
  await api.refresh();
  assert.equal(elem('amedas-temp-observed').textContent,'—','80km scope must be enforced');
  assert.equal(elem('amedas-temp-difference').textContent,'—');
  assert.match(elem('amedas-temp-note').textContent,/気温の観測値がない/);
  api.clear();
  assert.equal(elem('amedas-temp-observed').textContent,'—');
  assert.equal(elem('amedas-temp-forecast').textContent,'—');
  console.log('PASS: fresh time-aligned temperature reference; invalid quality, old forecast, mismatched time, distance and GPS switching safely guarded');
})().catch(e=>{console.error(e);process.exitCode=1;});
