'use strict';
/* host.js — the host portal's API (/api/host). Sign in with a code sent by email (no password to forget).
   Dashboard, meets, trucks, updates, turnout and history, recaps, settings. Hosts see counts from the food side
   (trucks in, pre-orders paid), never a truck's money. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const D = require('./db');
const U = require('./util');
const K = require('./kitchen');
const mail = require('./mail');
const { run, get, all } = D;

const V = require('./video');
const Vw = require('./views');
const LotMap = require('./public/lotmap');
const geo = require('./geo');
const N = require('./names');
const SESSION_MS = 60 * 864e5;
const CODE_MS = 15 * 60 * 1000;
const SCHEME = () => process.env.PUBLIC_SCHEME || 'https';
const SITE_DOMAIN = () => String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
const SITE = () => process.env.SITE_NAME || 'Meet Night';
const linkSecret = (() => { let s = process.env.LINK_SECRET; if (!s || s.length < 24) s = crypto.randomBytes(24).toString('hex'); return () => s; })();
/** An unsubscribe link that works without storing a token per email: the subscriber's id, signed. */
const offSig = (id) => crypto.createHmac('sha256', linkSecret()).update('off:' + id).digest('hex').slice(0, 32);
function offOk(s) { const [id, sig] = String(s || '').split('.'); return /^\d+$/.test(id || '') && sig && crypto.timingSafeEqual(Buffer.from(offSig(id)), Buffer.from(sig.padEnd(32).slice(0, 32))) ? +id : 0; }

/** The site owner (SITE_OWNER_EMAIL) also sets the front page's background video. */
const isOwner = (h) => !!process.env.SITE_OWNER_EMAIL && String(h.email).toLowerCase() === String(process.env.SITE_OWNER_EMAIL).trim().toLowerCase();
const videoShape = (x) => ({ status: x.video_status || null, url: x.video ? '/uploads/' + x.video : null, poster: x.video_poster ? '/uploads/' + x.video_poster : null,
  thumb: x.video_poster ? require('./views').small(x.video_poster, 480) : null, hevc: x.video_hevc ? '/uploads/' + x.video_hevc : null, error: x.video_error || null });

