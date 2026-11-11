/* 現場の空 v0.40 — two-line Japanese current location:
   prefecture + municipality on line 1, neighborhood on line 2.
   GSI reverse-geocoder receives GPS rounded to 3 decimals, and the
   nationwide official municipality-code map is bundled locally. */
(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root&&root.document)root.SoraArea=api.create({
    element:root.document.getElementById('current-area'),
    townElement:root.document.getElementById('current-area-town'),
    geoStatus:root.document.getElementById('geo-status'),
    municipalities:root.SoraMunicipalities||{},
    store:root.localStorage,
    fetcher:root.fetch.bind(root),
    online:()=>root.navigator.onLine,
  });
})(typeof window==='undefined'?null:window,function(){
  'use strict';
  const API='https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
  const CACHE_KEY='genbanosora.arealabel.v2';
  const TTL_MS=24*60*60*1000;
  function keyOf(lat,lon){
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||
       lat<20||lat>46.5||lon<122||lon>154)return null;
    return lat.toFixed(3)+','+lon.toFixed(3);
  }
  function normalize(name){
    if(typeof name!=='string')return '';
    const clean=name.normalize('NFKC').replace(/\s+/g,' ').trim();
    if(!clean||clean.length>60||/[<>]/.test(clean))return '';
    return clean;
  }
  function fromResponse(payload,municipalities){
    const response=payload?.results;
    const rawCode=response?.muniCd;
    if(typeof rawCode!=='string'||!/^\d{4,5}$/.test(rawCode))return null;
    // Official GSI lookup uses e.g. 2203 whereas the reverse API uses 02203.
    const code=String(Number(rawCode));
    const record=municipalities?.[code];
    if(!Array.isArray(record)||record.length!==2)return null;
    const prefecture=normalize(record[0]);
    const municipality=normalize(record[1]);
    if(!prefecture||!municipality)return null;
    const town=normalize(response?.lv01Nm);
    return {prefecture,municipality,town};
  }
  function create({element,townElement,geoStatus,municipalities={},store,fetcher,online,clock=()=>Date.now()}){
    let seq=0,lastKey='',lastValue=null;
    function paint(place){
      const valid=Boolean(place?.prefecture&&place?.municipality);
      if(element){
        const text=valid?place.prefecture+'・'+place.municipality:'';
        element.textContent=text;
        element.title=valid?'現在地付近：'+text+
          (place.town?' '+place.town:'')+'（国土地理院の参考地名）':'';
        element.classList.toggle('hidden',!valid);
      }
      if(townElement){
        townElement.textContent=valid?place.town||'':'';
        townElement.classList.toggle('hidden',!valid||!place.town);
      }
      // Preserve GPS coordinate / error status when area lookup is incomplete.
      // When available, show exactly two clean location lines.
      geoStatus?.classList.toggle('hidden',valid);
    }
    function clear(){
      ++seq;lastKey='';lastValue=null;paint(null);
    }
    function saved(key){
      try{
        const data=JSON.parse(store?.getItem(CACHE_KEY)||'null');
        if(data?.key!==key||!Number.isFinite(data.at)||
          clock()-data.at<0||clock()-data.at>=TTL_MS)return null;
        const place=data.place;
        if(!place||typeof place!=='object')return null;
        const prefecture=normalize(place.prefecture);
        const municipality=normalize(place.municipality);
        if(!prefecture||!municipality)return null;
        return {prefecture,municipality,town:normalize(place.town)};
      }catch(_){return null}
    }
    function persist(key,place){
      try{store?.setItem(CACHE_KEY,JSON.stringify({key,place,at:clock()}));}catch(_){}
    }
    async function update(lat,lon){
      const key=keyOf(lat,lon);
      if(!key){clear();return null;}
      const thisSeq=++seq;
      if(key===lastKey&&lastValue){paint(lastValue);return lastValue;}
      lastKey=key;lastValue=null;
      const cached=saved(key);
      if(cached){lastValue=cached;paint(cached);return cached;}
      paint(null);
      if(!online?.()||typeof fetcher!=='function')return null;
      try{
        const [y,x]=key.split(',');
        const url=API+'?lat='+encodeURIComponent(y)+'&lon='+encodeURIComponent(x);
        const response=await fetcher(url,{cache:'no-store',signal:AbortSignal.timeout(6500)});
        if(!response.ok)throw Error('geocoder unavailable');
        const place=fromResponse(await response.json(),municipalities);
        if(thisSeq!==seq)return null;
        if(place){lastValue=place;persist(key,place);paint(place);}
        return place;
      }catch(_){
        if(thisSeq===seq)paint(null);
        return null;
      }
    }
    return {update,clear};
  }
  return {create,keyOf,normalize,fromResponse};
});
