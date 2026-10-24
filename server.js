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
const N = require('./names');
const zlib = require('zlib');
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
/* ---------- Caddy's question before it gets a certificate for a name (on-demand TLS) ---------- */
// Only from Caddy on this server. Yes for the site itself, a host's own domain, and a vendor profile's subdomain.
app.get('/caddy/ask', async (req, res) => {
  const ip = String(req.socket.remoteAddress || '');
  if (!/^(127\.|::1$|::ffff:127\.)/.test(ip)) return res.status(404).end();
  const d = String(req.query.domain || '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(d)) return res.status(404).end();
  if (d === SITE_DOMAIN || d === 'www.' + SITE_DOMAIN) return res.status(200).end();
  const sub = U.subOf(d);
  if (sub) return (await pageBySlug(sub)) || (await N.hostOfName(sub)) ? res.status(200).end() : res.status(404).end();
  return (await get('SELECT 1 AS x FROM hosts WHERE custom_domain = ?', [d.replace(/^www\./, '')])) ? res.status(200).end() : res.status(404).end();
});

/** A vendor profile by its address (an old address counts, so a shared link still lands). */
async function pageBySlug(slug) {
  if (!U.SLUG_RE.test(String(slug || ''))) return null;
  const k = await get("SELECT * FROM kit_logos WHERE page_slug = ? AND kind IN ('vendor', 'sponsor')", [slug]);
  if (k) return { k, moved: false };
  const old = await get('SELECT k.* FROM kit_old_slugs o JOIN kit_logos k ON k.id = o.kit_id WHERE o.slug = ? AND k.page_slug IS NOT NULL', [slug]);
  return old ? { k: old, moved: true } : null;
}

// Pages squeezed too (gzip): with their styles inside, a page is about 10 KB on the wire.
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(String(req.get('accept-encoding') || ''))) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body === 'string' && body.length > 1400 && /text\/html/.test(String(res.get('Content-Type') || '')) && !res.get('Content-Encoding')) {
      res.set({ 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return send(zlib.gzipSync(body, { level: 6 }));
    }
    return send(body);
  };
  next();
});
// Anything slow is written to the log (pm2 logs carmeet), with the server's load at the time, to find what drags.
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > 1200 && !/\.(mp4|webm)$/.test(req.path) && req.method !== 'POST') console.log(`slow: ${req.method} ${req.hostname}${req.path} ${Math.round(ms)} ms (load ${require('os').loadavg().map((x) => x.toFixed(1)).join(' ')})`);
  });
  next();
});
/* ---------- which host a request is for: a host's own domain, a vendor's subdomain, or the site's ---------- */
app.use(async (req, res, next) => {
  const h = String(req.hostname || '').toLowerCase();
  req.own = null; req.vendorSub = null;
  const sub = U.subOf(h);
  // An old meet-name address (fuel-friday.<domain>): it lives at <domain>/fuel-friday now.
  if (sub && !(await pageBySlug(sub)) && (await N.hostOfName(sub))) {
    return res.redirect(301, `${SCHEME}://${SITE_DOMAIN}/${sub}${req.originalUrl === '/' ? '' : req.originalUrl}`);
  }
  if (sub) {
    // A vendor's own address (<truck>.<site domain>) shows their profile at "/" and the files it needs. Their menu
    // comes through /meet/* above. Anything else belongs to the site itself, so it goes there.
    req.vendorSub = sub;
    if (req.path === '/' || /^\/(static|uploads|food-photo|api\/meets|api\/orders|o)(\/|$)/.test(req.path) || ['/sw.js', '/health', '/robots.txt', '/privacy'].includes(req.path)) return next();
    return res.redirect(302, `${SCHEME}://${SITE_DOMAIN}${req.originalUrl}`);
  }
  if (h && h !== SITE_DOMAIN && h !== 'www.' + SITE_DOMAIN && h !== 'localhost' && h !== '127.0.0.1') {
    req.own = await get('SELECT * FROM hosts WHERE custom_domain = ? AND domain_on = 1', [h.replace(/^www\./, '')]);
  }
  next();
});

/* ---------- files ---------- */
/* The site's scripts and styles, squeezed (brotli or gzip, made once per file and kept in memory: the portal's
   scripts go from about 250 KB to about 60). A link with ?v= names this start's version, so the phone keeps the file
   until the next update instead of asking again every hour. */
