/* Offline two-line GPS municipality-and-town tests.
   Official municipality data is bundled locally; no GPS, GSI or weather calls. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const area=require('../location-label.js');
const scope={window:{}};
vm.runInNewContext(fs.readFileSync('municipalities-gsi.js','utf8'),scope);
const municipalities=scope.window.SoraMunicipalities;
assert.ok(Object.keys(municipalities).length>=1800,'use nationwide GSI map, not hardcoded towns');
assert.deepEqual(Array.from(municipalities['2203']),['青森県','八戸市']);
assert.deepEqual(Array.from(municipalities['2408']),['青森県','東北町']);
assert.deepEqual(Array.from(municipalities['3206']),['岩手県','北上市']);
assert.deepEqual(Array.from(municipalities['1101']),['北海道','札幌市中央区']);
function element(){
  const flags=new Set(['hidden']);
  return {textContent:'',title:'',classList:{
    toggle(key,truth){if(truth)flags.add(key);else flags.delete(key)},
    contains(key){return flags.has(key)}
  }};
}
function deferred(){
  let resolve;
  const promise=new Promise(res=>{resolve=res});
  return {promise,resolve};
}
const values=new Map();
const store={getItem(key){return values.get(key)||null},setItem(key,value){values.set(key,value)}};
const pos={lat:40.512345,lon:141.112345};
assert.equal(area.keyOf(pos.lat,pos.lon),'40.512,141.112');
assert.equal(area.keyOf(35,139.9),'35.000,139.900');
assert.equal(area.keyOf(0,0),null,'outside Japan should not call GSI');
assert.equal(area.normalize('  尻内町  '),'尻内町');
const answer={results:{muniCd:'02203',lv01Nm:'尻内町'}};
const expected={prefecture:'青森県',municipality:'八戸市',town:'尻内町'};
assert.deepEqual(area.fromResponse(answer,municipalities),expected);
assert.deepEqual(area.fromResponse({results:{muniCd:'02408',lv01Nm:'字ガス平'}},municipalities),
  {prefecture:'青森県',municipality:'東北町',town:'字ガス平'});
assert.deepEqual(area.fromResponse({results:{muniCd:'03206'}},municipalities),
  {prefecture:'岩手県',municipality:'北上市',town:''});
assert.equal(area.fromResponse({results:null},municipalities),null);
assert.equal(area.fromResponse({results:{lv01Nm:'尻内町'}},municipalities),null,
  'no municipality code: never guess prefecture from town');
assert.equal(area.fromResponse({results:{muniCd:'99999',lv01Nm:'尻内町'}},municipalities),null,
  'unknown code: do not invent a city or prefecture');
assert.deepEqual(area.fromResponse({results:{muniCd:'02203',lv01Nm:'<malicious>'}},municipalities),
  {...expected,town:''},'untrusted street name must not be injected as HTML');

(async()=>{
  const view=element(),town=element(),gpsStatus=element();
  let calls=[];
  const time=Date.parse('2026-11-11T00:00:00Z');
  const fetcher=async url=>{
    calls.push(url);
    return {ok:true,json:async()=>answer};
  };
  const widget=area.create({element:view,townElement:town,geoStatus:gpsStatus,municipalities,
    store,fetcher,online:()=>true,clock:()=>time});
  assert.deepEqual(await widget.update(pos.lat,pos.lon),expected);
  assert.equal(view.textContent,'青森県・八戸市');
  assert.equal(town.textContent,'尻内町');
  assert.equal(view.classList.contains('hidden'),false);
  assert.equal(town.classList.contains('hidden'),false);
  assert.equal(gpsStatus.classList.contains('hidden'),true,
    'with a complete area label, the GPS coordinate debug line should be hidden');
  assert.match(view.title,/国土地理院/);
  assert.equal(calls.length,1);
  assert.equal(new URL(calls[0]).hostname,'mreversegeocoder.gsi.go.jp');
  assert.equal(new URL(calls[0]).searchParams.get('lat'),'40.512');
  assert.equal(new URL(calls[0]).searchParams.get('lon'),'141.112');
  assert.ok(!calls[0].includes('現場'));
  assert.ok(!calls[0].includes('40.512345'),'never upload precise GPS');
  assert.deepEqual(await widget.update(pos.lat,pos.lon),expected);
  assert.equal(calls.length,1,'same location never repeats API needlessly');
  widget.clear();
  assert.equal(view.textContent,'');
  assert.equal(town.textContent,'');
  assert.equal(view.classList.contains('hidden'),true);
  assert.equal(town.classList.contains('hidden'),true);
  assert.equal(gpsStatus.classList.contains('hidden'),false,
    'after GPS changes, the ordinary GPS status should be visible');
  assert.deepEqual(await widget.update(pos.lat,pos.lon),expected);
  assert.equal(calls.length,1,'the full two-line location is cached for 24h');
  const offline=area.create({element:element(),townElement:element(),municipalities,store,
    fetcher:()=>{throw Error('offline should not request')},online:()=>false,clock:()=>time});
  assert.deepEqual(await offline.update(pos.lat,pos.lon),expected,'both lines work offline from cache');

  const staleClock=time+24*3600000+100;
  const noNetwork=area.create({element:element(),townElement:element(),municipalities,store,
    fetcher:()=>{throw Error('network blocked')},online:()=>false,clock:()=>staleClock});
  assert.equal(await noNetwork.update(pos.lat,pos.lon),null,
    'expired cache should not show a false current address');

  const race=deferred(),lateView=element(),lateTown=element();
  const slow=area.create({element:lateView,townElement:lateTown,municipalities,
    store:{getItem(){return null},setItem(){}},fetcher:()=>race.promise,
    online:()=>true,clock:()=>time});
  const pending=slow.update(pos.lat,pos.lon);
  slow.clear(); // a saved jobsite or new GPS must not display an old location
  race.resolve({ok:true,json:async()=>({results:{muniCd:'02203',lv01Nm:'古い町名'}})});
  await pending;
  assert.equal(lateView.textContent,'');
  assert.equal(lateTown.textContent,'','late reverse lookups must not repaint stale town');

  const missing=area.create({element:element(),townElement:element(),municipalities,
    store:{getItem(){return null},setItem(){}},
    fetcher:async()=>({ok:false}),online:()=>true,clock:()=>time});
  assert.equal(await missing.update(pos.lat,pos.lon),null,'reverse API failure is harmless');
  assert.equal(await missing.update(51,0),null,'outside supported area fails closed');

  const cityOnlyView=element(),cityOnlyTown=element();
  const cityOnly=area.create({element:cityOnlyView,townElement:cityOnlyTown,municipalities,
    store:{getItem(){return null},setItem(){}},
    fetcher:async()=>({ok:true,json:async()=>({results:{muniCd:'03206'}})}),
    online:()=>true,clock:()=>time});
  assert.ok(await cityOnly.update(pos.lat,pos.lon));
  assert.equal(cityOnlyView.textContent,'岩手県・北上市');
  assert.equal(cityOnlyTown.classList.contains('hidden'),true);

  console.log('PASS: nationwide prefecture/municipality + town, no guessing, privacy, 24h cache, offline, race, failure safety');
})().catch(e=>{console.error(e);process.exitCode=1});
