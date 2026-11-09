import webpush from 'web-push';

// Trial backend for the personal daily weather-note reminder, NOT for safety alerts.
// Data stored on Cloudflare D1: browser push endpoint and cryptographic keys only.
// Private field coordinates, job names, observations and notes never enter this API.
const SITE_ORIGIN = 'https://kinakomotitto.github.io';
const DAILY_TITLE = '하늘';
const DAILY_BODY = '今日の現場のお天気はどう？☁️ タップして記録してね ♡';
const TEST_COOLDOWN_SECONDS = 120;

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
      "INSERT INTO push_subscriptions (id,endpoint,p256dh,auth,token_hash,ip_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"
    ).bind(id,data.endpoint,data.keys.p256dh,data.keys.auth,tokenHash,ipKey).run();
  } else {
    await env.DB.prepare(
      "UPDATE push_subscriptions SET p256dh=?,auth=?,active=1,updated_at=datetime('now') WHERE id=? AND token_hash=?"
    ).bind(data.keys.p256dh,data.keys.auth,id,tokenHash).run();
  }
  return reply({ok:true,reminder:'daily 12:00 Asia/Tokyo'});
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
  const dateJST=new Date(scheduledTime+9*3600*1000).toISOString().slice(0,10);
  const rows=await env.DB.prepare(
    "SELECT * FROM push_subscriptions WHERE active=1 AND (last_sent_day IS NULL OR last_sent_day<>?) ORDER BY created_at LIMIT 100"
  ).bind(dateJST).all();
  let sent=0,dead=0,failed=0;
  for(const row of rows.results||[]) {
    try {
      await sendWeatherNote(row,env,'daily-weather-'+dateJST);
      await env.DB.prepare(
        "UPDATE push_subscriptions SET last_sent_day=? WHERE id=?"
      ).bind(dateJST,row.id).run();
      sent++;
    } catch(e) {
      if(e?.statusCode === 404 || e?.statusCode === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(row.id).run();
        dead++;
      } else {
        failed++;
      }
    }
  }
  // Deliberately log only counts, never endpoints, keys, or tokens.
  console.log(JSON.stringify({task:'daily_weather_note',dateJST,sent,dead,failed}));
  if(failed) throw new Error('Some push notifications could not be sent');
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
        schedule:'12:00',timeZone:'Asia/Tokyo'});
    }
    if(path==='/health' && request.method==='GET') {
      return reply({status:ready(env)?'ready':'not_configured'});
    }
    if(request.method!=='POST' || !['/api/subscribe','/api/unsubscribe','/api/test'].includes(path)) {
      return reply({error:'Not found'},404);
    }
    if(origin!==SITE_ORIGIN) return reply({error:'Origin required'},403);
    if(!ready(env)) return reply({error:'Service not configured'},503);
    try {
      if(path==='/api/subscribe') return await subscribe(request,env);
      if(path==='/api/unsubscribe') return await unsubscribe(request,env);
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