const PUBLIC = path.join(__dirname, 'public');
const squeezed = new Map(); // file → { mtime, br, gz, type }
const TEXT_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
app.use('/static', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const type = TEXT_TYPES[path.extname(req.path).toLowerCase()];
  const ae = String(req.get('accept-encoding') || '');
  const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gz' : null;
  if (!type || !enc) return next();
  const file = path.join(PUBLIC, path.normalize(decodeURIComponent(req.path)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC + path.sep)) return next();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return next();
    let c = squeezed.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      const raw = fs.readFileSync(file);
      c = { mtime: st.mtimeMs, br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } }), gz: zlib.gzipSync(raw, { level: 9 }) };
      squeezed.set(file, c);
    }
    res.set({ 'Content-Type': type, 'Content-Encoding': enc === 'br' ? 'br' : 'gzip', Vary: 'Accept-Encoding',
      'Cache-Control': req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : c[enc]);
  });
});
app.use('/static', express.static(PUBLIC, { index: false, maxAge: '1h', setHeaders: (res) => { if (res.req && res.req.query && res.req.query.v) res.set('Cache-Control', 'public, max-age=31536000, immutable'); } }));
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
const baseOf = (req, host) => (req.meetName ? '/' + req.meetName : req.own && req.own.id === host.id ? '' : '/' + host.slug);
// The "Page by" line: not on a host's own domain, and not when the site itself opens on this host.
const badgeOf = (host, req) => !host.domain_on && !(req && req.isMain);
const truckCache = new Map(); // meet ref → { at, list }: the public page asks at most once a minute
/* The trucks in a meet, from the food side. A page never waits on it for long: with a list from the last few minutes
   (up to an hour old) it shows that one and refreshes it behind the scenes (once a minute at most); with none, it waits
   under a second and then shows the page without trucks. The portal asks fresh. */
const truckLoads = new Map(); // meet ref → the request on its way
async function trucksFor(m, { fresh } = {}) {
  const c = truckCache.get(m.ref);
  if (!fresh && c && Date.now() - c.at < 60000) return c.list;
  if (fresh) return loadTrucks(m);
  const p = truckLoads.get(m.ref) || loadTrucks(m);
  if (c && Date.now() - c.at < 60 * 60000) return c.list;
  return Promise.race([p, new Promise((ok) => setTimeout(() => ok(c ? c.list : []), 800))]);
}
function loadTrucks(m) {
  const p = loadTrucks_(m).finally(() => truckLoads.delete(m.ref));
  truckLoads.set(m.ref, p);
  return p;
}
async function loadTrucks_(m) {
  const c = truckCache.get(m.ref);
  const r = await K.meetVendors(m.ref);
  const list = r.ok ? (r.data.vendors || []) : (c ? c.list : []);
  truckCache.set(m.ref, { at: Date.now(), list });
  if (r.ok) {
    // A truck that came in on a plain invite (it typed its name) joins the host's Food vendors, tied to its profile.
    // Only trucks still in the meet, and never one the host deleted.
    for (const v of list.filter((x) => x.hostProfile && x.slug && x.name && ['in', 'invited'].includes(x.status))) {
      const have = await get('SELECT id FROM kit_logos WHERE host_id = ? AND truck_slug = ?', [m.host_id, v.slug]);
      const gone = !have && await get('SELECT 1 AS x FROM kit_gone WHERE host_id = ? AND truck_slug = ?', [m.host_id, v.slug]);
      if (!have && !gone) await run("INSERT INTO kit_logos (host_id, kind, name, file, truck_slug, created_at) VALUES (?, 'vendor', ?, '', ?, ?)", [m.host_id, v.name, v.slug, Date.now()]).catch(() => {});
    }
    for (const v of list.filter((x) => x.status === 'in' && x.slug)) {
      // The meets a Food vendor served at, for "At 6 meets" on their profile.
      const kit = await get("SELECT id FROM kit_logos WHERE host_id = ? AND truck_slug = ? AND kind IN ('vendor', 'sponsor')", [m.host_id, v.slug]);
      if (kit) await run('INSERT OR IGNORE INTO kit_meets (kit_id, meet_id) VALUES (?, ?)', [kit.id, m.id]).catch(() => {});
      await run('INSERT INTO host_vendors (host_id, slug, name, emoji, last_meet_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (host_id, slug) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, last_meet_at = MAX(COALESCE(host_vendors.last_meet_at, 0), excluded.last_meet_at)',
        [m.host_id, v.slug, v.name, v.emoji || '', U.meetTimes(m, TZ()).startsAt]).catch(() => {});
    }
  }
  return list;
}
/** A truck's own logo on the food side, shown through this site (/food-photo/<truck>/…), never its address there. */
function truckFace(v) {
  const logo = v.brand && typeof v.brand.logo === 'string' && /^\/uploads\/[A-Za-z0-9._-]+$/.test(v.brand.logo) && v.slug ? `/food-photo/${v.slug}${v.brand.logo}` : null;
  return Object.assign({}, v, { logo });
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
  const [trucks, last, recap, upcoming, kitVendors, kitAll] = await Promise.all([trucksFor(m), lastTurnout(host), latestRecap(host), upcomingOf(host),
    all('SELECT k.id, k.kind, k.name, k.file, k.instagram, k.truck_slug, k.page_slug, k.page_on, v.truck_slug AS meet_truck FROM meet_kit_vendors v JOIN kit_logos k ON k.id = v.kit_id WHERE v.meet_id = ? AND k.host_id = ? ORDER BY v.created_at, v.kit_id', [m.id, host.id]),
    all("SELECT id, kind, name, file, instagram, truck_slug, page_slug, page_on FROM kit_logos WHERE host_id = ? AND kind IN ('vendor', 'sponsor')", [host.id])]);
  const venue = m.venue_id ? await get("SELECT name, file, instagram, note FROM kit_logos WHERE id = ? AND host_id = ? AND kind = 'venue'", [m.venue_id, host.id]) : null;
  // The other weeks listed: on a meet name's address, only that meet's; on the host's page, their own.
  const ups = req.meetName ? upcoming.filter((x) => x.page_name === req.meetName) : upcoming.filter((x) => !N.onName(host, x) || x.page_name === m.page_name || N.homeNames(host).has(x.page_name));
  res.set('Cache-Control', 'no-cache').type('html').send(V.meetPage(host, m, { tz: tzOf(host), base: baseOf(req, host), trucks: trucks.map(truckFace), kitVendors, kitAll, last, recap, upcoming: ups, isHome, venue, badge: badgeOf(host, req), meetMode: MEET_MODE(), origin: `${SCHEME}://${req.get('host')}` }));
}
const notFound = (req, res, host) => res.status(404).type('html').send(V.message(host || null, { title: 'Nothing here', text: 'The link may be old, or the address may have a typo.', href: host ? baseOf(req, host) || '/' : '/', cta: host ? 'See the next meet' : 'Go to the main page' }));

