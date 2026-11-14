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
    children:[],value:'',textContent:'',className:'',disabled:false,attrs:{},lastSubmit:null,
    classList:{
      add(v){cls.add(v)},remove(v){cls.delete(v)},contains(v){return cls.has(v)},
      toggle(v,force){const state=force===undefined?!cls.has(v):!!force;state?cls.add(v):cls.delete(v);return state}
    },
    addEventListener(event,fn){events[event]=fn},handlers:events,
    setAttribute(name,value){this.attrs[name]=value},removeAttribute(name){delete this.attrs[name]},
    requestSubmit(){this.lastSubmit=this.handlers.submit({preventDefault(){}});return this.lastSubmit},
    append(...nodes){this.children.push(...nodes)},
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
    window:{SoraArea:{clear(){calls.clears++}},SoraMunicipalities:{
      '2202':['青森県','弘前市'],
      '2201':['青森県','青森市'],
      '2206':['青森県','十和田市'],
      '4100':['宮城県','仙台市'],
      '1210':['北海道','函館市']
    }},
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
  // The real app opens on Home, so the stub must reflect that initial state.
  $('home').classList.add('active');
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
  // A real Japanese two-character short name often does not match the indexed
  // official municipal name, even when language=ja is selected.
  const short=environment();
  short.ctx.window.SoraMunicipalities={
    "2202":["青森県","弘前市"],
    "2203":["青森県","八戸市"],
  };
  assert.deepEqual(Array.from(short.ctx.personalSearchVariants('弘前')),['弘前','弘前市','弘前町','弘前村']);
  const attempted=[];
  short.setFetcher(async url=>{
    const name=new URL(url).searchParams.get('name');
    attempted.push(name);
    if(name==='弘前')return {ok:true,json:async()=>({results:[]})};
    if(name==='弘前市')return {ok:true,json:async()=>({results:[
      {name:'弘前市',latitude:40.6,longitude:140.4,admin1:'青森県',country:'日本'}
    ]})};
    throw Error('Unexpected extra geocoding request');
  });
  short.$('private-place-query').value='弘前';
  await short.$('private-place-form').handlers.submit({preventDefault(){}});
  assert.deepEqual(attempted,['弘前','弘前市'],'two-kanji fallback should use full official municipality');
  assert.equal(short.$('private-place-results').children.length,1);
  assert.match(short.$('private-place-status').textContent,/弘前市/);
  short.$('private-place-results').children[0].handlers.click();
  assert.equal(short.ctx.selected.kind,'private');
  assert.deepEqual(short.calls.weather,[[40.6,140.4]]);
  assert.deepEqual(Array.from(short.ctx.personalSearchVariants('Hirosaki')),['Hirosaki']);
  assert.deepEqual(Array.from(short.ctx.personalSearchVariants('十和田')),['十和田']);
  assert.equal(short.workSites.length,1,'short-name fallback must not change work locations');
  // Municipality suggestions are rendered from bundled GSI data, without
  // calling a weather/geocoding API for every input keystroke.
  const auto=environment();
  assert.equal(auto.ctx.personalMunicipalitySuggestions('弘').length,1);
  auto.$('private-place-query').value='弘';
  auto.$('private-place-query').handlers.input();
  assert.equal(auto.$('private-place-suggestions').children.length,1);
  assert.equal(auto.$('private-place-suggestions').children[0].children[0].textContent,'弘前市');
  assert.equal(auto.$('private-place-suggestions').children[0].children[1].textContent,'青森県');
  assert.equal(auto.$('private-place-query').attrs['aria-expanded'],'true');
  assert.deepEqual(auto.calls.fetch,[],'typing must never send data to geocoding service');
  auto.$('private-place-suggestions').children[0].handlers.click();
  await auto.$('private-place-form').lastSubmit;
  assert.equal(new URL(auto.calls.fetch[0]).searchParams.get('name'),'弘前市');
  assert.equal(auto.ctx.selected.kind,'private');
  assert.deepEqual(auto.calls.weather,[[40.6,140.4]],'verified prefecture should resolve the correct place in one tap');
  assert.equal(auto.$('private-place-query').attrs['aria-expanded'],'false');
  assert.equal(auto.$('private-place-suggestions').children.length,0);
  assert.equal(auto.workSites.length,1,'suggestions must not touch registered work sites');
  assert.equal(JSON.parse(stored.get('genbanosora.private-places.v1')).length,0,'suggestions do not auto-favorite');
  const ime=environment();
  ime.$('private-place-query').handlers.compositionstart();
  ime.$('private-place-query').value='十';
  ime.$('private-place-query').handlers.input();
  assert.equal(ime.$('private-place-suggestions').children.length,0,'IME composition must not show transient guesses');
  ime.$('private-place-query').handlers.compositionend();
  assert.equal(ime.$('private-place-suggestions').children.length,1);
  assert.equal(ime.$('private-place-suggestions').children[0].children[0].textContent,'十和田市');
  let prevented=0;
  ime.$('private-place-query').handlers.keydown({key:'ArrowDown',preventDefault(){prevented++}});
  assert.equal(ime.$('private-place-suggestions').children[0].attrs['aria-selected'],'true');
  ime.$('private-place-query').handlers.keydown({key:'Escape',preventDefault(){prevented++}});
  assert.equal(ime.$('private-place-suggestions').children.length,0);
  assert.equal(prevented,2);
  ime.$('private-place-query').value='弘前';
  ime.$('private-place-query').handlers.input();
  assert.equal(ime.$('private-place-suggestions').children.length,1);
  ime.$('private-place-query').handlers.keydown({key:'ArrowDown',preventDefault(){}});
  ime.$('private-place-query').handlers.keydown({key:'Enter',preventDefault(){}});
  await ime.$('private-place-form').lastSubmit;
  assert.equal(ime.ctx.selected.kind,'private');
  assert.equal(ime.ctx.selected.name,'弘前市');
  assert.deepEqual(Array.from(ime.ctx.personalMunicipalitySuggestions('ひろ')),[],
    'kana readings are not bundled; the iPhone IME handles kana-to-kanji');
  ime.$('private-place-query').value='';
  ime.$('private-place-query').handlers.input();
  assert.equal(ime.$('private-place-suggestions').children.length,0,'clearing input must clear suggestions');

  // 十和田市 exists in the bundled official municipality list but may be
  // absent from the Open-Meteo index. Never respond "not found" in that case:
  // show a plainly labeled, public Aomori Prefecture city hall reference.
  const towada=environment();
  const towadaQueries=[];
  towada.setFetcher(async url=>{
    towadaQueries.push(new URL(url).searchParams.get('name'));
    return {ok:true,json:async()=>({results:[]})};
  });
  towada.$('private-place-query').value='十和田市';
  await towada.$('private-place-form').handlers.submit({preventDefault(){}});
  assert.deepEqual(towadaQueries,['十和田市']);
  assert.equal(towada.$('private-place-results').children.length,1,
    'official Towada reference must be offered when public geocoder lacks the municipality');
  assert.equal(towada.$('private-place-results').children[0].children[0].textContent,'十和田市');
  assert.match(towada.$('private-place-results').children[0].children[1].textContent,
    /青森県.*十和田市役所付近/,'city hall fallback must never pretend to be an arbitrary point in the city');
  towada.$('private-place-results').children[0].handlers.click();
  assert.equal(towada.ctx.selected.kind,'private');
  assert.equal(towada.ctx.selected.name,'十和田市');
  assert.equal(towada.ctx.selected.lat,40.612703);
  assert.equal(towada.ctx.selected.lon,141.20591);
  assert.match(towada.ctx.selected.reference_label,/十和田市役所付近/);
  assert.deepEqual(towada.calls.weather,[[40.612703,141.20591]]);
  assert.match(towada.$('geo-status').textContent,/市内全域を代表する観測ではない/);
  assert.equal(towada.workSites.length,1,'no worksite registration side effects');
  towada.$('private-place-save').handlers.click();
  const persistedTowada=JSON.parse(stored.get('genbanosora.private-places.v1'));
  assert.equal(persistedTowada.length,1);
  assert.match(persistedTowada[0].reference_label,/市役所付近/,
    'favorite must keep the fact that its coordinate is a municipality reference');
  const reopenTowada=environment();
  reopenTowada.$('private-favorites-list').children[0].children[0].handlers.click();
  assert.match(reopenTowada.$('geo-status').textContent,/市役所付近/);
  assert.equal(reopenTowada.workSites.length,1);
  reopenTowada.$('private-favorites-list').children[0].children[1].handlers.click();

  // Selecting a GSI name from autocomplete must resolve through the same
  // fallback even if Open-Meteo has an unrelated name at that prefix.
  const pickTowada=environment();
  pickTowada.setFetcher(async()=>({ok:true,json:async()=>({results:[
    {name:'十和田湖',latitude:40.45,longitude:140.88,admin1:'青森県',country:'日本'}
  ]})}));
  pickTowada.$('private-place-query').value='十和田市';
  pickTowada.$('private-place-query').handlers.input();
  assert.equal(pickTowada.$('private-place-suggestions').children.length,1);
  pickTowada.$('private-place-suggestions').children[0].handlers.click();
  await pickTowada.$('private-place-form').lastSubmit;
  assert.equal(pickTowada.ctx.selected.name,'十和田市');
  assert.equal(pickTowada.ctx.selected.lat,40.612703);
  assert.match(pickTowada.ctx.selected.reference_label,/市役所付近/);

  // Never override a matching city/prefecture result that does exist
  // in the geocoder with the fallback city hall point.
  const foundTowada=environment();
  foundTowada.setFetcher(async()=>({ok:true,json:async()=>({results:[
    {name:'十和田市',latitude:40.6201,longitude:141.2101,
      admin1:'青森県',country:'日本',country_code:'JP'}
  ]})}));
  foundTowada.$('private-place-query').value='十和田市';
  await foundTowada.$('private-place-form').handlers.submit({preventDefault(){}});
  assert.equal(foundTowada.$('private-place-results').children.length,1);
  foundTowada.$('private-place-results').children[0].handlers.click();
  assert.equal(foundTowada.ctx.selected.lat,40.6201);
  assert.equal(foundTowada.ctx.selected.reference_label,'');

  const lake=environment();
  lake.setFetcher(async()=>({ok:true,json:async()=>({results:[]})}));
  lake.$('private-place-query').value='十和田湖';
  await lake.$('private-place-form').handlers.submit({preventDefault(){}});
  assert.equal(lake.$('private-place-results').children.length,0,
    'Towada Lake must not incorrectly resolve to Towada City Hall');

  console.log('PASS: private geocoding, disambiguation, weather, favorites persistence, removal, GPS return, radar guard, offline, no worksite mutation');
})().catch(e=>{console.error(e);process.exitCode=1;});
