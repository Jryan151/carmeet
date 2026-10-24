'use strict';
/* Section 5 — security and abuse. Each test states what should hold; a failing test is a finding.
   node --test test/stress/repro/security.repro.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { startSite, request, host } = require('../../helpers');

const ctx = startSite(test, { DEMO_PASSWORD: 'tacos2026', DEMO_HOST: 'tasty-tuesday' });
const SITE = 'meets.test';
const FIX = path.join(__dirname, '..', '.fixtures');
const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let A, B; // two hosts' cookies
const a = {}; const b = {};
const XSS = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

const req = (m, p, o = {}) => request(ctx, m, o.host || SITE, p, o);

test.before(async () => {
  A = await host(ctx, { email: 'a@a.test', name: 'Tasty Tuesday', slug: 'tasty-tuesday' });
  B = await host(ctx, { email: 'b@b.test', name: 'West Side', slug: 'west-side' });
  for (const [c, o] of [[A, a], [B, b]]) {
    let r = await req('POST', '/api/host/meets', { cookie: c, body: { day: ymd(3), start: '19:00', end: '22:00', place: 'Lot', title: o === a ? 'Fuel Friday' : 'Midnight', pageName: o === a ? 'fuel-friday' : 'midnight' } });
    assert.equal(r.status, 201, r.text); o.meet = r.json.meet.id;
    r = await req('POST', '/api/host/kit/entry', { cookie: c, body: { kind: 'vendor', name: 'Truck ' + (o === a ? 'A' : 'B') } }); o.kit = r.json.logo.id;
    r = await req('POST', '/api/host/kit/entry', { cookie: c, body: { kind: 'group', name: 'Club ' + (o === a ? 'A' : 'B') } }); o.club = r.json.logo.id;
    r = await req('POST', '/api/host/kit/entry', { cookie: c, body: { kind: 'venue', name: 'Venue ' + (o === a ? 'A' : 'B') } }); o.venue = r.json.logo.id;
    r = await req('POST', '/api/host/members', { cookie: c, body: { name: 'Member ' + (o === a ? 'A' : 'B'), car: 'Civic', clubId: o.club } }); o.member = r.json.member.id;
    r = await req('POST', `/api/host/members/${o.member}/link`, { cookie: c }); o.key = r.json.url.split('.').pop();
    r = await req('POST', '/api/host/recaps', { cookie: c, body: { caption: 'Recap', meetId: o.meet } }); o.recap = r.json.id;
    r = await req('POST', '/api/vendor-request', { body: { host: o === a ? 'tasty-tuesday' : 'west-side', name: 'Req', contact: '555' }, headers: { 'X-Forwarded-For': o === a ? '10.0.0.1' : '10.0.0.2' } });
    const list = await req('GET', '/api/host/requests', { cookie: c }); o.request = list.json.requests[0].id;
    r = await req('POST', `/api/host/kit/${o.kit}/spots`, { cookie: c, body: { name: 'Spot' } }); o.spot = r.json.profile.spots[0].id;
    r = await req('POST', `/api/host/members/${o.member}/photos`, { cookie: c, raw: { type: 'image/jpeg', buf: fs.readFileSync(path.join(FIX, 'photo.jpg')) } }); o.photo = r.json.member.photos[0].id;
  }
});

/* ---------- auth ---------- */
test('a made-up session, an expired one and a signed-out one get nothing', async () => {
  assert.equal((await req('GET', '/api/host/me', { cookie: 'mh_session=' + 'ab'.repeat(24) })).status, 401);
  const D = require('sqlite3'); const db = new D.Database(ctx.dbFile);
  const t = crypto.randomBytes(24).toString('hex');
  await new Promise((ok) => db.run('INSERT INTO sessions (token_hash, host_id, expires_at, created_at) VALUES (?, 1, ?, ?)', [crypto.createHash('sha256').update(t).digest('hex'), Date.now() - 1000, Date.now()], ok));
  db.close();
  assert.equal((await req('GET', '/api/host/me', { cookie: 'mh_session=' + t })).status, 401, 'expired session refused');
  const c = await host(ctx, { email: 'c@c.test', name: 'Third', slug: 'third-host' });
  await req('POST', '/api/host/logout', { cookie: c, body: {} });
  assert.equal((await req('GET', '/api/host/me', { cookie: c })).status, 401, 'a cookie stops working after sign out');
});

