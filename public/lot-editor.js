/* lot-editor.js — the host's parking map editor (portal › Meets › a meet › Parking map).
   Type the address, pick the match, and the satellite view opens there. Then:
   - Move: drag to slide the map, − and + to zoom.
   - Zone: pick what it's for (club parking, vendors, car show...), name it (a club's name), pick a color, tap its
     corners, Finish.
   - Pin: pick a kind (Enter, Exit...), tap where it goes.
   Every change saves itself. The layout is kept in latitude and longitude (lotmap.js), so it stays put at any zoom. */
(function () {
  'use strict';
  var L = window.LotMap;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pc = function (v) { return (v / L.FRAME * 100).toFixed(3) + '%'; };

  function mount(box, o) {
    var meet = o.meet, api = o.api;
    var lot = meet.lot ? JSON.parse(JSON.stringify(meet.lot)) : null;
    var mode = lot && lot.zones.length ? 'box' : 'move', zoneKind = 'club', zoneColor = L.KIND_COLOR.club, pinKind = 'enter';
    var sel = null, turn = null; // the zone picked (to turn, copy, move or remove), and where it started before turning
    var imp = null; // a marked-up picture being lined up over the map: { src, iw, ih, found, cx, cy, scale, angle }
    var draft = []; // corners of the zone being drawn, as { lat, lng }
    var results = null, past = null, msg = '', msgOk = true, saveTimer = null;

    function say(t, ok) { msg = t || ''; msgOk = ok !== false; var el = box.querySelector('[data-ed-msg]'); if (el) { el.className = 'msg ' + (msgOk ? 'ok' : 'bad'); el.textContent = msg; } }
    function save(now) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        api('PUT', '/meets/' + meet.id + '/lot', { lot: lot }).then(function (r) {
          if (!r.ok) return say(r.d.error, false);
          meet.lot = r.d.meet.lot; say('Saved.');
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

    /* ---------- the map ---------- */
    function mapHtml() {
      var f = L.frame(lot), tpl = o.me.mapTiles;
      var px = function (p) { return L.inFrame(lot, f, p.lat, p.lng); };
      var polys = lot.zones.map(function (z, i) {
        var pts = z.pts.map(px);
        return '<polygon data-zone="' + i + '" points="' + pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + '" style="--z:' + z.color + '" class="' + (z.kind === 'nopark' ? 'no' : '') + (i === sel ? ' sel' : '') + '"/>';
      }).join('');
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
        '<svg viewBox="0 0 ' + L.FRAME + ' ' + L.FRAME + '">' + polys + draftSvg + '<polygon class="boxdraft" data-boxdraft points=""/></svg>' + labels + impHtml() + '</div>' +
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
      var f = L.frame(lot), room = 30 - lot.zones.length, pinRoom = 20 - lot.pins.length, zones = imp.found.zones.slice(0, Math.max(0, room));
      zones.forEach(function (z) { lot.zones.push({ kind: z.kind, label: '', color: L.KIND_COLOR[z.kind], pts: z.pts.map(function (q) { return impToLatLng(q.u, q.v, f); }) }); });
      imp.found.pins.slice(0, Math.max(0, pinRoom)).forEach(function (q) { var ll = impToLatLng(q.u, q.v, f); lot.pins.push({ kind: 'enter', label: '', lat: ll.lat, lng: ll.lng }); });
      var skipped = imp.found.zones.length - zones.length;
      URL.revokeObjectURL(imp.src); imp = null; mode = 'box'; pick(null); draw(); save(true);
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
      var tabs = mode === 'import' ? '' : '<div class="ed-modes" role="tablist">' + [['move', 'Move'], ['box', 'Box'], ['zone', 'Shape'], ['pin', 'Pin']].map(function (m) {
        return '<button type="button" data-ed-mode="' + m[0] + '" aria-pressed="' + (mode === m[0]) + '">' + m[1] + '</button>'; }).join('') + '</div>';
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
      if (mode === 'box') {
        return tabs + pickedHtml() + '<p class="small" style="margin:8px 0">Drag across a row of spaces to box it. Tap a box to pick it: turn it, drag it, or copy it for the next row.</p>' + (lot.zones.length ? '' : '<p style="margin:0 0 10px">' + fromPic + '</p>') + zoneSettings();
      }
      if (mode === 'zone') {
        return tabs + '<p class="small dim" style="margin:0 0 8px">For odd shapes: tap each corner, then Finish.</p>' + zoneSettings() +
          '<p class="small" style="margin:10px 0 0">' + (draft.length ? draft.length + ' corner' + (draft.length === 1 ? '' : 's') + '. Keep tapping, then Finish.' : 'Tap the map at each corner of the zone.') + '</p>' +
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
    function draw() {
      var html = '<div class="card" id="lotCard"><h3>Parking map</h3><p class="small dim">The satellite view of the spot, with where each club parks, where the trucks go, overflow and the entrances.</p>';
      if (!lot) {
        html += searchHtml();
        if (past && past.length) html += '<p class="small dim" style="margin:14px 0 6px">Or start from one you made:</p>' + past.map(function (x, i) {
          return '<button class="btn sm" type="button" data-ed-past="' + i + '" style="margin:0 6px 6px 0">' + esc(x.place) + ' · ' + x.zones + ' zone' + (x.zones === 1 ? '' : 's') + '</button>'; }).join('');
      } else {
        html += '<details class="ed-where"' + (results ? ' open' : '') + '><summary class="small">' + esc(lot.address || 'The spot') + ' · change</summary>' + searchHtml() + '</details>' +
          mapHtml() + toolsHtml() + listHtml() +
          '<div class="bar"><a class="btn sm" href="' + esc(meet.url) + '#parking" target="_blank" rel="noopener">See it on the page</a><button class="btn sm" type="button" data-ed-drop>Remove map</button></div>';
      }
      html += '<div class="' + (msg ? 'msg ' + (msgOk ? 'ok' : 'bad') : 'msg') + '" data-ed-msg role="status">' + esc(msg) + '</div></div>';
      box.innerHTML = html;
      wireMap();
    }

    /* ---------- taps and drags on the map ---------- */
    function wireMap() {
      var el = box.querySelector('[data-ed-map]'); if (!el) return;
      var layer = el.querySelector('.ed-layer'), start = null;
      var at = function (e) { var r = el.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width * L.FRAME, fy: (e.clientY - r.top) / r.height * L.FRAME, k: L.FRAME / r.width }; };
      var ptsAttr = function (list) { return list.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' '); };
      el.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.ed-zoom')) return;
        var p = at(e);
        start = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false, fx: p.fx, fy: p.fy };
        // In Box: pressing on the picked zone drags it; anywhere else draws a new box.
        if (mode === 'box') start.dragZone = sel !== null && zoneAt(p.fx, p.fy) === sel;
        if (mode === 'move' || mode === 'box' || mode === 'import') { try { el.setPointerCapture(e.pointerId); } catch (x) {} }
      });
      el.addEventListener('pointermove', function (e) {
        if (!start || e.pointerId !== start.id) return;
        var dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!start.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
        start.moved = true;
        if (mode === 'move') { layer.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; return; }
        if (mode === 'import' && imp) { var o2 = el.querySelector('[data-ed-imp]'); if (o2) o2.style.translate = dx + 'px ' + dy + 'px'; return; }
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
      el.addEventListener('pointerup', function (e) {
        if (!start || e.pointerId !== start.id) return;
        var s = start; start = null;
        var p = at(e), f = L.frame(lot);
        if (mode === 'move') {
          if (!s.moved) return;
          var c = L.toPx(lot.lat, lot.lng, lot.zoom), n = L.toLatLng(c.x - (e.clientX - s.x) * p.k, c.y - (e.clientY - s.y) * p.k, lot.zoom);
          lot.lat = n.lat; lot.lng = n.lng; draw(); save(); return;
        }
        if (mode === 'import') {
          if (imp && s.moved) { imp.cx += p.fx - s.fx; imp.cy += p.fy - s.fy; draw(); }
          return;
        }
        if (mode === 'box') {
          if (s.dragZone && s.moved) {
            var ddx = p.fx - s.fx, ddy = p.fy - s.fy;
            lot.zones[sel].pts = lot.zones[sel].pts.map(function (q) { var w = world(q); return fromWorld(w.x + ddx, w.y + ddy); });
            pick(sel); draw(); save(); return;
          }
          if (!s.moved) { keepLabels(); pick(zoneAt(p.fx, p.fy)); draw(); return; } // a tap picks the box under it (or lets go)
          var w = Math.abs(p.fx - s.fx), h = Math.abs(p.fy - s.fy);
          if (w < 6 || h < 6) { draw(); return; }
          if (lot.zones.length >= 30) { draw(); return say('30 zones at most. Remove one first.', false); }
          keepLabels();
          var corners = [[s.fx, s.fy], [p.fx, s.fy], [p.fx, p.fy], [s.fx, p.fy]].map(function (c2) { return fromWorld(f.ox + c2[0], f.oy + c2[1]); });
          lot.zones.push({ kind: zoneKind, label: (box.dataset.zlabel || '').trim(), color: zoneColor, pts: corners });
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
          lot.pins.push({ kind: pinKind, label: lab ? lab.value.trim() : '', lat: ll.lat, lng: ll.lng });
          box.dataset.plabel = ''; draw(); save(true);
        }
      });
      el.addEventListener('pointercancel', function () { start = null; draw(); });
    }

    /* ---------- buttons and fields ---------- */
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !box.contains(b)) return;
      var a = function (n) { return b.getAttribute(n); };
      if (b.hasAttribute('data-ed-zoom')) { lot.zoom = Math.min(L.MAX_Z, Math.max(L.MIN_Z, lot.zoom + Number(a('data-ed-zoom')))); draw(); save(); }
      else if (b.hasAttribute('data-ed-mode')) { keepLabels(); mode = a('data-ed-mode'); if (mode !== 'zone') draft = []; if (mode !== 'box') pick(null); draw(); }
      else if (b.hasAttribute('data-ed-pickz')) { keepLabels(); mode = 'box'; pick(+a('data-ed-pickz')); draw(); box.querySelector('[data-ed-map]').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      else if (b.hasAttribute('data-ed-unpick')) { keepLabels(); pick(null); draw(); }
      else if (b.hasAttribute('data-ed-imp-use')) impUse();
      else if (b.hasAttribute('data-ed-imp-cancel')) { URL.revokeObjectURL(imp.src); imp = null; mode = 'move'; draw(); }
      else if (b.hasAttribute('data-ed-copy')) {
        if (sel === null) return;
        if (lot.zones.length >= 30) return say('30 zones at most. Remove one first.', false);
        // The copy sits just past the original, across the row (the way the next row of spaces usually runs).
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
        lot.zones.push({ kind: zoneKind, label: lab ? lab.value.trim() : '', color: zoneColor, pts: draft });
        draft = []; box.dataset.zlabel = ''; draw(); save(true);
      }
      else if (b.hasAttribute('data-ed-zdel')) { if (confirm('Remove this zone?')) { lot.zones.splice(+a('data-ed-zdel'), 1); pick(null); draw(); save(true); } }
      else if (b.hasAttribute('data-ed-pdel')) { lot.pins.splice(+a('data-ed-pdel'), 1); draw(); save(true); }
      else if (b.hasAttribute('data-ed-recolor')) {
        var z = lot.zones[+a('data-ed-recolor')];
        z.color = L.PALETTE[(L.PALETTE.indexOf(z.color) + 1) % L.PALETTE.length]; draw(); save();
      }
      else if (b.hasAttribute('data-ed-pick')) {
        var r = results[+a('data-ed-pick')];
        var label = r.label.split(',').slice(0, 3).join(',').trim();
        if (lot) { lot.lat = r.lat; lot.lng = r.lng; lot.address = label; }
        else lot = { lat: r.lat, lng: r.lng, zoom: 18, address: label, zones: [], pins: [] };
        results = null; delete box.dataset.q; draw(); save(true);
      }
      else if (b.hasAttribute('data-ed-past')) { lot = JSON.parse(JSON.stringify(past[+a('data-ed-past')].lot)); draw(); save(true); }
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
      turnTo(Number(e.target.value));
      var wrap = box.querySelector('[data-ed-map]'), f = L.frame(lot);
      var poly = wrap && wrap.querySelector('[data-zone="' + sel + '"]');
      if (poly) poly.setAttribute('points', lot.zones[sel].pts.map(function (p) { var c = L.inFrame(lot, f, p.lat, p.lng); return c.x.toFixed(1) + ',' + c.y.toFixed(1); }).join(' '));
    });
    box.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-ed-turn')) { save(); return; }
      if (t.hasAttribute('data-ed-import') && t.files && t.files[0]) { impLoad(t.files[0]); return; }
      if (t.hasAttribute('data-ed-zname')) { lot.zones[+t.getAttribute('data-ed-zname')].label = t.value.trim(); draw(); save(); }
      if (t.hasAttribute('data-ed-pname')) { lot.pins[+t.getAttribute('data-ed-pname')].label = t.value.trim(); draw(); save(); }
    });
    box.addEventListener('submit', function (e) {
      if (!e.target.hasAttribute('data-ed-search')) return;
      e.preventDefault();
      var q = e.target.elements.q.value.trim(); box.dataset.q = q;
      say('Searching…');
      api('GET', '/geocode?q=' + encodeURIComponent(q)).then(function (r) {
        if (!r.ok) { results = null; draw(); return say(r.d.error, false); }
        results = r.d.results || []; msg = ''; draw();
      });
    });
    function loadPast() { api('GET', '/lots').then(function (r) { past = r.ok ? r.d.lots.filter(function (x) { return x.meetId !== meet.id; }) : []; if (!lot) draw(); }); }
    draw();
    if (!lot) loadPast();
  }

  window.LotEditor = { mount: mount };
})();
