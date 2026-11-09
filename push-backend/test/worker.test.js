import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ORIGIN = 'https://kinakomotitto.github.io';
const url = 'https://push-test.example';

test('health is never confused with deployed readiness', async () => {
  const res = await worker.fetch(new Request(url+'/health'), {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'not_configured');
});

test('config keeps VAPID key unavailable until server is configured', async () => {
  const res = await worker.fetch(new Request(url+'/api/config'), {});
  const obj = await res.json();
  assert.equal(obj.available, false);
  assert.equal(obj.publicKey, null);
  assert.equal(obj.schedule, '12:00');
  assert.equal(obj.timeZone, 'Asia/Tokyo');
});

test('allowlisted browser origin is the only allowed CORS origin', async () => {
  const allowed = await worker.fetch(
    new Request(url+'/api/config',{headers:{Origin:ORIGIN}}),{}
  );
  assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
  const blocked = await worker.fetch(
    new Request(url+'/api/config',{headers:{Origin:'https://evil.invalid'}}),{}
  );
  assert.equal(blocked.status,403);
  const preflight = await worker.fetch(
    new Request(url+'/api/subscribe',{method:'OPTIONS',
      headers:{Origin:ORIGIN,'Access-Control-Request-Method':'POST'}}),{}
  );
  assert.equal(preflight.status,204);
});

test('API rejects external or missing Origin and refuses unconfigured subscriptions', async () => {
  const data={endpoint:'https://web.push.apple.com/abc',token:'A'.repeat(64),
    keys:{p256dh:'B'.repeat(80),auth:'C'.repeat(20)}};
  const options={method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data)};
  const noOrigin=await worker.fetch(new Request(url+'/api/subscribe',options),{});
  assert.equal(noOrigin.status,403);
  const validOrigin=await worker.fetch(new Request(url+'/api/subscribe',{
    ...options,headers:{...options.headers,Origin:ORIGIN}
  }),{});
  assert.equal(validOrigin.status,503);
});

test('rejects non-Apple push endpoint before accessing D1 storage', async () => {
  const data={endpoint:'https://external.invalid/ssrf',
    token:'A'.repeat(64),keys:{p256dh:'B'.repeat(80),auth:'C'.repeat(20)}};
  const fakeEnv={
    DB:{},VAPID_SUBJECT:'mailto:placeholder@example.invalid',
    VAPID_PUBLIC_KEY:'fake-public-key',VAPID_PRIVATE_KEY:'fake-private-key',
    RATE_LIMIT_SALT:'fake-test-salt'
  };
  const res=await worker.fetch(new Request(url+'/api/subscribe',{
    method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},
    body:JSON.stringify(data)
  }),fakeEnv);
  assert.equal(res.status,400);
});