test('a member key works only for its own page, and an old one stops after a new link', async () => {
  assert.equal((await req('GET', `/api/host/members/${a.member}`, { headers: { 'x-member-key': a.key } })).status, 200);
  assert.equal((await req('GET', `/api/host/members/${b.member}`, { headers: { 'x-member-key': a.key } })).status, 404, 'A’s key on B’s page');
  assert.equal((await req('PUT', `/api/host/members/${b.member}`, { headers: { 'x-member-key': a.key }, body: { car: 'pwned' } })).status, 404);
  assert.equal((await req('GET', `/api/host/members/${a.member}`, { headers: { 'x-member-key': 'f'.repeat(40) } })).status, 404, 'wrong key');
  // A member's key can't pick the club or the page name, or delete the page.
  await req('PUT', `/api/host/members/${a.member}`, { headers: { 'x-member-key': a.key }, body: { handle: 'took-it', clubId: b.club } });
  const m = (await req('GET', `/api/host/members/${a.member}`, { headers: { 'x-member-key': a.key } })).json.member;
  assert.notEqual(m.handle, 'took-it'); assert.notEqual(m.clubId, b.club);
  assert.equal((await req('DELETE', `/api/host/members/${a.member}`, { headers: { 'x-member-key': a.key } })).status, 401);
  const old = a.key;
  const r = await req('POST', `/api/host/members/${a.member}/link`, { cookie: A }); a.key = r.json.url.split('.').pop();
  assert.equal((await req('GET', `/api/host/members/${a.member}`, { headers: { 'x-member-key': old } })).status, 404, 'old key after a new link');
});

test('the demo password can’t be guessed from many addresses (FINDING if this fails)', async () => {
  // 10 tries per address per 15 minutes, nothing overall: an attacker with many addresses (an IPv6 /64 has 2^64)
  // keeps going. Caddy hands the real address over in X-Forwarded-For, which the site trusts from loopback.
  let fromOne = 0, limitedOne = 0;
  for (let i = 0; i < 12; i++) { const r = await req('POST', '/api/host/password', { body: { password: 'guess' + i }, headers: { 'X-Forwarded-For': '203.0.113.7' } }); if (r.status === 429) limitedOne++; else fromOne++; }
  assert.ok(limitedOne >= 2, 'one address is limited after 10 tries');
  let tried = 0;
  for (let i = 0; i < 300; i++) { const r = await req('POST', '/api/host/password', { body: { password: 'g' + i }, headers: { 'X-Forwarded-For': `2001:db8::${i.toString(16)}` } }); if (r.status !== 429) tried++; }
  assert.ok(tried < 50, `${tried} of 300 guesses from 300 addresses in one /64 were tried (no overall or per-prefix limit)`);
});