/* ---------- demo mode: the host sees their page filled in (sample trucks, every logo in their kit) ---------- */
// Only for the host themself (signed in to the portal), never cached or indexed; nothing in it is saved.
async function signedInHost(req) {
  const t = require('./host').cookieOf(req, 'mh_session');
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  const s = await get('SELECT host_id FROM sessions WHERE token_hash = ? AND expires_at > ?', [D.sha(t), Date.now()]);
  return s ? s.host_id : null;
}
const DEMO_TRUCKS = [
  { slug: 'demo-birria', name: 'Birria Bros', emoji: '🌮', status: 'in', cardReady: true, openNow: true },
  { slug: 'demo-lemonade', name: 'Desert Lemonade', emoji: '🍋', status: 'in', payAtTruck: true },
  { slug: 'demo-wings', name: 'Night Wings', emoji: '🍗', status: 'in', cardReady: true },
  { slug: 'demo-boba', name: 'Boba Spot', emoji: '🧋', status: 'in' },
];
async function renderDemo(req, res, host) {
  const tz = tzOf(host);
  const up = await upcomingOf(host);
  let m = up.find((x) => x.status === 'on');
  if (!m) { // no meet posted: the next Tuesday, 7 to 10 PM
    const today = U.dayKey(Date.now(), tz);
    let day = today; for (let i = 0; i < 7; i++) { day = U.addDays(today, i + 1); if (new Date(day + 'T12:00:00Z').getUTCDay() === 2) break; }
    m = { id: 0, ref: 'demo', host_id: host.id, day, start_time: '19:00', end_time: '22:00', place: 'Your spot', address: '', status: 'on', title: '' };
  }
  const kit = await all("SELECT id, kind, name, file, instagram FROM kit_logos WHERE host_id = ? AND kind IN ('vendor', 'sponsor', 'group') ORDER BY kind, name COLLATE NOCASE", [host.id]);
  const [last, recap] = await Promise.all([lastTurnout(host), latestRecap(host)]);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('html').send(V.meetPage(host, Object.assign({}, m, { status: 'on' }), {
    tz, base: baseOf(req, host), trucks: DEMO_TRUCKS, kitVendors: kit.map((k) => Object.assign({ truck_slug: null }, k)), kitAll: [], last, recap, upcoming: up,
    isHome: true, badge: badgeOf(host, req), meetMode: MEET_MODE(), origin: `${SCHEME}://${req.get('host')}`, demo: true }));
}

