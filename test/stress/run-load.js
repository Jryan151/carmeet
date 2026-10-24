'use strict';
/* Section 1 — load and latency on 2 CPUs.
   node test/stress/run-load.js [--steps 10,50,150,300] [--seconds 45] [--mix pages|api|writes|mixed]
   Seeds a private site, then ramps closed-loop clients. Per step: p50/p95/p99 per kind of request, error rate,
   event loop lag, RSS, open files, CPU. Writes test/stress/out/load-<mix>.json. */
const fs = require('fs');
const path = require('path');
const S = require('./lib/site');
const { seed } = require('./lib/seed');
const L = require('./lib/load');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const STEPS = arg('steps', '10,50,150,300').split(',').map(Number);
const SECONDS = Number(arg('seconds', 45));
const MIXNAME = arg('mix', 'mixed');
const MIXES = { mixed: { pages: 0.8, api: 0.15, writes: 0.05 }, pages: { pages: 1 }, api: { api: 1 }, writes: { writes: 1 } };
const OUT = path.join(__dirname, 'out');

function cpuOf(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { self: (+f[11] + +f[12]) / 100, kids: (+f[13] + +f[14]) / 100 };
  } catch (e) { return { self: 0, kids: 0 }; }
}
const ffmpegs = () => { try { return require('child_process').execSync('pgrep -c ffmpeg || true').toString().trim() | 0; } catch (e) { return 0; } };

async function sampleWhile(ctx, promise) {
  const samples = [];
  let done = false; promise.then(() => { done = true; }, () => { done = true; });
  let c0 = cpuOf(ctx.pid);
  await ctx.probe('/?reset');
  while (!done) {
    await S.sleep(1000);
    try {
      const p = await ctx.probe('/?reset', 3000);
      const c = cpuOf(ctx.pid);
      samples.push(Object.assign(p, { cpu: c.self - c0.self, cpuKids: c.kids - c0.kids, ffmpeg: ffmpegs() }));
      c0 = c;
    } catch (e) { samples.push({ t: Date.now(), probeError: e.message }); }
  }
  return samples;
}
function summarize(samples) {
  const ok = samples.filter((s) => !s.probeError);
  const max = (k) => Math.max(0, ...ok.map((s) => (typeof k === 'function' ? k(s) : s[k])));
  const avg = (k) => ok.reduce((a, s) => a + (typeof k === 'function' ? k(s) : s[k]), 0) / Math.max(1, ok.length);
  return { lagP99Max: +max((s) => s.lag.p99).toFixed(1), lagMax: +max((s) => s.lag.max).toFixed(1), lagMeanAvg: +avg((s) => s.lag.mean).toFixed(1),
    rssMaxMB: Math.round(max('rss') / 1048576), heapMaxMB: Math.round(max('heapUsed') / 1048576), fdsMax: max('fds'), handlesMax: max('handles'),
    eluAvg: +avg('elu').toFixed(2), cpuAvg: +avg('cpu').toFixed(2), cpuKidsAvg: +avg('cpuKids').toFixed(2), ffmpegMax: max('ffmpeg'),
    sqliteBusy: ok.length ? ok[ok.length - 1].sqliteBusy : null, appErrors: ok.length ? ok[ok.length - 1].errors : null, probeMisses: samples.length - ok.length };
}

async function main() {
  const ctx = await S.start({ cpus: '0,1', env: { VIDEO_PRESET: 'medium' } });
  console.log('site on', ctx.base, 'pid', ctx.pid);
  const t0 = Date.now();
  const world = await seed(ctx);
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${world.meets.length} meets, ${world.kit.length} logos, ${world.members.length} members`);
  // One look at every page first (truck lists cached, styles compressed), like a site that's been up a while.
  for (const p of ['/', '/meets', '/members', '/vendors', ...world.hosts.map((h) => '/' + h.slug), ...world.meetNames.map((n) => '/' + n)]) await S.req(ctx, 'GET', p);
  const worldLite = { hosts: world.hosts.map((h) => ({ id: h.id, slug: h.slug, cookie: h.cookie })), meets: world.meets, members: world.members, meetNames: world.meetNames, vendorSlugs: world.vendorSlugs };
  const results = [];
  for (const clients of STEPS) {
    const before = await ctx.probe('/');
    const run = L.run({ base: ctx.base, clients, seconds: SECONDS, world: worldLite, mix: MIXES[MIXNAME], workers: 2, photoFile: path.join(__dirname, '.fixtures', 'photo.jpg') });
    const samples = await sampleWhile(ctx, run);
    const r = await run;
    const sum = summarize(samples);
    const cats = r.byCat;
    const pages = Object.entries(cats).filter(([k]) => k.startsWith('page'));
    const all = Object.values(cats);
    const n = all.reduce((a, c) => a + c.n, 0);
    const err5 = all.reduce((a, c) => a + Object.entries(c.codes).filter(([code]) => +code >= 500 || +code === 0).reduce((x, [, v]) => x + v, 0), 0);
    const pageP95 = Math.max(0, ...pages.map(([, c]) => c.p95));
    const row = { clients, rps: r.rps, requests: n, errors5xxOr0: err5, errorRate: +(err5 / Math.max(1, n) * 100).toFixed(2), worstPageP95: pageP95, sum, cats, sqliteBusyDelta: sum.sqliteBusy - before.sqliteBusy };
    results.push(row);
    console.log(`\n== ${clients} clients: ${r.rps} req/s, errors ${row.errorRate}%, worst page p95 ${pageP95} ms, lag p99 max ${sum.lagP99Max} ms, RSS ${sum.rssMaxMB} MB, fds ${sum.fdsMax}, CPU ${sum.cpuAvg} + ffmpeg ${sum.cpuKidsAvg}`);
    for (const [k, c] of Object.entries(cats).sort()) console.log(`  ${k.padEnd(30)} n=${String(c.n).padStart(6)} p50=${String(c.p50).padStart(7)} p95=${String(c.p95).padStart(7)} p99=${String(c.p99).padStart(7)} max=${String(c.max).padStart(7)} codes=${JSON.stringify(c.codes)}${c.errSamples.length ? ' err=' + c.errSamples.join(',') : ''}`);
    await S.sleep(4000); // let queued picture work settle between steps
  }
  const lines = await ctx.probe('/lines').catch(() => []);
  S.writeJson(path.join(OUT, `load-${MIXNAME}.json`), { at: new Date().toISOString(), seconds: SECONDS, steps: results, appLog: lines.slice(-60) });
  await ctx.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