/* ---------- ownership: every /api/host route that takes an id, with another host's ids ---------- */
test('host B can’t read or change anything of host A’s', async () => {
  const D = require('sqlite3'); const db = new D.Database(ctx.dbFile);
  const all = (sql) => new Promise((ok) => db.all(sql, [], (e, r) => ok(r)));
  const snap = async () => JSON.stringify(await Promise.all(['SELECT * FROM meets WHERE host_id = 1', 'SELECT * FROM kit_logos WHERE host_id = 1', 'SELECT * FROM members WHERE host_id = 1', 'SELECT * FROM member_photos',
    'SELECT * FROM recaps WHERE host_id = 1', 'SELECT * FROM vendor_requests WHERE host_id = 1', 'SELECT * FROM kit_spots', 'SELECT * FROM meet_kit_vendors', 'SELECT * FROM kit_media'].map(all)));
  const before = await snap();
  const img = { type: 'image/png', buf: fs.readFileSync(path.join(FIX, 'logo.png')) };
  const calls = [
    ['PUT', `/meets/${a.meet}`, { day: ymd(4), start: '19:00', end: '22:00', place: 'X' }], ['POST', `/meets/${a.meet}/again`], ['POST', `/meets/${a.meet}/cancel`, {}], ['POST', `/meets/${a.meet}/resync`],
    ['POST', `/meets/${a.meet}/turnout`, { people: 5 }], ['GET', `/meets/${a.meet}/trucks`], ['POST', `/meets/${a.meet}/invite`, {}], ['POST', `/meets/${a.meet}/send-link`, { kitId: a.kit }],
    ['POST', `/meets/${b.meet}/send-link`, { kitId: a.kit }], ['POST', `/meets/${a.meet}/trucks`, { slug: 'x' }], ['DELETE', `/meets/${a.meet}/trucks/1`], ['POST', `/meets/${a.meet}/flyer`, null, img], ['DELETE', `/meets/${a.meet}/flyer`],
    ['PUT', `/meets/${a.meet}/lot`, { lot: { lat: 33.5, lng: -112.1 } }], ['DELETE', `/meets/${a.meet}/lot`], ['GET', `/meets/${a.meet}/kit-vendors`], ['PUT', `/meets/${a.meet}/kit-vendors/${a.kit}`, {}],
    ['PUT', `/meets/${b.meet}/kit-vendors/${a.kit}`, {}], ['DELETE', `/meets/${a.meet}/kit-vendors/${a.kit}`], ['POST', `/meets/${a.meet}/logo`, null, img], ['DELETE', `/meets/${a.meet}/logo`], ['DELETE', `/meets/${a.meet}/video`],
    ['POST', `/requests/${a.request}/invite`, { meetId: b.meet }], ['POST', `/requests/${b.request}/invite`, { meetId: a.meet }], ['PUT', `/requests/${a.request}`, { status: 'dismissed' }],
    ['DELETE', `/recaps/${a.recap}`], ['POST', `/recaps/${a.recap}/photos`, null, { type: 'image/png', buf: img.buf }], ['POST', '/locations', { meetId: a.meet, name: 'Steal' }], ['DELETE', `/locations/${a.venue}`],
    ['PUT', `/kit/${a.kit}`, { name: 'pwned' }], ['PUT', `/kit/${b.kit}`, { logoFrom: a.kit }], ['DELETE', `/kit/${a.kit}`], ['POST', `/kit/${a.kit}/image`, null, img], ['POST', '/kit/read', { ids: [a.kit] }],
    ['GET', `/kit/${a.kit}/menu`], ['PUT', `/kit/${a.kit}/menu`, { items: [] }], ['GET', `/kit/${a.kit}/profile`], ['PUT', `/kit/${a.kit}/profile`, { about: 'pwned', pageOn: true }], ['DELETE', `/kit/${a.kit}/video`],
    ['POST', `/kit/${a.kit}/media`, null, img], ['POST', `/kit/${a.kit}/spots`, { name: 'x' }], ['DELETE', `/kit/${a.kit}/spots/${a.spot}`], ['DELETE', `/kit/${b.kit}/spots/${a.spot}`],
    ['POST', '/updates', { message: 'hi', toVendors: true, meetId: a.meet }], ['GET', `/members/${a.member}`], ['PUT', `/members/${a.member}`, { car: 'pwned' }], ['DELETE', `/members/${a.member}`],
    ['POST', `/members/${a.member}/link`], ['POST', `/members/${a.member}/photos`, null, { type: 'image/jpeg', buf: fs.readFileSync(path.join(FIX, 'photo.jpg')) }], ['PUT', `/members/${a.member}/photos/${a.photo}`, { caption: 'x' }],
    ['DELETE', `/members/${a.member}/photos/${a.photo}`], ['DELETE', `/members/${b.member}/photos/${a.photo}`], ['POST', `/members/${a.member}/header`, null, img], ['DELETE', `/members/${a.member}/video`],
    ['POST', '/members', { name: 'x', clubId: a.club }], ['PUT', `/members/${b.member}`, { clubId: a.club }],
  ];
  const leaks = [];
  for (const [m, p, body, raw] of calls) {
    const r = await req(m, '/api/host' + p, { cookie: B, body: raw ? undefined : body === undefined ? (m === 'GET' || m === 'DELETE' ? undefined : {}) : body, raw: raw ? { type: raw.type, buf: raw.buf } : undefined });
    const txt = r.text || '';
    // Calls on B's own things (with one of A's ids inside) may succeed, as long as nothing of A's shows or changes.
    const onOwn = [`/meets/${b.meet}/`, `/requests/${b.request}/`, `/kit/${b.kit}`, `/members/${b.member}`].some((x) => p.startsWith(x)) || /^\/(members|updates|locations|kit\/read)$/.test(p);
    if (r.status < 400 && !onOwn) leaks.push(`${m} ${p} → ${r.status}`);
    if (/Truck A|Member A|Club A|Venue A/.test(txt)) leaks.push(`${m} ${p} shows A's data: ${txt.slice(0, 100)}`);
  }
  // B pointing at A's club from B's own member must not have attached it.
  const mb = await req('GET', `/api/host/members/${b.member}`, { cookie: B });
  assert.notEqual(mb.json.member.clubId, a.club, "A's club on B's member");
  // Two routes answer 200 to another host's id without changing anything (the UPDATE is scoped): misleading, not a leak.
  const noOp = leaks.filter((x) => /^(PUT \/requests\/|DELETE \/locations\/)/.test(x));
  if (noOp.length) console.log('note: 200 with no effect on another host’s id:', noOp.join(', '));
  assert.equal(await snap(), before, "A's rows unchanged");
  assert.deepEqual(leaks.filter((x) => !noOp.includes(x)), []);
  db.close();
});

