'use strict';
/* server.js — the car meet site: hosts' meet pages, food pre-orders, alerts, and the host portal (/host). */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const D = require('./db');
const U = require('./util');
const V = require('./views');
const K = require('./kitchen');
const mail = require('./mail');
const { run, get, all } = D;

const PORT = parseInt(process.env.PORT, 10) || 4100;
const SITE_DOMAIN = String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
const SCHEME = process.env.PUBLIC_SCHEME || 'https';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const TZ = () => process.env.TIMEZONE || 'America/Phoenix';
const tzOf = (host) => U.zone((host && host.timezone) || TZ());

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  if (SCHEME === 'https') res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

/* ---------- meet mode: trucks' menus and order tracking, served by the food side under this site's address ---------- */
// Before any body parsing: requests pass through untouched.
app.use('/meet', require('./meetproxy').middleware(SCHEME));
const MEET_MODE = () => process.env.MEET_MODE === '1';

/* ---------- rate limits (per network) ---------- */
function limit(windowMs, max, name) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = name + ':' + (req.ip || '');
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; hits.set(k, e); }
    if (++e.n > max) { res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000))); return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' }); }
    next();
  };
}
const limitForm = limit(10 * 60 * 1000, 12, 'form');
const limitOrder = limit(10 * 60 * 1000, 30, 'order');
const limitRead = limit(60 * 1000, 120, 'read');

/* ---------- the food side's notices (raw body: the signature covers the exact bytes) ---------- */
app.post('/hooks/kitchen', express.raw({ type: 'application/json', limit: '20kb' }), async (req, res) => {
  if (!K.verify(req.body, req.get('x-meet-sig'))) return res.status(401).json({ error: 'Bad signature.' });
  let ev = null;
  try { ev = JSON.parse(req.body.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Bad body.' }); }
  if (ev && ev.type === 'order' && /^[a-f0-9]{24}$/.test(String(ev.token || ''))) {
    const o = await get('SELECT * FROM orders WHERE token = ?', [ev.token]);
    if (o) {
      await run('UPDATE orders SET status = ?, payment = ?, ticket = COALESCE(?, ticket), updated_at = ? WHERE id = ?', [String(ev.status || o.status), String(ev.payment || o.payment), ev.ticket || null, Date.now(), o.id]);
      await orderMail(await get('SELECT * FROM orders WHERE id = ?', [o.id]));
    }
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: '50kb' }));

/* ---------- which host a request is for: a host's own domain, or the site's ---------- */
app.use(async (req, res, next) => {
  const h = String(req.hostname || '').toLowerCase();
  req.own = null;
  if (h && h !== SITE_DOMAIN && h !== 'www.' + SITE_DOMAIN && h !== 'localhost' && h !== '127.0.0.1') {
    req.own = await get('SELECT * FROM hosts WHERE custom_domain = ? AND domain_on = 1', [h.replace(/^www\./, '')]);
  }
  next();
});

/* ---------- files ---------- */
app.use('/static', express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'ignore', maxAge: '30d', immutable: true }));
app.get('/health', async (req, res) => { try { await get('SELECT 1 AS x'); res.json({ ok: true }); } catch (e) { res.status(503).json({ ok: false }); } });
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /host\nDisallow: /o/\nDisallow: /api/\n'));

// Menu photos come through here (/food-photo/<truck>/<path>), so pages never name the ordering system behind the food.
app.get(/^\/food-photo\/([a-z0-9_-]{1,63})(\/.+)$/, limitRead, async (req, res) => {
  const m = /^\/food-photo\/([a-z0-9_-]{1,63})(\/.+)$/.exec(req.path);
  const u = m && K.photoSource(m[1], m[2]);
  if (!u) return res.status(404).end();
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return res.status(404).end();
    res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' }).send(buf);
  } catch (e) { res.status(404).end(); }
});

