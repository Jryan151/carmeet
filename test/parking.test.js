'use strict';
/* The parking map: find the spot by address, save a layout (zones and pins, checked), show it tilted on the meet
   page over the satellite tiles, carry it to next week, and start a new meet from a past one. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startSite, request, host } = require('./helpers');
const L = require('../public/lotmap');

// A stand-in for the address search (Nominatim's answer shape), counting how often it's asked.
const geo = { asked: 0, port: 47000 + Math.floor(Math.random() * 900) };
geo.srv = http.createServer((req, res) => {
  geo.asked++;
  const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(/peoria/i.test(q) ? [{ lat: '33.58053', lon: '-112.17112', display_name: '5112 W Peoria Ave, Glendale, Maricopa County, Arizona, 85302, United States' }] : []));
}).listen(geo.port, '127.0.0.1');
// A stand-in for OpenStreetMap's Overpass: a lot, two spaces side by side, an aisle, and a lot drawn as a multipolygon.
const osm = { asked: 0, port: geo.port + 1 };
const ring = (lat, lng, dLat, dLng) => [{ lat, lon: lng }, { lat, lon: lng + dLng }, { lat: lat + dLat, lon: lng + dLng }, { lat: lat + dLat, lon: lng }, { lat, lon: lng }];
osm.srv = http.createServer((req, res) => {
  osm.asked++;
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    osm.lastQuery = decodeURIComponent(body.replace(/^data=/, ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ elements: [
      { type: 'way', id: 1, tags: { amenity: 'parking' }, geometry: ring(33.5805, -112.1712, 0.0004, 0.0006) },
      { type: 'way', id: 2, tags: { amenity: 'parking_space' }, geometry: ring(33.5806, -112.1711, 0.00005, 0.00003) },
      { type: 'way', id: 3, tags: { amenity: 'parking_space' }, geometry: ring(33.5806, -112.17107, 0.00005, 0.00003) },
      { type: 'way', id: 4, tags: { highway: 'service', service: 'parking_aisle' }, geometry: [{ lat: 33.5805, lon: -112.1712 }, { lat: 33.5809, lon: -112.1712 }] },
      { type: 'relation', id: 5, tags: { amenity: 'parking', type: 'multipolygon' }, members: [{ type: 'way', role: 'outer', geometry: ring(33.581, -112.1715, 0.0002, 0.0002) }, { type: 'way', role: 'inner', geometry: ring(33.5811, -112.1714, 0.00005, 0.00005) }] },
      { type: 'node', id: 6, lat: 33.58, lon: -112.17, tags: { amenity: 'parking' } },
    ] }));
  });
}).listen(osm.port, '127.0.0.1');
test.after(() => osm.srv.close());
test.after(() => geo.srv.close());

const ctx = startSite(test, { MAP_TILES: 'https://tiles.example/{z}/{y}/{x}.jpg', MAP_CREDIT: 'Imagery © Example', GEOCODER_URL: `http://127.0.0.1:${geo.port}/search`, OVERPASS_URL: `http://127.0.0.1:${osm.port}/api/interpreter` });
const SITE = 'meets.test';
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let C, id;

const at = (dx, dy) => ({ lat: 33.58053 + dy * 1e-4, lng: -112.17112 + dx * 1e-4 });
const LOT = { lat: 33.58053, lng: -112.17112, zoom: 18, address: '5112 W Peoria Ave, Glendale', zones: [
  { kind: 'club', label: 'Unforsaken', color: '#c084fc', pts: [at(0, 0), at(2, 0), at(2, 1), at(0, 1)] },
  { kind: 'vendors', label: '', pts: [at(-2, 0), at(-1, 0), at(-1, -1)] },
  { kind: 'helipad', pts: [at(0, 0), at(1, 0), at(1, 1)] },          // not a kind: dropped
  { kind: 'show', pts: [at(0, 0), at(1, 1)] },                        // two corners: dropped
  { kind: 'overflow', pts: [at(0, 0), { lat: 40, lng: -100 }, at(1, 1), at(0, 1)] }, // the far point goes, three stay
], pins: [{ kind: 'enter', label: '', ...at(-3, 0) }, { kind: 'enter', label: 'Side gate <b>', ...at(-3, 2) }, { kind: 'teleport', ...at(0, 0) }] };

test.before(async () => {
  C = await host(ctx, { email: 'fuel@example.com', name: 'Fuel Friday', slug: 'fuel-friday' });
  const r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day: ymd(1), start: '19:00', end: '23:00', place: '5112 W Peoria Ave', address: '5112 W Peoria Ave, Glendale, AZ' } });
  assert.equal(r.status, 201, r.text);
  id = r.json.meet.id;
});

test('the address search answers with places, and asks only once per address', async () => {
  let r = await request(ctx, 'GET', SITE, '/api/host/geocode?q=5112 W Peoria Ave Glendale', { cookie: C });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.results[0].lat, r.json.results[0].lng], [33.58053, -112.17112]);
  assert.match(r.json.results[0].label, /Glendale/);
  const before = geo.asked;
  r = await request(ctx, 'GET', SITE, '/api/host/geocode?q=5112  w peoria AVE glendale', { cookie: C });
  assert.equal(r.json.results.length, 1);
  assert.equal(geo.asked, before, 'kept from last time');
  r = await request(ctx, 'GET', SITE, '/api/host/geocode?q=ab', { cookie: C });
  assert.equal(r.status, 400);
  r = await request(ctx, 'GET', SITE, '/api/host/geocode?q=5112 W Peoria Ave');
  assert.equal(r.status, 401, 'hosts only');
  r = await request(ctx, 'GET', SITE, '/api/host/me', { cookie: C });
  assert.equal(r.json.host.mapTiles, 'https://tiles.example/{z}/{y}/{x}.jpg');
});

test('a layout is checked when saved, and shown tilted on the page over the tiles', async () => {
  let r = await request(ctx, 'PUT', SITE, `/api/host/meets/${id}/lot`, { cookie: C, body: { lot: { lat: 'x' } } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'PUT', SITE, `/api/host/meets/${id}/lot`, { cookie: C, body: { lot: LOT } });
  assert.equal(r.status, 200, r.text);
  const lot = r.json.meet.lot;
  assert.deepEqual(lot.zones.map((z) => z.kind), ['club', 'vendors', 'overflow']);
  assert.equal(lot.zones[1].color, L.KIND_COLOR.vendors, 'no color: the kind’s own');
  assert.equal(lot.zones[2].pts.length, 3);
  assert.deepEqual(lot.pins.map((p) => p.kind), ['enter', 'enter']);
  r = await request(ctx, 'GET', SITE, '/fuel-friday');
  assert.match(r.text, /Where to park/);
  assert.match(r.text, /src="https:\/\/tiles\.example\/18\/\d+\/\d+\.jpg"/);
  assert.match(r.text, /<polygon points="[\d., ]+" style="--z:#c084fc"\/>/);
  assert.match(r.text, /<b>Unforsaken<\/b>/);
  assert.ok(!/<b>Vendors<\/b>/.test(r.text), 'no name: no label on the map (the key says what the color is)');
  assert.match(r.text, /<span style="--pin:#f472b6">Vendors<\/span>/, 'the key names the kind');
  assert.ok(!/data-lot-flat|Drag to turn/.test(r.text), 'flat: nothing to turn');
  assert.match(r.text, /class="lot flat"/);
  assert.match(r.text, /<b>Side gate b<\/b>/, 'no markup in labels');
  assert.match(r.text, /Imagery © Example/);
  assert.match(r.text, /maps\/search\/\?api=1&amp;query=33\.58053,-112\.17112/);
  // The tiles on the page cover the square, at the right zoom.
  const f = L.frame(lot);
  for (const t of f.tiles) assert.ok(r.text.includes(`/18/${t.y}/${t.x}.jpg`), `tile ${t.x},${t.y}`);
});

test('repeat next week brings the layout; a new meet can start from a past one', async () => {
  let r = await request(ctx, 'POST', SITE, `/api/host/meets/${id}/again`, { cookie: C, body: {} });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.meet.lot.zones.length, 3);
  const next = r.json.meet.id;
  r = await request(ctx, 'DELETE', SITE, `/api/host/meets/${next}/lot`, { cookie: C });
  assert.equal(r.json.meet.lot, null);
  r = await request(ctx, 'GET', SITE, '/api/host/lots', { cookie: C });
  assert.equal(r.json.lots.length, 1);
  assert.equal(r.json.lots[0].meetId, id);
  assert.equal(r.json.lots[0].zones, 3);
  // Someone else's meet and layouts aren't theirs.
  const C2 = await host(ctx, { email: 'x@example.com', name: 'Other', slug: 'other-crew' });
  assert.equal((await request(ctx, 'PUT', SITE, `/api/host/meets/${id}/lot`, { cookie: C2, body: { lot: LOT } })).status, 404);
  assert.equal((await request(ctx, 'GET', SITE, '/api/host/lots', { cookie: C2 })).json.lots.length, 0);
});

test('a venue: added in Settings, picked on a meet, shown under The spot; only the host’s own', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/kit/entry', { cookie: C, body: { kind: 'venue', name: 'LV Smoke Shop', instagram: '@lvsmokeshop' } });
  assert.equal(r.status, 201, r.text);
  const v = r.json.logo.id;
  r = await request(ctx, 'PUT', SITE, `/api/host/kit/${v}`, { cookie: C, body: { note: 'Your neighborhood smoke shop' } });
  r = await request(ctx, 'PUT', SITE, `/api/host/meets/${id}`, { cookie: C, body: { day: ymd(1), start: '19:00', end: '23:00', place: 'The lot', address: '5112 W Peoria Ave, Glendale, AZ', venueId: v } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.meet.venueId, v);
  r = await request(ctx, 'GET', SITE, '/fuel-friday');
  assert.match(r.text, /class="venue"/);
  assert.match(r.text, /LV Smoke Shop<\/div><div class="small dim">Your neighborhood smoke shop/);
  assert.match(r.text, /instagram\.com\/lvsmokeshop/);
  assert.match(r.text, /<meta name="description" content="[^"]*at LV Smoke Shop, The lot/);
  // Another host's venue can't be picked; a club isn't a venue.
  const C3 = await host(ctx, { email: 'y@example.com', name: 'Third', slug: 'third-crew' });
  const other = (await request(ctx, 'POST', SITE, '/api/host/kit/entry', { cookie: C3, body: { kind: 'venue', name: 'Elsewhere' } })).json.logo.id;
  const club = (await request(ctx, 'POST', SITE, '/api/host/kit/entry', { cookie: C, body: { kind: 'group', name: 'Unforsaken' } })).json.logo.id;
  for (const bad of [other, club]) {
    r = await request(ctx, 'PUT', SITE, `/api/host/meets/${id}`, { cookie: C, body: { day: ymd(1), start: '19:00', end: '23:00', place: 'The lot', venueId: bad } });
    assert.equal(r.json.meet.venueId, null);
  }
});

test('parking already on the map: lots, single spaces, aisles and multipolygon lots, asked once per spot', async () => {
  let r = await request(ctx, 'GET', SITE, '/api/host/lot-shapes?lat=33.58053&lng=-112.17112', { cookie: C });
  assert.equal(r.status, 200, r.text);
  const by = (t) => r.json.shapes.filter((x) => x.type === t);
  assert.equal(by('lot').length, 2, 'the way and the multipolygon’s outer ring');
  assert.equal(by('space').length, 2);
  assert.equal(by('aisle').length, 1);
  assert.equal(by('lot')[0].pts.length, 4, 'a closed ring loses its repeated last point');
  assert.match(osm.lastQuery, /parking_space/);
  assert.match(osm.lastQuery, /around:\d+,33\.58053,-112\.17112/);
  const before = osm.asked;
  r = await request(ctx, 'GET', SITE, '/api/host/lot-shapes?lat=33.58053&lng=-112.17112', { cookie: C });
  assert.equal(osm.asked, before, 'kept from last time');
  r = await request(ctx, 'GET', SITE, '/api/host/lot-shapes?lat=x&lng=1', { cookie: C });
  assert.equal(r.status, 400);
  r = await request(ctx, 'GET', SITE, '/api/host/lot-shapes?lat=33.5&lng=-112.1');
  assert.equal(r.status, 401);
});

test('a meet can have its own header logo; the rest keep the usual one', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logo-')), 'l.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xd4a640:s=120x80', '-frames:v', '1', f]);
  const png = fs.readFileSync(f);
  let r = await request(ctx, 'POST', SITE, '/api/host/logo', { cookie: C, raw: { buf: png, type: 'image/png' } });
  const usual = r.json.host.logo;
  r = await request(ctx, 'POST', SITE, `/api/host/meets/${id}/logo`, { cookie: C, raw: { buf: png, type: 'image/png' } });
  assert.equal(r.status, 200, r.text);
  const own = r.json.meet.logo;
  assert.ok(own && own !== usual);
  const other = (await request(ctx, 'GET', SITE, '/api/host/meets', { cookie: C })).json.meets.find((m) => m.id !== id);
  r = await request(ctx, 'GET', SITE, `/fuel-friday/${(await request(ctx, 'GET', SITE, '/api/host/meets', { cookie: C })).json.meets.find((m) => m.id === id).day}`);
  assert.ok(r.text.includes(`class="avatar"><img src="${own}"`), 'this meet: its own logo');
  r = await request(ctx, 'GET', SITE, `/fuel-friday/${other.day}`);
  assert.ok(r.text.includes(`class="avatar"><img src="${usual}"`), 'another meet: the usual one');
  r = await request(ctx, 'DELETE', SITE, `/api/host/meets/${id}/logo`, { cookie: C });
  assert.equal(r.json.meet.logo, null);
});

test('logos: names and types read for them; placeholder names replaced; Food, Clubs and Vendors apart on the page', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 }, async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-')), 'k.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xc0c0c0:s=90x90', '-frames:v', '1', f]);
  const png = fs.readFileSync(f);
  // The splitter's pictures, before they're saved.
  let r = await request(ctx, 'POST', SITE, '/api/host/logo-read', { cookie: C, body: { files: [{ type: 'image/png', data: png.toString('base64') }, { type: 'image/png', data: png.toString('base64') }] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.logos, [{ name: 'Unforsaken', kind: 'group' }, { name: 'México en un Vaso', kind: 'vendor' }]);
  // Entries already saved as "Logo 1".."Logo 4" (all filed under Food), and one with a real name.
  const ids = [];
  for (const nm of ['Logo 1', 'Logo 2', 'Logo 3', 'Logo 4', 'Night Wings']) {
    r = await request(ctx, 'POST', SITE, `/api/host/kit?kind=vendor&name=${encodeURIComponent(nm)}`, { cookie: C, raw: { buf: png, type: 'image/png' } });
    assert.equal(r.status, 201, r.text); ids.push(r.json.logo.id);
  }
  r = await request(ctx, 'POST', SITE, '/api/host/kit/read', { cookie: C, body: { ids } });
  assert.equal(r.json.read.length, 5);
  assert.equal(r.json.logos, undefined, 'only read, nothing changed');
  r = await request(ctx, 'POST', SITE, '/api/host/kit/read', { cookie: C, body: { ids, apply: true } });
  const by = (id) => r.json.logos.find((l) => l.id === id);
  assert.deepEqual([by(ids[0]).name, by(ids[0]).kind], ['Unforsaken', 'group']);
  assert.deepEqual([by(ids[1]).name, by(ids[1]).kind], ['México en un Vaso', 'vendor']);
  assert.deepEqual([by(ids[2]).name, by(ids[2]).kind], ['LV Smoke Shop', 'sponsor']);
  assert.deepEqual([by(ids[3]).name, by(ids[3]).kind], ['Logo 4', 'vendor'], 'nothing read: left as it was');
  assert.equal(by(ids[4]).name, 'Night Wings', 'a real name stays');
  // On a meet's page: each in its own section.
  for (const k of [ids[0], ids[1], ids[2]]) await request(ctx, 'PUT', SITE, `/api/host/meets/${id}/kit-vendors/${k}`, { cookie: C, body: {} });
  const day = (await request(ctx, 'GET', SITE, '/api/host/meets', { cookie: C })).json.meets.find((m) => m.id === id).day;
  r = await request(ctx, 'GET', SITE, `/fuel-friday/${day}`);
  const sec = (h) => { const m = new RegExp(`<h2>${h}</h2>([\\s\\S]*?)</section>`).exec(r.text); return m ? m[1] : ''; };
  assert.match(sec('Food'), /México en un Vaso/); assert.doesNotMatch(sec('Food'), /Unforsaken|LV Smoke Shop/);
  assert.match(sec('Clubs'), /Unforsaken/);
  assert.match(sec('Vendors'), /LV Smoke Shop/); assert.doesNotMatch(sec('Vendors'), /México/);
});

test('email alerts start off: no sign-up on the page, none taken, no emails; on in Settings brings them back', async () => {
  const C4 = await host(ctx, { email: 'quiet@example.com', name: 'Quiet Meet', slug: 'quiet-meet', alerts: false });
  let r = await request(ctx, 'GET', SITE, '/api/host/me', { cookie: C4 });
  assert.equal(r.json.host.alertsOn, false);
  r = await request(ctx, 'GET', SITE, '/quiet-meet');
  assert.ok(!/id="alerts"|Get alerts/.test(r.text), 'no sign-up');
  r = await request(ctx, 'POST', SITE, '/api/alerts', { body: { host: 'quiet-meet', email: 'fan@example.com' } });
  assert.equal(r.status, 404);
  r = await request(ctx, 'PUT', SITE, '/api/host/settings', { cookie: C4, body: { alertsOn: true } });
  assert.equal(r.json.host.alertsOn, true);
  r = await request(ctx, 'GET', SITE, '/quiet-meet');
  assert.match(r.text, /id="alerts"/);
  r = await request(ctx, 'POST', SITE, '/api/alerts', { body: { host: 'quiet-meet', email: 'fan@example.com' } });
  assert.equal(r.status, 200);
});
