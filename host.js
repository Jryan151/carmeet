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
const SESSION_MS = 60 * 864e5;
const CODE_MS = 15 * 60 * 1000;
const SCHEME = () => process.env.PUBLIC_SCHEME || 'https';
const SITE_DOMAIN = () => String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
const SITE = () => process.env.SITE_NAME || 'Meet Night';
const linkSecret = (() => { let s = process.env.LINK_SECRET; if (!s || s.length < 24) s = crypto.randomBytes(24).toString('hex'); return () => s; })();
/** An unsubscribe link that works without storing a token per email: the subscriber's id, signed. */
const offSig = (id) => crypto.createHmac('sha256', linkSecret()).update('off:' + id).digest('hex').slice(0, 32);
function offOk(s) { const [id, sig] = String(s || '').split('.'); return /^\d+$/.test(id || '') && sig && crypto.timingSafeEqual(Buffer.from(offSig(id)), Buffer.from(sig.padEnd(32).slice(0, 32))) ? +id : 0; }

const videoShape = (x) => ({ status: x.video_status || null, url: x.video ? '/uploads/' + x.video : null, poster: x.video_poster ? '/uploads/' + x.video_poster : null, error: x.video_error || null });

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
      if (await get('SELECT 1 AS x FROM hosts WHERE slug = ?', [slug])) return res.status(409).json({ error: 'That address is taken. Try another.', needsName: true });
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
      timezone: h.timezone || '', customDomain: h.custom_domain || '', domainOn: !!h.domain_on, pageUrl: pageUrl(h), siteName: SITE(), foodOn: K.on(), mailOn: mail.configured(),
      video: videoShape(h), videoReady: V.ffmpegOk() };
  }
  function meetShape(m, h) {
    const tz = tzOf(h); const t = U.meetTimes(m, tz);
    return { id: m.id, ref: m.ref, title: m.title || '', day: m.day, start: m.start_time, end: m.end_time, place: m.place, address: m.address || '', notes: m.notes || '',
      status: m.status, startsAt: t.startsAt, endsAt: t.endsAt, label: `${U.dayShort(t.startsAt, tz)}, ${U.time12(t.startsAt, tz)}–${U.time12(t.endsAt, tz)}`,
      over: t.endsAt < Date.now(), people: m.turnout_people, cars: m.turnout_cars, video: videoShape(m), synced: !!m.synced_at && !m.sync_error, syncError: m.sync_error || '', url: `${pageUrl(h)}/${m.day}` };
  }
  async function sync(h, m) {
    const s = await K.syncMeet(h, m);
    await run('UPDATE meets SET synced_at = ?, sync_error = ? WHERE id = ?', [s.ok ? Date.now() : null, s.ok ? null : (s.data.error || 'not sent'), m.id]);
    truckCache.delete(m.ref);
    return s;
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
    cardReady: !!v.cardReady, preorders: v.preorders || 0, plates: v.plates === undefined ? null : v.plates });

  /* ---------- meets ---------- */
  r.get('/meets', signedIn, async (req, res) => {
    const h = req.me; const tz = tzOf(h);
    const rows = await all('SELECT * FROM meets WHERE host_id = ? AND day >= ? ORDER BY day, start_time LIMIT 40', [h.id, U.addDays(U.dayKey(Date.now(), tz), -1)]);
    res.set('Cache-Control', 'no-store').json({ meets: rows.filter((m) => U.meetTimes(m, tz).endsAt > Date.now()).map((m) => meetShape(m, h)), today: U.dayKey(Date.now(), tz) });
  });
  function readMeet(b, h) {
    const day = String(b.day || ''); const start = String(b.start || ''); const end = String(b.end || '');
    if (!U.validDate(day)) return { error: 'Pick a date.' };
    if (day < U.dayKey(Date.now(), tzOf(h))) return { error: 'That date already passed.' };
    if (!U.TIME_RE.test(start) || !U.TIME_RE.test(end) || start === end) return { error: 'Set a start and end time.' };
    const place = U.clean(b.place, 80);
    if (!place) return { error: 'Where is it?' };
    return { day, start_time: start, end_time: end, place, address: U.clean(b.address, 160), title: U.clean(b.title, 80), notes: U.cleanBlock(b.notes, 300) };
  }
  r.post('/meets', signedIn, async (req, res) => {
    const h = req.me;
    const m = readMeet(req.body || {}, h);
    if (m.error) return res.status(400).json({ error: m.error });
    if (await get('SELECT 1 AS x FROM meets WHERE host_id = ? AND day = ?', [h.id, m.day])) return res.status(409).json({ error: 'You already have a meet that day. Edit that one instead.' });
    const n = await get('SELECT COUNT(*) AS n FROM meets WHERE host_id = ? AND day >= ?', [h.id, U.dayKey(Date.now(), tzOf(h))]);
    if (n.n >= 30) return res.status(400).json({ error: 'You have 30 meets coming up. That’s the limit for now.' });
    const now = Date.now();
    const ins = await run('INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [h.id, 'm' + D.token(10), m.title, m.day, m.start_time, m.end_time, m.place, m.address, m.notes, now, now]);
    const row = await get('SELECT * FROM meets WHERE id = ?', [ins.lastID]);
    await sync(h, row);
    if ((req.body || {}).tellAlerts === true) await tellAlerts(h, row, 'new');
    res.status(201).json({ meet: meetShape(await get('SELECT * FROM meets WHERE id = ?', [row.id]), h) });
  });
  r.put('/meets/:id', signedIn, async (req, res) => {
    const h = req.me;
    const old = await own(req, req.params.id);
    if (!old) return res.status(404).json({ error: 'That meet is gone.' });
    const m = readMeet(req.body || {}, h);
    if (m.error) return res.status(400).json({ error: m.error });
    if (m.day !== old.day && (await get('SELECT 1 AS x FROM meets WHERE host_id = ? AND day = ? AND id != ?', [h.id, m.day, old.id]))) return res.status(409).json({ error: 'You already have a meet that day.' });
    await run('UPDATE meets SET title = ?, day = ?, start_time = ?, end_time = ?, place = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?',
      [m.title, m.day, m.start_time, m.end_time, m.place, m.address, m.notes, Date.now(), old.id]);
    const row = await get('SELECT * FROM meets WHERE id = ?', [old.id]);
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
    if (await get('SELECT 1 AS x FROM meets WHERE host_id = ? AND day = ?', [h.id, day])) return res.status(409).json({ error: `You already have a meet on ${day}.` });
    const now = Date.now();
    const ins = await run('INSERT INTO meets (host_id, ref, title, day, start_time, end_time, place, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [h.id, 'm' + D.token(10), src.title, day, src.start_time, src.end_time, src.place, src.address, src.notes, now, now]);
    const row = await get('SELECT * FROM meets WHERE id = ?', [ins.lastID]);
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
    const list = (await trucksFor(m, { fresh: true })).map(truckShape);
    const inNow = new Set(list.filter((v) => v.slug && ['in', 'invited'].includes(v.status)).map((v) => v.slug));
    const known = (await all('SELECT slug, name, emoji FROM host_vendors WHERE host_id = ? ORDER BY last_meet_at DESC LIMIT 40', [req.me.id])).filter((v) => !inNow.has(v.slug));
    res.set('Cache-Control', 'no-store').json({ trucks: list, known, foodOn: K.on() });
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
    const text = `Hey! We'd love to have you at ${m.title || req.me.name + "'s meet"}: ${m.place}, ${U.dayShort(t.startsAt, tz)} ${U.time12(t.startsAt, tz)}–${U.time12(t.endsAt, tz)}. People can pre-order from you ahead of time. Accept here: ${r2.data.url}`;
    res.status(201).json({ url: r2.data.url, code: r2.data.code, text });
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
      const page = m ? `${pageUrl(h)}/${m.day}` : pageUrl(h);
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
    const toAlerts = b.toAlerts === true; const toVendors = b.toVendors === true;
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
  const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: '6mb' });
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
  r.post('/logo', signedIn, rawImage, async (req, res) => {
    const name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) return res.status(400).json({ error: 'Use a JPEG or PNG image.' });
    if (req.me.logo && req.me.logo.startsWith('/uploads/')) fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(req.me.logo))).catch(() => {});
    await run('UPDATE hosts SET logo = ?, updated_at = ? WHERE id = ?', ['/uploads/' + name, Date.now(), req.me.id]);
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
        const old = await get(`SELECT video, video_poster FROM ${table} WHERE id = ?`, [id]);
        await run(`UPDATE ${table} SET video = ?, video_poster = ?, video_status = 'ready', video_error = NULL WHERE id = ?`, [out.video, out.poster, id]);
        if (old) { unlinkUpload(old.video); unlinkUpload(old.video_poster); }
      } catch (e) {
        console.error('video:', e.message);
        await run(`UPDATE ${table} SET video_status = 'failed', video_error = ? WHERE id = ?`, ['That file couldn’t be read as a video. Try another clip.', id]);
      } finally { fs.promises.unlink(up.file).catch(() => {}); }
    });
  }
  async function dropVideo(table, id) {
    const row = await get(`SELECT video, video_poster FROM ${table} WHERE id = ?`, [id]);
    if (row) { unlinkUpload(row.video); unlinkUpload(row.video_poster); }
    await run(`UPDATE ${table} SET video = NULL, video_poster = NULL, video_status = NULL, video_error = NULL WHERE id = ?`, [id]);
  }
  r.post('/video', signedIn, (req, res) => takeVideo(req, res, 'hosts', req.me.id));
  r.delete('/video', signedIn, async (req, res) => { await dropVideo('hosts', req.me.id); res.json({ host: hostShape(await get('SELECT * FROM hosts WHERE id = ?', [req.me.id])) }); });
  r.post('/meets/:id/video', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    return takeVideo(req, res, 'meets', m.id);
  });
  r.delete('/meets/:id/video', signedIn, async (req, res) => {
    const m = await own(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'That meet is gone.' });
    await dropVideo('meets', m.id);
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
    await run(`UPDATE hosts SET name = ?, tagline = ?, city = ?, accent = ?, instagram = ?, tiktok = ?, youtube = ?, rules = ?, close_minutes = ?, custom_domain = ?, domain_on = ?, updated_at = ? WHERE id = ?`,
      [name, U.clean(pick('tagline', 'tagline'), 120), U.clean(pick('city', 'city'), 60), accent, U.handle(pick('instagram', 'instagram')), U.handle(pick('tiktok', 'tiktok')), U.handle(pick('youtube', 'youtube')),
        U.cleanBlock(pick('rules', 'rules'), 600), close, domain || null, domainOn, Date.now(), h.id]);
    const fresh = await get('SELECT * FROM hosts WHERE id = ?', [h.id]);
    if (closeChanged || name !== h.name) { for (const m of await all("SELECT * FROM meets WHERE host_id = ? AND day >= ? AND status = 'on'", [h.id, U.dayKey(Date.now(), tzOf(h))])) await sync(fresh, m); }
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
module.exports.stripPng = stripPng;
module.exports.offOk = offOk;
