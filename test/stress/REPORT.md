# AZ Monarchy (carmeet) — stress test report

> **Applied.** All 14 fixes in `fixes/` are now in the app code on `restart` (applied in order on top of this commit). The diffs stay here as the record; they will not apply again. With them: existing suite 52/52, reproductions 44/44 (run `node test/stress/fixtures.js --big` first).

Branch `restart` at `fe1c6eb` ("Member name is optional…"), tested 23–24 Oct 2026. App code was not changed: every
script, test and proposed fix lives under `test/stress/`. Each proposed fix was applied to a scratch copy of the repo,
checked against the existing suite (52/52 pass) and against the reproduction it targets; the diffs in `fixes/` are
exactly what was run.

**Test machine.** 2 vCPU, 7 GB RAM, Linux, Node 22.23, SQLite 3.52 (sqlite3 6.0.1 built from source), ffmpeg 6.1 with
x264/x265/libwebp, Chromium 153 (Playwright). The server was pinned to CPUs 0–1 (`taskset`), but this machine only has
those two, so the load generator shares them. On the real Hetzner box Caddy and Online Kitchen share the same two
cores, so treat these numbers as roughly what the site gets there.

**Setup notes.**
- `npm install` is blocked here (the registry answers 403), so express 5.3.0, dotenv 18.0.9 and sqlite3 6.0.1 and their
  dependencies were installed from their GitHub sources at the matching tags (`node_modules` is not committed).
- Existing suite before starting: **52/52 pass**. It is timing-sensitive: twice during this work it failed 8/52 while
  other heavy jobs were using the CPU, then passed 52/52 when the machine was quiet.
- Reproductions (`test/stress/repro/*.repro.js`, 44 checks): on the code as it is, 30 fail (security 9, integrity 9,
  food side 8, media 4) and 14 pass; with all 14 fixes applied, 44/44 pass, and the existing suite stays 52/52.
- Production (section 9): this sandbox's network refuses connections to azmonarchy.com, so TLS, header, compression and
  timing checks could not run from here. Page content was checked through a web fetcher (4 requests). `prod-check.sh`
  runs the full section 9 checks from your own computer (one request a second, about 30 in all).

## Summary

| Area | Result | Worst numbers (code as it is) | With the proposed fixes |
|---|---|---|---|
| 1. Load and latency | **FAIL** | Tops out at ~40–48 req/s on 2 cores. Page p95 at 50 concurrent: **0.7–2.3 s** (target 300 ms). 30 s timeouts from 150 concurrent (7.5% at 300). No 5xx, no SQLITE_BUSY. 75% of CPU in `Intl.DateTimeFormat` construction. RSS ~490 MB. 01–03: 240 req/s (5×), page p95 at 50 concurrent 155–412 ms, no errors at 300, RSS ~190 MB. All fixes: 1,000 phones in 10 s → page p95 30 ms (see 7 PM) |
| 2. Heavy work next to pages | **FAIL** | Encodes overlap (H.264 + HEVC at once in 17% of samples); uploads took 64–152 s just to be accepted; a restart leaves 602 MB of uploads and ffmpeg still running; 4 "JPEG bomb" uploads → 2.1 GB of ffmpeg memory Pages p95 117 → 123 ms with 5 encodes running (no page cache) or 118 → 111 ms (with it); never two encodes; 395 MB accepted in 43–64 s; a restart stops ffmpeg and clears `uploads/tmp`; bombs refused |
| 3. Food side failing | **FAIL** | Pages fine for hang/500/garbage (cold page 807 ms). But a reply of the wrong shape makes **every meet page 500** (and stays 500 after recovery). Portal: settings 160 s, deleting a vendor 150 s, kit list 60 s, logo reading 30 s; deleted vendors stay invited in 15/15 meets | All portal calls ≤ ~5 s (menu proxy ≤ 15 s); pages survive bad replies |
| 4. Weak signal / service worker | **Mostly pass** | First paint ~1.0 s at 700 ms RTT from the page alone, blur placeholders ✓; second visit 1.2 s ✓; offline meet page ✓; sign-out isolation ✓ (6/6). Fails: the background clip **never restarts after a dead spot**; offline, the portal's first tab only says "No connection"; the server answers 500 to an unsatisfiable range | Clip restarts (without the worker ~10 s after signal returns) |
| 5. Security and abuse | **FAIL (7 issues)** | Ownership, sessions, member keys, server-side escaping, traversal, type spoofing, open redirects, CSRF, proxy headers: **all hold**. Fails: image bombs, Host header in email/return links, crowd-unfriendly limits (28 of 40 people refused), password guessing across addresses (300/300 tried), `/caddy/ask` answers visitors, food-side numbers run as script in the portal, client mistakes logged as 500s | All 19 security repros pass |
| 6. Data integrity | **FAIL (8 issues)** | Two meets share one address on one night; two hosts get the same address at once; renaming breaks old links and splits weeks; "again" passes the 30-meet limit (43); photo limit passed (41/30); a deleted truck comes back in "trucks you've had"; canceled meets vanish; a live overnight meet can't be edited after midnight. DST math ✓, last-write-wins ✓ | All 13 integrity repros pass |
| 7. Soak (110 min recorded, 20 req/s) | **Pass with leaks** | Heap flat (20–37 MB), file handles flat (33–40), no SQLITE_BUSY, no app errors. RSS 467 → 504 MB from minute 10 to 110. Grows without bound: picture-copy lookups (21,388 entries), the "copy being made" set (9,755), blur and size caches (~800 each); orphaned picture copies on disk: 3,627 files / 48.6 MB | Bounded caches; copies deleted with their originals (repros pass) |
| 8. Branding | **FAIL (2)** | `/static/portal.js` (public) says "Online Kitchen"; the invite text hosts send vendors carries the food side's own link. Pages, sign-up and member pages: clean (246 addresses crawled; production pages clean too) | Portal text fixed; invite link needs the food side (see M9) |
| 9. Production | **Not run** | Blocked by this sandbox's network | Run `bash test/stress/prod-check.sh` |

