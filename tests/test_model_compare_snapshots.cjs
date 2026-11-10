/* Offline simulation of model responses. Tests that visual sky codes are captured
   before weather-record taps, while existing wind/rain comparison still works. */
'use strict';
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync('model-comparison.js','utf8');
const files={};
const read=(name)=>Object.hasOwn(files,name)?files[name]:null;
const nodes=new Map();
function node(){
  return {textContent:'',children:[],attrs:{},classList:{
      add(){},remove(){}
    },replaceChildren(){this.children=[]},
    append(x){this.children.push(x)},
    setAttribute(name,v){this.attrs[name]=v},
    addEventListener(){}
  };
}
function get(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);}
const requests=[];
const hours=[new Date(Date.now()+11*3600000).toISOString().slice(0,13)+':00'];
async function fakeFetch(url){
  const parsed=new URL(url);
  const model=parsed.searchParams.get('models');
  const fields=parsed.searchParams.get('hourly').split(',');
  requests.push({model,fields});
  // Simulate ICON not accepting weather_code; old core forecast must survive.
  if(model==='icon_seamless'&&fields.includes('weather_code'))return {ok:false,status:400};
  return {ok:true,json:async()=>({hourly:{
    time:hours,wind_speed_10m:[4],wind_direction_10m:[180],
    precipitation:[3],weather_code:fields.includes('weather_code')?[61]:undefined,
    wind_gusts_10m:fields.includes('wind_gusts_10m')?[7]:undefined
  }})};
}
const ctx={window:{},document:{getElementById:get,createElement:node},
 navigator:{onLine:true},localStorage:{getItem:read,setItem(key,v){files[key]=v}},
 fetch:fakeFetch,URL,URLSearchParams,AbortController,
 setTimeout,clearTimeout,Date,Intl,console,Map,Set,Number,Math,Error};
vm.createContext(ctx);
vm.runInContext(source,ctx,{filename:'model-comparison.js'});
(async()=>{
  await ctx.window.SoraCompare.update(40.7,141.2);
  const history=JSON.parse(files['genbanosora.modelhistory.v1']);
  assert.equal(history.length,3,'three models must keep timestamped local history');
  for(const record of history){
    assert.equal(record.point[0],40.7);
    assert.equal(record.point[1],141.2);
    assert.equal(record.forecast[0].rain,3);
    assert.equal(record.forecast[0].wind,4);
    assert.ok(record.at.endsWith('Z'));
  }
  assert.equal(history.find(x=>x.model==='jma_msm').forecast[0].weatherCode,61);
  assert.equal(history.find(x=>x.model==='ecmwf_ifs').forecast[0].weatherCode,61);
  assert.equal(history.find(x=>x.model==='icon_seamless').forecast[0].weatherCode,null,
    'unavailable weather codes remain absent; do not fabricate classification');
  assert.ok(requests.some(x=>x.model==='icon_seamless'&&!x.fields.includes('weather_code')),
    'model without weather codes must retain existing wind/rain');
  assert.match(get('model-compare-status').textContent,/3\/3モデル取得/);
  console.log('PASS: forecast sky-code history, fallback wind/rain, no extra user data uploads');
})().catch(error=>{console.error(error);process.exitCode=1;});
