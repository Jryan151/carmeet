/* sw.js — background clips: they play as soon as the first bytes arrive, and the same download is kept on the phone,
   so every visit after plays from the phone (no second download, and it works with no signal at the meet).

   Only the clips (/uploads/<name>.mp4) are touched. Every other request (pages, menus, orders, the food side through
   /meet/*) goes straight to the network as if this file didn't exist.

   How a first play works: the clip is downloaded once, from start to end. Video players ask for it in pieces
   ("Range: bytes=0-1", "bytes=0-", "bytes=1234-"; iPhones always do), and each piece is answered (206 Partial
   Content) from that one download as soon as its bytes have arrived, so playback starts within the first few
   hundred KB instead of after the whole file. When the download finishes it's kept. A clip's name changes whenever
   it's replaced, so a kept copy is never stale. The phone may clear these on its own (low storage, weeks unused);
   the clip then just downloads again. */
'use strict';
const CACHE = 'clips-v2';
const MAX_CLIPS = 8;                    // the most recent 8 clips kept; older ones make room
const MAX_BYTES = 40 * 1024 * 1024;     // a clip bigger than this isn't kept (a 15-second loop is far smaller)
const CLIP_RE = /^\/uploads\/[A-Za-z0-9._-]+\.mp4$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('clips-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !CLIP_RE.test(url.pathname)) return;
  e.respondWith(clip(req, url.origin + url.pathname, e));
});

/* ---------- one download per clip, shared by every piece asked for while it comes in ---------- */
const loads = new Map(); // key → { size, chunks: [Uint8Array], got, done, failed, wake: [fn] }

function startLoad(key, e) {
  const L = { size: 0, chunks: [], got: 0, done: false, failed: false, wake: [] };
  const notify = () => { const w = L.wake; L.wake = []; w.forEach((f) => f()); };
  L.ready = (async () => {
    const res = await fetch(key, { credentials: 'same-origin' });
    const size = Number(res.headers.get('content-length') || 0);
    if (res.status !== 200 || !res.body || !size) { L.failed = true; return false; }
    L.size = size;
    const reader = res.body.getReader();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          L.chunks.push(value); L.got += value.length; notify();
        }
        L.done = true; notify();
        if (L.got === L.size && L.size <= MAX_BYTES) await keep(key, new Blob(L.chunks, { type: 'video/mp4' }));
      } catch (err) { L.failed = true; notify(); }
      finally { setTimeout(() => loads.delete(key), 30000); }
    })();
    if (e && e.waitUntil) e.waitUntil(pump); // keep the worker alive until the clip is in
    return true;
  })().catch(() => { L.failed = true; return false; });
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
    if (!(await L.ready)) return fetch(req); // couldn't start it this way: plain from the site
    const r = parse(range, L.size);
    if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${L.size}` } });
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(r.to - r.from + 1) };
    if (!range) return new Response(streamOf(L, 0, L.size - 1), { status: 200, headers });
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
  return new Response(blob.slice(r.from, r.to + 1), { status: 206, headers: {
    'Content-Type': 'video/mp4', 'Content-Length': String(r.to - r.from + 1), 'Content-Range': `bytes ${r.from}-${r.to}/${blob.size}`, 'Accept-Ranges': 'bytes' } });
}