The soak was planned at 125 minutes; this sandbox stops background jobs at 2 hours, which cut it at ~118 minutes (last
checkpoint at 110.7). Run `node test/stress/run-soak.js --minutes 150` on a machine without that limit for 2+ hours.

Scripts: `run-load.js` (1), `run-heavy.js` and `run-bomb.js` (2), `run-kitchen.js` (3), `run-sw.js`, `run-bgloop.js` (4),
`run-xss-portal.js` (5), `run-soak.js` (7), `run-branding.js` (8), `run-7pm.js` (the meet at 7 PM), `run-profile.js`
(CPU profile). Failing tests: `repro/*.repro.js` (run with `node --test test/stress/repro/*.repro.js`; they are named `.repro.js`
so `npm test` doesn't pick them up). The fixes build on each other: `git apply test/stress/fixes/*.diff` applies all 14 in
order (checked on a clean copy: the result is exactly the tested tree). Raw results: `out/*.json`, screenshots `out/shots/`. Media fixtures are made by
`node test/stress/fixtures.js --big` (not committed).

## Findings, by severity

### C1 (critical) — Every page spends most of its time building date formatters; the site saturates at ~40 req/s

**What happens.** `util.js` builds a new `Intl.DateTimeFormat` on every call to `zone()`, `parts()` and `fmt()`.
`meetTimes()` calls them about eight times, and pages call `meetTimes()` for every meet they list (80 on `/meets`).
Building a formatter loads the zone's rules, so it costs ~0.6 ms each time. A CPU profile under page load:

```
self time:  zone util.js:10 34.9%   parts util.js:12 34.5%   fmt util.js:43 4.3%     (util.js 75.4% of all CPU)
inclusive:  meetTimes 64.2%   upcomingOf 25.1%   allUpcoming 22.5%
```

**Who it hurts.** Everyone at once at a meet: on 2 cores the whole site does ~40 requests a second.

| clients | req/s | worst page p95 | page p50 range | errors | event loop p99 | RSS |
|---|---|---|---|---|---|---|
| 10 | 37 | 684 ms | 84–347 ms | 0 | 239 ms | 484 MB |
| 50 | 42 | 2,346 ms | 461–1,634 ms | 0 | 429 ms | 493 MB |
| 150 | 43 | 16,668 ms | 1.2–4.3 s | 0.6% (30 s timeouts) | 715 ms | 497 MB |
| 300 | 48 | 30,002 ms | 1.3–4.6 s | 7.5% (30 s timeouts) | 764 ms | 507 MB |

The knee is below 10 concurrent clients; the CPU gives out first (event loop utilisation 0.96–1.0 from 10 clients).
No 5xx and no SQLITE_BUSY at any step: the single SQLite connection kept up. The ~490 MB RSS (heap only 36 MB) is ICU
memory churned by the formatters; with the fix it is ~180 MB.

**Reproduce.** `node test/stress/run-load.js` (ramp 10→50→150→300, 45 s each) and `node test/stress/run-profile.js`.
Evidence: `out/load-mixed.json`, `out/profile.json`.

**Fix** (`fixes/01-intl-formatter-cache.diff`, plus `02` and `03` below). Same results, 18× faster per call:

```diff
-const zone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'America/Phoenix'; } };
+// Building an Intl.DateTimeFormat costs far more than using one (it loads the zone's rules): make each once, keep it.
+const zones = new Map();
+const zone = (tz) => {
+  let z = zones.get(tz);
+  if (z === undefined) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); z = tz; } catch (e) { z = 'America/Phoenix'; } if (zones.size < 500) zones.set(tz, z); }
+  return z;
+};
+const formatters = new Map();
+function formatter(tz, key, opts) {
+  const k = tz + '|' + key;
+  let f = formatters.get(k);
+  if (!f) { f = new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz }, opts)); if (formatters.size < 2000) formatters.set(k, f); }
+  return f;
+}
+const PARTS = { hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' };
 function parts(ms, tz) {
-  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone(tz), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
+  const f = formatter(zone(tz), 'parts', PARTS);
@@
-const fmt = (ms, tz, opts) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: zone(tz) }, opts)).format(new Date(ms));
+const fmt = (ms, tz, opts) => formatter(zone(tz), JSON.stringify(opts), opts).format(new Date(ms));
```

With 01 alone: 194 req/s, page p95 at 10 clients 40–120 ms. The next costs were synchronous gzip of every HTML and
JSON answer (22% of CPU, on the event loop) and `formatToParts` itself (17%):
`fixes/02-memoize-meet-times.diff` keeps each meet's start/end per day/time/zone (5,000 entries at most);
`fixes/03-gzip-off-event-loop.diff` compresses with `zlib.gzip` (thread pool) instead of `gzipSync`, at level 5, and
`GZIP_PAGES=0` turns it off when Caddy's `encode` does it.

| clients | 01–03: req/s | worst page p95 | page p95 range | errors | RSS |
|---|---|---|---|---|---|
| 10 | 251 | 89 ms | 38–89 ms | 0 | 192 MB |
| 50 | 229 | 412 ms | 155–412 ms | 0 | 210 MB |
| 150 | 238 | 1,401 ms | 439–1,401 ms | 0 | 281 MB |
| 300 | 240 | 2,223 ms | 855–2,223 ms | 0 | 350 MB |

Meet and vendor pages are still just over the 300 ms target at 50 concurrent with the load generator on the same two
cores; fix 11 (the page micro-cache) is what closes the gap at a meet (see "7 PM" below).

### C2 (critical) — One food-side reply of the wrong shape takes every meet page down, and it stays down

**What happens.** `loadTrucks_()` keeps whatever `vendors` the food side sends *before* checking it, then calls
`.filter` on it. A reply like `{"vendors": "nope"}` (a food-side bug, a half-deployed version, a proxy answering 200 with
something else) throws, the bad value is already in `truckCache`, and every page that shows trucks answers **500**:
the host's page, every meet-name address and week, every vendor profile, the food page, the portal's dashboard,
trucks panel and history. Right after the food side is fixed, pages keep failing until the kept list ages out.

**Who it hurts.** Attendees (no page at all), hosts (portal tabs fail).

**Reproduce.** `node --test --test-name-pattern="wrong shape" test/stress/repro/kitchen.repro.js` → `[500, 500]` for the
meet page during and right after. `run-kitchen.js` mode `wrongshape`: 6 public pages and 3 portal tabs answer 500.

Related, same root (the answer isn't checked): a **200 whose body isn't JSON** counts as success with nothing in it.
The host's invite message then reads *"Open this to set up (no account needed): undefined"*; `send-link` throws (500);
and a looked-up order's copy here is overwritten with `status/payment/ticket/total = null`.

**Fix** (`fixes/05-food-side-answers-validated.diff`): only a real list replaces the kept one; a non-JSON 2xx is a failure;
an order is updated only from a reply that has a status; and changes mark the kept truck list stale instead of deleting
it, so a page still has the last list when the food side is down at that moment.

```diff
-    return { ok: r.ok, status: r.status, data: data || { error: 'The food side didn’t answer properly.' } };
+    // A 2xx whose body isn't a JSON object is a failure, not "ok with nothing in it".
+    const good = !!data && typeof data === 'object' && !Array.isArray(data);
+    return { ok: r.ok && good, status: r.ok && !good ? 502 : r.status, data: good ? data : { error: 'The food side didn’t answer properly.' } };
@@ server.js loadTrucks_
-  const list = r.ok ? (r.data.vendors || []) : (c ? c.list : []);
-  truckCache.set(m.ref, { at: Date.now(), list });
-  if (r.ok) {
+  // Only a real list replaces the one kept: anything else (an error, a body of the wrong shape) keeps the last good one.
+  const got = r.ok && Array.isArray(r.data.vendors) ? r.data.vendors.filter((v) => v && typeof v === 'object' && !Array.isArray(v)) : null;
+  const list = got || (c ? c.list : []);
+  truckCache.set(m.ref, { at: got ? Date.now() : (c ? c.at : Date.now()), list });
+  if (got) {
@@ refreshOrder
-  if (r.ok) {
+  if (r.ok && typeof r.data.status === 'string' && typeof r.data.payment === 'string') {
@@ host.js: truckCache.delete(m.ref) → staleTrucks(m.ref) (6 places)
+  const staleTrucks = (ref) => { const c = truckCache.get(ref); if (c) c.stale = true; };
```

### H1 (high) — Image "bombs" and unqueued ffmpeg: one member link can push the server past its memory

**What happens.** `saveImage()` checks the first bytes but not the picture's size. A 1.4 MB JPEG of 16000×16000
pixels is accepted, and its feed copy is made at once by `V.small()` in the upload route (not through the
one-at-a-time picture queue). Four of them from one member link, in 65 ms: **5 ffmpeg at once, 2.1 GB of RSS**
(426 MB each). A member's limit is 30 photos (and that limit can be passed, see M8), at 300 requests per 15 minutes.
Logos (`trimLogo`) decode the full image too. On a 4–8 GB server running Online Kitchen as well, the OOM killer
decides which process dies.

**Who it hurts.** Everyone on the server, from anyone holding a member link (texted to members) or a host account.

**Reproduce.** `node test/stress/run-bomb.js 4` (`out/bomb.json`); `security.repro.js` "JPEG bomb" (accepted, 201).

**Fix** (`fixes/08-media-queue-files-and-bombs.diff`, the image part): read the width and height from the JPEG frame
header or PNG IHDR and refuse more than 50 megapixels before anything decodes it; the member photo's feed copy goes
through the pages' one-at-a-time picture queue.

```diff
   async function saveImage(buf) {
     ...
     if (!isJpeg && !isPng) return null;
+    const dim = isJpeg ? jpegSize(buf) : buf.length > 24 ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
+    if (!dim || !dim.w || !dim.h || dim.w * dim.h > MAX_PIXELS) return null; // a phone photo is 12 to 50 megapixels
@@
-    V.small(path.join(UPLOAD_DIR, name), UPLOAD_DIR, 1080).catch(() => {}); // the feed's size, ready before anyone looks
+    Vw.small(name, 1080); // the feed's size, queued with the other picture copies (one ffmpeg at a time)
+/* Its width and height, from the first frame header (SOF0–SOF15, not DHT/JPG/DAC), or null. */
+const MAX_PIXELS = 50e6;
+function jpegSize(buf) { /* walks the markers to the first SOFn; see the diff */ }
```

### H2 (high) — The portal waits on the food side one meet at a time; deleting a vendor leaves its invites

**What happens** with the food side hung (it answers after 30 s), unreachable, or erroring:

| portal call | food side hung | why |
|---|---|---|
| Settings: change name/accent/close time | **160 s** | one 10 s wait per upcoming meet (16), one after another |
| Delete a Food vendor | **150 s** | a fresh truck list per upcoming meet, one after another |
| Flyer kit list (`GET /kit`) | **60 s** | sends each unsent logo (20 s timeout each) before answering |
| Read logos | 30 s (would be 70 s if truly hung) | 70 s timeout |
| Post/edit a meet, trucks panel, dashboard, invite, send-link | 10 s | one 10 s call (meets: saved, marked "not sent") |
| Public pages | 7–807 ms | kept truck list, or 800 ms then none ✓ |
| Menu through `/meet/*` (meet mode) | **as long as the food side** (25 s in the test) | `up.setTimeout(0)`: no limit at all |

Deleting a vendor whose truck is in meets: in **every** failure mode (hang, 500, garbage, reset, refused) its invites
stay on the food side in **15/15** upcoming meets, nothing retries, and the truck keeps showing under Food on the
meet pages. Even with the food side healthy, the delete re-adds the truck to `host_vendors` ("trucks you've had before",
a one-tap re-invite) in the same request: it refreshes the truck list (which still has the truck "in") before it
drops the invites, and that refresh writes `host_vendors` without checking `kit_gone`.

**Who it hurts.** Hosts (a phone spinning for minutes at the meet), vendors (a truck the host removed stays listed).

**Reproduce.** `node test/stress/run-kitchen.js` (`out/kitchen.log`, `out/kitchen-original.json`);
`kitchen.repro.js` (settings 80 s with 8 meets; still invited in 1 meet; menu waited 25 s);
`integrity.repro.js` "deleting a logo…" and "deleted while the food side is down…".

**Fix** (`fixes/06-portal-never-waits-on-the-food-side.diff`): meets re-sync three at a time behind the scenes (the
request waits at most 5 s, so with a healthy food side it's as before); unsent logos go behind the scenes; a deleted
truck is dropped by `dropGone()` (waits at most 5 s, then retried every 5 minutes until no upcoming meet has it, and it
re-checks `kit_gone` before each drop so a truck re-invited meanwhile isn't dropped); pages, the trucks panel and
`host_vendors` skip trucks in `kit_gone`; the AI logo read is capped at 30 s; `/meet/*` gives up after 15 s.

```diff
-    if (closeChanged || name !== h.name || accent !== h.accent) { for (const m of await all(...)) await sync(fresh, m); }
+    if (closeChanged || name !== h.name || accent !== h.accent) {
+      const all3 = syncAll(fresh, await all(...));   // three at a time, behind the scenes
+      await Promise.race([all3, new Promise((ok) => setTimeout(ok, 5000))]); // usually done by then; never more than 5 s
+    }
@@ DELETE /kit/:id
-      const meets = ...; for (const m of meets) { const list = await trucksFor(m, { fresh: true }) ...; await K.dropInvite(...); }
+      await Promise.race([dropGone(req.me.id).catch(() => {}), new Promise((ok) => setTimeout(ok, 5000))]);
+  setInterval(async () => { ... for (const x of await all('SELECT DISTINCT host_id FROM kit_gone')) await dropGone(x.host_id); ... }, 5 * 60000).unref();
@@ meetproxy.js
-    up.setTimeout(0);
+    up.setTimeout(15000, () => up.destroy(new Error('the food side took too long')));
```

### H3 (high) — Video work: the queue overlaps, uploads crawl under load, a restart leaves 600 MB and ffmpeg behind

1. **Two encodes at once.** HEVC copies run on `hevcQueue`, which waits for the `videoQueue` *as it was*; a clip
   uploaded after that starts its H.264 next to the running HEVC. Sampled every 500 ms during 5 uploads: 2 encodes at
   once in 73 of 418 samples. With `THREADS = cpus − 1`, that's both cores.
2. **Uploads accepted only after 64–152 s** (96 MB, 395 MB, two 1080p clips, a vendor clip, streamed over localhost)
   while pages were under load: the upload's data events wait behind page renders on the saturated event loop. On a
   phone at a meet, add the network.
3. **Restart mid-encode** (pm2 restart = SIGTERM): statuses correctly become "failed" with *"The server restarted while
   this video was processing. Upload it again."* ✓. But the running ffmpeg processes **keep going** (orphaned; they
   finished a minute later and wrote output nothing uses), and the five originals (**602 MB**) stay in
   `uploads/tmp` for good. The host has to upload all five again, including the ones that hadn't started.
4. Pages during the encodes: on the code as it is, pages were already at p95 2.7 s from the page load alone, so ffmpeg
   (at nice 19) made no measurable difference (2.75 s → 2.70 s); with the fixes, see "With the fixes" below. The 200
   pictures without copies were all made within 152 s, one at a time ✓.

**With the fixes** (`out/heavy-fixes*.json`): pages-only baseline vs the same load with the 5 uploads and 200 missing
copies — without the page cache, 20 clients: p95 117 → 123 ms (+6%); with all fixes, 50 clients: 118 → 111 ms. Never
more than one encode (0 of 351 samples), ffmpeg always at nice 19, uploads accepted in 3–43 s (the 395 MB one in 43 s
instead of 152), the 200 copies made in 55 s instead of 152, and after a restart: statuses "failed", no ffmpeg left,
`uploads/tmp` empty.

**Reproduce.** `node test/stress/run-heavy.js` (`out/heavy-original.json`, `.log`); `media.repro.js`
("the video queue…" 2 encodes; "a restart mid-encode…" 1 upload left, 1 encode still running).

**Fix** (`fixes/08-media-queue-files-and-bombs.diff`): one worker for all video jobs, new clips first, HEVC after,
never two at once; ffmpeg children tracked and killed on exit/SIGTERM/SIGINT (`pixels()` gets nice 19 too); leftover
`uploads/tmp/in-*` removed at start.

```diff
-  let videoQueue = Promise.resolve(); // one at a time, so a big upload never starves the site of CPU
-  let hevcQueue = Promise.resolve();
-  function hevcLater(...) { hevcQueue = hevcQueue.then(() => videoQueue).then(async () => { ... }); }
+  const jobs = { main: [], hevc: [] };
+  let working = false;
+  async function pump() {
+    if (working) return;
+    working = true;
+    try { for (let fn; (fn = jobs.main.shift() || jobs.hevc.shift());) { try { await fn(); } catch (e) { console.error('video:', e.message); } } } finally { working = false; }
+  }
+  const enqueue = (kind, fn) => { jobs[kind].push(fn); pump(); };
@@ video.js
+const kids = new Set();
+const stopKids = () => { for (const p of kids) { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } } };
+process.once('exit', stopKids);
+for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { stopKids(); process.exit(0); });
@@ server.js tidyAtStart
+  try { for (const f of fs.readdirSync(path.join(UPLOAD_DIR, 'tmp'), { withFileTypes: true })) if (f.isFile() && /^in-[a-f0-9]+$/.test(f.name)) fs.promises.unlink(path.join(UPLOAD_DIR, 'tmp', f.name)).catch(() => {}); } catch (e) { /* no tmp folder yet */ }
```

### H4 (high) — Limits made for one person refuse a crowd on one network

**What happens.** Limits are per address: alert sign-ups and vendor requests 12 per 10 minutes, pre-orders 30 per
10 minutes, menu reads and menu photos 120 per minute. At a meet, the venue's Wi-Fi or a carrier's shared address
(CGNAT) puts many phones behind one address: in the test, **28 of 40 people** signing up for alerts were refused
("Too many tries"). One menu is 20+ photos, so six phones on one address exhaust the photo limit in a minute.

**Reproduce.** `security.repro.js` "a crowd on one network…".

**Fix** (`fixes/09-host-header-limits-caddy-ask.diff`, part): limits sized for a crowd (60 sign-ups/10 min, 150
orders/10 min, 900 reads/min per address); the per-email (5 min) and per-host vendor (3/day) checks stay.

### M1 — Client mistakes become 500s, and the logo sheet splitter can't work

The error handler answers 500 for everything: bad JSON (400), a body over 50 KB (413), a range past the end of a clip
(416, from `send`), a broken `%` escape in `/static` (URIError). They are logged as `Error:` and counted as server
failures. Worse, `/api/host/logo-read` sets a 20 MB limit, but `app.use(express.json({ limit: '50kb' }))` runs first:
the logo sheet splitter (`public/flyer.js`) sends up to 16 PNG cut-outs as base64 in one body, so reading names from a
logo sheet always fails ("Something went wrong on our side"; one 122 KB logo is enough).

**Reproduce.** `security.repro.js` "client mistakes…" (`[500, 500, 500]` for `[400, 413, 416]`), "reading logos…".

**Fix** (`fixes/04-error-status-and-logo-read-limit.diff`):

```diff
+app.use('/api/host/logo-read', express.json({ limit: '20mb' }));
 app.use(express.json({ limit: '50kb' }));
@@
 app.use((err, req, res, next) => {
-  console.error('Error:', err);
+  const code = err instanceof URIError ? 400 : Number(err.status || err.statusCode) || 500;
+  if (code >= 500) console.error('Error:', err);
   if (res.headersSent) return;
+  if (code < 500) {
+    if (err.headers) res.set(err.headers); // Content-Range on a 416
+    const msg = code === 413 ? 'That’s too big to send.' : code === 416 ? 'Range not satisfiable.' : 'That request didn’t look right.';
+    return req.path.startsWith('/api/') ? res.status(code).json({ error: msg }) : res.status(code).type('text').send(msg);
+  }
```

### M2 — Links in emails (and the card page's way back) come from the Host header

`/api/alerts` builds the confirmation link from `req.get('host')`; the pre-order's `returnUrl` (sent to the food side for
Stripe's return) and the pages' `og:image` do too. Behind Caddy's catch-all on-demand block, any Host header reaches
the site once TLS is done for a real name. A forged `Host: evil.test` sends the victim a real confirmation email, in the
host's name, from this site's domain, linking to `http://evil.test/alerts/yes?t=<token>`; a forged pre-order sends the
buyer back from Stripe to the attacker's site.

**Reproduce.** `security.repro.js` "links in emails…" → `http://evil.test/alerts/yes?t=…`.

**Fix** (`fixes/09`, part): `publicOrigin(req)` uses the request's host only when it is the site, www, a vendor
subdomain or a host's own domain that's on; otherwise `SITE_DOMAIN`.

### M3 — Meet addresses: shared on one night, raced between hosts, broken by a rename

- Two different meets on the same night can both be given `/cars-and-coffee/<date>`; only one is reachable.
- Two hosts saving the same new meet address at the same moment both get it (check, then update, with awaits between);
  the address then shows whichever host's meet is newest.
- Renaming a meet's address changes only that week: the old link (`/sunday-cruise/<date>`) gives **404**, and the
  other weeks keep the old name, so the meet is split across two addresses. Vendor pages keep old addresses
  (`kit_old_slugs`); meet names don't.

**Reproduce.** `integrity.repro.js` (three tests). **Fix** (`fixes/10-data-integrity.diff`): the name is claimed in one
`UPDATE … WHERE NOT EXISTS (…)` statement (other hosts, same night, vendor pages, old addresses); a rename moves every
week and records the old name in `meet_old_names`, which `/:a` and `/:a/:b` forward with a 301.

### M4 — Email holds requests: no timeout, and updates go one by one

`mail.deliver()` has no timeout and `/api/alerts` awaits it: with Resend slow (20 s in the test), the sign-up answers
after 20 s. An update to the alert list sends one email after another: **200 subscribers took 33 s** at a normal
150 ms per call (the host's request waits throughout; Caddy has no response timeout).

**Reproduce.** `kitchen.repro.js` "signing up for alerts…", "an update to 200 people…" (a local stand-in for Resend
via `FAKE_RESEND`). **Fix** (`fixes/07-email-never-holds-a-request.diff`): 10 s timeout (a failure waits in the outbox
and is retried, as designed); the confirmation is sent behind the scenes; updates send 8 at a time (200 → 4 s).

### M5 — The background clip gives up for good after a dead spot

`bgloop.js` stops reloading a clip after 6 tries (`reloads > 5`), and the count never resets. Arriving with no signal
for 60–90 s uses up the tries; when the signal comes back the background stays a still frame for the rest of the visit
(still frozen at 300 s, with and without the service worker). In a normal 30-minute run (drops, 20 s outages every
3–5 minutes, the tab frozen and back every 2–4 minutes) there was no freeze with the service worker and one 4 s
freeze at first load without it ✓.

With the service worker, the clip also restarts slowly after a dead spot (~55 s after signal returns on a clean link)
and in a 4-minute run on a flaky 60 KB/s link it never started: the worker downloads the whole clip in one request
(no resume after a dropped connection), a download that never started stayed in its `loads` map, and its fallback
`fetch(req)` had no time limit. The two concrete problems are fixed below; the whole-file download strategy is worth
revisiting (let range requests pass to the network until a clip is fully kept). *Partially verified.*

**Reproduce.** `node test/stress/run-bgloop.js --minutes 5 --dark-first 90` (`out/bgloop-dark-start.json`).
**Fix** (`fixes/12-bgloop-retries-and-sw-ranges.diff`): reset the count when it plays; after 6 tries rest 30 s and try
again; retry on `online`; in the worker, forget a failed start and give the fallback a 20 s limit. Without the worker
the clip then started ~10 s after signal returned.

### M6 — Files and memory that only grow (soak)

Over 110 recorded minutes at 20 req/s (124,868 requests) with file churn (998 flyers replaced, 742 vendor photos added
and 739 removed, 4,203 member photos added, a feed clip every 15 minutes, 4,020 alert sign-ups and vendor requests
from many addresses): the JS heap stayed flat (20–37 MB), open files flat (33–40), event loop p99 ~100 ms, no
SQLITE_BUSY and no app errors. RSS crept from 467 MB (minute 10) to 504 MB (minute 110), +0.4 MB/min, with the heap
flat: native memory, most likely the formatter churn of C1 (`out/soak.svg`). But:
- **Picture copies outlive their pictures.** Replacing a flyer, removing a vendor photo or logo, deleting a member photo
  deletes the original and leaves its `.s<size>.webp` copies: **3,627 orphaned files (48.6 MB)** after 110 minutes,
  ~330 more every 10 minutes at this churn.
- **In-memory maps in `views.js` never shrink**: `smallSeen` 8,004 → **21,388** entries (minute 10 → 110), `making`
  1,376 → **9,755** (every copy ever queued; a copy that failed is never retried until a restart), `tinyCache` (a data
  URL per flyer or still ever shown) and `sizeCache` ~800 each. Slow, but unbounded.
- The rate-limit maps stayed bounded (~500–800 entries, cleaned every window) ✓.
- (The member-photo deletes in the soak didn't run: the harness read gzipped answers as text. The delete path is
  covered by `media.repro.js` instead.)

**Reproduce.** `node test/stress/run-soak.js` (`out/soak.json`, `out/soak.svg`); `media.repro.js` "deleting a member
photo…", "a flyer replaced…". **Fix** (`fixes/08`, part): `unlinkUpload()` also removes the copies and tells
`views.forget()`; every unlink in `host.js` goes through it; the maps are capped; `making` forgets finished jobs.

### M7 — "Repeat next week" and photo uploads pass their limits

`POST /meets` refuses a 31st upcoming meet; `POST /meets/:id/again` doesn't check (43 upcoming after repeated
repeats, each synced to the food side). The 30-photo limit is a count followed by an insert: 45 uploads at once left
**41**. **Fix** (`fixes/10`, part): the same 30 check in `again`; the photo insert counts in the same statement.

### M8 — Demo password: 10 tries per address, nothing overall

`/api/host/password` allows 10 tries per address per 15 minutes and nothing else. An IPv6 /64 is billions of
addresses: **300 of 300** guesses from one /64 were tried. **Fix** (`fixes/09`, part): count an IPv6 address by its
/64, and stop all password tries for 15 minutes after 30 wrong ones overall.

### M9 — Branding: "Online Kitchen" in a public file, and the food side's link in vendor invites

- `public/portal.js` (served to anyone at `/static/portal.js`, shown to hosts): *"Trucks with their own Online Kitchen
  (one tap, they accept in their app)"*. Fix: `fixes/13-branding-portal-text.diff`.
- The text a host copies to invite a truck ends with the food side's own invite URL (`r2.data.url`, verbatim). In
  production that is presumably an onlinekitchen.fyi address, which car-meet vendors then see. Not fixable on this side
  alone: either the food side returns invite links on the meet's domain (it already serves menus under `/meet/*`), or
  this site serves `/join/<code>` itself. **Verify** what the real food side returns.
- Everything else is clean: 246 addresses crawled (pages, vendor sign-up, member pages, the scripts and styles they
  load), and production's `/`, `www`, `/vendors` and `/members`.

### M10 — Food-side numbers run as script in the host portal

`trucksHtml()` in `portal.js` puts `v.preorders`, `v.plates` and `v.inviteId` into the page without escaping, and
`truckShape()` passes them through untyped. A food side that sends a string there (a bug, or a compromise) runs script
in every host's portal. Everything hosts, members and vendors type is escaped (payloads in 38 fields, all portal tabs,
the member editor, meet, food and vendor pages: none ran). **Reproduce.** `node test/stress/run-xss-portal.js`.
**Fix** (`fixes/14-food-side-fields-escaped-in-portal.diff`): numbers coerced in `truckShape()`, escaped in the portal.

### Low

- **L1 `/caddy/ask` answers visitors.** It checks `req.socket.remoteAddress`, which is 127.0.0.1 for everything Caddy
  passes on, so `https://azmonarchy.com/caddy/ask?domain=<x>` tells anyone which names (vendors, own domains) exist.
  Fix (`fixes/09`): also refuse when `X-Forwarded-For` is present (Caddy's own ask doesn't send it).
- **L2 A live overnight meet can't be edited after midnight** ("That date already passed"): fixed in `fixes/10`
  (a meet still going keeps its date). Cancel still worked.
- **L3 Canceled meets vanish from Upcoming meets** instead of showing "Canceled" (someone who saw it earlier isn't told):
  fixed in `fixes/10`.
- **L4 Offline, the portal opens but its first tab says "No connection"**: `/api/host/dashboard` isn't in the worker's
  kept lists (Flyer kit, Meets, Members open fine). Fixed in `fixes/12`.
- **L5 The worker answers 416 to an invalid or multi-range `Range`** where a server ignores it (200, whole file);
  the server itself answered 500 to an unsatisfiable range (M1). Fixed in `fixes/12` and `fixes/04`.
- **L6 `/alerts/yes?t=<token>` has no `Cache-Control`**, so the service worker keeps the page with its token in the
  address. Fixed (`no-store`) in `fixes/09`.
- **L7** `PUT /requests/:id` and `DELETE /locations/:id` answer 200 to another host's id (nothing changes; misleading).
- **L8** `/history` asks for up to 12 past meets' trucks one after another (≤ 9.6 s with the food side down).
- **L9** The existing suite is timing-sensitive (8/52 failed twice under CPU load, 52/52 when quiet).

### What held (no change needed)

Sessions (made-up, expired, signed-out cookies refused); member keys (only their own page, old key dead after a new
link, can't change club/handle or delete); ownership (56 portal calls with another host's ids: no data read or changed);
server-written pages escape every field; no path out of `/static`, `/uploads` or `/food-photo`; HTML or SVG named .png
refused, a JPEG/HTML polyglot stays `image/jpeg` with `nosniff`; no open redirect (old meet-name and vendor subdomains,
absolute-form and odd request lines, `?host=`); CSRF (another origin, including a vendor subdomain, gets 403); `X-Meet-*`
and `X-Forwarded-For` from a visitor never reach the food side, nor the session cookie; the admin call needs its token;
portal answers are `no-store`; sign-out isolation in the worker (6 runs on a slow link: host B never saw host A's data);
first visit paints from the page alone (~1.0 s at 700 ms RTT, 10.7 KB on the wire, blur placeholders inline); second
visit ~1.2 s from the kept copy; offline meet page; clip ranges (0-1, 0-, middle, suffix, past the end) answered like
the server; a stalled clip download gives up (~23 s) and the next try works; a clip replaced mid-download is kept whole
or not at all; last write wins on concurrent meet edits with nothing half-written; DST lengths (6 h over fall-back,
4 h over spring-forward); a meet that's over says so and takes no orders.

## The meet at 7 PM

`node test/stress/run-7pm.js --phones N --window S`: N phones arrive evenly over S seconds (open loop: they come whether
or not the site keeps up), each opens the same meet page (seeded site: 3 hosts, 40 meets, 200 logos, 300 members),
then the 13 files that page loads; one in ten opens a truck's menu. Times are to the page's last byte.

| phones / window | build | page p50 | page p95 | page max | files p95 | menu p95 | failed | last phone done |
|---|---|---|---|---|---|---|---|---|
| 300 / 10 s | code as it is | 49 ms | 139 ms | 216 ms | 78 ms | 160 ms | 0 | 10 s |
| | fixes, no page cache | 7 ms | 12 ms | 28 ms | 15 ms | 29 ms | 0 | 10 s |
| | all fixes | 6 ms | 11 ms | 35 ms | 16 ms | 30 ms | 0 | 10 s |
| 600 / 5 s | code as it is | **4,283 ms** | **15,787 ms** | 16,169 ms | 8,804 ms | 8,251 ms | 0 | 17.1 s |
| | fixes, no page cache | 761 ms | 1,001 ms | 5,760 ms | 1,002 ms | 903 ms | 0 | 6.5 s |
| | all fixes | **17 ms** | **109 ms** | 2,462 ms | 707 ms | 237 ms | 0 | 5.0 s |
| 1,000 / 10 s | code as it is | **6,520 ms** | **11,393 ms** | 23,911 ms | 11,050 ms | 10,683 ms | 0 | 24.9 s |
| | fixes, no page cache | 188 ms | 522 ms | 6,870 ms | 375 ms | 488 ms | 0 | 10 s |
| | all fixes | **5 ms** | **30 ms** | 1,223 ms | 66 ms | 143 ms | 3 files of 13,000 | 10 s |

At 30 pages a second the site as it is keeps up. Past ~60 a second (600 phones in 5 s, or 1,000 in 10 s) it falls
behind and every phone waits: half wait over 4–6 s, the last ones 16–24 s, before even the page arrives, and on one bar
of signal the phone then still has to download it. With the fixes the page is there in tens of milliseconds and the
server is no longer what a phone waits for. (The 3 failed requests in the last run were static files during the
1,000-phone burst; out of 13,000.) Raw: `out/7pm-*.json`.

## The three changes that would most improve a real meet

Hundreds of phones on one bar of signal, all opening the same page at 7 PM:

1. **Stop rebuilding date formatters (fixes 01–03).** It's the single cause of the site's ~40 req/s ceiling: every
   page pays ~0.6 ms per formatter, dozens of times. Caching them (plus memoized meet times and gzip off the event loop)
   gives 5× the throughput and cuts RSS from ~490 to ~190 MB. Three small diffs, no behaviour change. With them (and the
   other fixes, but no page cache) 1,000 phones in 10 s go from a page p95 of 11.4 s to 0.5 s.
2. **Serve the same page once (fix 11).** At 7 PM every phone asks for the same few pages. Keeping each rendered public
   page for 5 s while the site is busy, and letting phones that arrive mid-render wait for that one render, turns
   hundreds of renders into one every few seconds: with it, 1,000 phones in 10 s get the page at p95 30 ms, 600 in 5 s
   at 109 ms. Quiet times are unchanged (it only switches on with 8+ requests in flight); any write clears it;
   signed-in hosts always get fresh pages.
3. **Never let the food side, email or a crowd's shared address take the night down (fixes 05, 06, 07, 09).** Validate
   what the food side sends (one bad reply currently 500s every meet page until it ages out), never wait on it in
   sequence or without a limit (the host's phone currently spins 1–3 minutes on Settings or deleting a vendor), send
   email behind the scenes, and size the per-address limits for a venue's Wi-Fi (today 28 of 40 people on one network
   are refused alerts).

Close behind: the image-size cap and single video queue (fix 08), so one member link can't take the server's memory
while the crowd is on it, and the background loop that keeps trying after a dead spot (fix 12), since a meet lot is
exactly where the signal drops.
