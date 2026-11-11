import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validCurrentGps,evaluateForecast,forecastUrl,
  WATCH_HOURS,WATCH_COOLDOWN_MS,WATCH_GUST_MS,WATCH_TABLE_SQL
} from '../src/weather-watch.js';

const now=Date.parse('2026-11-11T06:00:00Z');
const gps={lat:40.521295,lon:141.458923,accuracy:24,at:new Date(now-10000).toISOString()};
test('only user-provided fresh accurate Japan GPS is accepted, rounded for external services',()=>{
  assert.deepEqual(validCurrentGps(gps,now),{lat:40.521,lon:141.459});
  assert.equal(validCurrentGps({...gps,accuracy:400},now),null);
  assert.equal(validCurrentGps({...gps,at:new Date(now-6*60*1000).toISOString()},now),null);
  assert.equal(validCurrentGps({...gps,lat:0,lon:0},now),null);
  assert.equal(validCurrentGps({...gps,at:new Date(now+100000).toISOString()},now),null);
  assert.equal(validCurrentGps({...gps,lat:NaN},now),null);
  assert.equal(validCurrentGps({...gps,at:'invalid'},now),null);
  assert.equal(validCurrentGps(undefined,now),null);
  const query=new URL(forecastUrl(40.521,141.459));
  assert.equal(query.hostname,'api.open-meteo.com');
  assert.equal(query.searchParams.get('latitude'),'40.521');
  assert.equal(query.searchParams.get('longitude'),'141.459');
  assert.equal(query.searchParams.get('forecast_minutely_15'),'9');
  assert.equal(query.searchParams.get('wind_speed_unit'),'ms');
  assert.match(WATCH_TABLE_SQL,/FOREIGN KEY/);
  assert.equal(WATCH_HOURS,4);
  assert.equal(WATCH_COOLDOWN_MS,7200000);
});
const grid=Object.fromEntries(['time','precipitation','wind_gusts_10m','weather_code'].map(x=>[x,[]]));
function forecast(samples){
  const result={time:[],precipitation:[],wind_gusts_10m:[],weather_code:[]};
  for(let i=0;i<samples.length;i++){
    const time=new Date(now+(i+1)*15*60000).toISOString().slice(0,16);
    result.time.push(time);
    result.precipitation.push(samples[i].rain??0);
    result.wind_gusts_10m.push(samples[i].gust??6);
    result.weather_code.push(samples[i].code??3);
  }
  return {minutely_15:result};
}
test('rain / wind / predicted thunderstorm are forecast possibilities, never official lightning strikes',()=>{
  const events=evaluateForecast(forecast([
    {rain:0.7,gust:3,code:61},
    {rain:0,gust:15.1,code:3},
    {rain:0,gust:0,code:95}
  ]),now);
  assert.deepEqual(events.map(x=>x.kind),['thunder','wind','rain']);
  assert.match(events[0].text,/雷雨の予報/);
  assert.match(events[0].text,/実際の落雷接近を検知した通知ではありません/);
  assert.match(events[1].text,/最大瞬間風速15m\/s/);
  assert.match(events[2].text,/正確な時刻は分かりません/);
});
test('no false positives from null, snow, 15-min exact timing or old weather codes',()=>{
  const none=evaluateForecast(forecast([
    {rain:0.1,gust:14.9,code:71},
    {rain:0.4,gust:13,code:99}
  ]),now);
  assert.deepEqual(none.map(x=>x.kind),['thunder']);
  assert.deepEqual(evaluateForecast({minutely_15:grid},now),[]);
  assert.deepEqual(evaluateForecast({minutely_15:{time:['bad'],precipitation:[1],
      wind_gusts_10m:[30],weather_code:[95]}},now),[]);
  assert.deepEqual(evaluateForecast(forecast([{rain:0.7,gust:20,code:95}]),
    now-24*60*60000),[],'cannot send alerts for forecasts outside the now+2h window');
  assert.deepEqual(evaluateForecast({minutely_15:{time:['2026-11-11T06:15'],
    precipitation:[null],wind_gusts_10m:[null],weather_code:[null]}},now),[]);
  assert.equal(WATCH_GUST_MS,15);
});
