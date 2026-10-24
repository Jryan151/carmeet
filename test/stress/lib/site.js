'use strict';
/* site.js — a private copy of the site for stress runs. Reuses test/helpers.js (temp SQLite database, the food side's
   stand-in) and adds: the probe preloaded into the server, pinning to CPUs, and a food side that can be made slow,
   hung, broken, garbled or unreachable on demand. */
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const H = require('../../helpers');

const PROBE = path.join(__dirname, 'probe.js');

/** The food side's behaviour, switched by the test: ok (with latency), hang (ms), 500, garbage, reset, refused. */
function faultable(kitchen) {
  const srv = kitchen.srv;
  const real = srv.listeners('request')[0];
  srv.removeAllListeners('request');
  const fault = { mode: 'ok', latency: 15, hangMs: 30000, calls: 0, byMode: {} };
  srv.on('request', (req, res) => {
    fault.calls++;
    fault.byMode[fault.mode] = (fault.byMode[fault.mode] || 0) + 1;
    const pass = () => real(req, res);
    switch (fault.mode) {
      case 'hang': return void setTimeout(pass, fault.hangMs);
      case '500': req.resume(); return void setTimeout(() => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); }, fault.latency);
      case 'html500': req.resume(); return void setTimeout(() => { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>Bad gateway</html>'); }, fault.latency);
      case 'garbage': req.resume(); return void setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"vendors": [ {"slug": "x", "na'); }, fault.latency);
      case 'wrongshape': req.resume(); return void setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"vendors":"nope","logos":7,"profiles":{"a":1}}'); }, fault.latency);
      case 'reset': req.socket.destroy(); return;
      default: return void setTimeout(pass, fault.latency);
    }
  });
  let port = null;
  fault.refuse = () => new Promise((ok) => { port = srv.address().port; srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => ok()); });
  fault.restore = () => new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
  return fault;
}

/**
 * Starts a site. opts: { env, cpus: '0,1', probePort, label }
 * Returns ctx (helpers' ctx plus: pid, probe(), fault, stop()).
 */
