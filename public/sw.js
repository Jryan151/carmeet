/* sw.js — keeps the site on the phone, so on one bar of signal (or none) it still shows at once.

   - Pages (a meet, a vendor, a member, the portal): fresh from the site when it answers quickly; when it doesn't
     (1 s), the copy from the last visit shows right away, the fresh one is saved behind it, and the page offers
     "Newer info · Refresh". With no signal at all, the saved copy. Never: order pages, editors, anything marked
     no-store, the API's writes.
   - The site's files (/static, versioned): kept, so they never download twice. Pictures (/uploads): their names
     change whenever they're replaced, so a kept copy is never stale.
   - The portal's lists (logos, meets, members, settings): fresh when it's quick, else the last ones.
   - Background clips (/uploads/<name>.mp4): they play as soon as the first bytes arrive, and that same download is
     kept, so every visit after plays from the phone.

   How a first clip play works: the clip is downloaded once, from start to end. Video players ask for it in pieces
   ("Range: bytes=0-1", "bytes=0-", "bytes=1234-"; iPhones always do), and each piece is answered (206 Partial
   Content) from that one download as soon as its bytes have arrived, so playback starts within the first few
   hundred KB instead of after the whole file. The phone may clear any of this on its own (low storage, weeks unused);
   it then just downloads again. */
'use strict';
const CACHE = 'clips-v3';
const PAGES = 'pages-v1', FILES = 'files-v1', PICS = 'pics-v1', LISTS = 'lists-v1';
const KEEP = [CACHE, PAGES, FILES, PICS, LISTS];
const STALL_MS = 15000; // no bytes for this long (a dead spot): the download stops, so it never hogs a weak signal
const QUICK_MS = 1000;  // a page slower than this: the saved copy shows instead (a good signal answers well under it)
const MAX_CLIPS = 8;                    // the most recent 8 clips kept; older ones make room
const MAX_BYTES = 40 * 1024 * 1024;     // a clip bigger than this isn't kept (a 15-second loop is far smaller)
const CLIP_RE = /^\/uploads\/[A-Za-z0-9._-]+\.mp4$/;
const PIC_RE = /^\/uploads\/[A-Za-z0-9._-]+\.(webp|jpe?g|png|gif)$/i;
const LIST_RE = /^\/api\/host\/(me|kit|meets|recaps|members|lots|portal-video|dashboard)$/; // dashboard: the first screen, offline too
const NO_PAGE_RE = /^\/(api|o|meet|caddy|food-photo|uploads|static|health|sw\.js)(\/|$)|\/edit\/?$|\/food\//;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});
// The portal says when someone signs out (or in): their lists go.
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'forget-lists') e.waitUntil(caches.delete(LISTS)); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (CLIP_RE.test(p)) return e.respondWith(clip(req, url.origin + p, e));
  if (PIC_RE.test(p)) return e.respondWith(kept(PICS, req, e, 240));
  if (p.startsWith('/static/')) return e.respondWith(url.searchParams.has('v') ? kept(FILES, req, e, 80) : quick(FILES, req, e, { ms: 0 }));
  if (LIST_RE.test(p)) return e.respondWith(quick(LISTS, req, e, { ms: 2500 }));
  if (req.mode === 'navigate' && !NO_PAGE_RE.test(p)) return e.respondWith(quick(PAGES, req, e, { ms: QUICK_MS, tell: true, max: 40 }));
});

/** A file whose name changes when it does: from the phone if it's there, else downloaded once and kept. */
async function kept(name, req, e, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.status === 200 && !/no-store/.test(res.headers.get('cache-control') || '')) e.waitUntil(put(cache, req, res.clone(), max));
  return res;
}
/** Fresh when it comes within `ms`; otherwise the kept copy at once, with the fresh one saved behind it (and the page
    told, when `tell`). No kept copy: whatever the network gives. */
