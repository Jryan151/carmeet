'use strict';
/* Club members' pages: the host starts one, texts the link; the link edits only that page (photos, build, clip);
   the page shows the build, the club and its crew, and the photos as a feed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startSite, request, host } = require('./helpers');

const ctx = startSite(test);
const SITE = 'meets.test';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let C, club, jay, key;
const png = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'p.png');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x3050c0:s=320x200', '-frames:v', '1', f]);
  return fs.readFileSync(f);
};

test.before(async () => { C = await host(ctx); });

test('the host starts a page and texts the link; the link edits that page only', { skip: !hasFfmpeg }, async () => {
  let r = await request(ctx, 'POST', SITE, '/api/host/kit?kind=group&name=Unforsaken', { cookie: C, raw: { buf: png(), type: 'image/png' } });
  club = r.json.logo;
  r = await request(ctx, 'POST', SITE, '/api/host/members', { cookie: C, body: { name: 'Jay Ramirez', instagram: '@jays_m3', car: '2021 BMW M3', clubId: club.id } });
  assert.equal(r.status, 201, r.text); jay = r.json.member;
  assert.equal(jay.handle, 'jays-m3', 'from their Instagram');
  assert.equal(jay.clubName, 'Unforsaken');
  r = await request(ctx, 'POST', SITE, '/api/host/members', { cookie: C, body: { name: 'Jay', handle: 'jays-m3' } });
  assert.equal(r.status, 409);
  r = await request(ctx, 'POST', SITE, '/api/host/members', { cookie: C, body: { name: 'Lu', clubId: club.id } });
  const lu = r.json.member;
  // The link.
  r = await request(ctx, 'POST', SITE, `/api/host/members/${jay.id}/link`, { cookie: C });
  assert.equal(r.status, 201);
  assert.match(r.json.url, new RegExp(`/@jays-m3/edit#${jay.id}\\.[a-f0-9]{40}$`));
  assert.ok(r.json.text.includes(r.json.url));
  key = r.json.url.split('.').pop();
  // With the key: their page, not anyone else's; not the club or the page name.
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${jay.id}`, { headers: { 'x-member-key': key }, body: { mods: 'Stage 2 tune\nCarbon hood, Air lift', about: 'Weekend car.', handle: 'hijack', clubId: null } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.member.handle, 'jays-m3'); assert.equal(r.json.member.clubName, 'Unforsaken');
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${lu.id}`, { headers: { 'x-member-key': key }, body: { name: 'Hacked' } });
  assert.equal(r.status, 404);
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${jay.id}`, { body: { name: 'Nobody' } });
  assert.equal(r.status, 404, 'no key, no session');
  for (let i = 0; i < 2; i++) {
    r = await request(ctx, 'POST', SITE, `/api/host/members/${jay.id}/photos`, { headers: { 'x-member-key': key }, raw: { buf: png(), type: 'image/png' } });
    assert.equal(r.status, 201, r.text);
  }
  assert.equal(r.json.member.photos.length, 2);
  // A new link turns the old one off.
  await request(ctx, 'POST', SITE, `/api/host/members/${jay.id}/link`, { cookie: C });
  r = await request(ctx, 'GET', SITE, `/api/host/members/${jay.id}`, { headers: { 'x-member-key': key } });
  assert.equal(r.status, 404);
});

test('the page: the top, the feed with photos and clips, the build, the crew; the editor page is never indexed', { skip: !hasFfmpeg }, async () => {
  // A clip for the feed (the host's session works too): processing, then in the feed.
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clip-')), 'c.mp4');
  spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', '2', '-pix_fmt', 'yuv420p', f]);
  let r = await request(ctx, 'POST', SITE, `/api/host/members/${jay.id}/clips?caption=Pulling%20in`, { cookie: C, raw: { buf: fs.readFileSync(f), type: 'video/mp4' } });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.member.photos.find((x) => x.kind === 'video').status, 'processing');
  r = await request(ctx, 'GET', SITE, '/@jays-m3');
  assert.doesNotMatch(r.text, /data-feed/, 'not in the feed until it’s ready');
  for (let i = 0; i < 60; i++) {
    await new Promise((ok) => setTimeout(ok, 1000));
    r = await request(ctx, 'GET', SITE, `/api/host/members/${jay.id}`, { cookie: C });
    if (r.json.member.photos.some((x) => x.kind === 'video' && x.status !== 'processing')) break;
  }
  assert.equal(r.json.member.photos.find((x) => x.kind === 'video').status, 'ready');
  r = await request(ctx, 'GET', SITE, '/@jays-m3');
  assert.equal(r.status, 200);
  assert.match(r.text, /<h1 class="m-name">Jay Ramirez<\/h1>/);
  assert.match(r.text, /2021 BMW M3/);
  assert.match(r.text, /<li>Stage 2 tune<\/li><li>Carbon hood<\/li><li>Air lift<\/li>/, (r.text.match(/m-mods[\s\S]{0,200}/) || [''])[0]);
  assert.match(r.text, /Unforsaken crew[\s\S]*href="\/@lu-car"/);
  assert.equal((r.text.match(/class="m-shot"/g) || []).length, 2);
  assert.match(r.text, /<figure class="m-shot clip"><video muted loop playsinline preload="none" poster="[^"]+" data-feed>[\s\S]*?<source data-src="\/uploads\/bg-[0-9a-f]+\.mp4" type="video\/mp4"><\/video><figcaption>Pulling in<\/figcaption>/);
  assert.ok(r.text.indexOf('m-shot clip') < r.text.indexOf('class="m-shot"'), 'newest first');
  assert.ok(r.text.indexOf('class="showcase"') < r.text.indexOf('<section class="m-feed"'), 'the feed is below the open top');
  assert.match(r.text, /instagram\.com\/jays_m3/);
  // The top: their club's logo instead of their photo, or one they upload.
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${jay.id}`, { cookie: C, body: { header: 'club' } });
  assert.equal(r.json.member.header, 'club');
  r = await request(ctx, 'GET', SITE, '/@jays-m3');
  assert.match(r.text, /<div class="avatar m-logo"><img src="\/uploads\/[^"]+" alt="Jay Ramirez"><\/div>/);
  assert.doesNotMatch(r.text, /class="m-face/);
  r = await request(ctx, 'POST', SITE, `/api/host/members/${jay.id}/header`, { cookie: C, raw: { buf: png(), type: 'image/png' } });
  assert.equal(r.json.member.header, 'logo');
  assert.ok(r.json.member.headerLogo);
  r = await request(ctx, 'PUT', SITE, `/api/host/members/${jay.id}`, { cookie: C, body: { header: 'photo' } });
  r = await request(ctx, 'GET', SITE, '/@jays-m3');
  assert.match(r.text, /class="m-face/);
  r = await request(ctx, 'GET', SITE, '/@JAYS-M3');
  assert.equal(r.status, 301);
  r = await request(ctx, 'GET', SITE, '/@jays-m3/edit');
  assert.equal(r.status, 200);
  assert.match(r.headers['x-robots-tag'], /noindex/);
  assert.match(r.text, /member-edit\.js/);
  r = await request(ctx, 'GET', SITE, '/@nobody-here');
  assert.equal(r.status, 404);
  // Deleting the club keeps the page, without the club; deleting the page removes it.
  await request(ctx, 'DELETE', SITE, `/api/host/kit/${club.id}`, { cookie: C });
  r = await request(ctx, 'GET', SITE, '/@jays-m3');
  assert.doesNotMatch(r.text, /Unforsaken/);
  r = await request(ctx, 'DELETE', SITE, `/api/host/members/${jay.id}`, { cookie: C });
  r = await request(ctx, 'GET', SITE, '/@jays-m3');
  assert.equal(r.status, 404);
});
