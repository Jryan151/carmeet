/* club-edit.js — the club's own editor, opened from the link they got when they claimed their page (the key is after
   the #, so it's never in a request line or a log). Their name, Instagram, line and color; their logo and clip; and
   their members: add one, text each their link to finish their page, take one off. No account. */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var box = document.getElementById('clubEditor'); if (!box) return;
  var h = String(location.hash || '').replace(/^#/, '').split('.');
  var id = +box.getAttribute('data-id'), key = h[1] || '';
  if (+h[0] !== id || !/^[a-f0-9]{40}$/.test(key)) { box.innerHTML = '<p class="msg bad">This link is missing its key. Open the link from your email, or get a new one on your club’s page.</p>'; return; }
  var c = null, colors = [], links = {}, poll = null;
  function call(method, url, body, raw) {
    var o = { method: method, cache: 'no-store', headers: { 'X-Club-Key': key } };
    if (raw) { o.headers['Content-Type'] = raw.type; o.body = raw; } else if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch('/api/host/club-edit/' + id + url, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .catch(function () { return { ok: false, d: { error: 'No connection. Try again.' } }; });
  }
  function say(sel, t, ok) { var el = box.querySelector(sel); if (el) { el.className = 'msg ' + (ok ? 'ok' : 'bad'); el.textContent = t || ''; } }
  function load() { call('GET', '').then(function (r) { if (!r.ok) { box.innerHTML = '<p class="msg bad">' + esc(r.d.error) + '</p>'; return; } c = r.d.club; draw(); }); }

  function draw() {
    var v = c.video || {};
    var sw = colors.slice(); if (c.accent && sw.indexOf(c.accent) < 0) sw.unshift(c.accent);
    box.innerHTML =
      '<div class="card"><h3>Your page</h3><p class="small dim"><a href="' + esc(c.url) + '" target="_blank" rel="noopener">See it</a>. Keep this link to yourself: it edits the page.</p>' +
      '<form data-ce-form><label for="ceName">Club name</label><input id="ceName" name="name" maxlength="60" required value="' + esc(c.name) + '">' +
      '<label for="ceIg">Instagram</label><input id="ceIg" name="instagram" maxlength="60" autocapitalize="off" value="' + esc(c.instagram) + '">' +
      '<label for="ceLine">A line under the logo</label><input id="ceLine" name="tagline" maxlength="80" placeholder="Phoenix · Est. 2019" value="' + esc(c.tagline) + '">' +
      (sw.length ? '<label>Color</label><div class="swatches">' + sw.map(function (x) { return '<button type="button" data-ce-color="' + esc(x) + '" aria-pressed="' + (x === c.accent) + '" style="background:' + esc(x) + '" aria-label="' + esc(x) + '"></button>'; }).join('') + '</div>' : '') +
      '<div class="bar"><button class="btn go" type="submit">Save</button></div><div class="msg" data-ce-msg role="status"></div></form></div>' +

      '<div class="card"><h3>Logo</h3>' + (c.logo ? '<img class="club-logo" src="' + esc(c.thumb || c.logo) + '" alt="">' : '') +
      '<label class="btn sm" style="display:inline-block">' + (c.logo ? 'Use a different logo' : 'Upload your logo') + '<input type="file" accept="image/png,image/jpeg" hidden data-ce-logo></label>' +
      '<p class="small dim" style="margin:6px 0 0">A black square around it is trimmed off. The page’s color comes from it.</p><div class="msg" data-ce-lmsg role="status"></div></div>' +

      '<div class="card"><h3>Background clip</h3><p class="small dim">Plays behind the whole page, silent and on repeat. Any clip from your phone: it becomes a 15-second loop.</p>' +
      (v.status === 'ready' ? '<img src="' + esc(v.thumb || v.poster) + '" alt="" style="width:100%;max-height:260px;object-fit:cover;border-radius:8px;margin:6px 0">' : '') +
      (v.status === 'processing' ? '<p class="msg ok">Processing. It shows on the page in a minute or two.</p>' : '') +
      (v.status === 'failed' ? '<p class="msg bad">' + esc(v.error || 'That video didn’t work. Try another clip.') + '</p>' : '') +
      (c.videoReady ? '<input type="file" accept="video/*" data-ce-video aria-label="Choose a video">' : '') + '<div class="msg" data-ce-vmsg role="status"></div></div>' +

      '<div class="card"><h3>Members</h3><p class="small dim">Each one gets their own page. Text them their link and they add their photos, a clip and their build. No account.</p>' +
      c.members.map(function (m) {
        var l = links[m.id];
        return '<div class="rowx" style="flex-wrap:wrap"><div style="min-width:0;flex:1"><div>' + esc(m.name || m.car || '@' + m.handle) + '</div><div class="small dim">@' + esc(m.handle) + (m.car && m.name ? ' · ' + esc(m.car) : '') + ' · ' + m.photos.length + ' photo' + (m.photos.length === 1 ? '' : 's') + '</div></div>' +
          '<div class="bar" style="margin:0"><button class="btn sm go" type="button" data-ce-link="' + m.id + '">Their link</button><button class="btn sm" type="button" data-ce-del="' + m.id + '">Remove</button></div>' +
          (l ? '<div style="flex-basis:100%"><div class="copybox" data-ce-text="' + m.id + '">' + esc(l.text) + '</div><div class="bar"><button class="btn sm go" type="button" data-ce-copy="' + m.id + '">Copy message</button><a class="btn sm" href="sms:?&body=' + encodeURIComponent(l.text) + '">Text it</a></div></div>' : '') + '</div>';
      }).join('') +
      (c.members.length ? '' : '<p class="dim">No members yet.</p>') +
      '<form data-ce-add><label for="ceMName">Add a member: name</label><input id="ceMName" name="name" maxlength="60" placeholder="Jay">' +
      '<label for="ceMIg">Instagram</label><input id="ceMIg" name="instagram" maxlength="60" autocapitalize="off" placeholder="@jays_m3">' +
      '<label for="ceMCar">Car</label><input id="ceMCar" name="car" maxlength="80" placeholder="2021 BMW M3">' +
      '<div class="bar"><button class="btn go" type="submit">Add</button></div><div class="msg" data-ce-amsg role="status"></div></form></div>';
    clearTimeout(poll);
    if (v.status === 'processing') poll = setTimeout(load, 6000);
  }

  box.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = e.target;
    if (f.hasAttribute('data-ce-form')) {
      call('PUT', '', { name: f.name.value.trim(), instagram: f.instagram.value.trim(), tagline: f.tagline.value.trim() }).then(function (r) {
        if (!r.ok) return say('[data-ce-msg]', r.d.error); c = r.d.club; draw(); say('[data-ce-msg]', 'Saved.', true);
      });
    } else if (f.hasAttribute('data-ce-add')) {
      call('POST', '/members', { name: f.name.value.trim(), instagram: f.instagram.value.trim(), car: f.car.value.trim() }).then(function (r) {
        if (!r.ok) return say('[data-ce-amsg]', r.d.error); c = r.d.club; draw(); say('[data-ce-amsg]', 'Added. Tap “Their link” to send it.', true);
      });
    }
  });
  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ce-color],[data-ce-link],[data-ce-copy],[data-ce-del]'); if (!b) return;
    if (b.hasAttribute('data-ce-color')) {
      call('PUT', '', { accent: b.getAttribute('data-ce-color') }).then(function (r) { if (r.ok) { c = r.d.club; document.documentElement.style.setProperty('--accent', c.accent); draw(); } });
    } else if (b.hasAttribute('data-ce-link')) {
      var mid = +b.getAttribute('data-ce-link');
      if (links[mid] && !confirm('A new link turns their last one off. Make a new one?')) return;
      call('POST', '/members/' + mid + '/link', {}).then(function (r) { if (!r.ok) return alert(r.d.error); links[mid] = r.d; draw(); });
    } else if (b.hasAttribute('data-ce-copy')) {
      var t = links[+b.getAttribute('data-ce-copy')].text;
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy message'; }, 1500); });
    } else if (b.hasAttribute('data-ce-del')) {
      if (!confirm('Take this member’s page down, with their photos?')) return;
      call('DELETE', '/members/' + b.getAttribute('data-ce-del')).then(function (r) { if (!r.ok) return alert(r.d.error); c = r.d.club; draw(); });
    }
  });
  box.addEventListener('change', function (e) {
    var i = e.target;
    if (i.hasAttribute('data-ce-logo') && i.files[0]) {
      var f = i.files[0];
      if (!/^image\/(png|jpeg)$/.test(f.type)) return say('[data-ce-lmsg]', 'Use a PNG or JPEG.');
      say('[data-ce-lmsg]', 'Uploading…', true);
      call('POST', '/logo', null, f).then(function (r) { if (!r.ok) return say('[data-ce-lmsg]', r.d.error); colors = r.d.colors || []; c = r.d.club; draw(); });
    } else if (i.hasAttribute('data-ce-video') && i.files[0]) {
      var v = i.files[0];
      if (v.size > 400 * 1024 * 1024) return say('[data-ce-vmsg]', 'That video is over 400 MB. Trim it on your phone first.');
      var x = new XMLHttpRequest();
      x.open('POST', '/api/host/club-edit/' + id + '/video');
      x.setRequestHeader('X-Club-Key', key); x.setRequestHeader('Content-Type', v.type || 'video/mp4');
      x.upload.onprogress = function (ev) { if (ev.lengthComputable) say('[data-ce-vmsg]', 'Uploading… ' + Math.round(ev.loaded / ev.total * 100) + '%', true); };
      x.onload = function () { var d = {}; try { d = JSON.parse(x.responseText); } catch (er) {} if (x.status >= 400) return say('[data-ce-vmsg]', d.error || 'The upload didn’t go through.'); load(); };
      x.onerror = function () { say('[data-ce-vmsg]', 'The upload stopped. Try again on a stronger signal.'); };
      i.disabled = true; x.send(v);
    }
  });
  load();
})();
