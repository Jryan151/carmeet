'use strict';
/* The fixes from the Fuel Friday run-through: a vendor sent a link shows under Food right away; a deleted vendor is
   gone everywhere (and doesn't come back from an old invite); each meet name has its own address, two meets can share
   a night; saved locations carry a parking layout; the password sign-in. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startSite, request, host } = require('./helpers');

const ctx = startSite(test, { VENDOR_SUBDOMAINS: '1', DEMO_PASSWORD: 'azmonarchy', DEMO_HOST: 'tasty-tuesday' });
const SITE = 'meets.test';
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const k = () => ctx.kitchen.state;
let C, tt, ff, day;
const LOT = { lat: 33.5824, lng: -112.1699, zoom: 18, address: '5112 W Peoria Ave', zones: [{ kind: 'club', label: 'Unforsaken', pts: [{ lat: 33.5826, lng: -112.17 }, { lat: 33.5826, lng: -112.1698 }, { lat: 33.5824, lng: -112.1698 }] }], pins: [] };

test.before(async () => { C = await host(ctx); day = ymd(5); });

test('each meet name has its own address; two meets can share a night, the same one can’t', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day, start: '19:00', end: '22:00', place: 'Dunlap lot' } });
  assert.equal(r.status, 201, r.text); tt = r.json.meet;
  assert.equal(tt.pageName, 'tasty-tuesday', 'no title: the host’s name');
  r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day, start: '19:00', end: '23:00', place: 'LV Smoke Shop lot', title: 'Fuel Friday' } });
  assert.equal(r.status, 201, r.text); ff = r.json.meet;
  assert.equal(ff.pageName, 'fuel-friday');
  assert.equal(ff.url, `http://fuel-friday.meets.test/${day}`);
  r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day, start: '19:00', end: '23:00', place: 'Again', title: 'fuel friday' } });
  assert.equal(r.status, 409);
  // Its own address shows it; the host's page doesn't, and its old link forwards.
  r = await request(ctx, 'GET', 'fuel-friday.meets.test', '/');
  assert.equal(r.status, 200); assert.match(r.text, /LV Smoke Shop lot/); assert.doesNotMatch(r.text, /Dunlap lot/);
  r = await request(ctx, 'GET', 'fuel-friday.meets.test', '/' + day);
  assert.match(r.text, /LV Smoke Shop lot/);
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday');
  assert.match(r.text, /Dunlap lot/); assert.doesNotMatch(r.text, /LV Smoke Shop lot/);
  r = await request(ctx, 'GET', SITE, `/tasty-tuesday/${day}`);
  assert.equal(r.headers.location, `http://tasty-tuesday.meets.test/${day}`, 'that night’s link: their own meet, at its address');
  r = await request(ctx, 'GET', 'tasty-tuesday.meets.test', '/' + day);
  assert.match(r.text, /Dunlap lot/); assert.doesNotMatch(r.text, /LV Smoke Shop lot/);
  r = await request(ctx, 'GET', 'fuel-friday.meets.test', '/host');
  assert.equal(r.status, 302, 'the portal is on the main address');
  // Changing it: checked, then the new address works.
  r = await request(ctx, 'PUT', SITE, `/api/host/meets/${ff.id}`, { cookie: C, body: { day, start: '19:00', end: '23:00', place: 'LV Smoke Shop lot', title: 'Fuel Friday', pageName: 'host' } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'PUT', SITE, `/api/host/meets/${ff.id}`, { cookie: C, body: { day, start: '19:00', end: '23:00', place: 'LV Smoke Shop lot', title: 'Fuel Friday', pageName: 'fuelfriday' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.meet.url, `http://fuelfriday.meets.test/${day}`);
  // Repeat next week keeps the name.
  r = await request(ctx, 'POST', SITE, `/api/host/meets/${ff.id}/again`, { cookie: C });
  assert.equal(r.json.meet.pageName, 'fuelfriday');
  // Caddy may get a certificate for it.
  r = await request(ctx, 'GET', SITE, '/caddy/ask?domain=fuelfriday.meets.test');
  assert.equal(r.status, 200);
});

test('a vendor sent their link shows under Food right away; deleted, it’s gone everywhere and stays gone', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), 'v.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xc04040:s=90x90', '-frames:v', '1', f]);
  let r = await request(ctx, 'POST', SITE, '/api/host/kit?kind=vendor&name=' + encodeURIComponent('México en un Vaso'), { cookie: C, raw: { buf: fs.readFileSync(f), type: 'image/png' } });
  assert.equal(r.status, 201, r.text);
  const vendor = r.json.logo;
  await request(ctx, 'POST', SITE, '/api/host/kit?kind=sponsor&name=Basik%20Diecast', { cookie: C, raw: { buf: fs.readFileSync(f), type: 'image/png' } });
  r = await request(ctx, 'GET', SITE, `/api/host/meets/${tt.id}/trucks`, { cookie: C });
  assert.deepEqual(r.json.vendors.map((v) => v.name), ['México en un Vaso'], 'only Food vendors in the picker');
  assert.match(r.json.vendors[0].thumb, /\/uploads\//);
  r = await request(ctx, 'POST', SITE, `/api/host/meets/${tt.id}/send-link`, { cookie: C, body: { kitId: vendor.id } });
  assert.equal(r.status, 201, r.text);
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday');
  const food = /<section id="food">([\s\S]*?)<\/section>/.exec(r.text)[1];
  assert.match(food, /México en un Vaso/, 'on the page before they set up');
  // Deleted: their invite leaves the meet and their name doesn't come back.
  r = await request(ctx, 'DELETE', SITE, `/api/host/kit/${vendor.id}`, { cookie: C });
  assert.equal(r.status, 200);
  r = await request(ctx, 'GET', SITE, `/api/host/meets/${tt.id}/trucks`, { cookie: C });
  assert.ok(!r.json.trucks.some((v) => v.name === 'México en un Vaso'), 'off the trucks list (not “removed”)');
  r = await request(ctx, 'GET', SITE, '/api/host/kit', { cookie: C });
  assert.ok(!(r.json.logos || []).some((l) => l.name === 'México en un Vaso'), 'not put back in Food vendors');
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday');
  assert.doesNotMatch(r.text, /México en un Vaso/);
});

test('a layout saved as a location starts the next meet there', async () => {
  let r = await request(ctx, 'PUT', SITE, `/api/host/meets/${ff.id}/lot`, { cookie: C, body: { lot: LOT } });
  assert.equal(r.status, 200, r.text);
  r = await request(ctx, 'POST', SITE, '/api/host/locations', { cookie: C, body: { meetId: ff.id, name: 'LV Smoke Shop' } });
  assert.equal(r.status, 201, r.text);
  const venueId = r.json.venue.id;
  assert.equal(r.json.meet.venueId, venueId);
  r = await request(ctx, 'GET', SITE, '/api/host/lots', { cookie: C });
  assert.deepEqual(r.json.saved.map((x) => [x.name, x.zones]), [['LV Smoke Shop', 1]]);
  r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day: ymd(20), start: '19:00', end: '23:00', place: 'LV', title: 'Fuel Friday', venueId } });
  assert.equal(r.status, 201);
  assert.equal(r.json.meet.lot.zones[0].label, 'Unforsaken', 'the map comes with the location');
  r = await request(ctx, 'POST', SITE, '/api/host/locations', { cookie: C, body: { meetId: ff.id, name: 'lv smoke shop' } });
  assert.equal(r.json.venue.id, venueId, 'same name: the same location, layout replaced');
});

test('the password opens the host’s workspace; a wrong one doesn’t', async () => {
  let r = await request(ctx, 'GET', SITE, '/api/host/sign-in-options');
  assert.equal(r.json.password, true);
  r = await request(ctx, 'POST', SITE, '/api/host/password', { body: { password: 'nope' } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'POST', SITE, '/api/host/password', { body: { password: 'azmonarchy' } });
  assert.equal(r.status, 200);
  const cookie = String([].concat(r.headers['set-cookie'] || [])[0] || '').split(';')[0];
  r = await request(ctx, 'GET', SITE, '/api/host/me', { cookie });
  assert.equal(r.json.host.slug, 'tasty-tuesday');
});
