'use strict';
/* The meet at 7 PM: --phones (default 300) phones open the same meet page within --window seconds (default 10), each
   then loads what the page loads (scripts, fonts, the flyer and logo copies, the background's still) and one in ten
   opens a truck's menu. Open loop: phones arrive on schedule whether or not the site keeps up.
   node test/stress/run-7pm.js [--phones 300] [--window 10]
   Reports time to the page (p50/p95/p99/max), failures, and how long the last phone waited. */
const path = require('path');
const http = require('http');
const S = require('./lib/site');
const { seed } = require('./lib/seed');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PHONES = Number(arg('phones', 300));
const WINDOW = Number(arg('window', 10));

(async () => {
  const ctx = await S.start({ cpus: '0,1' });
  const w = await seed(ctx);
  const meet = w.meets.find((m) => m.hostIdx === 0 && m.flyer);
  const pagePath = new URL(meet.url).pathname;
  const u = new URL(ctx.base);
  // What the page loads, from one look at it.
  const first = await S.req(ctx, 'GET', pagePath);
  const assets = [...new Set([...first.text.matchAll(/(?:src|href|data-still|data-poster)="(\/(?:static|uploads)\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&')))].filter((a) => !/\.mp4$/.test(a));
  await S.sleep(2000);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
  const get = (p, ip) => new Promise((ok) => {
    const t0 = Date.now();
    const r = http.request({ hostname: u.hostname, port: u.port, path: p, agent, headers: { Host: 'meets.test', 'Accept-Encoding': 'gzip, br', 'X-Forwarded-For': ip }, timeout: 60000 }, (res) => { res.on('data', () => {}); res.on('end', () => ok({ ms: Date.now() - t0, status: res.statusCode })); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', () => ok({ ms: Date.now() - t0, status: 0 })); r.end();
  });
  const pages = []; const files = []; const menus = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: PHONES }, async (_, i) => {
    await S.sleep((i / PHONES) * WINDOW * 1000);
    const ip = `172.58.${Math.floor(i / 200)}.${(i % 200) + 1}`;
    pages.push(await get(pagePath, ip));
    const fs2 = await Promise.all(assets.map((a) => get(a, ip))); files.push(...fs2);
    if (i % 10 === 0) menus.push(await get(`/api/meets/${meet.id}/food/birria-bros`, ip));
  }));
  const total = Date.now() - t0;
  const q = (arr, p) => { const a = arr.map((x) => x.ms).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; };
  const fail = (arr) => arr.filter((x) => x.status !== 200).length;
  const out = { phones: PHONES, windowS: WINDOW, assetsPerPhone: assets.length,
    page: { p50: q(pages, 0.5), p95: q(pages, 0.95), p99: q(pages, 0.99), max: q(pages, 1), failed: fail(pages) },
    files: { p50: q(files, 0.5), p95: q(files, 0.95), max: q(files, 1), failed: fail(files) },
    menu: { p50: q(menus, 0.5), p95: q(menus, 0.95), failed: fail(menus) }, allDoneS: +(total / 1000).toFixed(1) };
  console.log(JSON.stringify(out));
  S.writeJson(path.join(__dirname, 'out', `7pm-${PHONES}${process.env.OUT_SUFFIX || ''}.json`), out);
  await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
