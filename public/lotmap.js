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

  /** The smallest turned rectangle around some points ({ x, y }), from their convex hull: { pts, area }. */
  function boxAround(points) {
    var p = points.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    var cross = function (o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); };
    var lo = [], hi = [], i;
    for (i = 0; i < p.length; i++) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop(); lo.push(p[i]); }
    for (i = p.length - 1; i >= 0; i--) { while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p[i]) <= 0) hi.pop(); hi.push(p[i]); }
    var hull = lo.slice(0, -1).concat(hi.slice(0, -1)), best = null;
    for (i = 0; i < hull.length; i++) {
      var a = hull[i], b = hull[(i + 1) % hull.length], len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!len) continue;
      var ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
      hull.forEach(function (q) { var s = q.x * ux + q.y * uy, t = -q.x * uy + q.y * ux; if (s < s0) s0 = s; if (s > s1) s1 = s; if (t < t0) t0 = t; if (t > t1) t1 = t; });
      var area = (s1 - s0) * (t1 - t0);
      if (!best || area < best.area) {
        var at = function (s, t) { return { x: s * ux - t * uy, y: s * uy + t * ux }; };
        best = { area: area, pts: [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)] };
      }
    }
    return best;
  }
  /** Fewer corners, same outline (an open or closed list of { x, y }), at most `max` (keeps loosening until it fits). */
  function simplify(pts, eps, max) {
    function rdp(list, e) {
      if (list.length < 3) return list;
      var a = list[0], b = list[list.length - 1], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, far = 0, at = 0;
      for (var i = 1; i < list.length - 1; i++) {
        var d = Math.abs(dy * list[i].x - dx * list[i].y + b.x * a.y - b.y * a.x) / len;
        if (d > far) { far = d; at = i; }
      }
      if (far <= e) return [a, b];
      return rdp(list.slice(0, at + 1), e).slice(0, -1).concat(rdp(list.slice(at), e));
    }
    var out = pts, e = eps;
    while (true) { // split the loop in half so both halves simplify well
      var h = Math.floor(pts.length / 2);
      out = pts.length > 4 ? rdp(pts.slice(0, h + 1), e).slice(0, -1).concat(rdp(pts.slice(h).concat([pts[0]]), e).slice(0, -1)) : pts;
      if (!max || out.length <= max || e > 1e6) return out;
      e *= 1.6;
    }
  }
  /** Groups shapes (lists of { x, y }) that touch: corners within `gap` of each other. Returns lists of indexes. */
  function touching(shapes, gap) {
    var parent = shapes.map(function (_, i) { return i; });
    var root = function (i) { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    for (var i = 0; i < shapes.length; i++) for (var j = i + 1; j < shapes.length; j++) {
      if (root(i) === root(j)) continue;
      var near = shapes[i].some(function (a) { return shapes[j].some(function (b) { return Math.abs(a.x - b.x) <= gap && Math.abs(a.y - b.y) <= gap; }); });
      if (near) parent[root(i)] = root(j);
    }
    var groups = {};
    shapes.forEach(function (_, i) { (groups[root(i)] = groups[root(i)] || []).push(i); });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }
  /** Whether a point is inside an outline ({ x, y } lists). */
  function inside(pt, poly) {
    for (var i = 0, j = poly.length - 1, c = false; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
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
      // A "club" zone named after one of the kinds (Parking, Overflow, Vendors...) is that kind, in that kind's
      // color; any other zone left in the club color takes its kind's own. Each kind reads at a glance.
      var label = text(z.label, 30), kind = z.kind;
      if (kind === 'club') {
        var named = Object.keys(ZONES).filter(function (k) { return k !== 'club' && ZONES[k].toLowerCase() === label.toLowerCase(); })[0];
        if (named) kind = named;
      }
      if (kind !== 'club' && color === KIND_COLOR.club) color = KIND_COLOR[kind];
      out.zones.push({ kind: kind, label: label, color: color, pts: pts });
    });
    (Array.isArray(v.pins) ? v.pins : []).slice(0, 20).forEach(function (p) {
      var at = pt(p);
      if (at && PINS[p.kind]) out.pins.push({ kind: p.kind, label: text(p.label, 24), lat: at.lat, lng: at.lng });
    });
    return out;
  }

  var api = { FRAME: FRAME, TILE: TILE, MIN_Z: MIN_Z, MAX_Z: MAX_Z, ZONES: ZONES, PINS: PINS, KIND_COLOR: KIND_COLOR, PALETTE: PALETTE, PIN_COLOR: PIN_COLOR,
    toPx: toPx, toLatLng: toLatLng, frame: frame, inFrame: inFrame, tileUrl: tileUrl, middle: middle, clean: clean,
    boxAround: boxAround, simplify: simplify, touching: touching, inside: inside };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.LotMap = api;
})(this);
