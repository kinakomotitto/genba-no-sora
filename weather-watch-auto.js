/* 現場の空 v0.42 — explicit persistent consent for refresh-on-app-open weather watch.
   No background location tracking: only runs when this PWA is visible.
   Never requests notification permission or creates a push subscription silently. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.SoraWatchAuto=api;
})(typeof window==='undefined'?null:window,function(){
  'use strict';
  const CONSENT_KEY='genbanosora.weatherwatch.auto.v1';
  const MIN_RECHECK_MS=10000;
  function validFix(position,now){
    const c=position?.coords;
    const at=position?.timestamp;
    if(!c||typeof at!=='number'||!Number.isFinite(at)||
      at>now+30000||now-at>5*60000)return null;
    const {latitude:lat,longitude:lon,accuracy}=c;
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||
      lat<24||lat>46||lon<123||lon>150||
      !Number.isFinite(accuracy)||accuracy<=0||accuracy>300)return null;
    return {lat:Number(lat.toFixed(3)),lon:Number(lon.toFixed(3)),
      accuracy,at:new Date(at).toISOString()};
  }
  function create({store,permission,isInstalled,isVisible,isOnline,
    getIdentity,getPosition,post,onStatus=()=>{},clock=()=>Date.now()}){
    let running=null,epoch=0,lastAttempt=0;
    function enabled(){
      try{return store?.getItem(CONSENT_KEY)==='1';}catch(_){return false;}
    }
    function activate(){
      try{store?.setItem(CONSENT_KEY,'1');}
      catch(_){return false;}
      ++epoch;lastAttempt=0;
      return true;
    }
    function deactivate(){
      // Stop future GPS uploads immediately, even if Cloudflare is offline.
      try{store?.removeItem(CONSENT_KEY);}catch(_){}
      ++epoch;lastAttempt=0;
      return running;
    }
    async function refresh(){
      if(!enabled())return {status:'not-consented'};
      if(running)return running;
      if(!isInstalled()||!isVisible())return {status:'not-visible-pwa'};
      if(!isOnline())return {status:'offline'};
      if(permission()!=='granted')return {status:'notification-permission-needed'};
      const at=clock();
      if(lastAttempt&&at-lastAttempt<MIN_RECHECK_MS)return {status:'recent'};
      lastAttempt=at;
      const runEpoch=epoch;
      const attempt=(async()=>{
        try{
          const identity=await getIdentity();
          if(!identity?.endpoint||!identity?.token)return {status:'subscription-missing'};
          if(!enabled()||epoch!==runEpoch||!isVisible())return {status:'cancelled'};
          const position=await getPosition();
          if(!enabled()||epoch!==runEpoch||!isVisible())return {status:'cancelled'};
          const gps=validFix(position,clock());
          if(!gps){
            onStatus({status:'gps-unavailable'});
            return {status:'gps-unavailable'};
          }
          // The only data transmitted is a fresh, deliberately rounded position
          // and the already-authorized private push identity.
          await post('/api/weather-watch-enable',{...identity,gps,consent:true});
          const status=epoch!==runEpoch?'cancelled':'refreshed';
          if(status==='refreshed')onStatus({status:'refreshed'});
          return {status};
        }catch(_){
          if(epoch!==runEpoch)return {status:'cancelled'};
          onStatus({status:'unavailable'});
          return {status:'unavailable'};
        }
      })();
      running=attempt;
      try{return await attempt;}
      finally{if(running===attempt)running=null;}
    }
    return {enabled,activate,deactivate,refresh,pending:()=>running};
  }
  return {CONSENT_KEY,MIN_RECHECK_MS,validFix,create};
});
