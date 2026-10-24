'use strict';
/* load.js — closed-loop load: N virtual clients, each sends a request, waits for the answer, sends the next.
   Spread over worker threads; each client has its own address (X-Forwarded-For, the way Caddy hands it over on the
   real server), so per-network limits see separate phones. Node built-ins only.
   run({ base, clients, seconds, mix, world, workers }) → { byCat: { cat: { n, errors, codes, p50, p95, p99, max } }, rps } */
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const http = require('http');
const fs = require('fs');
const path = require('path');

if (isMainThread) {
  module.exports.run = function run(opts) {
    const workers = Math.max(1, Math.min(opts.workers || 2, opts.clients));
    const per = Array.from({ length: workers }, (_, i) => Math.floor(opts.clients / workers) + (i < opts.clients % workers ? 1 : 0));
    return Promise.all(per.map((n, i) => new Promise((ok, no) => {
      const w = new Worker(__filename, { workerData: Object.assign({}, opts, { clients: n, workerIndex: i }) });
      w.on('message', ok); w.on('error', no);
    }))).then((parts) => {
      const byCat = {};
      let total = 0;
      for (const p of parts) for (const [cat, r] of Object.entries(p)) {
        const b = byCat[cat] || (byCat[cat] = { lat: [], errors: 0, codes: {}, errSamples: [] });
        b.lat.push(...r.lat); b.errors += r.errors; for (const [c, n] of Object.entries(r.codes)) b.codes[c] = (b.codes[c] || 0) + n;
        b.errSamples.push(...r.errSamples.slice(0, 5)); total += r.lat.length;
      }
      const out = {};
      for (const [cat, b] of Object.entries(byCat)) {
        const a = Float64Array.from(b.lat).sort();
        const q = (p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
        out[cat] = { n: a.length, errors: b.errors, codes: b.codes, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +(a.length ? a[a.length - 1] : 0).toFixed(1), errSamples: b.errSamples.slice(0, 5) };
      }
      return { byCat: out, rps: +(total / opts.seconds).toFixed(1) };
    });
  };
  return;
}

/* ---------- inside a worker ---------- */
const o = workerData;
const u = new URL(o.base);
const agent = new http.Agent({ keepAlive: true, maxSockets: o.clients + 4 });
const photo = o.photoFile ? fs.readFileSync(o.photoFile) : null;
const W = o.world;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const stats = {};
const rec = (cat, ms, code, err) => {
  const s = stats[cat] || (stats[cat] = { lat: [], errors: 0, codes: {}, errSamples: [] });
  s.lat.push(ms); s.codes[code] = (s.codes[code] || 0) + 1;
  if (err || code >= 500 || code === 0) { s.errors++; if (s.errSamples.length < 5) s.errSamples.push(String(err || code)); }
};

/** The mix: weights per kind of request. */
function nextRequest(ip) {
  const r = Math.random();
  let acc = 0;
  for (const [w, make] of MIX) { acc += w; if (r < acc) return make(ip); }
  return MIX[0][1](ip);
}
const page = (cat, p) => () => ({ cat, method: 'GET', path: p() });
const H = () => pick(W.hosts);
const meetDay = () => { const m = pick(W.meets); return m; };
const PAGES = [
  [6, page('page /', () => '/')],
  [4, page('page /meets', () => '/meets')],
  [4, page('page /members', () => '/members')],
  [2, page('page /vendors', () => '/vendors')],
  [10, page('page /<host>', () => '/' + H().slug)],
  [10, page('page /<meet-name>', () => '/' + pick(W.meetNames))],
  [10, page('page /<meet-name>/<date>', () => { const m = pick(W.meets.filter((x) => x.nameUrl)); const p = new URL(m.url).pathname; return p; })],
  [10, page('page /@handle', () => '/@' + pick(W.members).handle)],
  [5, page('page /v/<vendor>', () => '/v/' + pick(W.vendorSlugs))],
];
const API = [
  [3, () => ({ cat: 'api /me', method: 'GET', path: '/api/host/me', cookie: H().cookie })],
  [3, () => ({ cat: 'api /kit', method: 'GET', path: '/api/host/kit', cookie: H().cookie })],
  [3, () => ({ cat: 'api /meets', method: 'GET', path: '/api/host/meets', cookie: H().cookie })],
  [3, () => ({ cat: 'api /members', method: 'GET', path: '/api/host/members', cookie: H().cookie })],
  [2, () => ({ cat: 'api /vendors', method: 'GET', path: '/api/host/vendors', cookie: H().cookie })],
  [2, () => ({ cat: 'api /requests', method: 'GET', path: '/api/host/requests', cookie: H().cookie })],
];
let seq = 0;
const WRITES = [
  [1.5, () => ({ cat: 'write vendor-request', method: 'POST', path: '/api/vendor-request', body: { host: H().slug, name: 'Truck ' + (++seq) + '-' + o.workerIndex, contact: '602-555-0100', food: 'Tacos' } })],
  [1.5, () => ({ cat: 'write alert signup', method: 'POST', path: '/api/alerts', body: { host: H().slug, email: `fan${o.workerIndex}-${++seq}-${Date.now()}@example.com` } })],
  [1, () => { const m = pick(W.members); return { cat: 'write photo (member key)', method: 'POST', path: `/api/host/members/${m.id}/photos`, headers: { 'x-member-key': m.key, Origin: 'http://meets.test' }, raw: { type: 'image/jpeg', buf: photo } }; }],
  [0.5, () => { const m = pick(W.members); const h = W.hosts.find((x) => x.id === m.hostId); return { cat: 'write photo (host session)', method: 'POST', path: `/api/host/members/${m.id}/photos`, cookie: h.cookie, headers: { Origin: 'http://meets.test' }, raw: { type: 'image/jpeg', buf: photo } }; }],
  [1, () => { const m = pick(W.meets); const h = W.hosts[m.hostIdx]; return { cat: 'write meet edit', method: 'PUT', path: `/api/host/meets/${m.id}`, cookie: h.cookie, headers: { Origin: 'http://meets.test' },
    body: { day: m.day, start: m.start, end: m.end, place: m.place, address: m.address, title: m.title, notes: 'Edited ' + Date.now(), venueId: m.venueId } }; }],
];
const scale = (list, f) => list.map(([w, m]) => [w * f, m]);
const sets = { pages: PAGES, api: API, writes: WRITES };
const mixW = o.mix || { pages: 0.8, api: 0.15, writes: 0.05 };
const MIX = [];
for (const [k, share] of Object.entries(mixW)) { const list = sets[k]; const tot = list.reduce((s, [w]) => s + w, 0); MIX.push(...scale(list, share / tot)); }
if (o.only) MIX.splice(0, MIX.length, ...MIX.filter(([, m]) => { try { return o.only.some((c) => m().cat.startsWith(c)); } catch (e) { return false; } }));

function send(spec, ip) {
  const data = spec.raw ? spec.raw.buf : spec.body ? Buffer.from(JSON.stringify(spec.body)) : null;
  const headers = Object.assign({ Host: 'meets.test', 'X-Forwarded-For': ip, 'Accept-Encoding': 'gzip, br', 'User-Agent': 'stress' }, spec.headers || {});
  if (spec.cookie) headers.Cookie = spec.cookie;
  if (data) { headers['Content-Type'] = spec.raw ? spec.raw.type : 'application/json'; headers['Content-Length'] = data.length; if (!headers.Origin) headers.Origin = 'http://meets.test'; }
  const t0 = process.hrtime.bigint();
  return new Promise((ok) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: spec.path, method: spec.method, agent, headers, timeout: o.timeoutMs || 30000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => { rec(spec.cat, Number(process.hrtime.bigint() - t0) / 1e6, res.statusCode); ok(); });
      res.on('error', (e) => { rec(spec.cat, Number(process.hrtime.bigint() - t0) / 1e6, 0, e.code); ok(); });
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    r.on('error', (e) => { rec(spec.cat, Number(process.hrtime.bigint() - t0) / 1e6, 0, e.code || e.message); ok(); });
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const until = Date.now() + o.seconds * 1000;
  const clients = Array.from({ length: o.clients }, (_, i) => (async () => {
    const ip = `10.${o.workerIndex + 1}.${Math.floor(i / 250)}.${(i % 250) + 1}`;
    await new Promise((r) => setTimeout(r, Math.random() * 500)); // spread the start
    while (Date.now() < until) {
      await send(nextRequest(ip), ip);
      if (o.thinkMs) await new Promise((r) => setTimeout(r, o.thinkMs * (0.5 + Math.random())));
    }
  })());
  await Promise.all(clients);
  agent.destroy();
  parentPort.postMessage(stats);
})();