async function quick(name, req, e, { ms, tell, max }) {
  const cache = await caches.open(name);
  const hit = await cache.match(req, { ignoreVary: true, ignoreSearch: false });
  const net = fetch(req).then((res) => {
    // The portal's lists say no-store (no shared cache may keep them); this copy is the host's own phone's, and it's
    // dropped when they sign out.
    const store = res.ok && res.status === 200 && res.type === 'basic' && !res.redirected && (name === LISTS || !/no-store/.test(res.headers.get('cache-control') || ''));
    if (store) e.waitUntil(put(cache, req, res.clone(), max || 120));
    return res;
  });
  if (!hit) return net;
  const copy = tell ? hit.clone() : null; // to compare with the fresh one later (the page reads the other)
  let late = false;
  const timer = new Promise((ok) => setTimeout(() => { late = true; ok(null); }, ms));
  const first = await Promise.race([net.catch(() => null), timer]);
  if (first) return first;
  // Too slow (or no signal): the kept copy now, and the page hears when the fresh one is in.
  if (tell && late) e.waitUntil(net.then(async (res) => {
    if (!res || !res.ok) return;
    const [a, b] = await Promise.all([copy.text(), res.clone().text()]).catch(() => ['', '']);
    if (a && b && strip(a) !== strip(b)) {
      const c = await self.clients.get(e.resultingClientId || e.clientId);
      if (c) c.postMessage({ type: 'page-fresh' });
    }
  }).catch(() => {}));
  return hit;
}
// The parts of a page that change on every visit (its version tag) don't count as news.
const strip = (html) => html.replace(/\?v=[a-z0-9]+/g, '');
async function put(cache, req, res, max) {
  try {
    await cache.put(req, res);
    const keys = await cache.keys(); // oldest first
    for (const old of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(old);
  } catch (err) { /* storage full: it still showed */ }
}

/* ---------- one download per clip, shared by every piece asked for while it comes in ---------- */
const loads = new Map(); // key → { size, chunks: [Uint8Array], got, done, failed, wake: [fn] }

function startLoad(key, e) {
  const L = { size: 0, chunks: [], got: 0, done: false, failed: false, wake: [] };
  const notify = () => { const w = L.wake; L.wake = []; w.forEach((f) => f()); };
  const ctrl = new AbortController();
  let dog = setTimeout(() => ctrl.abort(), STALL_MS);
  const pet = () => { clearTimeout(dog); dog = setTimeout(() => ctrl.abort(), STALL_MS); };
  L.ready = (async () => {
    const res = await fetch(key, { credentials: 'same-origin', signal: ctrl.signal });
    const size = Number(res.headers.get('content-length') || 0);
    if (res.status !== 200 || !res.body || !size) { L.failed = true; return false; }
    L.size = size;
    const reader = res.body.getReader();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          L.chunks.push(value); L.got += value.length; pet(); notify();
        }
        L.done = true; notify();
        if (L.got === L.size && L.size <= MAX_BYTES) await keep(key, new Blob(L.chunks, { type: 'video/mp4' }));
      } catch (err) { L.failed = true; notify(); loads.delete(key); }
      finally { clearTimeout(dog); setTimeout(() => { if (loads.get(key) === L) loads.delete(key); }, 30000); }
    })();
    if (e && e.waitUntil) e.waitUntil(pump); // keep the worker alive until the clip is in
    return true;
  })().catch(() => { L.failed = true; return false; });
  // A download that never got going (no signal at all) is forgotten, so the next ask starts a fresh one.
  L.ready.then((ok) => { if (!ok && loads.get(key) === L) loads.delete(key); });
  loads.set(key, L);
  return L;
}
/** Bytes [from, to] of the download, waiting for them to arrive. */
function bytes(L, from, to) {
  return new Promise((ok, no) => {
    const tryNow = () => {
      if (L.got > to || (L.done && L.got >= to + 1)) {
        const out = new Uint8Array(to - from + 1); let pos = 0, at = 0;
        for (const c of L.chunks) {
          const s = Math.max(from, pos), e = Math.min(to + 1, pos + c.length);
          if (s < e) { out.set(c.subarray(s - pos, e - pos), at); at += e - s; }
          pos += c.length; if (pos > to) break;
        }
        return ok(out);
      }
      if (L.failed || L.done) return no(new Error('clip download stopped'));
      L.wake.push(tryNow);
    };
    tryNow();
  });
}
/** A range of the download as a stream: each part goes out as soon as it has arrived. */
function streamOf(L, from, to) {
  let at = from;
  const STEP = 256 * 1024;
  return new ReadableStream({
    async pull(ctrl) {
      if (at > to) { ctrl.close(); return; }
      const end = Math.min(to, at + STEP - 1, Math.max(at, L.got - 1));
      try { ctrl.enqueue(await bytes(L, at, Math.max(at, end))); at = Math.max(at, end) + 1; } catch (err) { ctrl.error(err); }
    },
  });
}

async function clip(req, key, e) {
  const range = req.headers.get('range');
  try {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(key);
    if (saved) { const blob = await saved.blob(); return range ? piece(blob, range) : whole(blob); }
    const L = loads.get(key) || startLoad(key, e);
    // Couldn't start it this way: straight from the site, range and all (the player resumes where it got to), with a
    // time limit so a dead spot can't hold it open.
    if (!(await L.ready)) return fetch(req, { signal: AbortSignal.any ? AbortSignal.any([req.signal, AbortSignal.timeout(20000)]) : req.signal });
    const r = parse(range, L.size);
    if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${L.size}` } });
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(r.to - r.from + 1) };
    if (!range || r.whole) return new Response(streamOf(L, 0, L.size - 1), { status: 200, headers });
    headers['Content-Range'] = `bytes ${r.from}-${r.to}/${L.size}`;
    return new Response(streamOf(L, r.from, r.to), { status: 206, headers });
  } catch (err) {
    return fetch(req);
  }
}

async function keep(key, blob) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(key, whole(blob));
    const keys = await cache.keys(); // oldest first
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CLIPS))) await cache.delete(old);
  } catch (err) { /* storage full: it still played */ }
}

const whole = (blob) => new Response(blob, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' } });

/** A range as asked ("bytes=start-end", "bytes=start-", "bytes=-last") → { from, to }, or null if it's outside. */
function parse(range, size) {
  if (!range) return { from: 0, to: size - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  // Not one range we can read (garbage, several ranges): answered whole, as a server does (RFC 9110 14.2).
  if (!m || (m[1] === '' && m[2] === '')) return { from: 0, to: size - 1, whole: true };
  let from, to;
  if (m && m[1] !== '') { from = Number(m[1]); to = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1; }
  else if (m && m[2] !== '') { from = Math.max(0, size - Number(m[2])); to = size - 1; }
  if (from === undefined || from > to || from >= size) return null;
  return { from, to };
}
/** One piece of a kept clip. */
function piece(blob, range) {
  const r = parse(range, blob.size);
  if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  if (r.whole) return whole(blob);
  return new Response(blob.slice(r.from, r.to + 1), { status: 206, headers: {
    'Content-Type': 'video/mp4', 'Content-Length': String(r.to - r.from + 1), 'Content-Range': `bytes ${r.from}-${r.to}/${blob.size}`, 'Accept-Ranges': 'bytes' } });
}
