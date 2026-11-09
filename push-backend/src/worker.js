import webpush from 'web-push';

// Trial backend for the personal daily weather-note reminder, NOT for safety alerts.
// Data stored on Cloudflare D1: browser push endpoint and cryptographic keys only.
// Private field coordinates, job names, observations and notes never enter this API.
const SITE_ORIGIN = 'https://kinakomotitto.github.io';
const DAILY_TITLE = '하늘';
const DAILY_BODY = '今日の現場のお天気はどう？☁️ タップして記録してね ♡';
const TEST_COOLDOWN_SECONDS = 120;
const MAX_TIMES = 3;

function reply(data, status=200, origin=SITE_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': origin,
      'vary': 'Origin',
      'x-content-type-options': 'nosniff',
    },
  });
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(n => n.toString(16).padStart(2,'0')).join('');
}
async function hash(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
function ready(env) {
  return !!(env.DB && env.VAPID_SUBJECT && env.VAPID_PUBLIC_KEY &&
    env.VAPID_PRIVATE_KEY && env.RATE_LIMIT_SALT);
}
function isBase64url(value, min=10, max=256) {
  return typeof value === 'string' && value.length >= min &&
    value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}
function isValidPushEndpoint(value) {
  if(typeof value !== 'string' || value.length > 2048) return false;
  try {
    const u = new URL(value);
    // Initial iPhone-only build. A narrow allowlist prevents arbitrary
    // outbound requests and makes a leaked public endpoint less useful.
    return u.protocol === 'https:' &&
      (u.hostname === 'push.apple.com' || u.hostname.endsWith('.push.apple.com')) &&
      u.username === '' && u.password === '';
  } catch (_) {
    return false;
  }
}
export function parseReminderTimes(times) {
  if(!Array.isArray(times) || times.length<1 || times.length>MAX_TIMES) return null;
  const unique=new Set();
  for(const value of times) {
    if(typeof value!=='string' || !/^\d{2}:\d{2}$/.test(value)) return null;
    const [hh,mm]=value.split(':').map(Number);
    if(hh<5 || hh>23 || mm>59 || mm%15!==0 || (hh===23&&mm>0)) return null;
    if(unique.has(value)) return null;
    unique.add(value);
  }
  return [...unique].sort();
}
function checkPayload(obj) {
  return obj && typeof obj === 'object' &&
    isValidPushEndpoint(obj.endpoint) &&
    isBase64url(obj.keys?.p256dh, 40, 160) &&
    isBase64url(obj.keys?.auth, 12, 80) &&
    isBase64url(obj.token, 40, 128);
}
async function parseSmallBody(request) {
  if(request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
    throw new Error('JSON required');
  }
  const content = await request.text();
  if(content.length > 4096) throw new Error('Body too large');
  return JSON.parse(content);
}
function setupVapid(env) {
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}
function subscription(row) {
  return { endpoint: row.endpoint, keys: {p256dh: row.p256dh, auth:row.auth} };
}
async function sendWeatherNote(row, env, tag) {
  setupVapid(env);
  return webpush.sendNotification(subscription(row),
    JSON.stringify({
      title: DAILY_TITLE, body: DAILY_BODY, tag,
      data: { kind: 'daily-weather-record' },
    }),
    {TTL: 3600, urgency:'normal'}
  );
}

async function subscribe(request, env) {
  let data;
  try { data=await parseSmallBody(request); }
  catch (_) { return reply({error:'Invalid request'},400); }
  if(!checkPayload(data)) return reply({error:'Invalid subscription'},400);
  const times=parseReminderTimes(data.times);
  if(!times)return reply({error:'Choose 1-3 valid times in 15-minute increments'},400);
  const ip=request.headers.get('cf-connecting-ip')||'unknown';
  const ipKey=await hash(env.RATE_LIMIT_SALT+':'+ip);
  const id=await hash(data.endpoint);
  const tokenHash=await hash(data.token);
  const existing=await env.DB.prepare(
    'SELECT token_hash FROM push_subscriptions WHERE id=?'
  ).bind(id).first();
  if(existing && existing.token_hash !== tokenHash) {
    return reply({error:'Subscription already owned'},409);
  }
  if(!existing) {
    const existingCount=await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM push_subscriptions WHERE ip_hash=? AND created_at>datetime('now','-1 day')"
    ).bind(ipKey).first();
    const totalCount=await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM push_subscriptions'
    ).first();
    if(Number(existingCount?.n)>=3 || Number(totalCount?.n)>=100) {
      return reply({error:'Trial subscription limit reached'},429);
    }
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,token_hash,ip_hash,schedule_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))"
    ).bind(id,data.endpoint,data.keys.p256dh,data.keys.auth,tokenHash,ipKey,JSON.stringify(times)).run();
  } else {
    await env.DB.prepare(
      "UPDATE push_subscriptions SET p256dh=?,auth=?,schedule_json=?,active=1,updated_at=datetime('now') WHERE id=? AND token_hash=?"
    ).bind(data.keys.p256dh,data.keys.auth,JSON.stringify(times),id,tokenHash).run();
  }
  return reply({ok:true,times,timeZone:'Asia/Tokyo'});
}

