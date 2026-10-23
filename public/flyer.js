/* flyer.js — the host portal's flyer tools, all on the phone (nothing leaves it until saved):
   - Split a logo sheet: one image with many logos on black becomes one logo each, ready to name and keep in the kit.
   - Flyer maker: main picture, then the details (date, time, place, a promo line), the meet's title logo, and rows
     of vendor and car group logos from the kit. Saves as the meet's flyer or downloads for Instagram.
   portal.js calls window.Flyer.splitter(el, done) and window.Flyer.maker(el, opts). */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function loadImage(src) { return new Promise(function (ok, no) { var i = new Image(); i.onload = function () { ok(i); }; i.onerror = no; i.src = src; }); }
  function fileImage(file) { return loadImage(URL.createObjectURL(file)); }
  function toBlob(c) { return new Promise(function (ok) { c.toBlob(ok, 'image/png'); }); }

  /* ======================= split a logo sheet ======================= */
  // Finds each logo on a dark background: bright pixels on a small copy, grown a little so a logo's own pieces
  // (letters, splashes, stars) join up, then grouped; each group is cut from the full-size image.
  function findLogos(img) {
    var W = img.naturalWidth, H = img.naturalHeight, S = Math.min(1, 320 / W), w = Math.max(1, Math.round(W * S)), h = Math.max(1, Math.round(H * S));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    var px = g.getImageData(0, 0, w, h).data, on = new Uint8Array(w * h), i, x, y;
    for (i = 0; i < w * h; i++) on[i] = px[i * 4 + 3] > 40 && Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) > 48 ? 1 : 0;
    var R = 1, grown = new Uint8Array(w * h);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (!on[y * w + x]) continue;
      for (var dy = -R; dy <= R; dy++) for (var dx = -R; dx <= R; dx++) { var yy = y + dy, xx = x + dx; if (yy >= 0 && yy < h && xx >= 0 && xx < w) grown[yy * w + xx] = 1; }
    }
    var seen = new Uint8Array(w * h), boxes = [];
    for (i = 0; i < w * h; i++) {
      if (!grown[i] || seen[i]) continue;
      var q = [i], x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0; seen[i] = 1;
      while (q.length) {
        var k = q.pop(), kx = k % w, ky = (k - kx) / w; n++;
        if (kx < x0) x0 = kx; if (kx > x1) x1 = kx; if (ky < y0) y0 = ky; if (ky > y1) y1 = ky;
        [k - 1, k + 1, k - w, k + w].forEach(function (m) { if (m >= 0 && m < w * h && !seen[m] && grown[m] && Math.abs((m % w) - kx) <= 1) { seen[m] = 1; q.push(m); } });
      }
      boxes.push({ x0: x0, y0: y0, x1: x1, y1: y1, n: n });
    }
    // Small specks are dropped; a box inside another (a star beside a logo) joins it.
    var min = w * h * 0.004;
    boxes = boxes.filter(function (b) { return (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) >= min && b.n > 20; });
    var merged = true;
    while (merged) {
      merged = false;
      for (var a = 0; a < boxes.length && !merged; a++) for (var b = a + 1; b < boxes.length && !merged; b++) {
        var A = boxes[a], B = boxes[b], ix = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), iy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
        // Joined only when most of the smaller one sits inside the bigger one (a star by a logo), never side by side.
        var small = Math.min((A.x1 - A.x0 + 1) * (A.y1 - A.y0 + 1), (B.x1 - B.x0 + 1) * (B.y1 - B.y0 + 1));
        if (ix > 0 && iy > 0 && ix * iy > small * 0.5) { boxes[a] = { x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1), n: A.n + B.n }; boxes.splice(b, 1); merged = true; }
      }
    }
    // Reading order: rows top to bottom, then left to right.
    boxes.sort(function (A, B) { var ra = (A.y0 + A.y1) / 2, rb = (B.y0 + B.y1) / 2; return Math.abs(ra - rb) < (A.y1 - A.y0) / 2 ? A.x0 - B.x0 : ra - rb; });
    return boxes.map(function (bx) {
      var pad = 4 / S;
      return { x: Math.max(0, Math.floor(bx.x0 / S - pad)), y: Math.max(0, Math.floor(bx.y0 / S - pad)),
        w: Math.min(W, Math.ceil((bx.x1 + 1) / S + pad)) - Math.max(0, Math.floor(bx.x0 / S - pad)),
        h: Math.min(H, Math.ceil((bx.y1 + 1) / S + pad)) - Math.max(0, Math.floor(bx.y0 / S - pad)) };
    });
  }
  // One logo, cut out; the black around it made see-through so it sits on any flyer.
  function cut(img, b, clear) {
    var c = document.createElement('canvas'); c.width = b.w; c.height = b.h;
    var g = c.getContext('2d'); g.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    if (clear) {
      var d = g.getImageData(0, 0, b.w, b.h), p = d.data;
      for (var i = 0; i < p.length; i += 4) {
        var m = Math.max(p[i], p[i + 1], p[i + 2]);
        if (m < 26) p[i + 3] = 0; else if (m < 64) p[i + 3] = Math.round(p[i + 3] * (m - 26) / 38);
      }
      g.putImageData(d, 0, 0);
    }
    return c;
  }

  function splitter(el, api, done) {
    el.innerHTML = '<div class="card"><h3>Split a logo sheet</h3><p class="small dim">One picture with lots of logos on black (like the sheet from your flyer designer). Each logo is cut out on its own; name them, then add them to the kit.</p>' +
      '<input type="file" id="sheetFile" accept="image/png,image/jpeg" aria-label="Logo sheet image">' +
      '<div class="checks"><label><input type="checkbox" id="sheetClear" checked> Make the black around each logo see-through</label></div>' +
      '<div class="msg" id="sheetMsg" role="status"></div><div id="sheetOut"></div></div>';
    var img = null, boxes = [];
    function draw() {
      var clear = document.getElementById('sheetClear').checked;
      var out = document.getElementById('sheetOut');
      if (!img) { out.innerHTML = ''; return; }
      out.innerHTML = '<div class="kit" style="margin-top:12px">' + boxes.map(function (b, i) {
        return '<figure><div class="art" data-slot="' + i + '"></div>' +
          '<label class="checks" style="margin:0"><input type="checkbox" data-keep="' + i + '" checked> Keep</label>' +
          '<input data-name="' + i + '" maxlength="60" placeholder="Name" aria-label="Logo name" style="min-height:40px">' +
          '<select data-kind="' + i + '" aria-label="Type" style="min-height:40px"><option value="vendor">Food vendor</option><option value="group">Car group</option><option value="sponsor">Sponsor</option><option value="title">Meet title</option></select></figure>';
      }).join('') + '</div><div class="bar"><button class="btn go" id="sheetSave">Add to kit</button></div>';
      boxes.forEach(function (b, i) { var c = cut(img, b, clear); c.style.maxWidth = '100%'; c.style.maxHeight = '100%'; out.querySelector('[data-slot="' + i + '"]').appendChild(c); });
      document.getElementById('sheetSave').onclick = save;
    }
    function save() {
      var clear = document.getElementById('sheetClear').checked, msg = document.getElementById('sheetMsg'), jobs = [];
      boxes.forEach(function (b, i) {
        if (!el.querySelector('[data-keep="' + i + '"]').checked) return;
        var name = el.querySelector('[data-name="' + i + '"]').value.trim() || ('Logo ' + (i + 1));
        jobs.push({ b: b, name: name, kind: el.querySelector('[data-kind="' + i + '"]').value });
      });
      if (!jobs.length) { msg.className = 'msg bad'; msg.textContent = 'Tick at least one logo.'; return; }
      var n = 0, failed = 0;
      (function next() {
        if (!jobs.length) { msg.className = 'msg ' + (failed ? 'bad' : 'ok'); msg.textContent = n + ' added to your kit' + (failed ? ', ' + failed + ' didn’t save.' : '.'); if (done) done(); return; }
        var j = jobs.shift();
        msg.className = 'msg ok'; msg.textContent = 'Adding ' + j.name + '…';
        toBlob(cut(img, j.b, clear)).then(function (blob) {
          return api('POST', '/kit?kind=' + encodeURIComponent(j.kind) + '&name=' + encodeURIComponent(j.name), null, new File([blob], 'logo.png', { type: 'image/png' }));
        }).then(function (r) { if (r.ok) n++; else failed++; next(); });
      })();
    }
    document.getElementById('sheetFile').onchange = function () {
      var f = this.files[0], msg = document.getElementById('sheetMsg'); if (!f) return;
      msg.className = 'msg ok'; msg.textContent = 'Finding the logos…';
      fileImage(f).then(function (i) {
        img = i; boxes = findLogos(i);
        msg.className = 'msg ' + (boxes.length ? 'ok' : 'bad');
        msg.textContent = boxes.length ? 'Found ' + boxes.length + ' logos. Untick any that came out wrong.' : 'No logos found. It works best with logos spread out on a black background.';
        draw();
      }, function () { msg.className = 'msg bad'; msg.textContent = 'That image didn’t open. Try a PNG or JPEG.'; });
    };
    document.getElementById('sheetClear').onchange = draw;
  }

  /* ======================= flyer maker ======================= */
  var SIZES = { post: [1080, 1350], story: [1080, 1920] };
  var FONT = '"Good Times", "Michroma", "Eurostile", sans-serif';

  // Text with letter spacing (drawn one character at a time, so it works on every phone).
  function spaced(g, text, cx, y, size, track, color) {
    g.font = size + 'px ' + FONT; g.fillStyle = color; g.textBaseline = 'alphabetic';
    var chars = Array.from(text), wsum = chars.reduce(function (s, ch) { return s + g.measureText(ch).width; }, 0) + track * (chars.length - 1);
    var x = cx - wsum / 2;
    chars.forEach(function (ch) { g.fillText(ch, x, y); x += g.measureText(ch).width + track; });
    return wsum;
  }
  function fitSize(g, text, max, start, track) {
    var s = start;
    while (s > 14) { g.font = s + 'px ' + FONT; var wsum = Array.from(text).reduce(function (a, ch) { return a + g.measureText(ch).width; }, 0) + track * (text.length - 1); if (wsum <= max) return s; s -= 2; }
    return s;
  }
  function contain(iw, ih, mw, mh) { var k = Math.min(mw / iw, mh / ih); return [iw * k, ih * k]; }
  // A row of logos, all the same height, scaled down together until the row fits the width.
  function logoRow(g, imgs, cy, W, maxH, gap) {
    if (!imgs.length) return 0;
    var h = maxH, total;
    for (;;) {
      total = imgs.reduce(function (s, im) { return s + Math.min(im.naturalWidth * h / im.naturalHeight, h * 2.4); }, 0) + gap * (imgs.length - 1);
      if (total <= W * 0.92 || h < 30) break;
      h -= 4;
    }
    var x = (W - total) / 2;
    imgs.forEach(function (im) {
      var w = Math.min(im.naturalWidth * h / im.naturalHeight, h * 2.4), d = contain(im.naturalWidth, im.naturalHeight, w, h);
      g.drawImage(im, x + (w - d[0]) / 2, cy - d[1] / 2, d[0], d[1]); x += w + gap;
    });
    return h;
  }

  function render(c, s) {
    var W = SIZES[s.size][0], H = SIZES[s.size][1], g = c.getContext('2d');
    c.width = W; c.height = H;
    g.fillStyle = '#05040a'; g.fillRect(0, 0, W, H);
    // 1. The main picture, filling the top, fading into the night.
    var picH = Math.round(H * (s.size === 'story' ? 0.5 : 0.42));
    if (s.pic) {
      var k = Math.max(W / s.pic.naturalWidth, picH / s.pic.naturalHeight), pw = s.pic.naturalWidth * k, ph = s.pic.naturalHeight * k;
      g.drawImage(s.pic, (W - pw) / 2, (picH - ph) / 2, pw, ph);
    } else {
      g.fillStyle = '#120d1f'; g.fillRect(0, 0, W, picH);
      spaced(g, 'ADD THE MAIN PICTURE', W / 2, picH / 2, 30, 6, 'rgba(255,255,255,.35)');
    }
    var fade = g.createLinearGradient(0, picH * 0.55, 0, picH);
    fade.addColorStop(0, 'rgba(5,4,10,0)'); fade.addColorStop(1, 'rgba(5,4,10,1)');
    g.fillStyle = fade; g.fillRect(0, 0, W, picH + 1);
    var top = g.createLinearGradient(0, 0, 0, picH * 0.18);
    top.addColorStop(0, 'rgba(5,4,10,.55)'); top.addColorStop(1, 'rgba(5,4,10,0)');
    g.fillStyle = top; g.fillRect(0, 0, W, picH * 0.18);
    // A faint glow of the host's color where the picture meets the details.
    var glow = g.createRadialGradient(W / 2, picH, 10, W / 2, picH, W * 0.6);
    glow.addColorStop(0, hexA(s.accent, 0.28)); glow.addColorStop(1, hexA(s.accent, 0));
    g.fillStyle = glow; g.fillRect(0, 0, W, H); // the whole canvas, so the glow has no hard edge

    // 2. The meet's title logo, over the bottom of the picture.
    var y = picH - H * 0.04;
    if (s.title) {
      var d = contain(s.title.naturalWidth, s.title.naturalHeight, W * 0.72, H * (s.size === 'story' ? 0.13 : 0.15));
      g.save(); g.shadowColor = 'rgba(0,0,0,.8)'; g.shadowBlur = 30;
      g.drawImage(s.title, (W - d[0]) / 2, y - d[1] / 2, d[0], d[1]); g.restore();
      y += d[1] / 2 + H * 0.045;
    } else {
      var ts = fitSize(g, s.hostName.toUpperCase(), W * 0.86, 70, 6);
      spaced(g, s.hostName.toUpperCase(), W / 2, y + ts * 0.35, ts, 6, '#ffffff');
      y += ts + H * 0.03;
    }
    // 3. The details: date and time, place, and a promo line.
    var line1 = [s.date, s.time].filter(Boolean).join('   ').toUpperCase();
    if (line1) { var s1 = fitSize(g, line1, W * 0.9, 52, 5); spaced(g, line1, W / 2, y + s1 * 0.8, s1, 5, '#ffffff'); y += s1 * 1.35; }
    if (s.place) { var pl = s.place.toUpperCase(), s2 = fitSize(g, pl, W * 0.9, 34, 3); spaced(g, pl, W / 2, y + s2 * 0.8, s2, 3, 'rgba(255,255,255,.88)'); y += s2 * 1.5; }
    if (s.promo) { var pr = s.promo.toUpperCase(), s3 = fitSize(g, pr, W * 0.9, 30, 3); spaced(g, pr, W / 2, y + s3 * 0.8, s3, 3, s.accent); y += s3 * 1.6; }
    // 4. Logo rows: vendors, then car groups (two rows when there are many), filling what's left.
    var rows = [];
    if (s.vendors.length) rows.push(s.vendors);
    if (s.groups.length > 6) { var half = Math.ceil(s.groups.length / 2); rows.push(s.groups.slice(0, half), s.groups.slice(half)); } else if (s.groups.length) rows.push(s.groups);
    if (rows.length) {
      var room = H - y - H * 0.035, gap = H * 0.02, rowH = Math.min(H * 0.11, (room - gap * (rows.length - 1)) / rows.length);
      var cy = y + rowH / 2 + (room - (rowH * rows.length + gap * (rows.length - 1))) / 2;
      rows.forEach(function (r) { logoRow(g, r, cy, W, rowH, W * 0.025); cy += rowH + gap; });
    }
  }
  function hexA(hex, a) { var m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || [0, 'c9adff']; var n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

  function maker(el, o) {
    var api = o.api, m = o.meet, me = o.me;
    var s = { size: 'post', pic: null, title: null, date: m.flyerDate, time: m.flyerTime, place: m.address || m.place, promo: '', vendors: [], groups: [], accent: me.accent || '#c9adff', hostName: me.name };
    el.innerHTML = '<p class="small"><button class="link" data-back>Back to the meet</button></p>' +
      '<div class="card"><h3>1. Main picture</h3><p class="small dim">The car shot that fills the top of the flyer.</p><input type="file" id="fmPic" accept="image/jpeg,image/png" aria-label="Main picture"></div>' +
      '<div class="card"><h3>2. Details</h3>' +
      '<label for="fmDate">Date</label><input id="fmDate" maxlength="30" value="' + esc(s.date) + '">' +
      '<label for="fmTime">Time</label><input id="fmTime" maxlength="30" value="' + esc(s.time) + '">' +
      '<label for="fmPlace">Location</label><input id="fmPlace" maxlength="80" value="' + esc(s.place) + '">' +
      '<label for="fmPromo">Promo line (optional)</label><input id="fmPromo" maxlength="60" placeholder="Buy 1 get 1 burritos">' +
      '<p class="small dim" style="margin-top:8px">These change the flyer only. To change the meet itself, use Edit on the meet.</p></div>' +
      '<div class="card"><h3>3. Logos</h3><div id="fmLogos"><p class="dim">Loading your kit…</p></div></div>' +
      '<div class="card"><h3>Preview</h3><div class="bar" style="margin:0 0 10px"><button class="btn sm" data-size="post" aria-pressed="true">Post 4:5</button><button class="btn sm" data-size="story" aria-pressed="false">Story 9:16</button></div>' +
      '<canvas id="fmCanvas" style="width:100%;max-width:420px;border-radius:12px;border:1px solid var(--line);display:block"></canvas>' +
      '<div class="bar"><button class="btn go" id="fmSave">Use as this meet’s flyer</button><a class="btn" id="fmDown" download="flyer.png">Download</a></div><div class="msg" id="fmMsg" role="status"></div></div>';
    var canvas = el.querySelector('#fmCanvas'), kit = [], imgs = {};
    var redraw = function () { render(canvas, s); };
    (document.fonts && document.fonts.load ? document.fonts.load('40px Michroma').catch(function () {}) : Promise.resolve()).then(redraw);
    var titleSrc = me.logo || null;
    api('GET', '/kit').then(function (r) {
      kit = (r.ok && r.d.logos) || [];
      var t = kit.filter(function (l) { return l.kind === 'title'; })[0];
      if (t) titleSrc = t.url;
      if (titleSrc) loadImage(titleSrc).then(function (im) { s.title = im; redraw(); }, function () {});
      var pick = function (kind, label) {
        var list = kit.filter(function (l) { return kind === 'vendor' ? (l.kind === 'vendor' || l.kind === 'sponsor') : l.kind === kind; });
        if (!list.length) return '<p class="small dim">No ' + label + ' in your kit yet (Flyer kit tab).</p>';
        return '<p class="small" style="margin:10px 0 6px">' + label + '</p><div class="checks">' + list.map(function (l) { return '<label><input type="checkbox" data-pick="' + l.id + '" data-kind="' + kind + '"> ' + esc(l.name) + '</label>'; }).join('') + '</div>';
      };
      el.querySelector('#fmLogos').innerHTML = pick('vendor', 'Food vendors and sponsors') + pick('group', 'Car groups');
    });
    function picked(kind) {
      return Array.prototype.filter.call(el.querySelectorAll('[data-pick][data-kind="' + kind + '"]'), function (x) { return x.checked; }).map(function (x) { return imgs[x.getAttribute('data-pick')]; }).filter(Boolean);
    }
    el.addEventListener('change', function (e) {
      var t = e.target;
      if (t.id === 'fmPic' && t.files[0]) { fileImage(t.files[0]).then(function (im) { s.pic = im; redraw(); }); }
      if (t.hasAttribute && t.hasAttribute('data-pick')) {
        var id = t.getAttribute('data-pick'), l = kit.filter(function (k) { return String(k.id) === id; })[0];
        var go = function () { s.vendors = picked('vendor'); s.groups = picked('group'); redraw(); };
        if (t.checked && !imgs[id] && l) loadImage(l.url).then(function (im) { imgs[id] = im; go(); }); else go();
      }
    });
    el.addEventListener('input', function (e) {
      var map = { fmDate: 'date', fmTime: 'time', fmPlace: 'place', fmPromo: 'promo' };
      if (map[e.target.id]) { s[map[e.target.id]] = e.target.value; redraw(); }
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-size]');
      if (b) { s.size = b.getAttribute('data-size'); el.querySelectorAll('[data-size]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); redraw(); return; }
      if (e.target.closest('[data-back]')) { o.back(); return; }
      if (e.target.id === 'fmDown') { e.target.href = canvas.toDataURL('image/png'); e.target.download = (me.slug || 'flyer') + '-' + m.day + '.png'; return; }
      if (e.target.id === 'fmSave') {
        var msg = el.querySelector('#fmMsg'); msg.className = 'msg ok'; msg.textContent = 'Saving…';
        canvas.toBlob(function (blob) {
          api('POST', '/meets/' + m.id + '/flyer', null, new File([blob], 'flyer.png', { type: 'image/png' })).then(function (r) {
            msg.className = 'msg ' + (r.ok ? 'ok' : 'bad'); msg.textContent = r.ok ? 'Saved. It’s on the meet’s page now.' : (r.d.error || 'Didn’t save.');
          });
        }, 'image/png');
      }
    });
  }

  window.Flyer = { splitter: splitter, maker: maker, findLogos: findLogos, render: render };
})();