async function hostHome(req, res, host) {
  if (req.query.demo === '1' && (await signedInHost(req)) === host.id) return renderDemo(req, res, host);
  let up = await upcomingOf(host);
  if (req.meetName) {
    // A meet name's address: only that meet's weeks (the last one once they're all over).
    up = up.filter((m) => m.page_name === req.meetName);
    if (!up.length) { const last = await get('SELECT * FROM meets WHERE host_id = ? AND page_name = ? ORDER BY day DESC LIMIT 1', [host.id, req.meetName]); if (last) up = [last]; }
  } else {
    // The host's own page: their own meets first, not one that has its own address (Fuel Friday on Tasty Tuesday's).
    const home = N.homeNames(host);
    const mine = up.filter((m) => !N.onName(host, m) || home.has(m.page_name));
    if (mine.length) up = mine;
  }
  const next = up.find((m) => m.status === 'on') || up[0];
  if (!next) return res.set('Cache-Control', 'no-cache').type('html').send(V.hostEmpty(host, { base: baseOf(req, host), badge: badgeOf(host, req) }));
  return renderMeet(req, res, host, next, true);
}
async function meetOn(host, day, name) {
  if (!U.validDate(day)) return null;
  if (name) return get('SELECT * FROM meets WHERE host_id = ? AND day = ? AND page_name = ?', [host.id, day, name]);
  // More than one that night: the host's own one first (a meet with its own address is reached there).
  const rows = await all('SELECT * FROM meets WHERE host_id = ? AND day = ? ORDER BY id', [host.id, day]);
  const home = N.homeNames(host);
  return rows.find((m) => !N.onName(host, m)) || rows.find((m) => home.has(m.page_name)) || rows[0] || null;
}
/** A meet that lives at its name's address, asked for anywhere else: send the visitor there (old links keep working). */
function toName(req, res, host, m, rest) {
  if (req.meetName || !N.onName(host, m)) return false;
  res.redirect(301, N.meetUrl(host, m) + (rest || ''));
  return true;
}
async function foodPage(req, res, host, day, truckSlug) {
  const m = await meetOn(host, day, req.meetName);
  if (!m) return notFound(req, res, host);
  const trucks = await trucksFor(m);
  const t = trucks.find((v) => v.slug === truckSlug && v.status === 'in');
  if (!t) return notFound(req, res, host);
  res.set('Cache-Control', 'no-cache').type('html').send(V.foodPage(host, m, t, { tz: tzOf(host), base: baseOf(req, host) }));
}

