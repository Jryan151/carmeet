'use strict';
/* Where a page's time goes: seeds a site, puts it under steady page load, and takes a CPU profile from inside it.
   node test/stress/run-profile.js [--only "page /meets,page /@handle"] [--clients 10] */
const path = require('path');
const S = require('./lib/site');
const { seed } = require('./lib/seed');
const L = require('./lib/load');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

(async () => {
  const ctx = await S.start({ cpus: '0,1' });
  const world = await seed(ctx);
  const worldLite = { hosts: world.hosts.map((h) => ({ id: h.id, slug: h.slug, cookie: h.cookie })), meets: world.meets, members: world.members, meetNames: world.meetNames, vendorSlugs: world.vendorSlugs };
  for (const p of ['/', '/meets', '/members']) await S.req(ctx, 'GET', p);
  const only = arg('only', '') ? arg('only').split(',') : null;
  const run = L.run({ base: ctx.base, clients: Number(arg('clients', 10)), seconds: 14, world: worldLite, mix: { pages: 1 }, only, workers: 1 });
  await S.sleep(3000);
  const prof = await ctx.probe('/profile?ms=8000', 20000);
  const r = await run;
  console.log('rps', r.rps);
  for (const [k, c] of Object.entries(r.byCat)) console.log(' ', k.padEnd(28), 'p50', c.p50, 'p95', c.p95);
  console.log('\nby file (self %):'); for (const [k, v] of prof.files.slice(0, 15)) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log('\nself time (top):'); for (const [k, v] of prof.selfTop.slice(0, 25)) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log('\napp functions, inclusive:'); for (const [k, v] of prof.appInclusive.slice(0, 30)) console.log(`  ${String(v).padStart(5)}  ${k}`);
  S.writeJson(path.join(__dirname, 'out', `profile${only ? '-' + only.join('+').replace(/[^a-z@]+/gi, '_') : ''}.json`), { rps: r.rps, byCat: r.byCat, prof });
  await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
