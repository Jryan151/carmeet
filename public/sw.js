/* sw.js — saves each background clip on the phone the first time it plays, then plays it from there every time after:
   no second download, and it works with no signal at the meet.

   Only the clips (/uploads/<name>.mp4) are touched. Every other request (pages, menus, orders, the food side through
   /meet/*) goes straight to the network as if this file didn't exist.

   iPhones ask for a video in pieces ("Range: bytes=0-1"), so a saved clip is answered piece by piece (206 Partial
   Content) from the saved copy. A clip's name changes whenever it's replaced, so a saved copy is never stale.
   The phone may clear these on its own (low storage, weeks unused); the clip then just downloads again. */
'use strict';
const CACHE = 'clips-v1';
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
  e.respondWith(clip(req, url.origin + url.pathname));
});

// The same clip is asked for many times while it loads; it downloads once.
const loading = new Map();

async function clip(req, key) {
  const range = req.headers.get('range');
  try {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(key);
    let blob = saved ? await saved.blob() : null;
    if (!blob) {
      if (!loading.has(key)) loading.set(key, save(cache, key).finally(() => loading.delete(key)));
      blob = await loading.get(key);
    }
    if (!blob) return fetch(req); // too big to keep, or it didn't download: play it straight from the site
    return range ? piece(blob, range) : whole(blob);
  } catch (err) {
    return fetch(req);
  }
}

const whole = (blob) => new Response(blob, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' } });

/** Downloads the whole clip once and keeps it (dropping the oldest when there are too many). Resolves the clip or null. */
async function save(cache, key) {
  const res = await fetch(key, { credentials: 'same-origin' });
  if (res.status !== 200) return null;
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return null;
  const blob = await res.blob();
  if (!blob.size || blob.size > MAX_BYTES) return null;
  try {
    await cache.put(key, whole(blob));
    const keys = await cache.keys(); // oldest first
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CLIPS))) await cache.delete(old);
  } catch (err) { /* storage full: still play this one */ }
  return blob;
}

/** One piece of a clip, the way a video player asks for it ("bytes=start-end", "bytes=start-", "bytes=-last"). */
function piece(blob, range) {
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  let start, end;
  if (m && m[1] !== '') { start = Number(m[1]); end = m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1; }
  else if (m && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  if (start === undefined || start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), { status: 206, headers: {
    'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
}