/* ---------- helpers for pages ---------- */
const baseOf = (req, host) => (req.own && req.own.id === host.id ? '' : '/' + host.slug);
// The "Page by" line: not on a host's own domain, and not when the site itself opens on this host.
const badgeOf = (host, req) => !host.domain_on && !(req && req.isMain);
const truckCache = new Map(); // meet ref → { at, list }: the public page asks at most once a minute
async function trucksFor(m, { fresh } = {}) {
  const c = truckCache.get(m.ref);
  if (!fresh && c && Date.now() - c.at < 60000) return c.list;
  const r = await K.meetVendors(m.ref);
  const list = r.ok ? (r.data.vendors || []) : (c ? c.list : []);
  truckCache.set(m.ref, { at: Date.now(), list });
  if (r.ok) {
    for (const v of list.filter((x) => x.status === 'in' && x.slug)) {
      await run('INSERT INTO host_vendors (host_id, slug, name, emoji, last_meet_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (host_id, slug) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, last_meet_at = MAX(COALESCE(host_vendors.last_meet_at, 0), excluded.last_meet_at)',
        [m.host_id, v.slug, v.name, v.emoji || '', U.meetTimes(m, TZ()).startsAt]).catch(() => {});
    }
  }
  return list;
}
async function upcomingOf(host) {
  const tz = tzOf(host);
  const rows = await all('SELECT * FROM meets WHERE host_id = ? AND day >= ? ORDER BY day, start_time LIMIT 12', [host.id, U.addDays(U.dayKey(Date.now(), tz), -1)]);
  return rows.filter((m) => U.meetTimes(m, tz).endsAt > Date.now());
}
async function lastTurnout(host) {
  const r = await get('SELECT * FROM meets WHERE host_id = ? AND turnout_people IS NOT NULL ORDER BY day DESC, start_time DESC LIMIT 1', [host.id]);
  return r ? { people: r.turnout_people, cars: r.turnout_cars, at: U.meetTimes(r, tzOf(host)).startsAt, place: r.place } : null;
}
async function latestRecap(host) {
  const r = await get('SELECT * FROM recaps WHERE host_id = ? ORDER BY id DESC LIMIT 1', [host.id]);
  if (!r) return null;
  const photos = await all('SELECT file FROM recap_photos WHERE recap_id = ? ORDER BY id LIMIT 9', [r.id]);
  return Object.assign(r, { photos: photos.map((p) => '/uploads/' + p.file) });
}
async function renderMeet(req, res, host, m, isHome) {
  const [trucks, last, recap, upcoming] = await Promise.all([trucksFor(m), lastTurnout(host), latestRecap(host), upcomingOf(host)]);
  res.set('Cache-Control', 'no-cache').type('html').send(V.meetPage(host, m, { tz: tzOf(host), base: baseOf(req, host), trucks, last, recap, upcoming, isHome, badge: badgeOf(host, req), meetMode: MEET_MODE(), origin: `${SCHEME}://${req.get('host')}` }));
}
const notFound = (req, res, host) => res.status(404).type('html').send(V.message(host || null, { title: 'Nothing here', text: 'The link may be old, or the address may have a typo.', href: host ? baseOf(req, host) || '/' : '/', cta: host ? 'See the next meet' : 'Go to the main page' }));

async function hostHome(req, res, host) {
  const up = await upcomingOf(host);
  const next = up.find((m) => m.status === 'on') || up[0];
  if (!next) return res.set('Cache-Control', 'no-cache').type('html').send(V.hostEmpty(host, { base: baseOf(req, host), badge: badgeOf(host, req) }));
  return renderMeet(req, res, host, next, true);
}
async function meetOn(host, day) {
  if (!U.validDate(day)) return null;
  return get('SELECT * FROM meets WHERE host_id = ? AND day = ?', [host.id, day]);
}
async function foodPage(req, res, host, day, truckSlug) {
  const m = await meetOn(host, day);
  if (!m) return notFound(req, res, host);
  const trucks = await trucksFor(m);
  const t = trucks.find((v) => v.slug === truckSlug && v.status === 'in');
  if (!t) return notFound(req, res, host);
  res.set('Cache-Control', 'no-cache').type('html').send(V.foodPage(host, m, t, { tz: tzOf(host), base: baseOf(req, host) }));
}

