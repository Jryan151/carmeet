'use strict';
/* seed.js — realistic data for a stress run: 3 hosts, 40 upcoming meets (some sharing a night, some with their own
   name address like /fuel-friday), 200 kit logos, 300 members with 10 photos each and a few feed clips, flyers and
   parking maps. Hosts and meets go through the API (so names, refs and the food side's copy are real); bulk rows
   (logos, members, photos) go straight into SQLite with real files on disk. Picture copies (.s*.webp) are made for
   everything except `withoutCopies` pictures, which section 2 uses. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { req, signIn } = require('./site');

const FIX = path.join(__dirname, '..', '.fixtures');
const U = require('../../../util');

function db(file) {
  const d = new sqlite3.Database(file);
  d.configure('busyTimeout', 10000);
  const run = (sql, p = []) => new Promise((ok, no) => d.run(sql, p, function (e) { return e ? no(e) : ok({ lastID: this.lastID, changes: this.changes }); }));
  const all = (sql, p = []) => new Promise((ok, no) => d.all(sql, p, (e, r) => (e ? no(e) : ok(r))));
  const get = (sql, p = []) => new Promise((ok, no) => d.get(sql, p, (e, r) => (e ? no(e) : ok(r))));
  return { d, run, all, get, close: () => new Promise((ok) => d.close(ok)) };
}
const tok = (n = 8) => crypto.randomBytes(n).toString('hex');

/** Copies a fixture into uploads under a new name (hard link when possible: 3000 photos cost no disk). */
function place(up, fixture, name) {
  const dst = path.join(up, name);
  try { fs.linkSync(path.join(FIX, fixture), dst); } catch (e) { fs.copyFileSync(path.join(FIX, fixture), dst); }
  return name;
}
function copies(up, base, sizes) { for (const s of sizes) place(up, `photo.s${s}.webp`, `${base}.s${s}.webp`); }

