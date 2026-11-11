'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const code=fs.readFileSync('sw.js','utf8');
assert.match(code,/genba-no-sora-shell-v0\.41/);
const listeners={};let displayed=null,visited=null;
const listenersContext={
  self:{
    location:{origin:'https://kinakomotitto.github.io'},
    addEventListener(name,cb){listeners[name]=cb},
    registration:{
      scope:'https://kinakomotitto.github.io/genba-no-sora/',
      showNotification(title,options){displayed={title,options};return Promise.resolve()}
    },
    clients:{
      matchAll:async()=>[],
      openWindow:async target=>{visited=target}
    }
  },
  caches:{},URL,Promise,Response,console
};
vm.runInNewContext(code,listenersContext);
assert.ok(listeners.push&&listeners.notificationclick);
(async()=>{
  const forecast={
    data:{json:()=>({
      title:'하늘 · 天気の変化（参考予報）',
      body:'最後に登録した地点の参考予報：この先2時間に雨の予報。',
      data:{kind:'weather-watch'}
    })},
    waitUntil(p){this.promise=p}
  };
  listeners.push(forecast);await forecast.promise;
  assert.match(displayed.options.body,/雨の予報/);
  assert.equal(displayed.options.data.kind,'weather-watch');
  const clicked={
    notification:{data:{kind:'weather-watch'},close(){}},
    waitUntil(p){this.promise=p}
  };
  listeners.notificationclick(clicked);await clicked.promise;
  assert.equal(visited,'https://kinakomotitto.github.io/genba-no-sora/#home');
  const reminder={data:null,waitUntil(p){this.promise=p}};
  listeners.push(reminder);await reminder.promise;
  assert.match(displayed.options.body,/天気はどう/);
  assert.equal(displayed.options.data.kind,'daily-weather-record');
  console.log('PASS: dynamic weather-watch push and original daily reminder service-worker notification');
})().catch(err=>{console.error(err);process.exitCode=1});