/* ---------- host portal and its API ---------- */
app.get(['/host', '/host/'], (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'portal.html')));
app.use('/api/host', require('./host')({ trucksFor, truckCache, UPLOAD_DIR, tzOf }));

/* ---------- public API: food, orders, alerts, vendor requests ---------- */
async function meetById(id) { const m = await get('SELECT * FROM meets WHERE id = ?', [parseInt(id, 10) || 0]); return m ? { m, host: await get('SELECT * FROM hosts WHERE id = ?', [m.host_id]) } : null; }
const photoUrl = (u) => (typeof u === 'string' ? K.photoPath(u) : null);

app.get('/api/meets/:id/food/:truck', limitRead, async (req, res) => {
  const f = await meetById(req.params.id);
  if (!f) return res.status(404).json({ error: 'No such meet.' });
  const r = await K.menu(f.m.ref, req.params.truck);
  if (!r.ok) return res.status(r.status || 502).json({ error: r.data.error || 'The menu didn’t load.' });
  const d = r.data;
  res.set('Cache-Control', 'no-store').json({
    name: d.name, emoji: d.emoji, cardReady: d.cardReady, tips: d.tips, allergyOn: d.allergyOn, window: d.window, slots: d.slots,
    menu: (d.menu || []).map((it) => Object.assign({}, it, { photo: photoUrl(it.photo) })), timezone: tzOf(f.host),
  });
});

app.post('/api/meets/:id/food/:truck/order', limitOrder, async (req, res) => {
  const f = await meetById(req.params.id);
  if (!f) return res.status(404).json({ error: 'No such meet.' });
  const b = req.body || {};
  if (b.website) return res.status(400).json({ error: 'Couldn’t place the order. Try again.' });
  const email = U.clean(b.email, 120).toLowerCase();
  if (!U.EMAIL_RE.test(email)) return res.status(400).json({ error: 'Add your email so we can tell you when it’s ready.' });
  const origin = `${SCHEME}://${req.get('host')}`;
  const device = /^[A-Za-z0-9_-]{16,64}$/.test(String(b.device || '')) ? D.sha('dev:' + b.device).slice(0, 32) : D.sha('ip:' + (req.ip || '')).slice(0, 32);
  const r = await K.order(f.m.ref, req.params.truck, {
    name: U.clean(b.name, 40), items: Array.isArray(b.items) ? b.items.slice(0, 30) : [], pickupAt: Number(b.pickupAt), clientKey: String(b.clientKey || ''),
    tipCents: b.tipCents, allergy: U.clean(b.allergy, 120), notes: U.clean(b.notes, 200), seenTotal: b.seenTotal, returnUrl: origin + '/o', device,
  });
  if (!r.ok) return res.status(r.status || 502).json(r.data);
  const d = r.data;
  const now = Date.now();
  await run(`INSERT INTO orders (token, meet_id, host_id, vendor_slug, vendor_name, name, email, ticket, status, payment, pickup_at, total, items_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (token) DO NOTHING`,
  [d.token, f.m.id, f.host.id, req.params.truck, d.vendor && d.vendor.name, d.name, email, d.ticket, d.status, d.payment, d.pickupAt, d.total, JSON.stringify(d.items || []), now, now]);
  res.status(201).json({ token: d.token, checkoutUrl: d.checkoutUrl || null, waiting: !!d.waiting });
});

