'use strict';
/* Section 7 — soak: a steady 20 requests a second of mixed traffic for --minutes (default 125).
   node test/stress/run-soak.js [--minutes 125] [--rps 20]
   Traffic: pages, the portal's lists, and writes that churn files the way a season of meets does (member photos
   added and removed, flyers replaced, vendor photos, a feed clip every 15 minutes, vendor requests and alert
   sign-ups from many phones). Every 10 s: RSS, heap, open files, event loop lag. Every 10 min: the largest Maps and
   Sets alive in the server, leftovers in uploads/tmp, picture copies whose original is gone, files nothing uses.
   Writes test/stress/out/soak.json and soak.svg (RSS and heap over time). */
const fs = require('fs');
const path = require('path');
const http = require('http');
const S = require('./lib/site');
const { seed, db } = require('./lib/seed');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg('minutes', 125));
const RPS = Number(arg('rps', 20));
const OUT = path.join(__dirname, 'out');
const FIX = path.join(__dirname, '.fixtures');
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** RSS, heap and external memory over time, as an SVG (written at every checkpoint, so a run cut short keeps it). */
function plot(series, MINUTES, RPS) {
  const ok = series.filter((s) => !s.probeError);
  const W = 900, H = 360, L = 60, B = 40;
  const maxY = Math.max(...ok.map((s) => s.rssMB)) * 1.1;
  const x = (m) => L + (m / MINUTES) * (W - L - 20);
  const y = (v) => H - B - (v / maxY) * (H - B - 20);
  const line = (k, color) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${ok.map((s) => `${x(s.min).toFixed(1)},${y(s[k]).toFixed(1)}`).join(' ')}"/>`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="${L - 8}" y="${y(maxY * f) + 4}" text-anchor="end" font-size="11">${Math.round(maxY * f)}</text><line x1="${L}" x2="${W - 20}" y1="${y(maxY * f)}" y2="${y(maxY * f)}" stroke="#ddd"/>`).join('');
  const xt = [0, 30, 60, 90, 120].filter((m) => m <= MINUTES).map((m) => `<text x="${x(m)}" y="${H - B + 16}" text-anchor="middle" font-size="11">${m} min</text>`).join('');
  fs.writeFileSync(path.join(OUT, 'soak.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif"><rect width="100%" height="100%" fill="#fff"/>${ticks}${xt}${line('rssMB', '#c0392b')}${line('heapMB', '#2c7fb8')}${line('extMB', '#7f8c8d')}<text x="${L}" y="14" font-size="13">Server memory (MB) over ${MINUTES} minutes of soak at ${RPS} req/s: RSS (red), JS heap (blue), external (grey)</text></svg>`);
}

(async () => {
  const ctx = await S.start({ cpus: '0,1' });
  const w = await seed(ctx);
  const D = db(ctx.dbFile);
  const u = new URL(ctx.base);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const photo = fs.readFileSync(path.join(FIX, 'photo.jpg'));
  const flyer = photo;
  const counts = { sent: 0, done: 0, codes: {}, slow: 0, errors: 0, byKind: {} };
  let outstanding = 0;
  function send(kind, method, p, { body, raw, cookie, headers, ip } = {}) {
    const data = raw ? raw.buf : body ? Buffer.from(JSON.stringify(body)) : null;
    const h = Object.assign({ Host: 'meets.test', 'Accept-Encoding': 'gzip, br', 'X-Forwarded-For': ip || `100.64.${Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 250) + 1}` }, headers || {});
    if (cookie) h.Cookie = cookie;
    if (data) { h['Content-Type'] = raw ? raw.type : 'application/json'; h['Content-Length'] = data.length; h.Origin = 'http://meets.test'; }
    counts.sent++; outstanding++;
    const t0 = Date.now();
    return new Promise((ok) => {
      const r = http.request({ hostname: u.hostname, port: u.port, path: p, method, agent, headers: h, timeout: 60000 }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c));
        res.on('end', () => { outstanding--; counts.done++; counts.codes[res.statusCode] = (counts.codes[res.statusCode] || 0) + 1; const k = counts.byKind[kind] || (counts.byKind[kind] = { n: 0, ms: 0, max: 0, codes: {} }); const ms = Date.now() - t0; k.n++; k.ms += ms; k.max = Math.max(k.max, ms); k.codes[res.statusCode] = (k.codes[res.statusCode] || 0) + 1; if (ms > 1000) counts.slow++;
          let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { /* page */ } ok({ status: res.statusCode, json }); });
      });
      r.on('timeout', () => r.destroy(new Error('timeout')));
      r.on('error', () => { outstanding--; counts.errors++; ok({ status: 0 }); });
      if (data) r.write(data);
      r.end();
    });
  }
  // The churn state.
  const myPhotos = []; // { member, id }
  const myMedia = []; // { kit, id, cookie }
  const vendorPages = w.kit.filter((k) => k.pageSlug);
  const clipState = { last: null };
  const host = (id) => w.hosts.find((h) => h.id === id);
  async function write() {
    const r = Math.random();
    if (r < 0.30) { // a member adds a photo
      const m = pick(w.members);
      const res = await send('photo add', 'POST', `/api/host/members/${m.id}/photos`, { raw: { type: 'image/jpeg', buf: photo }, headers: { 'x-member-key': m.key } });
      if (res.json && res.json.member) { const ph = res.json.member.photos.filter((x) => x.kind === 'photo'); myPhotos.push({ m, id: ph[ph.length - 1].id }); }
      return;
    }
    if (r < 0.55) { // and takes one down
      const x = myPhotos.shift(); if (!x) return;
      await send('photo delete', 'DELETE', `/api/host/members/${x.m.id}/photos/${x.id}`, { headers: { 'x-member-key': x.m.key, Origin: 'http://meets.test' } });
      return;
    }
    if (r < 0.62) { // a flyer replaced
      const m = pick(w.meets);
      await send('flyer replace', 'POST', `/api/host/meets/${m.id}/flyer`, { raw: { type: 'image/jpeg', buf: flyer }, cookie: w.hosts[m.hostIdx].cookie });
      return;
    }
    if (r < 0.72) { // a vendor's food photo, added then removed
      if (myMedia.length > 20 || (myMedia.length && Math.random() < 0.5)) { const x = myMedia.shift(); await send('media delete', 'DELETE', `/api/host/kit/${x.kit.id}/media/${x.id}`, { cookie: x.cookie, headers: { Origin: 'http://meets.test' } }); return; }
      const k = pick(vendorPages); const h = host(k.hostId);
      const res = await send('media add', 'POST', `/api/host/kit/${k.id}/media?kind=photo`, { raw: { type: 'image/jpeg', buf: photo }, cookie: h.cookie });
      if (res.json && res.json.profile) { const ph = res.json.profile.photos; if (ph.length) myMedia.push({ kit: k, id: ph[ph.length - 1].id, cookie: h.cookie }); }
      return;
    }
    if (r < 0.86) { await send('vendor request', 'POST', '/api/vendor-request', { body: { host: pick(w.hosts).slug, name: 'Soak ' + counts.sent, contact: '602' } }); return; }
    await send('alert signup', 'POST', '/api/alerts', { body: { host: pick(w.hosts).slug, email: `soak${counts.sent}@example.com` } });
  }
  function tick() {
    if (outstanding > 200) return; // the site is behind: don't pile on
    const r = Math.random();
    if (r < 0.75) {
      const pages = ['/', '/meets', '/members', '/vendors', '/' + pick(w.hosts).slug, '/' + pick(w.meetNames), new URL(pick(w.meets.filter((m) => m.nameUrl)).url).pathname, '/@' + pick(w.members).handle, '/v/' + pick(vendorPages).pageSlug];
      send('page', 'GET', pick(pages));
    } else if (r < 0.85) {
      const h = pick(w.hosts);
      send('portal', 'GET', pick(['/api/host/me', '/api/host/kit', '/api/host/meets', '/api/host/members', '/api/host/vendors', '/api/host/requests', '/api/host/dashboard']), { cookie: h.cookie });
    } else write();
  }
  async function clip() {
    const m = w.members[7];
    if (clipState.last) await send('clip delete', 'DELETE', `/api/host/members/${m.id}/photos/${clipState.last}`, { headers: { 'x-member-key': m.key, Origin: 'http://meets.test' } });
    const size = fs.statSync(path.join(FIX, 'phone-upright.mov')).size;
    const res = await new Promise((ok) => {
      const r = http.request({ hostname: u.hostname, port: u.port, path: `/api/host/members/${m.id}/clips`, method: 'POST', agent: false, headers: { Host: 'meets.test', 'Content-Type': 'video/quicktime', 'Content-Length': size, 'x-member-key': m.key, Origin: 'http://meets.test' } }, (res2) => { let b = ''; res2.on('data', (c) => { b += c; }); res2.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { ok(null); } }); });
      r.on('error', () => ok(null));
      fs.createReadStream(path.join(FIX, 'phone-upright.mov')).pipe(r);
    });
    const v = res && res.member && res.member.photos.filter((x) => x.kind === 'video').slice(-1)[0];
    clipState.last = v ? v.id : null;
  }
  async function files() {
    const up = w.uploads;
    const all = fs.readdirSync(up).filter((f) => f !== 'tmp');
    const set = new Set(all);
    const copies = all.filter((f) => /\.s\d+\.webp$/.test(f));
    const orphanCopies = copies.filter((f) => { const base = f.replace(/\.s\d+\.webp$/, ''); return ![...['.jpg', '.png', '.jpeg', '.webp', '.gif']].some((e) => set.has(base + e)); });
    const cols = [['hosts', ['logo', 'video', 'video_poster', 'video_hevc']], ['meets', ['flyer', 'logo', 'video', 'video_poster', 'video_hevc']], ['kit_logos', ['file', 'video', 'video_poster', 'video_hevc']], ['kit_media', ['file']],
      ['member_photos', ['file', 'poster', 'hevc']], ['members', ['header_file', 'video', 'video_poster', 'video_hevc']], ['recap_photos', ['file']], ['site', ['logo', 'video', 'video_poster', 'video_hevc']], ['host_portal', ['video', 'video_poster', 'video_hevc']]];
    const used = new Set();
    for (const [t, cs] of cols) for (const r of await D.all(`SELECT ${cs.join(', ')} FROM ${t}`)) for (const c of cs) if (r[c]) used.add(path.basename(String(r[c])));
    const originals = all.filter((f) => !/\.s\d+\.webp$/.test(f) && !f.startsWith('.'));
    const unused = originals.filter((f) => !used.has(f));
    const tmp = fs.readdirSync(path.join(up, 'tmp'));
    const bytes = (list) => list.reduce((a, f) => { try { return a + fs.statSync(path.join(up, f)).size; } catch (e) { return a; } }, 0);
    return { files: all.length, copies: copies.length, orphanCopies: orphanCopies.length, orphanCopyMB: +(bytes(orphanCopies) / 1048576).toFixed(1), unusedOriginals: unused.length, unusedMB: +(bytes(unused) / 1048576).toFixed(1), tmp: tmp.length, dotTmp: all.filter((f) => f.startsWith('.')).length };
  }

  const t0 = Date.now();
  const end = t0 + MINUTES * 60000;
  const series = [];
  const deep = [];
  const interval = setInterval(tick, 1000 / RPS);
  const clipTimer = setInterval(() => { clip().catch(() => {}); }, 15 * 60000);
  clip().catch(() => {});
  console.log(`soak: ${RPS} req/s for ${MINUTES} min, pid ${ctx.pid}`);
  let nextDeep = 0;
  while (Date.now() < end) {
    await S.sleep(10000);
    try {
      const p = await ctx.probe('/?reset', 8000);
      series.push({ min: +((Date.now() - t0) / 60000).toFixed(2), rssMB: +(p.rss / 1048576).toFixed(1), heapMB: +(p.heapUsed / 1048576).toFixed(1), extMB: +(p.external / 1048576).toFixed(1), fds: p.fds, lagP99: +p.lag.p99.toFixed(1), lagMax: +p.lag.max.toFixed(1), elu: +p.elu.toFixed(2), done: counts.done, outstanding, errs: p.errors, busy: p.sqliteBusy });
    } catch (e) { series.push({ min: +((Date.now() - t0) / 60000).toFixed(2), probeError: e.message }); }
    if (Date.now() >= nextDeep) {
      nextDeep = Date.now() + 10 * 60000;
      await ctx.probe('/gc').catch(() => {});
      const maps = await ctx.probe('/maps', 60000).catch((e) => ({ error: e.message }));
      const f = await files().catch((e) => ({ error: e.message }));
      deep.push({ min: +((Date.now() - t0) / 60000).toFixed(1), maps, files: f });
      const last = series[series.length - 1] || {};
      console.log(`${deep[deep.length - 1].min} min: rss ${last.rssMB} MB heap ${last.heapMB} MB fds ${last.fds} done ${counts.done} slow ${counts.slow} errors ${counts.errors} · files ${JSON.stringify(f)} · biggest Maps ${JSON.stringify((maps.Map || []).slice(0, 6))} Sets ${JSON.stringify((maps.Set || []).slice(0, 4))}`);
      S.writeJson(path.join(OUT, 'soak.json'), { rps: RPS, minutes: MINUTES, counts, series, deep });
      plot(series, MINUTES, RPS);
    }
  }
  clearInterval(interval); clearInterval(clipTimer);
  await S.sleep(5000);
  const lines = await ctx.probe('/lines').catch(() => []);
  S.writeJson(path.join(OUT, 'soak.json'), { rps: RPS, minutes: MINUTES, counts, series, deep, appLog: lines.slice(-40) });
  plot(series, MINUTES, RPS);
  console.log('done', counts);
  await D.close();
  await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
