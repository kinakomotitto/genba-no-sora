/* Offline unit tests for persistent opt-in and fresh-GPS-on-foreground.
   No real geolocation, no Web Push subscription or Cloudflare network. */
'use strict';
const assert=require('node:assert/strict');
const auto=require('../weather-watch-auto.js');
const local=new Map();
const storage={getItem:k=>local.get(k)||null,setItem:(k,v)=>local.set(k,v),
  removeItem:k=>local.delete(k)};
const now=Date.parse('2026-11-11T07:00:00Z');
let time=now,permission='granted',online=true,visible=true,installed=true;
let gpsCalls=0,identityCalls=0,posts=[];
let fixAt=now;
let position={
  coords:{latitude:40.5212345,longitude:141.456789,accuracy:17},
  timestamp:fixAt
};
const gateway=auto.create({
  store:storage,clock:()=>time,permission:()=>permission,
  isInstalled:()=>installed,isVisible:()=>visible,isOnline:()=>online,
  getIdentity:async()=>{identityCalls++;return {endpoint:'https://web.push.apple.com/fiction',
    token:'x'.repeat(64)};},
  getPosition:async()=>{gpsCalls++;return position;},
  post:async (path,body)=>{posts.push({path,body});return {ok:true};}
});
function advance(ms){time+=ms;position={...position,timestamp:time};}
async function verify(){
  // No consent, so never query GPS, push permissions or subscription.
  assert.equal(gateway.enabled(),false);
  assert.deepEqual(await gateway.refresh(),{status:'not-consented'});
  assert.equal(gpsCalls,0);assert.equal(identityCalls,0);assert.equal(posts.length,0);

  // Consent set only by the one direct button flow after successful upload.
  assert.equal(gateway.activate(),true);
  assert.equal(storage.getItem(auto.CONSENT_KEY),'1');
  const first=await gateway.refresh();
  assert.deepEqual(first,{status:'refreshed'});
  assert.equal(gpsCalls,1);
  assert.equal(posts.length,1);
  assert.equal(posts[0].path,'/api/weather-watch-enable');
  assert.equal(posts[0].body.consent,true);
  assert.equal(posts[0].body.gps.lat,40.521);
  assert.equal(posts[0].body.gps.lon,141.457);
  assert.equal(posts[0].body.gps.accuracy,17);
  assert.equal(posts[0].body.gps.at,new Date(now).toISOString());
  assert.ok(!JSON.stringify(posts).includes('40.5212345'),
    'precise GPS must not be transmitted');
  assert.ok(!JSON.stringify(posts).includes('141.456789'),
    'precise GPS must not be transmitted');
  assert.ok(!JSON.stringify(posts).includes('site_name'));
  assert.ok(!JSON.stringify(posts).includes('notes'));

  // iOS visible and pageshow often fire together. Do not duplicate updates.
  assert.deepEqual(await gateway.refresh(),{status:'recent'});
  assert.equal(posts.length,1);

  // Reopening the app after the throttle should obtain a completely new GPS.
  advance(90*60000);
  position={coords:{latitude:39.278345,longitude:141.124321,accuracy:29},
    timestamp:time};
  assert.deepEqual(await gateway.refresh(),{status:'refreshed'});
  assert.equal(posts.length,2);
  assert.deepEqual(posts[1].body.gps,
    {lat:39.278,lon:141.124,accuracy:29,at:new Date(time).toISOString()});

  // Blocking conditions must not accidentally cause GPS or server updates.
  const count=posts.length;
  advance(20000);
  visible=false;
  assert.equal((await gateway.refresh()).status,'not-visible-pwa');
  visible=true;installed=false;
  assert.equal((await gateway.refresh()).status,'not-visible-pwa');
  installed=true;online=false;
  assert.equal((await gateway.refresh()).status,'offline');
  online=true;permission='denied';
  assert.equal((await gateway.refresh()).status,'notification-permission-needed');
  assert.equal(posts.length,count);
  permission='granted';

  // An inaccurate GPS fix must never be uploaded.
  position.coords.accuracy=401;
  assert.equal((await gateway.refresh()).status,'gps-unavailable');
  assert.equal(posts.length,count);
  advance(20000);
  position.coords.accuracy=29;
  position.timestamp=time-8*60000;
  assert.equal((await gateway.refresh()).status,'gps-unavailable');
  assert.equal(posts.length,count);

  // Explicit stop revokes consent even if the network is broken.
  assert.equal(gateway.deactivate(),null);
  assert.equal(local.has(auto.CONSENT_KEY),false);
  advance(20000);
  assert.equal((await gateway.refresh()).status,'not-consented');
  assert.equal(posts.length,count);

  // Pending GPS result after stop must never upload any location.
  let releaseGps;
  const delayed=auto.create({
    store:storage,clock:()=>time,permission:()=>permission,
    isInstalled:()=>true,isVisible:()=>true,isOnline:()=>true,
    getIdentity:async()=>({endpoint:'push',token:'own'}),
    getPosition:()=>new Promise(resolve=>{releaseGps=resolve}),
    post:async()=>{throw Error('Must never post a cancelled GPS');}
  });
  delayed.activate();
  const waiting=delayed.refresh();
  // Let microtasks advance so the GPS request starts.
  await Promise.resolve();await Promise.resolve();
  assert.equal(typeof releaseGps,'function');
  const inflight=delayed.deactivate();
  assert.ok(inflight);
  releaseGps({coords:{latitude:40.2,longitude:141.3,accuracy:10},timestamp:time});
  assert.equal((await waiting).status,'cancelled');
  assert.equal(delayed.enabled(),false);
  assert.equal((await delayed.refresh()).status,'not-consented');

  // Fresh instance after reload reads the persisted local consent, not auto
  // permission, but no consent was left after stop.
  assert.equal(gateway.enabled(),false);
  console.log('PASS: first-time consent, reopen GPS updates, rounded-only uploads, no silent prompt, offline and revocation race');
}
verify().catch(err=>{console.error(err);process.exitCode=1});
