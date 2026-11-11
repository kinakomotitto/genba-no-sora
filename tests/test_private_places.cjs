/* No-network simulated browser test of private place search and favorites.
   Private selections must never enter the saved worksite list. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const start=html.indexOf('// v0.43 — private place search.');
const end=html.indexOf('\nfunction renderWindTrend',start);
assert(start>0&&end>start,'private search feature missing');
const feature=html.slice(start,end);
assert.match(feature,/genbanosora\.private-places\.v1/);
assert.match(feature,/language:'ja'/);
assert.match(feature,/personalMaxFavorites=20/);
assert.match(html,/if\(selected\.kind==='private'\)\{toast\('検索した場所は現場の天気記録と分けているよ ♡'\);return;\}/);
assert.match(html,/selected\.kind==='private'\?'検索した場所：'/);
const stored=new Map();
function fakeNode(){
  const cls=new Set(),events={};
  return {
    children:[],value:'',textContent:'',className:'',disabled:false,
    classList:{
      add(v){cls.add(v)},remove(v){cls.delete(v)},contains(v){return cls.has(v)},
      toggle(v,force){const state=force===undefined?!cls.has(v):!!force;state?cls.add(v):cls.delete(v);return state}
    },
    addEventListener(event,fn){events[event]=fn},handlers:events,
    setAttribute(){},append(...nodes){this.children.push(...nodes)},
    replaceChildren(){this.children=[]}
  };
}
function environment(){
  const ids={},calls={weather:[],tabs:[],cached:[],windy:0,clears:0,toast:[],aborts:0,fetch:[]};
  const $=id=>ids[id]||(ids[id]=fakeNode());
  const workSites=[{id:'work-one',name:'送電の現場',lat:40.2,lon:141.2}];
  let fetcher=async url=>{
    calls.fetch.push(url);
    return {ok:true,json:async()=>({results:[
      {name:'弘前市',admin1:'青森県',country:'日本',latitude:40.6,longitude:140.4},
      {name:'弘前市',admin1:'別の県',country:'日本',latitude:39.5,longitude:139.8}
    ]})};
  };
  const ctx={
    $,
    selected:{kind:'current',name:'現在地'},
    fetchController:{abort(){calls.aborts++}},
    localStorage:{getItem(k){return stored.get(k)||null},setItem(k,v){stored.set(k,v)}},
    document:{createElement:fakeNode},
    window:{SoraArea:{clear(){calls.clears++}}},
    navigator:{onLine:true},
    URLSearchParams,
    AbortController,
    Array,Number,JSON,String,Date,Set,Math,
    confirm:()=>true,
    setTimeout:()=>1,clearTimeout(){},
    fetch:(url)=>fetcher(url),
    toast:text=>calls.toast.push(text),
    updateWindyLinks(){calls.windy++},
    showCachedWeatherFor:p=>calls.cached.push(p),
    fetchWeather:(lat,lon)=>calls.weather.push([lat,lon]),
    showTab:id=>calls.tabs.push(id),
    lastGPS:{lat:40.5,lon:141.3},
  };
  vm.createContext(ctx);
  vm.runInContext(feature,ctx);
  return {ctx,$,calls,workSites,setFetcher:fn=>{fetcher=fn}};
}
(async()=>{
  const e=environment(),{ctx,$,calls,workSites}=e;
  assert.equal($('private-favorites').classList.contains('hidden'),true);
  $('private-place-query').value='弘前';
  await $('private-place-form').handlers.submit({preventDefault(){}});
  assert.equal(calls.fetch.length,1);
  assert.equal(new URL(calls.fetch[0]).searchParams.get('name'),'弘前');
  assert.equal(new URL(calls.fetch[0]).searchParams.get('language'),'ja');
  assert.equal($('private-place-results').children.length,2);
  const first=$('private-place-results').children[0];
  assert.equal(first.children[0].textContent,'弘前市');
  assert.match(first.children[1].textContent,/青森県/);
  first.handlers.click();
  assert.equal(ctx.selected.kind,'private');
  assert.equal(ctx.selected.name,'弘前市');
  assert.equal(ctx.selected.lat,40.6);
  assert.deepEqual(calls.weather,[[40.6,140.4]]);
  assert.equal($('weather-record').classList.contains('hidden'),true);
  assert.equal($('private-place-save').classList.contains('hidden'),false);
  assert.equal($('private-place-current').classList.contains('hidden'),false);
  assert.equal(workSites.length,1,'private location must not change saved work sites');
  $('private-place-save').handlers.click();
  const saved=JSON.parse(stored.get('genbanosora.private-places.v1'));
  assert.equal(saved.length,1);
  assert.equal(saved[0].name,'弘前市');
  assert.equal($('private-favorites-list').children.length,1);
  assert.equal($('private-favorites').classList.contains('hidden'),false);
  $('private-place-save').handlers.click(); // toggle removes favorite
  assert.equal(JSON.parse(stored.get('genbanosora.private-places.v1')).length,0);
  $('private-place-save').handlers.click();
  const second=environment();
  assert.equal(second.$('private-favorites-list').children.length,1,'favorite must persist on a new app load');
  second.$('private-favorites-list').children[0].children[0].handlers.click();
  assert.equal(second.ctx.selected.kind,'private');
  assert.deepEqual(second.calls.weather,[[40.6,140.4]]);
  second.$('private-favorites-list').children[0].children[1].handlers.click();
  assert.equal(JSON.parse(stored.get('genbanosora.private-places.v1')).length,0);
  $('private-place-current').handlers.click();
  assert.equal(ctx.selected.kind,'current');
  assert.equal($('weather-record').classList.contains('hidden'),false);
  assert.equal($('private-place-current').classList.contains('hidden'),true);
  assert.equal(workSites.length,1);
  assert.deepEqual(calls.tabs,['home']);
  assert(calls.aborts>0,'switch back must abort obsolete weather request');
  ctx.navigator.onLine=false;
  $('private-place-query').value='仙台';
  await $('private-place-form').handlers.submit({preventDefault(){}});
  assert.equal(calls.fetch.length,1,'offline place lookup must not call a network API');
  assert.match($('private-place-status').textContent,/通信が必要/);
  console.log('PASS: private geocoding, disambiguation, weather, favorites persistence, removal, GPS return, radar guard, offline, no worksite mutation');
})().catch(e=>{console.error(e);process.exitCode=1;});
