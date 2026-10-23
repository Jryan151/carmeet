/* lot-editor.js — the host's parking map editor (portal › Meets › a meet › Parking map), made for a phone.
   Type the address, pick the match, and the satellite view opens there, with the parking already on the map
   (OpenStreetMap: lots, single spaces, drive aisles) outlined. Then:
   - Select: tap a row or space, or swipe across several; a sheet comes up to make them Club parking (which club),
     Vendors, Parking, Car show, Overflow or No parking. Single spaces next to each other become one row.
   - Box: drag across a row to box it (it snaps to the spaces under it); tap a box to turn, drag, copy or remove it.
   - Pin: Enter, Exit, Food... tap where it goes.
   - Move: drag to slide. Two fingers pinch to zoom and slide, in any mode. Undo takes back the last change.
   Every change saves itself. The layout is kept in latitude and longitude (lotmap.js), so it stays put at any zoom. */
(function () {
  'use strict';
  var L = window.LotMap;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pc = function (v) { return (v / L.FRAME * 100).toFixed(3) + '%'; };

  function mount(box, o) {
    var meet = o.meet, api = o.api;
    var lot = meet.lot ? JSON.parse(JSON.stringify(meet.lot)) : null;
    var mode = lot ? 'select' : 'move', zoneKind = 'parking', zoneColor = L.KIND_COLOR.parking, pinKind = 'enter';
    var shapes = null, shapesAt = ''; // parking already on the map around the spot: [{ id, type: lot | space | aisle, pts }]
    var chosen = { s: {}, z: {} }, sheet = null; // what Select has picked (map shapes by id, zones by index); the sheet's step
    var history = []; // the layout before each change, for Undo
    var sel = null, turn = null; // the zone picked (to turn, copy, move or remove), and where it started before turning
    var imp = null; // a marked-up picture being lined up over the map: { src, iw, ih, found, cx, cy, scale, angle }
    var draft = []; // corners of the zone being drawn, as { lat, lng }
    var results = null, past = null, saved = null, msg = '', msgOk = true, saveTimer = null, note = null;

    function say(t, ok) { msg = t || ''; msgOk = ok !== false; var el = box.querySelector('[data-ed-msg]'); if (el) { el.className = 'msg ' + (msgOk ? 'ok' : 'bad'); el.textContent = msg; } }
    function save(now) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        api('PUT', '/meets/' + meet.id + '/lot', { lot: lot }).then(function (r) {
          if (!r.ok) return say(r.d.error, false);
          meet.lot = r.d.meet.lot; say(note || 'Saved.'); note = null;
        });
      }, now ? 0 : 500);
    }

    /* ---------- shapes in map pixels (at the current zoom), and back ---------- */
    var world = function (p) { return L.toPx(p.lat, p.lng, lot.zoom); };
    var fromWorld = function (x, y) { var q = L.toLatLng(x, y, lot.zoom); return { lat: q.lat, lng: q.lng }; };
    function inside(pt, poly) {
      for (var i = 0, j = poly.length - 1, c = false; i < poly.length; j = i++) {
        var a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    }
    /** The topmost zone under a spot on the map (frame pixels), or null. */
    function zoneAt(fx, fy) {
      var f = L.frame(lot);
      for (var i = lot.zones.length - 1; i >= 0; i--) {
        if (inside({ x: fx, y: fy }, lot.zones[i].pts.map(function (p) { return L.inFrame(lot, f, p.lat, p.lng); }))) return i;
      }
      return null;
    }
    function pick(i) { sel = i; turn = i === null ? null : { base: lot.zones[i].pts.slice(), angle: 0 }; }
    /** Turns the picked zone to an angle from where it started, around its middle. */
    function turnTo(deg) {
      var base = turn.base.map(world), c = L.middle(base), a = deg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      lot.zones[sel].pts = base.map(function (p) { var dx = p.x - c.x, dy = p.y - c.y; return fromWorld(c.x + dx * cos - dy * sin, c.y + dx * sin + dy * cos); });
      turn.angle = deg;
    }

    /* ---------- parking already on the map (OpenStreetMap), selecting it, and Undo ---------- */
    function loadShapes(force) {
      if (!lot) return;
      var key = lot.lat.toFixed(3) + ',' + lot.lng.toFixed(3);
      if (!force && key === shapesAt) return;
      shapesAt = key;
      api('GET', '/lot-shapes?lat=' + lot.lat + '&lng=' + lot.lng).then(function (r) {
        if (!r.ok) { shapes = shapes || []; say(r.d.error, false); return; }
        shapes = r.d.shapes || [];
        var n = shapes.filter(function (x) { return x.type !== 'aisle'; }).length;
        if (!n) { if (mode === 'select') mode = 'box'; msg = 'No parking is mapped here yet. Box rows by hand: drag across each one.'; msgOk = false; }
        draw();
      });
    }
    var count = function () { return Object.keys(chosen.s).length + Object.keys(chosen.z).length; };
    function clearChosen() { chosen = { s: {}, z: {} }; sheet = null; }
    function remember() { history.push(JSON.stringify(lot)); if (history.length > 40) history.shift(); }
    var areaOf = function (poly) { var a = 0; for (var i = 0; i < poly.length; i++) { var p = poly[i], q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a / 2); };
    /** What's under a spot on the map: a zone first, else the smallest mapped space or lot. 'z<i>' or 's<id>', or null. */
    function itemAt(fx, fy) {
      var zi = zoneAt(fx, fy);
      if (zi !== null) return 'z' + zi;
      var f = L.frame(lot), best = null, size = Infinity;
      (shapes || []).forEach(function (x) {
        if (x.type === 'aisle') return;
        var poly = x.pts.map(function (q) { return L.inFrame(lot, f, q.lat, q.lng); });
        if (L.inside({ x: fx, y: fy }, poly)) { var a = areaOf(poly); if (a < size) { size = a; best = 's' + x.id; } }
      });
      return best;
    }
    function sortOf(key) { if (!key) return null; if (key[0] === 'z') return 'zone'; var x = shapeById(key.slice(1)); return x ? x.type : null; }
    function isChosen(key) { return key[0] === 'z' ? !!chosen.z[key.slice(1)] : !!chosen.s[key.slice(1)]; }
    function setChosen(key, on) { var bag = key[0] === 'z' ? chosen.z : chosen.s; if (on) bag[key.slice(1)] = 1; else delete bag[key.slice(1)]; }
    var shapeById = function (id) { return (shapes || []).filter(function (x) { return x.id === id; })[0]; };
    /** A club's color: the one it already has on the map, else the next one no other club is using. */
    function clubColor(name) {
      var have = lot.zones.filter(function (z) { return z.kind === 'club' && z.label.toLowerCase() === name.toLowerCase(); })[0];
      if (have) return have.color;
      var used = lot.zones.filter(function (z) { return z.kind === 'club'; }).map(function (z) { return z.color; });
      var order = [L.KIND_COLOR.club, '#2dd4bf', '#fb923c', '#e5e7eb', '#fbbf24', '#60a5fa'];
      return order.filter(function (c) { return used.indexOf(c) < 0; })[0] || order[used.length % order.length];
    }
    /** Makes everything selected into one kind of zone. Mapped spaces that touch become one row; a mapped lot keeps
        its outline; a zone already on the map just changes. */
    function assign(kind, label) {
      remember();
      var color = kind === 'club' ? clubColor(label || 'club') : L.KIND_COLOR[kind];
      Object.keys(chosen.z).forEach(function (i) { var z = lot.zones[+i]; if (z) { z.kind = kind; z.label = label || ''; z.color = color; } });
      var f = L.frame(lot), px = function (q) { var w = world(q); return { x: w.x, y: w.y }; };
      var picked = Object.keys(chosen.s).map(shapeById).filter(Boolean);
      var made = [], spaces = picked.filter(function (x) { return x.type === 'space'; });
      picked.filter(function (x) { return x.type === 'lot'; }).forEach(function (x) {
        made.push(L.simplify(x.pts.map(px), 0.6, 30));
      });
      var sp = spaces.map(function (x) { return x.pts.map(px); }), gap = 0.8 * Math.pow(2, lot.zoom - 18) + 0.6;
      L.touching(sp, gap).forEach(function (g) {
        var all = []; g.forEach(function (i) { all = all.concat(sp[i]); });
        var bx = L.boxAround(all); if (bx) made.push(bx.pts);
      });
      var room = 30 - lot.zones.length;
      made.slice(0, Math.max(0, room)).forEach(function (pts) {
        lot.zones.push({ kind: kind, label: label || '', color: color, pts: pts.map(function (q) { return fromWorld(q.x, q.y); }) });
      });
      void f;
      var n = Object.keys(chosen.z).length + Math.min(made.length, Math.max(0, room));
      clearChosen(); draw(); save(true);
      note = made.length > room ? 'Made ' + n + '. Some didn’t fit: 30 zones at most.' : 'Marked ' + (label || L.ZONES[kind]) + '. Undo takes it back.';
    }
    function removeChosen() {
      var idx = Object.keys(chosen.z).map(Number).sort(function (a, b) { return b - a; });
      if (!idx.length) return;
      remember();
      idx.forEach(function (i) { lot.zones.splice(i, 1); });
      clearChosen(); pick(null); draw(); save(true);
    }
    /** The bottom sheet for what Select picked. */
    function sheetHtml() {
      var n = count(); if (!n || mode !== 'select') return '';
      var zonesOnly = !Object.keys(chosen.s).length;
      var head = '<div class="ed-sheet-head"><b>' + n + ' selected</b><button type="button" class="link" data-ed-clear>Clear</button></div>';
      if (sheet === 'club') {
        return '<div class="ed-sheet" role="dialog" aria-label="Which club">' + head + '<p class="small dim" style="margin:0 0 8px">Which club parks here?</p><div class="ed-big">' +
          (o.clubs || []).map(function (c) { return '<button type="button" data-ed-club="' + esc(c) + '"><i style="background:' + clubColor(c) + '"></i>' + esc(c) + '</button>'; }).join('') + '</div>' +
          '<form data-ed-club-other class="row" style="margin-top:8px"><input name="club" maxlength="30" placeholder="Another club" aria-label="Club name"><button class="btn sm" type="submit">Use</button></form>' +
          '<button type="button" class="link small" data-ed-sheet-back style="margin-top:8px">← Back</button></div>';
      }
      return '<div class="ed-sheet" role="dialog" aria-label="Mark what’s selected">' + head + '<div class="ed-big">' +
        Object.keys(L.ZONES).map(function (k) { return '<button type="button" data-ed-assign="' + k + '"><i style="background:' + L.KIND_COLOR[k] + '"></i>' + L.ZONES[k] + (k === 'club' ? ' ›' : '') + '</button>'; }).join('') +
        (zonesOnly ? '<button type="button" data-ed-remove-chosen class="danger">Remove</button>' : '') + '</div></div>';
    }

    /* ---------- the map ---------- */
    function mapHtml() {
      var f = L.frame(lot), tpl = o.me.mapTiles;
      var px = function (p) { return L.inFrame(lot, f, p.lat, p.lng); };
      var polys = lot.zones.map(function (z, i) {
        var pts = z.pts.map(px);
        return '<polygon data-zone="' + i + '" points="' + pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + '" style="--z:' + z.color + '" class="' + (z.kind === 'nopark' ? 'no' : '') + (i === sel ? ' sel' : '') + (chosen.z[i] ? ' on' : '') + '"/>';
      }).join('');
      var pl = function (list) { return list.map(function (q) { var c = px(q); return c.x.toFixed(1) + ',' + c.y.toFixed(1); }).join(' '); };
      var osm = (mode === 'select' || mode === 'box') && shapes ? '<g class="osm">' + shapes.filter(function (x) { return x.type === 'aisle'; }).map(function (x) { return '<polyline class="aisle" points="' + pl(x.pts) + '"/>'; }).join('') +
        shapes.filter(function (x) { return x.type === 'lot'; }).concat(shapes.filter(function (x) { return x.type === 'space'; })).map(function (x) {
          return '<polygon data-s="' + esc(x.id) + '" class="' + x.type + (chosen.s[x.id] ? ' on' : '') + '" points="' + pl(x.pts) + '"/>'; }).join('') + '</g>' : '';
      var d = draft.map(px);
      var draftSvg = d.length ? '<polyline class="draft" points="' + d.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + (d.length > 2 ? ' ' + d[0].x.toFixed(1) + ',' + d[0].y.toFixed(1) : '') + '" style="--z:' + zoneColor + '"/>' +
        d.map(function (p) { return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="7" style="--z:' + zoneColor + '"/>'; }).join('') : '';
      var labels = lot.zones.map(function (z, i) {
        var c = L.middle(z.pts.map(px));
        return '<span class="ed-tag" data-tag="' + i + '" style="left:' + pc(c.x) + ';top:' + pc(c.y) + ';--pin:' + z.color + '">' + (i + 1) + '. ' + esc(z.label || L.ZONES[z.kind]) + '</span>';
      }).join('') + lot.pins.map(function (p) {
        var c = px(p);
        return '<span class="ed-pin" style="left:' + pc(c.x) + ';top:' + pc(c.y) + ';--pin:' + L.PIN_COLOR[p.kind] + '"><b>' + esc(p.label || L.PINS[p.kind]) + '</b></span>';
      }).join('');
      return '<div class="ed-map mode-' + mode + '" data-ed-map><div class="ed-layer">' +
        f.tiles.map(function (t) { return '<img src="' + esc(L.tileUrl(tpl, t)) + '" alt="" draggable="false" style="left:' + pc(t.left) + ';top:' + pc(t.top) + '">'; }).join('') +
        '<svg viewBox="0 0 ' + L.FRAME + ' ' + L.FRAME + '">' + osm + polys + draftSvg + '<polygon class="boxdraft" data-boxdraft points=""/></svg>' + labels + impHtml() + '</div>' +
        '<div class="ed-zoom"><button type="button" data-ed-zoom="-1" aria-label="Zoom out">−</button><button type="button" data-ed-zoom="1" aria-label="Zoom in">+</button></div></div>' +
        (o.me.mapCredit ? '<p class="small dim" style="margin:4px 0 0;font-size:11px">' + esc(o.me.mapCredit) + '</p>' : '');
    }
    /* ---------- a marked-up picture, lined up over the map, turned into zones ---------- */
    function impStyle() {
      var W0 = L.FRAME * imp.scale, H0 = W0 * imp.ih / imp.iw;
      return 'left:' + pc(imp.cx - W0 / 2) + ';top:' + pc(imp.cy - H0 / 2) + ';width:' + pc(W0) + ';height:' + pc(H0) + ';transform:rotate(' + imp.angle + 'deg)';
    }
    function impHtml() {
      if (!imp) return '';
      var c = { parking: L.KIND_COLOR.parking, overflow: L.KIND_COLOR.overflow };
      return '<div class="ed-imp" data-ed-imp style="' + impStyle() + '"><img src="' + imp.src + '" alt="">' +
        '<svg viewBox="0 0 ' + imp.iw + ' ' + imp.ih + '" preserveAspectRatio="none">' + imp.found.zones.map(function (z) {
          return '<polygon points="' + z.pts.map(function (q) { return q.u.toFixed(1) + ',' + q.v.toFixed(1); }).join(' ') + '" style="--z:' + c[z.kind] + '"/>'; }).join('') +
        imp.found.pins.map(function (q) { return '<circle cx="' + q.u.toFixed(1) + '" cy="' + q.v.toFixed(1) + '" r="' + (imp.iw / 60).toFixed(1) + '" style="--z:' + L.PIN_COLOR.enter + '"/>'; }).join('') + '</svg></div>';
    }
    /** A point on the picture (its pixels) → where it lands on the map. */
    function impToLatLng(u, v, f) {
      var W0 = L.FRAME * imp.scale, H0 = W0 * imp.ih / imp.iw, a = imp.angle * Math.PI / 180;
      var lx = (u / imp.iw - 0.5) * W0, ly = (v / imp.ih - 0.5) * H0;
      return fromWorld(f.ox + imp.cx + lx * Math.cos(a) - ly * Math.sin(a), f.oy + imp.cy + lx * Math.sin(a) + ly * Math.cos(a));
    }
    function impUse() {
      remember();
      var f = L.frame(lot), room = 30 - lot.zones.length, pinRoom = 20 - lot.pins.length, zones = imp.found.zones.slice(0, Math.max(0, room));
      zones.forEach(function (z) { lot.zones.push({ kind: z.kind, label: '', color: L.KIND_COLOR[z.kind], pts: z.pts.map(function (q) { return impToLatLng(q.u, q.v, f); }) }); });
      imp.found.pins.slice(0, Math.max(0, pinRoom)).forEach(function (q) { var ll = impToLatLng(q.u, q.v, f); lot.pins.push({ kind: 'enter', label: '', lat: ll.lat, lng: ll.lng }); });
      var skipped = imp.found.zones.length - zones.length;
      URL.revokeObjectURL(imp.src); imp = null; mode = 'select'; pick(null); draw(); save(true);
      say(skipped ? 'Added ' + zones.length + ' zones (' + skipped + ' didn’t fit: 30 at most).' : 'Added. Tap any zone to rename it for a club, or remove it.');
    }
    function impLoad(file) {
      if (!window.LotDetect) return say('The picture reader didn’t load. Refresh and try again.', false);
      var src = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var found;
        try { found = LotDetect.detect(img); } catch (e) { found = { zones: [], pins: [] }; }
        if (!found.zones.length && !found.pins.length) { URL.revokeObjectURL(src); return say('Nothing painted found in that picture. It reads rows painted green or blue and yellow ENTER tags.', false); }
        imp = { src: src, iw: img.naturalWidth, ih: img.naturalHeight, found: found, cx: L.FRAME / 2, cy: L.FRAME / 2, scale: 1, angle: 0 };
        mode = 'import'; pick(null); msg = ''; draw();
        box.querySelector('[data-ed-map]').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      };
      img.onerror = function () { URL.revokeObjectURL(src); say('That file didn’t open as a picture.', false); };
      img.src = src;
    }

    function chips(list, cur, attr, colors) {
      return '<div class="ed-chips">' + Object.keys(list).map(function (k) {
        return '<button type="button" ' + attr + '="' + k + '" aria-pressed="' + (k === cur) + '"><i style="background:' + colors[k] + '"></i>' + list[k] + '</button>';
      }).join('') + '</div>';
    }
    function zoneSettings() {
      return '<p class="small dim" style="margin-bottom:6px">What it’s for:</p>' + chips(L.ZONES, zoneKind, 'data-ed-zkind', L.KIND_COLOR) +
        '<label for="edZLabel">Name on the map ' + (zoneKind === 'club' ? '(the club)' : '(optional)') + '</label>' +
        '<input id="edZLabel" maxlength="30" list="edClubs" placeholder="' + (zoneKind === 'club' ? 'Unforsaken' : L.ZONES[zoneKind]) + '" value="' + esc(box.dataset.zlabel || '') + '">' +
        '<datalist id="edClubs">' + (o.clubs || []).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
        '<p class="small dim" style="margin:10px 0 6px">Color:</p><div class="ed-colors">' + L.PALETTE.map(function (c) {
          return '<button type="button" data-ed-color="' + c + '" aria-label="Color ' + c + '" aria-pressed="' + (c === zoneColor) + '" style="background:' + c + '"></button>'; }).join('') + '</div>';
    }
    /** The picked zone's controls: turn it to match the row, copy it for the next row, remove it. */
    function pickedHtml() {
      if (sel === null || !lot.zones[sel]) return '';
      var z = lot.zones[sel];
      return '<div class="ed-picked"><div class="small"><b>' + (sel + 1) + '. ' + esc(z.label || L.ZONES[z.kind]) + '</b> · drag it to move it</div>' +
        '<label for="edTurn" class="small" style="margin:8px 0 2px">Turn it to match the row</label><input type="range" id="edTurn" min="-90" max="90" step="1" value="' + (turn ? turn.angle : 0) + '" data-ed-turn>' +
        '<div class="bar" style="margin-top:6px"><button class="btn go sm" type="button" data-ed-copy>Copy for the next row</button><button class="btn sm" type="button" data-ed-zdel="' + sel + '">Remove</button><button class="btn sm" type="button" data-ed-unpick>Done</button></div></div>';
    }
    function toolsHtml() {
      var tabs = mode === 'import' ? '' : '<div class="ed-modes" role="tablist">' + [['select', 'Select'], ['box', 'Box'], ['pin', 'Pin'], ['move', 'Move']].map(function (m) {
        return '<button type="button" data-ed-mode="' + m[0] + '" aria-pressed="' + (mode === m[0] || (m[0] === 'box' && mode === 'zone')) + '">' + m[1] + '</button>'; }).join('') + '</div>' +
        (history.length ? '<div class="ed-undo"><button type="button" class="btn sm" data-ed-back>↶ Undo</button></div>' : '');
      if (mode === 'import' && imp) {
        var nz = imp.found.zones.length, np = imp.found.pins.length;
        var kinds = { parking: 0, overflow: 0 }; imp.found.zones.forEach(function (z) { kinds[z.kind]++; });
        return '<div class="ed-picked"><div class="small"><b>Found ' + nz + ' zone' + (nz === 1 ? '' : 's') + (np ? ' and ' + np + ' entrance' + (np === 1 ? '' : 's') : '') + '</b> (' +
          [kinds.parking ? kinds.parking + ' green → Parking' : '', kinds.overflow ? kinds.overflow + ' blue → Overflow' : ''].filter(Boolean).join(', ') + ').</div>' +
          '<p class="small dim" style="margin:6px 0 0">Drag the picture until it sits on the lot, then size and turn it to match. If the lot doesn’t fit, Cancel, zoom the map out, and pick the picture again.</p>' +
          '<label for="edImpSize" class="small" style="margin:8px 0 2px">Size</label><input type="range" id="edImpSize" min="20" max="400" step="1" value="' + Math.round(imp.scale * 100) + '" data-ed-imp-size>' +
          '<label for="edImpTurn" class="small" style="margin:8px 0 2px">Turn</label><input type="range" id="edImpTurn" min="-45" max="45" step="0.5" value="' + imp.angle + '" data-ed-imp-turn>' +
          '<div class="bar" style="margin-top:8px"><button class="btn go sm" type="button" data-ed-imp-use>Use these</button><button class="btn sm" type="button" data-ed-imp-cancel>Cancel</button></div></div>';
      }
      var fromPic = '<label class="btn sm ed-frompic">From a picture<input type="file" accept="image/*" data-ed-import hidden></label><span class="small dim"> Your marked-up lot picture: green and blue rows and ENTER tags become zones and entrances.</span>';
      if (mode === 'move') return tabs + '<p class="small dim">Drag the map to slide it. − and + zoom. Frame the whole lot: what you see here is what people see.</p><p style="margin:0">' + fromPic + '</p>';
      if (mode === 'select') {
        var mapped = (shapes || []).filter(function (x) { return x.type !== 'aisle'; }).length;
        return tabs + '<p class="small" style="margin:8px 0">' + (shapes === null ? 'Looking for the parking on the map…' :
          mapped ? 'Tap a row or space to select it, or swipe across several. Then pick what they’re for. Two fingers zoom.' : 'No parking is mapped here yet. Use Box: drag across each row.') + '</p>';
      }
      if (mode === 'box') {
        return tabs + pickedHtml() + '<p class="small" style="margin:8px 0">Drag across a row to box it: it snaps to the mapped spaces under it. Tap a box to turn it, drag it, or copy it for the next row. <button type="button" class="link small" data-ed-mode="zone">Odd shape?</button></p>' + zoneSettings() +
          '<p style="margin:12px 0 0">' + fromPic + '</p>';
      }
      if (mode === 'zone') {
        return tabs + '<p class="small dim" style="margin:0 0 8px">For odd shapes: tap each corner, then Finish.</p>' + zoneSettings() +
          '<p class="small" style="margin:10px 0 0"><button type="button" class="link small" data-ed-mode="box">← Back to Box</button> ' + (draft.length ? draft.length + ' corner' + (draft.length === 1 ? '' : 's') + '. Keep tapping, then Finish.' : 'Tap the map at each corner of the zone.') + '</p>' +
          (draft.length ? '<div class="bar"><button class="btn go sm" type="button" data-ed-finish' + (draft.length < 3 ? ' disabled' : '') + '>Finish zone</button><button class="btn sm" type="button" data-ed-undo>Undo corner</button><button class="btn sm" type="button" data-ed-cancel>Cancel</button></div>' : '');
      }
      return tabs + '<p class="small dim" style="margin-bottom:6px">Pick one, then tap the map where it goes:</p>' + chips(L.PINS, pinKind, 'data-ed-pkind', L.PIN_COLOR) +
        '<label for="edPLabel">Label (optional)</label><input id="edPLabel" maxlength="24" placeholder="' + L.PINS[pinKind] + '" value="' + esc(box.dataset.plabel || '') + '">';
    }
    function listHtml() {
      var rows = lot.zones.map(function (z, i) {
        return '<div class="rowx"><div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0"><button type="button" class="ed-sw" data-ed-recolor="' + i + '" style="background:' + z.color + '" aria-label="Change color"></button>' +
          '<span class="small dim" style="flex:none">' + (i + 1) + '.</span><input data-ed-zname="' + i + '" maxlength="30" placeholder="' + esc(L.ZONES[z.kind]) + '" value="' + esc(z.label) + '" aria-label="Zone name"></div>' +
          '<button class="btn sm" type="button" data-ed-pickz="' + i + '">Edit</button></div>';
      }).concat(lot.pins.map(function (p, i) {
        return '<div class="rowx"><div style="display:flex;gap:8px;align-items:center;flex:1;min-width:0"><span class="ed-sw" style="background:' + L.PIN_COLOR[p.kind] + ';border-radius:50%"></span>' +
          '<input data-ed-pname="' + i + '" maxlength="24" placeholder="' + esc(L.PINS[p.kind]) + '" value="' + esc(p.label) + '" aria-label="Pin label"></div>' +
          '<button class="btn sm" type="button" data-ed-pdel="' + i + '">Remove</button></div>';
      }));
      return rows.length ? '<h3 style="margin:16px 0 4px;font-size:15px">On the map</h3>' + rows.join('') : '';
    }
    function searchHtml() {
      return '<form data-ed-search class="row" style="margin-top:8px"><input name="q" maxlength="160" placeholder="5112 W Peoria Ave, Glendale, AZ" value="' + esc(box.dataset.q != null ? box.dataset.q : ((lot && lot.address) || meet.address || '')) + '" aria-label="Address">' +
        '<button class="btn sm" type="submit">Find</button></form>' +
        (results ? (results.length ? '<div class="ed-results">' + results.map(function (r, i) { return '<button type="button" data-ed-pick="' + i + '">' + esc(r.label) + '</button>'; }).join('') + '</div>' : '<p class="small dim">No match. Try the street address with the city.</p>') : '');
    }
    /** Keep this layout as a saved location: pick that location for any meet and its map starts from here. */
    function saveAsHtml() {
      var v = (o.venues || []).filter(function (x) { return x.id === meet.venueId; })[0];
      var name = box.dataset.locname != null ? box.dataset.locname : (v ? v.name : (meet.place || ''));
      return '<details class="ed-save"><summary class="small">📍 Save this layout as a location</summary>' +
        '<form data-ed-saveas class="row" style="margin-top:8px"><input name="name" maxlength="60" placeholder="In-N-Out Tempe" value="' + esc(name) + '" aria-label="Location name">' +
        '<button class="btn sm go" type="submit">Save</button></form>' +
        '<p class="small dim" style="margin:4px 0 0">Same name as a saved one replaces its layout. It’s in Settings › Venues, and picking it for a meet starts the map from it.</p></details>';
    }
    function draw() {
      var html = '<div class="card" id="lotCard"><h3>Parking map</h3><p class="small dim">The satellite view of the spot, with where each club parks, where the trucks go, overflow and the entrances.</p>';
      if (!lot) {
        html += searchHtml();
        if (saved && saved.length) html += '<p class="small dim" style="margin:14px 0 6px">Your saved locations:</p>' + saved.map(function (x, i) {
          return '<button class="btn sm go" type="button" data-ed-saved="' + i + '" style="margin:0 6px 6px 0">📍 ' + esc(x.name) + ' · ' + x.zones + ' zone' + (x.zones === 1 ? '' : 's') + '</button>'; }).join('');
        if (past && past.length) html += '<p class="small dim" style="margin:14px 0 6px">Or start from one you made:</p>' + past.map(function (x, i) {
          return '<button class="btn sm" type="button" data-ed-past="' + i + '" style="margin:0 6px 6px 0">' + esc(x.place) + ' · ' + x.zones + ' zone' + (x.zones === 1 ? '' : 's') + '</button>'; }).join('');
      } else {
        html += '<details class="ed-where"' + (results ? ' open' : '') + '><summary class="small">' + esc(lot.address || 'The spot') + ' · change</summary>' + searchHtml() + '</details>' +
          mapHtml() + toolsHtml() + sheetHtml() + listHtml() + saveAsHtml() +
          '<div class="bar"><a class="btn sm" href="' + esc(meet.url) + '#parking" target="_blank" rel="noopener">See it on the page</a><button class="btn sm" type="button" data-ed-drop>Remove map</button></div>';
      }
      html += '<div class="' + (msg ? 'msg ' + (msgOk ? 'ok' : 'bad') : 'msg') + '" data-ed-msg role="status">' + esc(msg) + '</div></div>';
      box.innerHTML = html;
      wireMap();
    }

    /* ---------- taps and drags on the map ---------- */
    function wireMap() {
      var el = box.querySelector('[data-ed-map]'); if (!el) return;
      var layer = el.querySelector('.ed-layer'), start = null, fingers = {}, pinch = null;
      var mid = function () { var k = Object.keys(fingers), a = fingers[k[0]], b = fingers[k[1]]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; };
      var at = function (e) { var r = el.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width * L.FRAME, fy: (e.clientY - r.top) / r.height * L.FRAME, k: L.FRAME / r.width }; };
      var ptsAttr = function (list) { return list.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' '); };
      el.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.ed-zoom')) return;
        fingers[e.pointerId] = { x: e.clientX, y: e.clientY };
        try { el.setPointerCapture(e.pointerId); } catch (x) {}
        // A second finger: pinch to zoom and slide, whatever the mode. Whatever the first finger started is dropped.
        if (Object.keys(fingers).length === 2) {
          var m0 = mid(), r0 = el.getBoundingClientRect();
          pinch = { x: m0.x, y: m0.y, d: m0.d || 1, ox: m0.x - r0.left, oy: m0.y - r0.top };
          start = null; layer.style.transformOrigin = pinch.ox + 'px ' + pinch.oy + 'px';
          var dr = el.querySelector('[data-boxdraft]'); if (dr) dr.setAttribute('points', '');
          return;
        }
        if (pinch) return;
        var p = at(e);
        start = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, fx: p.fx, fy: p.fy };
        // In Box: pressing on the picked zone drags it; anywhere else draws a new box.
        if (mode === 'box') start.dragZone = sel !== null && zoneAt(p.fx, p.fy) === sel;
        // Select: a swipe adds everything it crosses, or (starting on something already picked) takes them off.
        if (mode === 'select') { var k0 = itemAt(p.fx, p.fy); start.item = k0; start.adding = !(k0 && isChosen(k0)); start.seen = {}; start.sort = sortOf(k0); }
      });
      el.addEventListener('pointermove', function (e) {
        if (fingers[e.pointerId]) fingers[e.pointerId] = { x: e.clientX, y: e.clientY };
        if (pinch && Object.keys(fingers).length >= 2) {
          var m1 = mid();
          layer.style.transform = 'translate(' + (m1.x - pinch.x) + 'px,' + (m1.y - pinch.y) + 'px) scale(' + (m1.d / pinch.d) + ')';
          pinch.last = m1; return;
        }
        if (!start || e.pointerId !== start.id) return;
        var dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!start.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
        start.moved = true;
        if (mode === 'move') { layer.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; return; }
        if (mode === 'import' && imp) { var o2 = el.querySelector('[data-ed-imp]'); if (o2) o2.style.translate = dx + 'px ' + dy + 'px'; return; }
        if (mode === 'select') {
          var ps = at(e), k1 = itemAt(ps.fx, ps.fy);
          // A swipe stays with what it started on (spaces, zones or whole lots), so slipping over an edge
          // between two spaces never grabs the lot around them.
          if (!start.sort && k1) start.sort = sortOf(k1);
          [start.item, k1].forEach(function (k2) {
            if (!k2 || start.seen[k2] || sortOf(k2) !== start.sort) return;
            start.seen[k2] = 1; setChosen(k2, start.adding);
            var node = el.querySelector(k2[0] === 'z' ? '[data-zone="' + k2.slice(1) + '"]' : '[data-s="' + k2.slice(1) + '"]');
            if (node) node.classList.toggle('on', start.adding);
          });
          return;
        }
        if (mode !== 'box') return;
        var p = at(e);
        if (start.dragZone) {
          var f = L.frame(lot), ddx = p.fx - start.fx, ddy = p.fy - start.fy;
          var moved = lot.zones[sel].pts.map(function (q) { var c = L.inFrame(lot, f, q.lat, q.lng); return { x: c.x + ddx, y: c.y + ddy }; });
          var poly = el.querySelector('[data-zone="' + sel + '"]'); if (poly) poly.setAttribute('points', ptsAttr(moved));
          var tag = el.querySelector('[data-tag="' + sel + '"]'); if (tag) tag.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
          return;
        }
        var d = el.querySelector('[data-boxdraft]');
        if (d) { d.setAttribute('points', ptsAttr([{ x: start.fx, y: start.fy }, { x: p.fx, y: start.fy }, { x: p.fx, y: p.fy }, { x: start.fx, y: p.fy }])); d.style.setProperty('--z', zoneColor); }
      });
      function endPinch() {
        var last = pinch.last; pinch = null; layer.style.transform = ''; layer.style.transformOrigin = '';
        if (!last) return;
        var r = el.getBoundingClientRect(), k = L.FRAME / r.width, f = L.frame(lot);
        var dz = Math.max(L.MIN_Z - lot.zoom, Math.min(L.MAX_Z - lot.zoom, Math.round(Math.log(last.d / pinch0.d) / Math.LN2)));
        // The spot under the fingers when they landed stays under them where they let go.
        var wx = f.ox + pinch0.ox * k, wy = f.oy + pinch0.oy * k, sc = Math.pow(2, dz);
        var nx = wx * sc - (last.x - r.left) * k + L.FRAME / 2, ny = wy * sc - (last.y - r.top) * k + L.FRAME / 2;
        lot.zoom += dz; var n = L.toLatLng(nx, ny, lot.zoom); lot.lat = n.lat; lot.lng = n.lng;
        draw(); save(); loadShapes();
      }
      var pinch0 = null;
      el.addEventListener('pointerup', function (e) {
        delete fingers[e.pointerId];
        if (pinch) { if (Object.keys(fingers).length < 2) { pinch0 = pinch; endPinch(); } return; }
        if (!start || e.pointerId !== start.id) return;
        var s = start; start = null;
        var p = at(e), f = L.frame(lot);
        if (mode === 'move') {
          if (!s.moved) return;
          var c = L.toPx(lot.lat, lot.lng, lot.zoom), n = L.toLatLng(c.x - (e.clientX - s.x) * p.k, c.y - (e.clientY - s.y) * p.k, lot.zoom);
          lot.lat = n.lat; lot.lng = n.lng; draw(); save(); loadShapes(); return;
        }
        if (mode === 'select') {
          if (!s.moved) { var k3 = itemAt(p.fx, p.fy); if (k3) setChosen(k3, !isChosen(k3)); }
          sheet = null; draw(); return;
        }
        if (mode === 'import') {
          if (imp && s.moved) { imp.cx += p.fx - s.fx; imp.cy += p.fy - s.fy; draw(); }
          return;
        }
        if (mode === 'box') {
          if (s.dragZone && s.moved) {
            remember();
            var ddx = p.fx - s.fx, ddy = p.fy - s.fy;
            lot.zones[sel].pts = lot.zones[sel].pts.map(function (q) { var w = world(q); return fromWorld(w.x + ddx, w.y + ddy); });
            pick(sel); draw(); save(); return;
          }
          if (!s.moved) { keepLabels(); pick(zoneAt(p.fx, p.fy)); draw(); return; } // a tap picks the box under it (or lets go)
          var w = Math.abs(p.fx - s.fx), h = Math.abs(p.fy - s.fy);
          if (w < 6 || h < 6) { draw(); return; }
          if (lot.zones.length >= 30) { draw(); return say('30 zones at most. Remove one first.', false); }
          keepLabels(); remember();
          var corners = [[s.fx, s.fy], [p.fx, s.fy], [p.fx, p.fy], [s.fx, p.fy]].map(function (c2) { return { x: f.ox + c2[0], y: f.oy + c2[1] }; });
          // Snap: mapped spaces whose middles fall inside the box become the box (turned to match their row).
          var x0 = Math.min(s.fx, p.fx), x1 = Math.max(s.fx, p.fx), y0 = Math.min(s.fy, p.fy), y1 = Math.max(s.fy, p.fy), under = [];
          (shapes || []).forEach(function (x) {
            if (x.type !== 'space') return;
            var poly = x.pts.map(function (q) { return L.inFrame(lot, f, q.lat, q.lng); }), c3 = L.middle(poly);
            if (c3.x >= x0 && c3.x <= x1 && c3.y >= y0 && c3.y <= y1) under = under.concat(poly.map(function (q) { return { x: f.ox + q.x, y: f.oy + q.y }; }));
          });
          var snapped = under.length >= 4 && L.boxAround(under);
          if (snapped) corners = snapped.pts;
          lot.zones.push({ kind: zoneKind, label: (box.dataset.zlabel || '').trim(), color: zoneKind === 'club' && (box.dataset.zlabel || '').trim() ? clubColor(box.dataset.zlabel.trim()) : zoneColor,
            pts: corners.map(function (c2) { return fromWorld(c2.x, c2.y); }) });
          if (snapped) note = 'Snapped to the mapped spaces under it.';
          pick(lot.zones.length - 1); draw(); save(true); return;
        }
        if (Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) > 10) return; // a slip, not a tap
        keepLabels();
        var ll = L.toLatLng(f.ox + p.fx, f.oy + p.fy, lot.zoom);
        if (mode === 'zone') {
          if (draft.length >= 30) return say('30 corners at most. Finish this zone.', false);
          draft.push({ lat: ll.lat, lng: ll.lng }); draw();
        } else if (mode === 'pin') {
          if (lot.pins.length >= 20) return say('20 pins at most. Remove one first.', false);
          var lab = box.querySelector('#edPLabel');
          remember();
          lot.pins.push({ kind: pinKind, label: lab ? lab.value.trim() : '', lat: ll.lat, lng: ll.lng });
          box.dataset.plabel = ''; draw(); save(true);
        }
      });
      el.addEventListener('pointercancel', function (e) { delete fingers[e.pointerId]; pinch = null; start = null; draw(); });
    }

    /* ---------- buttons and fields ---------- */
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !box.contains(b)) return;
      var a = function (n) { return b.getAttribute(n); };
      if (b.hasAttribute('data-ed-zoom')) { lot.zoom = Math.min(L.MAX_Z, Math.max(L.MIN_Z, lot.zoom + Number(a('data-ed-zoom')))); draw(); save(); }
      else if (b.hasAttribute('data-ed-mode')) { keepLabels(); mode = a('data-ed-mode'); if (mode !== 'zone') draft = []; if (mode !== 'box') pick(null); if (mode !== 'select') clearChosen(); draw(); }
      else if (b.hasAttribute('data-ed-back')) {
        if (!history.length) return;
        lot = JSON.parse(history.pop()); pick(null); clearChosen(); note = 'Undone.'; draw(); save(true);
      }
      else if (b.hasAttribute('data-ed-clear')) { clearChosen(); draw(); }
      else if (b.hasAttribute('data-ed-sheet-back')) { sheet = null; draw(); }
      else if (b.hasAttribute('data-ed-assign')) { if (a('data-ed-assign') === 'club') { sheet = 'club'; draw(); } else assign(a('data-ed-assign'), ''); }
      else if (b.hasAttribute('data-ed-club')) assign('club', a('data-ed-club'));
      else if (b.hasAttribute('data-ed-remove-chosen')) removeChosen();
      else if (b.hasAttribute('data-ed-pickz')) { keepLabels(); mode = 'box'; pick(+a('data-ed-pickz')); draw(); box.querySelector('[data-ed-map]').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      else if (b.hasAttribute('data-ed-unpick')) { keepLabels(); pick(null); draw(); }
      else if (b.hasAttribute('data-ed-imp-use')) impUse();
      else if (b.hasAttribute('data-ed-imp-cancel')) { URL.revokeObjectURL(imp.src); imp = null; mode = 'move'; draw(); }
      else if (b.hasAttribute('data-ed-copy')) {
        if (sel === null) return;
        if (lot.zones.length >= 30) return say('30 zones at most. Remove one first.', false);
        // The copy sits just past the original, across the row (the way the next row of spaces usually runs).
        remember();
        var src = lot.zones[sel], pts = src.pts.map(world), c0 = L.middle(pts);
        var e0 = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y }, e1 = { x: pts[pts.length - 1].x - pts[0].x, y: pts[pts.length - 1].y - pts[0].y };
        var short = Math.hypot(e0.x, e0.y) < Math.hypot(e1.x, e1.y) ? e0 : e1, gap = 1.25;
        lot.zones.push({ kind: src.kind, label: src.label, color: src.color, pts: pts.map(function (q) { return fromWorld(q.x + short.x * gap, q.y + short.y * gap); }) });
        void c0; keepLabels(); pick(lot.zones.length - 1); draw(); save(true);
      }
      else if (b.hasAttribute('data-ed-zkind')) { keepLabels(); zoneKind = a('data-ed-zkind'); zoneColor = L.KIND_COLOR[zoneKind]; draw(); }
      else if (b.hasAttribute('data-ed-color')) { keepLabels(); zoneColor = a('data-ed-color'); draw(); }
      else if (b.hasAttribute('data-ed-pkind')) { keepLabels(); pinKind = a('data-ed-pkind'); draw(); }
      else if (b.hasAttribute('data-ed-undo')) { keepLabels(); draft.pop(); draw(); }
      else if (b.hasAttribute('data-ed-cancel')) { keepLabels(); draft = []; draw(); }
      else if (b.hasAttribute('data-ed-finish')) {
        if (draft.length < 3) return;
        if (lot.zones.length >= 30) return say('30 zones at most. Remove one first.', false);
        var lab = box.querySelector('#edZLabel');
        remember();
        lot.zones.push({ kind: zoneKind, label: lab ? lab.value.trim() : '', color: zoneColor, pts: draft });
        draft = []; box.dataset.zlabel = ''; draw(); save(true);
      }
      else if (b.hasAttribute('data-ed-zdel')) { remember(); lot.zones.splice(+a('data-ed-zdel'), 1); pick(null); clearChosen(); note = 'Removed. Undo brings it back.'; draw(); save(true); }
      else if (b.hasAttribute('data-ed-pdel')) { remember(); lot.pins.splice(+a('data-ed-pdel'), 1); draw(); save(true); }
      else if (b.hasAttribute('data-ed-recolor')) {
        var z = lot.zones[+a('data-ed-recolor')];
        remember();
        z.color = L.PALETTE[(L.PALETTE.indexOf(z.color) + 1) % L.PALETTE.length]; draw(); save();
      }
      else if (b.hasAttribute('data-ed-pick')) {
        var r = results[+a('data-ed-pick')];
        var label = r.label.split(',').slice(0, 3).join(',').trim();
        if (lot) { lot.lat = r.lat; lot.lng = r.lng; lot.address = label; }
        else lot = { lat: r.lat, lng: r.lng, zoom: 18, address: label, zones: [], pins: [] };
        results = null; delete box.dataset.q; mode = 'select'; shapes = null; draw(); save(true); loadShapes(true);
      }
      else if (b.hasAttribute('data-ed-saved')) { lot = JSON.parse(JSON.stringify(saved[+a('data-ed-saved')].lot)); mode = 'select'; shapes = null; note = 'Started from ' + saved[+a('data-ed-saved')].name + '.'; draw(); save(true); loadShapes(true); }
      else if (b.hasAttribute('data-ed-past')) { lot = JSON.parse(JSON.stringify(past[+a('data-ed-past')].lot)); mode = 'select'; shapes = null; draw(); save(true); loadShapes(true); }
      else if (b.hasAttribute('data-ed-drop')) {
        if (!confirm('Remove the parking map from this meet?')) return;
        api('DELETE', '/meets/' + meet.id + '/lot').then(function (x) { if (!x.ok) return say(x.d.error, false); meet.lot = null; lot = null; draw(); loadPast(); });
      }
    });
    // What's typed in the label fields survives a redraw (picking a color, a kind...).
    function keepLabels() {
      var z = box.querySelector('#edZLabel'), p = box.querySelector('#edPLabel');
      if (z) box.dataset.zlabel = z.value; if (p) box.dataset.plabel = p.value;
    }
    box.addEventListener('input', function (e) {
      var t0 = e.target;
      if (imp && (t0.hasAttribute('data-ed-imp-size') || t0.hasAttribute('data-ed-imp-turn'))) {
        if (t0.hasAttribute('data-ed-imp-size')) imp.scale = Number(t0.value) / 100; else imp.angle = Number(t0.value);
        var ov = box.querySelector('[data-ed-imp]'); if (ov) ov.setAttribute('style', impStyle());
        return;
      }
      if (!e.target.hasAttribute('data-ed-turn') || sel === null) return;
      if (!turn.remembered) { remember(); turn.remembered = true; }
      turnTo(Number(e.target.value));
      var wrap = box.querySelector('[data-ed-map]'), f = L.frame(lot);
      var poly = wrap && wrap.querySelector('[data-zone="' + sel + '"]');
      if (poly) poly.setAttribute('points', lot.zones[sel].pts.map(function (p) { var c = L.inFrame(lot, f, p.lat, p.lng); return c.x.toFixed(1) + ',' + c.y.toFixed(1); }).join(' '));
    });
    box.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-ed-turn')) { save(); return; }
      if (t.hasAttribute('data-ed-import') && t.files && t.files[0]) { impLoad(t.files[0]); return; }
      if (t.hasAttribute('data-ed-zname') || t.hasAttribute('data-ed-pname')) remember();
      if (t.hasAttribute('data-ed-zname')) { lot.zones[+t.getAttribute('data-ed-zname')].label = t.value.trim(); draw(); save(); }
      if (t.hasAttribute('data-ed-pname')) { lot.pins[+t.getAttribute('data-ed-pname')].label = t.value.trim(); draw(); save(); }
    });
    box.addEventListener('submit', function (e) {
      if (e.target.hasAttribute('data-ed-saveas')) {
        e.preventDefault();
        var nm = e.target.elements.name.value.trim(); box.dataset.locname = nm;
        if (!nm) return say('Name the location.', false);
        clearTimeout(saveTimer);
        // The latest layout first, then keep it.
        api('PUT', '/meets/' + meet.id + '/lot', { lot: lot }).then(function (r0) {
          if (!r0.ok) return say(r0.d.error, false);
          return api('POST', '/locations', { meetId: meet.id, name: nm }).then(function (r) {
            if (!r.ok) return say(r.d.error, false);
            meet.venueId = r.d.meet.venueId; delete box.dataset.locname;
            say('Saved as ' + r.d.venue.name + '. Pick it for any meet and the map starts from it.');
          });
        });
        return;
      }
      if (e.target.hasAttribute('data-ed-club-other')) {
        e.preventDefault();
        var nm = e.target.elements.club.value.trim(); if (nm) assign('club', nm);
        return;
      }
      if (!e.target.hasAttribute('data-ed-search')) return;
      e.preventDefault();
      var q = e.target.elements.q.value.trim(); box.dataset.q = q;
      say('Searching…');
      api('GET', '/geocode?q=' + encodeURIComponent(q)).then(function (r) {
        if (!r.ok) { results = null; draw(); return say(r.d.error, false); }
        results = r.d.results || []; msg = ''; draw();
      });
    });
    function loadPast() { api('GET', '/lots').then(function (r) { past = r.ok ? r.d.lots.filter(function (x) { return x.meetId !== meet.id; }) : []; saved = r.ok ? r.d.saved || [] : []; if (!lot) draw(); }); }
    draw();
    if (!lot) loadPast(); else loadShapes();
  }

  window.LotEditor = { mount: mount };
})();