async function start(opts = {}) {
  const hooks = { before: [], after: [] };
  const fake = { before: (fn) => hooks.before.push(fn), after: (fn) => hooks.after.push(fn) };
  const probePort = opts.probePort || 39000 + Math.floor(Math.random() * 900);
  const env = Object.assign({
    NODE_OPTIONS: `--require ${PROBE}`, PROBE_PORT: String(probePort), VIDEO_PRESET: 'medium', MEET_MODE: '0',
  }, opts.env || {});
  const ctx = H.startSite(fake, env);
  ctx.fault = faultable(ctx.kitchen);
  for (const fn of hooks.before) await fn();
  ctx.pid = ctx.child.pid;
  ctx.log = [];
  ctx.child.stdout.on('data', (d) => { ctx.log.push(String(d)); if (ctx.log.length > 2000) ctx.log.shift(); });
  ctx.child.stderr.on('data', (d) => { ctx.log.push(String(d)); if (ctx.log.length > 2000) ctx.log.shift(); });
  if (opts.cpus) { try { execFileSync('taskset', ['-a', '-pc', opts.cpus, String(ctx.pid)], { stdio: 'ignore' }); } catch (e) { /* not fatal */ } }
  ctx.probePort = probePort;
  ctx.probe = (p = '/', ms = 10000) => getJson(`http://127.0.0.1:${probePort}${p}`, ms);
  ctx.stop = async () => {
    // Let the server (and any ffmpeg it started) go first, so the temp folder isn't removed under a write.
    if (ctx.child.exitCode === null) { const gone = new Promise((r) => ctx.child.once('exit', r)); ctx.child.kill('SIGTERM'); await Promise.race([gone, sleep(5000)]); }
    try { execFileSync('pkill', ['-f', path.dirname(ctx.dbFile)], { stdio: 'ignore' }); } catch (e) { /* none left */ }
    for (const fn of hooks.after) { try { await fn(); } catch (e) { try { fs.rmSync(path.dirname(ctx.dbFile), { recursive: true, force: true, maxRetries: 5 }); } catch (e2) { /* leave it */ } } }
  };
  ctx.kill = (sig = 'SIGKILL') => ctx.child.kill(sig);
  /** Stops the server (the way pm2 restart does: SIGTERM, or SIGKILL for a crash) and starts it again on the same
      database, uploads and port, as test/helpers.js would. */
  ctx.restart = async (sig = 'SIGTERM') => {
    const gone = new Promise((r) => ctx.child.once('exit', r));
    ctx.child.kill(sig); await gone;
    const { spawn } = require('node:child_process');
    const tmp = path.dirname(ctx.dbFile);
    const env2 = Object.assign({}, process.env, { PORT: ctx.port, DB_FILE: ctx.dbFile, UPLOAD_DIR: path.join(tmp, 'uploads'), SITE_DOMAIN: 'meets.test', SITE_NAME: 'Meet Night',
      PUBLIC_SCHEME: 'http', MEET_PARTNER_KEY: H.KEY, RESEND_API_KEY: '', MAIL_FROM: '', DEV_CODES: 'true', NODE_ENV: 'test',
      ADMIN_TOKEN: 'test-admin-token-0123456789', LINK_SECRET: 'test-link-secret-0123456789abcdef', KITCHEN_API: ctx.kitchenBase }, env);
    ctx.child = spawn(process.execPath, [path.join(__dirname, '..', '..', '..', 'server.js')], { cwd: tmp, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.child.stdout.on('data', (d) => ctx.log.push(String(d)));
    ctx.child.stderr.on('data', (d) => ctx.log.push(String(d)));
    ctx.pid = ctx.child.pid;
    if (opts.cpus) { try { execFileSync('taskset', ['-a', '-pc', opts.cpus, String(ctx.pid)], { stdio: 'ignore' }); } catch (e) { /* not fatal */ } }
    for (let i = 0; i < 100; i++) { const r = await req(ctx, 'GET', '/health', { timeout: 1000 }); if (r.status === 200) return; await sleep(150); }
    throw new Error('the site did not come back');
  };
  ctx.port = new URL(ctx.base).port;
  return ctx;
}

function getJson(url, ms = 10000) {
  return new Promise((ok, no) => {
    const r = http.get(url, { agent: false, timeout: ms }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { no(e); } }); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', no);
  });
}

/** One request with full control (keep-alive off), timing it. */
function req(ctx, method, urlPath, { host = 'meets.test', body, cookie, headers, raw, timeout = 60000 } = {}) {
  const u = new URL(ctx.base + urlPath);
  const data = raw ? raw.buf : body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const t0 = process.hrtime.bigint();
  return new Promise((ok) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: false, timeout,
      headers: Object.assign({ Host: host }, data ? { 'Content-Type': raw ? raw.type : 'application/json', 'Content-Length': data.length } : {}, cookie ? { Cookie: cookie } : {}, headers || {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
        ok({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
      });
      res.on('error', (e) => ok({ status: 0, error: e.code || e.message, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('client timeout'), { code: 'CLIENT_TIMEOUT' })));
    r.on('error', (e) => ok({ status: 0, error: e.code || e.message, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    if (data) r.write(data);
    r.end();
  });
}

/** Signs a host in (email code) and returns the session cookie. */
async function signIn(ctx, { email, name, slug }) {
  const c = await req(ctx, 'POST', '/api/host/code', { body: { email } });
  if (!c.json || !c.json.devCode) throw new Error('code: ' + c.text);
  const l = await req(ctx, 'POST', '/api/host/login', { body: { email, code: c.json.devCode, name, slug, city: 'Phoenix' } });
  if (l.status !== 200) throw new Error('login: ' + l.text);
  return String([].concat(l.headers['set-cookie'] || [])[0] || '').split(';')[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(arr, p) { if (!arr.length) return 0; const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; }
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

module.exports = { start, req, signIn, sleep, pct, writeJson, getJson, faultable, H };
