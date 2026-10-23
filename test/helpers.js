'use strict';
/* Test helpers: a private copy of the site (empty database, no email), and a stand-in for the food side that
   answers the partner API the way the real one does. Not a test file itself. */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const KEY = 'test-meet-key-0123456789abcdef';

/** The food side, in memory. `kitchen.state` can be changed by a test (a truck says yes, takes cards, a menu). */
function fakeKitchen() {
  const state = { meets: {}, invites: [], orders: {}, notices: [], calls: [], nextInvite: 1, menu: [
    { id: 1, name: 'Birria Tacos', description: 'Three, with consomé', price: 14, groups: [], photo: '/uploads/birria.jpg', category: 'Tacos' },
    { id: 2, name: 'Horchata', price: 4, groups: [], category: 'Drinks' },
  ] };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
      // Meet mode: echo what came through the proxy.
      if (req.url.startsWith('/meet/')) return send(res, 200, { url: req.url, method: req.method, headers: req.headers, raw });
      state.calls.push({ method: req.method, url: req.url, body });
      if (req.headers['x-meet-key'] !== KEY) return send(res, 401, { error: 'Wrong key.' });
      const p = req.url.replace(/^\/api\/meets\/partner/, '').split('/').filter(Boolean).map(decodeURIComponent);
      if (p[0] === 'orders') {
        const o = state.orders[p[1]];
        if (!o) return send(res, 404, { error: 'No such order.' });
        if (p[2] === 'cancel' && o.status === 'Pending') { o.status = 'Canceled'; o.payment = 'expired'; }
        return send(res, 200, o);
      }
      // The logo reader: names and kinds in turn from this list, one per logo sent.
      if (p[0] === 'logo-read') {
        const seen = [{ name: 'Unforsaken', kind: 'club' }, { name: 'México en un Vaso', kind: 'food' }, { name: 'LV Smoke Shop', kind: 'vendor' }, { name: '', kind: 'unknown' }];
        state.logoReads = (state.logoReads || 0) + 1;
        return send(res, 200, { logos: (body.files || []).map((_, i) => seen[i % seen.length]) });
      }
      // Truck profiles the host keeps (no email or phone): name, Instagram, menu.
      state.profiles = state.profiles || [];
      if (String(p[0] || '').split('?')[0] === 'profiles') {
        if (req.method === 'GET' && p.length === 1) return send(res, 200, { profiles: state.profiles.filter((x) => x.hostKey === new URL('http://x' + req.url).searchParams.get('hostKey')) });
        if (req.method === 'POST' && p.length === 1) { const pr = { hostKey: body.hostKey, slug: String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: body.name, items: 0, instagram: '' }; state.profiles.push(pr); return send(res, 201, { profile: pr }); }
        const pr = state.profiles.find((x) => x.slug === p[1] && x.hostKey === body.hostKey);
        if (!pr) return send(res, 404, { error: 'No such truck.' });
        if (req.method === 'PUT' && p.length === 2) { Object.assign(pr, body.name ? { name: body.name } : {}, body.instagram !== undefined ? { instagram: body.instagram } : {}); return send(res, 200, { profile: pr }); }
        if (p[2] === 'menu-read') { state.menuRead = body; return send(res, 200, { items: [{ name: 'Al pastor', price: 3.5 }] }); }
        if (p[2] === 'menu') { pr.items = (body.items || []).length; return send(res, 200, { added: pr.items }); }
      }
      const ref = p[0];
      const m = state.meets[ref];
      if (req.method === 'PUT' && p.length === 1) { if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(body.hostKey || ''))) return send(res, 400, { error: 'hostKey is missing.' }); if (!/^[A-Za-z0-9_-]{6,40}$/.test(ref)) return send(res, 400, { error: 'Bad meet ref.' }); state.meets[ref] = Object.assign({ vendors: [] }, m || {}, { body }); return send(res, 200, { meet: body }); }
      if (!m) return send(res, 404, { error: 'No such meet.' });
      if (req.method === 'GET' && p.length === 1) return send(res, 200, { meet: m.body, vendors: m.vendors });
      if (req.method === 'POST' && p[1] === 'invites') {
        const id = state.nextInvite++; const code = 'ABCD-' + String(1000 + id);
        const have = body.slug && m.vendors.find((x) => x.slug === body.slug && ['in', 'invited'].includes(x.status));
        if (have) return send(res, 200, { inviteId: have.inviteId, code, url: 'https://kitchen.test/meet-invite?c=' + code, status: have.status, signIn: have.status === 'in' });
        const pr = body.slug && state.profiles.find((x) => x.slug === body.slug);
        m.vendors.push(Object.assign({ inviteId: id, status: 'invited', code }, pr ? { slug: pr.slug, name: pr.name, hostProfile: true, setUp: false } : {}));
        return send(res, 201, { inviteId: id, code, url: 'https://kitchen.test/meet-invite?c=' + code, status: 'invited' });
      }
      if (req.method === 'POST' && p[1] === 'vendors' && p.length === 2) { m.vendors.push({ inviteId: state.nextInvite++, status: 'invited', slug: body.slug, name: body.slug }); return send(res, 201, { ok: true }); }
      if (req.method === 'DELETE' && p[1] === 'invites') { const v = m.vendors.find((x) => String(x.inviteId) === p[2]); if (v) v.status = 'removed'; return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && p[1] === 'notice') { state.notices.push(body); return send(res, 200, { sent: m.vendors.filter((v) => v.status === 'in').length }); }
      if (p[1] === 'vendors' && p[3] === 'menu') {
        const v = m.vendors.find((x) => x.slug === p[2] && x.status === 'in');
        if (!v) return send(res, 404, { error: 'That truck isn’t at this meet.' });
        return send(res, 200, { name: v.name, slug: v.slug, emoji: '', cardReady: !!v.cardReady, tips: { on: true, pcts: [15, 20] }, allergyOn: false,
          window: { opensAt: 0, closesAt: Date.now() + 864e5, open: !!v.cardReady }, slots: [{ at: 1900000000000, label: '7:00 PM', left: 8, full: false }], menu: state.menu.map((x) => Object.assign({}, x, x.photo ? { photo: 'http://' + req.headers.host + x.photo } : {})) });
      }
      if (req.method === 'POST' && p[1] === 'vendors' && p[3] === 'orders') {
        const v = m.vendors.find((x) => x.slug === p[2] && x.status === 'in');
        if (!v || !v.cardReady) return send(res, 409, { error: 'Not taking pre-orders.' });
        const token = crypto.randomBytes(12).toString('hex');
        const total = (body.items || []).reduce((s, l) => s + (state.menu.find((x) => x.id === l.id) || { price: 0 }).price * l.qty, 0);
        state.orders[token] = { token, ticket: 101 + Object.keys(state.orders).length, status: 'Pending', payment: 'pending', total, tipCents: 0, pickupAt: body.pickupAt, name: body.name,
          vendor: { slug: v.slug, name: v.name }, items: (body.items || []).map((l) => ({ name: (state.menu.find((x) => x.id === l.id) || {}).name, qty: l.qty, price: (state.menu.find((x) => x.id === l.id) || {}).price })) };
        state.lastOrderBody = body;
        return send(res, 201, Object.assign({}, state.orders[token], { checkoutUrl: 'https://checkout.stripe.test/' + token }));
      }
      send(res, 404, { error: 'Not handled in the fake.' });
    });
  });
  return { srv, state };
}

