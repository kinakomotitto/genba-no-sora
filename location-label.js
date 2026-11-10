/* 現場の空 v0.39 — short Japanese neighborhood by current GPS.
   GSI reverse-geocoding receives only coordinates rounded to 3 decimals
   (about 100 metres), not precise GPS, saved worksite names or notes.
   The lookup never blocks weather, GPS or offline viewing. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root&&root.document)root.SoraArea=api.create({
    element:root.document.getElementById('current-area'),
    store:root.localStorage,
    fetcher:root.fetch.bind(root),
    online:()=>root.navigator.onLine,
  });
})(typeof window==='undefined'?null:window,function(){
  'use strict';
  const API='https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
  const CACHE_KEY='genbanosora.arealabel.v1';
  const TTL_MS=24*60*60*1000;
  function keyOf(lat,lon){
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||
       lat<20||lat>46.5||lon<122||lon>154)return null;
    return lat.toFixed(3)+','+lon.toFixed(3);
  }
  function normalize(name){
    if(typeof name!=='string')return '';
    // GSI returns lv01Nm such as 尻内町 or 大字舂米.
    const clean=name.normalize('NFKC').replace(/\s+/g,' ').trim();
    if(!clean||clean.length>60||/[<>]/.test(clean))return '';
    return clean;
  }
  function fromResponse(payload){
    return normalize(payload?.results?.lv01Nm);
  }
  function create({element,store,fetcher,online,clock=()=>Date.now()}){
    let seq=0,lastKey='',lastValue='';
    function paint(name){
      if(!element)return;
      element.textContent=name;
      element.title=name?'現在地付近：'+name+'（国土地理院の参考地名）':'';
      element.classList.toggle('hidden',!name);
    }
    function clear(){
      ++seq;lastKey='';lastValue='';paint('');
    }
    function saved(key){
      try{
        const data=JSON.parse(store?.getItem(CACHE_KEY)||'null');
        if(data?.key===key&&typeof data.name==='string'&&
           Number.isFinite(data.at)&&clock()-data.at>=0&&clock()-data.at<TTL_MS){
          return normalize(data.name);
        }
      }catch(_){}
      return '';
    }
    function persist(key,name){
      try{store?.setItem(CACHE_KEY,JSON.stringify({key,name,at:clock()}));}catch(_){}
    }
    async function update(lat,lon){
      const key=keyOf(lat,lon);
      if(!key){clear();return '';}
      const thisSeq=++seq;
      if(key===lastKey&&lastValue){paint(lastValue);return lastValue;}
      lastKey=key;lastValue='';
      const cached=saved(key);
      if(cached){lastValue=cached;paint(cached);return cached;}
      paint('');
      if(!online?.()||typeof fetcher!=='function')return '';
      try{
        const [y,x]=key.split(',');
        const url=API+'?lat='+encodeURIComponent(y)+'&lon='+encodeURIComponent(x);
        // No automatic retry and no per-keystroke requests; one request per
        // successful GPS refresh. Never transmit saved sites or precise GPS.
        const response=await fetcher(url,{cache:'no-store',signal:AbortSignal.timeout(6500)});
        if(!response.ok)throw Error('geocoder unavailable');
        const label=fromResponse(await response.json());
        if(thisSeq!==seq)return '';
        if(label){lastValue=label;persist(key,label);paint(label);}
        return label;
      }catch(_){
        // Location label is optional; GPS or weather must always continue.
        if(thisSeq===seq)paint('');
        return '';
      }
    }
    return {update,clear};
  }
  return {create,keyOf,normalize,fromResponse};
});
