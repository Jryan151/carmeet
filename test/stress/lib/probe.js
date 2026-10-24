'use strict';
/* probe.js — preloaded into the server under test (NODE_OPTIONS=--require test/stress/lib/probe.js), never into
   production. Measures the server from the inside without touching app code:
   - event loop delay (perf_hooks histogram, reset on each read) and utilisation
   - RSS / heap / external memory, open file descriptors, active handles
   - errors the app logs (console.error), counted by kind (SQLITE_BUSY, "Error:", slow requests)
   - on demand (/maps): the size of every Map and Set alive in the heap (inspector queryObjects), so unbounded
     in-memory caches show up in a soak without knowing their variable names.
   Answers on 127.0.0.1:$PROBE_PORT. */
const http = require('http');
const fs = require('fs');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

// Email in tests: requests meant for Resend go to a local stand-in (FAKE_RESEND=http://127.0.0.1:port), so the
// cost of sending (and a slow or hung mail provider) can be measured without sending anything.
if (process.env.FAKE_RESEND && typeof global.fetch === 'function') {
  const realFetch = global.fetch;
  global.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : input && input.url;
    if (u && u.startsWith('https://api.resend.com/')) return realFetch(process.env.FAKE_RESEND + u.slice('https://api.resend.com'.length), init);
    return realFetch(input, init);
  };
}

const port = parseInt(process.env.PROBE_PORT, 10);
if (port) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let elu = performance.eventLoopUtilization();
  const counts = { sqliteBusy: 0, errors: 0, slow: 0, lines: [] };
  const origErr = console.error, origLog = console.log;
  const tally = (args) => {
    const s = args.map((a) => (a && a.stack) || String(a)).join(' ');
    if (/SQLITE_BUSY|database is locked/i.test(s)) counts.sqliteBusy++;
    if (/^Error:|\bError\b/.test(s)) counts.errors++;
    if (/^slow:/.test(s)) counts.slow++;
    counts.lines.push(s.slice(0, 400)); if (counts.lines.length > 200) counts.lines.shift();
  };
  console.error = (...a) => { tally(a); origErr.apply(console, a); };
  console.log = (...a) => { if (/^slow:/.test(String(a[0]))) tally(a); origLog.apply(console, a); };
  process.on('uncaughtException', (e) => { counts.uncaught = (counts.uncaught || 0) + 1; counts.lines.push('UNCAUGHT ' + (e && e.stack)); origErr('UNCAUGHT', e); });
  process.on('unhandledRejection', (e) => { counts.unhandled = (counts.unhandled || 0) + 1; counts.lines.push('UNHANDLED ' + (e && e.stack)); });

  const fds = () => { try { return fs.readdirSync('/proc/self/fd').length; } catch (e) { return -1; } };
  function snap(reset) {
    const m = process.memoryUsage();
    const e2 = performance.eventLoopUtilization(elu);
    const out = {
      t: Date.now(), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers,
      lag: { p50: h.percentile(50) / 1e6, p99: h.percentile(99) / 1e6, max: h.max / 1e6, mean: h.mean / 1e6 },
      elu: e2.utilization, fds: fds(), handles: process._getActiveHandles().length, requests: process._getActiveRequests().length,
      sqliteBusy: counts.sqliteBusy, errors: counts.errors, slow: counts.slow, uncaught: counts.uncaught || 0, unhandled: counts.unhandled || 0,
    };
    if (reset) { h.reset(); elu = performance.eventLoopUtilization(); }
    return out;
  }
  let session = null;
  function mapSizes(cb) {
    try {
      if (!session) { const inspector = require('inspector'); session = new inspector.Session(); session.connect(); }
      const post = (m, p) => new Promise((ok, no) => session.post(m, p || {}, (e, r) => (e ? no(e) : ok(r))));
      (async () => {
        const out = {};
        for (const kind of ['Map', 'Set']) {
          const proto = await post('Runtime.evaluate', { expression: kind + '.prototype' });
          const q = await post('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
          // Sizes of every instance, largest first (a function runs on the array inside the heap).
          const r = await post('Runtime.callFunctionOn', { objectId: q.objects.objectId, returnByValue: true,
            functionDeclaration: 'function(){ return this.map(function(m){ var k = []; try { var it = m.keys(); for (var i = 0; i < 2; i++) { var n = it.next(); if (n.done) break; k.push(String(n.value).slice(0, 60)); } } catch (e) {} return [m.size, k.join(" | ")]; }).filter(function(x){return x[0] >= 20;}).sort(function(a,b){return b[0]-a[0];}).slice(0, 25); }' });
          out[kind] = r.result.value;
          await post('Runtime.releaseObject', { objectId: q.objects.objectId }).catch(() => {});
        }
        cb(null, out);
      })().catch((e) => cb(e));
    } catch (e) { cb(e); }
  }
  // A CPU profile of the next N ms, summarised as self time per function (top 40) and per file.
  function profile(ms, cb) {
    try {
      if (!session) { const inspector = require('inspector'); session = new inspector.Session(); session.connect(); }
      session.post('Profiler.enable', () => session.post('Profiler.setSamplingInterval', { interval: 200 }, () => session.post('Profiler.start', () => {
        setTimeout(() => session.post('Profiler.stop', (e, r) => {
          if (e) return cb(e);
          const p = r.profile; const self = new Map(); const byId = new Map(p.nodes.map((n) => [n.id, n]));
          const counts = new Map(); for (const s of p.samples) counts.set(s, (counts.get(s) || 0) + 1);
          const total = p.samples.length;
          const files = new Map();
          for (const [id, c] of counts) {
            const n = byId.get(id); const f = n.callFrame;
            const k = `${f.functionName || '(anon)'} ${String(f.url).replace(/^.*\/(carmeet|node_modules)\//, '$1/')}:${f.lineNumber + 1}`;
            self.set(k, (self.get(k) || 0) + c);
            const file = String(f.url).replace(/^.*\/(carmeet|node_modules)\//, '$1/') || '(native)';
            files.set(file, (files.get(file) || 0) + c);
          }
          // Inclusive time for app functions: walk parents.
          const parent = new Map(); for (const n of p.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
          const incl = new Map();
          for (const [id, c] of counts) {
            const seen = new Set();
            for (let x = id; x !== undefined; x = parent.get(x)) {
              const f = byId.get(x).callFrame; if (!/carmeet\/(?!node_modules)/.test(f.url)) continue;
              const k = `${f.functionName || '(anon)'} ${String(f.url).replace(/^.*\/carmeet\//, '')}:${f.lineNumber + 1}`;
              if (seen.has(k)) continue; seen.add(k); incl.set(k, (incl.get(k) || 0) + c);
            }
          }
          const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => [k, +(c / total * 100).toFixed(1)]);
          cb(null, { samples: total, selfTop: top(self, 40), files: top(files, 25), appInclusive: top(incl, 40) });
        }), ms);
      })));
    } catch (e) { cb(e); }
  }
  http.createServer((req, res) => {
    if (req.url.startsWith('/profile')) { const ms = parseInt(new URL('http://x' + req.url).searchParams.get('ms'), 10) || 5000; return profile(ms, (e, o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(e ? { error: String(e) } : o)); }); }
    if (req.url.startsWith('/maps')) return mapSizes((e, o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(e ? { error: String(e) } : o)); });
    if (req.url.startsWith('/lines')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(counts.lines)); }
    if (req.url.startsWith('/gc') && global.gc) global.gc();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(snap(req.url.includes('reset'))));
  }).listen(port, '127.0.0.1').unref();
}
