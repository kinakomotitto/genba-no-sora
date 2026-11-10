/* 現場の空 v0.38 — 目視の天気を事前保存した予報と端末内だけで照合。
   NEVER sends GPS, saved site names, observations or learned scores to a server.
   A manual visual note is NOT an instrument-grade measurement or a safety forecast. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.SoraObservationCheck=api;
})(typeof window==='undefined'?null:window,function(){
  'use strict';
  const STORE='genbanosora.modelhistory.v1';
  const MODELS=['jma_msm','ecmwf_ifs','icon_seamless'];
  const MODEL_LABELS={jma_msm:'気象庁MSM',ecmwf_ifs:'ECMWF',icon_seamless:'ICON'};
  const GPS_MAX_AGE_MS=15*60*1000;
  const GPS_MAX_ACCURACY_M=300;
  const MODEL_MAX_DISTANCE_M=700;
  const SITE_MAX_DISTANCE_M=500;
  const FORECAST_MAX_AGE_MS=24*3600*1000;
  const HOUR_MAX_OFFSET_MS=30*60*1000;
  const reasonText={
    gps_missing:'GPSがないため照合できません（記録は保存しました）',
    gps_old:'GPSの位置が古いため、照合は見送りました',
    gps_inaccurate:'GPSの精度が低いため、照合は見送りました',
    gps_mismatch:'記録地点と現在地が離れているため、照合は見送りました',
    no_preissued_forecast:'事前に保存した同じ地点・時刻の予報がなく、照合は見送りました',
    no_comparable_code:'晴れ・曇りの境目など、比較が曖昧なので採点しません',
    malformed_log:'日時や天気が不明なため照合できません'
  };
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const validCoord=p=>p&&finite(p.lat)&&finite(p.lon)&&
    p.lat>=-90&&p.lat<=90&&p.lon>=-180&&p.lon<=180;
  const stamp=s=>{
    if(typeof s!=='string')return null;
    const t=Date.parse(s);
    return Number.isFinite(t)?t:null;
  };
  function meters(a,b){
    if(!validCoord(a)||!validCoord(b))return Infinity;
    const rad=Math.PI/180;
    const deltaLat=(b.lat-a.lat)*rad,deltaLon=(b.lon-a.lon)*rad;
    const lat1=a.lat*rad,lat2=b.lat*rad;
    const x=Math.sin(deltaLat/2)**2+
      Math.cos(lat1)*Math.cos(lat2)*Math.sin(deltaLon/2)**2;
    return 12742000*Math.asin(Math.min(1,Math.sqrt(x)));
  }
  // Open-Meteo hourly times for model requests are Asia/Tokyo local.
  // A code is an instantaneous hourly estimate, unlike precipitation's
  // preceding-hour sum; never compare visual rain to that hourly total.
  function jstHour(s){
    if(typeof s!=='string')return null;
    const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?$/.exec(s);
    if(!m)return null;
    const parsed=Date.parse(m[1]+':00+09:00');
    return Number.isFinite(parsed)?parsed:null;
  }
  function category(code){
    if(!Number.isInteger(code))return null;
    if(code===0||code===1)return 'sun';
    if(code===3)return 'cloud';
    if([51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,97,99].includes(code))return 'rain';
    if([71,73,75,77,85,86].includes(code))return 'snow';
    // Code 2 is partly cloudy (sun OR cloud); fog (45/48) is not "cloud".
    return null;
  }
  function readHistory(storage){
    try{
      const raw=JSON.parse((storage||localStorage).getItem(STORE)||'[]');
      return Array.isArray(raw)?raw.filter(x=>x&&MODELS.includes(x.model)&&
        Array.isArray(x.point)&&Array.isArray(x.forecast)).slice(-180):[];
    }catch(_){return []}
  }
  function gpsIssue(entry,gps,at){
    if(!validCoord(gps)||!stamp(gps.at))return 'gps_missing';
    const gpsAge=at-stamp(gps.at);
    if(gpsAge<0||gpsAge>GPS_MAX_AGE_MS)return 'gps_old';
    if(!finite(gps.accuracy)||gps.accuracy<=0||gps.accuracy>GPS_MAX_ACCURACY_M)return 'gps_inaccurate';
    if(!validCoord(entry)||meters(gps,entry)>(entry.siteId?SITE_MAX_DISTANCE_M:MODEL_MAX_DISTANCE_M)){
      return 'gps_mismatch';
    }
    return null;
  }
  function snapshotClosest(record,at){
    const fetched=stamp(record.at);
    if(fetched===null||fetched>=at||at-fetched>FORECAST_MAX_AGE_MS)return null;
    let result=null;
    for(const hour of record.forecast){
      if(!hour||typeof hour!=='object')continue;
      const valid=jstHour(hour.time);
      if(valid===null||valid<fetched)continue;
      const offset=Math.abs(valid-at);
      if(offset>HOUR_MAX_OFFSET_MS)continue;
      const predicted=category(hour.weatherCode);
      if(!predicted)continue;
      if(!result||offset<result.offset){
        result={predicted,valid,offset,weatherCode:hour.weatherCode};
      }
    }
    return result;
  }
  function evaluate(entry,gps,history){
    const base={schema:1,status:'skipped',reason:'malformed_log',models:[],createdAt:entry?.at||null,
      note:'端末内の参考照合。天気予報の自動補正・公式観測には使用しません。'};
    const at=stamp(entry?.at);
    if(!at||!['sun','cloud','rain','snow'].includes(entry?.weather))return base;
    const issue=gpsIssue(entry,gps,at);
    if(issue)return {...base,reason:issue};
    const chosen=new Map();
    for(const record of Array.isArray(history)?history:[]){
      if(!record||!MODELS.includes(record.model)||!Array.isArray(record.point)||record.point.length!==2)continue;
      const pos={lat:record.point[0],lon:record.point[1]};
      if(meters(pos,gps)>MODEL_MAX_DISTANCE_M)continue;
      const closest=snapshotClosest(record,at);
      if(!closest)continue;
      const previously=chosen.get(record.model);
      if(!previously||stamp(record.at)>stamp(previously.fetchedAt)){
        chosen.set(record.model,{model:record.model,label:MODEL_LABELS[record.model],
          predicted:closest.predicted,observed:entry.weather,
          matched:closest.predicted===entry.weather,
          forecastAt:new Date(closest.valid).toISOString(),
          fetchedAt:record.at,offsetMinutes:Math.round(closest.offset/60000)});
      }
    }
    const models=MODELS.map(id=>chosen.get(id)).filter(Boolean);
    if(!models.length){
      const closeButAmbiguous=(Array.isArray(history)?history:[]).some(record=>{
        if(!record||!MODELS.includes(record.model)||!Array.isArray(record.point))return false;
        if(meters({lat:record.point[0],lon:record.point[1]},gps)>MODEL_MAX_DISTANCE_M)return false;
        const fetched=stamp(record.at);
        if(fetched===null||fetched>=at||at-fetched>FORECAST_MAX_AGE_MS)return false;
        return Array.isArray(record.forecast)&&record.forecast.some(h=>{
          const valid=jstHour(h?.time);
          return valid!==null&&valid>=fetched&&Math.abs(valid-at)<=HOUR_MAX_OFFSET_MS&&
            Number.isInteger(h?.weatherCode)&&category(h.weatherCode)===null;
        });
      });
      return {...base,reason:closeButAmbiguous?'no_comparable_code':'no_preissued_forecast'};
    }
    return {...base,status:'compared',reason:null,models};
  }
  function verify(entry,gps,storage){
    return evaluate(entry,gps,readHistory(storage));
  }
  function summary(logs){
    const data=Object.fromEntries(MODELS.map(model=>[model,{model,label:MODEL_LABELS[model],
      matched:0,compared:0,days:new Set()}]));
    let comparedRecords=0,skippedRecords=0;
    for(const log of Array.isArray(logs)?logs:[]){
      if(!log||!log.verification)continue; // never backfill old logs with hindsight
      const v=log.verification;
      if(v.status!=='compared'||!Array.isArray(v.models)){
        skippedRecords++;
        continue;
      }
      comparedRecords++;
      const day=stamp(log.at)!==null?new Date(log.at).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}):null;
      for(const result of v.models){
        if(!data[result.model]||typeof result.matched!=='boolean')continue;
        data[result.model].compared++;
        if(result.matched)data[result.model].matched++;
        if(day)data[result.model].days.add(day);
      }
    }
    return {
      comparedRecords,skippedRecords,
      models:MODELS.map(id=>({...data[id],independentDays:data[id].days.size,days:undefined}))
    };
  }
  return {evaluate,verify,summary,category,meters,jstHour,reasonText,MODEL_LABELS};
});