function cookieOf(req, name) {
  const c = String(req.headers.cookie || '');
  for (const part of c.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
  return '';
}

module.exports = function hostApi({ trucksFor, truckCache, UPLOAD_DIR, tzOf }) {
  const r = express.Router();
  const hits = new Map();
  const limited = (key, max, ms) => { const now = Date.now(); let e = hits.get(key); if (!e || e.reset < now) { e = { n: 0, reset: now + ms }; hits.set(key, e); } return ++e.n > max; };
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 10 * 60 * 1000).unref();

  // Writes only from this site's own pages.
  r.use((req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) return next();
    const o = req.get('origin');
    if (o) { try { if (new URL(o).host !== req.get('host')) return res.status(403).json({ error: 'Blocked.' }); } catch (e) { return res.status(403).json({ error: 'Blocked.' }); } }
    next();
  });

  async function session(req) {
    const t = cookieOf(req, 'mh_session');
    if (!/^[a-f0-9]{48}$/.test(t)) return null;
    const s = await get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', [D.sha(t), Date.now()]);
    return s ? get('SELECT * FROM hosts WHERE id = ?', [s.host_id]) : null;
  }
  const signedIn = async (req, res, next) => { req.me = await session(req); if (!req.me) return res.status(401).json({ error: 'Sign in again.' }); next(); };
  function setSession(res, t) {
    res.cookie('mh_session', t, { httpOnly: true, sameSite: 'lax', secure: SCHEME() === 'https', maxAge: SESSION_MS, path: '/' });
  }

  /* ---------- sign in ---------- */
  r.post('/code', async (req, res) => {
    const email = U.clean((req.body || {}).email, 120).toLowerCase();
    if (!U.EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email doesn’t look right.' });
    if (limited('code:' + (req.ip || ''), 8, 15 * 60000) || limited('code:' + email, 4, 15 * 60000)) return res.status(429).json({ error: 'Too many codes. Wait a few minutes.' });
    const code = String(crypto.randomInt(100000, 1000000));
    await run('INSERT INTO login_codes (email, code_hash, expires_at, tries, sent_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0, sent_at = excluded.sent_at',
      [email, D.sha(email + ':' + code), Date.now() + CODE_MS, Date.now()]);
    const known = !!(await get('SELECT 1 AS x FROM hosts WHERE email = ?', [email]));
    await mail.send({ key: 'code-' + D.sha(email + code + Date.now()).slice(0, 24), to: email, subject: `${code} is your ${SITE()} code`,
      text: `Your sign-in code is ${code}. It works for 15 minutes.\n\nDidn't ask for it? Ignore this email.`,
      html: mail.shell({ from: SITE(), title: `Your code: ${code}`, html: '<p>Type it on the sign-in page. It works for 15 minutes.</p>', footer: 'Didn’t ask for it? Ignore this email.' }) }).catch(() => {});
    const dev = process.env.DEV_CODES === 'true' && process.env.NODE_ENV !== 'production' ? { devCode: code } : {};
    res.json(Object.assign({ ok: true, known }, dev));
  });

  /* A password that opens one host's portal (DEMO_PASSWORD and DEMO_HOST in .env), for a host trying it before
     they sign in with their own email. Off unless both are set. */
  const demoHost = () => (process.env.DEMO_PASSWORD && process.env.DEMO_HOST ? String(process.env.DEMO_HOST).toLowerCase() : null);
  r.get('/sign-in-options', (req, res) => res.set('Cache-Control', 'no-store').json({ password: !!demoHost() }));
  r.post('/password', async (req, res) => {
    if (!demoHost()) return res.status(404).json({ error: 'Sign in with your email.' });
    if (limited('pw:' + (req.ip || ''), 10, 15 * 60000)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const given = D.sha('pw:' + String((req.body || {}).password || ''));
    const want = D.sha('pw:' + process.env.DEMO_PASSWORD);
    if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return res.status(400).json({ error: 'That password isn’t right.' });
    const host = await get('SELECT * FROM hosts WHERE slug = ? OR lower(email) = ?', [demoHost(), demoHost()]);
    if (!host) return res.status(404).json({ error: 'That workspace isn’t set up yet.' });
    const t = D.token(24);
    await run('INSERT INTO sessions (token_hash, host_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [D.sha(t), host.id, Date.now() + SESSION_MS, Date.now()]);
    setSession(res, t);
    res.json({ ok: true });
  });

  r.post('/login', async (req, res) => {
    const b = req.body || {};
    const email = U.clean(b.email, 120).toLowerCase();
    const code = String(b.code || '').replace(/\D/g, '');
    if (limited('login:' + (req.ip || ''), 20, 15 * 60000)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const row = await get('SELECT * FROM login_codes WHERE email = ?', [email]);
    if (!row || row.expires_at < Date.now() || row.tries >= 5) return res.status(400).json({ error: 'That code expired. Get a new one.' });
    if (D.sha(email + ':' + code) !== row.code_hash) { await run('UPDATE login_codes SET tries = tries + 1 WHERE email = ?', [email]); return res.status(400).json({ error: 'That code isn’t right.' }); }
    let host = await get('SELECT * FROM hosts WHERE email = ?', [email]);
    if (!host) {
      // New host: their page name and address.
      const name = U.clean(b.name, 60);
      const slug = String(b.slug || '').toLowerCase().trim();
      if (!name) return res.status(400).json({ error: 'What’s your meet called?', needsName: true });
      if (!U.SLUG_RE.test(slug) || U.RESERVED.has(slug)) return res.status(400).json({ error: 'Pick a page address: 3 to 40 letters, numbers or dashes.', needsName: true });
      if (await get('SELECT 1 AS x FROM hosts WHERE slug = ?', [slug]) || await get('SELECT 1 AS x FROM meets WHERE page_name = ?', [slug])) return res.status(409).json({ error: 'That address is taken. Try another.', needsName: true });
      const now = Date.now();
      const ins = await run(`INSERT INTO hosts (slug, name, email, city, rules, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [slug, name, email, U.clean(b.city, 60), 'No burnouts or revving\nPark straight, leave room to walk\nTake your trash with you', process.env.TIMEZONE || 'America/Phoenix', now, now]);
      host = await get('SELECT * FROM hosts WHERE id = ?', [ins.lastID]);
    }
    await run('DELETE FROM login_codes WHERE email = ?', [email]);
    const t = D.token(24);
    await run('INSERT INTO sessions (token_hash, host_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [D.sha(t), host.id, Date.now() + SESSION_MS, Date.now()]);
    setSession(res, t);
    res.json({ ok: true });
  });
  r.post('/logout', async (req, res) => {
    const t = cookieOf(req, 'mh_session');
    if (t) await run('DELETE FROM sessions WHERE token_hash = ?', [D.sha(t)]);
    res.clearCookie('mh_session', { path: '/' });
    res.json({ ok: true });
  });

  /* ---------- shapes ---------- */
  const pageUrl = (h) => (h.domain_on && h.custom_domain ? `${SCHEME()}://${h.custom_domain}` : `${SCHEME()}://${SITE_DOMAIN()}/${h.slug}`);
  function hostShape(h) {
    return { name: h.name, slug: h.slug, email: h.email, tagline: h.tagline || '', city: h.city || '', accent: h.accent || '', logo: h.logo || '',
      instagram: h.instagram || '', tiktok: h.tiktok || '', youtube: h.youtube || '', rules: h.rules || '', closeMinutes: h.close_minutes,
      timezone: h.timezone || '', mapTiles: geo.tiles(), mapCredit: geo.credit(), customDomain: h.custom_domain || '', domainOn: !!h.domain_on, pageUrl: pageUrl(h), siteName: SITE(), foodOn: K.on(), mailOn: mail.configured(),
      video: videoShape(h), videoReady: V.ffmpegOk(), owner: isOwner(h), alertsOn: !!h.alerts_on, namesOn: true, siteDomain: SITE_DOMAIN() };
  }
  function meetShape(m, h) {
    const tz = tzOf(h); const t = U.meetTimes(m, tz);
    return { id: m.id, ref: m.ref, title: m.title || '', day: m.day, start: m.start_time, end: m.end_time, place: m.place, address: m.address || '', notes: m.notes || '',
      status: m.status, startsAt: t.startsAt, endsAt: t.endsAt, label: `${U.dayShort(t.startsAt, tz)}, ${U.time12(t.startsAt, tz)}–${U.time12(t.endsAt, tz)}`,
      over: t.endsAt < Date.now(), people: m.turnout_people, cars: m.turnout_cars, video: videoShape(m), flyer: m.flyer ? '/uploads/' + m.flyer : null, lot: LotMap.clean(m.lot), venueId: m.venue_id || null, logo: m.logo ? '/uploads/' + m.logo : null, synced: !!m.synced_at && !m.sync_error, syncError: m.sync_error || '', url: N.meetUrl(h, m),
      pageName: m.page_name || '', nameUrl: N.onName(h, m) ? N.nameUrl(h, m) : null, namesOn: true, siteDomain: SITE_DOMAIN() };
  }
  async function sync(h, m) {
    const s = await K.syncMeet(h, m, N.meetUrl(h, m));
    await run('UPDATE meets SET synced_at = ?, sync_error = ? WHERE id = ?', [s.ok ? Date.now() : null, s.ok ? null : (s.data.error || 'not sent'), m.id]);
    truckCache.delete(m.ref);
    return s;
  }
  // The look of the trucks' menus follows the host's page (logo, video, colors): re-send upcoming meets when it changes.
  async function refreshLook(hostId) {
    try {
      const h = await get('SELECT * FROM hosts WHERE id = ?', [hostId]);
      for (const m of await all("SELECT * FROM meets WHERE host_id = ? AND day >= ? AND status = 'on'", [h.id, U.addDays(U.dayKey(Date.now(), tzOf(h)), -1)])) await sync(h, m);
    } catch (e) { console.error('refresh look:', e.message); }
  }
  const own = (req, id) => get('SELECT * FROM meets WHERE id = ? AND host_id = ?', [parseInt(id, 10) || 0, req.me.id]);
  async function nextMeet(h) {
    const tz = tzOf(h);
    const rows = await all("SELECT * FROM meets WHERE host_id = ? AND day >= ? ORDER BY day, start_time LIMIT 6", [h.id, U.addDays(U.dayKey(Date.now(), tz), -1)]);
    return rows.find((m) => U.meetTimes(m, tz).endsAt > Date.now() && m.status === 'on') || null;
  }

  r.get('/me', signedIn, async (req, res) => res.set('Cache-Control', 'no-store').json({ host: hostShape(req.me) }));

  /* ---------- dashboard: the next meet at a glance ---------- */
  r.get('/dashboard', signedIn, async (req, res) => {
    const h = req.me;
    const m = await nextMeet(h);
    const subs = await get('SELECT COUNT(*) AS n FROM subscribers WHERE host_id = ? AND verified_at IS NOT NULL AND off_at IS NULL', [h.id]);
    const reqs = await get("SELECT COUNT(*) AS n FROM vendor_requests WHERE host_id = ? AND status = 'new'", [h.id]);
    const toLog = await all('SELECT * FROM meets WHERE host_id = ? AND turnout_people IS NULL AND status = ? ORDER BY day DESC LIMIT 3', [h.id, 'on']);
    const unlogged = toLog.filter((x) => U.meetTimes(x, tzOf(h)).endsAt < Date.now() && U.meetTimes(x, tzOf(h)).endsAt > Date.now() - 14 * 864e5).map((x) => meetShape(x, h));
    let trucks = [];
    if (m) trucks = (await trucksFor(m, { fresh: true })).map(truckShape);
    const last = await get('SELECT * FROM meets WHERE host_id = ? AND turnout_people IS NOT NULL ORDER BY day DESC LIMIT 1', [h.id]);
    res.set('Cache-Control', 'no-store').json({ host: hostShape(h), meet: m ? meetShape(m, h) : null, trucks, preorders: trucks.reduce((n, v) => n + (v.preorders || 0), 0),
      subscribers: subs.n, requests: reqs.n, unlogged, last: last ? meetShape(last, h) : null });
  });
  const truckShape = (v) => ({ inviteId: v.inviteId, status: v.status, code: v.code, slug: v.slug || null, name: v.name || null, emoji: v.emoji || '',
    cardReady: !!v.cardReady, payAtTruck: !!v.payAtTruck, paused: !!v.paused, openNow: !!v.openNow, setUp: v.setUp !== false, hostProfile: !!v.hostProfile, preorders: v.preorders || 0, plates: v.plates === undefined ? null : v.plates });

  /* ---------- meets ---------- */
  r.get('/meets', signedIn, async (req, res) => {
    const h = req.me; const tz = tzOf(h);
    const rows = await all('SELECT * FROM meets WHERE host_id = ? AND day >= ? ORDER BY day, start_time LIMIT 40', [h.id, U.addDays(U.dayKey(Date.now(), tz), -1)]);
    res.set('Cache-Control', 'no-store').json({ meets: rows.filter((m) => U.meetTimes(m, tz).endsAt > Date.now()).map((m) => meetShape(m, h)), today: U.dayKey(Date.now(), tz) });
  });
  const row0 = (id) => get('SELECT * FROM meets WHERE id = ?', [id]);
  /** A meet at a saved location with no parking map of its own starts from the location's. */
  async function lotFromVenue(p) {
    const m = await p;
    if (!m || m.lot || !m.venue_id) return;
    const k = await get("SELECT lot FROM kit_logos WHERE id = ? AND host_id = ? AND kind = 'venue'", [m.venue_id, m.host_id]);
    const lot = k && LotMap.clean(k.lot);
    if (lot) await run('UPDATE meets SET lot = ? WHERE id = ?', [JSON.stringify(lot), m.id]);
  }
  /** Two different meets can be on the same night (Fuel Friday and Midnight Tempe); the same meet twice can't. */
  async function sameMeetThatDay(h, day, title, notId) {
    const name = (t) => String(t || '').trim().toLowerCase() || String(h.name).trim().toLowerCase();
    const rows = await all('SELECT id, title FROM meets WHERE host_id = ? AND day = ? AND id != ?', [h.id, day, notId || 0]);
    return rows.some((x) => name(x.title) === name(title));
  }
  function readMeet(b, h) {
    const day = String(b.day || ''); const start = String(b.start || ''); const end = String(b.end || '');
    if (!U.validDate(day)) return { error: 'Pick a date.' };
    if (day < U.dayKey(Date.now(), tzOf(h))) return { error: 'That date already passed.' };
    if (!U.TIME_RE.test(start) || !U.TIME_RE.test(end) || start === end) return { error: 'Set a start and end time.' };
    const place = U.clean(b.place, 80);
    if (!place) return { error: 'Where is it?' };
    return { day, start_time: start, end_time: end, place, address: U.clean(b.address, 160), title: U.clean(b.title, 80), notes: U.cleanBlock(b.notes, 300), venueId: b.venueId, pageName: b.pageName };
  }
  /** The venue picked for a meet: one of this host's Venues, or none. */
  async function venueOf(h, id) {
    const n = parseInt(id, 10);
    if (!n) return null;
    const k = await get("SELECT id FROM kit_logos WHERE id = ? AND host_id = ? AND kind = 'venue'", [n, h.id]);
    return k ? k.id : null;
  }
  r.post('/meets', signedIn, async (req, res) => {
    const h = req.me;
    const m = readMeet(req.body || {}, h);
    if (m.error) return res.status(400).json({ error: m.error });
    if (await sameMeetThatDay(h, m.day, m.title)) return res.status(409).json({ error: 'You already have this meet that day. Edit that one instead.' });
    const n = await get('SELECT COUNT(*) AS n FROM meets WHERE host_id = ? AND day >= ?', [h.id, U.dayKey(Date.now(), tzOf(h))]);
    if (n.n >= 30) return res.status(400).json({ error: 'You have 30 meets coming up. That’s the limit for now.' });
    const now = Date.now();
    const ins = await run('INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, address, notes, venue_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [h.id, 'm' + D.token(10), m.title, m.day, m.start_time, m.end_time, m.place, m.address, m.notes, await venueOf(h, m.venueId), now, now]);
    await lotFromVenue(row0(ins.lastID));
    const row = await get('SELECT * FROM meets WHERE id = ?', [ins.lastID]);
    const nm = await N.ensure(h, row, m.pageName);
    await sync(h, row);
    if ((req.body || {}).tellAlerts === true) await tellAlerts(h, row, 'new');
    if (nm.error) return res.status(201).json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [row.id]), h), warning: nm.error });
    res.status(201).json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [row.id]), h) });
  });
  r.put('/meets/:id', signedIn, async (req, res) => {
    const h = req.me;
    const old = await own(req, req.params.id);
    if (!old) return res.status(404).json({ error: 'That meet is gone.' });
    const m = readMeet(req.body || {}, h);
    if (m.error) return res.status(400).json({ error: m.error });
    if (m.pageName && String(m.pageName).toLowerCase() !== old.page_name) {
      const nm = await N.ensure(h, Object.assign({}, old), m.pageName);
      if (nm.error) return res.status(400).json({ error: nm.error });
    }
    if ((m.day !== old.day || m.title !== (old.title || '')) && (await sameMeetThatDay(h, m.day, m.title, old.id))) return res.status(409).json({ error: 'You already have this meet that day.' });
    await run('UPDATE meets SET title = ?, day = ?, start_time = ?, end_time = ?, place = ?, address = ?, notes = ?, venue_id = ?, updated_at = ? WHERE id = ?',
      [m.title, m.day, m.start_time, m.end_time, m.place, m.address, m.notes, await venueOf(h, m.venueId), Date.now(), old.id]);
    await lotFromVenue(row0(old.id));
    const row = await get('SELECT * FROM meets WHERE id = ?', [old.id]);
    await N.ensure(h, row);
    await sync(h, row);
    const moved = old.day !== row.day || old.start_time !== row.start_time || old.end_time !== row.end_time || old.place !== row.place || old.address !== row.address;
    if (moved && (req.body || {}).tellAlerts === true) await tellAlerts(h, row, 'moved');
    res.json({ meet: meetShape(row, h) });
  });
  // Next week, same time and place: the usual way a weekly meet gets posted.
  r.post('/meets/:id/again', signedIn, async (req, res) => {
    const h = req.me;
    const src = await own(req, req.params.id);
    if (!src) return res.status(404).json({ error: 'That meet is gone.' });
    let day = U.addDays(src.day, 7);
    const today = U.dayKey(Date.now(), tzOf(h));
    while (day < today) day = U.addDays(day, 7);
    if (await sameMeetThatDay(h, day, src.title || '')) return res.status(409).json({ error: `You already have this meet on ${day}.` });
    const now = Date.now();
    // Same spot, same parking map, same header logo (its own copy, so changing one week never touches another).
    let logo = null;
    if (src.logo) {
      const name = D.token(12) + (path.extname(src.logo) || '.png');
      try { await fs.promises.copyFile(path.join(UPLOAD_DIR, path.basename(src.logo)), path.join(UPLOAD_DIR, name)); logo = name; } catch (e) { logo = null; }
    }
    const ins = await run('INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, address, notes, lot, venue_id, logo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [h.id, 'm' + D.token(10), src.title, day, src.start_time, src.end_time, src.place, src.address, src.notes, src.lot, src.venue_id, logo, now, now]);
    if (src.page_name) await run('UPDATE meets SET page_name = ? WHERE id = ?', [src.page_name, ins.lastID]);
    const row = await get('SELECT * FROM meets WHERE id = ?', [ins.lastID]);
    await N.ensure(h, row);
    await sync(h, row);
    res.status(201).json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [row.id]), h) });
  });
  r.post('/meets/:id/cancel', signedIn, async (req, res) => {
    const h = req.me;
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const back = (req.body || {}).undo === true;
    await run('UPDATE meets SET status = ?, updated_at = ? WHERE id = ?', [back ? 'on' : 'canceled', Date.now(), m.id]);
    const row = await get('SELECT * FROM meets WHERE id = ?', [m.id]);
    await sync(h, row);
    if (!back && (req.body || {}).tellAlerts === true) await tellAlerts(h, row, 'canceled');
    res.json({ meet: meetShape(row, h) });
  });
  r.post('/meets/:id/resync', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const s = await sync(req.me, m);
    if (!s.ok) return res.status(502).json({ error: s.data.error || 'The food side didn’t answer.' });
    res.json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });
  // After the meet: a quick head count and car count. Past turnout is what tells a truck a spot is worth it.
  r.post('/meets/:id/turnout', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    if (U.meetTimes(m, tzOf(req.me)).startsAt > Date.now()) return res.status(400).json({ error: 'Log the count once the meet has started.' });
    const people = parseInt((req.body || {}).people, 10); const cars = parseInt((req.body || {}).cars, 10);
    if (!Number.isInteger(people) || people < 1 || people > 20000) return res.status(400).json({ error: 'About how many people came?' });
    if ((req.body || {}).cars !== undefined && (req.body || {}).cars !== '' && (!Number.isInteger(cars) || cars < 0 || cars > 20000)) return res.status(400).json({ error: 'That car count doesn’t look right.' });
    await run('UPDATE meets SET turnout_people = ?, turnout_cars = ?, turnout_at = ? WHERE id = ?', [people, Number.isInteger(cars) ? cars : null, Date.now(), m.id]);
    res.json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });

  /* ---------- trucks ---------- */
  r.get('/meets/:id/trucks', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const list = (await trucksFor(m, { fresh: true })).map(truckShape).filter((v) => v.status !== 'removed');
    const inNow = new Set(list.filter((v) => v.slug && ['in', 'invited'].includes(v.status)).map((v) => v.slug));
    const vendorRows = await all("SELECT * FROM kit_logos WHERE host_id = ? AND kind = 'vendor' ORDER BY name COLLATE NOCASE", [req.me.id]);
    const mine = new Set(vendorRows.map((k) => k.truck_slug).filter(Boolean));
    // Full Online Kitchen accounts the host has had before (one tap: they accept in their own app).
    const known = (await all('SELECT slug, name, emoji FROM host_vendors WHERE host_id = ? ORDER BY last_meet_at DESC LIMIT 40', [req.me.id])).filter((v) => !inNow.has(v.slug) && !mine.has(v.slug));
    // The host's Food vendors not in this meet yet: each gets its own link (no email or phone).
    const vendors = vendorRows.filter((k) => !(k.truck_slug && inNow.has(k.truck_slug))).map(kitShape);
    res.set('Cache-Control', 'no-store').json({ trucks: list, known, vendors, foodOn: K.on() });
  });
  // A link for a truck the host hasn't worked with: the host texts it to the owner.
  r.post('/meets/:id/invite', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    if (!m.synced_at) { const s = await sync(req.me, m); if (!s.ok) return res.status(502).json({ error: s.data.error || 'The food side didn’t answer.' }); }
    const r2 = await K.inviteLink(m.ref);
    if (!r2.ok) return res.status(r2.status || 502).json({ error: r2.data.error || 'Couldn’t make a link.' });
    truckCache.delete(m.ref);
    const tz = tzOf(req.me); const t = U.meetTimes(m, tz);
    const text = `Hey! We'd love to have you at ${m.title || req.me.name + "'s meet"}: ${m.place}, ${U.dayShort(t.startsAt, tz)} ${U.time12(t.startsAt, tz)}–${U.time12(t.endsAt, tz)}. People can pre-order from you ahead of time and pay at your truck. Open this to set up (no account needed): ${r2.data.url}`;
    res.status(201).json({ url: r2.data.url, code: r2.data.code, text });
  });
  // A Food vendor's own link for this meet: no email or phone, it opens straight to their truck (name and menu ready).
  // Already in the meet: a one-time sign-in link (a new phone, or a lost one).
  r.post('/meets/:id/send-link', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const b = req.body || {};
    let k = b.kitId ? await ownKit(req, b.kitId) : null;
    if (!k && b.slug) k = await get('SELECT * FROM kit_logos WHERE host_id = ? AND truck_slug = ?', [req.me.id, String(b.slug).toLowerCase()]);
    if (!k) return res.status(404).json({ error: 'Add the truck to your Food vendors first.' });
    if (!m.synced_at) { const s = await sync(req.me, m); if (!s.ok) return res.status(502).json({ error: s.data.error || 'The food side didn’t answer.' }); }
    const pf = await ensureProfile(req.me, k);
    if (pf.error) return res.status(pf.status).json({ error: pf.error });
    await run('DELETE FROM kit_gone WHERE host_id = ? AND truck_slug = ?', [req.me.id, pf.slug]);
    const r2 = await K.inviteLink(m.ref, pf.slug);
    if (!r2.ok) return res.status(r2.status || 502).json({ error: r2.data.error || 'Couldn’t make a link.' });
    truckCache.delete(m.ref);
    const tz = tzOf(req.me); const t = U.meetTimes(m, tz);
    const text = r2.data.signIn
      ? `Here's a new link for ${k.name}'s pre-order screen (it works once, on the phone that opens it): ${r2.data.url}`
      : `Hey ${k.name}! You're on for ${m.title || req.me.name + "'s meet"}: ${m.place}, ${U.dayShort(t.startsAt, tz)} ${U.time12(t.startsAt, tz)}–${U.time12(t.endsAt, tz)}. People can pre-order from you ahead of time and pay at your truck. Open this to set up (no account needed): ${r2.data.url}`;
    res.status(201).json({ url: r2.data.url, text, signIn: !!r2.data.signIn, name: k.name });
  });
  r.post('/meets/:id/trucks', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const slug = String((req.body || {}).slug || '');
    if (!(await get('SELECT 1 AS x FROM host_vendors WHERE host_id = ? AND slug = ?', [req.me.id, slug]))) return res.status(404).json({ error: 'Send that truck an invite link first.' });
    if (!m.synced_at) await sync(req.me, m);
    const r2 = await K.addKnown(m.ref, slug);
    if (!r2.ok) return res.status(r2.status || 502).json({ error: r2.data.error || 'Couldn’t invite them.' });
    truckCache.delete(m.ref);
    res.status(201).json({ ok: true });
  });
  r.delete('/meets/:id/trucks/:inviteId', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const r2 = await K.dropInvite(m.ref, req.params.inviteId);
    if (!r2.ok) return res.status(r2.status || 502).json({ error: r2.data.error || 'Couldn’t remove it.' });
    truckCache.delete(m.ref);
    res.json({ ok: true });
  });
  r.get('/requests', signedIn, async (req, res) => {
    const rows = await all("SELECT id, name, contact, food, note, status, created_at FROM vendor_requests WHERE host_id = ? AND status != 'dismissed' ORDER BY id DESC LIMIT 50", [req.me.id]);
    res.set('Cache-Control', 'no-store').json({ requests: rows });
  });
  r.put('/requests/:id', signedIn, async (req, res) => {
    const st = (req.body || {}).status;
    if (!['new', 'invited', 'dismissed'].includes(st)) return res.status(400).json({ error: 'Unknown status.' });
    await run('UPDATE vendor_requests SET status = ? WHERE id = ? AND host_id = ?', [st, parseInt(req.params.id, 10) || 0, req.me.id]);
    res.json({ ok: true });
  });

  /* ---------- updates: one message to the alert list and/or the trucks ---------- */
  async function tellAlerts(h, m, kind) {
    if (!h.alerts_on) return; // alerts are off for this host (Settings)
    const tz = tzOf(h); const t = U.meetTimes(m, tz);
    const when = `${U.dayLong(t.startsAt, tz)}, ${U.time12(t.startsAt, tz)}–${U.time12(t.endsAt, tz)}`;
    const subject = kind === 'canceled' ? `Canceled: ${h.name}, ${U.dayShort(t.startsAt, tz)}` : kind === 'moved' ? `Changed: ${h.name} is now ${U.dayShort(t.startsAt, tz)} at ${m.place}` : `${h.name}: ${U.dayShort(t.startsAt, tz)} at ${m.place}`;
    const text = kind === 'canceled' ? `The meet on ${when} at ${m.place} is canceled.` : `${kind === 'moved' ? 'New time and place: ' : 'Next meet: '}${when} at ${m.place}${m.address ? ' (' + m.address + ')' : ''}.`;
    return sendUpdate(h, m, subject, text, { alerts: true, vendors: false });
  }
  async function sendUpdate(h, m, subject, text, to) {
    const now = Date.now();
    const ins = await run('INSERT INTO updates (host_id, meet_id, subject, body, to_alerts, to_vendors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [h.id, m ? m.id : null, subject, text, to.alerts ? 1 : 0, to.vendors ? 1 : 0, now]);
    let sent = 0;
    if (to.alerts) {
      const subs = await all('SELECT id, email FROM subscribers WHERE host_id = ? AND verified_at IS NOT NULL AND off_at IS NULL', [h.id]);
      const page = m ? N.meetUrl(h, m) : pageUrl(h);
      for (const s of subs) {
        const off = `${SCHEME()}://${SITE_DOMAIN()}/alerts/off?s=${s.id}.${offSig(s.id)}`;
        const ok = await mail.send({ key: `upd-${ins.lastID}-${s.id}`, to: s.email, fromName: h.name, subject, text: `${text}\n\n${page}\n\nStop these emails: ${off}`,
          headers: { 'List-Unsubscribe': `<${off}>` },
          html: mail.shell({ from: h.name, title: subject, html: `<p>${mail.esc(text).replace(/\n/g, '<br>')}</p><p><a href="${page}">See the meet</a></p>`, footer: `<a href="${off}">Stop these emails</a>` }) }).catch(() => false);
        if (ok || !mail.configured()) sent++;
      }
    }
    if (to.vendors && m) { const r2 = await K.notice(m.ref, subject, text); if (r2.ok) sent += r2.data.sent || 0; }
    await run('UPDATE updates SET sent = ? WHERE id = ?', [sent, ins.lastID]);
    return { sent };
  }
  r.post('/updates', signedIn, async (req, res) => {
    const h = req.me; const b = req.body || {};
    if (limited('upd:' + h.id, 10, 60 * 60000)) return res.status(429).json({ error: 'That’s a lot of updates in an hour. Wait a bit.' });
    const text = U.cleanBlock(b.message, 600);
    if (!text) return res.status(400).json({ error: 'Write the update first.' });
    const toAlerts = b.toAlerts === true && !!req.me.alerts_on; const toVendors = b.toVendors === true;
    if (!toAlerts && !toVendors) return res.status(400).json({ error: 'Pick who gets it.' });
    const m = b.meetId ? await own(req, b.meetId) : await nextMeet(h);
    if (toVendors && !m) return res.status(400).json({ error: 'Trucks hear about a specific meet. Post one first.' });
    const subject = U.clean(b.subject, 90) || (m ? `${h.name}: update for ${U.dayShort(U.meetTimes(m, tzOf(h)).startsAt, tzOf(h))}` : `${h.name}: update`);
    const r2 = await sendUpdate(h, m, subject, text, { alerts: toAlerts, vendors: toVendors });
    res.json({ ok: true, sent: r2.sent });
  });
  r.get('/updates', signedIn, async (req, res) => {
    const rows = await all('SELECT subject, body, to_alerts, to_vendors, sent, created_at FROM updates WHERE host_id = ? ORDER BY id DESC LIMIT 20', [req.me.id]);
    const subs = await get('SELECT COUNT(*) AS n FROM subscribers WHERE host_id = ? AND verified_at IS NOT NULL AND off_at IS NULL', [req.me.id]);
    res.set('Cache-Control', 'no-store').json({ updates: rows, subscribers: subs.n, mailOn: mail.configured() });
  });

  /* ---------- history: turnout per spot over time ---------- */
  r.get('/history', signedIn, async (req, res) => {
    const h = req.me; const tz = tzOf(h);
    const rows = await all('SELECT * FROM meets WHERE host_id = ? AND day <= ? ORDER BY day DESC LIMIT 60', [h.id, U.dayKey(Date.now(), tz)]);
    const past = rows.filter((m) => U.meetTimes(m, tz).endsAt < Date.now());
    const meets = [];
    for (const m of past) {
      const s = meetShape(m, h);
      let preorders = null;
      if (meets.length < 12 && m.status === 'on') { const t = await trucksFor(m); preorders = t.filter((v) => v.status === 'in').reduce((n, v) => n + (v.preorders || 0), 0); s.trucks = t.filter((v) => v.status === 'in').length; }
      meets.push(Object.assign(s, { preorders }));
    }
    const bySpot = {};
    for (const m of meets.filter((x) => x.people && x.status === 'on')) {
      const k = m.place; const b = bySpot[k] || (bySpot[k] = { place: k, meets: 0, people: 0, cars: 0, carsN: 0 });
      b.meets++; b.people += m.people; if (m.cars !== null && m.cars !== undefined) { b.cars += m.cars; b.carsN++; }
    }
    const spots = Object.values(bySpot).map((b) => ({ place: b.place, meets: b.meets, avgPeople: Math.round(b.people / b.meets), avgCars: b.carsN ? Math.round(b.cars / b.carsN) : null })).sort((a, b) => b.avgPeople - a.avgPeople);
    res.set('Cache-Control', 'no-store').json({ meets, spots });
  });

  /* ---------- recaps: a video link and a few photos ---------- */
  r.post('/recaps', signedIn, async (req, res) => {
    const b = req.body || {};
    const video = b.videoUrl ? U.videoUrl(b.videoUrl) : '';
    if (b.videoUrl && !video) return res.status(400).json({ error: 'Use a YouTube, Instagram, TikTok or Vimeo link.' });
    const m = b.meetId ? await own(req, b.meetId) : null;
    const ins = await run('INSERT INTO recaps (host_id, meet_id, video_url, caption, created_at) VALUES (?, ?, ?, ?, ?)', [req.me.id, m ? m.id : null, video || null, U.clean(b.caption, 140), Date.now()]);
    res.status(201).json({ id: ins.lastID });
  });
  r.get('/recaps', signedIn, async (req, res) => {
    const rows = await all('SELECT * FROM recaps WHERE host_id = ? ORDER BY id DESC LIMIT 10', [req.me.id]);
    for (const x of rows) x.photos = (await all('SELECT id, file FROM recap_photos WHERE recap_id = ? ORDER BY id', [x.id])).map((p) => ({ id: p.id, url: '/uploads/' + p.file }));
    res.set('Cache-Control', 'no-store').json({ recaps: rows });
  });
  r.delete('/recaps/:id', signedIn, async (req, res) => {
    const x = await get('SELECT * FROM recaps WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!x) return res.status(404).json({ error: 'That recap is gone.' });
    for (const p of await all('SELECT file FROM recap_photos WHERE recap_id = ?', [x.id])) fs.promises.unlink(path.join(UPLOAD_DIR, p.file)).catch(() => {});
    await run('DELETE FROM recap_photos WHERE recap_id = ?', [x.id]);
    await run('DELETE FROM recaps WHERE id = ?', [x.id]);
    res.json({ ok: true });
  });
  // A photo arrives as the raw file. Only JPEG or PNG, up to 6 MB; a JPEG's hidden data (where it was taken) is removed.
  const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: '8mb' });
  const rawFlyer = express.raw({ type: ['image/jpeg', 'image/png'], limit: '12mb' });
  async function saveImage(buf) {
    const isJpeg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng = buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isJpeg && !isPng) return null;
    const out = isJpeg ? stripJpeg(buf) : stripPng(buf);
    if (!out) return null;
    const name = D.token(12) + (isJpeg ? '.jpg' : '.png');
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), out);
    return name;
  }
  r.post('/recaps/:id/photos', signedIn, rawImage, async (req, res) => {
    const x = await get('SELECT * FROM recaps WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!x) return res.status(404).json({ error: 'That recap is gone.' });
    const n = await get('SELECT COUNT(*) AS n FROM recap_photos WHERE recap_id = ?', [x.id]);
    if (n.n >= 9) return res.status(400).json({ error: '9 photos per recap.' });
    const name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG photo.' });
    await run('INSERT INTO recap_photos (recap_id, host_id, file, created_at) VALUES (?, ?, ?, ?)', [x.id, req.me.id, name, Date.now()]);
    res.status(201).json({ url: '/uploads/' + name });
  });
  /* ---------- the flyer for a meet ---------- */
  r.post('/meets/:id/flyer', signedIn, rawFlyer, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use the flyer as a JPEG or PNG (a screenshot works).' });
    if (m.flyer) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(m.flyer))).catch(() => {});
    await run('UPDATE meets SET flyer = ?, updated_at = ? WHERE id = ?', [name, Date.now(), m.id]);
    res.json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });
  r.delete('/meets/:id/flyer', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    if (m.flyer) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(m.flyer))).catch(() => {});
    await run('UPDATE meets SET flyer = NULL, updated_at = ? WHERE id = ?', [Date.now(), m.id]);
    res.json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });

  /* ---------- the parking map: a spot on the satellite view, with zones and pins drawn on it ---------- */
  // The address search for the map: a few matches, each with where it is.
  r.get('/geocode', signedIn, async (req, res) => {
    const q = U.clean(req.query.q, 160);
    if (q.length < 4) return res.status(400).json({ error: 'Type the address, like 5112 W Peoria Ave, Glendale, AZ.' });
    if (limited('geo:' + req.me.id, 30, 10 * 60000)) return res.status(429).json({ error: 'Too many searches. Wait a few minutes.' });
    const out = await geo.search(q);
    if (out.error) return res.status(502).json({ error: out.error });
    res.set('Cache-Control', 'no-store').json({ results: out.results });
  });
  // Parking shapes already on the map around a spot (OpenStreetMap): lots, single spaces, drive aisles.
  r.get('/lot-shapes', signedIn, async (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Find the spot first.' });
    if (limited('osm:' + req.me.id, 40, 10 * 60000)) return res.status(429).json({ error: 'Too many lookups. Wait a few minutes.' });
    const out = await geo.parking(lat, lng);
    if (out.error) return res.status(502).json({ error: out.error });
    res.set('Cache-Control', 'no-store').json({ shapes: out.shapes });
  });
  r.put('/meets/:id/lot', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const lot = LotMap.clean((req.body || {}).lot);
    if (!lot) return res.status(400).json({ error: 'Find the spot on the map first.' });
    await run('UPDATE meets SET lot = ?, updated_at = ? WHERE id = ?', [JSON.stringify(lot), Date.now(), m.id]);
    res.json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });
  r.delete('/meets/:id/lot', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    await run('UPDATE meets SET lot = NULL, updated_at = ? WHERE id = ?', [Date.now(), m.id]);
    res.json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });
  // The layouts from this host's other meets (newest first, one per spot), to start from one.
  r.get('/lots', signedIn, async (req, res) => {
    const rows = await all('SELECT id, day, place, lot FROM meets WHERE host_id = ? AND lot IS NOT NULL ORDER BY day DESC LIMIT 60', [req.me.id]);
    const seen = new Set(); const out = [];
    for (const x of rows) {
      const lot = LotMap.clean(x.lot); if (!lot) continue;
      const key = lot.lat.toFixed(4) + ',' + lot.lng.toFixed(4);
      if (seen.has(key)) continue; seen.add(key);
      out.push({ meetId: x.id, day: x.day, place: x.place, zones: lot.zones.length, pins: lot.pins.length, lot });
      if (out.length >= 12) break;
    }
    // Saved locations (Venues with a layout), by name.
    const saved = (await all("SELECT id, name, lot FROM kit_logos WHERE host_id = ? AND kind = 'venue' AND lot IS NOT NULL ORDER BY name COLLATE NOCASE", [req.me.id]))
      .map((k) => { const lot = LotMap.clean(k.lot); return lot && { venueId: k.id, name: k.name, zones: lot.zones.length, pins: lot.pins.length, lot }; }).filter(Boolean);
    res.set('Cache-Control', 'no-store').json({ lots: out, saved });
  });
  // A meet's layout kept as a saved location: into one of the host's Venues (venueId), or a new one (name).
  r.post('/locations', signedIn, async (req, res) => {
    const b = req.body || {};
    const m = await own(req, b.meetId);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const lot = LotMap.clean(m.lot);
    if (!lot) return res.status(400).json({ error: 'Make the parking map first.' });
    let k = null;
    if (b.venueId) {
      k = await get("SELECT * FROM kit_logos WHERE id = ? AND host_id = ? AND kind = 'venue'", [parseInt(b.venueId, 10) || 0, req.me.id]);
      if (!k) return res.status(404).json({ error: 'That location is gone.' });
    } else {
      const name = U.clean(b.name, 60);
      if (!name) return res.status(400).json({ error: 'Name the location.' });
      k = await get("SELECT * FROM kit_logos WHERE host_id = ? AND kind = 'venue' AND lower(name) = lower(?)", [req.me.id, name]);
      if (!k) {
        const n = await get("SELECT COUNT(*) AS n FROM kit_logos WHERE host_id = ? AND kind = 'venue'", [req.me.id]);
        if (n.n >= 60) return res.status(400).json({ error: '60 saved locations at most. Remove one in Settings › Venues.' });
        const ins = await run("INSERT INTO kit_logos (host_id, kind, name, file, created_at) VALUES (?, 'venue', ?, '', ?)", [req.me.id, name, Date.now()]);
        k = await get('SELECT * FROM kit_logos WHERE id = ?', [ins.lastID]);
      }
    }
    await run('UPDATE kit_logos SET lot = ? WHERE id = ?', [JSON.stringify(lot), k.id]);
    // The meet is at that location now (so next week's copy starts there too).
    if (!m.venue_id) await run('UPDATE meets SET venue_id = ? WHERE id = ?', [k.id, m.id]);
    res.status(201).json({ venue: { id: k.id, name: k.name }, meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });
  r.delete('/locations/:id', signedIn, async (req, res) => {
    await run("UPDATE kit_logos SET lot = NULL WHERE id = ? AND host_id = ? AND kind = 'venue'", [parseInt(req.params.id, 10) || 0, req.me.id]);
    res.json({ ok: true });
  });

  /* ---------- the flyer kit: vendor and car group logos, ready to paste onto a flyer ---------- */
  const KINDS = ['vendor', 'group', 'sponsor', 'title', 'venue']; // food vendor, club, vendor (not food), meet title, venue
  const kitShape = (k) => ({ id: k.id, kind: k.kind, name: k.name, url: k.file ? '/uploads/' + k.file : '', thumb: k.file ? Vw.small(k.file, 256) : '', instagram: k.instagram || '', note: k.note || '', truckSlug: k.truck_slug || null,
    pageSlug: k.page_slug || null, pageOn: !!k.page_on, pageUrl: k.page_slug ? U.vendorUrl(k.page_slug, { absolute: true }) : null, hasLot: !!k.lot });
  const hostKey = (h) => 'host_' + h.id;
  // A Food vendor's truck profile on the food side (name and menu, no email or phone), made the first time it's needed.
  async function ensureProfile(h, k) {
    if (k.truck_slug) return { slug: k.truck_slug };
    const r2 = await K.createProfile(hostKey(h), k.name, tzOf(h));
    if (!r2.ok) return { error: r2.data.error || 'The food side didn’t answer.', status: r2.status || 502 };
    await run('UPDATE kit_logos SET truck_slug = ? WHERE id = ?', [r2.data.profile.slug, k.id]);
    if (k.instagram) K.updateProfile(hostKey(h), r2.data.profile.slug, { instagram: k.instagram }).catch(() => {});
    return { slug: r2.data.profile.slug };
  }
  // What the reader's answer means in the lists: food → Food vendors, club → Clubs, vendor → Vendors (non-food).
  const KIND_OF = { food: 'vendor', club: 'group', vendor: 'sponsor' };
  const PLACEHOLDER = /^(logo|vendor|club)\s*\d*$/i;
  // Logo pictures (from the logo sheet splitter, before they're saved) → [{ name, kind }].
  r.post('/logo-read', signedIn, express.json({ limit: '20mb' }), async (req, res) => {
    const files = Array.isArray((req.body || {}).files) ? req.body.files.slice(0, 16) : [];
    if (!files.length) return res.status(400).json({ error: 'Send at least one logo.' });
    const r2 = await K.readLogos(hostKey(req.me), files.map((f) => ({ type: String(f && f.type || ''), data: String(f && f.data || '') })));
    if (!r2.ok) return res.status(r2.status || 502).json({ error: r2.data.error || 'Reading the logos didn’t work. Type the names for now.' });
    res.json({ logos: (r2.data.logos || []).map((l) => ({ name: U.clean(l.name, 60), kind: KIND_OF[l.kind] || null })) });
  });
  // Entries already in the lists: read their logos. With apply, a placeholder name ("Logo 3") takes the name read,
  // and the entry moves to the list it belongs in; with all, every name is replaced. Returns what was read, by id.
  r.post('/kit/read', signedIn, async (req, res) => {
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 16);
    const rows = [];
    for (const id of ids) {
      const k = await get('SELECT * FROM kit_logos WHERE id = ? AND host_id = ?', [id, req.me.id]);
      if (!k || !k.file) continue;
      try {
        const buf = await fs.promises.readFile(path.join(UPLOAD_DIR, path.basename(k.file)));
        if (buf.length > 3 * 1024 * 1024) continue;
        rows.push({ k, file: { type: /\.jpe?g$/i.test(k.file) ? 'image/jpeg' : 'image/png', data: buf.toString('base64') } });
      } catch (e) { /* no file */ }
    }
    if (!rows.length) return res.status(400).json({ error: 'None of those have a logo to read yet.' });
    const r2 = await K.readLogos(hostKey(req.me), rows.map((x) => x.file));
    if (!r2.ok) return res.status(r2.status || 502).json({ error: r2.data.error || 'Reading the logos didn’t work. Type the names for now.' });
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const k = rows[i].k, l = (r2.data.logos || [])[i] || {};
      const name = U.clean(l.name, 60), kind = KIND_OF[l.kind] || null;
      out.push({ id: k.id, name, kind });
      if (!b.apply) continue;
      const newName = name && (b.apply === 'all' || PLACEHOLDER.test(k.name)) ? name : k.name;
      // A venue or a meet title stays what it is; vendors and clubs go where the reader says.
      const newKind = kind && ['vendor', 'group', 'sponsor'].includes(k.kind) ? kind : k.kind;
      await run('UPDATE kit_logos SET name = ?, kind = ? WHERE id = ?', [newName, newKind, k.id]);
      if (k.truck_slug && newName !== k.name) K.updateProfile(hostKey(req.me), k.truck_slug, { name: newName }).catch(() => {});
    }
    res.json({ read: out, logos: b.apply ? (await all('SELECT * FROM kit_logos WHERE host_id = ? ORDER BY kind, name COLLATE NOCASE', [req.me.id])).map(kitShape) : undefined });
  });
  const ownKit = (req, id) => get('SELECT * FROM kit_logos WHERE id = ? AND host_id = ?', [parseInt(id, 10) || 0, req.me.id]);
  r.get('/kit', signedIn, async (req, res) => {
    const rows = await all('SELECT * FROM kit_logos WHERE host_id = ? ORDER BY kind, name COLLATE NOCASE', [req.me.id]);
    res.set('Cache-Control', 'no-store').json({ logos: rows.map(kitShape) });
  });
  r.post('/kit', signedIn, rawImage, async (req, res) => {
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : 'vendor';
    const nm = U.clean(req.query.name, 60);
    if (!nm) return res.status(400).json({ error: 'Name the logo (the vendor or car group).' });
    const n = await get('SELECT COUNT(*) AS n FROM kit_logos WHERE host_id = ?', [req.me.id]);
    if (n.n >= 200) return res.status(400).json({ error: 'Your kit has 200 logos. Delete a few first.' });
    let name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG logo.' });
    const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR);
    if (trimmed) { fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {}); name = trimmed; }
    const ins = await run('INSERT INTO kit_logos (host_id, kind, name, file, created_at) VALUES (?, ?, ?, ?, ?)', [req.me.id, kind, nm, name, Date.now()]);
    res.status(201).json({ logo: kitShape(await get('SELECT * FROM kit_logos WHERE id = ?', [ins.lastID])) });
  });
  // A Food vendor or a Club added from Settings: a name (and Instagram), with or without a logo yet.
  r.post('/kit/entry', signedIn, async (req, res) => {
    const b = req.body || {};
    const kind = ['group', 'venue'].includes(b.kind) ? b.kind : 'vendor';
    const nm = U.clean(b.name, 60);
    if (!nm) return res.status(400).json({ error: kind === 'group' ? 'Name the club.' : kind === 'venue' ? 'Name the place.' : 'Name the truck.' });
    const n = await get('SELECT COUNT(*) AS n FROM kit_logos WHERE host_id = ?', [req.me.id]);
    if (n.n >= 200) return res.status(400).json({ error: 'Your lists have 200 entries. Delete a few first.' });
    const ins = await run('INSERT INTO kit_logos (host_id, kind, name, file, instagram, note, created_at) VALUES (?, ?, ?, \'\', ?, ?, ?)',
      [req.me.id, kind, nm, U.handle(b.instagram) || null, U.clean(b.note, 80) || null, Date.now()]);
    res.status(201).json({ logo: kitShape(await get('SELECT * FROM kit_logos WHERE id = ?', [ins.lastID])) });
  });
  r.put('/kit/:id', signedIn, async (req, res) => {
    const k = await get('SELECT * FROM kit_logos WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!k) return res.status(404).json({ error: 'That logo is gone.' });
    const b = req.body || {};
    const nm = b.name === undefined ? k.name : U.clean(b.name, 60);
    if (!nm) return res.status(400).json({ error: 'Name the logo.' });
    const kind = KINDS.includes(b.kind) ? b.kind : k.kind;
    const ig = b.instagram === undefined ? k.instagram : (U.handle(b.instagram) || null);
    const note = b.note === undefined ? k.note : (U.clean(b.note, 80) || null);
    await run('UPDATE kit_logos SET name = ?, kind = ?, instagram = ?, note = ? WHERE id = ?', [nm, kind, ig, note, k.id]);
    // The truck's profile on the food side keeps the same name and Instagram.
    if (k.truck_slug && (nm !== k.name || ig !== k.instagram)) K.updateProfile(hostKey(req.me), k.truck_slug, { name: nm, instagram: ig || '' }).catch(() => {});
    res.json({ logo: kitShape(await get('SELECT * FROM kit_logos WHERE id = ?', [k.id])) });
  });
  // A new picture for a logo already in the kit (same name and type).
  r.post('/kit/:id/image', signedIn, rawImage, async (req, res) => {
    const k = await get('SELECT * FROM kit_logos WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!k) return res.status(404).json({ error: 'That logo is gone.' });
    let name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG logo.' });
    const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR);
    if (trimmed) { fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {}); name = trimmed; }
    await run('UPDATE kit_logos SET file = ? WHERE id = ?', [name, k.id]);
    if (k.file) fs.promises.unlink(path.join(UPLOAD_DIR, k.file)).catch(() => {});
    res.json({ logo: kitShape(await get('SELECT * FROM kit_logos WHERE id = ?', [k.id])) });
  });
  r.delete('/kit/:id', signedIn, async (req, res) => {
    const k = await get('SELECT * FROM kit_logos WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!k) return res.status(404).json({ error: 'That logo is gone.' });
    if (k.file) fs.promises.unlink(path.join(UPLOAD_DIR, k.file)).catch(() => {});
    // Its profile goes with it: pictures, clip, spots, meet history, old addresses.
    for (const x of await all('SELECT file FROM kit_media WHERE kit_id = ?', [k.id])) unlinkUpload(x.file);
    unlinkUpload(k.video); unlinkUpload(k.video_poster); unlinkUpload(k.video_hevc);
    for (const t of ['kit_media', 'kit_spots', 'kit_meets', 'kit_old_slugs']) await run(`DELETE FROM ${t} WHERE kit_id = ?`, [k.id]);
    await run('DELETE FROM kit_logos WHERE id = ?', [k.id]);
    await run('DELETE FROM meet_kit_vendors WHERE kit_id = ?', [k.id]);
    await run('UPDATE meets SET venue_id = NULL WHERE venue_id = ?', [k.id]);
    await run('UPDATE members SET club_id = NULL WHERE club_id = ?', [k.id]);
    if (k.truck_slug) {
      // Its truck leaves every meet still to come, and isn't put back in the lists from an old invite.
      await run('INSERT OR IGNORE INTO kit_gone (host_id, truck_slug) VALUES (?, ?)', [req.me.id, k.truck_slug]);
      await run('DELETE FROM host_vendors WHERE host_id = ? AND slug = ?', [req.me.id, k.truck_slug]);
      const tz = tzOf(req.me);
      const meets = (await all('SELECT * FROM meets WHERE host_id = ? AND ref IS NOT NULL AND day >= ?', [req.me.id, U.addDays(U.dayKey(Date.now(), tz), -1)]))
        .filter((m) => U.meetTimes(m, tz).endsAt > Date.now());
      for (const m of meets) {
        const list = await trucksFor(m, { fresh: true }).catch(() => []);
        for (const v of list.filter((x) => x.slug === k.truck_slug && ['in', 'invited'].includes(x.status))) await K.dropInvite(m.ref, v.inviteId).catch(() => {});
        truckCache.delete(m.ref);
      }
    }
    res.json({ ok: true });
  });

  /* ---------- a Food vendor's menu, put in by the host (a photo of their board), so the truck only checks it ---------- */
  r.get('/kit/:id/menu', signedIn, async (req, res) => {
    const k = await ownKit(req, req.params.id);
    if (!k) return res.status(404).json({ error: 'That truck is gone.' });
    if (!k.truck_slug || !K.on()) return res.set('Cache-Control', 'no-store').json({ items: 0, foodOn: K.on() });
    const r2 = await K.profiles(hostKey(req.me));
    const p = r2.ok ? (r2.data.profiles || []).find((x) => x.slug === k.truck_slug) : null;
    res.set('Cache-Control', 'no-store').json({ items: p ? p.items : 0, foodOn: true });
  });
  r.post('/kit/:id/menu-read', signedIn, rawImage, async (req, res) => {
    const k = await ownKit(req, req.params.id);
    if (!k) return res.status(404).json({ error: 'That truck is gone.' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'Use a JPEG or PNG photo of the menu.' });
    const pf = await ensureProfile(req.me, k);
    if (pf.error) return res.status(pf.status).json({ error: pf.error });
    const type = String(req.headers['content-type'] || '').split(';')[0];
    const r2 = await K.profileMenuRead(hostKey(req.me), pf.slug, [{ type, data: req.body.toString('base64') }]);
    res.status(r2.ok ? 200 : r2.status || 502).json(r2.data);
  });
  r.put('/kit/:id/menu', signedIn, async (req, res) => {
    const k = await ownKit(req, req.params.id);
    if (!k) return res.status(404).json({ error: 'That truck is gone.' });
    const pf = await ensureProfile(req.me, k);
    if (pf.error) return res.status(pf.status).json({ error: pf.error });
    const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 80) : [];
    const r2 = await K.profileMenu(hostKey(req.me), pf.slug, items);
    res.status(r2.ok ? 200 : r2.status || 502).json(r2.ok ? { ok: true, added: r2.data.added } : r2.data);
  });

  /* ---------- a Food vendor's profile page: their story, clip, past logos, food photos, spots ---------- */
  async function profileShape(k) {
    const [media, spots, served] = await Promise.all([
      all('SELECT id, kind, file, label FROM kit_media WHERE kit_id = ? ORDER BY id', [k.id]),
      all('SELECT id, name, address, when_text FROM kit_spots WHERE kit_id = ? ORDER BY id', [k.id]),
      get('SELECT COUNT(*) AS n FROM (SELECT meet_id FROM kit_meets WHERE kit_id = ? UNION SELECT meet_id FROM meet_kit_vendors WHERE kit_id = ?)', [k.id, k.id])]);
    const pic = (x) => ({ id: x.id, url: '/uploads/' + x.file, label: x.label || '' });
    return Object.assign(kitShape(k), { about: k.about || '', serves: k.serves || '', signature: k.signature || '', since: k.since || '',
      suggestSlug: k.page_slug || await freeSlug(U.pageSlugFrom(k.name), k.id), previewUrl: k.page_slug ? '/v/' + k.page_slug : null,
      video: videoShape(k), logos: media.filter((x) => x.kind === 'logo').reverse().map(pic), photos: media.filter((x) => x.kind === 'photo').map(pic),
      spots: spots.map((x) => ({ id: x.id, name: x.name, address: x.address || '', when: x.when_text || '' })), meets: served ? served.n : 0 });
  }
  /** A page address nobody else has: the one asked for, or with -2, -3… on the end. */
  async function freeSlug(base, kitId) {
    for (let i = 1; i < 50; i++) {
      const s = i === 1 ? base : (base.slice(0, 36) + '-' + i);
      if (!U.pageSlugOk(s)) continue;
      const a = await get('SELECT id FROM kit_logos WHERE page_slug = ?', [s]);
      const b = await get('SELECT kit_id FROM kit_old_slugs WHERE slug = ?', [s]);
      const c = await get('SELECT 1 AS x FROM meets WHERE page_name = ?', [s]); // a meet name's address
      if ((!a || a.id === kitId) && (!b || b.kit_id === kitId) && !c) return s;
    }
    return null;
  }
  const ownVendor = async (req) => { const k = await ownKit(req, req.params.id); return k && k.kind !== 'group' && k.kind !== 'title' ? k : null; };
  r.get('/kit/:id/profile', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    res.set('Cache-Control', 'no-store').json({ profile: await profileShape(k), videoReady: V.ffmpegOk(), subdomains: U.subdomainsOn() });
  });
  r.put('/kit/:id/profile', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    const b = req.body || {};
    const f = (v, n, block) => (v === undefined ? undefined : (block ? U.cleanBlock(v, n) : U.clean(v, n)) || null);
    const about = f(b.about, 800, true), serves = f(b.serves, 90), signature = f(b.signature, 60), since = f(b.since, 24);
    let slug = k.page_slug;
    if (b.pageSlug !== undefined || (b.pageOn && !slug)) {
      const want = String(b.pageSlug || '').toLowerCase().trim() || k.page_slug || await freeSlug(U.pageSlugFrom(k.name), k.id) || '';
      if (!U.pageSlugOk(want)) return res.status(400).json({ error: 'Page address: 3 to 40 letters, numbers or single dashes (some words are taken by the site).' });
      if (want !== k.page_slug) {
        const free = await freeSlug(want, k.id);
        if (free !== want) return res.status(409).json({ error: `${want} is taken. Try ${free || 'another'}.` });
        // The old address keeps working: it moves to the new one.
        if (k.page_slug) await run('INSERT OR REPLACE INTO kit_old_slugs (slug, kit_id, created_at) VALUES (?, ?, ?)', [k.page_slug, k.id, Date.now()]);
        await run('DELETE FROM kit_old_slugs WHERE slug = ?', [want]);
        slug = want;
      }
    }
    const on = b.pageOn === undefined ? k.page_on : (b.pageOn ? 1 : 0);
    await run(`UPDATE kit_logos SET about = COALESCE(?, CASE WHEN ? THEN NULL ELSE about END), serves = COALESCE(?, CASE WHEN ? THEN NULL ELSE serves END),
      signature = COALESCE(?, CASE WHEN ? THEN NULL ELSE signature END), since = COALESCE(?, CASE WHEN ? THEN NULL ELSE since END), page_slug = ?, page_on = ? WHERE id = ?`,
    [about, b.about !== undefined ? 1 : 0, serves, b.serves !== undefined ? 1 : 0, signature, b.signature !== undefined ? 1 : 0, since, b.since !== undefined ? 1 : 0, slug, on, k.id]);
    res.json({ profile: await profileShape(await get('SELECT * FROM kit_logos WHERE id = ?', [k.id])) });
  });
  // Their clip: any phone clip becomes the same 15-second 1080p loop as the meet page's.
  r.post('/kit/:id/video', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    return takeVideo(req, res, 'kit_logos', k.id);
  });
  r.delete('/kit/:id/video', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    await dropVideo('kit_logos', k.id);
    res.json({ profile: await profileShape(await get('SELECT * FROM kit_logos WHERE id = ?', [k.id])) });
  });
  // A past logo (kind=logo, trimmed like the current one) or a food photo (kind=photo), with an optional label.
  r.post('/kit/:id/media', signedIn, rawImage, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    const kind = req.query.kind === 'logo' ? 'logo' : 'photo';
    const n = await get('SELECT COUNT(*) AS n FROM kit_media WHERE kit_id = ? AND kind = ?', [k.id, kind]);
    if (n.n >= 12) return res.status(400).json({ error: kind === 'logo' ? '12 past logos max. Remove one first.' : '12 photos max. Remove one first.' });
    let name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG image.' });
    if (kind === 'logo') {
      const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR);
      if (trimmed) { fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {}); name = trimmed; }
    }
    await run('INSERT INTO kit_media (kit_id, host_id, kind, file, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', [k.id, req.me.id, kind, name, U.clean(req.query.label, 40) || null, Date.now()]);
    res.status(201).json({ profile: await profileShape(k) });
  });
  r.put('/kit/:id/media/:mid', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    await run('UPDATE kit_media SET label = ? WHERE id = ? AND kit_id = ?', [U.clean((req.body || {}).label, 40) || null, parseInt(req.params.mid, 10) || 0, k.id]);
    res.json({ profile: await profileShape(k) });
  });
  r.delete('/kit/:id/media/:mid', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    const x = await get('SELECT * FROM kit_media WHERE id = ? AND kit_id = ?', [parseInt(req.params.mid, 10) || 0, k.id]);
    if (x) { unlinkUpload(x.file); await run('DELETE FROM kit_media WHERE id = ?', [x.id]); }
    res.json({ profile: await profileShape(k) });
  });
  r.post('/kit/:id/spots', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    const b = req.body || {};
    const name = U.clean(b.name, 60);
    if (!name) return res.status(400).json({ error: 'Name the spot (like "Maryvale" or the lot they park at).' });
    const n = await get('SELECT COUNT(*) AS n FROM kit_spots WHERE kit_id = ?', [k.id]);
    if (n.n >= 8) return res.status(400).json({ error: '8 spots max. Remove one first.' });
    await run('INSERT INTO kit_spots (kit_id, host_id, name, address, when_text, created_at) VALUES (?, ?, ?, ?, ?, ?)', [k.id, req.me.id, name, U.clean(b.address, 120) || null, U.clean(b.when, 60) || null, Date.now()]);
    res.status(201).json({ profile: await profileShape(k) });
  });
  r.delete('/kit/:id/spots/:sid', signedIn, async (req, res) => {
    const k = await ownVendor(req);
    if (!k) return res.status(404).json({ error: 'That vendor is gone.' });
    await run('DELETE FROM kit_spots WHERE id = ? AND kit_id = ?', [parseInt(req.params.sid, 10) || 0, k.id]);
    res.json({ profile: await profileShape(k) });
  });

  /* ---------- vendors from the kit listed on a meet's page (with their logo, under Food) ---------- */
  r.get('/meets/:id/kit-vendors', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const rows = await all('SELECT kit_id, truck_slug FROM meet_kit_vendors WHERE meet_id = ? ORDER BY created_at, kit_id', [m.id]);
    res.set('Cache-Control', 'no-store').json({ ids: rows.map((x) => x.kit_id), trucks: Object.fromEntries(rows.filter((x) => x.truck_slug).map((x) => [x.kit_id, x.truck_slug])) });
  });
  r.put('/meets/:id/kit-vendors/:kit', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    const k = await get('SELECT * FROM kit_logos WHERE id = ? AND host_id = ?', [parseInt(req.params.kit, 10) || 0, req.me.id]);
    if (!k) return res.status(404).json({ error: 'That logo is gone.' });
    await run('INSERT OR IGNORE INTO meet_kit_vendors (meet_id, kit_id, created_at) VALUES (?, ?, ?)', [m.id, k.id, Date.now()]);
    // Linked to a truck's menu (one of this meet's trucks), or unlinked with an empty one.
    const b = req.body || {};
    if (b.truck !== undefined) {
      const slug = b.truck ? String(b.truck).toLowerCase() : null;
      if (slug && !/^[a-z0-9-]{1,40}$/.test(slug)) return res.status(400).json({ error: 'That truck isn’t in this meet.' });
      await run('UPDATE meet_kit_vendors SET truck_slug = ? WHERE meet_id = ? AND kit_id = ?', [slug, m.id, k.id]);
    }
    res.json({ ok: true });
  });
  r.delete('/meets/:id/kit-vendors/:kit', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    await run('DELETE FROM meet_kit_vendors WHERE meet_id = ? AND kit_id = ?', [m.id, parseInt(req.params.kit, 10) || 0]);
    res.json({ ok: true });
  });

  // A meet's own header logo, over the host's usual one (trimmed the same way).
  r.post('/meets/:id/logo', signedIn, rawImage, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    let name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG image.' });
    const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR);
    if (trimmed) { fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {}); name = trimmed; }
    if (m.logo) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(m.logo))).catch(() => {});
    await run('UPDATE meets SET logo = ?, updated_at = ? WHERE id = ?', [name, Date.now(), m.id]);
    const row = await get('SELECT * FROM meets WHERE id = ?', [m.id]);
    sync(req.me, row).catch(() => {}); // the trucks' menus for this meet wear it too
    res.json({ meet: meetShape(row, req.me) });
  });
  r.delete('/meets/:id/logo', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    if (m.logo) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(m.logo))).catch(() => {});
    await run('UPDATE meets SET logo = NULL, updated_at = ? WHERE id = ?', [Date.now(), m.id]);
    const row = await get('SELECT * FROM meets WHERE id = ?', [m.id]);
    sync(req.me, row).catch(() => {});
    res.json({ meet: meetShape(row, req.me) });
  });
  r.post('/logo', signedIn, rawImage, async (req, res) => {
    let name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG image.' });
    // Trimmed to the logo itself (no black margin around it); the untrimmed copy is dropped.
    const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR);
    if (trimmed) { fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {}); name = trimmed; }
    if (req.me.logo && req.me.logo.startsWith('/uploads/')) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(req.me.logo))).catch(() => {});
    await run('UPDATE hosts SET logo = ?, updated_at = ? WHERE id = ?', ['/uploads/' + name, Date.now(), req.me.id]);
    refreshLook(req.me.id);
    res.json({ host: hostShape(await get('SELECT * FROM hosts WHERE id = ?', [req.me.id])) });
  });

  /* ---------- background video: the host's default, or one for a single meet ---------- */
  let videoQueue = Promise.resolve(); // one at a time, so a big upload never starves the site of CPU
  const tmpDir = path.join(UPLOAD_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const unlinkUpload = (f) => { if (f) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(f))).catch(() => {}); };
  async function takeVideo(req, res, table, id) {
    if (!V.ffmpegOk()) return res.status(503).json({ error: 'Video processing isn’t installed on the server yet (ffmpeg).' });
    const row = await get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (row.video_status === 'processing') return res.status(409).json({ error: 'The last video is still processing. Give it a minute.' });
    let up;
    try { up = await V.receive(req, tmpDir); } catch (e) { return res.status(400).json({ error: e.message }); }
    await run(`UPDATE ${table} SET video_status = 'processing', video_error = NULL WHERE id = ?`, [id]);
    res.status(202).json({ video: { status: 'processing' } });
    videoQueue = videoQueue.then(async () => {
      try {
        const out = await V.process(up.file, UPLOAD_DIR);
        const old = await get(`SELECT video, video_poster, video_hevc FROM ${table} WHERE id = ?`, [id]);
        await run(`UPDATE ${table} SET video = ?, video_hevc = ?, video_poster = ?, video_status = 'ready', video_error = NULL WHERE id = ?`, [out.video, out.hevc, out.poster, id]);
        if (old) { unlinkUpload(old.video); unlinkUpload(old.video_poster); unlinkUpload(old.video_hevc); }
        if (table === 'hosts') refreshLook(id);
        else if (table === 'meets') { const m = await get('SELECT * FROM meets WHERE id = ?', [id]); if (m) sync(await get('SELECT * FROM hosts WHERE id = ?', [m.host_id]), m).catch(() => {}); }
      } catch (e) {
        console.error('video:', e.message);
        await run(`UPDATE ${table} SET video_status = 'failed', video_error = ? WHERE id = ?`, ['That file couldn’t be read as a video. Try another clip.', id]);
      } finally { fs.promises.unlink(up.file).catch(() => {}); }
    });
  }
  async function dropVideo(table, id) {
    const row = await get(`SELECT video, video_poster, video_hevc FROM ${table} WHERE id = ?`, [id]);
    if (row) { unlinkUpload(row.video); unlinkUpload(row.video_poster); unlinkUpload(row.video_hevc); }
    await run(`UPDATE ${table} SET video = NULL, video_hevc = NULL, video_poster = NULL, video_status = NULL, video_error = NULL WHERE id = ?`, [id]);
  }
  r.post('/video', signedIn, (req, res) => takeVideo(req, res, 'hosts', req.me.id));
  // The portal's own background (only the host sees it, behind their portal).
  r.get('/portal-video', signedIn, async (req, res) => {
    res.set('Cache-Control', 'no-store').json({ video: videoShape((await get('SELECT * FROM host_portal WHERE id = ?', [req.me.id])) || {}) });
  });
  r.post('/portal-video', signedIn, async (req, res) => {
    await run('INSERT OR IGNORE INTO host_portal (id) VALUES (?)', [req.me.id]);
    return takeVideo(req, res, 'host_portal', req.me.id);
  });
  r.delete('/portal-video', signedIn, async (req, res) => {
    if (await get('SELECT id FROM host_portal WHERE id = ?', [req.me.id])) await dropVideo('host_portal', req.me.id);
    res.json({ video: videoShape({}) });
  });
  // The front page's video: the site owner only.
  r.get('/site-video', signedIn, async (req, res) => {
    if (!isOwner(req.me)) return res.status(404).json({ error: 'Not found.' });
    res.set('Cache-Control', 'no-store').json({ video: videoShape(await get('SELECT * FROM site WHERE id = 1')) });
  });
  r.post('/site-video', signedIn, (req, res) => (isOwner(req.me) ? takeVideo(req, res, 'site', 1) : res.status(404).json({ error: 'Not found.' })));
  r.delete('/site-video', signedIn, async (req, res) => {
    if (!isOwner(req.me)) return res.status(404).json({ error: 'Not found.' });
    await dropVideo('site', 1);
    res.json({ video: videoShape(await get('SELECT * FROM site WHERE id = 1')) });
  });
  r.delete('/video', signedIn, async (req, res) => { await dropVideo('hosts', req.me.id); refreshLook(req.me.id); res.json({ host: hostShape(await get('SELECT * FROM hosts WHERE id = ?', [req.me.id])) }); });
  r.post('/meets/:id/video', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    return takeVideo(req, res, 'meets', m.id);
  });
  r.delete('/meets/:id/video', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    await dropVideo('meets', m.id);
    sync(req.me, await get('SELECT * FROM meets WHERE id = ?', [m.id])).catch(() => {});
    res.json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [m.id]), req.me) });
  });

  /* ---------- settings ---------- */
  r.put('/settings', signedIn, async (req, res) => {
    const h = req.me; const b = req.body || {};
    const name = b.name === undefined ? h.name : U.clean(b.name, 60);
    if (!name) return res.status(400).json({ error: 'Your meet needs a name.' });
    const accent = b.accent === undefined ? h.accent : (U.ACCENTS.includes(b.accent) ? b.accent : null);
    const close = b.closeMinutes === undefined ? h.close_minutes : parseInt(b.closeMinutes, 10);
    if (![30, 60, 120, 180, 240, 360].includes(close)) return res.status(400).json({ error: 'Pick when pre-orders close.' });
    let domain = b.customDomain === undefined ? h.custom_domain : U.clean(b.customDomain, 120).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (domain && !/^([a-z0-9-]+\.)+[a-z]{2,24}$/.test(domain)) return res.status(400).json({ error: 'That domain doesn’t look right (like tuesdaymeets.com).' });
    if (domain === SITE_DOMAIN()) return res.status(400).json({ error: 'Use your own domain.' });
    if (domain && (await get('SELECT 1 AS x FROM hosts WHERE custom_domain = ? AND id != ?', [domain, h.id]))) return res.status(409).json({ error: 'Another page already uses that domain.' });
    const domainOn = domain && domain === h.custom_domain ? h.domain_on : 0; // a new domain waits for setup
    const pick = (k, f) => (b[k] === undefined ? h[f] : b[k]);
    const closeChanged = close !== h.close_minutes;
    const alertsOn = b.alertsOn === undefined ? h.alerts_on : (b.alertsOn ? 1 : 0);
    if (alertsOn !== h.alerts_on) await run('UPDATE hosts SET alerts_on = ? WHERE id = ?', [alertsOn, h.id]);
    await run(`UPDATE hosts SET name = ?, tagline = ?, city = ?, accent = ?, instagram = ?, tiktok = ?, youtube = ?, rules = ?, close_minutes = ?, custom_domain = ?, domain_on = ?, updated_at = ? WHERE id = ?`,
      [name, U.clean(pick('tagline', 'tagline'), 120), U.clean(pick('city', 'city'), 60), accent, U.handle(pick('instagram', 'instagram')), U.handle(pick('tiktok', 'tiktok')), U.handle(pick('youtube', 'youtube')),
        U.cleanBlock(pick('rules', 'rules'), 600), close, domain || null, domainOn, Date.now(), h.id]);
    const fresh = await get('SELECT * FROM hosts WHERE id = ?', [h.id]);
    if (closeChanged || name !== h.name || accent !== h.accent) { for (const m of await all("SELECT * FROM meets WHERE host_id = ? AND day >= ? AND status = 'on'", [h.id, U.dayKey(Date.now(), tzOf(h))])) await sync(fresh, m); }
    res.json({ host: hostShape(fresh) });
  });

  /* ---------- your admin call: turn on a host's own domain once DNS points here (and the upgrade is settled) ---------- */
  r.post('/admin/domain', async (req, res) => {
    const want = String(process.env.ADMIN_TOKEN || '');
    const given = String(req.get('x-admin-token') || '');
    if (want.length < 16 || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(given))) return res.status(404).json({ error: 'Not found.' });
    const h = await get('SELECT * FROM hosts WHERE slug = ?', [String((req.body || {}).slug || '')]);
    if (!h || !h.custom_domain) return res.status(404).json({ error: 'No host with a domain by that name.' });
    await run('UPDATE hosts SET domain_on = ?, updated_at = ? WHERE id = ?', [(req.body || {}).on === false ? 0 : 1, Date.now(), h.id]);
    res.json({ ok: true, domain: h.custom_domain, on: (req.body || {}).on !== false });
  });

  r.offOk = offOk;

  /* ---------- club members' own pages (/@handle) ----------
     The host starts one (name, club, car) in the portal and texts the member their link; the link opens the same
     editor for that one page, no account: their clip, car photos, mods, Instagram. A new link turns the old one off. */
  const MAX_MEMBER_PHOTOS = 30;
  const memberUrl = (m) => `${SCHEME()}://${SITE_DOMAIN()}/@${m.handle}`;
  async function memberShape(m) {
    const [photos, club] = await Promise.all([
      all('SELECT * FROM member_photos WHERE member_id = ? ORDER BY id', [m.id]),
      m.club_id ? get("SELECT id, name, file FROM kit_logos WHERE id = ? AND kind = 'group'", [m.club_id]) : null]);
    return { id: m.id, handle: m.handle, name: m.name, car: m.car || '', mods: m.mods || '', instagram: m.instagram || '', about: m.about || '',
      clubId: club ? club.id : null, clubName: club ? club.name : '', clubLogo: club && club.file ? Vw.small(club.file, 256) : '',
      header: m.header === 'logo' && m.header_file ? 'logo' : m.header === 'club' && club && club.file ? 'club' : 'photo',
      headerLogo: m.header_file ? Vw.small(m.header_file, 720) : '',
      url: memberUrl(m), video: videoShape(m), videoReady: V.ffmpegOk(), maxPhotos: MAX_MEMBER_PHOTOS,
      photos: photos.map((x) => x.kind === 'video'
        ? { id: x.id, kind: 'video', status: x.status || 'ready', url: x.file ? '/uploads/' + x.file : null, thumb: x.poster ? Vw.small(x.poster, 480) : null, caption: x.caption || '' }
        : { id: x.id, kind: 'photo', url: Vw.small(x.file, 480), caption: x.caption || '' }) };
  }
  /** The member a request may change: the host's own (signed in), or the one whose link key it carries. */
  async function memberFor(req) {
    const id = parseInt(req.params.id, 10) || 0;
    const m = await get('SELECT * FROM members WHERE id = ?', [id]);
    if (!m) return null;
    const key = String(req.get('x-member-key') || '');
    if (key && /^[a-f0-9]{40}$/.test(key) && m.edit_hash && D.sha('member:' + key) === m.edit_hash) { req.byMember = true; return m; }
    const me = await session(req);
    if (me && me.id === m.host_id) { req.me = me; return m; }
    return null;
  }
  const memberOnly = async (req, res, next) => {
    if (limited('member:' + (req.ip || ''), 300, 15 * 60000)) return res.status(429).json({ error: 'Too many changes at once. Wait a minute.' });
    req.member = await memberFor(req);
    if (!req.member) return res.status(404).json({ error: 'That link is old. Ask for a new one.' });
    next();
  };
  async function freeHandle(base, id) {
    for (let i = 1; i < 50; i++) {
      const h = i === 1 ? base : base.slice(0, 36) + '-' + i;
      if (!U.SLUG_RE.test(h)) continue;
      const x = await get('SELECT id FROM members WHERE handle = ?', [h]);
      if (!x || x.id === id) return h;
    }
    return null;
  }
  function readMember(b) {
    const out = {};
    if (b.name !== undefined) { out.name = U.clean(b.name, 60); if (!out.name) return { error: 'Add a name.' }; }
    if (b.car !== undefined) out.car = U.clean(b.car, 80);
    if (b.mods !== undefined) out.mods = U.cleanBlock(b.mods, 1200);
    if (b.about !== undefined) out.about = U.cleanBlock(b.about, 600);
    if (b.instagram !== undefined) out.instagram = U.handle(b.instagram) || null;
    if (b.header !== undefined) out.header = ['club', 'logo'].includes(b.header) ? b.header : null;
    return out;
  }
  r.get('/members', signedIn, async (req, res) => {
    const rows = await all('SELECT * FROM members WHERE host_id = ? ORDER BY name COLLATE NOCASE', [req.me.id]);
    res.set('Cache-Control', 'no-store').json({ members: await Promise.all(rows.map(memberShape)) });
  });
  r.post('/members', signedIn, async (req, res) => {
    const b = req.body || {};
    const f = readMember(Object.assign({ name: '' }, b));
    if (f.error) return res.status(400).json({ error: f.error });
    const n = await get('SELECT COUNT(*) AS n FROM members WHERE host_id = ?', [req.me.id]);
    if (n.n >= 500) return res.status(400).json({ error: '500 member pages at most for now.' });
    let club = null;
    if (b.clubId) { club = await get("SELECT id FROM kit_logos WHERE id = ? AND host_id = ? AND kind = 'group'", [parseInt(b.clubId, 10) || 0, req.me.id]); if (!club) return res.status(400).json({ error: 'Pick one of your Clubs.' }); }
    const want = b.handle ? String(b.handle).toLowerCase().replace(/^@/, '').trim() : null;
    if (want && !U.SLUG_RE.test(want)) return res.status(400).json({ error: 'Page name: 3 to 40 letters, numbers or dashes.' });
    if (want && (await get('SELECT 1 AS x FROM members WHERE handle = ?', [want]))) return res.status(409).json({ error: `@${want} is taken. Try another.` });
    const raw = U.pageSlugFrom(f.instagram || f.name).replace(/-food$/, '');
    const handle = want || await freeHandle(raw.length >= 3 ? raw : (raw || 'member') + '-car', 0);
    if (!handle) return res.status(400).json({ error: 'Pick a page name.' });
    const now = Date.now();
    const ins = await run('INSERT INTO members (host_id, club_id, handle, name, car, mods, instagram, about, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.me.id, club ? club.id : null, handle, f.name, f.car || null, f.mods || null, f.instagram || null, f.about || null, now, now]);
    res.status(201).json({ member: await memberShape(await get('SELECT * FROM members WHERE id = ?', [ins.lastID])) });
  });
  r.get('/members/:id', memberOnly, async (req, res) => res.set('Cache-Control', 'no-store').json({ member: await memberShape(req.member), byMember: !!req.byMember }));
  r.put('/members/:id', memberOnly, async (req, res) => {
    const m = req.member; const b = req.body || {};
    const f = readMember(b);
    if (f.error) return res.status(400).json({ error: f.error });
    // The host also picks the club and the page name.
    if (!req.byMember && b.clubId !== undefined) {
      const club = b.clubId ? await get("SELECT id FROM kit_logos WHERE id = ? AND host_id = ? AND kind = 'group'", [parseInt(b.clubId, 10) || 0, m.host_id]) : null;
      f.club_id = club ? club.id : null;
    }
    if (!req.byMember && b.handle !== undefined && String(b.handle).toLowerCase() !== m.handle) {
      const want = String(b.handle).toLowerCase().replace(/^@/, '').trim();
      if (!U.SLUG_RE.test(want)) return res.status(400).json({ error: 'Page name: 3 to 40 letters, numbers or dashes.' });
      if (await get('SELECT 1 AS x FROM members WHERE handle = ? AND id != ?', [want, m.id])) return res.status(409).json({ error: `@${want} is taken. Try another.` });
      f.handle = want;
    }
    const keys = Object.keys(f);
    if (keys.length) await run(`UPDATE members SET ${keys.map((k2) => k2 + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, keys.map((k2) => f[k2]).concat([Date.now(), m.id]));
    res.json({ member: await memberShape(await get('SELECT * FROM members WHERE id = ?', [m.id])) });
  });
  r.delete('/members/:id', signedIn, async (req, res) => {
    const m = await get('SELECT * FROM members WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!m) return res.status(404).json({ error: 'That page is gone.' });
    for (const x of await all('SELECT file, poster, hevc FROM member_photos WHERE member_id = ?', [m.id])) { unlinkUpload(x.file); unlinkUpload(x.poster); unlinkUpload(x.hevc); }
    unlinkUpload(m.video); unlinkUpload(m.video_poster); unlinkUpload(m.video_hevc); unlinkUpload(m.header_file);
    await run('DELETE FROM member_photos WHERE member_id = ?', [m.id]);
    await run('DELETE FROM members WHERE id = ?', [m.id]);
    res.json({ ok: true });
  });
  // The member's own link (a new one turns the last one off), and a message to text them.
  r.post('/members/:id/link', signedIn, async (req, res) => {
    const m = await get('SELECT * FROM members WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!m) return res.status(404).json({ error: 'That page is gone.' });
    const key = crypto.randomBytes(20).toString('hex');
    await run('UPDATE members SET edit_hash = ? WHERE id = ?', [D.sha('member:' + key), m.id]);
    const url = `${memberUrl(m)}/edit#${m.id}.${key}`;
    const text = `Hey ${m.name.split(' ')[0]}! Your page on ${SITE()} is started: ${memberUrl(m)}. Add your car photos, a clip and your mods here (no account needed, keep this link to yourself): ${url}`;
    res.status(201).json({ url, text });
  });
  r.post('/members/:id/photos', memberOnly, rawImage, async (req, res) => {
    const m = req.member;
    const n = await get('SELECT COUNT(*) AS n FROM member_photos WHERE member_id = ?', [m.id]);
    if (n.n >= MAX_MEMBER_PHOTOS) return res.status(400).json({ error: `${MAX_MEMBER_PHOTOS} photos at most. Remove one first.` });
    const name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG photo.' });
    await run('INSERT INTO member_photos (member_id, file, caption, created_at) VALUES (?, ?, ?, ?)', [m.id, name, U.clean(req.query.caption, 120) || null, Date.now()]);
    V.small(path.join(UPLOAD_DIR, name), UPLOAD_DIR, 1080).catch(() => {}); // the feed's size, ready before anyone looks
    res.status(201).json({ member: await memberShape(m) });
  });
  r.put('/members/:id/photos/:pid', memberOnly, async (req, res) => {
    await run('UPDATE member_photos SET caption = ? WHERE id = ? AND member_id = ?', [U.clean((req.body || {}).caption, 120) || null, parseInt(req.params.pid, 10) || 0, req.member.id]);
    res.json({ member: await memberShape(req.member) });
  });
  r.delete('/members/:id/photos/:pid', memberOnly, async (req, res) => {
    const x = await get('SELECT * FROM member_photos WHERE id = ? AND member_id = ?', [parseInt(req.params.pid, 10) || 0, req.member.id]);
    if (x) { unlinkUpload(x.file); unlinkUpload(x.poster); unlinkUpload(x.hevc); await run('DELETE FROM member_photos WHERE id = ?', [x.id]); }
    res.json({ member: await memberShape(req.member) });
  });
  // A clip for the feed: made into the same light 1080p loop as a background (silent, 15 seconds), one at a time.
  const MAX_MEMBER_CLIPS = 10;
  r.post('/members/:id/clips', memberOnly, async (req, res) => {
    const m = req.member;
    if (!V.ffmpegOk()) return res.status(503).json({ error: 'Clips aren’t set up on the server yet (ffmpeg).' });
    const [n, nc] = await Promise.all([get('SELECT COUNT(*) AS n FROM member_photos WHERE member_id = ?', [m.id]),
      get("SELECT COUNT(*) AS n FROM member_photos WHERE member_id = ? AND kind = 'video'", [m.id])]);
    if (n.n >= MAX_MEMBER_PHOTOS) return res.status(400).json({ error: `${MAX_MEMBER_PHOTOS} photos and clips at most. Remove one first.` });
    if (nc.n >= MAX_MEMBER_CLIPS) return res.status(400).json({ error: `${MAX_MEMBER_CLIPS} clips at most. Remove one first.` });
    let up;
    try { up = await V.receive(req, tmpDir); } catch (e) { return res.status(400).json({ error: e.message }); }
    const ins = await run("INSERT INTO member_photos (member_id, kind, file, status, caption, created_at) VALUES (?, 'video', '', 'processing', ?, ?)", [m.id, U.clean(req.query.caption, 120) || null, Date.now()]);
    res.status(202).json({ member: await memberShape(m) });
    videoQueue = videoQueue.then(async () => {
      try {
        const out = await V.process(up.file, UPLOAD_DIR);
        const still = await get('SELECT id FROM member_photos WHERE id = ?', [ins.lastID]);
        if (!still) { unlinkUpload(out.video); unlinkUpload(out.hevc); unlinkUpload(out.poster); return; } // removed while it was processing
        await run("UPDATE member_photos SET file = ?, hevc = ?, poster = ?, status = 'ready' WHERE id = ?", [out.video, out.hevc, out.poster, ins.lastID]);
      } catch (e) {
        console.error('member clip:', e.message);
        await run("UPDATE member_photos SET status = 'failed' WHERE id = ?", [ins.lastID]);
      } finally { fs.promises.unlink(up.file).catch(() => {}); }
    });
  });
  // A logo for the top of their page (their club's, or their own), trimmed like the host's logo.
  r.post('/members/:id/header', memberOnly, rawImage, async (req, res) => {
    const m = req.member;
    let name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG logo.' });
    const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR);
    if (trimmed) { fs.promises.unlink(path.join(UPLOAD_DIR, name)).catch(() => {}); name = trimmed; }
    unlinkUpload(m.header_file);
    await run("UPDATE members SET header_file = ?, header = 'logo', updated_at = ? WHERE id = ?", [name, Date.now(), m.id]);
    res.json({ member: await memberShape(await get('SELECT * FROM members WHERE id = ?', [m.id])) });
  });
  r.post('/members/:id/video', memberOnly, (req, res) => takeVideo(req, res, 'members', req.member.id));
  r.delete('/members/:id/video', memberOnly, async (req, res) => { await dropVideo('members', req.member.id); res.json({ member: await memberShape(await get('SELECT * FROM members WHERE id = ?', [req.member.id])) }); });

  return r;
};

/* A JPEG without its APP1 (Exif, XMP: camera, time and GPS) and APP13 (IPTC) blocks. Everything else is kept as is. */
function stripJpeg(buf) {
  const out = [buf.slice(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xda) { out.push(buf.slice(i)); return Buffer.concat(out); } // start of the image data: the rest is pixels
    if (marker === 0xd9) { out.push(buf.slice(i, i + 2)); return Buffer.concat(out); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { out.push(buf.slice(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (marker !== 0xe1 && marker !== 0xed) out.push(buf.slice(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}
/* A PNG without text and Exif chunks (tEXt, zTXt, iTXt, eXIf). */
function stripPng(buf) {
  const out = [buf.slice(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (i + 12 + len > buf.length) return null;
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) out.push(buf.slice(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') return Buffer.concat(out);
  }
  return null;
}
module.exports.stripJpeg = stripJpeg;
module.exports.cookieOf = cookieOf;
module.exports.stripPng = stripPng;
module.exports.offOk = offOk;
