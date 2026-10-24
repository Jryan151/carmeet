'use strict';
/* The car meet site end to end, with a stand-in for the food side: a host signs up and posts a meet (sent to the
   food side), the page shows it with no trace of the ordering system, a truck invite link, pre-orders, the signed
   notice and the customer's order page, alerts with one-tap confirm and unsubscribe, vendor requests, turnout and
   history, settings, a host's own domain. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startSite, request, host, sign } = require('./helpers');

const ctx = startSite(test);
let C, meetId, day;
const SITE = 'meets.test';
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const k = () => ctx.kitchen.state;

test.before(async () => { C = await host(ctx); });

test('signing in needs the right code; a new host picks a free address', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/code', { body: { email: 'other@example.com' } });
  assert.equal(r.json.known, false);
  r = await request(ctx, 'POST', SITE, '/api/host/login', { body: { email: 'other@example.com', code: '000000' } });
  assert.equal(r.status, 400);
  const code = (await request(ctx, 'POST', SITE, '/api/host/code', { body: { email: 'other@example.com' } })).json.devCode;
  r = await request(ctx, 'POST', SITE, '/api/host/login', { body: { email: 'other@example.com', code, name: 'Other', slug: 'tasty-tuesday' } });
  assert.equal(r.status, 409, 'address taken');
  r = await request(ctx, 'POST', SITE, '/api/host/login', { body: { email: 'other@example.com', code, name: 'Other', slug: 'host' } });
  assert.equal(r.status, 400, 'reserved address');
  r = await request(ctx, 'GET', SITE, '/api/host/me');
  assert.equal(r.status, 401);
  r = await request(ctx, 'GET', SITE, '/api/host/me', { cookie: C });
  assert.equal(r.json.host.slug, 'tasty-tuesday');
});

test('a meet: posted, sent to the food side, on the page with nothing from the ordering system', async () => {
  day = ymd(4);
  let r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day, start: '19:00', end: '22:00', place: 'Dunlap lot', address: '3500 W Dunlap Ave, Phoenix, AZ', title: 'JDM night', pageName: 'tasty-tuesday' } });
  assert.equal(r.status, 201, r.text);
  meetId = r.json.meet.id;
  assert.equal(r.json.meet.synced, true);
  const put = k().calls.find((c) => c.method === 'PUT');
  assert.deepEqual([put.body.day, put.body.start, put.body.place, put.body.hostName, put.body.closeMinutes], [day, '19:00', 'Dunlap lot', 'JDM night', 120]);
  r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day, start: '18:00', end: '20:00', place: 'Elsewhere', title: 'jdm night' } });
  assert.equal(r.status, 409, 'the same meet once a day');
  r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day: ymd(-3), start: '18:00', end: '20:00', place: 'Elsewhere' } });
  assert.equal(r.status, 400, 'not in the past');

  r = await request(ctx, 'GET', SITE, '/tasty-tuesday');
  assert.equal(r.status, 200);
  assert.match(r.text, /Dunlap lot/);
  assert.match(r.text, /JDM night/);
  assert.match(r.text, /Get alerts/);
  assert.ok(!/online ?kitchen|127\.0\.0\.1/i.test(r.text), 'no link or name from the ordering system');
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday/' + day);
  assert.equal(r.status, 200);
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday/2020-01-01');
  assert.equal(r.status, 404);
  // The site's front page: its own landing (the buttons), with this meet under Next up.
  r = await request(ctx, 'GET', SITE, '/');
  assert.match(r.text, /href="\/meets"[^>]*>Upcoming meets/); assert.match(r.text, /href="\/members"/); assert.match(r.text, /href="\/vendors"/);
  assert.match(r.text, /JDM night/);
  r = await request(ctx, 'GET', SITE, '/meets');
  assert.match(r.text, new RegExp(`<a class="mcard" href="http://meets.test/tasty-tuesday/${day}">`));
  r = await request(ctx, 'GET', SITE, '/vendors');
  const opt = new RegExp(`<option value="(\\d+)">JDM night`).exec(r.text);
  assert.ok(opt, 'the meets to pick from');
  r = await request(ctx, 'POST', SITE, '/api/vendor-request', { body: { site: '1', name: 'Wrap Shop', contact: 'wrap@example.com', kind: 'other', instagram: '@wrapshop', meet: opt[1], food: 'Car wraps' } });
  assert.equal(r.status, 200, r.text);
  r = await request(ctx, 'GET', SITE, '/api/host/requests', { cookie: C });
  const vr = r.json.requests.find((x) => x.name === 'Wrap Shop');
  assert.deepEqual([vr.kind, vr.instagram, vr.meet && vr.meet.title], ['other', 'wrapshop', 'JDM night']);
  r = await request(ctx, 'GET', SITE, '/members');
  assert.equal(r.status, 200);
});

test('trucks: an invite link to text, then a truck that takes cards shows Pre-order', async () => {
  let r = await request(ctx, 'POST', SITE, `/api/host/meets/${meetId}/invite`, { cookie: C, body: {} });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.text, /Dunlap lot/);
  assert.ok(r.json.text.includes(r.json.url));
  // The truck accepts on the food side and takes cards.
  const ref = Object.keys(k().meets)[0];
  Object.assign(k().meets[ref].vendors[0], { status: 'in', slug: 'birria-bros', name: 'Birria Bros', cardReady: true, preorders: 3 });
  r = await request(ctx, 'GET', SITE, `/api/host/meets/${meetId}/trucks`, { cookie: C });
  assert.equal(r.json.trucks[0].preorders, 3);
  assert.ok(!('total' in r.json.trucks[0]) && !('sales' in r.json.trucks[0]), 'counts only');
  r = await request(ctx, 'GET', SITE, '/api/host/dashboard', { cookie: C });
  assert.equal(r.json.preorders, 3);
  r = await request(ctx, 'GET', SITE, `/tasty-tuesday/${day}`);
  assert.match(r.text, /Birria Bros/);
  assert.ok(r.text.includes(`/tasty-tuesday/${day}/food/birria-bros`));
  r = await request(ctx, 'GET', SITE, `/tasty-tuesday/${day}/food/birria-bros`);
  assert.equal(r.status, 200);
  r = await request(ctx, 'GET', SITE, `/tasty-tuesday/${day}/food/nobody`);
  assert.equal(r.status, 404);
  // A truck the host has had before shows as one tap on the next meet.
  r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day: ymd(11), start: '19:00', end: '22:00', place: 'Dunlap lot' } });
  const next = r.json.meet.id;
  r = await request(ctx, 'GET', SITE, `/api/host/meets/${next}/trucks`, { cookie: C });
  assert.ok(r.json.known.find((x) => x.slug === 'birria-bros'));
  r = await request(ctx, 'POST', SITE, `/api/host/meets/${next}/trucks`, { cookie: C, body: { slug: 'birria-bros' } });
  assert.equal(r.status, 201);
  r = await request(ctx, 'POST', SITE, `/api/host/meets/${next}/trucks`, { cookie: C, body: { slug: 'never-had' } });
  assert.equal(r.status, 404);
});

test('a pre-order: the menu comes through this site, the card page returns here, the notice is checked', async () => {
  let r = await request(ctx, 'GET', SITE, `/api/meets/${meetId}/food/birria-bros`);
  assert.equal(r.status, 200);
  assert.equal(r.json.menu[0].photo, '/food-photo/_/uploads/birria.jpg', 'photos come through this site, with no address from the food side');
  assert.ok(!/127\.0\.0\.1/.test(JSON.stringify(r.json)));
  r = await request(ctx, 'POST', SITE, `/api/meets/${meetId}/food/birria-bros/order`, { body: { name: 'Ana', email: 'nope', items: [{ id: 1, qty: 1 }], pickupAt: 1900000000000, clientKey: 'abcdefgh12' } });
  assert.equal(r.status, 400, 'needs an email');
  r = await request(ctx, 'POST', SITE, `/api/meets/${meetId}/food/birria-bros/order`, { body: { name: 'Ana', email: 'ana@example.com', items: [{ id: 1, qty: 2 }], pickupAt: 1900000000000, clientKey: 'abcdefgh12', device: 'device-0123456789abcd' } });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.json.checkoutUrl.startsWith('https://checkout.stripe.test/'));
  const token = r.json.token;
  const sent = k().lastOrderBody;
  assert.equal(sent.returnUrl, 'http://meets.test/o', 'the card page comes back here');
  assert.ok(!sent.email, 'the email stays on this site');
  assert.match(sent.device, /^[a-f0-9]{32}$/, 'the device id goes hashed');

  // Back from the card page.
  r = await request(ctx, 'GET', SITE, '/o?paid=' + token);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, `/o/${token}?paid=1`);
  r = await request(ctx, 'GET', SITE, '/o/' + token);
  assert.equal(r.status, 200);
  assert.ok(!/online ?kitchen/i.test(r.text));

  // The food side's notice: wrong signature refused; right one updates the order.
  const body = JSON.stringify({ type: 'order', token, status: 'Preparing', payment: 'paid', ticket: 101 });
  r = await request(ctx, 'POST', SITE, '/hooks/kitchen', { raw: { buf: Buffer.from(body), type: 'application/json' }, headers: { 'x-meet-sig': 'bad' } });
  assert.equal(r.status, 401);
  k().orders[token].status = 'Preparing'; k().orders[token].payment = 'paid';
  r = await request(ctx, 'POST', SITE, '/hooks/kitchen', { raw: { buf: Buffer.from(body), type: 'application/json' }, headers: { 'x-meet-sig': sign(body) } });
  assert.equal(r.status, 200);
  r = await request(ctx, 'GET', SITE, `/api/orders/${token}`);
  assert.deepEqual([r.json.status, r.json.payment, r.json.ticket, r.json.vendor], ['Preparing', 'paid', 101, 'Birria Bros']);
});

test('alerts: confirm by link, an update reaches them, a signed link turns them off', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/alerts', { body: { host: 'tasty-tuesday', email: 'fan@example.com' } });
  assert.equal(r.status, 200);
  const link = new URL(r.json.devLink);
  r = await request(ctx, 'GET', SITE, '/api/host/updates', { cookie: C });
  assert.equal(r.json.subscribers, 0, 'not until confirmed');
  r = await request(ctx, 'GET', SITE, link.pathname + link.search);
  assert.match(r.text, /on the list/);
  r = await request(ctx, 'GET', SITE, '/api/host/updates', { cookie: C });
  assert.equal(r.json.subscribers, 1);
  r = await request(ctx, 'POST', SITE, '/api/host/updates', { cookie: C, body: { message: 'Moving to the north lot.', toAlerts: true, toVendors: true, meetId } });
  assert.equal(r.status, 200, r.text);
  assert.equal(k().notices.length, 1, 'the trucks hear it too');
  r = await request(ctx, 'GET', SITE, '/alerts/off?s=1.0000000000000000000000000000000');
  assert.equal(r.status, 404, 'a forged link does nothing');
  r = await request(ctx, 'GET', SITE, '/api/host/updates', { cookie: C });
  assert.equal(r.json.updates[0].subject.includes('Tasty Tuesday'), true);
});

test('a food vendor asks for a spot; the host sees it', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/vendor-request', { body: { host: 'tasty-tuesday', name: 'Lemon Stand', contact: '602-555-0100', food: 'Lemonade' } });
  assert.equal(r.status, 200);
  r = await request(ctx, 'GET', SITE, '/api/host/requests', { cookie: C });
  assert.equal(r.json.requests[0].name, 'Lemon Stand');
  r = await request(ctx, 'PUT', SITE, '/api/host/requests/' + r.json.requests[0].id, { cookie: C, body: { status: 'dismissed' } });
  r = await request(ctx, 'GET', SITE, '/api/host/requests', { cookie: C });
  assert.ok(!r.json.requests.some((x) => x.name === 'Lemon Stand'));
});

test('turnout: only once a meet has started; history averages by spot', async () => {
  let r = await request(ctx, 'POST', SITE, `/api/host/meets/${meetId}/turnout`, { cookie: C, body: { people: 40, cars: 20 } });
  assert.equal(r.status, 400, 'not before it starts');
  // A past meet, written straight to the database (the portal won't post one in the past).
  const D = (() => { process.env.DB_FILE = ctx.dbFile; return require('../db'); })();
  const now = Date.now();
  for (const [d, people] of [[ymd(-14), 30], [ymd(-7), 50]]) {
    await D.run("INSERT INTO meets (host_id, ref, day, start_time, end_time, place, created_at, updated_at) VALUES (1, ?, ?, '19:00', '22:00', 'Dunlap lot', ?, ?)", ['mpast' + people, d, now, now]);
    const id = (await D.get('SELECT id FROM meets WHERE ref = ?', ['mpast' + people])).id;
    r = await request(ctx, 'POST', SITE, `/api/host/meets/${id}/turnout`, { cookie: C, body: { people, cars: people / 2 } });
    assert.equal(r.status, 200, r.text);
  }
  r = await request(ctx, 'GET', SITE, '/api/host/history', { cookie: C });
  assert.deepEqual(r.json.spots[0], { place: 'Dunlap lot', meets: 2, avgPeople: 40, avgCars: 20 });
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday');
  assert.match(r.text, /Last meet: about 50 people, 25 cars/);
});

test('settings, and a host’s own domain once it’s turned on', async () => {
  let r = await request(ctx, 'PUT', SITE, '/api/host/settings', { cookie: C, body: { accent: '#5fb3d9', instagram: '@tastytuesday', closeMinutes: 60, customDomain: 'https://www.TastyTuesday.com/' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.host.accent, r.json.host.instagram, r.json.host.closeMinutes, r.json.host.customDomain, r.json.host.domainOn], ['#5fb3d9', 'tastytuesday', 60, 'tastytuesday.com', false]);
  assert.equal(k().calls.filter((c) => c.method === 'PUT').slice(-1)[0].body.closeMinutes, 60, 'the food side hears the new cutoff');
  r = await request(ctx, 'GET', 'tastytuesday.com', '/');
  assert.match(r.text, /Nothing here|Upcoming meets/, 'not live until turned on');
  r = await request(ctx, 'POST', SITE, '/api/host/admin/domain', { body: { slug: 'tasty-tuesday' }, headers: { 'x-admin-token': 'wrong-wrong-wrong-wrong-xx' } });
  assert.equal(r.status, 404);
  r = await request(ctx, 'POST', SITE, '/api/host/admin/domain', { body: { slug: 'tasty-tuesday' }, headers: { 'x-admin-token': 'test-admin-token-0123456789' } });
  assert.equal(r.status, 200);
  r = await request(ctx, 'GET', 'tastytuesday.com', '/');
  assert.match(r.text, /Dunlap lot/);
  assert.ok(!/Page by/.test(r.text), 'no site line on their own domain');
  r = await request(ctx, 'GET', SITE, '/tasty-tuesday');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'http://tastytuesday.com/');
});

test('photos lose their hidden location data', () => {
  const { stripJpeg, stripPng } = require('../host');
  const seg = (m, data) => { const b = Buffer.alloc(4 + data.length); b[0] = 0xff; b[1] = m; b.writeUInt16BE(data.length + 2, 2); data.copy(b, 4); return b; };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0')), seg(0xe1, Buffer.from('Exif\0\0GPS-HERE')), seg(0xdb, Buffer.alloc(8)), Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])]);
  const out = stripJpeg(jpeg);
  assert.ok(out && !out.includes(Buffer.from('GPS-HERE')) && out.includes(Buffer.from('JFIF')));
  assert.equal(stripJpeg(Buffer.from('not a jpeg')), null);
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13)), chunk('eXIf', Buffer.from('GPS-HERE')), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))]);
  const p = stripPng(png);
  assert.ok(p && !p.includes(Buffer.from('GPS-HERE')) && p.includes(Buffer.from('IDAT')));
});

test('a background video: any clip becomes a silent 15-second 1080p loop with a still, behind the date', { skip: !require('../video').ffmpegOk() && 'ffmpeg not installed' }, async () => {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmvid-'));
  // An upright 4K-ish phone clip, 17 seconds, with sound and a location tag.
  const src = path.join(dir, 'phone.mov');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1440x2560:rate=30:duration=17', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=17',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-metadata', 'location=+33.5684-112.1366/', '-metadata', 'com.apple.quicktime.location.ISO6709=+33.5684-112.1366/', '-shortest', src]);
  const buf = fs.readFileSync(src);
  let r = await request(ctx, 'POST', SITE, '/api/host/video', { cookie: C, raw: { buf: Buffer.from('not a video'), type: 'text/plain' } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'POST', SITE, '/api/host/video', { cookie: C, raw: { buf, type: 'video/quicktime' } });
  assert.equal(r.status, 202, r.text);
  let me;
  for (let i = 0; i < 240; i++) {
    me = (await request(ctx, 'GET', SITE, '/api/host/me', { cookie: C })).json.host;
    if (me.video.status !== 'processing') break;
    await new Promise((res) => setTimeout(res, 500));
  }
  assert.equal(me.video.status, 'ready', JSON.stringify(me.video));
  const out = path.join(dir, 'out.mp4');
  fs.writeFileSync(out, (await request(ctx, 'GET', SITE, me.video.url)).buf);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).toString());
  const v = probe.streams.filter((s) => s.codec_type === 'video');
  assert.equal(v.length, 1);
  assert.deepEqual([v[0].codec_name, v[0].width, v[0].height], ['h264', 1080, 1920], '1080p on the short side, upright kept upright');
  assert.equal(probe.streams.filter((s) => s.codec_type === 'audio').length, 0, 'silent');
  assert.ok(Number(probe.format.duration) <= 15.1, 'a 15-second loop');
  assert.ok(!JSON.stringify(probe.format.tags || {}).includes('33.5684'), 'no location');
  assert.ok(buf.length && (await request(ctx, 'GET', SITE, me.video.poster)).status === 200, 'a still frame');
  r = await request(ctx, 'GET', 'tastytuesday.com', '/' + day);
  assert.equal(v[0].r_frame_rate, '24/1', '24 frames a second');
  assert.ok(r.text.includes(`<source data-src="${me.video.url}" type="video/mp4">`), 'the clip loads after the page');
  assert.match(r.text, /<video muted loop playsinline preload="none"[^>]* data-bg>/);
  if (/libx265/.test(execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString())) {
    assert.match(r.text, /<source data-src="\/uploads\/bg-[0-9a-f]+\.hevc\.mp4" type='video\/mp4; codecs="hvc1"'>/, 'HEVC offered first');
  }
  assert.ok(r.text.includes(`poster="${me.video.poster}"`), 'the still, until its phone copy is made');
  await new Promise((ok) => setTimeout(ok, 1500));
  r = await request(ctx, 'GET', 'tastytuesday.com', '/' + day);
  const webp = me.video.poster.replace(/\.jpg$/, '.s1280.webp');
  assert.ok(r.text.includes(`poster="${webp}"`), 'then the phone-size still');
  assert.equal((await request(ctx, 'GET', SITE, webp)).status, 200);
  r = await request(ctx, 'DELETE', SITE, '/api/host/video', { cookie: C });
  assert.equal(r.json.host.video.status, null);
  r = await request(ctx, 'GET', 'tastytuesday.com', '/' + day);
  assert.ok(!r.text.includes('<video'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only the site owner sets the front page (with none named, the first host)', async () => {
  let r = await request(ctx, 'GET', SITE, '/api/host/site-video', { cookie: C });
  assert.equal(r.status, 200, 'the first host');
  r = await request(ctx, 'PUT', SITE, '/api/host/site-front', { cookie: C, body: { tagline: 'Arizona car meets' } });
  r = await request(ctx, 'GET', SITE, '/');
  assert.match(r.text, /Arizona car meets/);
  const C2 = await host(ctx, { email: 'second@example.com', name: 'Second Meet', slug: 'second-meet' });
  r = await request(ctx, 'GET', SITE, '/api/host/site-video', { cookie: C2 });
  assert.equal(r.status, 404, 'a host who isn’t the owner doesn’t see it');
  const me = (await request(ctx, 'GET', SITE, '/api/host/me', { cookie: C2 })).json.host;
  assert.equal(me.owner, false);
});

test('a meet’s flyer is the page’s main picture and its link preview', async () => {
  const zlib = require('node:zlib');
  // A tiny real PNG (1×1).
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 120, 80, 200]))), chunk('IEND', Buffer.alloc(0))]);
  let r = await request(ctx, 'POST', SITE, `/api/host/meets/${meetId}/flyer`, { cookie: C, raw: { buf: png, type: 'image/png' } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.meet.flyer, /^\/uploads\/.+\.png$/);
  r = await request(ctx, 'GET', 'tastytuesday.com', '/' + day);
  assert.ok(r.text.includes('class="flyer"') && r.text.includes(r.text.match(/\/uploads\/[a-f0-9]+\.png/)[0]));
  assert.match(r.text, /og:image" content="[^"]+\/uploads\/[a-f0-9]+\.png"/);
  r = await request(ctx, 'DELETE', SITE, `/api/host/meets/${meetId}/flyer`, { cookie: C });
  assert.equal(r.json.meet.flyer, null);
});

test('the flyer kit keeps vendor and car group logos', async () => {
  const fs = require('node:fs');
  const buf = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'fonts', 'README.md'));
  let r = await request(ctx, 'POST', SITE, '/api/host/kit?kind=vendor&name=Lemon', { cookie: C, raw: { buf, type: 'image/png' } });
  assert.equal(r.status, 400, 'not an image');
  r = await request(ctx, 'POST', SITE, '/api/host/kit?kind=vendor&name=', { cookie: C, raw: { buf, type: 'image/png' } });
  assert.equal(r.status, 400, 'needs a name');
  r = await request(ctx, 'GET', SITE, '/api/host/kit', { cookie: C });
  assert.deepEqual(r.json.logos, []);
});

test('a weak signal: fonts from this site, no Google, and the portal the same', async () => {
  let r = await request(ctx, 'GET', SITE, '/');
  assert.match(r.text, /<style>@font-face\{font-family:"Michroma"/, 'fonts and styles inside the page (one trip)');
  assert.ok(!/<link rel="stylesheet"/.test(r.text), 'no stylesheet to wait for');
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(r.text), 'nothing from Google');
  for (const f of r.text.match(/\/static\/fonts\/[a-z0-9-]+\.woff2?/g)) {
    const w = await request(ctx, 'GET', SITE, f);
    assert.equal(w.status, 200, f);
    assert.ok(w.buf.length < 40 * 1024, f + ' is small');
    assert.equal(w.headers['access-control-allow-origin'], '*', f + ' usable by the trucks’ invite pages');
  }
  r = await request(ctx, 'GET', SITE, '/host');
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(r.text), 'portal: nothing from Google');
  assert.ok(!/<link rel="stylesheet"/.test(r.text) && /<style>@font-face/.test(r.text), 'portal: styles inside too');
});