/* ---------- host portal and its API ---------- */
// The portal's scripts and styles carry this start's version, so after an update a phone never keeps the old ones.
let portalHtml = null;
app.get(['/host', '/host/'], (req, res) => {
  // Its styles inside it too (one trip), like the public pages.
  if (!portalHtml) portalHtml = fs.readFileSync(path.join(__dirname, 'public', 'portal.html'), 'utf8').replace(/\?v=\d+/g, '?v=' + V.ver())
    .replace(/<link rel="stylesheet" href="\/static\/fonts\.css">\s*<link rel="stylesheet" href="\/static\/site\.css[^"]*">/, () => '<link rel="preload" href="/static/fonts/instrument-sans-400.woff2" as="font" type="font/woff2" crossorigin>\n<style>' + V.inlineCss() + '</style>');
  res.set('Cache-Control', 'no-cache').type('html').send(portalHtml);
});
// The portal's answers, squeezed when they're more than a little (the lists of logos, meets, members).
app.use('/api', (req, res, next) => {
  if (!/\bgzip\b/.test(String(req.get('accept-encoding') || ''))) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    const buf = Buffer.from(JSON.stringify(body));
    if (buf.length < 1400 || res.get('Content-Encoding')) return json(body);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(zlib.gzipSync(buf, { level: 6 }));
  };
  next();
});
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
  if (!host.alerts_on) return res.status(404).json({ error: 'Alerts aren’t on for this page.' });
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
  // To a meet's host (picked on the site's Vendors page), a host's page, or the site's owner.
  let host = null;
  if (b.meet) { const m = await get('SELECT host_id FROM meets WHERE id = ?', [parseInt(b.meet, 10) || 0]); if (m) host = await get('SELECT * FROM hosts WHERE id = ?', [m.host_id]); }
  if (!host && b.host) host = await get('SELECT * FROM hosts WHERE slug = ?', [String(b.host)]);
  if (!host && b.site) host = await siteOwner();
  if (!host) return res.status(404).json({ error: 'No such host.' });
  const name = U.clean(b.name, 60); const contact = U.clean(b.contact, 80);
  if (b.site) {
    // The extra details from the site's form go in the note the host reads.
    const meet = b.meet ? await get('SELECT title, day FROM meets WHERE id = ?', [parseInt(b.meet, 10) || 0]) : null;
    b.note = [b.kind === 'other' ? 'Not food (shop, merch, detailing…)' : '', U.handle(b.instagram) ? 'Instagram: @' + U.handle(b.instagram) : '', meet ? `For: ${meet.title || host.name} on ${meet.day}` : '', U.cleanBlock(b.note, 300)].filter(Boolean).join('\n');
  }
  if (!name || !contact) return res.status(400).json({ error: 'Add your business name and a phone or email.' });
  const ipHash = D.sha('vr:' + (req.ip || '')).slice(0, 24);
  const recent = await get('SELECT COUNT(*) AS n FROM vendor_requests WHERE host_id = ? AND ip_hash = ? AND created_at > ?', [host.id, ipHash, Date.now() - 864e5]);
  if (recent.n >= 3) return res.status(429).json({ error: 'You already sent a request. The host will reach out.' });
  await run('INSERT INTO vendor_requests (host_id, name, contact, food, note, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [host.id, name, contact, U.clean(b.food, 80), U.cleanBlock(b.note, 400), ipHash, Date.now()]);
  mail.send({ key: 'vr-' + D.token(8), to: host.email, subject: `Food vendor request: ${name}`, text: `${name} (${contact}) would like a spot at your meets.${b.food ? '\nServes: ' + U.clean(b.food, 80) : ''}\n\nSee it in your portal: ${SCHEME}://${SITE_DOMAIN}/host`,
    html: mail.shell({ from: process.env.SITE_NAME || 'Meet Night', title: `${name} wants a spot`, html: `<p>${mail.esc(name)} (${mail.esc(contact)}) would like a spot at your meets.${b.food ? '<br>Serves: ' + mail.esc(U.clean(b.food, 80)) : ''}</p><p><a href="${SCHEME}://${SITE_DOMAIN}/host">Open your portal</a></p>` }) }).catch(() => {});
  res.json({ ok: true, message: `Sent. ${host.name} will reach out.` });
});

