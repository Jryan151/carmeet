'use strict';
/* kitchen.js — the food side. Every truck, menu and pre-order lives in the ordering system behind KITCHEN_API; this
   file is the only place that talks to it, server to server, with MEET_PARTNER_KEY. Attendees never see that system:
   menus, photos, checkout returns and order emails all come through this site, under this site's name.
   Hosts get counts (trucks in, pre-orders paid), never a truck's money. */
const crypto = require('crypto');

const base = () => String(process.env.KITCHEN_API || '').replace(/\/+$/, '');
const key = () => String(process.env.MEET_PARTNER_KEY || '');
const on = () => !!(base() && key().length >= 24);

/** Calls the food side. Returns { ok, status, data }; never throws (status 0 = it didn't answer). */
async function call(method, p, body, ms) {
  if (!on()) return { ok: false, status: 0, data: { error: 'Food pre-orders aren’t set up on this site yet.' } };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 10000);
  try {
    const r = await fetch(base() + '/api/meets/partner' + p, {
      method, signal: ctrl.signal,
      headers: Object.assign({ 'x-meet-key': key() }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data: data || { error: 'The food side didn’t answer properly.' } };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'The food side isn’t answering right now. Try again in a minute.' } };
  } finally { clearTimeout(t); }
}

const tz = () => process.env.TIMEZONE || 'America/Phoenix';
/** Sends a meet's details (new, changed or canceled). The trucks in it follow automatically. */
function syncMeet(host, m, pageUrl) {
  return call('PUT', '/' + encodeURIComponent(m.ref), {
    pageUrl: /^https:\/\//.test(pageUrl || '') ? pageUrl : undefined, // the meet's page (a truck's post links here)
    hostKey: 'host_' + host.id, hostName: host.name, title: m.title || '', day: m.day, start: m.start_time, end: m.end_time,
    timezone: host.timezone || tz(), place: m.place, address: m.address || '', closeMinutes: host.close_minutes || 120,
    status: m.status === 'canceled' ? 'canceled' : 'on',
    theme: themeOf(host, m),
  });
}
/** How a truck's menu looks in meet mode: this host's background loop, logo, colors and fonts, and the way back. */
function themeOf(host, m) {
  const vid = m.video && m.video_status === 'ready' ? m : host.video && host.video_status === 'ready' ? host : null;
  const up = (f) => (f ? '/uploads/' + f : '');
  return {
    siteName: host.name,
    accent: /^#[0-9a-f]{6}$/i.test(host.accent || '') ? host.accent : '#c9adff',
    videoUrl: vid ? up(vid.video) : '', posterUrl: vid ? up(vid.video_poster) : '',
    logoUrl: m.logo ? '/uploads/' + m.logo : host.logo || '',
    backUrl: '/' + host.slug + '/' + m.day,
    fontsHref: 'https://fonts.googleapis.com/css2?family=Michroma&family=Instrument+Sans:wght@400;500;600&display=swap',
    fontDisplay: 'Michroma', fontBody: 'Instrument Sans',
  };
}
const meetVendors = (ref) => call('GET', '/' + encodeURIComponent(ref));
const inviteLink = (ref, slug) => call('POST', '/' + encodeURIComponent(ref) + '/invites', slug ? { slug } : {});
/* Truck profiles this host keeps on the food side (name, menu; no email or phone): one per Food vendor. */
const profiles = (hostKey) => call('GET', '/profiles?hostKey=' + encodeURIComponent(hostKey));
const createProfile = (hostKey, name, timezone) => call('POST', '/profiles', { hostKey, name, timezone });
const updateProfile = (hostKey, slug, fields) => call('PUT', '/profiles/' + encodeURIComponent(slug), Object.assign({ hostKey }, fields));
const profileMenuRead = (hostKey, slug, files) => call('POST', '/profiles/' + encodeURIComponent(slug) + '/menu-read', { hostKey, files }, 90000);
const profileMenu = (hostKey, slug, items) => call('PUT', '/profiles/' + encodeURIComponent(slug) + '/menu', { hostKey, items, mode: 'replace' });
/* The names on logos, and what each one is (food, club, another vendor), read by the food side's AI. */
const readLogos = (hostKey, files) => call('POST', '/logo-read', { hostKey, files }, 70000);
const addKnown = (ref, slug) => call('POST', '/' + encodeURIComponent(ref) + '/vendors', { slug });
const dropInvite = (ref, id) => call('DELETE', '/' + encodeURIComponent(ref) + '/invites/' + encodeURIComponent(id));
const notice = (ref, subject, text) => call('POST', '/' + encodeURIComponent(ref) + '/notice', { subject, text });
const menu = (ref, slug) => call('GET', '/' + encodeURIComponent(ref) + '/vendors/' + encodeURIComponent(slug) + '/menu');
const order = (ref, slug, body) => call('POST', '/' + encodeURIComponent(ref) + '/vendors/' + encodeURIComponent(slug) + '/orders', body);
const orderStatus = (token) => call('GET', '/orders/' + encodeURIComponent(token));
const confirmOrder = (token) => call('POST', '/orders/' + encodeURIComponent(token) + '/confirm', {});
const cancelOrder = (token) => call('POST', '/orders/' + encodeURIComponent(token) + '/cancel', {});

/** A notice from the food side is genuine only with the right signature over its exact body. */
function verify(rawBody, sig) {
  if (!on() || !sig || !Buffer.isBuffer(rawBody)) return false;
  const want = crypto.createHmac('sha256', key()).update(rawBody).digest('hex');
  const a = Buffer.from(want); const b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Menu photos come through this site as /food-photo/<truck>/<path>, so a page never names or links to the ordering
    system, not even inside an image address. These two turn a photo's address into that path and back. */
function photoPath(u) {
  try {
    const url = new URL(u); const k = new URL(base());
    if (url.protocol !== k.protocol) return null;
    const sub = url.host === k.host ? '_' : url.host.endsWith('.' + k.host) ? url.host.slice(0, -(k.host.length + 1)) : null;
    if (!sub || !/^[a-z0-9_-]{1,63}$/.test(sub) || !/^\/[A-Za-z0-9._\/-]{1,200}$/.test(url.pathname) || url.pathname.includes('..')) return null;
    return '/food-photo/' + sub + url.pathname;
  } catch (e) { return null; }
}
function photoSource(sub, rest) {
  if (!/^[a-z0-9_-]{1,63}$/.test(sub) || !/^\/[A-Za-z0-9._\/-]{1,200}$/.test(rest) || rest.includes('..')) return null;
  const k = new URL(base());
  return `${k.protocol}//${sub === '_' ? '' : sub + '.'}${k.host}${rest}`;
}

module.exports = { readLogos, themeOf, on, call, syncMeet, meetVendors, inviteLink, profiles, createProfile, updateProfile, profileMenuRead, profileMenu, addKnown, dropInvite, notice, menu, order, orderStatus, confirmOrder, cancelOrder, verify, photoPath, photoSource };