function startSite(test, extraEnv = {}) {
  const ctx = { base: '', child: null, tmp: null, kitchen: fakeKitchen() };
  let started; ctx.ready = new Promise((r) => { started = r; });
  test.before(async () => {
    ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carmeet-'));
    await new Promise((r) => ctx.kitchen.srv.listen(0, '127.0.0.1', r));
    const kport = ctx.kitchen.srv.address().port;
    const port = 42000 + Math.floor(Math.random() * 8000);
    ctx.base = `http://127.0.0.1:${port}`;
    ctx.dbFile = path.join(ctx.tmp, 'test.sqlite');
    const env = Object.assign({}, process.env, { PORT: String(port), DB_FILE: ctx.dbFile, UPLOAD_DIR: path.join(ctx.tmp, 'uploads'), SITE_DOMAIN: 'meets.test', SITE_NAME: 'Meet Night',
      PUBLIC_SCHEME: 'http', MEET_PARTNER_KEY: KEY, RESEND_API_KEY: '', MAIL_FROM: '', DEV_CODES: 'true', NODE_ENV: 'test',
      VIDEO_PRESET: 'veryfast', ADMIN_TOKEN: 'test-admin-token-0123456789', LINK_SECRET: 'test-link-secret-0123456789abcdef' }, extraEnv);
    env.KITCHEN_API = `http://127.0.0.1:${kport}`;
    ctx.kitchenBase = env.KITCHEN_API;
    ctx.child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: ctx.tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.child.stderr.on('data', (d) => { if (process.env.TEST_VERBOSE) process.stderr.write(d); });
    ctx.child.stdout.on('data', (d) => { if (process.env.TEST_VERBOSE) process.stdout.write(d); });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      try { const r = await send(ctx, 'GET', 'meets.test', '/health'); if (r.json && r.json.ok) { started(); return; } } catch (e) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('the site did not start');
  });
  test.after(() => { if (ctx.child) ctx.child.kill('SIGTERM'); ctx.kitchen.srv.close(); if (ctx.tmp) fs.rmSync(ctx.tmp, { recursive: true, force: true }); });
  return ctx;
}

async function request(ctx, method, host, urlPath, opts = {}) { await ctx.ready; return send(ctx, method, host, urlPath, opts); }
function send(ctx, method, host, urlPath, { body, cookie, headers, raw } = {}) {
  const u = new URL(ctx.base + urlPath);
  const data = raw ? raw.buf : body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false, // a fresh connection each time, like separate visitors
      headers: Object.assign({ Host: host }, data ? { 'Content-Type': raw ? raw.type : 'application/json', 'Content-Length': data.length, Origin: 'http://' + host } : {}, cookie ? { Cookie: cookie } : {}, headers || {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* html */ } resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString('utf8'), buf }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Signs a host up (email code → page name and address) and returns their cookie. */
async function host(ctx, { email = 'crew@example.com', name = 'Tasty Tuesday', slug = 'tasty-tuesday' } = {}) {
  const c = await request(ctx, 'POST', 'meets.test', '/api/host/code', { body: { email } });
  if (!c.json || !c.json.devCode) throw new Error('code: ' + c.text);
  const l = await request(ctx, 'POST', 'meets.test', '/api/host/login', { body: { email, code: c.json.devCode, name, slug, city: 'Phoenix' } });
  if (l.status !== 200) throw new Error('login: ' + l.text);
  return String([].concat(l.headers['set-cookie'] || [])[0] || '').split(';')[0];
}

const sign = (body) => crypto.createHmac('sha256', KEY).update(body).digest('hex');
module.exports = { startSite, request, host, sign, KEY };
