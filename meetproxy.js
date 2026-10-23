'use strict';
/* meetproxy.js — "meet mode": a truck's real menu and order tracker, served by the food side but shown on this site.
   Everything under /meet/* is passed straight through to the food side on the same server, so people ordering at a
   meet never leave this site's address. The food side only answers /meet/* when the proxy header is right, and it
   takes the public address and the customer's IP from the headers below (never from the customer). */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const target = () => new URL(process.env.KITCHEN_LOCAL || process.env.KITCHEN_API || 'http://127.0.0.1:3000');
const secret = () => crypto.createHmac('sha256', String(process.env.MEET_PARTNER_KEY || '')).update('meet-proxy').digest('hex');
const on = () => String(process.env.MEET_PARTNER_KEY || '').length >= 24;

// Headers never passed on: the customer can't set the proxy ones, and this site's own sign-in stays here.
const DROP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'x-meet-proxy', 'x-meet-origin', 'x-meet-client-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']);
const OWN_COOKIES = /^(mh_session|mn_[a-z_]*)$/;

function cookiesFor(h) {
  const kept = String(h || '').split(';').map((s) => s.trim()).filter((c) => c && !OWN_COOKIES.test(c.split('=')[0]));
  return kept.join('; ');
}

function middleware(scheme) {
  return (req, res, next) => {
    if (!on()) return next();
    const t = target();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
    const ck = cookiesFor(req.headers.cookie);
    if (ck) headers.cookie = ck; else delete headers.cookie;
    headers.host = t.host;
    headers['x-meet-proxy'] = secret();
    headers['x-meet-origin'] = `${scheme}://${req.get('host')}`;
    headers['x-meet-client-ip'] = req.ip || '';
    const lib = t.protocol === 'https:' ? https : http;
    const up = lib.request({ protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      method: req.method, path: req.originalUrl, headers, agent: false }, (r) => {
      const out = Object.assign({}, r.headers);
      delete out.connection; delete out['keep-alive']; delete out['transfer-encoding'];
      res.writeHead(r.statusCode || 502, out);
      r.pipe(res);
    });
    up.setTimeout(0);
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.status(502).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#07060b;color:#eee;font:16px system-ui;padding:40px;text-align:center">The menu isn’t loading right now. Try again in a minute.</body>');
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  };
}

module.exports = { middleware, secret, on, cookiesFor };
