'use strict';
/* Club prospects: the owner builds a club's page (logo and its colors, screenshots read into members, a clip from the
   footage library), it stays unlisted with "Make it ours" until someone from the club claims it with an emailed code;
   claimed, the club gets an editor link (no account). Unclaimed, it's gone after its days with its member pages.
   Library clips are shared by pages and never deleted with them. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startSite, request, host } = require('./helpers');

// The AI that reads screenshots, stood in for: it answers like the real one, from what the test sets.
const ai = { calls: [], answer: null };
const AI_PORT = 43000 + Math.floor(Math.random() * 4000);
const aiSrv = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    ai.calls.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'Here you go:\n' + JSON.stringify(ai.answer) }] }));
  });
}).listen(AI_PORT, '127.0.0.1');
test.after(() => aiSrv.close());

const ctx = startSite(test, { ANTHROPIC_API_KEY: 'test-ai-key', ANTHROPIC_BASE: `http://127.0.0.1:${AI_PORT}` });
const SITE = 'meets.test';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-'));
const picture = (color, w = 320, h = 200) => {
  const f = path.join(tmp, color + w + '.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x${h}`, '-frames:v', '1', f]);
  return fs.readFileSync(f);
};
const clip = () => {
  const f = path.join(tmp, 'clip.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-t', '2', '-pix_fmt', 'yuv420p', f]);
  return fs.readFileSync(f);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let O, other, club, foot;

test.before(async () => {
  O = await host(ctx); // the first host is the site's owner
  other = await host(ctx, { email: 'other@example.com', name: 'Fuel Friday', slug: 'fuel-friday' });
});

test('only the site owner has prospects; a new one gets its page address and 30 days', async () => {
  let r = await request(ctx, 'GET', SITE, '/api/host/prospects', { cookie: other });
  assert.equal(r.status, 404, 'another host never sees it');
  r = await request(ctx, 'POST', SITE, '/api/host/prospects', { cookie: other, body: { name: 'Nope' } });
  assert.equal(r.status, 404);
  r = await request(ctx, 'POST', SITE, '/api/host/prospects', { cookie: O, body: { name: 'Unforsaken', instagram: '@unforsaken.az' } });
  assert.equal(r.status, 201, r.text); club = r.json.club;
  assert.equal(club.slug, 'unforsaken'); assert.equal(club.url, 'http://meets.test/c/unforsaken');
  assert.equal(club.prospect, true); assert.equal(club.daysLeft, 30); assert.equal(club.instagram, 'unforsaken.az');
  assert.match(club.dm, /meets\.test\/c\/unforsaken/); assert.match(club.dm, /Make it ours/);
  r = await request(ctx, 'POST', SITE, '/api/host/prospects', { cookie: O, body: { name: 'unforsaken' } });
  assert.equal(r.status, 409, 'one page per club');
  r = await request(ctx, 'GET', SITE, '/api/host/prospects', { cookie: O });
  assert.equal(r.json.clubs.length, 1); assert.equal(r.json.aiReady, true);
});

test('the logo: trimmed, its colors read, the first one becomes the page color', { skip: !hasFfmpeg }, async () => {
  const r = await request(ctx, 'POST', SITE, `/api/host/prospects/${club.id}/logo`, { cookie: O, raw: { buf: picture('0xd02030'), type: 'image/png' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.colors.length >= 1, 'a color came out of it');
  assert.match(r.json.colors[0], /^#[0-9a-f]{6}$/);
  assert.ok(parseInt(r.json.colors[0].slice(1, 3), 16) > 150, 'red, like the logo: ' + r.json.colors[0]);
  assert.equal(r.json.club.accent, r.json.colors[0]);
  assert.ok(r.json.club.logo);
});

test('screenshots read into details and members (nothing saved until picked); picked members get pages', async () => {
  ai.answer = { name: 'Unforsaken', instagram: '@unforsaken.az', tagline: 'Phoenix · Est. 2019 🔥', members: [
    { instagram: '@jays_m3', name: 'Jay', car: '2021 BMW M3' }, { instagram: 'lu.supra', name: '', car: 'Supra?' }, { instagram: '@jays_m3', name: 'dup', car: '' }, { instagram: 'not a handle!!', name: '', car: '' }] };
  const shot = Buffer.from('fake-jpeg-bytes').toString('base64');
  let r = await request(ctx, 'POST', SITE, `/api/host/prospects/${club.id}/read`, { cookie: O, body: { files: [{ type: 'image/jpeg', data: shot }, { type: 'text/html', data: 'x' }] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ai.calls.length, 1); assert.equal(ai.calls[0].key, 'test-ai-key');
  assert.equal(ai.calls[0].body.messages[0].content.filter((c) => c.type === 'image').length, 1, 'only the picture went');
  const read = r.json.read;
  assert.equal(read.instagram, 'unforsaken.az');
  assert.deepEqual(read.members.map((m) => m.instagram), ['jays_m3', 'lu.supra'], 'each handle once, made-up ones dropped');
  r = await request(ctx, 'GET', SITE, `/api/host/prospects/${club.id}`, { cookie: O });
  assert.equal(r.json.club.members.length, 0, 'nothing saved by reading');
  r = await request(ctx, 'POST', SITE, `/api/host/prospects/${club.id}/members`, { cookie: O, body: { members: read.members } });
  assert.equal(r.status, 201, r.text); assert.equal(r.json.added, 2);
  assert.deepEqual(r.json.club.members.map((m) => m.handle).sort(), ['jays-m3', 'lu-supra']);
  r = await request(ctx, 'POST', SITE, `/api/host/prospects/${club.id}/members`, { cookie: O, body: { members: [{ instagram: 'jays_m3' }] } });
  assert.equal(r.status, 409, 'already on the page');
  r = await request(ctx, 'PUT', SITE, `/api/host/prospects/${club.id}`, { cookie: O, body: { tagline: read.tagline } });
  assert.equal(r.json.club.tagline, read.tagline);
  // A second read says which are on the page already.
  r = await request(ctx, 'POST', SITE, `/api/host/prospects/${club.id}/read`, { cookie: O, body: { files: [{ type: 'image/png', data: shot }] } });
  assert.equal(r.json.read.members.find((m) => m.instagram === 'jays_m3').have, true);
});

test('the footage library: tagged, searched, shared by pages, never deleted with them', { skip: !hasFfmpeg }, async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/footage?title=' + encodeURIComponent('Dunlap night') + '&tags=' + encodeURIComponent('Unforsaken, #Scottsdale, M3'), { cookie: O, raw: { buf: clip(), type: 'video/mp4' } });
  assert.equal(r.status, 202, r.text);
  for (let i = 0; i < 120; i++) {
    r = await request(ctx, 'GET', SITE, '/api/host/footage', { cookie: O });
    foot = r.json.footage[0];
    if (foot.video.status !== 'processing') break;
    await wait(500);
  }
  assert.equal(foot.video.status, 'ready', JSON.stringify(foot));
  assert.equal(foot.tags, 'unforsaken, scottsdale, m3');
  r = await request(ctx, 'GET', SITE, '/api/host/footage?q=scotts%20m3', { cookie: O });
  assert.equal(r.json.footage.length, 1);
  r = await request(ctx, 'GET', SITE, '/api/host/footage?q=glendale', { cookie: O });
  assert.equal(r.json.footage.length, 0);
  r = await request(ctx, 'GET', SITE, '/api/host/footage', { cookie: other });
  assert.equal(r.status, 404);
  // Behind the club's page and a member's.
  r = await request(ctx, 'PUT', SITE, `/api/host/prospects/${club.id}/footage`, { cookie: O, body: { footageId: foot.id } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.club.footageId, foot.id); assert.equal(r.json.club.video.status, 'ready');
  const jay = r.json.club.members.find((m) => m.handle === 'jays-m3');
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${jay.id}/footage`, { cookie: O, body: { footageId: foot.id } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.member.video.status, 'ready');
  r = await request(ctx, 'GET', SITE, '/api/host/footage', { cookie: O });
  assert.equal(r.json.footage[0].used, 2);
  r = await request(ctx, 'DELETE', SITE, `/api/host/footage/${foot.id}`, { cookie: O });
  assert.equal(r.status, 409, 'not while a page uses it');
  // Taken off the member's page: the clip is still in the library, its file still there.
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${jay.id}/footage`, { cookie: O, body: { footageId: null } });
  assert.equal(r.json.member.video.status, null);
  r = await request(ctx, 'GET', SITE, foot.video.url);
  assert.equal(r.status, 200, 'the library file stays');
});

test('the page while it’s a prospect: unlisted, never indexed, "Make it ours"; its members aren’t listed either', async () => {
  let r = await request(ctx, 'GET', SITE, '/c/unforsaken');
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /Make it ours/); assert.match(r.text, /<meta name="robots" content="noindex">/);
  assert.equal(r.headers['x-robots-tag'], 'noindex');
  assert.match(r.text, /href="\/@jays-m3"/); assert.match(r.text, /Phoenix · Est\. 2019/);
  r = await request(ctx, 'GET', SITE, '/c/UNFORSAKEN');
  assert.equal(r.status, 301);
  r = await request(ctx, 'GET', SITE, '/members');
  assert.doesNotMatch(r.text, /jays-m3/, 'not on the members list yet');
  r = await request(ctx, 'GET', SITE, '/@jays-m3');
  assert.equal(r.status, 200); assert.equal(r.headers['x-robots-tag'], 'noindex');
  r = await request(ctx, 'GET', SITE, '/c/nobody-here');
  assert.equal(r.status, 404);
});

let editKey;
test('claiming: an emailed code, then it’s theirs (listed, indexed, kept) with an editor link', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/club/unforsaken/code', { body: { email: 'President@Unforsaken.com' } });
  assert.equal(r.status, 200, r.text); const code = r.json.devCode; assert.match(code, /^\d{6}$/);
  r = await request(ctx, 'POST', SITE, '/api/host/club/unforsaken/verify', { body: { email: 'president@unforsaken.com', code: code === '000000' ? '111111' : '000000' } });
  assert.equal(r.status, 400);
  r = await request(ctx, 'POST', SITE, '/api/host/club/unforsaken/verify', { body: { email: 'president@unforsaken.com', code } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.claimed, true);
  assert.match(r.json.editUrl, new RegExp(`^http://meets\\.test/c/unforsaken/edit#${club.id}\\.[a-f0-9]{40}$`));
  editKey = r.json.editUrl.split('.').pop();
  r = await request(ctx, 'GET', SITE, '/c/unforsaken');
  assert.doesNotMatch(r.text, /Make it ours/); assert.doesNotMatch(r.text, /noindex/);
  assert.match(r.text, /Get your editor link/);
  r = await request(ctx, 'GET', SITE, '/members');
  assert.match(r.text, /jays-m3/, 'listed now');
  r = await request(ctx, 'GET', SITE, '/api/host/prospects', { cookie: O });
  const row = r.json.clubs.find((x) => x.id === club.id);
  assert.equal(row.claimed, true); assert.equal(row.prospect, false); assert.equal(row.daysLeft, null);
  r = await request(ctx, 'GET', SITE, `/api/host/prospects/${club.id}`, { cookie: O });
  assert.equal(r.json.club.claimEmail, 'president@unforsaken.com');
  r = await request(ctx, 'GET', SITE, '/c/unforsaken/edit');
  assert.equal(r.status, 200); assert.match(r.text, /noindex/); assert.match(r.text, /club-edit\.js/);
});

test('the club’s editor: their key changes their page and members, nothing else', async () => {
  const H = { 'x-club-key': editKey };
  let r = await request(ctx, 'GET', SITE, `/api/host/club-edit/${club.id}`);
  assert.equal(r.status, 404, 'no key');
  r = await request(ctx, 'GET', SITE, `/api/host/club-edit/${club.id}`, { headers: { 'x-club-key': 'a'.repeat(40) } });
  assert.equal(r.status, 404, 'wrong key');
  r = await request(ctx, 'PUT', SITE, `/api/host/club-edit/${club.id}`, { headers: H, body: { tagline: 'Scottsdale since 2019', slug: 'hijacked', accent: '#123456' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.club.tagline, 'Scottsdale since 2019'); assert.equal(r.json.club.slug, 'unforsaken', 'the address stays'); assert.equal(r.json.club.accent, '#123456');
  assert.equal(r.json.club.claimEmail, undefined);
  r = await request(ctx, 'POST', SITE, `/api/host/club-edit/${club.id}/members`, { headers: H, body: { name: 'Marco', car: '1999 Civic Si' } });
  assert.equal(r.status, 201, r.text);
  const marco = r.json.club.members.find((m) => m.name === 'Marco');
  r = await request(ctx, 'POST', SITE, `/api/host/club-edit/${club.id}/members/${marco.id}/link`, { headers: H });
  assert.equal(r.status, 201); assert.match(r.json.url, /\/@marco\/edit#\d+\.[a-f0-9]{40}$/); assert.match(r.json.text, /Unforsaken/);
  const mkey = r.json.url.split('.').pop();
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${marco.id}`, { headers: { 'x-member-key': mkey }, body: { mods: 'Turbo' } });
  assert.equal(r.status, 200, 'the member finishes their own page');
  r = await request(ctx, 'DELETE', SITE, `/api/host/club-edit/${club.id}/members/${marco.id}`, { headers: H });
  assert.equal(r.status, 200); assert.ok(!r.json.club.members.find((m) => m.id === marco.id));
});

test('a new editor link: only to the email that claimed it; the old one stops working', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/club/unforsaken/code', { body: { email: 'someone@else.com' } });
  assert.equal(r.status, 200); assert.equal(r.json.devCode, undefined, 'says nothing, sends nothing');
  r = await request(ctx, 'POST', SITE, '/api/host/club/unforsaken/code', { body: { email: 'president@unforsaken.com' } });
  const code = r.json.devCode; assert.ok(code);
  r = await request(ctx, 'POST', SITE, '/api/host/club/unforsaken/verify', { body: { email: 'president@unforsaken.com', code } });
  assert.equal(r.status, 200); assert.equal(r.json.claimed, false);
  const newKey = r.json.editUrl.split('.').pop();
  r = await request(ctx, 'GET', SITE, `/api/host/club-edit/${club.id}`, { headers: { 'x-club-key': editKey } });
  assert.equal(r.status, 404, 'the old link is off');
  r = await request(ctx, 'GET', SITE, `/api/host/club-edit/${club.id}`, { headers: { 'x-club-key': newKey } });
  assert.equal(r.status, 200, 'the new one works');
  editKey = newKey;
});

test('an unclaimed prospect past its days is gone, with its member pages; a library clip it used stays', { skip: !hasFfmpeg }, async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/prospects', { cookie: O, body: { name: 'Night Shift' } });
  const ns = r.json.club;
  r = await request(ctx, 'POST', SITE, `/api/host/prospects/${ns.id}/members`, { cookie: O, body: { members: [{ instagram: 'ns_gtr', car: 'R35 GT-R' }] } });
  r = await request(ctx, 'PUT', SITE, `/api/host/prospects/${ns.id}/footage`, { cookie: O, body: { footageId: foot.id } });
  r = await request(ctx, 'POST', SITE, `/api/host/prospects/${ns.id}/extend`, { cookie: O });
  assert.equal(r.json.club.daysLeft, 30);
  // Its time runs out.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(ctx.dbFile);
  db.prepare('UPDATE kit_logos SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, ns.id);
  db.close();
  r = await request(ctx, 'GET', SITE, '/api/host/prospects', { cookie: O });
  assert.ok(!r.json.clubs.find((x) => x.id === ns.id), 'swept');
  r = await request(ctx, 'GET', SITE, '/c/night-shift'); assert.equal(r.status, 404);
  r = await request(ctx, 'GET', SITE, '/@ns-gtr'); assert.equal(r.status, 404);
  r = await request(ctx, 'GET', SITE, foot.video.url); assert.equal(r.status, 200, 'the library clip stays');
  // The claimed one is never swept.
  r = await request(ctx, 'GET', SITE, '/c/unforsaken'); assert.equal(r.status, 200);
});

test('taking a prospect down deletes its page and member pages right away', async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/prospects', { cookie: O, body: { name: 'Low Club' } });
  const lc = r.json.club;
  await request(ctx, 'POST', SITE, `/api/host/prospects/${lc.id}/members`, { cookie: O, body: { members: [{ name: 'Rae', car: 'S2000' }] } });
  r = await request(ctx, 'DELETE', SITE, `/api/host/prospects/${lc.id}`, { cookie: other });
  assert.equal(r.status, 404);
  r = await request(ctx, 'DELETE', SITE, `/api/host/prospects/${lc.id}`, { cookie: O });
  assert.equal(r.status, 200);
  r = await request(ctx, 'GET', SITE, '/c/low-club'); assert.equal(r.status, 404);
  r = await request(ctx, 'GET', SITE, '/@rae'); assert.equal(r.status, 404);
});

test('a read that comes back garbled says so plainly', async () => {
  ai.answer = 'not json';
  const r = await request(ctx, 'POST', SITE, `/api/host/prospects/${club.id}/read`, { cookie: O, body: { files: [{ type: 'image/png', data: 'aGVsbG8=' }] } });
  assert.equal(r.status, 502); assert.match(r.json.error, /screenshots/);
});
