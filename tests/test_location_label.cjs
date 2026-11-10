/* Offline synthetic verification; no real GPS, calls to GSI or weather API. */
'use strict';
const assert=require('node:assert/strict');
const area=require('../location-label.js');

function element(){
  const flags=new Set(['hidden']);
  return {
    textContent:'',title:'',
    classList:{
      toggle(key,truth){if(truth)flags.add(key);else flags.delete(key)},
      contains(key){return flags.has(key)}
    }
  };
}
function deferred(){
  let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej});
  return {promise,resolve,reject};
}
const values=new Map();
const store={
  getItem(key){return values.get(key)||null},
  setItem(key,value){values.set(key,value)}
};
const pos={lat:40.512345,lon:141.112345};
assert.equal(area.keyOf(pos.lat,pos.lon),'40.512,141.112');
assert.equal(area.keyOf(35,139.9),'35.000,139.900');
assert.equal(area.keyOf(0,0),null,'out of range should not call Japanese reverse geocoder');
assert.equal(area.normalize('  尻内町  '),'尻内町');
assert.equal(area.fromResponse({results:{muniCd:'02203',lv01Nm:'尻内町'}}),'尻内町');
assert.equal(area.fromResponse({results:null}),'');
assert.equal(area.fromResponse({results:{lv01Nm:'<malicious>'}}),'',
  'untrusted service text must never become HTML');

(async()=>{
  const view=element();let calls=[];
  const time=Date.parse('2026-11-11T00:00:00Z');
  const fetcher=async url=>{
    calls.push(url);
    return {ok:true,json:async()=>({results:{muniCd:'02203',lv01Nm:'尻内町'}})};
  };
  const widget=area.create({element:view,store,fetcher,online:()=>true,clock:()=>time});
  assert.equal(await widget.update(pos.lat,pos.lon),'尻内町');
  assert.equal(view.textContent,'尻内町');
  assert.equal(view.classList.contains('hidden'),false);
  assert.match(view.title,/国土地理院/);
  assert.equal(calls.length,1);
  assert.equal(new URL(calls[0]).hostname,'mreversegeocoder.gsi.go.jp');
  assert.equal(new URL(calls[0]).searchParams.get('lat'),'40.512');
  assert.equal(new URL(calls[0]).searchParams.get('lon'),'141.112');
  assert.ok(!calls[0].includes('現場'));
  assert.ok(!calls[0].includes('40.512345'),'never upload unrounded GPS');
  assert.equal(await widget.update(pos.lat,pos.lon),'尻内町');
  assert.equal(calls.length,1,'same location should not hammer API');
  widget.clear();
  assert.equal(view.textContent,'');
  assert.equal(view.classList.contains('hidden'),true);
  assert.equal(await widget.update(pos.lat,pos.lon),'尻内町');
  assert.equal(calls.length,1,'local short term cache');
  const offline=area.create({element:element(),store,fetcher:()=>{throw Error('must not fetch offline')},
    online:()=>false,clock:()=>time});
  assert.equal(await offline.update(pos.lat,pos.lon),'尻内町','cached area can be shown offline');

  const staleClock=time+24*3600000+100;
  const noNetwork=area.create({element:element(),store,fetcher:()=>{throw Error('network blocked')},
    online:()=>false,clock:()=>staleClock});
  assert.equal(await noNetwork.update(pos.lat,pos.lon),'','old cache cannot pretend to be current');

  const race=deferred();
  const lateView=element();
  const slow=area.create({
    element:lateView,store:{getItem(){return null},setItem(){}},
    fetcher:()=>race.promise,online:()=>true,clock:()=>time
  });
  const pending=slow.update(pos.lat,pos.lon);
  slow.clear(); // user switched from GPS to a saved site
  race.resolve({ok:true,json:async()=>({results:{lv01Nm:'古い町名'}})});
  await pending;
  assert.equal(lateView.textContent,'','late response must not repaint a cleared location');

  const missing=area.create({element:element(),store:{getItem(){return null},setItem(){}},
    fetcher:async()=>({ok:false}),online:()=>true,clock:()=>time});
  assert.equal(await missing.update(pos.lat,pos.lon),'','reverse-geocode failure is harmless');
  assert.equal(await missing.update(51,0),'','non-Japan position does not call Japan API');

  console.log('PASS: Japanese nearby label, rounded GPS, cache/offline, async race and fail-closed fallback');
})().catch(e=>{console.error(e);process.exitCode=1});