async function orderView(o) {
  const f = await meetById(o.meet_id);
  const tz = tzOf(f && f.host);
  let items = []; try { items = JSON.parse(o.items_json || '[]'); } catch (e) { items = []; }
  return { token: o.token, ticket: o.ticket, status: o.status, payment: o.payment, total: o.total, name: o.name, vendor: o.vendor_name,
    pickupAt: o.pickup_at, pickupLabel: o.pickup_at ? U.time12(o.pickup_at, tz) : '', dayLabel: o.pickup_at ? U.dayShort(o.pickup_at, tz) : '',
    place: f ? f.m.place : '', meetUrl: f ? `/${f.host.slug}/${f.m.day}` : '/', items };
}
async function refreshOrder(o, how) {
  const r = how === 'confirm' ? await K.confirmOrder(o.token) : how === 'cancel' ? await K.cancelOrder(o.token) : await K.orderStatus(o.token);
  if (r.ok) {
    await run('UPDATE orders SET status = ?, payment = ?, ticket = ?, total = ?, updated_at = ? WHERE id = ?', [r.data.status, r.data.payment, r.data.ticket, r.data.total, Date.now(), o.id]);
    o = await get('SELECT * FROM orders WHERE id = ?', [o.id]);
    await orderMail(o);
  }
  return o;
}
const orderByToken = (t) => (/^[a-f0-9]{24}$/.test(String(t || '')) ? get('SELECT * FROM orders WHERE token = ?', [String(t)]) : Promise.resolve(null));
app.get('/api/orders/:token', limitRead, async (req, res) => {
  let o = await orderByToken(req.params.token);
  if (!o) return res.status(404).json({ error: 'No such order.' });
  if (!['Fulfilled', 'Canceled'].includes(o.status) || Date.now() - o.updated_at > 5 * 60000) o = await refreshOrder(o);
  res.set('Cache-Control', 'no-store').json(await orderView(o));
});
app.post('/api/orders/:token/:act', limitOrder, async (req, res) => {
  let o = await orderByToken(req.params.token);
  if (!o || !['confirm', 'cancel'].includes(req.params.act)) return res.status(404).json({ error: 'No such order.' });
  o = await refreshOrder(o, req.params.act);
  res.json(await orderView(o));
});

/** The customer hears from this site, in the host's name: paid (with the pickup time), then ready. Once each. */
async function orderMail(o) {
  if (!o || !o.email) return;
  const f = await meetById(o.meet_id);
  if (!f) return;
  const tz = tzOf(f.host);
  const link = `${SCHEME}://${f.host.domain_on && f.host.custom_domain ? f.host.custom_domain : SITE_DOMAIN}/o/${o.token}`;
  const footer = `You ordered from ${mail.esc(o.vendor_name || 'a food truck')} at ${mail.esc(f.host.name)}’s meet. <a href="${link}">Your order</a>`;
  if (o.payment === 'paid' && !o.mailed_paid) {
    const r = await run('UPDATE orders SET mailed_paid = 1 WHERE id = ? AND mailed_paid = 0', [o.id]);
    if (r.changes) {
      const when = o.pickup_at ? `${U.dayShort(o.pickup_at, tz)} at ${U.time12(o.pickup_at, tz)}` : 'at the meet';
      await mail.send({ key: 'paid-' + o.token, to: o.email, fromName: f.host.name, subject: `Order #${o.ticket} from ${o.vendor_name}: pick up ${when}`,
        text: `Thanks${o.name ? ', ' + o.name : ''}. Order #${o.ticket} from ${o.vendor_name} is paid. Pick it up ${when} at ${f.m.place}. We'll email you when it's ready.\n\n${link}`,
        html: mail.shell({ from: f.host.name, title: `#${o.ticket} is paid`, html: `<p>${mail.esc(o.vendor_name)} will have it ready ${mail.esc(when)} at ${mail.esc(f.m.place)}.</p><p>We’ll email you when it’s ready.</p><p><a href="${link}">See your order</a></p>`, footer }) }).catch(() => {});
    }
  }
  if (o.status === 'Ready' && !o.mailed_ready) {
    const r = await run('UPDATE orders SET mailed_ready = 1 WHERE id = ? AND mailed_ready = 0', [o.id]);
    if (r.changes) {
      await mail.send({ key: 'ready-' + o.token, to: o.email, fromName: f.host.name, subject: `#${o.ticket} is ready at ${o.vendor_name}`,
        text: `Order #${o.ticket} is ready. Grab it at ${o.vendor_name}'s window.\n\n${link}`,
        html: mail.shell({ from: f.host.name, title: `#${o.ticket} is ready`, html: `<p>Grab it at ${mail.esc(o.vendor_name)}’s window.</p>`, footer }) }).catch(() => {});
    }
  }
}