/* ---------- XSS: what the server writes ---------- */
test('HTML in every field is escaped on the server-written pages', async () => {
  await req('PUT', '/api/host/settings', { cookie: A, body: { name: 'Tasty' + XSS, tagline: XSS, city: XSS, rules: XSS + '\n' + XSS, instagram: XSS } });
  const m = await req('POST', '/api/host/meets', { cookie: A, body: { day: ymd(5), start: '19:00', end: '22:00', place: 'P' + XSS, address: 'A' + XSS, title: 'T' + XSS, notes: XSS } });
  assert.equal(m.status, 201, m.text);
  const k = await req('POST', '/api/host/kit/entry', { cookie: A, body: { kind: 'vendor', name: 'V' + XSS, instagram: XSS } });
  await req('PUT', `/api/host/kit/${k.json.logo.id}/profile`, { cookie: A, body: { about: XSS, serves: XSS, signature: XSS, since: XSS, pageOn: true } });
  await req('POST', `/api/host/kit/${k.json.logo.id}/spots`, { cookie: A, body: { name: XSS, address: XSS, when: XSS } });
  await req('PUT', `/api/host/meets/${m.json.meet.id}/kit-vendors/${k.json.logo.id}`, { cookie: A, body: {} });
  await req('PUT', `/api/host/members/${a.member}`, { cookie: A, body: { name: XSS, car: XSS, mods: XSS + '\n' + XSS, about: XSS, instagram: XSS } });
  await req('PUT', `/api/host/members/${a.member}/photos/${a.photo}`, { cookie: A, body: { caption: XSS } });
  await req('POST', '/api/host/recaps', { cookie: A, body: { caption: XSS } });
  await req('PUT', `/api/host/meets/${m.json.meet.id}/lot`, { cookie: A, body: { lot: { lat: 33.5, lng: -112.1, zoom: 19, address: XSS, zones: [{ kind: 'club', label: XSS, color: 'red;}</style><script>alert(3)</script>', pts: [{ lat: 33.5001, lng: -112.1001 }, { lat: 33.5001, lng: -112.0999 }, { lat: 33.4999, lng: -112.0999 }] }], pins: [{ kind: 'info', label: XSS, lat: 33.5, lng: -112.1 }] } } });
  const prof = await req('GET', `/api/host/kit/${k.json.logo.id}/profile`, { cookie: A });
  const member = (await req('GET', `/api/host/members/${a.member}`, { cookie: A })).json.member;
  const pages = ['/', '/meets', '/members', '/vendors', '/tasty-tuesday', '/fuel-friday', new URL(m.json.meet.url).pathname, '/@' + member.handle, '/@' + member.handle + '/edit', prof.json.profile.previewUrl, '/privacy', '/vendors?host=tasty-tuesday'];
  const bad = [];
  for (const p of pages) {
    const r = await req('GET', p, { cookie: A });
    if (/<img src=x onerror|<script>alert/i.test(r.text)) bad.push(p);
  }
  assert.deepEqual(bad, [], 'unescaped markup on ' + bad.join(', '));
});