/* ---------- a Food vendor's profile page ---------- */
const norm = (x) => String(x || '').trim().toLowerCase();
/** The vendor's next meet with this host (within the next few posted), and their truck there if it's on the food side. */
async function vendorAt(host, k) {
  const up = (await upcomingOf(host)).filter((m) => m.status === 'on').slice(0, 3);
  for (const m of up) {
    const [trucks, listed] = await Promise.all([trucksFor(m), get('SELECT truck_slug FROM meet_kit_vendors WHERE meet_id = ? AND kit_id = ?', [m.id, k.id])]);
    const v = trucks.find((x) => x.status === 'in' && x.slug && (x.slug === k.truck_slug || (listed && listed.truck_slug === x.slug) || (!k.truck_slug && norm(x.name) === norm(k.name))));
    if (v || listed) return { m, v: v || null };
  }
  return null;
}
async function vendorProfile(req, res, k) {
  const host = await get('SELECT * FROM hosts WHERE id = ?', [k.host_id]);
  if (!host) return notFound(req, res, null);
  // A page that's off: only its host sees it (a preview), so it can be shown to the truck before it goes live.
  let preview = false;
  if (!k.page_on) {
    if ((await signedInHost(req)) !== host.id) return notFound(req, res, host);
    preview = true;
  }
  const tz = tzOf(host);
  const mainOrigin = `${SCHEME}://${host.domain_on && host.custom_domain ? host.custom_domain : SITE_DOMAIN}`;
  const hostUrl = host.domain_on && host.custom_domain ? mainOrigin : `${SCHEME}://${SITE_DOMAIN}/${host.slug}`;
  const [found, logos, photos, spots, served] = await Promise.all([vendorAt(host, k),
    all("SELECT file, label FROM kit_media WHERE kit_id = ? AND kind = 'logo' ORDER BY id DESC LIMIT 12", [k.id]),
    all("SELECT file, label FROM kit_media WHERE kit_id = ? AND kind = 'photo' ORDER BY id LIMIT 12", [k.id]),
    all('SELECT name, address, when_text FROM kit_spots WHERE kit_id = ? ORDER BY id LIMIT 8', [k.id]),
    get(`SELECT COUNT(*) AS n FROM meets m WHERE m.host_id = ? AND m.status = 'on' AND m.day <= ? AND m.id IN
      (SELECT meet_id FROM kit_meets WHERE kit_id = ? UNION SELECT meet_id FROM meet_kit_vendors WHERE kit_id = ?)`, [host.id, U.dayKey(Date.now(), tz), k.id, k.id])]);
  let at = null;
  if (found) {
    const { m, v } = found;
    const t = U.meetTimes(m, tz);
    const tonight = U.dayKey(Date.now(), tz) === m.day || (Date.now() >= t.startsAt && Date.now() < t.endsAt);
    const takes = !!(v && !v.paused && (v.cardReady || (MEET_MODE() && v.payAtTruck)));
    const label = `${tonight ? 'Tonight' : U.dayShort(t.startsAt, tz)} at ${host.name} · ${U.time12(t.startsAt, tz)} · ${m.place}`;
    // The menu opens on whichever address this page is on, so the clip keeps playing from the phone's copy.
    const menu = v ? (MEET_MODE() ? `/meet/${encodeURIComponent(m.ref)}/${encodeURIComponent(v.slug)}/` : takes ? `${hostUrl}/${m.day}/food/${encodeURIComponent(v.slug)}` : null) : null;
    if (menu && takes) at = { m, label, href: menu, go: true, text: tonight ? 'Order' : `Pre-order for ${U.fmt(t.startsAt, tz, { weekday: 'long' })}` };
    else if (menu) at = { m, label, href: menu, go: false, text: 'See the menu', note: v && v.paused ? 'Pre-orders are paused. Order at the truck.' : '' };
    else at = { m, label, href: null, text: tonight ? 'Order at the truck tonight' : 'Not serving tonight' };
  }
  // Their own clip, or the host's usual one.
  const vid = k.video && k.video_status === 'ready' ? k : host.video && host.video_status === 'ready' ? host : null;
  res.set('Cache-Control', preview ? 'no-store' : 'no-cache').type('html').send(V.vendorPage(host, k, {
    tz, vid, logos, photos, spots, meets: served ? served.n : 0, at, hostUrl, preview, origin: `${SCHEME}://${req.get('host')}` }));
}
app.get('/v/:slug', async (req, res) => {
  if (req.vendorSub) return notFound(req, res, null);
  const p = await pageBySlug(String(req.params.slug).toLowerCase());
  if (!p || (req.own && p.k.host_id !== req.own.id)) return notFound(req, res, req.own);
  if (p.moved) return res.redirect(301, '/v/' + p.k.page_slug);
  // With vendor subdomains on, a live page has one address: its own.
  if (U.subdomainsOn() && p.k.page_on && !req.own) return res.redirect(301, U.vendorUrl(p.k.page_slug));
  return vendorProfile(req, res, p.k);
});

// Saves each background clip on the phone the first time it plays (public/sw.js).
app.get('/sw.js', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).type('text/javascript').sendFile(path.join(__dirname, 'public', 'sw.js'));
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

