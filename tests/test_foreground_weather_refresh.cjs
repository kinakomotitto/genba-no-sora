/* Test persisted iPhone PWA session: old GPS/forecast vs online indicator.
   All tests run without native geolocation, network or browser. */
'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8');
const begin=html.indexOf('// v0.46.1 — refresh weather when a previously open iPhone PWA returns');
const end=html.indexOf('// v0.43 — private place search.',begin);
assert(begin>0&&end>begin,'foreground refresh implementation must exist');
const code=html.slice(begin,end);
assert.match(html,/window\.addEventListener\('pageshow',event=>\{if\(event\.persisted\)refreshForegroundWeather\(\)\}\)/);
assert.match(html,/document\.addEventListener\('visibilitychange',\(\)=>\{if\(document\.visibilityState==='visible'\)refreshForegroundWeather\(\)\}\)/);
assert.match(html,/if\(selected\.kind==='current'\)\{locate\(\{fresh:true\}\);return\}/,
  'manual weather refresh must reacquire current GPS');
assert.match(html,/GPSを更新できなかったよ · 前回の位置・予報/);
assert.match(html,/locate\(\{fresh:true\}\);\n\}\)\(\);/,'initial GPS acquisition must require fresh coordinates');
function create(kind='current'){
  const now=Date.now(),calls={gps:[],forecast:[],render:[],connection:0};
  const place={lat:35.23,lon:139.14};
  const context={
    selected:{kind,name:'test',...place},
    lastGPS:{...place,at:new Date(now-24*60*60*1000).toISOString()},
    cache:{'35.23,139.14':{data:{current:{}},fetched:new Date(now-24*60*60*1000).toISOString()}},
    document:{visibilityState:'visible'},
    navigator:{onLine:true},
    setConnection(){calls.connection++},
    getCoords(){return kind==='current'?this.lastGPS:place},
    keyFor:(lat,lon)=>lat+','+lon,
    renderWeather:(data,fetched,stale)=>calls.render.push({stale,fetched}),
    fetchWeather:(lat,lon)=>calls.forecast.push({lat,lon}),
    locate:opts=>calls.gps.push(opts),
    Date,
  };
  vm.createContext(context);
  vm.runInContext(code,context);
  return {context,calls,now,place};
}
function ageCheck(c){vm.runInContext('foregroundWeatherCheckedAt=Date.now()-11*60*1000',c)}
// Just restored an app that last fetched and geolocated yesterday.
{
  const {context,calls}=create();
  ageCheck(context);
  context.refreshForegroundWeather();
  assert.equal(calls.gps.length,1,'stale foreground GPS must reacquire rather than fetch old coords');
  assert.equal(calls.gps[0].fresh,true);
  assert.equal(calls.forecast.length,0);
  assert.equal(calls.render.length,1);
  assert.equal(calls.render[0].stale,true,'old forecast must explicitly appear as saved');
}
// Avoid extra GPS when both forecast and GPS are fresh.
{
  const {context,calls,now,place}=create();
  context.lastGPS={...place,at:new Date(now-5*60*1000).toISOString()};
  context.cache['35.23,139.14'].fetched=new Date(now-5*60*1000).toISOString();
  ageCheck(context);
  context.refreshForegroundWeather();
  assert.equal(calls.gps.length,0);
  assert.equal(calls.forecast.length,0);
  assert.equal(calls.render.length,0);
}
// A fresh GPS with stale forecast only refreshes weather, not GPS.
{
  const {context,calls,now,place}=create();
  context.lastGPS={...place,at:new Date(now-5*60*1000).toISOString()};
  ageCheck(context);
  context.refreshForegroundWeather();
  assert.equal(calls.gps.length,0);
  assert.deepEqual(calls.forecast,[place]);
  assert.equal(calls.render[0].stale,true);
}
// Private search weather must refresh the selected location, never switch to GPS.
{
  const {context,calls,place}=create('private');
  ageCheck(context);
  context.refreshForegroundWeather();
  assert.deepEqual(calls.forecast,[place]);
  assert.equal(calls.gps.length,0);
}
// Regaining network always tries again, including with fresh-enough timestamps.
{
  const {context,calls,now,place}=create();
  context.lastGPS={...place,at:new Date(now-5*60*1000).toISOString()};
  context.cache['35.23,139.14'].fetched=new Date(now-5*60*1000).toISOString();
  context.refreshForegroundWeather('online');
  assert.deepEqual(calls.forecast,[place]);
  assert.equal(calls.gps.length,0);
}
// In background, offline and repeated wakeups do not burn battery or send GPS.
{
  const {context,calls}=create();
  context.document.visibilityState='hidden';
  ageCheck(context);
  context.refreshForegroundWeather();
  assert.equal(calls.gps.length,0);
  context.document.visibilityState='visible';
  context.navigator.onLine=false;
  context.refreshForegroundWeather();
  assert.equal(calls.connection,1);
  assert.equal(calls.gps.length,0);
  context.navigator.onLine=true;
  context.refreshForegroundWeather();
  context.refreshForegroundWeather();
  assert.equal(calls.gps.length,1,'only one GPS refresh within throttle window');
}
console.log('PASS: foreground wakeup restores stale forecast honestly, refreshes old GPS and avoids extra GPS for recent locations');
