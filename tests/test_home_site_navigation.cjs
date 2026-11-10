/* Offline navigation tests, no browser dependency or geolocation access.
   Tests the actual navigation function source extracted from index.html. */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
function count(text){return html.split(text).length-1}
for(const id of ['weather-content','site-weather-detail','site-weather-host','sites-index',
  'site-detail-back','site-detail-name','radar-target-chip','selected-location']){
  assert.equal(count('id="'+id+'"'),1,'duplicate or missing '+id);
}
assert.match(html,/表示版 v0\.31/);
assert.match(html,/>現場一覧へ ›<\/button>/);
assert.match(html,/id="site-detail-back"/);
const homeStart=html.indexOf('<section id="home" class="page active">');
const radarStart=html.indexOf('<section id="radar" class="page"');
const sitesStart=html.indexOf('<section id="sites" class="page"');
const settingsStart=html.indexOf('<section id="settings" class="page');
assert(homeStart>0&&homeStart<radarStart&&radarStart<sitesStart&&sitesStart<settingsStart);
assert(html.indexOf('id="weather-content"')>homeStart&&html.indexOf('id="weather-content"')<radarStart);
assert(html.indexOf('id="site-weather-host"')>sitesStart&&html.indexOf('id="site-weather-host"')<settingsStart);
assert.match(html.slice(sitesStart,settingsStart),/id="sites-index"/);
assert.equal(count('id="refresh"'),1,'only one refresh control');
assert.equal(count('id="wind-trend-chart"'),1,'only one wind chart');
assert.equal(count('id="model-compare"'),1,'only one model comparison');
assert.equal(count('id="amedas-nearby"'),1,'only one AMeDAS panel');
const script=html.slice(html.indexOf('<script>\n(()=>{')+8,html.indexOf('</script>',html.indexOf('<script>\n(()=>{')));
new Function(script); // entire inlined app must remain valid JS
function node(id){
  const css=new Set(id==='home'?['active']:id==='sites-index'?[]:id==='site-weather-detail'?['hidden']:[]);
  return {
    id,children:[],parentElement:null,textContent:'',dataset:{tab:id},attrs:{},
    classList:{
      add(value){css.add(value)},remove(value){css.delete(value)},
      contains(value){return css.has(value)},
      toggle(value,forced){const b=forced===undefined?!css.has(value):Boolean(forced);
        if(b)css.add(value);else css.delete(value);return b}
    },
    append(child){
      if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(x=>x!==child);
      this.children.push(child);child.parentElement=this;
    },
    replaceChildren(){this.children=[]},
    setAttribute(name,value){this.attrs[name]=value}
  };
}
const ids=Object.create(null);
for(const id of ['home','sites','radar','settings','sites-index','site-weather-detail','site-weather-host','weather-content']){
  ids[id]=node(id);
}
ids.home.append(ids['weather-content']);
const pages=['home','radar','sites','settings'].map(id=>ids[id]);
const tabs=['home','radar','sites'].map(id=>node(id+'-tab'));
tabs.forEach((el,i)=>el.dataset.tab=['home','radar','sites'][i]);
let gpsRefreshes=0,modelsCleared=0,amedasCleared=0,radarRenders=0,siteRenders=0,modelPrepares=0;
let aborted=0;
const context={
 document:{getElementById(id){return ids[id]||(ids[id]=node(id))},
   querySelectorAll(selector){if(selector==='.page')return pages;if(selector==='.tab')return tabs;return[]}},
 window:{SoraCompare:{prepare(){modelPrepares++},clear(){modelsCleared++}},
   SoraAmedas:{setLocation(){},clear(){amedasCleared++}}},
 navigator:{onLine:false},cache:{},lastGPS:null,
 fetchController:{abort(){aborted++}},
 selected:{kind:'current',name:'現在地'},
 $:id=>ids[id]||(ids[id]=node(id)),
 keyFor:(lat,lon)=>lat+','+lon,renderWeather(){},
 updateWindyLinks(){},radarStop(){},renderRadar15h(){radarRenders++},
 renderSites(){siteRenders++},locate(options){assert.equal(options.fresh,true);gpsRefreshes++},
 fetchWeather(){throw Error('no network should be used in this offline test')},
 requestAnimationFrame(){},ensureRadarMap(){},scrollTo(){},
};
vm.createContext(context);
const start=html.indexOf('// v0.31: Move one existing weather dashboard;');
const end=html.indexOf('function gps(success,fail,options={}){',start);
assert(start>-1&&end>start);
vm.runInContext(html.slice(start,end),context);
const site={kind:'site',id:'abc',name:'試験用保存現場',lat:40.5,lon:141.4};
context.selectLoc(site);
assert.equal(context.selected.kind,'site');
assert.equal(ids['weather-content'].parentElement,ids['site-weather-host']);
assert.equal(ids['site-weather-detail'].classList.contains('hidden'),false);
assert.equal(ids['sites-index'].classList.contains('hidden'),true);
assert.equal(ids['site-detail-name'].textContent,site.name);
assert.equal(ids.home.classList.contains('active'),false);
assert.equal(ids.sites.classList.contains('active'),true);
context.showTab('radar');
assert.equal(radarRenders,1);
assert.match(ids['radar-target-chip'].textContent,/保存現場：試験用保存現場/);
context.showTab('home');
assert.equal(context.selected.kind,'current','home must reset location to GPS');
assert.equal(ids['selected-location'].textContent,'現在地');
assert.equal(ids['weather-content'].parentElement,ids.home);
assert.equal(ids['site-weather-detail'].classList.contains('hidden'),true);
assert.equal(ids.home.classList.contains('active'),true);
assert.equal(gpsRefreshes,1);
assert.equal(aborted,1,'inflight site request must be cancelled');
assert(modelsCleared>0&&amedasCleared>0,'missing GPS must clear old site values');
context.showTab('sites');
assert.equal(ids['sites-index'].classList.contains('hidden'),false);
assert.equal(ids['site-weather-detail'].classList.contains('hidden'),true);
assert(siteRenders>0);
context.selectLoc(site);
context.showTab('sites');
assert.equal(context.selected.kind,'current','opening Site list must not retain prior site');
assert.equal(ids['weather-content'].parentElement,ids.home);
context.showTab('radar');
assert.match(ids['radar-target-chip'].textContent,/現在地/);
assert(modelPrepares===0,'without GPS there should be no location-model fetch');
console.log('PASS: GPS Home, Site list, Site detail, Radar target, back, no stale observation or weather DOM');
