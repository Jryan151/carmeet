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
  'x-meet-proxy', 'x-meet-origin', 'x-meet-client-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'x-meet-bg-video', 'x-meet-bg-poster', 'x-meet-back']);

/* A truck's menu page plays that vendor's own clip when their profile has one (and on their own address, its back
   link goes to their profile). Only the page itself asks: /meet/<ref>/<slug>/ and its order tracker. */
const PAGE_RE = /^\/meet\/([A-Za-z0-9_-]{4,40})\/([a-z0-9-]{1,40})\/(?:o\/[A-Za-z0-9]{8,64})?(?:\?.*)?$/;
async function vendorLook(req) {
  const m = req.method === 'GET' && PAGE_RE.exec(req.originalUrl);
  if (!m) return null;
  try {
    const D = require('./db');
    const k = await D.get(`SELECT k.video, k.video_poster, k.video_status, k.page_slug, k.page_on FROM kit_logos k JOIN meets mt ON mt.host_id = k.host_id
      WHERE mt.ref = ? AND k.truck_slug = ? AND k.kind IN ('vendor', 'sponsor') LIMIT 1`, [m[1], m[2]]);
    if (!k) return null;
    const out = {};
    if (k.video && k.video_status === 'ready') { out.video = '/uploads/' + k.video; out.poster = '/uploads/' + k.video_poster; }
    // On the vendor's own address, "back" is their profile.
    if (req.vendorSub && k.page_on && k.page_slug === req.vendorSub) out.back = '/';
    return Object.keys(out).length ? out : null;
  } catch (e) { return null; }
}
const OWN_COOKIES = /^(mh_session|mn_[a-z_]*)$/;

function cookiesFor(h) {
  const kept = String(h || '').split(';').map((s) => s.trim()).filter((c) => c && !OWN_COOKIES.test(c.split('=')[0]));
  return kept.join('; ');
}

function middleware(scheme) {
  return async (req, res, next) => {
    if (!on()) return next();
    // Which vendor address this is, if any (the site's own check runs after this proxy).
    req.vendorSub = req.vendorSub || require('./util').subOf(req.hostname);
    const look = await vendorLook(req);
    const t = target();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
    const ck = cookiesFor(req.headers.cookie);
    if (ck) headers.cookie = ck; else delete headers.cookie;
    headers.host = t.host;
    headers['x-meet-proxy'] = secret();
    headers['x-meet-origin'] = `${scheme}://${req.get('host')}`;
    headers['x-meet-client-ip'] = req.ip || '';
    if (look && look.video) { headers['x-meet-bg-video'] = look.video; headers['x-meet-bg-poster'] = look.poster; }
    if (look && look.back) headers['x-meet-back'] = look.back;
    const lib = t.protocol === 'https:' ? https : http;
    const up = lib.request({ protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      method: req.method, path: req.originalUrl, headers, agent: false }, (r) => {
      const out = Object.assign({}, r.headers);
      delete out.connection; delete out['keep-alive']; delete out['transfer-encoding'];
      res.writeHead(r.statusCode || 502, out);
      r.pipe(res);
    });
    // A menu that hasn't started answering in 15 s won't: the phone gets the "not loading" page instead of a spinner
    // that never ends (and the connection is let go).
    up.setTimeout(15000, () => up.destroy(new Error('the food side took too long')));
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.status(502).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#07060b;color:#eee;font:16px system-ui;padding:40px;text-align:center">The menu isn’t loading right now. Try again in a minute.</body>');
    });
    req.on('aborted', () => up.destroy());
    req.pipe(up);
  };
}

module.exports = { middleware, secret, on, cookiesFor, PAGE_RE };
