/* Fully offline quality tests: only snapshots previously obtained by the app.
   Does not touch private user files, GPS network APIs, or Open-Meteo. */
'use strict';
const assert=require('node:assert/strict');
const v=require('../observation-verification.js');
const models=['jma_msm','ecmwf_ifs','icon_seamless'];
const at='2026-11-11T00:05:00.000Z'; // 09:05 JST
const gps={lat:40.7,lon:141.2,accuracy:24,at:'2026-11-11T00:00:00.000Z'};
const record={id:'1',at,weather:'rain',locationName:'現在地',
  siteId:null,lat:gps.lat,lon:gps.lon,kind:'manual_visual'};
const forecast=(model,code,opts={})=>({
  at:opts.fetchedAt||'2026-11-10T23:10:00.000Z',
  point:opts.point||[gps.lat,gps.lon],model,
  forecast:[{time:opts.time||'2026-11-11T09:00',wind:3,
    rain:opts.rain??2,weatherCode:code,direction:140}]
});
const full=[
  forecast(models[0],61),forecast(models[1],3),forecast(models[2],61)
];
const result=v.evaluate(record,gps,full);
assert.equal(result.status,'compared');
assert.deepEqual(result.models.map(x=>x.model),models);
assert.deepEqual(result.models.map(x=>x.matched),[true,false,true]);
assert.equal(result.models[0].forecastAt,'2026-11-11T00:00:00.000Z');
assert.equal(result.models[0].fetchedAt,'2026-11-10T23:10:00.000Z');
assert.equal(v.category(0),'sun');
assert.equal(v.category(1),'sun');
assert.equal(v.category(3),'cloud');
assert.equal(v.category(71),'snow');
assert.equal(v.category(95),'rain');
assert.equal(v.category(2),null,'partly cloudy is not strictly sun nor cloud');
assert.equal(v.category(45),null,'fog cannot count as cloud');
assert.equal(v.category(null),null,'null is not clear');
assert.equal(v.category('61'),null,'non-number is not a weather code');

const staleGps={...gps,at:'2026-11-10T23:30:00.000Z'};
assert.equal(v.evaluate(record,staleGps,full).reason,'gps_old');
assert.equal(v.evaluate(record,{...gps,accuracy:900},full).reason,'gps_inaccurate');
assert.equal(v.evaluate(record,null,full).reason,'gps_missing');
assert.equal(v.evaluate({...record,siteId:'saved-site',lat:40.8,lon:141.3},gps,full).reason,'gps_mismatch',
  'clicking a saved site from somewhere else must NOT train that site');

assert.equal(v.evaluate(record,gps,[forecast(models[0],61,
  {fetchedAt:'2026-11-11T00:06:00.000Z'})]).reason,'no_preissued_forecast',
  'a forecast fetched AFTER recording must never get credit');
assert.equal(v.evaluate(record,gps,[forecast(models[0],61,
  {fetchedAt:'2026-11-11T00:02:00.000Z'})]).reason,'no_preissued_forecast',
  'forecast collected after the TARGET hour must not be used retroactively');
assert.equal(v.evaluate(record,gps,[forecast(models[0],61,
  {time:'2026-11-11T11:00'})]).reason,'no_preissued_forecast',
  '2h apart is not an observation-hour match');
assert.equal(v.evaluate(record,gps,[forecast(models[0],61,
  {point:[41.3,141.2]})]).reason,'no_preissued_forecast',
  'a forecast for another area must not count');
assert.equal(v.evaluate(record,gps,[forecast(models[0],2)]).reason,'no_comparable_code');
assert.equal(v.evaluate(record,gps,[forecast(models[0],null,
  {rain:100})]).reason,'no_preissued_forecast',
  'one-hour precipitation must not be interpreted as visual rain');
assert.equal(v.evaluate(record,gps,[forecast(models[0],3,
  {rain:100})]).models[0].matched,false,
  'visual rain versus instantaneous overcast is still a mismatch, despite hourly total');

const older=[forecast(models[0],61,{fetchedAt:'2026-11-10T22:00:00.000Z'}),
  forecast(models[0],3,{fetchedAt:'2026-11-10T23:10:00.000Z'})];
assert.equal(v.evaluate(record,gps,older).models[0].predicted,'cloud',
  'a newer valid pre-observation snapshot takes priority');

const report=v.summary([
  {...record,verification:result},
  {...record,id:'prior',at:'2026-11-10T00:20:00Z',verification:result},
  {...record,id:'old-day',verification:undefined},
  {...record,id:'skipped',verification:{status:'skipped',reason:'gps_old',models:[]}},
]);
assert.equal(report.comparedRecords,2);
assert.equal(report.skippedRecords,1);
const msm=report.models.find(x=>x.model==='jma_msm');
assert.equal(msm.matched,2);
assert.equal(msm.compared,2);
assert.equal(msm.independentDays,2,'independent days cannot be replaced by hourly samples');

const stored={getItem(key){assert.equal(key,'genbanosora.modelhistory.v1');
  return JSON.stringify(full);}};
assert.equal(v.verify(record,gps,stored).status,'compared');
assert.equal(v.verify(record,gps,{getItem(){throw Error('Storage denied')}}).status,'skipped');
console.log('PASS: device-only exact-place pre-record weather-code verification, no hindsight or fake learning');
