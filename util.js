'use strict';
/* util.js — small shared helpers: times on the host's clock, checks for what people type. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,180}\.[a-z]{2,24}$/i;
const RESERVED = new Set(['host', 'api', 'o', 'hooks', 'food-photo', 'uploads', 'alerts', 'static', 'admin', 'login', 'about', 'help', 'privacy', 'terms', 'site', 'www', 'meets', 'meet', 'members', 'vendors', 'clubs']);

const zone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return 'America/Phoenix'; } };
/** The parts of an instant on a clock: { y, m, d, h, min, wd }. */
function parts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone(tz), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
/** The instant a wall-clock time happens on a clock (two passes handle daylight saving edges). */
function zonedTime(y, m, d, h, mi, tz) {
  let t = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = parts(t, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    t += Date.UTC(y, m - 1, d, h, mi) - asUtc;
  }
  return t;
}
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (ms, tz) => { const p = parts(ms, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
function addDays(key, n) { const [y, m, d] = key.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
function validDate(s) {
  if (!DATE_RE.test(String(s))) return false;
  const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/** A meet's start and end instants. An end at or before the start runs past midnight. */
function meetTimes(m, tz) {
  const at = (k, hm) => { const [y, mo, d] = k.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return zonedTime(y, mo, d, h, mi, tz); };
  const startsAt = at(m.day, m.start_time);
  const endsAt = m.end_time > m.start_time ? at(m.day, m.end_time) : at(addDays(m.day, 1), m.end_time);
  return { startsAt, endsAt };
}
const fmt = (ms, tz, opts) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: zone(tz) }, opts)).format(new Date(ms));
const time12 = (ms, tz) => fmt(ms, tz, { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
const dayLong = (ms, tz) => fmt(ms, tz, { weekday: 'long', month: 'long', day: 'numeric' });
const dayShort = (ms, tz) => fmt(ms, tz, { weekday: 'short', month: 'short', day: 'numeric' });

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanBlock = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function handle(s) { const h = clean(s, 60).replace(/^https?:\/\/(www\.)?(instagram|tiktok|youtube)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, ''); return /^[A-Za-z0-9._-]{1,40}$/.test(h) ? h : ''; }
function videoUrl(s) {
  const u = clean(s, 300);
  try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)(youtube\.com|youtu\.be|instagram\.com|tiktok\.com|vimeo\.com)$/i.test(x.hostname) ? x.href : ''; } catch (e) { return ''; }
}
const ACCENTS = ['#c9adff', '#f2a33a', '#e8e4d8', '#5fb3d9', '#e0574f', '#7cc47f', '#c792ea'];

/* ---------- a Food vendor's profile address: /v/<slug> on the site, or <slug>.<site domain> ---------- */
// Names a vendor's address can never be: the site's own paths, and subdomains a server or mail setup uses.
const PAGE_RESERVED = new Set([...RESERVED, 'v', 'www', 'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'ns1', 'ns2', 'mx', 'cdn', 'assets', 'img',
  'status', 'support', 'blog', 'shop', 'app', 'dev', 'test', 'staging', 'portal', 'dashboard', 'webmail', 'autoconfig', 'autodiscover', 'caddy']);
const pageSlugOk = (s) => SLUG_RE.test(String(s || '')) && !PAGE_RESERVED.has(String(s)) && !String(s).includes('--');
/** A page address from a truck's name: "Tacos El Rey!" → "tacos-el-rey". */
function pageSlugFrom(name) {
  const s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 40).replace(/-+$/, '');
  return s.length >= 3 ? s : (s + '-food').replace(/^-/, '').slice(0, 40);
}
const subdomainsOn = () => process.env.VENDOR_SUBDOMAINS === '1';
/** Where a vendor's profile lives. With subdomains on, its own address; else a path on whichever site is showing. */
function vendorUrl(slug, { absolute } = {}) {
  const domain = String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
  const scheme = process.env.PUBLIC_SCHEME || 'https';
  if (subdomainsOn()) return `${scheme}://${slug}.${domain}/`;
  return (absolute ? `${scheme}://${domain}` : '') + '/v/' + slug;
}
/** The vendor subdomain a host name is for ("tacos-el-rey.azmonarchy.com" → "tacos-el-rey"), or null. */
function subOf(hostname) {
  const h = String(hostname || '').toLowerCase();
  const domain = String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
  if (!h.endsWith('.' + domain)) return null;
  const sub = h.slice(0, -(domain.length + 1));
  return sub && sub !== 'www' && SLUG_RE.test(sub) ? sub : null;
}

module.exports = { PAGE_RESERVED, pageSlugOk, pageSlugFrom, vendorUrl, subOf, subdomainsOn, DATE_RE, TIME_RE, SLUG_RE, EMAIL_RE, RESERVED, zone, parts, zonedTime, dayKey, addDays, validDate, meetTimes, time12, dayLong, dayShort, fmt, clean, cleanBlock, esc, handle, videoUrl, ACCENTS };
