'use strict';
/* scripts/midnight-tempe.js — starts Midnight Tempe: In-N-Out Invasion (Fri Oct 23, 7–10 PM, 999 E Playa del Norte Dr
   Ste 610, Tempe) on a host's page, from the flyer and its Instagram collaborators: the meet, In-N-Out Tempe as the
   venue, the six clubs on the post under Clubs (names and Instagram; logos added in the portal), and the parking map
   opened on the address. Its own page address: midnight-tempe.<site domain>. Safe to run again: anything already
   there is kept, not doubled. The flyer, logos and zones are left for the portal.

   On the server, in the site's folder (it uses the same .env):
     node scripts/midnight-tempe.js --email you@example.com */
require('dotenv').config();
const D = require('../db');
const U = require('../util');
const K = require('../kitchen');
const N = require('../names');
const geo = require('../geo');
const LotMap = require('../public/lotmap');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const MEET = { day: '2026-10-23', start: '19:00', end: '22:00', title: 'Midnight Tempe: In-N-Out Invasion', name: 'midnight-tempe',
  place: 'In-N-Out Burger, Tempe', address: '999 E Playa del Norte Dr Ste 610, Tempe, AZ 85288',
  notes: 'Presented by AZ Driven Society with AZ Monarchy, Arizona Hellcats, AzStreetCulture, Outcast Truckin and Az.street.cars.' };
const CLUBS = [
  ['AZ Driven Society', 'azdrivensociety'], ['AZ Monarchy CC', 'azmonarchy'], ['Arizona Hellcats', 'az_hellcats'],
  ['AzStreetCulture', 'azstreetculture'], ['Outcast Truckin', 'outcasts_truckin_az'], ['Az.street.cars', 'az.street.cars'],
];
const log = (s) => console.log('· ' + s);

async function entry(host, kind, name, { instagram, note } = {}) {
  let k = await D.get('SELECT * FROM kit_logos WHERE host_id = ? AND kind = ? AND (lower(name) = lower(?) OR (instagram IS NOT NULL AND lower(instagram) = lower(?)))', [host.id, kind, name, instagram || '']);
  if (!k) {
    const ins = await D.run('INSERT INTO kit_logos (host_id, kind, name, file, instagram, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [host.id, kind, name, '', instagram || null, note || null, Date.now()]);
    k = await D.get('SELECT * FROM kit_logos WHERE id = ?', [ins.lastID]);
    log(`Added ${name} (${kind === 'group' ? 'Clubs' : 'Venues'})`);
  } else {
    if (!k.instagram && instagram) await D.run('UPDATE kit_logos SET instagram = ? WHERE id = ?', [instagram, k.id]);
    log(`${k.name} was already in your lists`);
  }
  return D.get('SELECT * FROM kit_logos WHERE id = ?', [k.id]);
}

async function main() {
  const email = String(arg('email', '')).trim().toLowerCase();
  if (!U.EMAIL_RE.test(email)) throw new Error('Add the host account’s email: node scripts/midnight-tempe.js --email you@example.com');
  await D.ensureSchema();
  const host = await D.get('SELECT * FROM hosts WHERE email = ?', [email]);
  if (!host) throw new Error(`No host account for ${email}. Sign in to the portal once with it, then run this again.`);
  log(`Host: ${host.name} (/${host.slug})`);

  const venue = await entry(host, 'venue', 'In-N-Out Burger (Tempe)', { note: 'Thanks to In-N-Out for the spot · Grab a Double-Double' });
  const clubs = [];
  for (const [name, ig] of CLUBS) clubs.push(await entry(host, 'group', name, { instagram: ig }));

  let m = await D.get('SELECT * FROM meets WHERE host_id = ? AND day = ? AND (page_name = ? OR title = ?)', [host.id, MEET.day, MEET.name, MEET.title]);
  const now = Date.now();
  if (!m) {
    const ins = await D.run(`INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, address, notes, venue_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [host.id, 'm' + D.token(10), MEET.title, MEET.day, MEET.start, MEET.end, MEET.place, MEET.address, MEET.notes, venue.id, now, now]);
    m = await D.get('SELECT * FROM meets WHERE id = ?', [ins.lastID]);
    log(`Posted ${MEET.title}, ${MEET.day}, 7–10 PM`);
  } else log(`${MEET.title} was already posted; kept as it is`);
  const nm = await N.ensure(host, m, m.page_name ? undefined : MEET.name);
  if (nm.error) { await N.ensure(host, m); log(`${MEET.name} was taken; page address is ${m.page_name}`); }
  for (const k of clubs) await D.run('INSERT OR IGNORE INTO meet_kit_vendors (meet_id, kit_id, created_at) VALUES (?, ?, ?)', [m.id, k.id, now]);
  log('The six clubs from the post are under Clubs');

  m = await D.get('SELECT * FROM meets WHERE id = ?', [m.id]);
  if (!m.lot) {
    const g = await geo.search(MEET.address);
    if (g.results && g.results[0]) {
      const lot = LotMap.clean({ lat: g.results[0].lat, lng: g.results[0].lng, zoom: 18, address: '999 E Playa del Norte Dr, Tempe', zones: [], pins: [] });
      await D.run('UPDATE meets SET lot = ? WHERE id = ?', [JSON.stringify(lot), m.id]);
      log('Parking map opened on 999 E Playa del Norte Dr; draw the zones in the portal');
    } else log(`Couldn’t find the address for the parking map (${g.error || 'no match'}); search it in the portal`);
  }

  m = await D.get('SELECT * FROM meets WHERE id = ?', [m.id]);
  if (K.on()) {
    const s = await K.syncMeet(host, m, N.meetUrl(host, m));
    await D.run('UPDATE meets SET synced_at = ?, sync_error = ? WHERE id = ?', [s.ok ? Date.now() : null, s.ok ? null : (s.data.error || 'not sent'), m.id]);
    if (!s.ok) log(`The food side didn’t take the meet yet (${s.data.error}); saving it once in the portal sends it again`);
  }
  console.log(`\nDone. ${N.meetUrl(host, m)}\n\nStill to do in the portal:\n- Flyer, header logo and background clip\n- Club logos (Settings › Clubs)\n- Parking zones on the map`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('\n' + e.message); process.exit(1); });
