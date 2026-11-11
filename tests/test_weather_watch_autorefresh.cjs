/* Offline regression for explicit first consent and automatic updates on opening.
   No actual GPS, app notification permissions or Cloudflare calls. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const start=html.indexOf("const weatherWatchAutoKey='genbanosora.weatherwatch.auto.v1';");
const end=html.indexOf('async function refreshWeatherWatchStatus(){',start);
const stopStart=html.indexOf('async function stopWeatherWatch(){',end);
const stopEnd=html.indexOf("$('weather-watch-enable').addEventListener",stopStart);
assert.ok(start>=0&&end>start&&stopStart>end&&stopEnd>stopStart,'extract live application functions');
assert.match(html,/表示版 v0\.42/);
assert.match(html,/document\.addEventListener\('visibilitychange'/);
assert.match(html,/rememberFreshGpsForWatch\(p\)/);
assert.match(html,/locate\(\{fresh:true\}\);\s*\}\)\(\);/);
assert.match(html,/if\(!setWatchAutoEnabled\(true\)\)/);
assert.match(html,/async function disableDailyPush\(\)\{\s*\/\/[^]*?setWatchAutoEnabled\(false\)/);
assert.match(html,/アプリを開く／戻るたび/);

function createEnvironment(sharedStore=new Map()){
  const inputs=new Map(),posts=[];
  const $=id=>{
    if(!inputs.has(id)){
      inputs.set(id,{
        textContent:'',classList:{remove(){},add(){},toggle(){},contains(){return false}}
      });
    }
    return inputs.get(id);
  };
  const state={
    store:sharedStore,posts,notice:'',permission:'granted',hidden:false,
    identity:{endpoint:'https://web.push.apple.com/mock',token:'abc'},
    block:null
  };
  const storage={
    getItem:k=>sharedStore.get(k)??null,
    setItem:(k,v)=>sharedStore.set(k,v),
    removeItem:k=>sharedStore.delete(k)
  };
  const scope={
    Date,Number,console,localStorage:storage,
    document:{get hidden(){return state.hidden}},
    Notification:{get permission(){return state.permission}},
    isInstalledPwa:()=>true,pushServiceOrigin:'https://mock.example',
    weatherWatchIdentity:async()=>state.identity,
    pushPost:async(path,data)=>{
      posts.push({path,data});
      if(state.block&&path==='/api/weather-watch-enable')await state.block;
      return {ok:true};
    },watchStatus:message=>{state.notice=message},watchLoading(){},$
  };
  const ctx=vm.createContext(scope);
  vm.runInContext(html.slice(start,end)+'\n'+html.slice(stopStart,stopEnd),ctx);
  return {ctx,state};
}
function run(env,src,p){
  env.ctx.point=p;return vm.runInContext(src,env.ctx);
}
function loc(lat=40.512345,lon=141.456789,at=Date.now()){
  return {lat,lon,accuracy:21,at:new Date(at).toISOString()};
}
async function settle(env){
  const promise=vm.runInContext('watchAutoInFlight',env.ctx);
  if(promise)await promise;
}
(async()=>{
  const sharedStore=new Map(),env=createEnvironment(sharedStore);
  const point=loc();
  assert.equal(vm.runInContext('watchAutoEnabled()',env.ctx),false);
  run(env,'rememberFreshGpsForWatch(point)',point);
  await settle(env);
  assert.equal(env.state.posts.length,0,'never upload GPS before first consent');
  assert.equal(vm.runInContext('setWatchAutoEnabled(true)',env.ctx),true);
  assert.equal(sharedStore.get('genbanosora.weatherwatch.auto.v1'),'on');
  run(env,'rememberFreshGpsForWatch(point)',point);
  await settle(env);
  assert.equal(env.state.posts.length,1,'post only after consent; state='+JSON.stringify({
    enabled:vm.runInContext('watchAutoEnabled()',env.ctx),
    valid:run(env,'watchValidFreshGps(point)',point),
    recent:vm.runInContext('watchRecentFreshGps?.lat',env.ctx),
    notice:env.state.notice,hidden:env.state.hidden
  }));
  assert.equal(env.state.posts[0].path,'/api/weather-watch-enable');
  assert.equal(env.state.posts[0].data.consent,true);
  assert.equal(env.state.posts[0].data.gps.lat,40.512);
  assert.equal(env.state.posts[0].data.gps.lon,141.457);
  assert.equal(env.state.posts[0].data.gps.accuracy,21);
  assert.equal(env.state.posts[0].data.endpoint,env.state.identity.endpoint);
  run(env,'rememberFreshGpsForWatch(point)',loc());
  await settle(env);
  assert.equal(env.state.posts.length,1,'revisiting same GPS quickly does not spam server');
  run(env,'rememberFreshGpsForWatch(point)',loc(40.624,141.571));
  await settle(env);
  assert.equal(env.state.posts.length,2,'new location updates even inside cooldown');
  const stale=loc(40.7,141.6,Date.now()-8*60000);
  run(env,'rememberFreshGpsForWatch(point)',stale);
  await settle(env);
  assert.equal(env.state.posts.length,2,'stale position cannot be uploaded');
  env.state.hidden=true;
  run(env,'rememberFreshGpsForWatch(point)',loc(40.9,141.8));
  await settle(env);
  assert.equal(env.state.posts.length,2,'hidden PWA does not silently GPS-upload');
  env.state.hidden=false;
  env.state.permission='denied';
  run(env,'rememberFreshGpsForWatch(point)',loc(41.0,141.9));
  await settle(env);
  assert.equal(env.state.posts.length,2,'no upload after notification permission revoked');
  env.state.permission='granted';
  await vm.runInContext('stopWeatherWatch()',env.ctx);
  assert.equal(vm.runInContext('watchAutoEnabled()',env.ctx),false);
  assert.equal(sharedStore.has('genbanosora.weatherwatch.auto.v1'),false);
  assert.equal(env.state.posts.at(-1).path,'/api/weather-watch-stop');
  run(env,'rememberFreshGpsForWatch(point)',loc(41.1,142.0));
  await settle(env);
  assert.equal(env.state.posts.at(-1).path,'/api/weather-watch-stop',
    'stop cancels all future app-open GPS uploads');

  // One-time flag persists across a reload but only after explicit consent.
  sharedStore.set('genbanosora.weatherwatch.auto.v1','on');
  const reopened=createEnvironment(sharedStore);
  run(reopened,'rememberFreshGpsForWatch(point)',loc(40.51,141.43));
  await settle(reopened);
  assert.equal(reopened.state.posts.length,1,
    'later app open automatically uploads fresh current GPS without a second tap');

  // Stop during an in-flight update: stop waits for the update and deletes it.
  let release;
  reopened.state.block=new Promise(resolve=>{release=resolve});
  run(reopened,'rememberFreshGpsForWatch(point)',loc(40.8,141.9));
  const pending=vm.runInContext('watchAutoInFlight',reopened.ctx);
  await Promise.resolve(); // getSubscription promise resolves, send starts
  const stopping=vm.runInContext('stopWeatherWatch()',reopened.ctx);
  assert.equal(vm.runInContext('watchAutoEnabled()',reopened.ctx),false);
  release();await pending;await stopping;
  assert.equal(reopened.state.posts.at(-1).path,'/api/weather-watch-stop',
    'stop request is ordered after any in-flight auto-update');

  console.log('PASS: initial consent, app-open automatic renewal, GPS privacy, expiry controls, stop and stop/update race');
})().catch(e=>{console.error(e);process.exitCode=1});