async function setPreferences(request, env) {
  let data;
  try { data=await parseSmallBody(request); }
  catch (_) { return reply({error:'Invalid request'},400); }
  if(!isValidPushEndpoint(data?.endpoint)||!isBase64url(data?.token,40,128)) {
    return reply({error:'Invalid subscription owner'},400);
  }
  const times=parseReminderTimes(data.times);
  if(!times)return reply({error:'Choose 1-3 valid times in 15-minute increments'},400);
  const updated=await env.DB.prepare(
    "UPDATE push_subscriptions SET schedule_json=?,updated_at=datetime('now') WHERE id=? AND token_hash=? AND active=1"
  ).bind(JSON.stringify(times),await hash(data.endpoint),await hash(data.token)).run();
  if(!updated.meta?.changes)return reply({error:'No active subscription'},404);
  return reply({ok:true,times,timeZone:'Asia/Tokyo'});
}

async function unsubscribe(request, env) {
  let data;
  try { data=await parseSmallBody(request); }
  catch (_) { return reply({error:'Invalid request'},400); }
  if(!isValidPushEndpoint(data?.endpoint)||!isBase64url(data?.token,40,128)) {
    return reply({error:'Invalid request'},400);
  }
  await env.DB.prepare(
    'DELETE FROM push_subscriptions WHERE id=? AND token_hash=?'
  ).bind(await hash(data.endpoint),await hash(data.token)).run();
  return reply({ok:true});
}

async function sendTest(request, env) {
  let data;
  try { data=await parseSmallBody(request); }
  catch (_) { return reply({error:'Invalid request'},400); }
  if(!isValidPushEndpoint(data?.endpoint)||!isBase64url(data?.token,40,128)) {
    return reply({error:'Invalid request'},400);
  }
  const id=await hash(data.endpoint),tokenHash=await hash(data.token);
  const row=await env.DB.prepare(
    'SELECT * FROM push_subscriptions WHERE id=? AND token_hash=? AND active=1'
  ).bind(id,tokenHash).first();
  if(!row) return reply({error:'No active subscription'},404);
  if(row.last_test_at) {
    const interval=(Date.now()-new Date(row.last_test_at+'Z').getTime())/1000;
    if(Number.isFinite(interval) && interval < TEST_COOLDOWN_SECONDS) {
      return reply({error:'Try again later'},429);
    }
  }
  await env.DB.prepare(
    "UPDATE push_subscriptions SET last_test_at=strftime('%Y-%m-%dT%H:%M:%S','now') WHERE id=?"
  ).bind(id).run();
  try {
    await sendWeatherNote(row,env,'weather-note-test');
    return reply({ok:true});
  } catch (e) {
    if(e?.statusCode === 404 || e?.statusCode === 410) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(id).run();
      return reply({error:'Subscription expired. Re-enable notifications.'},410);
    }
    return reply({error:'Push service unavailable'},502);
  }
}

