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
  // Finds each logo on a dark (or see-through) background. On a smaller copy: the logo pixels, grown a little so a
  // logo's own pieces (letters, splashes, stars) join up, then grouped. Small pieces near a logo (a tagline, a star)
  // belong to that logo, so nothing of it is cut off. Each logo remembers which groups are its own, so when it's cut
  // from the full-size image, any part of a neighbouring logo inside its box is removed: no trace of the others.
  function findLogos(img) {
    var W = img.naturalWidth, H = img.naturalHeight, S = Math.min(1, 640 / Math.max(W, H));
    var w = Math.max(1, Math.round(W * S)), h = Math.max(1, Math.round(H * S)), N = w * h;
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    var px = g.getImageData(0, 0, w, h).data, on = new Uint8Array(N), i, x, y;
    var corner = [0, w - 1, N - w, N - 1].filter(function (k) { return px[k * 4 + 3] < 128; }).length >= 2;
    for (i = 0; i < N; i++) on[i] = corner ? (px[i * 4 + 3] > 40 ? 1 : 0) : (px[i * 4 + 3] > 40 && Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]) > 48 ? 1 : 0);
    // Grown by R in each direction (rows, then columns).
    var R = Math.max(2, Math.round(Math.min(w, h) * 0.006)), row = new Uint8Array(N), grown = new Uint8Array(N);
    for (y = 0; y < h; y++) { var last = -1e9; for (x = 0; x < w; x++) { if (on[y * w + x]) last = x; if (x - last <= R) row[y * w + x] = 1; } last = 1e9; for (x = w - 1; x >= 0; x--) { if (on[y * w + x]) last = x; if (last - x <= R) row[y * w + x] = 1; } }
    for (x = 0; x < w; x++) { var lastY = -1e9; for (y = 0; y < h; y++) { if (row[y * w + x]) lastY = y; if (y - lastY <= R) grown[y * w + x] = 1; } lastY = 1e9; for (y = h - 1; y >= 0; y--) { if (row[y * w + x]) lastY = y; if (lastY - y <= R) grown[y * w + x] = 1; } }
    // Groups of touching pixels; lab holds each pixel's group number (0 = background).
    var lab = new Int32Array(N), parts = [];
    for (i = 0; i < N; i++) {
      if (!grown[i] || lab[i]) continue;
      var id = parts.length + 1, q = [i], x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0; lab[i] = id;
      while (q.length) {
        var k = q.pop(), kx = k % w, ky = (k - kx) / w; if (on[k]) n++;
        if (kx < x0) x0 = kx; if (kx > x1) x1 = kx; if (ky < y0) y0 = ky; if (ky > y1) y1 = ky;
        if (kx > 0 && grown[k - 1] && !lab[k - 1]) { lab[k - 1] = id; q.push(k - 1); }
        if (kx < w - 1 && grown[k + 1] && !lab[k + 1]) { lab[k + 1] = id; q.push(k + 1); }
        if (ky > 0 && grown[k - w] && !lab[k - w]) { lab[k - w] = id; q.push(k - w); }
        if (ky < h - 1 && grown[k + w] && !lab[k + w]) { lab[k + w] = id; q.push(k + w); }
      }
      parts.push({ ids: [id], x0: x0, y0: y0, x1: x1, y1: y1, n: n });
    }
    parts = parts.filter(function (p) { return p.n > 6; });
    if (!parts.length) return [];
    var area = function (p) { return (p.x1 - p.x0 + 1) * (p.y1 - p.y0 + 1); };
    var join = function (A, B) { return { ids: A.ids.concat(B.ids), x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1), n: A.n + B.n }; };
    var gap = function (A, B) { var dx = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1)), dy = Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1)); return Math.max(dx, dy); };
    // The logos themselves: the big groups. One group enclosed by another (the letters inside a shield or a ring)
    // is part of it; one that only sits in another's box (a logo in the corner of an L-shaped one) stays its own.
    var biggest = Math.max.apply(null, parts.map(area));
    var major = parts.filter(function (p) { return area(p) >= Math.max(biggest * 0.06, N * 0.004); });
    var minor = parts.filter(function (p) { return major.indexOf(p) < 0; });
    var mine = function (P, k) { return P.ids.indexOf(lab[k]) >= 0; };
    // Walks out from the middle of A in four directions (inside B's box): enclosed when B is met on at least three.
    var enclosed = function (A, B) {
      var cx = Math.round((A.x0 + A.x1) / 2), cy = Math.round((A.y0 + A.y1) / 2), met = 0, xx, yy;
      for (yy = A.y0 - 1; yy >= B.y0; yy--) if (mine(B, yy * w + cx)) { met++; break; }
      for (yy = A.y1 + 1; yy <= B.y1; yy++) if (mine(B, yy * w + cx)) { met++; break; }
      for (xx = A.x0 - 1; xx >= B.x0; xx--) if (mine(B, cy * w + xx)) { met++; break; }
      for (xx = A.x1 + 1; xx <= B.x1; xx++) if (mine(B, cy * w + xx)) { met++; break; }
      return met >= 3;
    };
    var inside = function (A, B) { return A.x0 >= B.x0 && A.x1 <= B.x1 && A.y0 >= B.y0 && A.y1 <= B.y1; };
    var merged = true;
    while (merged) {
      merged = false;
      for (var a = 0; a < major.length && !merged; a++) for (var b = 0; b < major.length && !merged; b++) {
        var A = major[a], B = major[b];
        if (a !== b && inside(A, B) && enclosed(A, B)) { major[b] = join(B, A); major.splice(a, 1); merged = true; }
      }
    }
    // Small pieces go to the nearest logo when they're close to it (part of it); far-off specks are dropped.
    var near = Math.max(w, h) * 0.035;
    minor.forEach(function (p) {
      var best = -1, bd = Infinity;
      major.forEach(function (M, j) { var d = gap(p, M); if (d < bd) { bd = d; best = j; } });
      if (best >= 0 && bd <= near) major[best] = join(major[best], p);
    });
    // Reading order: rows top to bottom, then left to right.
    major.sort(function (A, B) { var ra = (A.y0 + A.y1) / 2, rb = (B.y0 + B.y1) / 2; return Math.abs(ra - rb) < (A.y1 - A.y0) / 2 ? A.x0 - B.x0 : ra - rb; });
    var map = { lab: lab, w: w, h: h, S: S };
    return major.map(function (bx) {
      var pad = Math.max(2, Math.round(Math.max(bx.x1 - bx.x0, bx.y1 - bx.y0) * 0.03));
      var X0 = Math.max(0, Math.floor((bx.x0 - pad) / S)), Y0 = Math.max(0, Math.floor((bx.y0 - pad) / S));
      var X1 = Math.min(W, Math.ceil((bx.x1 + 1 + pad) / S)), Y1 = Math.min(H, Math.ceil((bx.y1 + 1 + pad) / S));
      var own = {}; bx.ids.forEach(function (k) { own[k] = 1; });
      return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0, own: own, map: map };
    });
  }
  // One logo, cut out. Anything in its box that belongs to another logo is removed; with clear on, the black around
  // it is made see-through so it sits on any flyer.
  function cut(img, b, clear) {
    var c = document.createElement('canvas'); c.width = b.w; c.height = b.h;
    var g = c.getContext('2d'); g.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    var d = g.getImageData(0, 0, b.w, b.h), p = d.data, M = b.map;
    for (var yy = 0; yy < b.h; yy++) {
      var sy = Math.min(M.h - 1, Math.floor((b.y + yy) * M.S));
      for (var xx = 0; xx < b.w; xx++) {
        var i = (yy * b.w + xx) * 4;
        var l = M ? M.lab[sy * M.w + Math.min(M.w - 1, Math.floor((b.x + xx) * M.S))] : 0;
        if (l && !b.own[l]) { if (clear) p[i + 3] = 0; else { p[i] = p[i + 1] = p[i + 2] = 0; } continue; }
        if (clear) {
          var m = Math.max(p[i], p[i + 1], p[i + 2]);
          if (m < 26) p[i + 3] = 0; else if (m < 64) p[i + 3] = Math.round(p[i + 3] * (m - 26) / 38);
        }
      }
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  function splitter(el, api, done) {
    el.innerHTML = '<div class="card"><h3>Split a logo sheet</h3><p class="small dim">One picture with lots of logos on black (like the sheet from your flyer designer). Each logo is cut out on its own, and its name and type are read for you. Fix any that came out wrong, then add them.</p>' +
      '<input type="file" id="sheetFile" accept="image/png,image/jpeg" aria-label="Logo sheet image">' +
      '<div class="checks"><label><input type="checkbox" id="sheetClear" checked> Make the black around each logo see-through</label></div>' +
      '<div class="msg" id="sheetMsg" role="status"></div><div id="sheetOut"></div></div>';
    var img = null, boxes = [], names = [], kinds = [], reading = false;
    var escA = function (t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    // What's typed or picked survives a redraw (ticking the see-through box redraws the cut-outs).
    function keep() {
      boxes.forEach(function (b, i) { var n = el.querySelector('[data-name="' + i + '"]'), k = el.querySelector('[data-kind="' + i + '"]'); if (n) names[i] = n.value; if (k) kinds[i] = k.value; });
    }
    /** Reads every cut-out's name and type (the food side's AI) and fills them in, without touching anything typed. */
    function readNames() {
      var clear = document.getElementById('sheetClear').checked, msg = document.getElementById('sheetMsg');
      reading = true; draw();
      Promise.all(boxes.slice(0, 16).map(function (b) {
        return toBlob(cut(img, b, clear)).then(function (blob) {
          return new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { ok({ type: 'image/png', data: String(fr.result).split(',')[1] }); }; fr.readAsDataURL(blob); });
        });
      })).then(function (files) { return api('POST', '/logo-read', { files: files }); }).then(function (r) {
        reading = false; keep();
        if (!r.ok) { draw(); msg.className = 'msg bad'; msg.textContent = (r.d.error || 'Couldn’t read the names') + ' Type them in.'; return; }
        (r.d.logos || []).forEach(function (l, i) { if (!names[i] && l.name) names[i] = l.name; if (l.kind) kinds[i] = l.kind; });
        draw(); msg.className = 'msg ok'; msg.textContent = 'Found ' + boxes.length + ' logos and read their names. Check them, fix any that are off, untick any that came out wrong.';
      });
    }
    function draw() {
      var clear = document.getElementById('sheetClear').checked;
      var out = document.getElementById('sheetOut');
      if (!img) { out.innerHTML = ''; return; }
      out.innerHTML = '<div class="kit" style="margin-top:12px">' + boxes.map(function (b, i) {
        return '<figure><div class="art" data-slot="' + i + '"></div>' +
          '<label class="checks" style="margin:0"><input type="checkbox" data-keep="' + i + '" checked> Keep</label>' +
          '<input data-name="' + i + '" maxlength="60" placeholder="' + (reading ? 'Reading…' : 'Name') + '" aria-label="Logo name" style="min-height:40px" value="' + escA(names[i] || '') + '">' +
          '<select data-kind="' + i + '" aria-label="Type" style="min-height:40px">' + [['vendor', 'Food vendor'], ['group', 'Club'], ['sponsor', 'Vendor (not food)'], ['title', 'Meet title']].map(function (o) {
            return '<option value="' + o[0] + '"' + ((kinds[i] || 'vendor') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></figure>';
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
        img = i; boxes = findLogos(i); names = []; kinds = [];
        msg.className = 'msg ' + (boxes.length ? 'ok' : 'bad');
        msg.textContent = boxes.length ? 'Found ' + boxes.length + ' logos. Reading their names…' : 'No logos found. It works best with logos spread out on a black background.';
        draw();
        if (boxes.length) readNames();
      }, function () { msg.className = 'msg bad'; msg.textContent = 'That image didn’t open. Try a PNG or JPEG.'; });
    };
    document.getElementById('sheetClear').onchange = function () { keep(); draw(); };
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

  // How much of the flyer's height the main picture takes.
  function picFrac(size) { return size === 'story' ? 0.5 : 0.42; }
  // Where a placed logo sits, in flyer pixels: its center (fx, fy) and width (fw) are fractions of the flyer.
  function placedBox(p, W, H) {
    var dw = p.fw * W, dh = dw * p.im.naturalHeight / p.im.naturalWidth;
    return { x: p.fx * W - dw / 2, y: p.fy * H - dh / 2, w: dw, h: dh };
  }
  // opt.sel: the id of the logo being moved (outlined in the preview only, never in the saved flyer).
  function render(c, s, opt) {
    var W = SIZES[s.size][0], H = SIZES[s.size][1], g = c.getContext('2d');
    c.width = W; c.height = H;
    g.fillStyle = '#05040a'; g.fillRect(0, 0, W, H);
    // 1. The main picture, filling the top, fading into the night.
    var picH = Math.round(H * picFrac(s.size));
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
    // 4. Logo rows: car groups (two rows when there are many), filling what's left.
    var rows = [];
    if (s.groups.length > 6) { var half = Math.ceil(s.groups.length / 2); rows.push(s.groups.slice(0, half), s.groups.slice(half)); } else if (s.groups.length) rows.push(s.groups);
    if (rows.length) {
      var room = H - y - H * 0.035, gap = H * 0.02, rowH = Math.min(H * 0.11, (room - gap * (rows.length - 1)) / rows.length);
      var cy = y + rowH / 2 + (room - (rowH * rows.length + gap * (rows.length - 1))) / 2;
      rows.forEach(function (r) { logoRow(g, r, cy, W, rowH, W * 0.025); cy += rowH + gap; });
    }
    // 5. The vendors, each where the host put it, on top of everything.
    (s.placed || []).forEach(function (p) {
      var b = placedBox(p, W, H);
      g.save(); g.shadowColor = 'rgba(0,0,0,.75)'; g.shadowBlur = 24; g.drawImage(p.im, b.x, b.y, b.w, b.h); g.restore();
      if (opt && opt.sel === p.id) {
        g.save(); g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.setLineDash([16, 10]);
        g.strokeRect(b.x - 10, b.y - 10, b.w + 20, b.h + 20); g.restore();
      }
    });
  }
  // A free spot for a new vendor logo, so several vendors spread out instead of piling up: the first open spot over
  // the main picture (middle, left, right, then a second row), else below it, else wherever is farthest from the rest.
  function freeSpot(s) {
    var W = SIZES[s.size][0], H = SIZES[s.size][1], pf = picFrac(s.size), spots = [];
    [[0.5, 0.3], [0.2, 0.3], [0.8, 0.3], [0.35, 0.64], [0.65, 0.64], [0.15, 0.64], [0.85, 0.64]].forEach(function (t) { spots.push([t[0], pf * t[1]]); });
    [[0.5, 0.92], [0.2, 0.92], [0.8, 0.92]].forEach(function (t) { spots.push(t); });
    var gap = function (sp) { return s.placed.length ? Math.min.apply(null, s.placed.map(function (p) { return Math.hypot((sp[0] - p.fx) * W, (sp[1] - p.fy) * H); })) : Infinity; };
    for (var i = 0; i < spots.length; i++) if (gap(spots[i]) >= W * 0.24) return spots[i];
    var best = spots[0], bd = -1;
    spots.forEach(function (sp) { var d = gap(sp); if (d > bd) { bd = d; best = sp; } });
    return best;
  }
  // A logo's width, kept so it's never taller than an eighth of the flyer.
  function fitWidth(im, fw, size) {
    var W = SIZES[size][0], H = SIZES[size][1], maxH = H * 0.13;
    return Math.max(0.06, Math.min(fw, maxH / (im.naturalHeight / im.naturalWidth) / W));
  }
  function hexA(hex, a) { var m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || [0, 'c9adff']; var n = parseInt(m[1], 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; }

  function maker(el, o) {
    var api = o.api, m = o.meet, me = o.me;
    var s = { size: 'post', pic: null, title: null, date: m.flyerDate, time: m.flyerTime, place: m.address || m.place, promo: '', placed: [], groups: [], accent: me.accent || '#c9adff', hostName: me.name };
    var sel = null, drag = null;
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
      '<p class="small dim" style="margin:0 0 8px">Tap a vendor in step 3 to put it on the flyer, then drag it where you want it.</p>' +
      '<canvas id="fmCanvas" style="width:100%;max-width:420px;border-radius:12px;border:1px solid var(--line);display:block;cursor:grab"></canvas>' +
      '<div id="fmEdit" hidden style="max-width:420px"><label for="fmSize">Size of <b id="fmSelName"></b></label><input type="range" id="fmSize" min="6" max="70" step="1" style="padding:0;min-height:32px">' +
      '<div class="bar" style="margin-top:6px"><button class="btn sm" data-remove>Take it off the flyer</button><button class="btn sm" data-done>Done</button></div></div>' +
      '<div class="bar"><button class="btn go" id="fmSave">Use as this meet’s flyer</button><a class="btn" id="fmDown" download="flyer.png">Download</a></div><div class="msg" id="fmMsg" role="status"></div></div>';
    var canvas = el.querySelector('#fmCanvas'), kit = [], imgs = {};
    var redraw = function () { render(canvas, s, { sel: sel }); syncEdit(); };
    // The saved or downloaded flyer: drawn once without the outline, then the preview comes back.
    var clean = function (use) { render(canvas, s); try { return use(); } finally { redraw(); } };
    function syncEdit() {
      var p = s.placed.filter(function (x) { return x.id === sel; })[0], box = el.querySelector('#fmEdit');
      if (!box) return;
      box.hidden = !p;
      if (p) { el.querySelector('#fmSelName').textContent = p.name; el.querySelector('#fmSize').value = String(Math.round(p.fw * 100)); }
      el.querySelectorAll('[data-place]').forEach(function (b) { b.setAttribute('aria-pressed', String(s.placed.some(function (x) { return x.id === b.getAttribute('data-place'); }))); });
    }
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
        if (kind === 'vendor') {
          return '<p class="small" style="margin:10px 0 6px">' + label + ': tap to put one on the flyer, tap again to take it off</p><div class="vpick">' + list.map(function (l) {
            return '<button type="button" data-place="' + l.id + '" aria-pressed="false"><span class="art"><img src="' + esc(l.url) + '" alt=""></span><span>' + esc(l.name) + '</span></button>';
          }).join('') + '</div>';
        }
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
      if (t.id === 'fmSize') return;
      if (t.hasAttribute && t.hasAttribute('data-pick')) {
        var id = t.getAttribute('data-pick'), l = kit.filter(function (k) { return String(k.id) === id; })[0];
        var go = function () { s.groups = picked('group'); redraw(); };
        if (t.checked && !imgs[id] && l) loadImage(l.url).then(function (im) { imgs[id] = im; go(); }); else go();
      }
    });
    el.addEventListener('input', function (e) {
      if (e.target.id === 'fmSize') {
        var p = s.placed.filter(function (x) { return x.id === sel; })[0];
        if (p) { p.fw = fitWidth(p.im, (parseInt(e.target.value, 10) || 20) / 100, s.size); redraw(); }
        return;
      }
      var map = { fmDate: 'date', fmTime: 'time', fmPlace: 'place', fmPromo: 'promo' };
      if (map[e.target.id]) { s[map[e.target.id]] = e.target.value; redraw(); }
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-size]');
      if (b) { s.size = b.getAttribute('data-size'); el.querySelectorAll('[data-size]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); redraw(); return; }
      if (e.target.closest('[data-back]')) { o.back(); return; }
      var pb = e.target.closest('[data-place]');
      if (pb) { togglePlace(pb.getAttribute('data-place')); return; }
      if (e.target.closest('[data-remove]')) { s.placed = s.placed.filter(function (x) { return x.id !== sel; }); sel = null; redraw(); return; }
      if (e.target.closest('[data-done]')) { sel = null; redraw(); return; }
      if (e.target.id === 'fmDown') { e.target.href = clean(function () { return canvas.toDataURL('image/png'); }); e.target.download = (me.slug || 'flyer') + '-' + m.day + '.png'; return; }
      if (e.target.id === 'fmSave') {
        var msg = el.querySelector('#fmMsg'); msg.className = 'msg ok'; msg.textContent = 'Saving…';
        sel = null; redraw(); // no outline in the saved flyer
        canvas.toBlob(function (blob) {
          api('POST', '/meets/' + m.id + '/flyer', null, new File([blob], 'flyer.png', { type: 'image/png' })).then(function (r) {
            msg.className = 'msg ' + (r.ok ? 'ok' : 'bad'); msg.textContent = r.ok ? 'Saved. It’s on the meet’s page now.' : (r.d.error || 'Didn’t save.');
          });
        }, 'image/png');
      }
    });

    // A vendor's logo onto the flyer (at a free spot) or off it again.
    function togglePlace(id) {
      if (s.placed.some(function (x) { return x.id === id; })) {
        s.placed = s.placed.filter(function (x) { return x.id !== id; }); if (sel === id) sel = null; redraw(); return;
      }
      var l = kit.filter(function (k) { return String(k.id) === id; })[0];
      if (!l) return;
      var put = function (im) {
        if (s.placed.some(function (x) { return x.id === id; })) return;
        var spot = freeSpot(s);
        s.placed.push({ id: id, name: l.name, im: im, fx: spot[0], fy: spot[1], fw: fitWidth(im, 0.26, s.size) });
        sel = id; redraw();
      };
      if (imgs[id]) put(imgs[id]); else loadImage(l.url).then(function (im) { imgs[id] = im; put(im); }, function () {});
    }
    // Dragging a placed logo around the preview (finger or mouse). Touching the flyer anywhere else scrolls as usual.
    function at(e) {
      var r = canvas.getBoundingClientRect(), W = SIZES[s.size][0], H = SIZES[s.size][1];
      return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height, W: W, H: H };
    }
    function hit(pt) {
      var slack = pt.W * 0.02;
      for (var i = s.placed.length - 1; i >= 0; i--) {
        var b = placedBox(s.placed[i], pt.W, pt.H);
        if (pt.x >= b.x - slack && pt.x <= b.x + b.w + slack && pt.y >= b.y - slack && pt.y <= b.y + b.h + slack) return s.placed[i];
      }
      return null;
    }
    canvas.addEventListener('touchstart', function (e) { var t = e.touches[0]; if (t && hit(at(t))) e.preventDefault(); }, { passive: false });
    canvas.addEventListener('touchmove', function (e) { if (drag) e.preventDefault(); }, { passive: false });
    canvas.addEventListener('pointerdown', function (e) {
      var pt = at(e), p = hit(pt);
      if (!p) { if (sel) { sel = null; redraw(); } return; }
      s.placed = s.placed.filter(function (x) { return x !== p; }).concat([p]); // the one touched comes to the front
      sel = p.id; drag = { p: p, dx: pt.x - p.fx * pt.W, dy: pt.y - p.fy * pt.H };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
      canvas.style.cursor = 'grabbing'; redraw();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var pt = at(e);
      drag.p.fx = Math.max(0.02, Math.min(0.98, (pt.x - drag.dx) / pt.W));
      drag.p.fy = Math.max(0.02, Math.min(0.98, (pt.y - drag.dy) / pt.H));
      redraw();
    });
    var stop = function () { drag = null; canvas.style.cursor = 'grab'; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }

  window.Flyer = { splitter: splitter, maker: maker, findLogos: findLogos, cut: cut, render: render, freeSpot: freeSpot };
})();