/* ---------- paths and uploads ---------- */
test('no path gets out of /static or /uploads, and a bad escape is a 400, not a 500', async () => {
  const probes = ['/static/../server.js', '/static/%2e%2e/server.js', '/static/..%2fserver.js', '/static/%2e%2e%2fserver.js', '/static/%252e%252e%252fserver.js', '/static/..%5cserver.js',
    '/uploads/../test.sqlite', '/uploads/..%2ftest.sqlite', '/uploads/%2e%2e%2ftest.sqlite', '/uploads/%2e%2e/%2e%2e/etc/passwd', '/food-photo/_/..%2f..%2fetc/passwd', '/food-photo/..%2f/x.png'];
  const got = [];
  for (const p of probes) {
    for (const ae of ['gzip, br', 'identity']) {
      const r = await req('GET', p, { headers: { 'Accept-Encoding': ae } });
      if (r.status === 200 && /require\(|SQLite format|root:/.test(r.buf.toString('latin1'))) got.push(`${p} (${ae}) → leaked`);
    }
  }
  assert.deepEqual(got, []);
  const bad = await req('GET', '/static/%E0%A4%A.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.notEqual(bad.status, 500, `malformed escape in /static → ${bad.status}`);
});

test('an upload must really be a picture: HTML or SVG named .png is refused; a polyglot stays a picture', async () => {
  for (const f of ['evil.html.png', 'evil.svg.png']) {
    const r = await req('POST', `/api/host/members/${a.member}/photos`, { headers: { 'x-member-key': a.key }, raw: { type: 'image/png', buf: fs.readFileSync(path.join(FIX, f)) } });
    assert.equal(r.status, 400, f + ' → ' + r.status);
  }
  // A real JPEG with a script in a comment block: kept as a JPEG, served as image/jpeg with nosniff.
  const jpg = fs.readFileSync(path.join(FIX, 'photo.jpg'));
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(2), Buffer.from('<html><script>alert(1)</script>')]); com.writeUInt16BE(com.length - 2, 2);
  const poly = Buffer.concat([jpg.subarray(0, 2), com, jpg.subarray(2)]);
  const r = await req('POST', `/api/host/members/${a.member}/photos`, { headers: { 'x-member-key': a.key }, raw: { type: 'image/jpeg', buf: poly } });
  assert.equal(r.status, 201);
  const url = r.json.member.photos.slice(-1)[0].url.replace(/\.s480\.webp$/, '.jpg');
  const g = await req('GET', url);
  assert.match(String(g.headers['content-type']), /^image\/jpeg/); assert.equal(g.headers['x-content-type-options'], 'nosniff');
});

test('a "JPEG bomb" (1.4 MB file, 16000×16000 pixels) is refused before ffmpeg decodes it (FINDING if this fails)', async () => {
  const r = await req('POST', `/api/host/members/${a.member}/photos`, { headers: { 'x-member-key': a.key }, raw: { type: 'image/jpeg', buf: fs.readFileSync(path.join(FIX, 'bomb.jpg')) } });
  assert.equal(r.status, 400, `accepted (${r.status}); its feed copy is then made by a full-size ffmpeg decode (see run-bomb.js for memory)`);
});

