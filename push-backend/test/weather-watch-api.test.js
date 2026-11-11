import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ORIGIN='https://kinakomotitto.github.io';
const base='https://push-test.example';
const endpoint='https://web.push.apple.com/mock-token';
const identity={endpoint,token:'a'.repeat(64)};
function fakeEnv(){
  const state={watch:null,createCount:0,removed:0,sql:[]};
  const db={prepare(sql){
    state.sql.push(sql);
    return {
      bind(...values){
        return {
          first:async()=>{
            if(sql.includes('FROM push_subscriptions'))return {id:'owned-test-sub'};
            if(sql.includes('FROM weather_watch'))return state.watch;
            return null;
          },
          run:async()=>{
            if(sql.includes('CREATE TABLE')){state.createCount++;return {meta:{changes:0}}}
            if(sql.includes('INSERT INTO weather_watch')){
              const [,latitude,longitude,updated_at,expires_at]=values;
              state.watch={latitude,longitude,updated_at,expires_at};
              return {meta:{changes:1}};
            }
            if(sql.includes('DELETE FROM weather_watch')){
              state.removed++;state.watch=null;return {meta:{changes:1}};
            }
            return {meta:{changes:0}};
          }
        };
      },
      run:async()=>{state.createCount++;return {meta:{changes:0}}}
    };
  }};
  return {state,env:{
    DB:db,VAPID_SUBJECT:'mailto:mock@example.invalid',VAPID_PUBLIC_KEY:'mock',
    VAPID_PRIVATE_KEY:'mock',RATE_LIMIT_SALT:'mock'
  }};
}
function post(path,body){
  return new Request(base+path,{method:'POST',headers:{
    Origin:ORIGIN,'Content-Type':'application/json'
  },body:JSON.stringify(body)});
}
test('explicit weather-watch consent required and fresh GPS only',async()=>{
  const {state,env}=fakeEnv();
  const now=Date.now();
  const gps={lat:40.5,lon:141.5,accuracy:15,at:new Date(now-1000).toISOString()};
  const noConsent=await worker.fetch(post('/api/weather-watch-enable',{...identity,gps}),env);
  assert.equal(noConsent.status,400);
  assert.equal(state.watch,null);
  const stale=await worker.fetch(post('/api/weather-watch-enable',{...identity,
    consent:true,gps:{...gps,at:new Date(now-20*60*1000).toISOString()}}),env);
  assert.equal(stale.status,400);
  assert.equal(state.watch,null);
  const ok=await worker.fetch(post('/api/weather-watch-enable',{...identity,
    consent:true,gps:{...gps,lat:40.512345,lon:141.456789}}),env);
  assert.equal(ok.status,200);
  assert.equal((await ok.json()).hours,4);
  assert.equal(state.watch.latitude,40.512);
  assert.equal(state.watch.longitude,141.457);
  assert.equal(state.watch.expires_at.endsWith('Z'),true);
  assert.ok(state.createCount>=1);
  assert.ok(!state.sql.some(sql=>/site_name|notes|wxLogs/.test(sql)));
  const status=await worker.fetch(post('/api/weather-watch-status',identity),env);
  assert.equal((await status.json()).active,true);
  const stop=await worker.fetch(post('/api/weather-watch-stop',identity),env);
  assert.equal(stop.status,200);
  assert.equal((await stop.json()).active,false);
  assert.equal(state.removed,1);
  assert.equal(state.watch,null);
});
test('watch endpoint cannot be triggered by cross-origin requests',async()=>{
  const {env}=fakeEnv();
  const req=new Request(base+'/api/weather-watch-enable',{
    method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},
    body:JSON.stringify({...identity,consent:true})
  });
  assert.equal((await worker.fetch(req,env)).status,403);
});
test('weather forecast watch stays unavailable when push secrets and D1 are absent',async()=>{
  const config=await worker.fetch(new Request(base+'/api/config'),{});
  assert.equal((await config.json()).weatherWatchAvailable,false);
  const res=await worker.fetch(post('/api/weather-watch-enable',identity),{});
  assert.equal(res.status,503);
});