async function sendDaily(env, scheduledTime) {
  if(!ready(env)) throw new Error('Worker secrets or D1 not configured');
  const date=new Date(scheduledTime+9*3600*1000);
  if(!Number.isFinite(date.getTime()))throw new Error('Invalid scheduled time');
  const dateJST=date.toISOString().slice(0,10);
  const timeJST=date.toISOString().slice(11,16);
  // Cron runs every 15 minutes once enabled; only chosen times match.
  const rows=await env.DB.prepare(
    "SELECT * FROM push_subscriptions WHERE active=1 ORDER BY created_at LIMIT 100"
  ).all();
  let sent=0,dead=0,failed=0,skipped=0;
  for(const row of rows.results||[]) {
    let times;
    try { times=parseReminderTimes(JSON.parse(row.schedule_json)); }
    catch (_) { times=null; }
    if(!times?.includes(timeJST))continue;
    // Reserve before delivery so concurrent retries do not duplicate.
    const reserved=await env.DB.prepare(
      "INSERT OR IGNORE INTO push_delivery_log (subscription_id,date_jst,time_jst) VALUES (?,?,?)"
    ).bind(row.id,dateJST,timeJST).run();
    if(!reserved.meta?.changes){skipped++;continue;}
    try {
      await sendWeatherNote(row,env,'weather-note-'+dateJST+'-'+timeJST);
      await env.DB.prepare(
        "UPDATE push_delivery_log SET status='sent' WHERE subscription_id=? AND date_jst=? AND time_jst=?"
      ).bind(row.id,dateJST,timeJST).run();
      sent++;
    } catch(e) {
      if(e?.statusCode===404||e?.statusCode===410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(row.id).run();
        dead++;
      } else {
        await env.DB.prepare(
          "UPDATE push_delivery_log SET status='failed' WHERE subscription_id=? AND date_jst=? AND time_jst=?"
        ).bind(row.id,dateJST,timeJST).run();
        failed++;
      }
    }
  }
  // Logs contain aggregate counts, no recipient details.
  console.log(JSON.stringify({task:'daily_weather_note',dateJST,timeJST,sent,dead,failed,skipped}));
  if(failed)throw new Error('Some push notifications could not be delivered');
}

export default {
  async fetch(request, env) {
    const path=new URL(request.url).pathname;
    const origin=request.headers.get('origin');
    if(origin && origin !== SITE_ORIGIN) return reply({error:'Origin not allowed'},403);
    if(request.method==='OPTIONS') {
      if(origin!==SITE_ORIGIN) return reply({error:'Origin not allowed'},403);
      return new Response(null,{status:204,headers:{
        'access-control-allow-origin':SITE_ORIGIN,
        'access-control-allow-methods':'GET,POST,OPTIONS',
        'access-control-allow-headers':'Content-Type',
        'access-control-max-age':'3600',
        vary:'Origin'
      }});
    }
    if(path==='/api/config' && request.method==='GET') {
      return reply({available:ready(env),publicKey:ready(env)?env.VAPID_PUBLIC_KEY:null,
        schedule:'user_selected',timeZone:'Asia/Tokyo',maxTimes:3,intervalMinutes:15});
    }
    if(path==='/health' && request.method==='GET') {
      return reply({status:ready(env)?'ready':'not_configured'});
    }
    if(request.method!=='POST' || !['/api/subscribe','/api/unsubscribe','/api/test','/api/preferences'].includes(path)) {
      return reply({error:'Not found'},404);
    }
    if(origin!==SITE_ORIGIN) return reply({error:'Origin required'},403);
    if(!ready(env)) return reply({error:'Service not configured'},503);
    try {
      if(path==='/api/subscribe') return await subscribe(request,env);
      if(path==='/api/unsubscribe') return await unsubscribe(request,env);
      if(path==='/api/preferences') return await setPreferences(request,env);
      return await sendTest(request,env);
    } catch(e) {
      // Do not print endpoint/key/token or raw exceptions.
      return reply({error:'Service error'},500);
    }
  },
  async scheduled(event,env,ctx) {
    ctx.waitUntil(sendDaily(env,event.scheduledTime));
  }
};
