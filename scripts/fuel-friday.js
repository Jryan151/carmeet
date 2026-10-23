'use strict';
/* scripts/fuel-friday.js — sets up Fuel Friday (Fri Oct 23, 5112 W Peoria Ave, Glendale) on a host's page, from the
   flyer and Instagram posts: the meet, the flyer as the page's main picture, LV Smoke Shop as the venue, México en
   un Vaso under Food, Slow Traffic AZ and Unforsaken under Clubs, and the parking map opened on the address (the
   zones are drawn in the portal). Safe to run again: anything already there is kept, not doubled.

   On the server, in the site's folder (it uses the same .env):
     node scripts/fuel-friday.js --email you@example.com [--start 19:00 --end 23:00]
   The email is the host account's sign-in. With no account for it yet, one is made: AZ Monarchy, /azmonarchy. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const D = require('../db');
const U = require('../util');
const K = require('../kitchen');
const V = require('../video');
const geo = require('../geo');
const LotMap = require('../public/lotmap');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const ASSETS = path.join(__dirname, 'fuel-friday');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const MEET = { day: '2026-10-23', title: 'Fuel Friday', place: 'LV Smoke Shop lot', address: '5112 W Peoria Ave, Glendale, AZ 85302',
  notes: 'Thanks to LV Smoke Shop for letting us host.' };
const said = [];
const log = (s) => { said.push(s); console.log('· ' + s); };

/** A file from the kit folder into the uploads, with a fresh name; logos get the same trim as a portal upload. */
async function upload(file, { logo } = {}) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = D.token(12) + path.extname(file);
  fs.copyFileSync(path.join(ASSETS, file), path.join(UPLOAD_DIR, name));
  if (logo && V.ffmpegOk()) {
    const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR).catch(() => null);
    if (trimmed) { fs.unlinkSync(path.join(UPLOAD_DIR, name)); return trimmed; }
  }
  return name;
}
/** One of the host's lists (Food vendors, Clubs, Venues): found by name, or added. A logo only where there's none. */
async function entry(host, kind, name, { file, instagram, note } = {}) {
  let k = await D.get('SELECT * FROM kit_logos WHERE host_id = ? AND kind = ? AND lower(name) = lower(?)', [host.id, kind, name]);
  if (!k) {
    const ins = await D.run('INSERT INTO kit_logos (host_id, kind, name, file, instagram, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [host.id, kind, name, file ? await upload(file, { logo: true }) : '', instagram || null, note || null, Date.now()]);
    k = await D.get('SELECT * FROM kit_logos WHERE id = ?', [ins.lastID]);
    log(`Added ${name} (${{ vendor: 'Food vendors', group: 'Clubs', venue: 'Venues' }[kind]})`);
  } else {
    if (!k.file && file) await D.run('UPDATE kit_logos SET file = ? WHERE id = ?', [await upload(file, { logo: true }), k.id]);
    if (!k.instagram && instagram) await D.run('UPDATE kit_logos SET instagram = ? WHERE id = ?', [instagram, k.id]);
    if (!k.note && note) await D.run('UPDATE kit_logos SET note = ? WHERE id = ?', [note, k.id]);
    log(`${name} was already in your lists`);
  }
  return D.get('SELECT * FROM kit_logos WHERE id = ?', [k.id]);
}

async function main() {
  const email = String(arg('email', '')).trim().toLowerCase();
  if (!U.EMAIL_RE.test(email)) throw new Error('Add the host account’s email: node scripts/fuel-friday.js --email you@example.com');
  const start = arg('start', '19:00'), end = arg('end', '23:00');
  if (!U.TIME_RE.test(start) || !U.TIME_RE.test(end)) throw new Error('--start and --end are 24-hour times, like 19:00 and 23:00.');
  await D.ensureSchema();

  // The host: AZ Monarchy.
  let host = await D.get('SELECT * FROM hosts WHERE email = ?', [email]);
  if (!host) {
    const slug = (await D.get("SELECT 1 AS x FROM hosts WHERE slug = 'azmonarchy'")) ? 'az-monarchy' : 'azmonarchy';
    const now = Date.now();
    const ins = await D.run('INSERT INTO hosts (slug, name, email, city, instagram, rules, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [slug, 'AZ Monarchy', email, 'Glendale', 'azmonarchy', 'No burnouts or revving\nPark straight, leave room to walk\nTake your trash with you', process.env.TIMEZONE || 'America/Phoenix', now, now]);
    host = await D.get('SELECT * FROM hosts WHERE id = ?', [ins.lastID]);
    log(`Made the host page AZ Monarchy (/${slug}) for ${email}`);
  } else log(`Host: ${host.name} (/${host.slug})`);
  if (!host.instagram) { await D.run("UPDATE hosts SET instagram = 'azmonarchy' WHERE id = ?", [host.id]); log('Host Instagram set to @azmonarchy'); }
  if (!host.logo) log('No page logo yet: upload the AZ Monarchy logo in Settings › Logo (the flyer’s copy is too rough for the top of the page)');
  host = await D.get('SELECT * FROM hosts WHERE id = ?', [host.id]);

  // Who's on the flyer.
  const lv = await entry(host, 'venue', 'LV Smoke Shop', { file: 'lv.png', instagram: 'lvsmokeshop', note: 'Your neighborhood smoke shop · Open daily' });
  const mexico = await entry(host, 'vendor', 'México en un Vaso', { file: 'mexico.png' });
  const slow = await entry(host, 'group', 'Slow Traffic AZ', { file: 'slowtraffic.png' });
  const unf = await entry(host, 'group', 'Unforsaken', { file: 'unforsaken.png' });

  // The meet.
  let m = await D.get('SELECT * FROM meets WHERE host_id = ? AND day = ?', [host.id, MEET.day]);
  const now = Date.now();
  if (!m) {
    const ins = await D.run(`INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, address, notes, venue_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [host.id, 'm' + D.token(10), MEET.title, MEET.day, start, end, MEET.place, MEET.address, MEET.notes, lv.id, now, now]);
    m = await D.get('SELECT * FROM meets WHERE id = ?', [ins.lastID]);
    log(`Posted Fuel Friday, ${MEET.day}, ${start}–${end}`);
  } else {
    await D.run('UPDATE meets SET title = COALESCE(NULLIF(title, \'\'), ?), address = COALESCE(NULLIF(address, \'\'), ?), notes = COALESCE(NULLIF(notes, \'\'), ?), venue_id = COALESCE(venue_id, ?), updated_at = ? WHERE id = ?',
      [MEET.title, MEET.address, MEET.notes, lv.id, now, m.id]);
    log(`Your meet on ${MEET.day} was already posted (${m.start_time}–${m.end_time}); filled in what it was missing`);
  }
  if (!m.flyer) {
    await D.run('UPDATE meets SET flyer = ? WHERE id = ?', [await upload('flyer.jpg'), m.id]);
    log('Flyer set as the page’s main picture');
  }
  for (const k of [mexico, slow, unf]) await D.run('INSERT OR IGNORE INTO meet_kit_vendors (meet_id, kit_id, created_at) VALUES (?, ?, ?)', [m.id, k.id, now]);
  log('México en un Vaso under Food; Slow Traffic AZ and Unforsaken under Clubs');

  // The parking map, opened on the address (the zones get drawn in the portal).
  m = await D.get('SELECT * FROM meets WHERE id = ?', [m.id]);
  if (!m.lot) {
    const g = await geo.search(MEET.address);
    if (g.results && g.results[0]) {
      const lot = LotMap.clean({ lat: g.results[0].lat, lng: g.results[0].lng, zoom: 18, address: '5112 W Peoria Ave, Glendale', zones: [], pins: [] });
      await D.run('UPDATE meets SET lot = ? WHERE id = ?', [JSON.stringify(lot), m.id]);
      log('Parking map opened on 5112 W Peoria Ave; draw the zones in the portal');
    } else log(`Couldn’t find the address for the parking map (${g.error || 'no match'}); search it in the portal`);
  }

  // The food side hears about the meet (its trucks' menus follow it).
  m = await D.get('SELECT * FROM meets WHERE id = ?', [m.id]);
  const scheme = process.env.PUBLIC_SCHEME || 'https', domain = String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
  const pageUrl = host.domain_on && host.custom_domain ? `${scheme}://${host.custom_domain}` : `${scheme}://${domain}/${host.slug}`;
  if (K.on()) {
    const s = await K.syncMeet(host, m, `${pageUrl}/${m.day}`);
    await D.run('UPDATE meets SET synced_at = ?, sync_error = ? WHERE id = ?', [s.ok ? Date.now() : null, s.ok ? null : (s.data.error || 'not sent'), m.id]);
    if (!s.ok) log(`The food side didn’t take the meet yet (${s.data.error}); saving it once in the portal sends it again`);
  }
  console.log(`\nDone. ${pageUrl}\n\nStill to do in the portal:\n- Check the time (set to ${m.start_time}–${m.end_time})\n- Parking map: Move › From a picture › scripts/fuel-friday/parking.jpg (the marked-up lot): line it up on the
  satellite, Use these. That's every row and both entrances; then name the club rows in the list\n- Instagram for México en un Vaso, Slow Traffic AZ and Unforsaken (Settings › Food vendors / Clubs)\n- Swap in clean logo files when you have them (these are cut from the flyer)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n' + e.message); process.exit(1); });