async function seed(ctx, { members = 300, photosEach = 10, withoutCopies = 200, kit = 200, meets = 40 } = {}) {
  const up = path.join(path.dirname(ctx.dbFile), 'uploads');
  const today = U.dayKey(Date.now(), 'America/Phoenix');
  const hosts = [
    { email: 'owner@tasty.test', name: 'Tasty Tuesday', slug: 'tasty-tuesday' },
    { email: 'west@side.test', name: 'West Side Nights', slug: 'west-side' },
    { email: 'crew@monarchy.test', name: 'AZ Monarchy', slug: 'az-monarchy' },
  ];
  for (const h of hosts) {
    h.cookie = await signIn(ctx, h);
    await req(ctx, 'PUT', '/api/host/settings', { cookie: h.cookie, body: { alertsOn: true, instagram: h.slug.replace(/-/g, '') } });
  }
  // Meets: each host's own weekly one, plus a second meet name with its own address; some nights carry both.
  const plan = [
    [0, 'Tasty Tuesday', 2, 'tasty-tuesday'], [0, 'Fuel Friday', 5, 'fuel-friday'], [0, 'Sunday Cruise', 0, 'sunday-cruise'],
    [1, '', 3, null], [1, 'Midnight Tempe', 3, 'midnight-tempe'], [1, 'Glendale Gathering', 6, 'glendale-gathering'],
    [2, 'AZ Monarchy', 4, null], [2, 'Monarchy Late Night', 4, 'monarchy-late'],
  ];
  const created = [];
  const dayFor = (dow, week) => { let d = today; for (let i = 0; i < 7; i++) { const x = U.addDays(today, i); if (new Date(x + 'T12:00:00Z').getUTCDay() === dow) { d = x; break; } } return U.addDays(d, 7 * week); };
  for (let week = 0; created.length < meets; week++) {
    for (const [hi, title, dow, pageName] of plan) {
      if (created.length >= meets) break;
      const h = hosts[hi];
      const r = await req(ctx, 'POST', '/api/host/meets', { cookie: h.cookie, body: { day: dayFor(dow, week), start: title.includes('Late') || title.includes('Midnight') ? '22:00' : '19:00', end: title.includes('Late') || title.includes('Midnight') ? '01:00' : '22:00',
        place: ['Lot at 35th Ave & Dunlap', 'Westgate north lot', '75th Ave & Dunlap', 'Tempe Marketplace'][created.length % 4], address: '3500 W Dunlap Ave, Phoenix, AZ', title, notes: 'Bring your best build.', pageName: pageName || undefined } });
      if (r.status !== 201) throw new Error('meet: ' + r.status + ' ' + r.text);
      created.push(Object.assign(r.json.meet, { hostIdx: hi }));
    }
  }
  const D = db(ctx.dbFile);
  const hostRows = await D.all('SELECT id, slug FROM hosts ORDER BY id');
  hosts.forEach((h) => { h.id = hostRows.find((x) => x.slug === h.slug).id; });
  // The food side: three trucks in every meet (two take cards), one invited.
  const k = ctx.kitchen.state;
  for (const m of created) {
    const km = k.meets[m.ref];
    km.vendors = [
      { inviteId: k.nextInvite++, status: 'in', slug: 'birria-bros', name: 'Birria Bros', emoji: '🌮', cardReady: true, preorders: 4, brand: { logo: '/uploads/bb.png' } },
      { inviteId: k.nextInvite++, status: 'in', slug: 'night-wings', name: 'Night Wings', emoji: '🍗', cardReady: true, preorders: 1 },
      { inviteId: k.nextInvite++, status: 'in', slug: 'desert-lemonade', name: 'Desert Lemonade', emoji: '🍋', payAtTruck: true },
      { inviteId: k.nextInvite++, status: 'invited', slug: 'boba-spot', name: 'Boba Spot', hostProfile: true },
    ];
  }
  // Background videos for every host, ready.
  const vid = () => { const id = tok(10); place(up, 'loop.mp4', `bg-${id}.mp4`); place(up, 'loop.jpg', `bg-${id}.jpg`); copies(up, `bg-${id}`, [24, 480, 1280]); return id; };
  for (const h of hosts) { const id = vid(); await D.run("UPDATE hosts SET video = ?, video_poster = ?, video_status = 'ready' WHERE id = ?", [`bg-${id}.mp4`, `bg-${id}.jpg`, h.id]); }
  // Flyers on half the meets, parking maps on twenty.
  const lot = { lat: 33.5677, lng: -112.1336, zoom: 19, address: '3500 W Dunlap', zones: [
    { kind: 'club', label: 'Unforsaken', pts: [{ lat: 33.5679, lng: -112.1339 }, { lat: 33.5679, lng: -112.1334 }, { lat: 33.5677, lng: -112.1334 }, { lat: 33.5677, lng: -112.1339 }] },
    { kind: 'vendors', label: '', pts: [{ lat: 33.5676, lng: -112.1338 }, { lat: 33.5676, lng: -112.1335 }, { lat: 33.5675, lng: -112.1335 }] }],
  pins: [{ kind: 'enter', lat: 33.5678, lng: -112.1337 }, { kind: 'food', label: 'Trucks', lat: 33.5676, lng: -112.1336 }] };
  for (let i = 0; i < created.length; i++) {
    const m = created[i];
    if (i % 2 === 0) { const f = `${tok(12)}.jpg`; place(up, 'photo.jpg', f); copies(up, f.replace('.jpg', ''), [24, 480, 1080]); await D.run('UPDATE meets SET flyer = ? WHERE id = ?', [f, m.id]); m.flyer = f; }
    if (i < 20) await D.run('UPDATE meets SET lot = ? WHERE id = ?', [JSON.stringify(lot), m.id]);
  }
  // 200 kit logos: Food vendors (30 with profile pages on), Clubs, Vendors, Venues; eight on each meet's page.
  const kinds = [['vendor', 80], ['group', 60], ['sponsor', 40], ['venue', 20]];
  const kitRows = [];
  let n = 0;
  for (const [kind, count] of kinds) {
    for (let i = 0; i < count && n < kit; i++, n++) {
      const h = hosts[n % 3];
      const file = `logo-${tok(8)}-k.png`; place(up, 'logo.png', file); copies(up, file.replace('.png', ''), [256, 512, 720]);
      const name = `${kind === 'vendor' ? 'Truck' : kind === 'group' ? 'Club' : kind === 'venue' ? 'Venue' : 'Shop'} ${i + 1}`;
      const pageSlug = kind === 'vendor' && i < 30 ? `truck-${i + 1}` : null;
      const ins = await D.run('INSERT INTO kit_logos (host_id, kind, name, file, instagram, created_at, page_slug, page_on, about, serves) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [h.id, kind, name, file, name.toLowerCase().replace(/ /g, ''), Date.now(), pageSlug, pageSlug ? 1 : 0, pageSlug ? 'Family recipes since 2015.' : null, pageSlug ? 'Tacos, birria, aguas frescas' : null]);
      kitRows.push({ id: ins.lastID, hostId: h.id, kind, pageSlug, file });
      if (pageSlug) for (let p = 0; p < 6; p++) { const f = `${tok(12)}.jpg`; place(up, 'photo.jpg', f); copies(up, f.replace('.jpg', ''), [480]); await D.run("INSERT INTO kit_media (kit_id, host_id, kind, file, created_at) VALUES (?, ?, 'photo', ?, ?)", [ins.lastID, h.id, f, Date.now()]); }
    }
  }
  for (const m of created) {
    const mine = kitRows.filter((x) => x.hostId === hosts[m.hostIdx].id && x.kind !== 'venue');
    for (let j = 0; j < 8; j++) { const x = mine[(m.id * 3 + j * 7) % mine.length]; await D.run('INSERT OR IGNORE INTO meet_kit_vendors (meet_id, kit_id, created_at) VALUES (?, ?, ?)', [m.id, x.id, Date.now() + j]); }
  }
  // 300 members, 10 photos each (the last `withoutCopies` photos get no WebP copies yet), a few feed clips.
  const clubs = kitRows.filter((x) => x.kind === 'group');
  const memberRows = [];
  const noCopy = [];
  const totalPhotos = members * photosEach;
  let pi = 0;
  await D.run('BEGIN');
  for (let i = 0; i < members; i++) {
    const h = hosts[i % 3];
    const club = clubs.filter((c) => c.hostId === h.id)[i % 20];
    const key = crypto.randomBytes(20).toString('hex');
    const handle = `driver-${i + 1}`;
    const ins = await D.run('INSERT INTO members (host_id, club_id, handle, name, car, mods, instagram, about, edit_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [h.id, club ? club.id : null, handle, i % 4 ? `Driver ${i + 1}` : '', ['2019 Civic Type R', 'E46 M3', 'Supra MK4', 'GR86'][i % 4], 'Stage 2 tune\nCoilovers\nWide body', `drv${i + 1}`, 'Weekend builds.',
        crypto.createHash('sha256').update('member:' + key).digest('hex'), Date.now(), Date.now()]);
    memberRows.push({ id: ins.lastID, handle, key, hostId: h.id });
    for (let p = 0; p < photosEach; p++, pi++) {
      const f = `${tok(12)}.jpg`; place(up, 'photo.jpg', f);
      if (pi < totalPhotos - withoutCopies) copies(up, f.replace('.jpg', ''), [256, 480, 1080]); else noCopy.push({ file: f, handle });
      await D.run('INSERT INTO member_photos (member_id, file, caption, created_at) VALUES (?, ?, ?, ?)', [ins.lastID, f, p % 3 ? '' : 'Night shot', Date.now()]);
    }
    if (i % 60 === 0) { const id = tok(10); place(up, 'loop.mp4', `bg-${id}.mp4`); place(up, 'loop.jpg', `bg-${id}.jpg`); copies(up, `bg-${id}`, [256, 480, 1080]);
      await D.run("INSERT INTO member_photos (member_id, kind, file, poster, status, created_at) VALUES (?, 'video', ?, ?, 'ready', ?)", [ins.lastID, `bg-${id}.mp4`, `bg-${id}.jpg`, Date.now()]); }
  }
  await D.run('COMMIT');
  await D.close();
  const meetNames = [...new Set(created.map((m) => m.pageName).filter((x) => x && !['tasty-tuesday', 'west-side', 'az-monarchy', 'west-side-nights'].includes(x)))];
  return { hosts, meets: created, kit: kitRows, members: memberRows, noCopy, meetNames, vendorSlugs: kitRows.filter((x) => x.pageSlug).map((x) => x.pageSlug), uploads: up };
}

module.exports = { seed, db };
