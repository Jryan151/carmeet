'use strict';
/* Section 2 — heavy work next to page traffic.
   node test/stress/run-heavy.js [--clients 50] [--seconds 120]
   1. Baseline: pages only, N clients, for --base seconds.
   2. Same page load, plus 5 video uploads at once (host background 4K 60 fps, a meet background ~400 MB, two member
      feed clips, a vendor clip) and 200 pictures without WebP copies being asked for.
      Samples every 500 ms: the ffmpeg processes running (H.264 / HEVC / picture), and each video's status.
   3. Restart mid-encode: uploads again, SIGTERM while encoding, start again; what each status says, what keeps
      running, what's left on disk. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');
const S = require('./lib/site');
const { seed } = require('./lib/seed');
const L = require('./lib/load');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const CLIENTS = Number(arg('clients', 50));
const SECONDS = Number(arg('seconds', 150));
const BASE_S = Number(arg('base', 40));
const FIX = path.join(__dirname, '.fixtures');
const OUT = path.join(__dirname, 'out');

/** Streams a file as the request body (like a phone upload), resolving when the answer comes back. */
function upload(ctx, urlPath, file, type, { cookie, key } = {}) {
  const u = new URL(ctx.base + urlPath);
  const size = fs.statSync(file).size;
  const t0 = Date.now();
  return new Promise((ok) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', agent: false,
      headers: Object.assign({ Host: 'meets.test', 'Content-Type': type, 'Content-Length': size, Origin: 'http://meets.test' }, cookie ? { Cookie: cookie } : {}, key ? { 'x-member-key': key } : {}) }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode, body: b.slice(0, 300), ms: Date.now() - t0 }));
    });
    r.on('error', (e) => ok({ status: 0, body: e.message, ms: Date.now() - t0 }));
    fs.createReadStream(file).pipe(r);
  });
}
function ffmpegs() {
  let out = '';
  try { out = execSync("ps -eo pid,ni,etimes,args | grep '[f]fmpeg' || true").toString(); } catch (e) { return []; }
  return out.split('\n').filter(Boolean).map((l) => {
    const [pid, ni, et] = l.trim().split(/\s+/);
    return { pid: +pid, nice: +ni, secs: +et, kind: /libx265/.test(l) ? 'hevc' : /libx264/.test(l) ? 'h264' : /libwebp/.test(l) ? 'webp' : /rawvideo|colorkey|scale='min\(900/.test(l) ? 'logo' : /-frames:v 1/.test(l) ? 'still' : 'other' };
  });
}
const sleep = S.sleep;

async function statusOf(ctx, w, v) {
  const h = w.hosts[0];
  if (v.kind === 'host') { const r = await S.req(ctx, 'GET', '/api/host/me', { cookie: h.cookie }); return r.json && r.json.host.video.status; }
  if (v.kind === 'meet') { const r = await S.req(ctx, 'GET', '/api/host/meets', { cookie: h.cookie }); const m = r.json && r.json.meets.find((x) => x.id === v.id); return m && m.video.status; }
  if (v.kind === 'clip') { const r = await S.req(ctx, 'GET', `/api/host/members/${v.id}`, { headers: { 'x-member-key': v.key } }); const p = r.json && r.json.member.photos.find((x) => x.kind === 'video' && x.id === v.pid) || (r.json && r.json.member.photos.filter((x) => x.kind === 'video').slice(-1)[0]); if (p && !v.pid) v.pid = p.id; return p && p.status; }
  if (v.kind === 'kit') { const r = await S.req(ctx, 'GET', `/api/host/kit/${v.id}/profile`, { cookie: v.cookie }); return r.json && r.json.profile.video.status; }
  return null;
}
async function startUploads(ctx, w) {
  const h = w.hosts[0];
  const meet = w.meets.find((m) => m.hostIdx === 0);
  const memberA = w.members.find((m) => m.hostId === h.id && !w.members.slice(0, 0).includes(m));
  const memberB = w.members.filter((m) => m.hostId === h.id)[5];
  const kit = w.kit.find((k) => k.hostId === h.id && k.kind === 'vendor');
  const vids = [
    { name: 'host background (4K 60 fps, 96 MB)', kind: 'host', path: '/api/host/video', file: '4k60.mp4', type: 'video/mp4', cookie: h.cookie },
    { name: 'meet background (395 MB)', kind: 'meet', id: meet.id, path: `/api/host/meets/${meet.id}/video`, file: 'big-395mb.mp4', type: 'video/mp4', cookie: h.cookie },
    { name: 'member feed clip (1080p 30 s)', kind: 'clip', id: memberA.id, key: memberA.key, path: `/api/host/members/${memberA.id}/clips`, file: 'phone-1080p.mp4', type: 'video/mp4' },
    { name: 'member feed clip (upright .mov)', kind: 'clip', id: memberB.id, key: memberB.key, path: `/api/host/members/${memberB.id}/clips`, file: 'phone-upright.mov', type: 'video/quicktime' },
    { name: 'vendor clip (1080p 30 s)', kind: 'kit', id: kit.id, cookie: h.cookie, path: `/api/host/kit/${kit.id}/video`, file: 'phone-1080p.mp4', type: 'video/mp4' },
  ];
  const t0 = Date.now();
  await Promise.all(vids.map(async (v) => { v.res = await upload(ctx, v.path, path.join(FIX, v.file), v.type, { cookie: v.cookie, key: v.key }); v.acceptedAt = Date.now() - t0; }));
  return { vids, t0 };
}

(async () => {
  const ctx = await S.start({ cpus: '0,1', env: { VIDEO_PRESET: process.env.VIDEO_PRESET || 'medium' } });
  const w = await seed(ctx);
  const worldLite = { hosts: w.hosts.map((h) => ({ id: h.id, slug: h.slug, cookie: h.cookie })), meets: w.meets, members: w.members, meetNames: w.meetNames, vendorSlugs: w.vendorSlugs };
  for (const p of ['/', '/meets', '/members', ...w.meetNames.map((n) => '/' + n)]) await S.req(ctx, 'GET', p);
  const report = { clients: CLIENTS };

  // 1. Baseline.
  console.log(`baseline: ${CLIENTS} clients, pages only, ${BASE_S} s`);
  report.baseline = await L.run({ base: ctx.base, clients: CLIENTS, seconds: BASE_S, world: worldLite, mix: { pages: 1 }, workers: 2 });
  const worst = (r) => Math.max(...Object.entries(r.byCat).filter(([k]) => k.startsWith('page')).map(([, c]) => c.p95));
  console.log('  rps', report.baseline.rps, 'worst page p95', worst(report.baseline));

  // 2. Same load + 5 uploads + 200 pictures without copies.
  console.log(`with heavy work: ${SECONDS} s`);
  const load = L.run({ base: ctx.base, clients: CLIENTS, seconds: SECONDS, world: worldLite, mix: { pages: 1 }, workers: 2 });
  const timeline = [];
  let stop = false;
  const sampler = (async () => { const t0 = Date.now(); while (!stop) { timeline.push({ t: Date.now() - t0, ff: ffmpegs() }); await sleep(500); } })();
  // The pictures: the member pages that show them (each page asks for its feed copies), all at once.
  const handles = [...new Set(w.noCopy.map((x) => x.handle))];
  const picStart = Date.now();
  const picPages = Promise.all(handles.map((hd) => S.req(ctx, 'GET', '/@' + hd)));
  const ups = await startUploads(ctx, w);
  console.log('  uploads answered:', ups.vids.map((v) => `${v.name}: ${v.res.status} in ${v.res.ms} ms`).join('; '));
  const pp = await picPages;
  console.log('  member pages with missing copies:', pp.map((r) => Math.round(r.ms)).sort((a, b) => b - a).slice(0, 3), 'ms (slowest 3)');
  // Watch statuses until all ready/failed (or the load ends and 10 more minutes pass).
  const statusLog = [];
  const until = Date.now() + (SECONDS + 900) * 1000;
  let picsDoneAt = null;
  for (;;) {
    const st = await Promise.all(ups.vids.map((v) => statusOf(ctx, w, v).catch(() => 'err')));
    const t = Date.now() - ups.t0;
    statusLog.push({ t, st });
    ups.vids.forEach((v, i) => { if (!v.doneAt && ['ready', 'failed'].includes(st[i])) { v.doneAt = t; v.final = st[i]; } });
    const made = w.noCopy.filter((x) => fs.existsSync(path.join(w.uploads, x.file.replace('.jpg', '.s1080.webp')))).length;
    if (made === w.noCopy.length && !picsDoneAt) picsDoneAt = Date.now() - picStart;
    if ((ups.vids.every((v) => v.doneAt) && picsDoneAt) || Date.now() > until) break;
    await sleep(2000);
  }
  report.heavy = await load;
  stop = true; await sampler;
  // Concurrency of encodes: the most H.264/HEVC at once, and the share of samples with an encode next to another.
  const enc = timeline.map((s) => s.ff.filter((p) => p.kind === 'h264' || p.kind === 'hevc'));
  report.queue = { maxEncodesAtOnce: Math.max(0, ...enc.map((e) => e.length)), samplesWith2PlusEncodes: enc.filter((e) => e.length >= 2).length, samples: enc.length,
    maxFfmpegAtOnce: Math.max(0, ...timeline.map((s) => s.ff.length)), niceSeen: [...new Set(timeline.flatMap((s) => s.ff.map((p) => p.nice)))],
    overlapExamples: timeline.filter((s) => s.ff.filter((p) => p.kind === 'h264' || p.kind === 'hevc').length >= 2).slice(0, 3).map((s) => ({ t: s.t, ff: s.ff })) };
  report.uploads = ups.vids.map((v) => ({ name: v.name, status: v.res.status, answeredMs: v.res.ms, body: v.res.body.slice(0, 120), final: v.final || 'not done', doneAtS: v.doneAt ? +(v.doneAt / 1000).toFixed(1) : null }));
  report.pictures = { count: w.noCopy.length, allCopiesMadeS: picsDoneAt ? +(picsDoneAt / 1000).toFixed(1) : null };
  console.log('  heavy rps', report.heavy.rps, 'worst page p95', worst(report.heavy));
  for (const [k, c] of Object.entries(report.heavy.byCat)) console.log('   ', k.padEnd(28), 'p50', c.p50, 'p95', c.p95, 'p99', c.p99, 'max', c.max, JSON.stringify(c.codes));
  console.log('  queue', JSON.stringify(report.queue).slice(0, 600));
  console.log('  uploads', JSON.stringify(report.uploads, null, 1));
  console.log('  pictures', report.pictures);

  // 3. Restart mid-encode.
  console.log('restart mid-encode');
  const ups2 = await startUploads(ctx, w);
  await sleep(8000);
  const before = { st: await Promise.all(ups2.vids.map((v) => statusOf(ctx, w, v))), ff: ffmpegs(), tmp: fs.readdirSync(path.join(w.uploads, 'tmp')) };
  const oldPid = ctx.pid;
  await ctx.restart('SIGTERM');
  await sleep(3000);
  const after = { st: await Promise.all(ups2.vids.map((v) => statusOf(ctx, w, v))), ff: ffmpegs(), tmp: fs.readdirSync(path.join(w.uploads, 'tmp')) };
  const err = await S.req(ctx, 'GET', '/api/host/me', { cookie: w.hosts[0].cookie });
  await sleep(60000);
  const later = { ff: ffmpegs(), tmp: fs.readdirSync(path.join(w.uploads, 'tmp')).map((f) => ({ f, mb: +(fs.statSync(path.join(w.uploads, 'tmp', f)).size / 1048576).toFixed(1) })),
    orphanLoops: fs.readdirSync(w.uploads).filter((f) => /^bg-.*\.mp4$/.test(f)).length };
  report.restart = { oldPid, before, after, hostVideoError: err.json && err.json.host.video.error, later };
  console.log('  statuses before', before.st, 'after', after.st);
  console.log('  ffmpeg before', before.ff.map((p) => p.kind + ':' + p.pid), 'after restart', after.ff.map((p) => p.kind + ':' + p.pid), 'a minute later', later.ff.map((p) => p.kind + ':' + p.pid + ':' + p.secs + 's'));
  console.log('  tmp before', before.tmp.length, 'after', after.tmp.length, 'a minute later', later.tmp);
  console.log('  host video error shown:', report.restart.hostVideoError);
  S.writeJson(path.join(OUT, `heavy${process.env.OUT_SUFFIX || ''}.json`), report);
  await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