// The site's own front page is its landing page (every meet, the members, vendors). HOME_HOST=<slug> makes it one
// host's page instead.
async function homeHost() {
  if (process.env.HOME_HOST) return get('SELECT * FROM hosts WHERE slug = ?', [String(process.env.HOME_HOST).toLowerCase()]);
  return null;
}
/** The site's owner (their Instagram in the footer, vendor requests from the site's own page). */
async function siteOwner() {
  if (process.env.SITE_OWNER_EMAIL) { const h = await get('SELECT * FROM hosts WHERE lower(email) = ?', [String(process.env.SITE_OWNER_EMAIL).trim().toLowerCase()]); if (h) return h; }
  return get('SELECT * FROM hosts ORDER BY id LIMIT 1');
}
/** Every meet still to come, on every host, each with its page address. */
async function allUpcoming() {
  const rows = await all(`SELECT m.*, h.slug, h.name AS host_name, h.timezone, h.logo AS host_logo, h.domain_on, h.custom_domain FROM meets m JOIN hosts h ON h.id = m.host_id
    WHERE m.status = 'on' AND m.day >= ? ORDER BY m.day, m.start_time LIMIT 80`, [U.addDays(U.dayKey(Date.now(), TZ()), -1)]);
  return rows.filter((r) => U.meetTimes(r, r.timezone || TZ()).endsAt > Date.now())
    .map((r) => Object.assign(r, { url: N.meetUrl({ id: r.host_id, slug: r.slug, name: r.host_name, domain_on: r.domain_on, custom_domain: r.custom_domain }, r) }));
}
const siteRow = () => get('SELECT * FROM site WHERE id = 1');
app.get('/meets', async (req, res, next) => {
  if (req.own) return next();
  const [site, meets, owner] = await Promise.all([siteRow(), allUpcoming(), siteOwner()]);
  res.set('Cache-Control', 'no-cache').type('html').send(V.meetsPage(site, { meets, instagram: owner && owner.instagram }));
});
app.get('/members', async (req, res, next) => {
  if (req.own) return next();
  const [site, owner, rows] = await Promise.all([siteRow(), siteOwner(), all(`SELECT m.handle, m.name, m.car, k.name AS club, k.file AS club_logo,
      (SELECT CASE WHEN p.kind = 'video' THEN p.poster ELSE p.file END FROM member_photos p WHERE p.member_id = m.id AND (p.kind = 'photo' OR p.status = 'ready') ORDER BY p.id LIMIT 1) AS face
    FROM members m LEFT JOIN kit_logos k ON k.id = m.club_id ORDER BY m.name COLLATE NOCASE`)]);
  const groups = [];
  for (const r of rows) { const n = r.club || 'Members'; let g = groups.find((x) => x.name === n); if (!g) groups.push(g = { name: n, logo: r.club_logo, members: [] }); g.members.push(r); }
  groups.sort((a, b) => (a.name === 'Members') - (b.name === 'Members') || b.members.length - a.members.length);
  res.set('Cache-Control', 'no-cache').type('html').send(V.membersPage(site, { groups, count: rows.length, instagram: owner && owner.instagram }));
});
app.get('/vendors', async (req, res, next) => {
  if (req.own) return next();
  const [site, meets, owner] = await Promise.all([siteRow(), allUpcoming(), siteOwner()]);
  res.set('Cache-Control', 'no-cache').type('html').send(V.vendorsPage(site, { meets, instagram: owner && owner.instagram }));
});
app.get('/privacy', async (req, res) => {
  const main = req.own || (await homeHost());
  res.set('Cache-Control', 'no-cache').type('html').send(V.privacy(main || null));
});
app.get('/', async (req, res) => {
  if (req.vendorSub) {
    const p = await pageBySlug(req.vendorSub);
    if (!p) return res.redirect(302, `${SCHEME}://${SITE_DOMAIN}/`);
    if (p.moved) return res.redirect(301, U.vendorUrl(p.k.page_slug));
    return vendorProfile(req, res, p.k);
  }
  if (req.own) return hostHome(req, res, req.own);
  // Not on a host's own domain that's still waiting to be turned on.
  const onSite = !(await get('SELECT 1 AS x FROM hosts WHERE custom_domain = ?', [String(req.hostname || '').toLowerCase()]));
  const main = onSite ? await homeHost() : null;
  if (main && !(main.domain_on && main.custom_domain)) { req.isMain = true; return hostHome(req, res, main); }
  const [site, meets, owner] = await Promise.all([siteRow(), allUpcoming(), siteOwner()]);
  res.set('Cache-Control', 'no-cache').type('html').send(V.landing(site, { meets, instagram: owner && owner.instagram, origin: `${SCHEME}://${req.get('host')}` }));
});
/* ---------- a club member's page (/@handle), and the editor their link opens ---------- */
app.get(/^\/@([a-z0-9-]{3,40})(\/edit)?\/?$/i, async (req, res) => {
  const mm = /^\/@([a-z0-9-]{3,40})(\/edit)?\/?$/i.exec(req.path);
  if (req.own || req.vendorSub) return res.redirect(302, `${SCHEME}://${SITE_DOMAIN}${req.originalUrl}`);
  const m = await get('SELECT * FROM members WHERE handle = ?', [mm[1].toLowerCase()]);
  if (!m) return notFound(req, res, null);
  if (mm[1] !== m.handle) return res.redirect(301, '/@' + m.handle + (mm[2] || ''));
  const host = await get('SELECT * FROM hosts WHERE id = ?', [m.host_id]);
  if (!host) return notFound(req, res, null);
  if (mm[2]) return res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' }).type('html').send(V.memberEdit(host, m));
  const [photos, club] = await Promise.all([
    all("SELECT * FROM member_photos WHERE member_id = ? AND (kind = 'photo' OR status = 'ready') ORDER BY id DESC", [m.id]),
    m.club_id ? get("SELECT id, name, file, instagram FROM kit_logos WHERE id = ? AND kind = 'group'", [m.club_id]) : null]);
  // The crew: others in the same club (their first photo as their face), like a top 8.
  const crew = club ? await all(`SELECT m.handle, m.name, (SELECT CASE WHEN p.kind = 'video' THEN p.poster ELSE p.file END FROM member_photos p WHERE p.member_id = m.id AND (p.kind = 'photo' OR p.status = 'ready') ORDER BY p.id LIMIT 1) AS face
    FROM members m WHERE m.club_id = ? AND m.id != ? ORDER BY m.updated_at DESC LIMIT 8`, [club.id, m.id]) : [];
  const vid = m.video_status === 'ready' && m.video ? m : host.video && host.video_status === 'ready' ? host : null;
  res.set('Cache-Control', 'no-cache').type('html').send(V.memberPage(host, m, { photos, club, crew, vid, origin: `${SCHEME}://${req.get('host')}` }));
});

