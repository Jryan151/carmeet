/* names.js — each meet name has its own address: Fuel Friday at fuel-friday.<site domain>, Tasty Tuesday at
   tasty-tuesday.<site domain>, whichever host runs them. The name comes from the meet's title (or the host's name
   when it has none) the first time it's saved, and stays put after that so shared links keep working; the host can
   change it in the meet's form. Weeks of the same meet share it (<name>.<domain>/<date>).

   A meet named like the host itself, on a host with their own domain turned on, stays on that domain. Without
   VENDOR_SUBDOMAINS=1 (no wildcard DNS yet) every meet stays at <site>/<host>/<date> as before. */
'use strict';
const { get, run } = require('./db');
const U = require('./util');

const domain = () => String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
const scheme = () => process.env.PUBLIC_SCHEME || 'https';

/** The names that mean "the host's own page" (their address, and their name as an address). */
const homeNames = (h) => new Set([h.slug, U.pageSlugFrom(h.name)].filter(Boolean));

/** Whether a meet lives at its name's address (rather than on the host's page). */
function onName(h, m) {
  if (!U.subdomainsOn() || !m || !m.page_name) return false;
  if (h.domain_on && h.custom_domain && homeNames(h).has(m.page_name)) return false;
  return true;
}
/** Where a meet's page is. */
function meetUrl(h, m) {
  if (onName(h, m)) return `${scheme()}://${m.page_name}.${domain()}/${m.day}`;
  return `${hostUrl(h)}/${m.day}`;
}
/** The front of a meet name's address (it shows the next one), or the host's page. */
function nameUrl(h, m) {
  return onName(h, m) ? `${scheme()}://${m.page_name}.${domain()}` : hostUrl(h);
}
const hostUrl = (h) => (h.domain_on && h.custom_domain ? `${scheme()}://${h.custom_domain}` : `${scheme()}://${domain()}/${h.slug}`);

/** Whether an address is free for this host's meet name: no other host's meet, no vendor page, nothing reserved. */
async function free(hostId, s) {
  if (!U.pageSlugOk(s)) return false;
  if (await get('SELECT 1 AS x FROM meets WHERE page_name = ? AND host_id != ?', [s, hostId])) return false;
  if (await get('SELECT 1 AS x FROM kit_logos WHERE page_slug = ?', [s])) return false;
  if (await get('SELECT 1 AS x FROM kit_old_slugs WHERE slug = ?', [s])) return false;
  return true;
}
async function firstFree(hostId, base) {
  for (let i = 1; i < 50; i++) {
    const s = i === 1 ? base : base.slice(0, 36) + '-' + i;
    if (await free(hostId, s)) return s;
  }
  return null;
}

/** After a meet is saved: the name asked for (checked), else the one it has, else the one another week of the same
    meet uses, else one made from its title. Returns { name } or { error }. */
async function ensure(h, m, wanted) {
  if (wanted !== undefined && wanted !== null && wanted !== '') {
    const s = String(wanted).trim().toLowerCase().replace(/\.[a-z0-9.-]*$/, '');
    if (s === m.page_name) return { name: s };
    if (!U.pageSlugOk(s)) return { error: 'Use letters, numbers and dashes for the page address (3 to 40).' };
    if (!(await free(h.id, s))) return { error: `${s}.${domain()} is taken. Try another.` };
    await run('UPDATE meets SET page_name = ? WHERE id = ?', [s, m.id]);
    m.page_name = s;
    return { name: s };
  }
  if (m.page_name) return { name: m.page_name };
  const title = (m.title || '').trim() || h.name;
  const same = await get("SELECT page_name FROM meets WHERE host_id = ? AND page_name IS NOT NULL AND lower(trim(COALESCE(NULLIF(title, ''), ?))) = lower(?) ORDER BY day DESC LIMIT 1", [h.id, h.name, title]);
  const s = same ? same.page_name : await firstFree(h.id, U.pageSlugFrom(title));
  if (!s) return { name: null };
  await run('UPDATE meets SET page_name = ? WHERE id = ?', [s, m.id]);
  m.page_name = s;
  return { name: s };
}

/** The host whose meet name an address is ("fuel-friday" → the host running Fuel Friday), or null. */
async function hostOfName(sub) {
  if (!U.SLUG_RE.test(String(sub || ''))) return null;
  const row = await get('SELECT host_id FROM meets WHERE page_name = ? ORDER BY day DESC LIMIT 1', [sub]);
  return row ? get('SELECT * FROM hosts WHERE id = ?', [row.host_id]) : null;
}

module.exports = { homeNames, onName, meetUrl, nameUrl, hostUrl, free, ensure, hostOfName };
