'use strict';
/* Section 3 — the food side failing (the full timing run is run-kitchen.js). Each test states what should hold.
   node --test test/stress/repro/kitchen.repro.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startSite, request, host } = require('../../helpers');
const { faultable } = require('../lib/site');

// A stand-in for Resend that answers slowly (or never), to see what waits on email.
let mailDelay = 0; let mails = 0;
const resend = http.createServer((q, r) => { mails++; q.resume(); setTimeout(() => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"id":"x"}'); }, mailDelay); });
let ctx;
test.before(async () => { await new Promise((ok) => resend.listen(0, '127.0.0.1', ok)); });
ctx = startSite(test, { MEET_MODE: '1', DROP_RETRY_MS: '1000', RESEND_API_KEY: 're_test', MAIL_FROM: 'meets@meets.test', NODE_OPTIONS: `--require ${require.resolve('../lib/probe.js')}`, get FAKE_RESEND() { return `http://127.0.0.1:${resend.address().port}`; } });
test.after(() => resend.close());
const SITE = 'meets.test';
const req = (m, p, o = {}) => request(ctx, m, o.host || SITE, p, o);
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let C, F, meets = [];

test.before(async () => {
  F = faultable(ctx.kitchen); F.latency = 0;
  C = await host(ctx);
  for (let i = 0; i < 8; i++) { const r = await req('POST', '/api/host/meets', { cookie: C, body: { day: ymd(2 + i * 7), start: '19:00', end: '22:00', place: 'Lot' } }); meets.push(r.json.meet); }
  for (const m of meets) ctx.kitchen.state.meets[m.ref].vendors = [{ inviteId: 900 + m.id, status: 'in', slug: 'birria-bros', name: 'Birria Bros', cardReady: true }];
});
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return Object.assign(r, { ms: Date.now() - t }); };

test('one reply of the wrong shape ({"vendors": "nope"}) doesn’t take the meet pages down (FINDING if this fails)', async () => {
  F.mode = 'wrongshape';
  const r1 = await req('GET', new URL(meets[1].url).pathname);
  F.mode = 'ok';
  const r2 = await req('GET', new URL(meets[1].url).pathname); // the food side is fine again
  assert.deepEqual([r1.status, r2.status], [200, 200], 'meet page while the reply was malformed, and right after');
});

test('a 200 with a body that isn’t JSON is a failure, not a success with nothing in it (FINDING if this fails)', async () => {
  const k = await req('POST', '/api/host/kit/entry', { cookie: C, body: { kind: 'vendor', name: 'Garbled' } });
  F.mode = 'garbage';
  const inv = await req('POST', `/api/host/meets/${meets[0].id}/invite`, { cookie: C, body: {} });
  const link = await req('POST', `/api/host/meets/${meets[0].id}/send-link`, { cookie: C, body: { kitId: k.json.logo.id } });
  F.mode = 'ok';
  assert.ok(!/undefined/.test(inv.text), 'invite text: ' + (inv.json && inv.json.text));
  assert.notEqual(link.status, 500, 'send-link: ' + link.text);
});

test('an order’s copy here isn’t wiped by a bad reply (FINDING if this fails)', async () => {
  const sqlite3 = require('sqlite3');
  const sql = (q, p = []) => new Promise((ok) => { const d = new sqlite3.Database(ctx.dbFile); d.all(q, p, (e, r) => { d.close(); ok(r); }); });
  const tok = 'b'.repeat(24);
  await sql("INSERT INTO orders (token, meet_id, host_id, vendor_slug, vendor_name, ticket, status, payment, total, items_json, created_at, updated_at) VALUES (?, ?, 1, 'birria-bros', 'Birria Bros', 104, 'Paid', 'paid', 14, '[]', ?, ?)", [tok, meets[0].id, Date.now(), Date.now() - 10 * 60000]);
  F.mode = 'garbage';
  await req('GET', '/api/orders/' + tok);
  F.mode = 'ok';
  const row = (await sql('SELECT status, payment, ticket, total FROM orders WHERE token = ?', [tok]))[0];
  assert.deepEqual({ ...row }, { status: 'Paid', payment: 'paid', ticket: 104, total: 14 });
});

test('with the food side hung, a settings change answers within ~10 s (FINDING if this fails)', async () => {
  F.mode = 'hang'; F.hangMs = 30000;
  const r = await timed(() => req('PUT', '/api/host/settings', { cookie: C, body: { name: 'Tasty Tuesday 2' } }));
  F.mode = 'ok';
  assert.ok(r.ms < 12000, `took ${Math.round(r.ms / 1000)} s (one 10 s wait per upcoming meet, one after another)`);
});

test('deleting a vendor while the food side is down still takes it out of the meets (FINDING if this fails)', async () => {
  const k = await req('POST', '/api/host/kit/entry', { cookie: C, body: { kind: 'vendor', name: 'Leaving Truck' } });
  const link = await req('POST', `/api/host/meets/${meets[2].id}/send-link`, { cookie: C, body: { kitId: k.json.logo.id } });
  assert.equal(link.status, 201, link.text);
  F.mode = 'reset';
  await req('DELETE', `/api/host/kit/${k.json.logo.id}`, { cookie: C });
  F.mode = 'ok';
  await new Promise((r) => setTimeout(r, 1500));
  const still = Object.values(ctx.kitchen.state.meets).filter((m) => m.vendors.some((v) => v.name === 'Leaving Truck' && ['in', 'invited'].includes(v.status))).length;
  assert.equal(still, 0, `still invited in ${still} meet(s); nothing retries the drop later`);
});

test('menus through /meet/* give up when the food side hangs (FINDING if this fails)', async () => {
  F.mode = 'hang'; F.hangMs = 25000;
  const r = await timed(() => req('GET', `/meet/${meets[0].ref}/birria-bros/`));
  F.mode = 'ok';
  assert.ok(r.ms < 20000, `a menu request waited ${Math.round(r.ms / 1000)} s (the proxy has no timeout: it waits as long as the food side does)`);
});

test('signing up for alerts doesn’t wait on a slow email provider (FINDING if this fails)', async () => {
  mailDelay = 20000;
  const r = await timed(() => req('POST', '/api/alerts', { body: { host: 'tasty-tuesday', email: 'slowmail@example.com' } }));
  mailDelay = 0;
  assert.ok(r.ms < 5000, `the sign-up answered after ${Math.round(r.ms / 1000)} s (it waits for the email to be sent; no timeout on that call)`);
});

test('an update to 200 people on alerts answers quickly (FINDING if this fails)', async () => {
  const sqlite3 = require('sqlite3');
  const d = new sqlite3.Database(ctx.dbFile);
  await new Promise((ok) => d.serialize(() => { d.run('BEGIN'); for (let i = 0; i < 200; i++) d.run('INSERT INTO subscribers (host_id, email, token_hash, verified_at, created_at) VALUES (1, ?, ?, ?, ?)', [`fan${i}@example.com`, 'x' + i, Date.now(), Date.now()]); d.run('COMMIT', ok); }));
  d.close();
  mailDelay = 150; // a normal provider round trip
  const r = await timed(() => req('POST', '/api/host/updates', { cookie: C, body: { message: 'Moved to the north lot', toAlerts: true } }));
  mailDelay = 0;
  assert.equal(r.status, 200, r.text);
  assert.ok(r.ms < 5000, `the host waited ${Math.round(r.ms / 1000)} s for ${r.json && r.json.sent} emails sent one after another`);
});