app.post('/api/alerts', limitForm, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });
  const host = await get('SELECT * FROM hosts WHERE slug = ?', [String(b.host || '')]);
  if (!host) return res.status(404).json({ error: 'No such host.' });
  const email = U.clean(b.email, 120).toLowerCase();
  if (!U.EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email doesn’t look right.' });
  const t = D.token(18);
  const have = await get('SELECT * FROM subscribers WHERE host_id = ? AND email = ?', [host.id, email]);
  if (have && have.verified_at && !have.off_at) return res.json({ ok: true, message: 'You’re already on the list.' });
  if (have && have.sent_at && Date.now() - have.sent_at < 5 * 60000) return res.json({ ok: true, message: 'Check your email for the link we just sent.' });
  if (have) await run('UPDATE subscribers SET token_hash = ?, off_at = NULL, sent_at = ? WHERE id = ?', [D.sha(t), Date.now(), have.id]);
  else await run('INSERT INTO subscribers (host_id, email, token_hash, created_at, sent_at) VALUES (?, ?, ?, ?, ?)', [host.id, email, D.sha(t), Date.now(), Date.now()]);
  const link = `${SCHEME}://${req.get('host')}/alerts/yes?t=${t}`;
  await mail.send({ key: 'alerts-confirm-' + D.sha(t).slice(0, 20), to: email, fromName: host.name, subject: `Confirm alerts from ${host.name}`,
    text: `Tap to get an email when ${host.name} posts a meet or something changes:\n${link}\n\nDidn't ask for this? Ignore it and you won't hear from us.`,
    html: mail.shell({ from: host.name, title: 'One tap to confirm', html: `<p>Get an email when ${mail.esc(host.name)} posts a meet or something changes.</p><p><a href="${link}" style="display:inline-block;background:#f2a33a;color:#1c1e23;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">Yes, send me alerts</a></p>`,
      footer: 'Didn’t ask for this? Ignore it and you won’t hear from us.' }) });
  const dev = process.env.DEV_CODES === 'true' && process.env.NODE_ENV !== 'production' ? { devLink: link } : {};
  res.json(Object.assign({ ok: true, message: 'Check your email and tap the link to confirm.' }, dev));
});
app.get('/alerts/:act', async (req, res) => {
  const t = String(req.query.t || '');
  const offId = req.params.act === 'off' && req.query.s ? require('./host').offOk(req.query.s) : 0;
  const s = offId ? await get('SELECT * FROM subscribers WHERE id = ?', [offId])
    : /^[a-f0-9]{36}$/.test(t) ? await get('SELECT * FROM subscribers WHERE token_hash = ?', [D.sha(t)]) : null;
  const host = s ? await get('SELECT * FROM hosts WHERE id = ?', [s.host_id]) : null;
  if (!s || !host) return res.status(404).type('html').send(V.message(null, { title: 'That link is old', text: 'Sign up again from the meet page.', href: '/', cta: 'Go to the main page' }));
  const home = `${SCHEME}://${host.domain_on && host.custom_domain ? host.custom_domain : SITE_DOMAIN + '/' + host.slug}`;
  if (req.params.act === 'yes') {
    await run('UPDATE subscribers SET verified_at = COALESCE(verified_at, ?), off_at = NULL WHERE id = ?', [Date.now(), s.id]);
    return res.type('html').send(V.message(host, { title: 'You’re on the list', text: `You’ll get an email when ${host.name} posts a meet or something changes.`, href: home, cta: 'See the next meet' }));
  }
  if (req.params.act === 'off') {
    await run('UPDATE subscribers SET off_at = ? WHERE id = ?', [Date.now(), s.id]);
    return res.type('html').send(V.message(host, { title: 'Alerts are off', text: `You won’t get emails from ${host.name} anymore.`, href: home, cta: 'See the next meet' }));
  }
  return notFound(req, res, host);
});

