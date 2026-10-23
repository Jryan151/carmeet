'use strict';
/* The site opening on one host's page (round logo, trucks listed with their menus), trucks' menus in meet mode
   (passed through to the food side with the proxy headers, never this site's sign-in), the logo trim, and editing
   a logo in the flyer kit. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startSite, request, host, KEY } = require('./helpers');

const ctx = startSite(test, { MEET_MODE: '1', HOME_HOST: 'tasty-tuesday' });
const SITE = 'meets.test';
const k = () => ctx.kitchen.state;
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let C, ref;

// A logo the way phones save it: a tall black image with the crest in the middle (odd size on purpose).
function tallLogo() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logo-')), 'logo.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=421x754', '-frames:v', '1',
    '-vf', 'drawbox=x=40:y=260:w=340:h=200:color=0xd4a640:t=fill,drawbox=x=150:y=200:w=120:h=60:color=0xd4a640:t=fill', f]);
  return fs.readFileSync(f);
}
const sizeOf = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)]; // PNG width, height

test.before(async () => {
  C = await host(ctx);
  const r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day: ymd(3), start: '19:00', end: '22:00', place: '9240 N 43rd Ave', address: '9240 N 43rd Ave, Glendale, AZ' } });
  assert.equal(r.status, 201, r.text);
  ref = Object.keys(k().meets)[0];
  k().meets[ref].vendors = [
    { inviteId: 1, status: 'in', slug: 'birria-bros', name: 'Birria Bros', emoji: '🌮', cardReady: true, preorders: 0 },
    { inviteId: 2, status: 'in', slug: 'lemon-stand', name: 'Desert Lemonade', emoji: '🍋', cardReady: false, preorders: 0 },
    { inviteId: 3, status: 'in', slug: 'night-birria', name: 'Night Birria', emoji: '', cardReady: false, payAtTruck: true, preorders: 0 },
  ];
});

test('the logo keeps the whole crest, not a strip from the middle', { skip: !ffmpeg }, async () => {
  const r = await request(ctx, 'POST', SITE, '/api/host/logo', { cookie: C, raw: { buf: tallLogo(), type: 'image/png' } });
  assert.equal(r.status, 200, r.text);
  const png = (await request(ctx, 'GET', SITE, r.json.host.logo)).buf;
  const [w, h] = sizeOf(png);
  assert.ok(w >= 340 && w <= 380, `width ${w}`);
  assert.ok(h >= 260 && h <= 300, `height ${h}`);
  // The black around the crest is see-through (no black box on the footage); the crest itself isn't.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'png-')), 'l.png'); fs.writeFileSync(f, png);
  const px = (x, y) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-vf', `crop=1:1:${x}:${y},format=rgba`, '-f', 'rawvideo', '-']).stdout;
  assert.equal(px(0, 0)[3], 0, 'corner is see-through');
  assert.equal(px(Math.round(w / 2), h - 30)[3], 255, 'crest is solid');
});

test('the site opens on the host: round logo, no header, every truck linked to its menu', async () => {
  const r = await request(ctx, 'GET', SITE, '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /class="avatar"><img src="\/uploads\//);
  assert.ok(!/<header class="wrap top">/.test(r.text), 'no name above the logo');
  assert.ok(!/Run a meet|Page by/.test(r.text));
  assert.ok(r.text.includes(`href="/meet/${ref}/birria-bros/"`), 'card truck → its menu in meet mode');
  assert.ok(r.text.includes(`href="/meet/${ref}/lemon-stand/"`), 'every truck gets a menu link');
  assert.match(r.text, /Night Birria<\/div><div class="note">Pre-order, pay at the truck/, 'a night-kit truck takes pre-orders paid at the truck');
  assert.ok(!/online ?kitchen|127\.0\.0\.1/i.test(r.text));
});

test('the food side hears the look for meet mode', async () => {
  const put = k().calls.filter((c) => c.method === 'PUT').slice(-1)[0];
  assert.equal(put.body.theme.siteName, 'Tasty Tuesday');
  assert.match(put.body.theme.logoUrl, /^\/uploads\//, 'a new logo re-sends upcoming meets');
  assert.match(put.body.theme.backUrl, /^\/tasty-tuesday\/\d{4}-\d{2}-\d{2}$/);
  assert.match(put.body.theme.accent, /^#[0-9a-f]{6}$/i);
});

test('meet mode: /meet/* goes to the food side with the proxy headers, never this site’s sign-in', async () => {
  const r = await request(ctx, 'POST', SITE, `/meet/${ref}/birria-bros/api/orders?x=1`, {
    cookie: `${C}; okm_cart=abc; mn_device=d1`, body: { items: [1] },
    headers: { 'X-Meet-Proxy': 'forged', 'X-Meet-Origin': 'https://evil.example', 'X-Meet-Client-IP': '6.6.6.6' } });
  assert.equal(r.status, 200, r.text);
  const h = r.json.headers;
  assert.equal(r.json.url, `/meet/${ref}/birria-bros/api/orders?x=1`, 'path kept as is');
  assert.equal(r.json.method, 'POST');
  assert.deepEqual(JSON.parse(r.json.raw), { items: [1] }, 'body passed through untouched');
  assert.equal(h['x-meet-proxy'], crypto.createHmac('sha256', KEY).update('meet-proxy').digest('hex'));
  assert.equal(h['x-meet-origin'], 'http://meets.test');
  assert.notEqual(h['x-meet-client-ip'], '6.6.6.6');
  assert.equal(h.cookie, 'okm_cart=abc', 'only the food side’s own cookies');
});

test('the flyer kit: rename, change type, new picture', { skip: !ffmpeg }, async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/kit?kind=vendor&name=Lemon', { cookie: C, raw: { buf: tallLogo(), type: 'image/png' } });
  assert.equal(r.status, 201, r.text);
  const id = r.json.logo.id, first = r.json.logo.url;
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${id}`, { cookie: C, body: { name: 'Desert Lemonade', kind: 'sponsor' } });
  assert.deepEqual([r.json.logo.name, r.json.logo.kind], ['Desert Lemonade', 'sponsor']);
  r = await request(ctx, 'POST', SITE, `/api/host/kit/${id}/image`, { cookie: C, raw: { buf: tallLogo(), type: 'image/png' } });
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.json.logo.url, first);
  assert.equal((await request(ctx, 'GET', SITE, first)).status, 404, 'the old picture is gone');
  r = await request(ctx, 'POST', SITE, `/api/host/kit/999/image`, { cookie: C, raw: { buf: tallLogo(), type: 'image/png' } });
  assert.equal(r.status, 404);
});

test('the privacy page meet mode links to is there, with no trace of the ordering system', async () => {
  const r = await request(ctx, 'GET', SITE, '/privacy');
  assert.equal(r.status, 200);
  assert.match(r.text, /Food pre-orders/);
  assert.ok(!/online ?kitchen/i.test(r.text));
});

test('the page: logo and buttons on top, when and where under The spot, kit vendors under Food, Instagram button', async () => {
  let r = await request(ctx, 'GET', SITE, '/');
  const hero = r.text.slice(r.text.indexOf('<section class="hero'), r.text.indexOf('<section id="food"'));
  assert.ok(!/class="date"|data-countdown|Directions/.test(hero), 'no date block in the middle');
  assert.match(hero, /href="#alerts">Get alerts</);
  const spot = r.text.slice(r.text.indexOf('<section id="spot"'));
  assert.match(spot, /class="when"[\s\S]*class="date"[\s\S]*data-countdown[\s\S]*9240 N 43rd Ave[\s\S]*Directions/);
  // A vendor from the kit, listed on the meet's page.
  r = await request(ctx, 'POST', SITE, '/api/host/kit?kind=vendor&name=Boba%20Spot', { cookie: C, raw: { buf: tallLogo(), type: 'image/png' } });
  assert.equal(r.status, 201, r.text);
  const kid = r.json.logo.id;
  const meets = await request(ctx, 'GET', SITE, '/api/host/meets', { cookie: C });
  const mid = (meets.json.meets || meets.json.upcoming || [])[0].id;
  r = await request(ctx, 'PUT', SITE, `/api/host/meets/${mid}/kit-vendors/${kid}`, { cookie: C });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await request(ctx, 'GET', SITE, `/api/host/meets/${mid}/kit-vendors`, { cookie: C })).json.ids, [kid]);
  r = await request(ctx, 'GET', SITE, '/');
  assert.match(r.text, /Boba Spot<\/div><div class="note">At the meet · order at the truck/);
  r = await request(ctx, 'DELETE', SITE, `/api/host/meets/${mid}/kit-vendors/${kid}`, { cookie: C });
  assert.ok(!(await request(ctx, 'GET', SITE, '/')).text.includes('Boba Spot'), 'taken off again');
  // With an Instagram handle, the top button follows the host there.
  r = await request(ctx, 'PUT', SITE, '/api/host/settings', { cookie: C, body: { instagram: '@tastytuesdayaz' } });
  assert.equal(r.status, 200, r.text);
  r = await request(ctx, 'GET', SITE, '/');
  assert.match(r.text, /<a class="btn[^"]*" href="https:\/\/instagram\.com\/tastytuesdayaz" rel="noopener">Follow on Instagram<\/a>/);
});
