'use strict';
/* geo.js — where the parking map's pictures and address search come from.

   Satellite tiles: MAP_TILES, a tile address with {z}, {x} and {y}. Phones load the tiles straight from there.
   Defaults to Esri's World Imagery, which needs its credit shown (MAP_CREDIT); check its terms for your use, or
   point MAP_TILES at another provider (Mapbox satellite with your token, MapTiler...), with that provider's credit.

   Address search: GEOCODER_URL, a Nominatim-style search (defaults to OpenStreetMap's public Nominatim, which asks
   for a real contact in each request and at most one search a second: fine for hosts placing a meet now and then).
   Answers are kept, so the same address is never asked twice. */
const U = require('./util');
const D = () => require('./db'); // only the search needs the database (pages that just show tiles don't)

const tiles = () => process.env.MAP_TILES || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const credit = () => process.env.MAP_CREDIT || (process.env.MAP_TILES ? '' : 'Imagery © Esri, Maxar, Earthstar Geographics');
const geocoder = () => process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';

let last = 0; // one search a second, at most
async function search(q) {
  const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = await D().get('SELECT json, at FROM geocache WHERE q = ?', [key]);
  if (hit && Date.now() - hit.at < 90 * 864e5) return { results: JSON.parse(hit.json) };
  const wait = last + 1100 - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  last = Date.now();
  const u = new URL(geocoder());
  u.searchParams.set('q', q); u.searchParams.set('format', 'jsonv2'); u.searchParams.set('limit', '5'); u.searchParams.set('addressdetails', '0');
  if (process.env.GEOCODER_COUNTRIES) u.searchParams.set('countrycodes', process.env.GEOCODER_COUNTRIES);
  if (process.env.SITE_OWNER_EMAIL) u.searchParams.set('email', process.env.SITE_OWNER_EMAIL);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': `${process.env.SITE_NAME || 'Meet Night'} (${process.env.SITE_DOMAIN || 'localhost'})`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { error: 'The address search isn’t answering right now. Try again in a minute.' };
    const list = await r.json();
    const results = (Array.isArray(list) ? list : []).map((x) => ({ lat: Number(x.lat), lng: Number(x.lon), label: U.clean(x.display_name, 160) }))
      .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lng)).slice(0, 5);
    await D().run('INSERT OR REPLACE INTO geocache (q, json, at) VALUES (?, ?, ?)', [key, JSON.stringify(results), Date.now()]);
    return { results };
  } catch (e) {
    return { error: 'The address search isn’t answering right now. Try again in a minute.' };
  }
}

module.exports = { tiles, credit, search };
