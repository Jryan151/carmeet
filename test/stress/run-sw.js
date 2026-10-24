'use strict';
/* Section 4 — weak signal and the service worker, in Chromium (Playwright) behind a throttling proxy
   (700 ms round trips, ~40 KB/s, some dropped connections).
   node test/stress/run-sw.js
   A first visit · B second visit and "Newer info is ready" · C offline · D clip ranges, a stall, a clip replaced while
   being kept · E sign out, then another host signs in on a slow connection. Screenshots in test/stress/out/shots. */
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const S = require('./lib/site');
const { seed, db } = require('./lib/seed');
const { throttle } = require('./lib/throttle');

const OUT = path.join(__dirname, 'out');
const SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const ONLY = process.env.ONLY || 'ABCDE';
const on = (x) => ONLY.includes(x);
const note = (area, check, pass, evidence) => { results.push({ area, check, pass, evidence }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${check} · ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`); };

(async () => {
  const ctx = await S.start({ cpus: '0,1' });
  const w = await seed(ctx, { members: 12, photosEach: 3, withoutCopies: 0, kit: 30, meets: 8 });
  const D = db(ctx.dbFile);
  const hA = w.hosts[0], hB = w.hosts[1];
  // Things only host A has, to spot in host B's portal.
  await S.req(ctx, 'POST', '/api/host/kit/entry', { cookie: hA.cookie, body: { kind: 'vendor', name: 'ALPHA-PRIVATE-TRUCK' }, headers: { Origin: 'http://meets.test' } });
  await S.req(ctx, 'POST', '/api/host/members', { cookie: hA.cookie, body: { name: 'ALPHA-PRIVATE-MEMBER', car: 'Secret' }, headers: { Origin: 'http://meets.test' } });
  const meet = w.meets.find((m) => m.hostIdx === 0 && m.flyer);
  const meetPath = new URL(meet.url).pathname;
  const proxy = await throttle({ target: { port: Number(ctx.port) } }).listen();
  const origin = `http://localhost:${proxy.port}`;
  console.log('site', ctx.base, 'through the weak signal at', origin, 'meet page', meetPath);
  const browser = await chromium.launch();

  /* ---------- A: first visit ---------- */
  if (on('A')) {
    proxy.mode = 'weak'; proxy.dropRate = 0;
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const p = await c.newPage();
    await p.addInitScript(() => { window.__fcp = null; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); });
    const t0 = Date.now();
    await p.goto(origin + meetPath, { waitUntil: 'commit', timeout: 60000 });
    await p.waitForFunction(() => window.__fcp !== null, null, { timeout: 60000 });
    await p.screenshot({ path: path.join(SHOTS, 'A-first-paint.png') });
    const nav = await p.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const r = performance.getEntriesByType('resource'); return { ttfb: n.responseStart, htmlDone: n.responseEnd, fcp: window.__fcp, bytes: n.encodedBodySize, firstSubDone: Math.min(...r.map((x) => x.responseEnd).filter((x) => x > 0), 1e9), blockingCss: document.querySelectorAll('link[rel=stylesheet]').length, headScripts: [...document.head.querySelectorAll('script')].filter((s) => !s.defer && !s.async).length,
      flyerBlur: !!document.querySelector('.flyer.has-blur') && /data:image\/webp/.test(document.querySelector('.flyer').getAttribute('style') || ''), bgBlur: /data:image\/webp/.test((document.querySelector('.page-bg') || { getAttribute: () => '' }).getAttribute('style') || '') }; });
    note('first visit', 'no stylesheet or blocking script to wait for (styles inline)', nav.blockingCss === 0 && nav.headScripts === 0, nav);
    note('first visit', 'first paint comes from the page alone, before any other file finishes', nav.fcp <= nav.firstSubDone + 5, `FCP ${Math.round(nav.fcp)} ms, page done ${Math.round(nav.htmlDone)} ms, first other file done ${Math.round(nav.firstSubDone)} ms, first byte ${Math.round(nav.ttfb)} ms, page ${nav.bytes} B on the wire`);
    note('first visit', 'blur placeholders inside the page (flyer and background still)', nav.flyerBlur && nav.bgBlur, nav);
    await p.waitForTimeout(15000);
    await p.screenshot({ path: path.join(SHOTS, 'A-after-15s.png') });
    /* ---------- B: second visit ---------- */
    await p.evaluate(() => navigator.serviceWorker.ready);
    const ctl = await p.evaluate(async () => { for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100)); return !!navigator.serviceWorker.controller; });
    const p2 = await c.newPage();
    await p2.addInitScript(() => { window.__fcp = null; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); });
    await p2.goto(origin + meetPath, { waitUntil: 'commit', timeout: 60000 });
    await p2.waitForFunction(() => window.__fcp !== null, null, { timeout: 60000 });
    const fcp2 = await p2.evaluate(() => window.__fcp);
    note('second visit', 'the saved page shows in about 1 s on the weak signal', fcp2 < 1600, `controller ${ctl}; FCP ${Math.round(fcp2)} ms (first visit ${Math.round(nav.fcp)} ms)`);
    // The host changes the meet; the next visit should offer the newer page.
    await S.req(ctx, 'PUT', `/api/host/meets/${meet.id}`, { cookie: hA.cookie, headers: { Origin: 'http://meets.test' }, body: { day: meet.day, start: meet.start, end: meet.end, place: meet.place, address: meet.address, title: meet.title, notes: 'Moved to the north lot ' + Date.now() } });
    const p3 = await c.newPage();
    await p3.goto(origin + meetPath, { waitUntil: 'commit', timeout: 60000 });
    let bar = false; const tb = Date.now();
    try { await p3.waitForSelector('.fresh-bar', { timeout: 45000 }); bar = true; } catch (e) { /* none */ }
    await p3.screenshot({ path: path.join(SHOTS, 'B-newer-info.png') });
    const shownFresh = await p3.evaluate((n) => document.body.innerText.includes(n), 'Moved to the north lot').catch(() => false);
    const p3nav = await p3.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { responseStart: Math.round(n.responseStart), fromSW: n.workerStart > 0 }; }).catch(() => ({}));
    note('second visit', '"Newer info is ready" shows when the saved page was out of date', bar || shownFresh, bar ? `bar after ${Date.now() - tb} ms` : shownFresh ? `the fresh page came within 1 s and showed directly (${JSON.stringify(p3nav)})` : `the old page showed and no bar came within 45 s (${JSON.stringify(p3nav)})`);
    /* ---------- C: offline ---------- */
    // The portal once online (so its lists are kept), then no signal at all.
    await c.addCookies([{ name: 'mh_session', value: hA.cookie.split('=')[1], domain: 'localhost', path: '/' }]);
    const pp = await c.newPage();
    await pp.goto(origin + '/host', { waitUntil: 'load', timeout: 90000 });
    await pp.waitForSelector('#portal:not([hidden])', { timeout: 60000 }).catch(() => {});
    await pp.waitForTimeout(12000); // its lists load in the background
    proxy.mode = 'offline'; proxy.kickAll();
    const po = await c.newPage();
    const off1 = await po.goto(origin + meetPath, { timeout: 30000 }).then((r) => r && r.status()).catch((e) => 'error ' + e.message.split('\n')[0]);
    const offText = await po.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => '');
    await po.screenshot({ path: path.join(SHOTS, 'C-offline-meet.png') });
    note('offline', 'the saved meet page opens with no signal', off1 === 200 && /the spot|food/i.test(offText), `${off1}: ${offText.replace(/\s+/g, ' ').slice(0, 80)}`);
    const pq = await c.newPage();
    const off2 = await pq.goto(origin + '/host', { timeout: 30000 }).then((r) => r && r.status()).catch((e) => 'error ' + e.message.split('\n')[0]);
    await pq.waitForTimeout(6000);
    const portalText = await pq.evaluate(() => document.body.innerText).catch(() => '');
    await pq.screenshot({ path: path.join(SHOTS, 'C-offline-portal.png') });
    note('offline', 'the portal opens, signed in, from the phone', off2 === 200 && /tasty tuesday/i.test(portalText), `${off2}: ${portalText.replace(/\s+/g, ' ').slice(0, 120)}`);
    note('offline', 'its first screen (Next meet) shows something other than an error', !/No connection/i.test(portalText), portalText.replace(/\s+/g, ' ').slice(0, 200));
    await pq.click('[data-tab="kit"]').catch(() => {}); await pq.waitForTimeout(2500);
    const kitText = await pq.evaluate(() => document.body.innerText).catch(() => '');
    note('offline', 'a saved list (Flyer kit) opens offline', /Truck \d|Club \d/.test(kitText) && !/No connection/i.test(kitText), kitText.replace(/\s+/g, ' ').slice(0, 160));
    proxy.mode = 'weak';
    await c.close();
  }

  /* ---------- D: clip ranges, a stall, a clip replaced while kept ---------- */
  if (on('D')) {
    const clips = (await D.all("SELECT file FROM member_photos WHERE kind = 'video'")).map((x) => x.file).concat((await D.all('SELECT video FROM hosts')).map((x) => x.video));
    const c = await browser.newContext();
    const p = await c.newPage();
    proxy.mode = 'ok';
    await p.goto(origin + '/members', { waitUntil: 'load' });
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload(); await p.evaluate(async () => { for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100)); });
    const size = fs.statSync(path.join(w.uploads, clips[0])).size;
    const direct = (range) => new Promise((ok) => http.get({ host: '127.0.0.1', port: ctx.port, path: '/uploads/' + clips[0], headers: Object.assign({ Host: 'meets.test' }, range ? { Range: range } : {}) }, (r) => { let n = 0; r.on('data', (d) => { n += d.length; }); r.on('end', () => ok({ status: r.statusCode, len: n, cr: r.headers['content-range'] || '' })); }));
    const ranges = [null, 'bytes=0-1', 'bytes=0-', 'bytes=1000-1999', 'bytes=-500', `bytes=${size - 10}-${size + 100}`, `bytes=${size}-`, 'bytes=99999999-', 'bytes=abc', 'bytes=0-1,5-6', 'bytes=5-2'];
    const rows = [];
    for (const r of ranges) {
      const viaSw = await p.evaluate(async ([u, range]) => { try { const res = await fetch(u, { headers: range ? { Range: range } : {} }); const b = await res.arrayBuffer(); return { status: res.status, len: b.byteLength, cr: res.headers.get('content-range') || '' }; } catch (e) { return { status: 'error', len: 0, cr: e.message }; } }, ['/uploads/' + clips[0], r]);
      const dir = await direct(r);
      rows.push({ range: r || '(none)', sw: viaSw, server: dir, same: viaSw.status === dir.status && viaSw.len === dir.len });
    }
    for (const r of rows) note('clips', `Range ${r.range}: service worker answers like the server`, r.same, `sw ${r.sw.status}/${r.sw.len} ${r.sw.cr} · server ${r.server.status}/${r.server.len} ${r.server.cr}`);
    // A stall: the second clip stops after 300 KB. The download should give up at about 15 s and work on a later try.
    proxy.mode = 'weak'; proxy.dropRate = 0;
    const fresh = await p.evaluate(async (list) => { const c2 = await caches.open('clips-v3'); const out = []; for (const f of list) if (!(await c2.match(location.origin + '/uploads/' + f))) out.push(f); return out; }, clips);
    const stallClip = fresh[0], replaceClip = fresh[1];
    proxy.rules = (pth) => (pth.includes(stallClip) ? { stallAfter: 300 * 1024 } : null);
    const ts = Date.now();
    const stalled = await p.evaluate(async (u) => { const t = performance.now(); try { const res = await fetch(u, { headers: { Range: 'bytes=0-' } }); const b = await res.arrayBuffer(); return { status: res.status, len: b.byteLength, ms: performance.now() - t }; } catch (e) { return { status: 'error', err: e.message, ms: performance.now() - t }; } }, '/uploads/' + stallClip);
    note('clips', 'a stalled download gives up after about 15 s', stalled.status === 'error' && stalled.ms > 13000 && stalled.ms < 25000, stalled);
    proxy.rules = () => null; proxy.mode = 'ok';
    const retry = await p.evaluate(async (u) => { try { const res = await fetch(u); const b = await res.arrayBuffer(); return { status: res.status, len: b.byteLength }; } catch (e) { return { status: 'error', err: e.message }; } }, '/uploads/' + stallClip);
    note('clips', 'the next try downloads it whole', retry.status === 200 && retry.len === fs.statSync(path.join(w.uploads, stallClip)).size, retry);
    // Replaced while being kept: the file goes away on the server mid-download (a new clip was uploaded).
    proxy.mode = 'weak';
    const third = replaceClip;
    const fetching = p.evaluate(async (u) => { try { const res = await fetch(u); const b = await res.arrayBuffer(); return { status: res.status, len: b.byteLength }; } catch (e) { return { status: 'error', err: e.message }; } }, '/uploads/' + third);
    await S.sleep(4000);
    fs.unlinkSync(path.join(w.uploads, third));
    const got = await fetching;
    proxy.mode = 'ok';
    await S.sleep(1000);
    const cached = await p.evaluate(async (u) => { const c2 = await caches.open('clips-v3'); const r = await c2.match(location.origin + u); return r ? (await r.blob()).size : null; }, '/uploads/' + third);
    note('clips', 'a clip replaced mid-download: the phone keeps either the whole old file or nothing', cached === null || cached === got.len, `download ${JSON.stringify(got)}, kept ${cached} B`);
    await c.close();
  }

  /* ---------- E: sign out, then another host signs in on a slow connection ---------- */
  if (on('E')) {
    proxy.mode = 'weak'; proxy.dropRate = 0; proxy.rules = () => null;
    const c = await browser.newContext();
    await c.addCookies([{ name: 'mh_session', value: hA.cookie.split('=')[1], domain: 'localhost', path: '/' }]);
    const p = await c.newPage();
    await p.goto(origin + '/host', { waitUntil: 'load', timeout: 90000 });
    await p.waitForSelector('#portal:not([hidden])', { timeout: 90000 });
    await p.waitForTimeout(15000); // A's lists are kept (prefetch)
    await p.click('[data-tab="settings"]');
    await p.waitForSelector('#signOut', { timeout: 180000 });
    // The signal gets worse (answers take over 3 s), and A's lists are on their way when A signs out — the way
    // they are when someone taps around the portal and then hands the phone over.
    proxy.rules = (pth) => (pth.startsWith('/api/host/') ? { extraMs: 3200 } : null);
    await p.evaluate(() => { ['/me', '/kit', '/meets', '/members', '/recaps'].forEach((u) => fetch('/api/host' + u, { cache: 'no-store' }).catch(() => {})); });
    await p.waitForTimeout(300);
    await p.click('#signOut');
    await p.waitForSelector('#signin:not([hidden])', { timeout: 60000 });
    // Host B signs in on the same phone with their email code.
    await p.fill('#email', 'west@side.test');
    await p.click('#fEmail [type=submit]');
    await p.waitForSelector('#fCode:not([hidden])', { timeout: 60000 });
    let devCode = null;
    for (let i = 0; i < 40 && !devCode; i++) { devCode = (/Test code: (\d{6})/.exec((await p.textContent('#signMsg')) || '') || [])[1]; if (!devCode) await p.waitForTimeout(250); }
    await p.fill('#code', devCode);
    await p.click('#fCode [type=submit]');
    const seen = new Set(); const whereSeen = {};
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      const txt = await p.evaluate(() => document.body.innerText).catch(() => '');
      for (const s2 of ['ALPHA-PRIVATE-TRUCK', 'ALPHA-PRIVATE-MEMBER', 'owner@tasty.test', 'meets.test/tasty-tuesday', 'Sunday Cruise']) if (txt.includes(s2)) {
        if (!seen.has(s2)) {
          const where = await p.evaluate((needle) => { const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w2.nextNode())) if (n.nodeValue.includes(needle)) { let e = n.parentElement; for (let i = 0; i < 3 && e.parentElement && e.parentElement !== document.body; i++) e = e.parentElement; e.scrollIntoView(); e.style.outline = '3px solid red'; return { tab: (document.querySelector('[data-tab][aria-selected=true]') || {}).textContent, html: e.outerHTML.slice(0, 600) }; } return null; }, s2);
          await p.screenshot({ path: path.join(SHOTS, 'E-host-B-sees-' + s2.replace(/[^a-z]/gi, '') + '.png') });
          whereSeen[s2] = where;
        }
        seen.add(s2);
      }
      if (i === 8) await p.click('[data-tab="kit"]').catch(() => {});
      if (i === 20) await p.click('[data-tab="members"]').catch(() => {});
      if (i === 32) await p.click('[data-tab="meets"]').catch(() => {});
      await p.waitForTimeout(500);
    }
    await p.screenshot({ path: path.join(SHOTS, 'E-host-B-portal.png') });
    const keptLists = await p.evaluate(async () => { const c2 = await caches.open('lists-v1'); const out = []; for (const k of await c2.keys()) { const r = await c2.match(k); out.push([new URL(k.url).pathname, (await r.text()).slice(0, 4000)]); } return out; });
    note('sign out', 'host B never sees host A’s data on a slow connection', seen.size === 0, `seen within ${Math.round((Date.now() - t0) / 1000)} s: ${[...seen].join(', ') || 'nothing'} ${JSON.stringify(whereSeen)}; lists kept on the phone now: ${keptLists.map(([k, v]) => k + (/ALPHA|owner@tasty|Sunday Cruise|tasty-tuesday/.test(v) ? ' (A’s)' : ' (B’s)')).join(', ')}`);
    proxy.rules = () => null;
    await c.close();
  }

  S.writeJson(path.join(OUT, 'sw.json'), results);
  await browser.close();
  proxy.close();
  await D.close();
  await ctx.stop();
})().catch((e) => { console.error(e); S.writeJson(path.join(OUT, 'sw.json'), results); process.exit(1); });
