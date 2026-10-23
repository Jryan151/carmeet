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

/* ---------- parking shapes from OpenStreetMap (Overpass): lots, rows of spaces, single spaces, drive aisles ----------
   OVERPASS_URL (default the public Overpass API). Kept a week per spot, so a lot is asked about once. */
const overpass = () => process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const RADIUS = 260; // meters around the map's middle: the whole square at zoom 18, with room
/** One area or line: { id, type: 'lot' | 'space' | 'aisle', pts: [{ lat, lng }] }. */
function shapesFrom(data) {
  const out = []; const nodesOf = (g) => (Array.isArray(g) ? g : []).map((n) => ({ lat: +n.lat, lng: +n.lon })).filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lng));
  const area = (pts) => pts.length >= 4 && pts[0].lat === pts[pts.length - 1].lat && pts[0].lng === pts[pts.length - 1].lng ? pts.slice(0, -1) : pts;
  for (const el of (data && Array.isArray(data.elements) ? data.elements : [])) {
    const t = el.tags || {};
    if (el.type === 'way' && t.highway === 'service' && t.service === 'parking_aisle') {
      const pts = nodesOf(el.geometry); if (pts.length >= 2) out.push({ id: 'w' + el.id, type: 'aisle', pts: pts.slice(0, 200) });
    } else if (el.type === 'way' && (t.amenity === 'parking' || t.amenity === 'parking_space')) {
      const pts = area(nodesOf(el.geometry)); if (pts.length >= 3) out.push({ id: 'w' + el.id, type: t.amenity === 'parking_space' ? 'space' : 'lot', pts: pts.slice(0, 200) });
    } else if (el.type === 'relation' && t.amenity === 'parking') {
      // A lot drawn as a multipolygon: each outer ring is a lot.
      (el.members || []).filter((m) => m.role === 'outer' && m.type === 'way').forEach((m, i) => {
        const pts = area(nodesOf(m.geometry)); if (pts.length >= 3) out.push({ id: 'r' + el.id + '-' + i, type: 'lot', pts: pts.slice(0, 200) });
      });
    }
  }
  return out.slice(0, 600);
}
async function parking(lat, lng) {
  const key = 'osm:' + lat.toFixed(4) + ',' + lng.toFixed(4);
  const hit = await D().get('SELECT json, at FROM geocache WHERE q = ?', [key]);
  if (hit && Date.now() - hit.at < 7 * 864e5) return { shapes: JSON.parse(hit.json) };
  const around = `(around:${RADIUS},${lat},${lng})`;
  const q = `[out:json][timeout:20];(way["amenity"="parking"]${around};relation["amenity"="parking"]${around};way["amenity"="parking_space"]${around};way["highway"="service"]["service"="parking_aisle"]${around};);out geom;`;
  try {
    const r = await fetch(overpass(), { method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `${process.env.SITE_NAME || 'Meet Night'} (${process.env.SITE_DOMAIN || 'localhost'})` }, signal: AbortSignal.timeout(25000) });
    if (!r.ok) return { error: 'The map data isn’t answering right now. Try again in a minute, or draw with Box.' };
    const shapes = shapesFrom(await r.json());
    await D().run('INSERT OR REPLACE INTO geocache (q, json, at) VALUES (?, ?, ?)', [key, JSON.stringify(shapes), Date.now()]);
    return { shapes };
  } catch (e) {
    return { error: 'The map data isn’t answering right now. Try again in a minute, or draw with Box.' };
  }
}

module.exports = { tiles, credit, search, parking, shapesFrom };
