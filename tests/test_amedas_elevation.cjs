/* Ground elevation must be opt-in, source-labeled and never a forecast correction.
   Simulated browser test — no live requests, no GPS or user data. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('amedas-nearby.js','utf8');
const html=fs.readFileSync('index.html','utf8');
for(const id of ['amedas-ground-height','amedas-station-height','amedas-height-difference',
  'amedas-ground-lookup','amedas-height-status']){
  assert.equal(html.split('id="'+id+'"').length-1,1,'missing or duplicated ID '+id);
}
assert.match(source,/cyberjapandata2\.gsi\.go\.jp\/general\/dem\/scripts\/getelevation\.php/);
assert.match(source,/api\.open-meteo\.com\/v1\/elevation/);
assert.match(source,/if\(!navigator\.onLine\)/);
assert.match(html,/標高差（地点−観測所）/);
const now=new Date(Math.floor(Date.now()/60000)*60000);
const stamp=new Date(now.getTime()+9*3600000).toISOString().slice(0,19)+'+09:00';
const catalog={example:{kjName:'標高14mの気温観測所',lat:[35,0],lon:[139,0],alt:14}};
const map={example:{temp:[10,0],wind:[2,0],precipitation1h:[0,0]}};
function elem(id){
  throw Error('Must build a test environment');
}
function build(provider,online=true){
  const nodes={},urls=[],services=[];
  function el(id){
    if(!nodes[id])nodes[id]={id,open:false,textContent:'',disabled:false,events:{},
      addEventListener(event,callback){this.events[event]=callback}};
    return nodes[id];
  }
  const navigator={onLine:online};
  async function fakeFetch(url,opts){
    const u=String(url);urls.push(u);
    if(u.endsWith('latest_time.txt'))return {ok:true,text:async()=>stamp};
    if(u.endsWith('amedastable.json'))return {ok:true,text:async()=>JSON.stringify(catalog)};
    if(u.includes('/data/map/'))return {ok:true,text:async()=>JSON.stringify(map)};
    services.push({url:u,options:opts});
    return await provider(u,opts);
  }
  const win={},context={document:{getElementById:el},window:win,navigator,fetch:fakeFetch,
    AbortController,URLSearchParams,Date,Math,JSON,Object,Number,String,Promise,setTimeout,clearTimeout};
  vm.runInNewContext(source,context,{filename:'amedas-nearby.js'});
  return {api:win.SoraAmedas,el,navigator,urls,services};
}
(async()=>{
  const gsi=build(async url=>{
    assert(url.includes('cyberjapandata2.gsi.go.jp'));
    assert.equal(new URL(url).searchParams.get('outtype'),'JSON');
    assert.equal(new URL(url).searchParams.get('lat'),'35.00000');
    return {ok:true,json:async()=>({elevation:108.6,hsrc:'5m（レーザ）'})};
  });
  gsi.api.setLocation(35,139);
  gsi.el('amedas-nearby').open=true;
  await gsi.api.refresh();
  assert.equal(gsi.el('amedas-station-height').textContent,'14m');
  assert.equal(gsi.el('amedas-ground-height').textContent,'—');
  assert.equal(gsi.services.length,0,'never transmit selected GPS to elevation API until button tap');
  assert.match(gsi.el('amedas-height-status').textContent,/標高を調べる/);
  await gsi.el('amedas-ground-lookup').events.click();
  assert.equal(gsi.services.length,1);
  assert.equal(gsi.el('amedas-ground-height').textContent,'109m');
  assert.equal(gsi.el('amedas-height-difference').textContent,'＋95m');
  assert.match(gsi.el('amedas-height-status').textContent,/国土地理院/);
  assert.match(gsi.el('amedas-height-status').textContent,/地形上の標高/);
  assert.equal(gsi.el('amedas-ground-lookup').disabled,false);
  gsi.api.setLocation(45,145);
  assert.equal(gsi.el('amedas-ground-height').textContent,'—','never display prior location elevation after switching');
  assert.equal(gsi.el('amedas-height-difference').textContent,'—');
  const fallback=build(async url=>{
    if(url.includes('getelevation.php'))return {ok:true,json:async()=>({elevation:'-----',hsrc:'-----'})};
    assert(url.includes('api.open-meteo.com/v1/elevation'),'fallback uses official 90m elevation API');
    return {ok:true,json:async()=>({elevation:[97.3]})};
  });
  fallback.api.setLocation(35,139);
  fallback.el('amedas-nearby').open=true;
  await fallback.api.refresh();
  await fallback.api.lookupGroundElevation();
  assert.equal(fallback.services.length,2);
  assert.equal(fallback.el('amedas-ground-height').textContent,'97m');
  assert.equal(fallback.el('amedas-height-difference').textContent,'＋83m');
  assert.match(fallback.el('amedas-height-status').textContent,/90m/,'must disclose lower-resolution source');
  const missing=build(async url=>{
    if(url.includes('getelevation.php'))return {ok:true,json:async()=>({elevation:'-----',hsrc:'-----'})};
    return {ok:true,json:async()=>({elevation:[null]})};
  });
  missing.api.setLocation(35,139);
  missing.el('amedas-nearby').open=true;
  await missing.api.refresh();
  await missing.api.lookupGroundElevation();
  assert.equal(missing.el('amedas-ground-height').textContent,'—');
  assert.equal(missing.el('amedas-height-difference').textContent,'—');
  assert.match(missing.el('amedas-height-status').textContent,/取得できなかった/);
  assert.equal(missing.el('amedas-ground-lookup').disabled,false);
  const offline=build(async()=>{throw Error('No requests allowed')},false);
  offline.api.setLocation(35,139);
  await offline.api.lookupGroundElevation();
  assert.equal(offline.services.length,0);
  assert.match(offline.el('amedas-height-status').textContent,/圏外/);
  let resolveOld;
  const delayed=build(async()=>new Promise(resolve=>{resolveOld=resolve}));
  delayed.api.setLocation(35,139);
  delayed.el('amedas-nearby').open=true;
  await delayed.api.refresh();
  const pending=delayed.api.lookupGroundElevation();
  delayed.api.setLocation(45,145);
  resolveOld({ok:true,json:async()=>({elevation:333,hsrc:'5m（レーザ）'})});
  await pending;
  assert.equal(delayed.el('amedas-ground-height').textContent,'—','late response from old GPS must be discarded');
  assert.equal(delayed.el('amedas-height-difference').textContent,'—');
  console.log('PASS: elevation only on tap, official and 90m fallback, source, station height, invalid/offline, stale GPS response');
})().catch(e=>{console.error(e);process.exitCode=1});
