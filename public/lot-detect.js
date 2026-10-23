/* lot-detect.js — reads a marked-up lot picture (the kind hosts already post: rows painted green or blue, yellow
   ENTER tags) and finds the painted areas and the entrances, in the picture's own pixels.
   Painted green → Parking, blue → Overflow, yellow tags → Enter pins. A legend box (a painted label sitting on a
   light roof, like "Parking / Overflow") is skipped. Runs in the browser on a small copy of the picture. */
(function (root) {
  'use strict';
  var W = 320; // the picture is read at this width

  function classify(r, g, b) {
    if (r > 195 && g > 180 && b < 120 && Math.abs(r - g) < 70) return 3;                 // yellow tag
    if (g > 130 && g > r * 1.25 && g > b * 1.25) return 1;                                // painted green
    if (b > 140 && b > r * 1.5 && b > g * 1.1) return 2;                                  // painted blue
    return 0;
  }
  /** Fills one-pixel gaps (the white stall lines inside a painted row) so a row reads as one area. */
  function close(mask, w, h) {
    var dil = new Uint8Array(w * h), out = new Uint8Array(w * h), x, y, i;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      dil[i] = mask[i] || (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w]) ? 1 : 0;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      out[i] = dil[i] && (x === 0 || dil[i - 1]) && (x === w - 1 || dil[i + 1]) && (y === 0 || dil[i - w]) && (y === h - 1 || dil[i + w]) ? 1 : 0;
    }
    return out;
  }
  /** Areas of touching pixels in a mask: each { cells: [index...], x0, y0, x1, y1 }. */
  function areas(mask, w, h) {
    var seen = new Uint8Array(w * h), out = [], stack = [];
    for (var s = 0; s < w * h; s++) {
      if (!mask[s] || seen[s]) continue;
      var a = { cells: [], x0: w, y0: h, x1: 0, y1: 0 };
      stack.push(s); seen[s] = 1;
      while (stack.length) {
        var i = stack.pop(), x = i % w, y = (i - x) / w;
        a.cells.push(i);
        if (x < a.x0) a.x0 = x; if (x > a.x1) a.x1 = x; if (y < a.y0) a.y0 = y; if (y > a.y1) a.y1 = y;
        var n = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (var k = 0; k < 4; k++) if (n[k] >= 0 && mask[n[k]] && !seen[n[k]]) { seen[n[k]] = 1; stack.push(n[k]); }
      }
      out.push(a);
    }
    return out;
  }
  /** The outline of an area: the edges of its cells chained into loops; the longest loop is the outside. */
  function outline(a, w) {
    var inA = {}; a.cells.forEach(function (i) { inA[i] = 1; });
    var next = {}; // start corner "x,y" → end corner, walking with the area on the right
    a.cells.forEach(function (i) {
      var x = i % w, y = (i - x) / w;
      if (!inA[i - w] || y === 0) next[x + ',' + y] = (x + 1) + ',' + y;              // top edge, left to right
      if (!inA[i + 1] || x === w - 1) next[(x + 1) + ',' + y] = (x + 1) + ',' + (y + 1); // right edge, down
      if (!inA[i + w]) next[(x + 1) + ',' + (y + 1)] = x + ',' + (y + 1);              // bottom edge, right to left
      if (!inA[i - 1] || x === 0) next[x + ',' + (y + 1)] = x + ',' + y;               // left edge, up
    });
    var best = [], used = {};
    Object.keys(next).forEach(function (k0) {
      if (used[k0]) return;
      var loop = [], k = k0, guard = 0;
      while (k && !used[k] && guard++ < 100000) { used[k] = 1; var p = k.split(','); loop.push({ x: +p[0], y: +p[1] }); k = next[k]; }
      if (loop.length > best.length) best = loop;
    });
    return best;
  }
  /** Fewer points, same shape (Ramer–Douglas–Peucker, closed loop). */
  function simplify(pts, eps) {
    if (pts.length < 4) return pts;
    function rdp(list) {
      if (list.length < 3) return list;
      var a = list[0], b = list[list.length - 1], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, far = 0, at = 0;
      for (var i = 1; i < list.length - 1; i++) {
        var d = Math.abs(dy * list[i].x - dx * list[i].y + b.x * a.y - b.y * a.x) / len;
        if (d > far) { far = d; at = i; }
      }
      if (far <= eps) return [a, b];
      var l = rdp(list.slice(0, at + 1)), r = rdp(list.slice(at));
      return l.slice(0, -1).concat(r);
    }
    // Split the loop at its two farthest-apart points, so both halves simplify well.
    var i0 = 0, i1 = 0, far = -1;
    for (var i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 60))) {
      for (var j = i + 1; j < pts.length; j += Math.max(1, Math.floor(pts.length / 60))) {
        var d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y); if (d > far) { far = d; i0 = i; i1 = j; }
      }
    }
    var one = rdp(pts.slice(i0, i1 + 1)), two = rdp(pts.slice(i1).concat(pts.slice(0, i0 + 1)));
    return one.slice(0, -1).concat(two.slice(0, -1));
  }

  /** The smallest turned rectangle around some points (from their convex hull), and its area. */
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

  /** Reads the picture. Returns { zones: [{ kind, pts: [{u, v}] }], pins: [{ kind, u, v }] } in the picture's pixels. */
  function detect(img) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var w = W, h = Math.max(1, Math.round(W * ih / iw)), k = iw / w;
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    var cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, w, h);
    var px = cx.getImageData(0, 0, w, h).data;
    var cls = new Uint8Array(w * h), lum = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) { var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2]; cls[i] = classify(r, g, b); lum[i] = 0.3 * r + 0.59 * g + 0.11 * b; }
    var out = { zones: [], pins: [] }, minZone = w * h * 0.0012;
    // Bright all around (a light roof): a legend or a sign, not a lot.
    var ring = function (a) {
      var s = 0, n = 0, pad = 3;
      for (var y = Math.max(0, a.y0 - pad); y <= Math.min(h - 1, a.y1 + pad); y++) for (var x = Math.max(0, a.x0 - pad); x <= Math.min(w - 1, a.x1 + pad); x++) {
        if (x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1) continue;
        s += lum[y * w + x]; n++;
      }
      return n ? s / n : 0;
    };
    [[1, 'parking'], [2, 'overflow']].forEach(function (c) {
      var mask = new Uint8Array(w * h); for (var i2 = 0; i2 < w * h; i2++) mask[i2] = cls[i2] === c[0] ? 1 : 0;
      areas(close(mask, w, h), w, h).forEach(function (a) {
        if (a.cells.length < minZone || ring(a) > 165) return;
        var edge = outline(a, w), pts;
        // A row that fills most of its box (cars and trees only nick it): the clean box. Else (an L around a
        // building, say) its own outline, simplified.
        var bx = boxAround(edge);
        if (bx && a.cells.length / bx.area > 0.74) pts = bx.pts;
        else pts = simplify(edge, 1.6);
        if (pts.length < 3 || pts.length > 30) return;
        out.zones.push({ kind: c[1], pts: pts.map(function (p) { return { u: p.x * k, v: p.y * k }; }) });
      });
    });
    var ymask = new Uint8Array(w * h); for (var j = 0; j < w * h; j++) ymask[j] = cls[j] === 3 ? 1 : 0;
    areas(close(ymask, w, h), w, h).forEach(function (a) {
      if (a.cells.length < w * h * 0.0006) return;
      out.pins.push({ kind: 'enter', u: (a.x0 + a.x1 + 1) / 2 * k, v: (a.y0 + a.y1 + 1) / 2 * k });
    });
    out.zones.sort(function (a, b) { return a.pts[0].v - b.pts[0].v || a.pts[0].u - b.pts[0].u; });
    return out;
  }

  var api = { detect: detect, classify: classify };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.LotDetect = api;
})(this);