/* ---------- redirects and limits ---------- */
test('no open redirect: old meet-name subdomains, vendor subdomains, absolute-form and odd request lines', async () => {
  const raw = (line, hostH) => new Promise((ok) => {
    const u = new URL(ctx.base);
    const s = net.connect(+u.port, u.hostname, () => s.end(`${line}\r\nHost: ${hostH}\r\nConnection: close\r\n\r\n`));
    let b = ''; s.on('data', (d) => { b += d; }); s.on('end', () => ok(b)); s.on('error', () => ok(b));
  });
  const outs = [];
  for (const [line, hh] of [['GET //evil.test/ HTTP/1.1', 'fuel-friday.meets.test'], ['GET //evil.test/ HTTP/1.1', 'truck.meets.test'], ['GET http://evil.test/ HTTP/1.1', 'fuel-friday.meets.test'],
    ['GET /\\evil.test HTTP/1.1', 'truck.meets.test'], ['GET /%2f%2fevil.test HTTP/1.1', 'fuel-friday.meets.test'], ['GET /o?paid=' + 'a'.repeat(24) + '&x=//evil.test HTTP/1.1', SITE],
    ['GET /fuel-friday/' + ymd(3) + '//evil.test HTTP/1.1', SITE], ['GET /vendors?host=//evil.test HTTP/1.1', SITE]]) {
    const r = await raw(line, hh);
    const loc = (/\r\nlocation: ([^\r]*)/i.exec(r) || [])[1];
    if (loc) { const u = new URL(loc, 'http://meets.test'); if (!/(^|\.)meets\.test$/.test(u.hostname)) outs.push(`${line} @ ${hh} → ${loc}`); }
  }
  assert.deepEqual(outs, []);
});

