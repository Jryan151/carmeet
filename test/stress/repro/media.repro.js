'use strict';
/* Sections 2 and 7 — pictures, clips and the files they leave. Each test states what should hold.
   node --test test/stress/repro/media.repro.js   (needs ffmpeg) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const S = require('../lib/site');

const FIX = path.join(__dirname, '..', '.fixtures');
let ctx, cookie, up;
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const until = async (fn, ms = 120000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await S.sleep(500); } };
const upload = (p, file, type, headers = {}) => new Promise((ok) => {
  const http = require('node:http'); const u = new URL(ctx.base + p); const size = fs.statSync(file).size;
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false, headers: Object.assign({ Host: 'meets.test', 'Content-Type': type, 'Content-Length': size, Origin: 'http://meets.test', Cookie: cookie }, headers) }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() })); });
  fs.createReadStream(file).pipe(r);
});

test.before(async () => {
  ctx = await S.start({ env: { VIDEO_PRESET: 'veryfast' } });
  cookie = await S.signIn(ctx, { email: 'm@m.test', name: 'Media Host', slug: 'media-host' });
  up = path.join(path.dirname(ctx.dbFile), 'uploads');
});
test.after(() => ctx && ctx.stop());

test('deleting a member photo also deletes its picture copies (FINDING if this fails)', async () => {
  const mem = (await S.req(ctx, 'POST', '/api/host/members', { cookie, body: { name: 'Pat', car: 'Supra' }, headers: { Origin: 'http://meets.test' } })).json.member;
  const r = await S.req(ctx, 'POST', `/api/host/members/${mem.id}/photos`, { cookie, raw: { type: 'image/jpeg', buf: fs.readFileSync(path.join(FIX, 'photo.jpg')) }, headers: { Origin: 'http://meets.test' } });
  const ph = r.json.member.photos[0];
  const base = path.basename(ph.url).replace(/\.s\d+\.webp$/, '').replace(/\.jpg$/, '');
  await S.req(ctx, 'GET', '/@' + mem.handle); // the page asks for its copies
  await until(() => fs.readdirSync(up).filter((f) => f.startsWith(base + '.s')).length >= 2, 30000);
  const before = fs.readdirSync(up).filter((f) => f.startsWith(base));
  await S.req(ctx, 'DELETE', `/api/host/members/${mem.id}/photos/${ph.id}`, { cookie, headers: { Origin: 'http://meets.test' } });
  await S.sleep(500);
  const left = fs.readdirSync(up).filter((f) => f.startsWith(base));
  assert.deepEqual(left, [], `before: ${before.join(', ')} · left after delete: ${left.join(', ')}`);
});

test('a flyer replaced: the old one’s copies go too, and the page stops using its blur (FINDING if this fails)', async () => {
  const m = (await S.req(ctx, 'POST', '/api/host/meets', { cookie, body: { day: ymd(3), start: '19:00', end: '22:00', place: 'Lot' }, headers: { Origin: 'http://meets.test' } })).json.meet;
  const f1 = (await S.req(ctx, 'POST', `/api/host/meets/${m.id}/flyer`, { cookie, raw: { type: 'image/jpeg', buf: fs.readFileSync(path.join(FIX, 'photo.jpg')) }, headers: { Origin: 'http://meets.test' } })).json.meet.flyer;
  const b1 = path.basename(f1).replace('.jpg', '');
  await S.req(ctx, 'GET', new URL(m.url).pathname);
  await until(() => fs.readdirSync(up).filter((f) => f.startsWith(b1 + '.s')).length >= 2, 30000);
  await S.req(ctx, 'POST', `/api/host/meets/${m.id}/flyer`, { cookie, raw: { type: 'image/jpeg', buf: fs.readFileSync(path.join(FIX, 'photo.jpg')) }, headers: { Origin: 'http://meets.test' } });
  await S.sleep(500);
  const left = fs.readdirSync(up).filter((f) => f.startsWith(b1));
  assert.deepEqual(left, [], 'left: ' + left.join(', '));
});

test('the video queue runs one encode at a time, HEVC copies included (FINDING if this fails)', async () => {
  const mem = (await S.req(ctx, 'POST', '/api/host/members', { cookie, body: { name: 'Clips', car: 'GR86' }, headers: { Origin: 'http://meets.test' } })).json.member;
  let most = 0; let stop = false;
  const sampler = (async () => { while (!stop) { const n = execSync("ps -eo args | grep -E '[f]fmpeg.*(libx264|libx265)' | wc -l").toString().trim() | 0; most = Math.max(most, n); await S.sleep(150); } })();
  await upload(`/api/host/members/${mem.id}/clips`, path.join(FIX, 'phone-upright.mov'), 'video/quicktime');
  // A second clip arrives while the first one's HEVC copy is being made.
  await until(() => execSync("ps -eo args | grep -c '[l]ibx265' || true").toString().trim() !== '0', 120000);
  await upload(`/api/host/video`, path.join(FIX, 'phone-1080p.mp4'), 'video/mp4');
  await until(async () => (await S.req(ctx, 'GET', '/api/host/me', { cookie })).json.host.video.status === 'ready', 300000);
  stop = true; await sampler;
  assert.equal(most, 1, `${most} encodes ran at once`);
});

test('a restart mid-encode leaves no upload behind and no ffmpeg running (FINDING if this fails)', async () => {
  await upload('/api/host/video', path.join(FIX, '4k60.mp4'), 'video/mp4');
  await until(() => execSync("ps -eo args | grep -c '[l]ibx264' || true").toString().trim() !== '0', 60000);
  await ctx.restart('SIGTERM');
  await S.sleep(2000);
  const st = (await S.req(ctx, 'GET', '/api/host/me', { cookie })).json.host.video;
  const tmp = fs.readdirSync(path.join(up, 'tmp'));
  const encoding = execSync("ps -eo args | grep -c '[l]ibx264' || true").toString().trim() | 0;
  assert.equal(st.status, 'failed', 'status says failed: ' + JSON.stringify(st));
  assert.deepEqual({ tmp: tmp.length, encoding }, { tmp: 0, encoding: 0 }, `left in uploads/tmp: ${tmp.join(', ')}; encodes still running: ${encoding}`);
});
