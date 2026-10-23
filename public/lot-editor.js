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
    var mode = 'move', zoneKind = 'club', zoneColor = L.KIND_COLOR.club, pinKind = 'enter';
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

    /* ---------- the map ---------- */
    function mapHtml() {
      var f = L.frame(lot), tpl = o.me.mapTiles;
      var px = function (p) { return L.inFrame(lot, f, p.lat, p.lng); };
      var polys = lot.zones.map(function (z, i) {
        var pts = z.pts.map(px);
        return '<polygon data-zone="' + i + '" points="' + pts.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + '" style="--z:' + z.color + '"' + (z.kind === 'nopark' ? ' class="no"' : '') + '/>';
      }).join('');
      var d = draft.map(px);
      var draftSvg = d.length ? '<polyline class="draft" points="' + d.map(function (p) { return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') + (d.length > 2 ? ' ' + d[0].x.toFixed(1) + ',' + d[0].y.toFixed(1) : '') + '" style="--z:' + zoneColor + '"/>' +
        d.map(function (p) { return '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="7" style="--z:' + zoneColor + '"/>'; }).join('') : '';
      var labels = lot.zones.map(function (z, i) {
        var c = L.middle(z.pts.map(px));
        return '<span class="ed-tag" style="left:' + pc(c.x) + ';top:' + pc(c.y) + ';--pin:' + z.color + '">' + (i + 1) + '. ' + esc(z.label || L.ZONES[z.kind]) + '</span>';
      }).join('') + lot.pins.map(function (p) {
        var c = px(p);
        return '<span class="ed-pin" style="left:' + pc(c.x) + ';top:' + pc(c.y) + ';--pin:' + L.PIN_COLOR[p.kind] + '"><b>' + esc(p.label || L.PINS[p.kind]) + '</b></span>';
      }).join('');
      return '<div class="ed-map mode-' + mode + '" data-ed-map><div class="ed-layer">' +
        f.tiles.map(function (t) { return '<img src="' + esc(L.tileUrl(tpl, t)) + '" alt="" draggable="false" style="left:' + pc(t.left) + ';top:' + pc(t.top) + '">'; }).join('') +
        '<svg viewBox="0 0 ' + L.FRAME + ' ' + L.FRAME + '">' + polys + draftSvg + '</svg>' + labels + '</div>' +
        '<div class="ed-zoom"><button type="button" data-ed-zoom="-1" aria-label="Zoom out">−</button><button type="button" data-ed-zoom="1" aria-label="Zoom in">+</button></div></div>' +
        (o.me.mapCredit ? '<p class="small dim" style="margin:4px 0 0;font-size:11px">' + esc(o.me.mapCredit) + '</p>' : '');
    }
    function chips(list, cur, attr, colors) {
      return '<div class="ed-chips">' + Object.keys(list).map(function (k) {
        return '<button type="button" ' + attr + '="' + k + '" aria-pressed="' + (k === cur) + '"><i style="background:' + colors[k] + '"></i>' + list[k] + '</button>';
      }).join('') + '</div>';
    }
    function toolsHtml() {
      var tabs = '<div class="ed-modes" role="tablist">' + [['move', 'Move'], ['zone', 'Draw a zone'], ['pin', 'Drop a pin']].map(function (m) {
        return '<button type="button" data-ed-mode="' + m[0] + '" aria-pressed="' + (mode === m[0]) + '">' + m[1] + '</button>'; }).join('') + '</div>';
      if (mode === 'move') return tabs + '<p class="small dim">Drag the map to slide it. − and + zoom. Frame the whole lot: what you see here is what people see.</p>';
      if (mode === 'zone') {
        return tabs + '<p class="small dim" style="margin-bottom:6px">What it’s for:</p>' + chips(L.ZONES, zoneKind, 'data-ed-zkind', L.KIND_COLOR) +
          '<label for="edZLabel">Name on the map ' + (zoneKind === 'club' ? '(the club)' : '(optional)') + '</label>' +
          '<input id="edZLabel" maxlength="30" list="edClubs" placeholder="' + (zoneKind === 'club' ? 'Unforsaken' : L.ZONES[zoneKind]) + '" value="' + esc(box.dataset.zlabel || '') + '">' +
          '<datalist id="edClubs">' + (o.clubs || []).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
          '<p class="small dim" style="margin:10px 0 6px">Color:</p><div class="ed-colors">' + L.PALETTE.map(function (c) {
            return '<button type="button" data-ed-color="' + c + '" aria-label="Color ' + c + '" aria-pressed="' + (c === zoneColor) + '" style="background:' + c + '"></button>'; }).join('') + '</div>' +
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
          '<button class="btn sm" type="button" data-ed-zdel="' + i + '">Remove</button></div>';
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
      var html = '<div class="card" id="lotCard"><h3>Parking map</h3><p class="small dim">The satellite view of the spot, with where each club parks, where the trucks go, overflow and the entrances. On the page it’s tilted, like pulling into the lot.</p>';
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
      var at = function (e) { var r = el.getBoundingClientRect(); return { fx: (e.clientX - r.left) / r.width * L.FRAME, fy: (e.clientY - r.top) / r.height * L.FRAME, w: r.width }; };
      el.addEventListener('pointerdown', function (e) {
        if (e.target.closest('.ed-zoom')) return;
        start = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
        if (mode === 'move') { try { el.setPointerCapture(e.pointerId); } catch (x) {} }
      });
      el.addEventListener('pointermove', function (e) {
        if (!start || e.pointerId !== start.id || mode !== 'move') return;
        var dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!start.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        start.moved = true; layer.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      });
      el.addEventListener('pointerup', function (e) {
        if (!start || e.pointerId !== start.id) return;
        var s = start; start = null;
        if (mode === 'move') {
          if (!s.moved) return;
          var r = el.getBoundingClientRect(), k = L.FRAME / r.width;
          var c = L.toPx(lot.lat, lot.lng, lot.zoom), n = L.toLatLng(c.x - (e.clientX - s.x) * k, c.y - (e.clientY - s.y) * k, lot.zoom);
          lot.lat = n.lat; lot.lng = n.lng; draw(); save(); return;
        }
        if (Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) > 10) return; // a slip, not a tap
        keepLabels();
        var p = at(e), f = L.frame(lot), ll = L.toLatLng(f.ox + p.fx, f.oy + p.fy, lot.zoom);
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
      el.addEventListener('pointercancel', function () { start = null; layer.style.transform = ''; });
    }

    /* ---------- buttons and fields ---------- */
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !box.contains(b)) return;
      var a = function (n) { return b.getAttribute(n); };
      if (b.hasAttribute('data-ed-zoom')) { lot.zoom = Math.min(L.MAX_Z, Math.max(L.MIN_Z, lot.zoom + Number(a('data-ed-zoom')))); draw(); save(); }
      else if (b.hasAttribute('data-ed-mode')) { mode = a('data-ed-mode'); if (mode !== 'zone') draft = []; draw(); }
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
      else if (b.hasAttribute('data-ed-zdel')) { if (confirm('Remove this zone?')) { lot.zones.splice(+a('data-ed-zdel'), 1); draw(); save(true); } }
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
    box.addEventListener('change', function (e) {
      var t = e.target;
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
