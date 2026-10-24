'use strict';
/* Section 4 (long part) — the background loop (public/bgloop.js) over --minutes (default 30) on a weak signal with
   dropped connections, a short outage every few minutes, and the tab put in the background (frozen, as a phone does
   when you switch apps) and brought back.
   Two phones at once: one with the service worker (the clip is kept after its first download), one without it
   (private browsing, storage cleared, or still on its first download).
   Every second: the clip's position. A freeze is the clip not moving for more than 3 s while the tab is in front.
   node test/stress/run-bgloop.js [--minutes 30] */
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const S = require('./lib/site');
const { seed } = require('./lib/seed');
const { throttle } = require('./lib/throttle');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg('minutes', 30));
const DARK_FIRST = Number(arg('dark-first', 0)); // seconds at the start with the clip unreachable (arriving with no signal)
const OUT = path.join(__dirname, 'out');

(async () => {
  const ctx = await S.start({ cpus: '0,1' });
  const w = await seed(ctx, { members: 6, photosEach: 1, withoutCopies: 0, kit: 10, meets: 6 });
  const meet = w.meets.find((m) => m.hostIdx === 0);
  const proxy = await throttle({ target: { port: Number(ctx.port) }, rttMs: 700, bps: 60 * 1024, dropRate: 0.08 }).listen();
  const origin = `http://localhost:${proxy.port}`;
  if (DARK_FIRST) { proxy.rules = (pth) => (/\.mp4/.test(pth) ? { stallAfter: 0 } : null); setTimeout(() => { proxy.rules = () => null; }, DARK_FIRST * 1000); }
  const browser = await chromium.launch();
  const phones = [];
  for (const sw of [true, false]) {
    const c = await browser.newContext({ serviceWorkers: sw ? 'allow' : 'block', viewport: { width: 390, height: 844 } });
    const p = await c.newPage();
    await p.addInitScript(() => {
      window.__loads = 0; const real = HTMLMediaElement.prototype.load;
      HTMLMediaElement.prototype.load = function () { window.__loads++; return real.apply(this, arguments); };
    });
    await p.goto(origin + new URL(meet.url).pathname, { waitUntil: 'load', timeout: 120000 });
    const cdp = await c.newCDPSession(p);
    phones.push({ name: sw ? 'with service worker' : 'without service worker', p, cdp, frozen: false, samples: [], freezes: [], stuckSince: null, lastT: null });
  }
  const t0 = Date.now();
  const end = t0 + MINUTES * 60000;
  let nextOutage = t0 + (DARK_FIRST ? 1e9 : 3 * 60000), nextBackground = t0 + (DARK_FIRST ? 1e9 : 2 * 60000);
  while (Date.now() < end) {
    const now = Date.now();
    if (now >= nextOutage) { proxy.mode = 'offline'; proxy.kickAll(); setTimeout(() => { proxy.mode = 'weak'; }, 20000); nextOutage = now + (3 + Math.random() * 2) * 60000; }
    if (now >= nextBackground) {
      for (const ph of phones) { ph.frozen = true; await ph.cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).catch(() => {}); }
      setTimeout(async () => { for (const ph of phones) { await ph.cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {}); ph.frozen = false; ph.lastT = null; ph.stuckSince = null; } }, 15000);
      nextBackground = now + (2 + Math.random() * 2) * 60000;
    }
    for (const ph of phones) {
      if (ph.frozen) continue;
      const s = await ph.p.evaluate(() => { const v = document.querySelector('.page-bg video'); return v ? { t: v.currentTime, rs: v.readyState, paused: v.paused, err: v.error ? v.error.code : 0, net: v.networkState, src: (v.currentSrc || '').split('/').pop(), loads: window.__loads } : null; }).catch(() => null);
      if (!s) continue;
      ph.samples.push(Object.assign({ at: Math.round((now - t0) / 1000) }, s));
      if (ph.lastT !== null && Math.abs(s.t - ph.lastT) < 0.01) { if (!ph.stuckSince) ph.stuckSince = now; }
      else if (ph.stuckSince) { const d = now - ph.stuckSince; if (d > 3000) ph.freezes.push({ fromS: Math.round((ph.stuckSince - t0) / 1000), forS: Math.round(d / 1000) }); ph.stuckSince = null; }
      ph.lastT = s.t;
    }
    await S.sleep(1000);
  }
  const out = phones.map((ph) => {
    if (ph.stuckSince && Date.now() - ph.stuckSince > 3000) ph.freezes.push({ fromS: Math.round((ph.stuckSince - t0) / 1000), forS: Math.round((Date.now() - ph.stuckSince) / 1000), stillFrozenAtEnd: true });
    const last = ph.samples[ph.samples.length - 1] || {};
    const longest = Math.max(0, ...ph.freezes.map((f) => f.forS));
    return { phone: ph.name, freezes: ph.freezes.length, longestFreezeS: longest, frozenTotalS: ph.freezes.reduce((a, f) => a + f.forS, 0), loads: last.loads, last, firstFreezes: ph.freezes.slice(0, 12) };
  });
  for (const o of out) console.log(JSON.stringify(o));
  S.writeJson(path.join(OUT, DARK_FIRST ? 'bgloop-dark-start.json' : 'bgloop.json'), { minutes: MINUTES, darkFirstS: DARK_FIRST, proxy: proxy.stats, phones: out });
  await browser.close(); proxy.close(); await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
