'use strict';
/* Section 6 — data integrity. Each test states what should hold; a failing test is a finding.
   node --test test/stress/repro/integrity.repro.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { startSite, request, host } = require('../../helpers');
const U = require('../../../util');

const ctx = startSite(test);
const SITE = 'meets.test';
const req = (m, p, o = {}) => request(ctx, m, o.host || SITE, p, o);
const ymd = (n) => U.addDays(U.dayKey(Date.now(), 'America/Phoenix'), n);
let A, B;
const sql = (q, p = []) => new Promise((ok, no) => { const d = new sqlite3.Database(ctx.dbFile); d.configure('busyTimeout', 5000); d.all(q, p, (e, r) => { d.close(); return e ? no(e) : ok(r); }); });
const meet = async (c, body) => { const r = await req('POST', '/api/host/meets', { cookie: c, body: Object.assign({ start: '19:00', end: '22:00', place: 'Lot' }, body) }); return r; };

test.before(async () => {
  A = await host(ctx, { email: 'a@a.test', name: 'Tasty Tuesday', slug: 'tasty-tuesday' });
  B = await host(ctx, { email: 'b@b.test', name: 'West Side', slug: 'west-side' });
});

test('two meets on one night with different names both have pages; the same name twice is refused', async () => {
  const d = ymd(6);
  const r1 = await meet(A, { day: d, title: 'Fuel Friday' });
  const r2 = await meet(A, { day: d, title: 'Midnight Run' });
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  assert.notEqual(r1.json.meet.url, r2.json.meet.url);
  for (const r of [r1, r2]) assert.match((await req('GET', new URL(r.json.meet.url).pathname)).text, new RegExp(r.json.meet.title));
  assert.equal((await meet(A, { day: d, title: ' fuel friday ' })).status, 409, 'same name, other case and spaces');
  const r3 = await req('PUT', `/api/host/meets/${r2.json.meet.id}`, { cookie: A, body: { day: d, start: '19:00', end: '22:00', place: 'Lot', title: 'Fuel Friday' } });
  assert.equal(r3.status, 409, 'renaming onto the other one');
});

test('two different meets on one night can’t share an address (FINDING if this fails)', async () => {
  const d = ymd(7);
  const r1 = await meet(A, { day: d, title: 'Cars and Coffee', pageName: 'cars-and-coffee' });
  const r2 = await meet(A, { day: d, title: 'Cars After Dark', pageName: 'cars-and-coffee' });
  assert.equal(r1.status, 201);
  const both = await sql('SELECT id, title FROM meets WHERE page_name = ? AND day = ?', ['cars-and-coffee', d]);
  assert.ok(both.length < 2, `both meets got /cars-and-coffee/${d}; one of them can't be reached (${r2.status})`);
});

test('renaming a meet’s address keeps old links working and moves its other weeks (FINDING if this fails)', async () => {
  const r = await meet(A, { day: ymd(8), title: 'Sunday Cruise', pageName: 'sunday-cruise' });
  const id = r.json.meet.id;
  const again = await req('POST', `/api/host/meets/${id}/again`, { cookie: A });
  assert.equal(again.status, 201, again.text);
  const oldLink = `/sunday-cruise/${ymd(8)}`;
  assert.equal((await req('GET', oldLink)).status, 200);
  const e = await req('PUT', `/api/host/meets/${id}`, { cookie: A, body: { day: ymd(8), start: '19:00', end: '22:00', place: 'Lot', title: 'Sunday Cruise', pageName: 'sunday-cruise-az' } });
  assert.equal(e.status, 200, e.text);
  const old = await req('GET', oldLink);
  const weeks = await sql('SELECT day, page_name FROM meets WHERE title = ? ORDER BY day', ['Sunday Cruise']);
  assert.ok(old.status === 200 || (old.status === 301 && /sunday-cruise-az/.test(old.headers.location)), `the shared link ${oldLink} now gives ${old.status}`);
  assert.equal(new Set(weeks.map((w) => w.page_name)).size, 1, `weeks split across addresses: ${JSON.stringify(weeks)}`);
});

test('two hosts can’t end up with the same meet address, even at the same moment (FINDING if this fails)', async () => {
  const [ra, rb] = await Promise.all([meet(A, { day: ymd(9), title: 'Race One', pageName: 'tuner-takeover' }), meet(B, { day: ymd(9), title: 'Race Two', pageName: 'tuner-takeover' })]);
  const rows = await sql('SELECT DISTINCT host_id FROM meets WHERE page_name = ?', ['tuner-takeover']);
  assert.ok(rows.length <= 1, `both hosts hold /tuner-takeover (${ra.status}, ${rb.status}); the address shows whichever is newest`);
});

test('repeat next week: copies spot, map and header, refuses a duplicate, and respects the 30 upcoming limit (FINDING if this fails)', async () => {
  const r = await meet(B, { day: ymd(1), title: 'Weekly' });
  let id = r.json.meet.id;
  await req('PUT', `/api/host/meets/${id}/lot`, { cookie: B, body: { lot: { lat: 33.5, lng: -112.1, zoom: 19 } } });
  const n1 = await req('POST', `/api/host/meets/${id}/again`, { cookie: B });
  assert.equal(n1.status, 201); assert.ok(n1.json.meet.lot, 'map came along'); assert.equal(n1.json.meet.day, ymd(8));
  assert.equal((await req('POST', `/api/host/meets/${id}/again`, { cookie: B })).status, 409, 'same week twice');
  id = n1.json.meet.id;
  for (let i = 0; i < 40; i++) { const x = await req('POST', `/api/host/meets/${id}/again`, { cookie: B }); if (x.status !== 201) break; id = x.json.meet.id; }
  const up = await sql('SELECT COUNT(*) AS n FROM meets WHERE host_id = 2 AND day >= ?', [ymd(0)]);
  assert.ok(up[0].n <= 30, `${up[0].n} upcoming meets: "again" skips the 30-meet limit that posting checks`);
});

test('deleting a logo: venue, member club and meet lists let go of it; its truck stays gone (kit_gone)', async () => {
  const m = (await meet(A, { day: ymd(10), title: 'Logo Test' })).json.meet;
  const ref = m.ref;
  const venue = (await req('POST', '/api/host/kit/entry', { cookie: A, body: { kind: 'venue', name: 'LV Smoke' } })).json.logo.id;
  const club = (await req('POST', '/api/host/kit/entry', { cookie: A, body: { kind: 'group', name: 'Unforsaken' } })).json.logo.id;
  const truck = (await req('POST', '/api/host/kit/entry', { cookie: A, body: { kind: 'vendor', name: 'Birria Bros' } })).json.logo.id;
  await req('PUT', `/api/host/meets/${m.id}`, { cookie: A, body: { day: m.day, start: '19:00', end: '22:00', place: 'Lot', title: 'Logo Test', venueId: venue } });
  await req('PUT', `/api/host/meets/${m.id}/kit-vendors/${club}`, { cookie: A, body: {} });
  const mem = (await req('POST', '/api/host/members', { cookie: A, body: { name: 'Sam', car: 'Supra', clubId: club } })).json.member.id;
  const link = await req('POST', `/api/host/meets/${m.id}/send-link`, { cookie: A, body: { kitId: truck } });
  assert.equal(link.status, 201, link.text);
  const slug = (await sql('SELECT truck_slug FROM kit_logos WHERE id = ?', [truck]))[0].truck_slug;
  // The truck sets up and is in.
  const v = ctx.kitchen.state.meets[ref].vendors.find((x) => x.slug === slug); v.status = 'in';
  for (const id of [venue, club, truck]) assert.equal((await req('DELETE', `/api/host/kit/${id}`, { cookie: A })).status, 200);
  assert.equal((await sql('SELECT venue_id FROM meets WHERE id = ?', [m.id]))[0].venue_id, null);
  assert.equal((await sql('SELECT club_id FROM members WHERE id = ?', [mem]))[0].club_id, null);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM meet_kit_vendors WHERE kit_id IN (?, ?, ?)', [venue, club, truck]))[0].n, 0);
  assert.equal(v.status, 'removed', 'dropped from the meet on the food side');
  // A page view later: nothing comes back.
  await req('GET', new URL(m.url).pathname);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM kit_logos WHERE truck_slug = ?', [slug]))[0].n, 0);
  assert.equal((await sql('SELECT COUNT(*) AS n FROM host_vendors WHERE slug = ?', [slug]))[0].n, 0);
});

test('a truck deleted while the food side is down doesn’t come back in the lists (FINDING if this fails)', async () => {
  const m = (await meet(A, { day: ymd(11), title: 'Down Test' })).json.meet;
  const truck = (await req('POST', '/api/host/kit/entry', { cookie: A, body: { kind: 'vendor', name: 'Night Wings' } })).json.logo.id;
  await req('POST', `/api/host/meets/${m.id}/send-link`, { cookie: A, body: { kitId: truck } });
  const slug = (await sql('SELECT truck_slug FROM kit_logos WHERE id = ?', [truck]))[0].truck_slug;
  const v = ctx.kitchen.state.meets[m.ref].vendors.find((x) => x.slug === slug); v.status = 'in';
  // The food side stops answering just for the delete.
  const real = ctx.kitchen.srv.listeners('request')[0];
  ctx.kitchen.srv.removeAllListeners('request'); ctx.kitchen.srv.on('request', (rq) => rq.socket.destroy());
  assert.equal((await req('DELETE', `/api/host/kit/${truck}`, { cookie: A })).status, 200);
  ctx.kitchen.srv.removeAllListeners('request'); ctx.kitchen.srv.on('request', real);
  // Later, the page asks the food side again.
  await req('GET', `/api/host/meets/${m.id}/trucks`, { cookie: A });
  const page = await req('GET', new URL(m.url).pathname);
  const known = await sql('SELECT COUNT(*) AS n FROM host_vendors WHERE slug = ?', [slug]);
  assert.ok(!/Night Wings/.test(page.text) && known[0].n === 0, `deleted truck: on the meet page ${/Night Wings/.test(page.text)}, back in "trucks you've had" ${known[0].n}`);
});

test('the 30-photo limit holds when photos arrive at once (FINDING if this fails)', async () => {
  const mem = (await req('POST', '/api/host/members', { cookie: A, body: { name: 'Rush', car: 'GR86' } })).json.member.id;
  const jpg = require('fs').readFileSync(require('path').join(__dirname, '..', '.fixtures', 'photo.jpg'));
  await Promise.all(Array.from({ length: 45 }, () => req('POST', `/api/host/members/${mem}/photos`, { cookie: A, raw: { type: 'image/jpeg', buf: jpg } })));
  const n = (await sql('SELECT COUNT(*) AS n FROM member_photos WHERE member_id = ?', [mem]))[0].n;
  assert.ok(n <= 30, `${n} photos (limit 30)`);
});

test('concurrent edits of one meet: the last one wins, nothing half-written', async () => {
  const m = (await meet(A, { day: ymd(12), title: 'Edit Race' })).json.meet;
  const bodies = Array.from({ length: 10 }, (_, i) => ({ day: ymd(12), start: '19:00', end: '22:00', place: 'Lot ' + i, address: 'Addr ' + i, title: 'Edit Race', notes: 'n' + i }));
  await Promise.all(bodies.map((b) => req('PUT', `/api/host/meets/${m.id}`, { cookie: A, body: b })));
  const row = (await sql('SELECT place, address, notes FROM meets WHERE id = ?', [m.id]))[0];
  const i = row.place.split(' ')[1];
  assert.equal(row.address, 'Addr ' + i); assert.equal(row.notes, 'n' + i);
});

/* ---------- time and dates ---------- */
test('a meet crossing midnight stays live after 12 AM, and the host can still edit it (FINDING if this fails)', async (t) => {
  // Started yesterday (host's clock) at 23:59 and ends 40 minutes from now: live, its date is yesterday's.
  const tz = 'America/Phoenix';
  const later = Date.now() + 40 * 60e3;
  const p = U.parts(later, tz);
  const end = `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
  const today = U.dayKey(Date.now(), tz);
  if (U.dayKey(later, tz) !== today || end >= '23:59') return t.skip('too close to midnight to set up; run again later');
  const yday = U.addDays(today, -1);
  await sql("INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, status, page_name, created_at, updated_at) VALUES (1, 'mlive0000001', 'Late Night', ?, '23:59', ?, 'Lot', 'on', 'late-night', ?, ?)", [yday, end, Date.now(), Date.now()]);
  const home = await req('GET', '/');
  assert.match(home.text, /Late Night/, 'on the front page');
  assert.match(home.text, /Happening now/);
  const id = (await sql("SELECT id FROM meets WHERE ref = 'mlive0000001'"))[0].id;
  const e = await req('PUT', `/api/host/meets/${id}`, { cookie: A, body: { day: yday, start: '23:59', end, place: 'Lot', title: 'Late Night', notes: 'Moved to the back lot' } });
  assert.equal(e.status, 200, `editing the live meet after midnight: ${e.status} ${e.text}`);
});

test('daylight saving: a Denver host’s meets around the change have the right length', () => {
  const tz = 'America/Denver';
  const t = (day, s, e) => U.meetTimes({ day, start_time: s, end_time: e }, tz);
  const h = (x) => (x.endsAt - x.startsAt) / 3600e3;
  assert.equal(h(t('2026-10-31', '22:00', '03:00')), 6, 'over the fall-back night: 22:00 → 03:00 is 6 hours');
  assert.equal(h(t('2027-03-13', '22:00', '03:00')), 4, 'over the spring-forward night: 4 hours');
  assert.equal(U.time12(t('2026-11-01', '19:00', '22:00').startsAt, tz), '7 PM');
  const gap = t('2027-03-14', '02:30', '04:00');
  assert.ok(gap.endsAt > gap.startsAt, 'a start in the skipped hour still ends after it starts');
});

test('a canceled meet still shows (as canceled) where people look for it (FINDING if this fails)', async () => {
  const r = await meet(A, { day: ymd(1), title: 'Called Off' });
  assert.equal(r.status, 201, r.text);
  const m = r.json.meet;
  await req('POST', `/api/host/meets/${m.id}/cancel`, { cookie: A, body: {} });
  const list = await req('GET', '/meets');
  const page = await req('GET', new URL(m.url).pathname);
  assert.match(page.text, /canceled/i, 'its own page says canceled');
  assert.match(list.text, /Called Off/, 'Upcoming meets drops it without a word, so someone who saw it earlier doesn’t learn it’s off');
});

test('a meet that is over says so and stops taking orders', async () => {
  const yday = U.addDays(U.dayKey(Date.now(), 'America/Phoenix'), -2);
  await sql("INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, status, page_name, created_at, updated_at) VALUES (2, 'mover0000001', 'Old One', ?, '19:00', '22:00', 'Lot', 'on', 'old-one', ?, ?)", [yday, Date.now(), Date.now()]);
  const r = await req('GET', `/old-one/${yday}`);
  assert.match(r.text, /This meet is over/);
  assert.ok(!/Pre-order food/.test(r.text));
  assert.ok(!/Old One/.test((await req('GET', '/meets')).text));
});
