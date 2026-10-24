'use strict';
/* Food vendor profiles: built by the host (story, photos, past logos, spots, their clip), off until turned on,
   opened from the Food logos, an Order button when they're at a meet, their own subdomain with Caddy's check, the
   vendor's clip passed to their menu, and the clip saver. Nothing names the ordering system. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startSite, request, host } = require('./helpers');

const ctx = startSite(test, { MEET_MODE: '1' });
const SITE = 'meets.test';
const k = () => ctx.kitchen.state;
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const OK = /online ?kitchen|onlinekitchen|127\.0\.0\.1/i;
let C, kid, ref, meetId;

function png(color) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'img-')), 'i.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=200x200`, '-frames:v', '1', f]);
  return fs.readFileSync(f);
}

test.before(async () => {
  C = await host(ctx);
  let r = await request(ctx, 'POST', SITE, '/api/host/kit/entry', { cookie: C, body: { kind: 'vendor', name: 'Birria Bros', instagram: '@birriabros' } });
  assert.equal(r.status, 201, r.text);
  kid = r.json.logo.id;
  r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day: ymd(3), start: '19:00', end: '22:00', place: 'Dunlap lot', address: '3500 W Dunlap Ave, Phoenix, AZ' } });
  assert.equal(r.status, 201, r.text);
  meetId = r.json.meet.id;
  ref = Object.keys(k().meets)[0];
});

test('a profile starts off: only its host sees a preview', async () => {
  let r = await request(ctx, 'GET', SITE, `/api/host/kit/${kid}/profile`, { cookie: C });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.profile.pageOn, false);
  assert.equal(r.json.profile.suggestSlug, 'birria-bros');
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${kid}/profile`, { cookie: C, body: { pageSlug: 'birria-bros', serves: 'Birria tacos · consomé', signature: 'Quesabirria', since: '2019', about: 'Family truck from Maryvale.\n\nThird generation.' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.profile.serves, 'Birria tacos · consomé');
  r = await request(ctx, 'GET', SITE, '/v/birria-bros');
  assert.equal(r.status, 404, 'off: not public');
  r = await request(ctx, 'GET', SITE, '/v/birria-bros', { cookie: C });
  assert.equal(r.status, 200);
  assert.match(r.text, /Preview/);
  assert.match(r.text, /noindex/);
});

test('addresses: reserved words and taken ones are refused', async () => {
  let r = await request(ctx, 'PUT', SITE, `/api/host/kit/${kid}/profile`, { cookie: C, body: { pageSlug: 'www' } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${kid}/profile`, { cookie: C, body: { pageSlug: 'Bad Name!' } });
  assert.equal(r.status, 400);
  const other = (await request(ctx, 'POST', SITE, '/api/host/kit/entry', { cookie: C, body: { kind: 'vendor', name: 'Lemon Stand' } })).json.logo.id;
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${other}/profile`, { cookie: C, body: { pageSlug: 'birria-bros' } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /birria-bros-2/);
  r = await request(ctx, 'GET', SITE, `/api/host/kit/${other}/profile`, { cookie: C });
  assert.equal(r.json.profile.suggestSlug, 'lemon-stand');
});

test('photos, past logos and spots show on the page once it is on', { skip: !ffmpeg }, async () => {
  let r = await request(ctx, 'POST', SITE, `/api/host/kit/${kid}/media?kind=photo&label=Quesabirria`, { cookie: C, raw: { buf: png('0xa0522d'), type: 'image/png' } });
  assert.equal(r.status, 201, r.text);
  r = await request(ctx, 'POST', SITE, `/api/host/kit/${kid}/media?kind=logo&label=2021`, { cookie: C, raw: { buf: png('0xf2a33a'), type: 'image/png' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.profile.logos[0].label, '2021');
  r = await request(ctx, 'POST', SITE, `/api/host/kit/${kid}/spots`, { cookie: C, body: { name: 'Maryvale', when: 'Fri–Sun 6–11 PM', address: '51st Ave & Indian School Rd, Phoenix' } });
  assert.equal(r.status, 201, r.text);
  r = await request(ctx, 'POST', SITE, `/api/host/kit/${kid}/spots`, { cookie: C, body: { name: '' } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${kid}/profile`, { cookie: C, body: { pageOn: true } });
  assert.equal(r.json.profile.pageOn, true);
  r = await request(ctx, 'GET', SITE, '/v/birria-bros');
  assert.equal(r.status, 200);
  for (const s of ['Birria Bros', 'Birria tacos · consomé', 'Serving since 2019', 'Quesabirria', 'Third generation', 'Maryvale', 'Fri–Sun 6–11 PM', '2021', 'Through the years', 'instagram.com/birriabros', 'maps/search']) assert.ok(r.text.includes(s), s);
  assert.ok(!/Preview/.test(r.text));
  assert.ok(!OK.test(r.text), 'no trace of the ordering system');
});

test('not at a meet: "Not serving tonight"; at one taking pre-orders: Order opens their menu', async () => {
  let r = await request(ctx, 'GET', SITE, '/v/birria-bros');
  assert.match(r.text, /Not serving tonight/);
  // The host fills in their menu (this ties the vendor to their truck profile on the food side), and the truck is in.
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${kid}/menu`, { cookie: C, body: { items: [{ name: 'Tacos', price: 4 }] } });
  assert.equal(r.status, 200, r.text);
  k().meets[ref].vendors = [{ inviteId: 1, status: 'in', slug: 'birria-bros', name: 'Birria Bros', cardReady: true, preorders: 0 }];
  // The page asks the food side at most once a minute; the host's truck list asks fresh.
  await request(ctx, 'GET', SITE, `/api/host/meets/${meetId}/trucks`, { cookie: C });
  r = await request(ctx, 'GET', SITE, '/v/birria-bros');
  assert.ok(r.text.includes(`href="/meet/${ref}/birria-bros/"`), 'Order opens the menu on this address');
  assert.match(r.text, /Pre-order for/);
  assert.match(r.text, /Dunlap lot/);
  // On the meet page, their logo opens the profile (the Order tag still shows).
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday');
  assert.ok(r.text.includes('href="/v/birria-bros"'), 'logo opens the profile');
  assert.match(r.text, /class="tag">Order/);
  // A paused truck: the menu, not Order.
  k().meets[ref].vendors[0].paused = true;
  await request(ctx, 'GET', SITE, `/api/host/meets/${meetId}/trucks`, { cookie: C });
  r = await request(ctx, 'GET', SITE, '/v/birria-bros');
  assert.match(r.text, /See the menu/);
  assert.match(r.text, /paused/);
  k().meets[ref].vendors[0].paused = false;
  await request(ctx, 'GET', SITE, `/api/host/meets/${meetId}/trucks`, { cookie: C });
});

test('a rename keeps the old address working', async () => {
  let r = await request(ctx, 'PUT', SITE, `/api/host/kit/${kid}/profile`, { cookie: C, body: { pageSlug: 'birria-brothers' } });
  assert.equal(r.status, 200, r.text);
  r = await request(ctx, 'GET', SITE, '/v/birria-bros');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, '/v/birria-brothers');
  r = await request(ctx, 'GET', SITE, '/v/birria-brothers');
  assert.equal(r.status, 200);
  // Nobody else can take the old one while it points here.
  const other = (await request(ctx, 'POST', SITE, '/api/host/kit/entry', { cookie: C, body: { kind: 'vendor', name: 'Bros Two' } })).json.logo.id;
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${other}/profile`, { cookie: C, body: { pageSlug: 'birria-bros' } });
  assert.equal(r.status, 409);
});

test('their clip plays behind their profile and is passed to their menu', { skip: !ffmpeg }, async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vid-')), 'c.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', f]);
  let r = await request(ctx, 'POST', SITE, `/api/host/kit/${kid}/video`, { cookie: C, raw: { buf: fs.readFileSync(f), type: 'video/mp4' } });
  assert.equal(r.status, 202, r.text);
  let v;
  for (let i = 0; i < 120; i++) {
    v = (await request(ctx, 'GET', SITE, `/api/host/kit/${kid}/profile`, { cookie: C })).json.profile.video;
    if (v.status !== 'processing') break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  assert.equal(v.status, 'ready', JSON.stringify(v));
  r = await request(ctx, 'GET', SITE, '/v/birria-brothers');
  assert.ok(r.text.includes(v.url), 'their clip is the background');
  // The menu page (through the proxy) gets the clip; its scripts and answers don't need it.
  r = await request(ctx, 'GET', SITE, `/meet/${ref}/birria-bros/`);
  assert.equal(r.json.headers['x-meet-bg-video'], v.url);
  assert.equal(r.json.headers['x-meet-bg-poster'], v.poster);
  assert.equal(r.json.headers['x-meet-back'], undefined, 'on the site itself, back goes to the meet');
  r = await request(ctx, 'GET', SITE, `/meet/${ref}/birria-bros/api/vendor-data`);
  assert.equal(r.json.headers['x-meet-bg-video'], undefined);
  // A customer can't send these themselves.
  r = await request(ctx, 'GET', SITE, `/meet/${ref}/birria-bros/`, { headers: { 'x-meet-bg-video': '/uploads/evil.mp4', 'x-meet-back': 'https://evil.test' } });
  assert.equal(r.json.headers['x-meet-bg-video'], v.url);
  assert.equal(r.json.headers['x-meet-back'], undefined);
  r = await request(ctx, 'GET', SITE, `/meet/${ref}/nobody/`, { headers: { 'x-meet-bg-video': '/uploads/evil.mp4' } });
  assert.equal(r.json.headers['x-meet-bg-video'], undefined);
});

test('the clip saver is served from the root, and removing a vendor removes their profile', async () => {
  let r = await request(ctx, 'GET', SITE, '/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /javascript/);
  assert.match(r.text, /clips-v3/);
  const gone = (await request(ctx, 'POST', SITE, '/api/host/kit/entry', { cookie: C, body: { kind: 'vendor', name: 'Gone Truck' } })).json.logo.id;
  await request(ctx, 'PUT', SITE, `/api/host/kit/${gone}/profile`, { cookie: C, body: { pageOn: true } });
  assert.equal((await request(ctx, 'GET', SITE, '/v/gone-truck')).status, 200);
  await request(ctx, 'DELETE', SITE, `/api/host/kit/${gone}`, { cookie: C });
  assert.equal((await request(ctx, 'GET', SITE, '/v/gone-truck')).status, 404);
  // Another host's vendor isn't theirs to edit.
  const C2 = await host(ctx, { email: 'two@example.com', name: 'Other Meet', slug: 'other-meet' });
  r = await request(ctx, 'GET', SITE, `/api/host/kit/${kid}/profile`, { cookie: C2 });
  assert.equal(r.status, 404);
});

/* ---------- with vendor subdomains on ---------- */
const sub = startSite(test, { MEET_MODE: '1', VENDOR_SUBDOMAINS: '1' });
test('subdomains: <name>.<site> is the profile; Caddy only gets a yes for real pages', async () => {
  const C3 = await host(sub);
  const id = (await request(sub, 'POST', SITE, '/api/host/kit/entry', { cookie: C3, body: { kind: 'vendor', name: 'Tacos El Rey' } })).json.logo.id;
  let r = await request(sub, 'PUT', SITE, `/api/host/kit/${id}/profile`, { cookie: C3, body: { pageOn: true, serves: 'Birria' } });
  assert.equal(r.json.profile.pageUrl, 'http://tacos-el-rey.meets.test/');
  r = await request(sub, 'GET', 'tacos-el-rey.meets.test', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Tacos El Rey/);
  r = await request(sub, 'GET', SITE, '/v/tacos-el-rey');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'http://tacos-el-rey.meets.test/');
  // Anything that isn't the profile or what it needs goes to the site itself.
  r = await request(sub, 'GET', 'tacos-el-rey.meets.test', '/host');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'http://meets.test/host');
  r = await request(sub, 'GET', 'nobody-here.meets.test', '/');
  assert.equal(r.status, 302);
  // The menu through the vendor's address: the back link is their profile.
  const mr = await request(sub, 'POST', SITE, '/api/host/meets', { cookie: C3, body: { day: ymd(2), start: '19:00', end: '22:00', place: 'Lot' } });
  const sref = Object.keys(sub.kitchen.state.meets)[0];
  await request(sub, 'PUT', SITE, `/api/host/kit/${id}/menu`, { cookie: C3, body: { items: [{ name: 'Taco', price: 3 }] } });
  r = await request(sub, 'GET', 'tacos-el-rey.meets.test', `/meet/${sref}/tacos-el-rey/`);
  assert.equal(r.json.headers['x-meet-back'], '/');
  assert.equal(r.json.headers['x-meet-origin'], 'http://tacos-el-rey.meets.test');
  assert.ok(mr.json.meet.id);
  // Caddy's question: yes for the site and live pages, no for anything else.
  assert.equal((await request(sub, 'GET', SITE, '/caddy/ask?domain=tacos-el-rey.meets.test')).status, 200);
  assert.equal((await request(sub, 'GET', SITE, '/caddy/ask?domain=meets.test')).status, 200);
  assert.equal((await request(sub, 'GET', SITE, '/caddy/ask?domain=random.meets.test')).status, 404);
  assert.equal((await request(sub, 'GET', SITE, '/caddy/ask?domain=evil.example')).status, 404);
});