test('links in emails use the site’s own address, not the Host header (FINDING if this fails)', async () => {
  // Behind Caddy's catch-all on-demand block, any Host header reaches the site once TLS is done for a real name.
  const r = await req('POST', '/api/alerts', { host: 'evil.test', body: { host: 'tasty-tuesday', email: 'victim@example.com' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(!String(r.json.devLink).includes('evil.test'), 'confirm link points at ' + r.json.devLink);
});

test('a crowd on one network (venue Wi-Fi, carrier NAT) can all sign up for alerts (FINDING if this fails)', async () => {
  let ok = 0, limited = 0;
  for (let i = 0; i < 40; i++) { const r = await req('POST', '/api/alerts', { body: { host: 'tasty-tuesday', email: `fan${i}@example.com` }, headers: { 'X-Forwarded-For': '172.58.10.10' } }); if (r.status === 429) limited++; else ok++; }
  assert.equal(limited, 0, `${limited} of 40 people on one address were refused (12 per 10 minutes per address)`);
});

test('vendor requests: 3 a day per address per host, the form limit, and a honeypot', async () => {
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await req('POST', '/api/vendor-request', { body: { host: 'west-side', name: 'Spam ' + i, contact: '1' }, headers: { 'X-Forwarded-For': '198.51.100.9' } })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const hp = await req('POST', '/api/vendor-request', { body: { host: 'west-side', name: 'Bot', contact: '1', website: 'x' }, headers: { 'X-Forwarded-For': '198.51.100.10' } });
  assert.equal(hp.status, 200);
});

/* ---------- proxy and admin ---------- */
test('CSRF: a write from another origin is refused; a bodyless write with no Origin is only possible outside a browser', async () => {
  const r = await req('POST', `/api/host/meets/${a.meet}/cancel`, { cookie: A, body: {}, headers: { Origin: 'https://evil.test' } });
  assert.equal(r.status, 403);
  const sub = await req('DELETE', `/api/host/kit/${a.kit}`, { cookie: A, headers: { Origin: 'https://truck.meets.test' } });
  assert.equal(sub.status, 403, 'a vendor subdomain (same site, cookie sent) is another origin');
});

test('/caddy/ask answers only Caddy itself, not a visitor whose request Caddy passed on (FINDING if this fails)', async () => {
  // Through Caddy every request comes from 127.0.0.1, with the visitor in X-Forwarded-For.
  const r = await req('GET', '/caddy/ask?domain=fuel-friday.meets.test', { headers: { 'X-Forwarded-For': '203.0.113.50' } });
  assert.equal(r.status, 404, 'a proxied visitor learns which names exist: ' + r.status);
});

test('X-Meet-* headers a visitor sends never reach the food side', async () => {
  const r = await req('GET', '/meet/mabcdef/truck/', { headers: { 'X-Meet-Proxy': 'forged', 'X-Meet-Origin': 'https://evil.test', 'X-Meet-Client-Ip': '1.1.1.1', 'X-Meet-Bg-Video': '/x', 'X-Meet-Back': '//evil.test', 'X-Forwarded-For': '9.9.9.9', Cookie: 'mh_session=' + 'ab'.repeat(24) + '; other=1' } });
  const got = r.json.headers;
  assert.notEqual(got['x-meet-proxy'], 'forged'); assert.equal(got['x-meet-origin'], 'http://meets.test'); assert.notEqual(got['x-meet-client-ip'], '1.1.1.1');
  assert.equal(got['x-meet-bg-video'], undefined); assert.equal(got['x-meet-back'], undefined); assert.ok(!/mh_session/.test(got.cookie || ''));
});

test('the admin call needs the token', async () => {
  assert.equal((await req('POST', '/api/host/admin/domain', { body: { slug: 'tasty-tuesday' }, headers: { 'x-admin-token': 'nope' } })).status, 404);
  assert.equal((await req('POST', '/api/host/admin/domain', { body: { slug: 'tasty-tuesday' } })).status, 404);
});

/* ---------- caching ---------- */
test('private answers are no-store and the service worker skips no-store pages', async () => {
  for (const p of ['/api/host/me', '/api/host/kit', '/api/host/meets', '/api/host/members', '/api/host/dashboard']) {
    const r = await req('GET', p, { cookie: A });
    assert.match(String(r.headers['cache-control']), /no-store/, p);
  }
  const sw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /no-store/);
  // The alert confirmation page (with its token in the address) has no Cache-Control: no-store, so the service worker keeps it.
  const conf = await req('POST', '/api/alerts', { body: { host: 'west-side', email: 'keep@example.com' }, headers: { 'X-Forwarded-For': '10.9.9.9' } });
  const yes = await req('GET', new URL(conf.json.devLink).pathname + new URL(conf.json.devLink).search);
  assert.match(String(yes.headers['cache-control'] || ''), /no-store/, '/alerts/yes?t=… is cacheable: ' + yes.headers['cache-control']);
});

test('client mistakes get 4xx, not 500: bad JSON, too-big body, unsatisfiable range (FINDING if this fails)', async () => {
  const bad = await req('POST', '/api/alerts', { raw: { type: 'application/json', buf: Buffer.from('{"host": "tasty-tuesday", ') } });
  const big = await req('POST', '/api/alerts', { raw: { type: 'application/json', buf: Buffer.from(JSON.stringify({ host: 'x', pad: 'x'.repeat(60 * 1024) })) } });
  const fs2 = require('node:fs');
  const up = require('node:path').join(require('node:path').dirname(ctx.dbFile), 'uploads');
  fs2.copyFileSync(require('node:path').join(FIX, 'loop.mp4'), require('node:path').join(up, 'bg-range-test.mp4'));
  const rng = await req('GET', '/uploads/bg-range-test.mp4', { headers: { Range: 'bytes=99999999-' } });
  assert.deepEqual([bad.status, big.status, rng.status], [400, 413, 416]);
});

test('reading logos from the logo sheet splitter accepts real-size pictures (FINDING if this fails)', async () => {
  // The route allows 20 MB, but the site-wide JSON limit (50 KB) runs first.
  const png = require('node:fs').readFileSync(path.join(FIX, 'photo.jpg')).toString('base64');
  const r = await req('POST', '/api/host/logo-read', { cookie: A, body: { files: [{ type: 'image/jpeg', data: png }] } });
  assert.notEqual(r.status, 413, `one ${Math.round(png.length / 1024)} KB logo → ${r.status} ${r.text.slice(0, 80)}`);
  assert.notEqual(r.status, 500, `one ${Math.round(png.length / 1024)} KB logo → ${r.status} ${r.text.slice(0, 80)}`);
});
