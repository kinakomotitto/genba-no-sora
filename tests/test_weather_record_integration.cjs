/* Exercise the actual weather-record handlers extracted from index.html.
   No browser/GPS/network. Records must survive missing forecasts. */
'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8');
const begin=html.indexOf("const wxLabels={");
const end=html.indexOf("document.querySelectorAll('[data-wx]')",begin);
assert(begin>0&&end>begin,'record block must exist in the actual app');
const source=html.slice(begin,end);
const stored={};
let calls=0;
const verification={status:'compared',reason:null,
  models:[{model:'jma_msm',label:'気象庁MSM',predicted:'rain',matched:true}]};
const now=new Date().toISOString();
const ctx={
 wxLogs:[],wxKey:'genbanosora.wxlogs.v1',
 selected:{kind:'current',name:'現在地'},lastGPS:{
    lat:40.7,lon:141.2,accuracy:23,at:now
 },
 getCoords(){return {lat:40.7,lon:141.2}},
 $(){return null},toast(){},
 localStorage:{setItem(key,val){stored[key]=val}},
 window:{SoraObservationCheck:{
    verify(entry,gps){calls++;assert.equal(entry.weather,'rain');
      assert.equal(gps.lat,40.7);return verification;},
    reasonText:{},summary(){return {comparedRecords:1,models:[]}}
 }},
 Date,Number,Math,console,Intl,
 document:{createElement(){return {}}}
};
vm.createContext(ctx);
vm.runInContext(source,ctx,{filename:'index-weather-record.js'});
vm.runInContext("recordWx('rain')",ctx);
assert.equal(calls,1);
let logs=JSON.parse(stored['genbanosora.wxlogs.v1']);
assert.equal(logs.length,1);
assert.equal(logs[0].weather,'rain');
assert.equal(logs[0].verification.status,'compared');
assert.equal(logs[0].verification.models[0].matched,true);
// Correction/duplicate tap within five minutes replaces one observation,
// not two independent successful predictions.
vm.runInContext("recordWx('rain')",ctx);
logs=JSON.parse(stored['genbanosora.wxlogs.v1']);
assert.equal(logs.length,1,'same location quick taps must not inflate sample count');
ctx.window.SoraObservationCheck.verify=()=>{throw Error('corrupted forecast cache')};
vm.runInContext("recordWx('sun')",ctx);
logs=JSON.parse(stored['genbanosora.wxlogs.v1']);
assert.equal(logs.length,1);
assert.equal(logs[0].weather,'sun');
assert.equal(logs[0].verification.status,'skipped');
assert.equal(logs[0].verification.reason,'verification_error');
console.log('PASS: real record button locally persists verifications and never drops observations on failure');
