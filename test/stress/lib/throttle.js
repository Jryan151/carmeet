'use strict';
/* throttle.js — one phone's weak signal, as a TCP proxy in front of the site: a round trip of `rttMs`, a shared
   downlink of `bps` bytes/s for every connection (one phone, one radio), and some connections dropped mid-transfer.
   Modes switch at any time: 'ok' (no shaping), 'weak', 'offline' (refused at once), 'blackhole' (accepted, silent).
   rules(path) can add per-request behaviour: { extraMs, stallAfter } (stop sending after N bytes of that answer). */
const net = require('net');

function throttle({ target, rttMs = 700, bps = 40 * 1024, dropRate = 0.02, rules = () => null } = {}) {
  const st = { mode: 'weak', rttMs, bps, dropRate, rules, conns: new Set(), stats: { conns: 0, dropped: 0, bytesDown: 0 } };
  const pending = []; // { conn, buf, at }, in arrival order per connection
  let tokens = 0;
  const TICK = 25;
  const MSS = 1460;
  let rr = 0; // round robin over connections, the way TCP flows share one radio
  const timer = setInterval(() => {
    if (st.mode === 'ok') { while (pending.length) { const p = pending.shift(); if (!p.conn.client.destroyed) p.conn.client.write(p.buf); } return; }
    tokens = Math.min(st.bps / 4, tokens + st.bps * TICK / 1000);
    const now = Date.now();
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].conn.client.destroyed) pending.splice(i, 1);
    let progress = true;
    while (tokens >= 1 && progress) {
      progress = false;
      const conns = [...new Set(pending.filter((p) => p.at <= now && !p.conn.stalled).map((p) => p.conn))];
      if (!conns.length) break;
      for (let k = 0; k < conns.length && tokens >= 1; k++) {
        const conn = conns[(rr + k) % conns.length];
        const idx = pending.findIndex((p) => p.conn === conn);
        if (idx < 0) continue;
        const p = pending[idx];
        const n = Math.min(p.buf.length, MSS, Math.floor(tokens));
        if (conn.stallAfter != null && conn.sentForReq + n > conn.stallAfter) { conn.stalled = true; continue; }
        const part = p.buf.subarray(0, n);
        conn.sent += n; conn.sentForReq += n; st.stats.bytesDown += n; tokens -= n; progress = true;
        conn.client.write(part);
        if (n === p.buf.length) pending.splice(idx, 1); else p.buf = p.buf.subarray(n);
        if (conn.dropAt != null && conn.sent >= conn.dropAt) { st.stats.dropped++; conn.client.destroy(); conn.up.destroy(); }
      }
      rr++;
    }
  }, TICK);
  timer.unref();
  const server = net.createServer((client) => {
    st.stats.conns++;
    if (st.mode === 'offline') return client.destroy();
    const conn = { client, sent: 0, sentForReq: 0, stalled: false, stallAfter: null, dropAt: null, path: '' };
    if (st.mode === 'blackhole') { client.on('error', () => {}); return; }
    if (Math.random() < st.dropRate && st.mode === 'weak') conn.dropAt = 2000 + Math.floor(Math.random() * 60000);
    const up = net.connect(target.port, target.host || '127.0.0.1');
    conn.up = up;
    st.conns.add(conn);
    const half = () => (st.mode === 'ok' ? 0 : st.rttMs / 2);
    client.on('data', (d) => {
      const m = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) (\S+)/.exec(d.toString('latin1', 0, 300));
      let extra = 0;
      if (m) {
        conn.path = m[2]; conn.sentForReq = 0; conn.stalled = false; conn.stallAfter = null;
        const r = st.rules(conn.path, st.mode) || {};
        if (r.stallAfter != null) conn.stallAfter = r.stallAfter;
        extra = r.extraMs || 0;
      }
      setTimeout(() => { if (!up.destroyed) up.write(d); }, half() + extra);
    });
    up.on('data', (d) => pending.push({ conn, buf: d, at: Date.now() + half() }));
    const end = () => { st.conns.delete(conn); client.destroy(); up.destroy(); };
    client.on('error', end); up.on('error', end); client.on('close', end);
    up.on('end', () => { const wait = () => (pending.some((p) => p.conn === conn) ? setTimeout(wait, 50) : client.end()); wait(); });
  });
  st.listen = () => new Promise((ok) => server.listen(0, '127.0.0.1', () => { st.port = server.address().port; ok(st); }));
  st.close = () => { clearInterval(timer); for (const c of st.conns) { c.client.destroy(); c.up.destroy(); } server.close(); };
  st.kickAll = () => { for (const c of st.conns) { c.client.destroy(); c.up.destroy(); } };
  return st;
}
module.exports = { throttle };
