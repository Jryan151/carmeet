/* names.js — each meet name has its own address on the site: Fuel Friday at <site>/fuel-friday, whichever host runs
   it. The name comes from the meet's title (or the host's name when it has none) the first time it's saved, and
   stays put after that so shared links keep working; the host can change it in the meet's form. Weeks of the same
   meet share it (<site>/fuel-friday/<date>). A meet named like the host itself is the host's own page
   (<site>/<host>, or their own domain). Old fuel-friday.<site> links forward here. */
'use strict';
const { get, run } = require('./db');
const U = require('./util');

const domain = () => String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
const scheme = () => process.env.PUBLIC_SCHEME || 'https';

/** The names that mean "the host's own page" (their address, and their name as an address). */
const homeNames = (h) => new Set([h.slug, U.pageSlugFrom(h.name)].filter(Boolean));

/** Whether a meet lives at its name's address (rather than on the host's page). */
function onName(h, m) {
  return !!(m && m.page_name && !homeNames(h).has(m.page_name));
}
/** Where a meet's page is. */
function meetUrl(h, m) {
  if (onName(h, m)) return `${scheme()}://${domain()}/${m.page_name}/${m.day}`;
  return `${hostUrl(h)}/${m.day}`;
}
/** The front of a meet name's address (it shows the next one), or the host's page. */
function nameUrl(h, m) {
  return onName(h, m) ? `${scheme()}://${domain()}/${m.page_name}` : hostUrl(h);
}
const hostUrl = (h) => (h.domain_on && h.custom_domain ? `${scheme()}://${h.custom_domain}` : `${scheme()}://${domain()}/${h.slug}`);

/** Whether an address is free for this host's meet name: no other host's meet, no vendor page, nothing reserved. */
async function free(hostId, s) {
  if (!U.pageSlugOk(s)) return false;
  if (await get('SELECT 1 AS x FROM meets WHERE page_name = ? AND host_id != ?', [s, hostId])) return false;
  if (await get('SELECT 1 AS x FROM meet_old_names WHERE name = ? AND host_id != ?', [s, hostId])) return false;
  if (await get('SELECT 1 AS x FROM hosts WHERE slug = ? AND id != ?', [s, hostId])) return false; // another host's page
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

/* The name is set only if, at that same moment, no other host has it (nor a vendor page or an old address of theirs)
   and no other meet of this host has it that day: one statement, so two saves at once can't both get it. */
const TAKEN = `EXISTS (SELECT 1 FROM meets x WHERE x.page_name = ?1 AND (x.host_id != ?2 OR (x.day = ?3 AND x.id != ?4)))
  OR EXISTS (SELECT 1 FROM hosts WHERE slug = ?1 AND id != ?2) OR EXISTS (SELECT 1 FROM kit_logos WHERE page_slug = ?1)
  OR EXISTS (SELECT 1 FROM kit_old_slugs WHERE slug = ?1) OR EXISTS (SELECT 1 FROM meet_old_names WHERE name = ?1 AND host_id != ?2)`;
async function claim(h, m, s) {
  const r = await run(`UPDATE meets SET page_name = ?1 WHERE id = ?4 AND NOT (${TAKEN})`, { 1: s, 2: h.id, 3: m.day, 4: m.id });
  return r.changes > 0;
}
/** After a meet is saved: the name asked for (checked), else the one it has, else the one another week of the same
    meet uses, else one made from its title. Returns { name } or { error }. A new name for a meet that had one moves
    its other weeks too, and the old address keeps working (meet_old_names). */
async function ensure(h, m, wanted) {
  if (wanted !== undefined && wanted !== null && wanted !== '') {
    const s = String(wanted).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^[a-z0-9.-]*\.[a-z]{2,}\//, '').replace(/^\/+|\/+$/g, '');
    if (s === m.page_name) return { name: s };
    if (!U.pageSlugOk(s)) return { error: 'Use letters, numbers and dashes for the page address (3 to 40).' };
    if (!(await free(h.id, s)) || !(await claim(h, m, s))) return { error: `${domain()}/${s} is taken. Try another.` };
    const old = m.page_name;
    if (old && old !== s && !homeNames(h).has(old)) {
      // Every week of it moves (not just this one), and the old address is kept, pointing at the new one.
      await run('UPDATE meets SET page_name = ? WHERE host_id = ? AND page_name = ?', [s, h.id, old]);
      await run('INSERT OR REPLACE INTO meet_old_names (name, host_id, page_name, created_at) VALUES (?, ?, ?, ?)', [old, h.id, s, Date.now()]);
      await run('UPDATE meet_old_names SET page_name = ? WHERE host_id = ? AND page_name = ?', [s, h.id, old]);
      await run('DELETE FROM meet_old_names WHERE name = ?', [s]);
    }
    m.page_name = s;
    return { name: s };
  }
  if (m.page_name) return { name: m.page_name };
  const title = (m.title || '').trim() || h.name;
  const same = await get("SELECT page_name FROM meets WHERE host_id = ? AND page_name IS NOT NULL AND lower(trim(COALESCE(NULLIF(title, ''), ?))) = lower(?) ORDER BY day DESC LIMIT 1", [h.id, h.name, title]);
  let s = same ? same.page_name : await firstFree(h.id, U.pageSlugFrom(title));
  if (!s) return { name: null };
  if (!(await claim(h, m, s))) { s = await firstFree(h.id, U.pageSlugFrom(title) + '-' + m.day.slice(5)); if (!s || !(await claim(h, m, s))) return { name: null }; }
  m.page_name = s;
  return { name: s };
}

/** Where an old meet-name address points now ({ host_id, page_name }), or null. */
const movedName = (s) => (U.SLUG_RE.test(String(s || '')) ? get('SELECT host_id, page_name FROM meet_old_names WHERE name = ?', [s]) : Promise.resolve(null));
/** The host whose meet name an address is ("fuel-friday" → the host running Fuel Friday), or null. */
async function hostOfName(sub) {
  if (!U.SLUG_RE.test(String(sub || ''))) return null;
  const row = await get('SELECT host_id FROM meets WHERE page_name = ? ORDER BY day DESC LIMIT 1', [sub]);
  return row ? get('SELECT * FROM hosts WHERE id = ?', [row.host_id]) : null;
}

module.exports = { homeNames, onName, meetUrl, nameUrl, hostUrl, free, ensure, hostOfName, movedName };
