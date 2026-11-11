/* No network, no real GPS. Verify explicit initial consent, foreground renewal and revocation. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {create,freshGps,KEY}=require('../weather-watch-auto.js');
const values=new Map();
const store={
  getItem(k){return values.get(k)||null},
  setItem(k,v){values.set(k,v)},
  removeItem(k){values.delete(k)}
};
let clock=Date.parse('2026-11-11T06:00:00Z');
let n=0;
const source={
  lat:40.501239,lon:141.453673,accuracy:12,
  at:new Date(clock-500).toISOString()
};
(async()=>{
  const watch=create({store,now:()=>clock});
  assert.equal(watch.isEnabled(),false,'must be off by default, even with GPS');
  assert.equal(await watch.refresh(source,async()=>{n++}),false);
  assert.equal(n,0,'never upload GPS before explicit first tap');
  assert.equal(watch.setEnabled(true),true);
  assert.equal(store.getItem(KEY),'1','only the consent state is stored');
  assert.equal(await watch.refresh(source,async()=>{n++}),true);
  assert.equal(n,1,'foreground with a valid GPS sends once');
  assert.equal(await watch.refresh(source,async()=>{n++}),false);
  assert.equal(n,1,'two immediate foreground events should not double-send');

  clock+=15000;
  const next={...source,lat:40.504831,at:new Date(clock).toISOString()};
  assert.equal(await watch.refresh(next,async()=>{n++}),true,
    'a changed current location should update without a second button tap');
  assert.equal(n,2);
  assert.equal(await watch.refresh({...next,at:new Date(clock-6*60*1000).toISOString()},
    async()=>{n++}),false,'stale location cannot be uploaded');
  assert.equal(await watch.refresh({...next,accuracy:500},async()=>{n++}),
    false,'low accuracy prevents upload');
  assert.equal(n,2);

  let release;
  const delayed=new Promise(resolve=>{release=resolve});
  clock+=15000;
  const live={...source,at:new Date(clock).toISOString()};
  const pending=watch.refresh(live,async()=>{await delayed;n++});
  const concurrent=watch.refresh(live,async()=>{n++});
  watch.setEnabled(false);
  assert.equal(watch.isEnabled(),false);
  assert.equal(values.has(KEY),false);
  release();
  assert.equal(await pending,false,'consent revoked during an in-flight upload');
  assert.equal(await concurrent,false);
  assert.equal(n,3,'no second send while first in flight');
  await watch.drain();
  assert.equal(await watch.refresh(live,async()=>{n++}),false,
    'reopened app after stop never silently restarts monitoring');
  assert.equal(n,3);

  const reloaded=create({store,now:()=>clock});
  assert.equal(reloaded.isEnabled(),false,'stop persists across PWA relaunches');
  reloaded.setEnabled(true);
  assert.equal(create({store,now:()=>clock}).isEnabled(),true,
    'explicit consent persists across subsequent launches');
  assert.equal(freshGps({...source,at:'invalid'},clock),false);
  assert.equal(freshGps({...source,lat:NaN},clock),false);
  assert.equal(freshGps({...source,accuracy:301},clock),false);
  assert.equal(freshGps({...source,at:new Date(clock+100000).toISOString()},clock),false);
  assert.equal(freshGps({...source,at:new Date(clock).toISOString()},clock),true);

  const html=fs.readFileSync('index.html','utf8');
  const sw=fs.readFileSync('sw.js','utf8');
  assert.match(html,/表示版 v0\.42/);
  assert.match(sw,/genba-no-sora-shell-v0\.42/);
  assert.match(sw,/'\.\/weather-watch-auto\.js'/);
  assert.match(html,/src="\.\/weather-watch-auto\.js"/);
  assert.match(html,/setEnabled\(true\)/);
  assert.match(html,/setEnabled\(false\)/);
  assert.match(html,/document\.addEventListener\('visibilitychange'/);
  assert.match(html,/watchFreshPoint=p/);
  assert.ok(!html.includes('maybeAutoRefreshWeatherWatch(lastGPS)'),
    'cached GPS is never used to re-arm surveillance');
  assert.match(html,/weather-watch-auto\.js/);
  assert.match(html,/GPS座標を小数3桁に丸め/);
  assert.match(html,/Number\(gpsPoint\.lat\.toFixed\(3\)\)/);
  assert.match(html,/Notification\.permission!=='granted'/);
  console.log('PASS: first-tap consent, auto-foreground sync, 10s dedupe, never cached/stale GPS, persistent stop, safe disclosure');
})().catch(e=>{console.error(e);process.exitCode=1});
