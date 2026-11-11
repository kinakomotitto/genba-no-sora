/* 現場の空 v0.42 — opt-in weather watch foreground GPS sync.
   The consent flag is device-local. Never writes location or silently starts
   a subscription. The caller obtains FRESH GPS when the app is foregrounded. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root&&root.document){
    root.SoraWatchAuto=api.create({store:root.localStorage});
  }
})(typeof window==='undefined'?null:window,function(){
  'use strict';
  const KEY='genbanosora.weatherwatch.autorefresh.v1';
  const MIN_RETRY_MS=10000;
  const MAX_GPS_AGE_MS=5*60000;
  function freshGps(gps,now){
    if(!gps||typeof gps!=='object')return false;
    if(!Number.isFinite(gps.lat)||!Number.isFinite(gps.lon)||
       !Number.isFinite(gps.accuracy)||gps.accuracy<=0||gps.accuracy>300)return false;
    const at=Date.parse(gps.at);
    return typeof gps.at==='string'&&Number.isFinite(at)&&at<=now+30000&&
      now-at>=0&&now-at<=MAX_GPS_AGE_MS;
  }
  function create({store,now=()=>Date.now()}){
    let pending=null,pendingKey='',lastKey='',lastSuccessAt=0,generation=0;
    function isEnabled(){
      try{return store?.getItem(KEY)==='1'}catch(_){return false}
    }
    function setEnabled(enabled){
      ++generation;
      try{
        if(enabled)store?.setItem(KEY,'1');
        else store?.removeItem(KEY);
      }catch(_){}
      if(!enabled){lastKey='';lastSuccessAt=0}
      return isEnabled();
    }
    function drain(){
      return pending?pending.catch(()=>{}):Promise.resolve();
    }
    async function refresh(gps,send){
      if(!isEnabled()||typeof send!=='function'||!freshGps(gps,now()))return false;
      const key=gps.lat.toFixed(3)+','+gps.lon.toFixed(3);
      if(pending){
        if(pendingKey===key)return pending;
        await drain();
        if(!isEnabled())return false;
      }
      if(lastKey===key&&lastSuccessAt>0&&now()-lastSuccessAt<MIN_RETRY_MS)return false;
      const gen=generation;
      pendingKey=key;
      const running=(async()=>{
        if(!isEnabled()||gen!==generation)return false;
        await send(gps);
        if(gen!==generation||!isEnabled())return false;
        lastSuccessAt=now();lastKey=key;
        return true;
      })();
      pending=running;
      try{return await running}
      finally{
        if(pending===running){pending=null;pendingKey='';}
      }
    }
    return {isEnabled,setEnabled,refresh,drain};
  }
  return {KEY,create,freshGps};
});
