/* member-edit.js — the editor for one club member's page (/@handle). The member opens it from their link (the key is
   after the # so it never shows in a server log), and the host gets the same editor in the portal (Members), plus the
   club and the page name. Photos are shrunk on the phone before they're sent (a weak signal at a meet), one at a time. */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function mount(box, o) {
    var id = o.id, key = o.key || '', host = !!o.host, m = null, poll = null, busy = false;
    var base = '/api/host/members/' + id;
    function call(method, url, body, raw) {
      var h = {}; if (key) h['X-Member-Key'] = key;
      var opt = { method: method, headers: h, cache: 'no-store', credentials: 'same-origin' };
      if (raw) { h['Content-Type'] = raw.type || 'image/jpeg'; opt.body = raw; }
      else if (body) { h['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      return fetch(base + url, opt).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
      }).catch(function () { return { ok: false, d: { error: 'No connection. Try again.' } }; });
    }
    function say(sel, t, ok) { var el = box.querySelector(sel); if (el) { el.className = 'msg ' + (ok ? 'ok' : 'bad'); el.textContent = t || ''; } }

    function draw() {
      var v = m.video || {};
      var clubs = o.clubs || [];
      box.innerHTML =
        '<div class="card"><h3>' + (host ? 'Their page' : 'Your page') + '</h3>' +
        '<p class="small dim">' + (host ? 'Start it here, then text them their link to finish it.' : 'Everything here shows on your page. Save when you’re done.') + ' <a href="' + esc(m.url) + '" target="_blank" rel="noopener">See the page</a></p>' +
        '<form data-me-form>' +
        '<label for="meName">Name</label><input id="meName" name="name" maxlength="60" required value="' + esc(m.name) + '">' +
        (host ? '<label for="meHandle">Page name</label><div class="suffix"><span>@</span><input id="meHandle" name="handle" maxlength="40" autocapitalize="off" autocorrect="off" spellcheck="false" value="' + esc(m.handle) + '"></div>' +
          '<label for="meClub">Club</label><select id="meClub" name="clubId"><option value="">None</option>' + clubs.map(function (c) { return '<option value="' + c.id + '"' + (c.id === m.clubId ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select>' : '') +
        '<label for="meCar">Car</label><input id="meCar" name="car" maxlength="80" placeholder="2021 BMW M3 Competition" value="' + esc(m.car) + '">' +
        '<label for="meIg">Instagram</label><input id="meIg" name="instagram" maxlength="60" autocapitalize="off" placeholder="@yourname" value="' + esc(m.instagram) + '">' +
        '<label for="meMods">The build (one mod per line)</label><textarea id="meMods" name="mods" maxlength="1200" rows="5" placeholder="Stage 2 tune\nCarbon hood\nAir lift suspension">' + esc(m.mods) + '</textarea>' +
        '<label for="meAbout">About</label><textarea id="meAbout" name="about" maxlength="600" rows="3" placeholder="How the car came together, where you take it.">' + esc(m.about) + '</textarea>' +
        '<div class="bar"><button class="btn go" type="submit">Save</button></div><div class="msg" data-me-msg role="status"></div></form></div>' +

        '<div class="card"><h3>Top of the page</h3><p class="small dim">What sits at the top, right on the footage (like a meet page). Turn your name off for more room for the footage.</p>' +
        '<div class="me-heads">' +
          (m.clubLogo ? headBtn('club', 'My club’s logo', '<img src="' + esc(m.clubLogo) + '" alt="">') : '') +
          (m.headerLogo ? headBtn('logo', 'My logo', '<img src="' + esc(m.headerLogo) + '" alt="">') : '') +
          headBtn('name', 'Just my name', '<span class="me-h-name">' + esc(m.name.split(' ')[0]) + '</span>') +
        '</div>' +
        '<label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" data-me-showname style="width:auto"' + (m.showName ? ' checked' : '') + '> Show my name on the page</label>' +
        '<label class="btn sm" style="display:inline-block">' + (m.headerLogo ? 'Upload a different logo' : 'Upload a logo') + '<input type="file" accept="image/png,image/jpeg" hidden data-me-head></label>' +
        '<p class="small dim" style="margin:6px 0 0">A PNG with a see-through background looks best; a black square around it is trimmed off.</p>' +
        '<div class="msg" data-me-hmsg role="status"></div></div>' +
        '<div class="card"><h3>Background clip</h3><p class="small dim">Plays behind the whole page, silent and on repeat. Any clip from your phone: it becomes a 15-second loop.</p>' +
        (v.status === 'ready' ? '<img src="' + esc(v.thumb || v.poster) + '" alt="" style="width:100%;border-radius:8px;margin:6px 0">' : '') +
        (v.status === 'processing' ? '<p class="msg ok">Processing. It shows on the page in a minute or two.</p>' : '') +
        (v.status === 'failed' ? '<p class="msg bad">' + esc(v.error || 'That video didn’t work. Try another clip.') + '</p>' : '') +
        (m.videoReady ? '<input type="file" accept="video/*" data-me-video aria-label="Choose a video">' : '<p class="small dim">Clips aren’t set up on the server yet.</p>') +
        '<div class="msg" data-me-vmsg role="status"></div>' +
        (v.status === 'ready' || v.status === 'failed' ? '<div class="bar"><button class="btn sm" type="button" data-me-vdrop>Remove clip</button></div>' : '') + '</div>' +

        '<div class="card"><h3>The feed</h3><p class="small dim">Photos and clips, shown one after another below the top of the page, newest first. Clips play on their own as you scroll, silent, up to 15 seconds each. Up to ' + m.maxPhotos + ' in all.</p>' +
        (m.photos.length < m.maxPhotos ? '<div class="bar"><label class="btn go sm" style="display:inline-block">Add photos<input type="file" accept="image/*" multiple hidden data-me-photos></label>' +
          (m.videoReady ? '<label class="btn sm" style="display:inline-block">Add a clip<input type="file" accept="video/*" hidden data-me-clip></label>' : '') + '</div>' : '') +
        '<div class="msg" data-me-pmsg role="status"></div>' +
        '<div class="me-photos">' + m.photos.slice().reverse().map(function (p) {
          var face = p.kind === 'video'
            ? (p.status === 'ready' ? '<div class="me-clip"><img src="' + esc(p.thumb) + '" alt="" loading="lazy"><span aria-hidden="true">▶</span></div>'
              : '<div class="me-clip wait"><span class="small">' + (p.status === 'failed' ? 'That clip didn’t work' : 'Processing…') + '</span></div>')
            : '<img src="' + esc(p.url) + '" alt="" loading="lazy">';
          return '<figure>' + face + '<input data-me-cap="' + p.id + '" maxlength="120" placeholder="Caption" value="' + esc(p.caption) + '" aria-label="Caption">' +
            '<button class="btn sm" type="button" data-me-pdel="' + p.id + '">Remove</button></figure>';
        }).join('') + '</div></div>';
      clearTimeout(poll);
      var waiting = v.status === 'processing' || m.photos.some(function (p) { return p.status === 'processing'; });
      if (waiting) poll = setTimeout(load, 6000);
    }
    function headBtn(kind, label, art) {
      return '<button type="button" data-me-headpick="' + kind + '" aria-pressed="' + (m.header === kind) + '"><span class="art">' + art + '</span><span class="small">' + label + '</span></button>';
    }
    function firstPhoto() { var p = m.photos.filter(function (x) { return x.kind !== 'video' || x.thumb; })[0]; return p ? (p.kind === 'video' ? p.thumb : p.url) : ''; }
    function load() { call('GET', '').then(function (r) { if (!r.ok) { box.innerHTML = '<p class="msg bad">' + esc(r.d.error) + '</p>'; return; } m = r.d.member; draw(); }); }

    box.addEventListener('submit', function (e) {
      if (!e.target.hasAttribute('data-me-form')) return;
      e.preventDefault();
      var f = e.target.elements, body = { name: f.name.value.trim(), car: f.car.value.trim(), instagram: f.instagram.value.trim(), mods: f.mods.value, about: f.about.value };
      if (host) { body.handle = f.handle.value.trim().toLowerCase(); body.clubId = f.clubId.value ? +f.clubId.value : null; }
      call('PUT', '', body).then(function (r) { if (!r.ok) return say('[data-me-msg]', r.d.error); m = r.d.member; draw(); say('[data-me-msg]', 'Saved.', true); if (o.saved) o.saved(m); });
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-me-pdel')) {
        if (!confirm('Remove this photo?')) return;
        call('DELETE', '/photos/' + b.getAttribute('data-me-pdel')).then(function (r) { if (r.ok) { m = r.d.member; draw(); } });
      } else if (b.hasAttribute('data-me-headpick')) {
        call('PUT', '', { header: b.getAttribute('data-me-headpick') }).then(function (r) { if (r.ok) { m = r.d.member; draw(); } });
      } else if (b.hasAttribute('data-me-vdrop')) {
        call('DELETE', '/video').then(function (r) { if (r.ok) { m = r.d.member; draw(); } });
      }
    });
    box.addEventListener('change', function (e) {
      if (e.target.hasAttribute('data-me-showname')) {
        call('PUT', '', { showName: e.target.checked }).then(function (r) { if (r.ok) { m = r.d.member; draw(); } });
        return;
      }
      var t = e.target;
      if (t.hasAttribute('data-me-cap')) { call('PUT', '/photos/' + t.getAttribute('data-me-cap'), { caption: t.value.trim() }); return; }
      if (t.hasAttribute('data-me-video') && t.files[0]) return sendVideo(t, '/video', '[data-me-vmsg]');
      if (t.hasAttribute('data-me-head') && t.files[0]) {
        say('[data-me-hmsg]', 'Uploading…', true);
        call('POST', '/header', null, t.files[0]).then(function (r) { if (!r.ok) return say('[data-me-hmsg]', r.d.error); m = r.d.member; draw(); });
        return;
      }
      if (t.hasAttribute('data-me-clip') && t.files[0]) return sendVideo(t, '/clips', '[data-me-pmsg]');
      if (t.hasAttribute('data-me-photos') && t.files.length) return sendPhotos(Array.prototype.slice.call(t.files, 0, m.maxPhotos - m.photos.length));
    });

    function sendVideo(input, where, msg) {
      var f = input.files[0];
      if (f.size > 400 * 1024 * 1024) return say(msg, 'That video is over 400 MB. Trim it on your phone first.');
      var x = new XMLHttpRequest();
      x.open('POST', base + where);
      x.setRequestHeader('Content-Type', f.type || 'video/mp4');
      if (key) x.setRequestHeader('X-Member-Key', key);
      x.upload.onprogress = function (ev) { if (ev.lengthComputable) say(msg, 'Uploading… ' + Math.round(ev.loaded / ev.total * 100) + '%', true); };
      x.onload = function () { var d = {}; try { d = JSON.parse(x.responseText); } catch (er) {} if (x.status >= 400) return say(msg, d.error || 'The upload didn’t go through.'); load(); };
      x.onerror = function () { say(msg, 'The upload stopped. Try again on a stronger signal.'); };
      input.disabled = true; x.send(f);
    }
    /** A photo at most 2000 px on its long side, as a JPEG: a few hundred KB instead of several MB. */
    function shrink(file) {
      return new Promise(function (ok) {
        if (!window.createImageBitmap || !/^image\//.test(file.type)) return ok(file);
        createImageBitmap(file).then(function (bmp) {
          var k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
          var c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
          c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          c.toBlob(function (b) { ok(b || file); }, 'image/jpeg', 0.86);
        }).catch(function () { ok(file); });
      });
    }
    function sendPhotos(files) {
      if (busy) return; busy = true;
      var i = 0, failed = 0;
      (function next() {
        if (i >= files.length) { busy = false; load(); if (failed) setTimeout(function () { say('[data-me-pmsg]', failed + ' didn’t go through. Try those again.'); }, 300); return; }
        say('[data-me-pmsg]', 'Uploading ' + (i + 1) + ' of ' + files.length + '…', true);
        shrink(files[i]).then(function (blob) {
          if (blob.size > 8 * 1024 * 1024) { failed++; i++; return next(); }
          call('POST', '/photos', null, blob).then(function (r) { if (!r.ok) failed++; i++; next(); });
        });
      })();
    }
    load();
  }
  window.MemberEditor = { mount: mount };

  // On the member's own edit page: the key from the link.
  var page = document.getElementById('memberEditor');
  if (page) {
    var h = /^#(\d+)\.([a-f0-9]{40})$/.exec(location.hash || '');
    if (!h || h[1] !== page.getAttribute('data-id')) { page.innerHTML = '<p class="msg bad">This link is missing its key. Open the whole link you were texted.</p>'; return; }
    mount(page, { id: +h[1], key: h[2] });
  }
})();
