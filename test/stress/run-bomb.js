'use strict';
/* A "JPEG bomb" through a member's link: a 1.4 MB file that decodes to 16000×16000 (768 MB of pixels).
   node test/stress/run-bomb.js [count]
   Uploads `count` at once with one member key and samples every ffmpeg's memory (RSS) and how long it runs. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const S = require('./lib/site');
const { seed } = require('./lib/seed');

(async () => {
  const N = Number(process.argv[2] || 4);
  const ctx = await S.start({ cpus: '0,1' });
  const w = await seed(ctx, { members: 10, photosEach: 1, withoutCopies: 0, kit: 10, meets: 4 });
  const m = w.members[0];
  const bomb = fs.readFileSync(path.join(__dirname, '.fixtures', 'bomb.jpg'));
  const samples = [];
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const out = execSync("ps -eo pid,rss,etimes,args | grep '[f]fmpeg' || true").toString().split('\n').filter(Boolean);
      samples.push({ t: Date.now(), procs: out.map((l) => { const [pid, rss, et] = l.trim().split(/\s+/); return { pid: +pid, rssMB: Math.round(+rss / 1024), secs: +et }; }),
        freeMB: Math.round(require('os').freemem() / 1048576) });
      await S.sleep(200);
    }
  })();
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, () => S.req(ctx, 'POST', `/api/host/members/${m.id}/photos`, { headers: { 'x-member-key': m.key, Origin: 'http://meets.test' }, raw: { type: 'image/jpeg', buf: bomb } })));
  console.log('answers:', rs.map((r) => r.status), 'in', Date.now() - t0, 'ms');
  // A page during it.
  const p = await S.req(ctx, 'GET', '/@' + m.handle);
  console.log('member page during:', p.status, Math.round(p.ms), 'ms');
  for (let i = 0; i < 600 && (samples.length < 5 || samples[samples.length - 1].procs.length); i++) await S.sleep(200);
  stop = true; await sampler;
  const peakSum = Math.max(...samples.map((s) => s.procs.reduce((a, p2) => a + p2.rssMB, 0)));
  const peakOne = Math.max(0, ...samples.flatMap((s) => s.procs.map((p2) => p2.rssMB)));
  const most = Math.max(...samples.map((s) => s.procs.length));
  const minFree = Math.min(...samples.map((s) => s.freeMB));
  console.log(`ffmpeg at once: ${most}; peak RSS one: ${peakOne} MB; all together: ${peakSum} MB; lowest free memory: ${minFree} MB; done after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  S.writeJson(path.join(__dirname, 'out', 'bomb.json'), { N, answers: rs.map((r) => r.status), most, peakOne, peakSum, minFree, pageMs: p.ms });
  await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