app.get('/:a', async (req, res, next) => {
  if (req.own) {
    const m = await meetOn(req.own, req.params.a, req.meetName);
    if (m && toName(req, res, req.own, m)) return;
    return m ? renderMeet(req, res, req.own, m, false) : notFound(req, res, req.own);
  }
  if (U.RESERVED.has(req.params.a)) return next();
  const a = String(req.params.a).toLowerCase();
  const host = await get('SELECT * FROM hosts WHERE slug = ?', [a]);
  if (!host) {
    // A meet name (<site>/fuel-friday): its next week.
    const nh = await N.hostOfName(a);
    if (!nh) return notFound(req, res, null);
    req.meetName = a;
    return hostHome(req, res, nh);
  }
  if (host.domain_on && host.custom_domain && req.query.demo !== '1') return res.redirect(301, `${SCHEME}://${host.custom_domain}/`);
  return hostHome(req, res, host);
});
app.get('/:a/:b', async (req, res, next) => {
  if (req.own) return notFound(req, res, req.own);
  if (U.RESERVED.has(req.params.a)) return next();
  const a = String(req.params.a).toLowerCase();
  const host = await get('SELECT * FROM hosts WHERE slug = ?', [a]);
  if (!host) {
    // A week of a meet name (<site>/fuel-friday/<date>).
    const nh = await N.hostOfName(a);
    if (!nh) return notFound(req, res, null);
    req.meetName = a;
    const m = await meetOn(nh, req.params.b, a);
    return m ? renderMeet(req, res, nh, m, false) : notFound(req, res, nh);
  }
  if (host.domain_on && host.custom_domain) return res.redirect(301, `${SCHEME}://${host.custom_domain}/${encodeURIComponent(req.params.b)}`);
  const m = await meetOn(host, req.params.b);
  if (m && toName(req, res, host, m)) return;
  return m ? renderMeet(req, res, host, m, false) : notFound(req, res, host);
});
app.get('/:a/food/:truck', async (req, res, next) => (req.own ? foodPage(req, res, req.own, req.params.a, req.params.truck) : next()));
app.get('/:a/:b/food/:truck', async (req, res) => {
  if (req.own) return notFound(req, res, req.own);
  const a = String(req.params.a).toLowerCase();
  let host = await get('SELECT * FROM hosts WHERE slug = ?', [a]);
  if (!host) { host = await N.hostOfName(a); if (host) req.meetName = a; }
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
  await nameMeets().catch((e) => console.error('meet names:', e.message));
  const Vid = require('./video');
  for (const t of ['hosts', 'meets', 'site', 'host_portal', 'kit_logos', 'members']) {
    await D.run(`UPDATE ${t} SET video_status = 'failed', video_error = ? WHERE video_status = 'processing'`,
      ['The server restarted while this video was processing. Upload it again.']).catch(() => {});
  }
  await D.run("UPDATE member_photos SET status = 'failed' WHERE status = 'processing'").catch(() => {});
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
/** Meets saved before meet names had addresses get theirs (from the title, or the host's name); the food side is told
    the new page link. */
async function nameMeets() {
  const rows = await all('SELECT * FROM meets WHERE page_name IS NULL ORDER BY day DESC');
  for (const m of rows) {
    const h = await get('SELECT * FROM hosts WHERE id = ?', [m.host_id]);
    if (!h) continue;
    await N.ensure(h, m);
    if (m.status === 'on' && U.meetTimes(m, tzOf(h)).endsAt > Date.now() && N.onName(h, m)) await K.syncMeet(h, m, N.meetUrl(h, m)).catch(() => {});
  }
}
module.exports = { app, orderMail, tidyAtStart, nameMeets, ready: () => D.ensureSchema() };
