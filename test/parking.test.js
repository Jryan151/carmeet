'use strict';
/* The parking map: the host's screenshot and the pins they tap on, checked and shown tilted on the meet page,
   copied with "Repeat next week", and cleared with a new picture. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startSite, request, host } = require('./helpers');

const ctx = startSite(test);
const SITE = 'meets.test';
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let C, id;

function png() {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lot-')), 'l.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2a2a30:s=300x360', '-frames:v', '1', f]);
  return fs.readFileSync(f);
}

test.before(async () => {
  C = await host(ctx, { email: 'fuel@example.com', name: 'Fuel Friday', slug: 'fuel-friday' });
  const r = await request(ctx, 'POST', SITE, '/api/host/meets', { cookie: C, body: { day: ymd(1), start: '19:00', end: '23:00', place: '5112 W Peoria Ave', address: '5112 W Peoria Ave, Glendale, AZ' } });
  assert.equal(r.status, 201, r.text);
  id = r.json.meet.id;
});

test('pins need the picture first; then they are checked and shown on the page, tilted', { skip: !ffmpeg }, async () => {
  let r = await request(ctx, 'PUT', SITE, `/api/host/meets/${id}/parking`, { cookie: C, body: { pins: [{ x: 0.1, y: 0.2, kind: 'enter' }] } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'POST', SITE, `/api/host/meets/${id}/parking`, { cookie: C, raw: { buf: png(), type: 'image/png' } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.meet.parking, /^\/uploads\//);
  r = await request(ctx, 'PUT', SITE, `/api/host/meets/${id}/parking`, { cookie: C, body: { pins: [
    { x: 0.07, y: 0.25, kind: 'enter', label: 'Enter' }, { x: 0.55, y: 0.43, kind: 'parking', label: 'Car show <b>' },
    { x: 2, y: 0.5, kind: 'food' }, { x: 0.5, y: 0.5, kind: 'helipad' }, { x: 0.9, y: 0.2, kind: 'overflow' }] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.meet.parkingPins.map((p) => p.kind), ['enter', 'parking', 'overflow'], 'outside the picture and unknown kinds dropped');
  r = await request(ctx, 'GET', SITE, '/fuel-friday');
  assert.match(r.text, /Where to park/);
  assert.match(r.text, /data-lot/);
  assert.match(r.text, /class="pin k-enter" style="left:7\.0%;top:25\.0%"><b>Enter<\/b>/);
  assert.match(r.text, /<b>Car show &lt;b&gt;<\/b>/, 'labels are escaped');
  assert.match(r.text, /<b>Overflow<\/b>/, 'no label: the kind’s name');
  assert.match(r.text, /class="lot-key"><span class="k-enter">Enter<\/span><span class="k-parking">Parking<\/span><span class="k-overflow">Overflow<\/span>/);
});

test('repeat next week brings the map and pins along, as its own copy', { skip: !ffmpeg }, async () => {
  let r = await request(ctx, 'POST', SITE, `/api/host/meets/${id}/again`, { cookie: C, body: {} });
  assert.equal(r.status, 201, r.text);
  const next = r.json.meet;
  const first = (await request(ctx, 'GET', SITE, '/api/host/meets', { cookie: C })).json.meets.find((m) => m.id === id);
  assert.ok(next.parking && next.parking !== first.parking, 'its own picture');
  assert.equal(next.parkingPins.length, 3);
  assert.equal((await request(ctx, 'GET', SITE, next.parking)).status, 200);
  // A new picture clears that meet's pins only.
  r = await request(ctx, 'POST', SITE, `/api/host/meets/${next.id}/parking`, { cookie: C, raw: { buf: png(), type: 'image/png' } });
  assert.deepEqual(r.json.meet.parkingPins, []);
  r = await request(ctx, 'DELETE', SITE, `/api/host/meets/${next.id}/parking`, { cookie: C });
  assert.equal(r.json.meet.parking, null);
  const still = (await request(ctx, 'GET', SITE, '/api/host/meets', { cookie: C })).json.meets.find((m) => m.id === id);
  assert.equal(still.parkingPins.length, 3);
  assert.equal((await request(ctx, 'GET', SITE, still.parking)).status, 200, 'the first week’s picture is untouched');
  // Someone else's meet isn't theirs to change.
  const C2 = await host(ctx, { email: 'x@example.com', name: 'Other', slug: 'other-crew' });
  assert.equal((await request(ctx, 'DELETE', SITE, `/api/host/meets/${id}/parking`, { cookie: C2 })).status, 404);
});