app.post('/api/vendor-request', limitForm, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });
  const host = await get('SELECT * FROM hosts WHERE slug = ?', [String(b.host || '')]);
  if (!host) return res.status(404).json({ error: 'No such host.' });
  const name = U.clean(b.name, 60); const contact = U.clean(b.contact, 80);
  if (!name || !contact) return res.status(400).json({ error: 'Add your business name and a phone or email.' });
  const ipHash = D.sha('vr:' + (req.ip || '')).slice(0, 24);
  const recent = await get('SELECT COUNT(*) AS n FROM vendor_requests WHERE host_id = ? AND ip_hash = ? AND created_at > ?', [host.id, ipHash, Date.now() - 864e5]);
  if (recent.n >= 3) return res.status(429).json({ error: 'You already sent a request. The host will reach out.' });
  await run('INSERT INTO vendor_requests (host_id, name, contact, food, note, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [host.id, name, contact, U.clean(b.food, 80), U.cleanBlock(b.note, 400), ipHash, Date.now()]);
  mail.send({ key: 'vr-' + D.token(8), to: host.email, subject: `Food vendor request: ${name}`, text: `${name} (${contact}) would like a spot at your meets.${b.food ? '\nServes: ' + U.clean(b.food, 80) : ''}\n\nSee it in your portal: ${SCHEME}://${SITE_DOMAIN}/host`,
    html: mail.shell({ from: process.env.SITE_NAME || 'Meet Night', title: `${name} wants a spot`, html: `<p>${mail.esc(name)} (${mail.esc(contact)}) would like a spot at your meets.${b.food ? '<br>Serves: ' + mail.esc(U.clean(b.food, 80)) : ''}</p><p><a href="${SCHEME}://${SITE_DOMAIN}/host">Open your portal</a></p>` }) }).catch(() => {});
  res.json({ ok: true, message: `Sent. ${host.name} will reach out.` });
});

/* ---------- pages ---------- */
app.get('/o/:token', async (req, res) => {
  const o = await orderByToken(req.params.token);
  const host = o ? await get('SELECT * FROM hosts WHERE id = ?', [o.host_id]) : req.own;
  if (!o) return notFound(req, res, host);
  // Back from the card page: ?paid= or ?canceled= tells order.js what to check first.
  res.set('Cache-Control', 'no-store').type('html').send(V.orderPage(host, { token: o.token, base: host ? baseOf(req, host) : '' }));
});
app.get('/o', async (req, res) => {
  const t = String(req.query.paid || req.query.canceled || '');
  if (!/^[a-f0-9]{24}$/.test(t)) return notFound(req, res, req.own);
  res.redirect(303, `/o/${t}?${req.query.paid ? 'paid=1' : 'canceled=1'}`);
});

