/* lotmap.js — the parking map's shared parts, used by the server (to write the page) and by the portal's editor.
   A layout is a spot on the satellite map (its center and zoom) plus zones drawn on it (club parking, vendors,
   overflow...) and pins (entrances, exits...), all kept as latitude and longitude so they stay put at any zoom.
   The map is a square FRAME pixels wide at its zoom, built from the standard 256-pixel satellite tiles. */
(function (root) {
  'use strict';
  var FRAME = 640, TILE = 256, MIN_Z = 15, MAX_Z = 20;
  var ZONES = { club: 'Club parking', vendors: 'Vendors', parking: 'Parking', show: 'Car show', overflow: 'Overflow', nopark: 'No parking' };
  var PINS = { enter: 'Enter', exit: 'Exit', food: 'Food', spot: 'The meet', info: 'Info' };
  // Colors a zone can take (the first is each kind's own); bright enough to read over asphalt at night.
  var KIND_COLOR = { club: '#c084fc', vendors: '#f472b6', parking: '#4ade80', show: '#fbbf24', overflow: '#60a5fa', nopark: '#f87171' };
  var PALETTE = ['#4ade80', '#60a5fa', '#c084fc', '#f472b6', '#fbbf24', '#f87171', '#2dd4bf', '#fb923c', '#e5e7eb'];
  var PIN_COLOR = { enter: '#ffd23f', exit: '#fb923c', food: '#f9a8d4', spot: '#c9adff', info: '#e5e7eb' };

  /** A place's position in pixels on the whole world map at zoom z (Web Mercator, like every satellite map). */
  function toPx(lat, lng, z) {
    var n = TILE * Math.pow(2, z), s = Math.sin(lat * Math.PI / 180);
    s = Math.min(Math.max(s, -0.9999), 0.9999);
    return { x: (lng + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function toLatLng(x, y, z) {
    var n = TILE * Math.pow(2, z);
    var lng = x / n * 360 - 180;
    var lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
    return { lat: lat, lng: lng };
  }
  /** The frame's corner on the world map, and the tiles that cover it (with where each sits, in frame pixels). */
  function frame(lot) {
    var c = toPx(lot.lat, lot.lng, lot.zoom);
    var ox = c.x - FRAME / 2, oy = c.y - FRAME / 2, max = Math.pow(2, lot.zoom);
    var tiles = [];
    for (var ty = Math.floor(oy / TILE); ty <= Math.floor((oy + FRAME - 1) / TILE); ty++) {
      for (var tx = Math.floor(ox / TILE); tx <= Math.floor((ox + FRAME - 1) / TILE); tx++) {
        if (ty < 0 || ty >= max) continue;
        tiles.push({ x: ((tx % max) + max) % max, y: ty, z: lot.zoom, left: tx * TILE - ox, top: ty * TILE - oy });
      }
    }
    return { ox: ox, oy: oy, tiles: tiles };
  }
  /** Where a place falls in the frame, in frame pixels. */
  function inFrame(lot, f, lat, lng) { var p = toPx(lat, lng, lot.zoom); return { x: p.x - f.ox, y: p.y - f.oy }; }
  function tileUrl(tpl, t) { return String(tpl).replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y); }
  /** A zone's middle (the center of its outline's area), for its label. */
  function middle(pts) {
    var a = 0, cx = 0, cy = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length], k = p.x * q.y - q.x * p.y;
      a += k; cx += (p.x + q.x) * k; cy += (p.y + q.y) * k;
    }
    if (Math.abs(a) < 1e-9) { var sx = 0, sy = 0; pts.forEach(function (p) { sx += p.x; sy += p.y; }); return { x: sx / pts.length, y: sy / pts.length }; }
    return { x: cx / (3 * a), y: cy / (3 * a) };
  }

  var num = function (v) { return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; };
  var text = function (s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); };
  var near = function (lot, lat, lng) { return Math.abs(lat - lot.lat) < 0.05 && Math.abs(lng - lot.lng) < 0.05; }; // about 5 km
  /** A layout as saved: everything checked, anything that doesn't fit dropped. null when there's no usable spot. */
  function clean(v) {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
    if (!v || typeof v !== 'object') return null;
    var lat = num(v.lat), lng = num(v.lng), zoom = Math.round(num(v.zoom));
    if (!isFinite(lat) || !isFinite(lng) || lat < -85 || lat > 85 || lng < -180 || lng > 180) return null;
    var out = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, zoom: isFinite(zoom) ? Math.min(MAX_Z, Math.max(MIN_Z, zoom)) : 18,
      address: text(v.address, 120), zones: [], pins: [] };
    var pt = function (p) { var a = num(p && p.lat), b = num(p && p.lng); return isFinite(a) && isFinite(b) && near(out, a, b) ? { lat: Math.round(a * 1e7) / 1e7, lng: Math.round(b * 1e7) / 1e7 } : null; };
    (Array.isArray(v.zones) ? v.zones : []).slice(0, 30).forEach(function (z) {
      if (!z || !ZONES[z.kind] || !Array.isArray(z.pts)) return;
      var pts = z.pts.slice(0, 30).map(pt).filter(Boolean);
      if (pts.length < 3) return;
      var want = String(z.color || '').toLowerCase();
      var color = PALETTE.indexOf(want) >= 0 || Object.keys(KIND_COLOR).some(function (k) { return KIND_COLOR[k] === want; }) ? want : KIND_COLOR[z.kind];
      out.zones.push({ kind: z.kind, label: text(z.label, 30), color: color, pts: pts });
    });
    (Array.isArray(v.pins) ? v.pins : []).slice(0, 20).forEach(function (p) {
      var at = pt(p);
      if (at && PINS[p.kind]) out.pins.push({ kind: p.kind, label: text(p.label, 24), lat: at.lat, lng: at.lng });
    });
    return out;
  }

  var api = { FRAME: FRAME, TILE: TILE, MIN_Z: MIN_Z, MAX_Z: MAX_Z, ZONES: ZONES, PINS: PINS, KIND_COLOR: KIND_COLOR, PALETTE: PALETTE, PIN_COLOR: PIN_COLOR,
    toPx: toPx, toLatLng: toLatLng, frame: frame, inFrame: inFrame, tileUrl: tileUrl, middle: middle, clean: clean };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.LotMap = api;
})(this);