// The site's own front page can be one host's page: HOME_HOST=<slug>, or the only host when there's just one.
async function homeHost() {
  if (process.env.HOME_HOST) return get('SELECT * FROM hosts WHERE slug = ?', [String(process.env.HOME_HOST).toLowerCase()]);
  const rows = await all('SELECT * FROM hosts WHERE slug IS NOT NULL LIMIT 2');
  return rows.length === 1 ? rows[0] : null;
}
app.get('/privacy', async (req, res) => {
  const main = req.own || (await homeHost());
  res.set('Cache-Control', 'no-cache').type('html').send(V.privacy(main || null));
});
app.get('/', async (req, res) => {
  if (req.own) return hostHome(req, res, req.own);
  // Not on a host's own domain that's still waiting to be turned on.
  const onSite = !(await get('SELECT 1 AS x FROM hosts WHERE custom_domain = ?', [String(req.hostname || '').toLowerCase()]));
  const main = onSite ? await homeHost() : null;
  if (main && !(main.domain_on && main.custom_domain)) { req.isMain = true; return hostHome(req, res, main); }
  const rows = await all(`SELECT m.*, h.slug, h.name AS host_name, h.timezone FROM meets m JOIN hosts h ON h.id = m.host_id
    WHERE m.status = 'on' AND m.day >= ? ORDER BY m.day, m.start_time LIMIT 30`, [U.addDays(U.dayKey(Date.now(), TZ()), -1)]);
  const list = rows.filter((m) => U.meetTimes(m, m.timezone || TZ()).endsAt > Date.now()).slice(0, 12);
  res.set('Cache-Control', 'no-cache').type('html').send(V.home(list, await get('SELECT * FROM site WHERE id = 1')));
});
app.get('/:a', async (req, res, next) => {
  if (req.own) { const m = await meetOn(req.own, req.params.a); return m ? renderMeet(req, res, req.own, m, false) : notFound(req, res, req.own); }
  if (U.RESERVED.has(req.params.a)) return next();
  const host = await get('SELECT * FROM hosts WHERE slug = ?', [String(req.params.a).toLowerCase()]);
  if (!host) return notFound(req, res, null);
  if (host.domain_on && host.custom_domain) return res.redirect(301, `${SCHEME}://${host.custom_domain}/`);
  return hostHome(req, res, host);
});
app.get('/:a/:b', async (req, res, next) => {
  if (req.own) return notFound(req, res, req.own);
  if (U.RESERVED.has(req.params.a)) return next();
  const host = await get('SELECT * FROM hosts WHERE slug = ?', [String(req.params.a).toLowerCase()]);
  if (!host) return notFound(req, res, null);
  if (host.domain_on && host.custom_domain) return res.redirect(301, `${SCHEME}://${host.custom_domain}/${encodeURIComponent(req.params.b)}`);
  const m = await meetOn(host, req.params.b);
  return m ? renderMeet(req, res, host, m, false) : notFound(req, res, host);
});
app.get('/:a/food/:truck', async (req, res, next) => (req.own ? foodPage(req, res, req.own, req.params.a, req.params.truck) : next()));
app.get('/:a/:b/food/:truck', async (req, res) => {
  if (req.own) return notFound(req, res, req.own);
  const host = await get('SELECT * FROM hosts WHERE slug = ?', [String(req.params.a).toLowerCase()]);
  if (!host) return notFound(req, res, null);
  return foodPage(req, res, host, req.params.b, req.params.truck);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => notFound(req, res, req.own));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Error:', err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
  res.status(500).type('html').send(V.message(null, { title: 'Something went wrong', text: 'Try again in a minute.', href: '/', cta: 'Go to the main page' }));
});

/**
 * Once at startup:
 * - A video that was processing when the server stopped never finishes (the work was in memory), and a new upload
 *   is refused while one is processing. Those are marked failed so the host can upload again.
 * - Logos saved before logos were made see-through get the same treatment now (trimmed, black made see-through).
 *   The old file stays, so a page cached somewhere still shows it.
 */
async function tidyAtStart() {
  const Vid = require('./video');
  for (const t of ['hosts', 'meets', 'site']) {
    await D.run(`UPDATE ${t} SET video_status = 'failed', video_error = ? WHERE video_status = 'processing'`,
      ['The server restarted while this video was processing. Upload it again.']).catch(() => {});
  }
  if (!Vid.ffmpegOk()) return;
  const redo = async (file) => {
    const f = path.basename(String(file || ''));
    if (!f || Vid.TRIMMED.test(f) || !fs.existsSync(path.join(UPLOAD_DIR, f))) return null;
    return Vid.trimLogo(path.join(UPLOAD_DIR, f), UPLOAD_DIR);
  };
  for (const h of await D.all("SELECT id, logo FROM hosts WHERE logo LIKE '/uploads/%'")) {
    const n = await redo(h.logo);
    if (n) await D.run('UPDATE hosts SET logo = ? WHERE id = ?', ['/uploads/' + n, h.id]);
  }
  for (const k of await D.all('SELECT id, file FROM kit_logos')) {
    const n = await redo(k.file);
    if (n) await D.run('UPDATE kit_logos SET file = ? WHERE id = ?', [n, k.id]);
  }
}

if (require.main === module) {
  D.ensureSchema().then(() => {
    app.listen(PORT, () => console.log(`Car meet site on port ${PORT} (${SITE_DOMAIN})${K.on() ? '' : ' · food side not connected (KITCHEN_API, MEET_PARTNER_KEY)'}`));
    mail.start();
    tidyAtStart().catch((e) => console.error('startup tidy:', e.message));
  }).catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
module.exports = { app, orderMail, tidyAtStart, ready: () => D.ensureSchema() };
