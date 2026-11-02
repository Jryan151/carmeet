/* prospects-admin.js — Admin › Prospects in the portal (the site owner only): build a club's page before asking them,
   in about 30 minutes, then send it. In order: screenshots of their Instagram read into the page, their logo (its
   colors become the page's), the details, a clip from the footage library, the members, a look on the phone, the DM.
   Plus the footage library: clips filmed once, tagged, used behind any club or member page.
   Uses window.Portal (portal.js) for the API and the view. */
(function () {
  'use strict';
  var P = function () { return window.Portal; };
  var esc = function (s) { return P().esc(s); };
  var $ = function (id) { return document.getElementById(id); };
  var open = null, lib = false, club = null, meets = [], aiReady = false, colors = {}, found = null, picking = null, q = '', clips = [], shots = [], timer = null, editing = null;
  var START = 'prStart:'; // when work on a prospect started (this phone), for the 30-minute clock

  function api(m, u, b, raw) { return P().api(m, u, b, raw); }
  function view(h) { P().view(h); }
  function say(el, t, ok) { P().say(el, t, ok); }
  function later(fn) { clearTimeout(timer); timer = setTimeout(function () { if (P().on('prospects')) fn(); }, 8000); }
  function minutes(id) { var t = 0; try { t = +localStorage.getItem(START + id) || 0; } catch (e) {} return t ? Math.floor((Date.now() - t) / 60000) : null; }
  function startClock(id) { try { if (!localStorage.getItem(START + id)) localStorage.setItem(START + id, String(Date.now())); } catch (e) {} }
  function chip(c) {
    if (c.claimed) return '<span class="pr-chip ok">Claimed</span>';
    return '<span class="pr-chip' + (c.daysLeft <= 5 ? ' warn' : '') + '">' + c.daysLeft + ' day' + (c.daysLeft === 1 ? '' : 's') + ' left</span>';
  }

  function draw() {
    if (lib) return drawLibrary();
    if (open) return drawOne();
    api('GET', '/prospects').then(function (r) {
      if (!r.ok) return view('<p class="msg bad">' + esc(r.d.error) + '</p>');
      aiReady = r.d.aiReady; meets = r.d.meets || [];
      var list = r.d.clubs;
      var html = '<div class="card"><h3>New club page</h3><p class="small dim">Build a club’s page before you ask them: their logo, your footage, a couple of members. They get one link and “Make it ours”. Aim for 30 minutes.</p>' +
        '<form id="prNew"><label for="prName">Club name</label><input id="prName" maxlength="60" required placeholder="Unforsaken">' +
        '<label for="prIg">Their Instagram</label><input id="prIg" maxlength="60" autocapitalize="off" placeholder="@unforsaken.az">' +
        '<div class="bar"><button class="btn go" type="submit">Start the page</button><button class="btn" type="button" data-pr-lib>Footage library</button></div><div class="msg" id="prMsg" role="status"></div></form></div>';
      if (list.length) {
        html += '<div class="card pr-list"><h3>Club pages</h3>' + list.map(function (c) {
          var mins = c.claimed ? null : minutes(c.id);
          return '<div class="rowx"><div style="display:flex;gap:10px;align-items:center;min-width:0"><div class="ent-face">' + (c.thumb ? '<img src="' + esc(c.thumb) + '" alt="">' : '🚗') + '</div>' +
            '<div style="min-width:0"><div>' + esc(c.name) + '</div><div class="tag">' + chip(c) + ' · ' + c.members + ' member' + (c.members === 1 ? '' : 's') + (mins !== null ? ' · ⏱ ' + mins + ' min' : '') + '</div></div></div>' +
            '<button class="btn sm" data-pr-open="' + c.id + '">Open</button></div>';
        }).join('') + '</div>';
      }
      html += '<p class="small dim">Until a club claims it, its page and member pages are unlisted, never in search, and deleted after 30 days. Take one down any time someone asks.</p>';
      view(html);
      $('prNew').onsubmit = function (e) {
        e.preventDefault();
        api('POST', '/prospects', { name: $('prName').value.trim(), instagram: $('prIg').value.trim() }).then(function (r2) {
          if (!r2.ok) { if (r2.d.id) { open = r2.d.id; return draw(); } return say($('prMsg'), r2.d.error); }
          open = r2.d.club.id; club = r2.d.club; startClock(open); found = null; shots = []; draw();
        });
      };
    });
  }

  /* ---------- one prospect, top to bottom in the order of the 30 minutes ---------- */
  function drawOne() {
    var go = function (r) {
      if (!r.ok) { open = null; return draw(); }
      club = r.d.club; render();
    };
    Promise.all([api('GET', '/prospects/' + open), meets.length ? Promise.resolve(null) : api('GET', '/prospects')]).then(function (rs) {
      if (rs[1] && rs[1].ok) { meets = rs[1].d.meets || []; aiReady = rs[1].d.aiReady; }
      go(rs[0]);
    });
  }
  function render() {
    var c = club, v = c.video || {}, mins = c.claimed ? null : minutes(c.id);
    var sw = (colors[c.id] || []).slice(); if (c.accent && sw.indexOf(c.accent) < 0) sw.unshift(c.accent);
    var html = '<p class="small"><button class="link" data-pr-back>All club pages</button></p>' +
      '<div class="card"><h3 style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + esc(c.name) + ' ' + chip(c) + (mins !== null ? ' <span class="pr-chip' + (mins > 30 ? ' warn' : '') + '">⏱ ' + mins + ' min</span>' : '') + '</h3>' +
      '<p class="small dim"><a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.url.replace(/^https?:\/\//, '')) + '</a>' + (c.claimed ? ' · claimed with ' + esc(c.claimEmail) : '') + '</p></div>' +
      '<div class="pr-steps">';

    // 1. Screenshots → details and members.
    html += '<div class="card"><h3>Screenshots</h3><p class="small dim">Their profile and 2–4 posts with members tagged. The name, a line and the members with their cars are read from them. You check everything before it goes on the page.</p>' +
      (aiReady ? '<label class="btn go sm" style="display:inline-block">Choose screenshots<input type="file" accept="image/*" multiple hidden data-pr-shots></label>'
        : '<p class="msg bad">Reading needs ANTHROPIC_API_KEY in the server’s .env (the same key Online Kitchen uses). Type the details below for now.</p>') +
      (shots.length ? '<div class="pr-shots">' + shots.map(function (s) { return '<img src="' + s + '" alt="">'; }).join('') + '</div>' : '') +
      '<div class="msg" id="prReadMsg" role="status"></div>' + (found ? foundHtml() : '') + '</div>';

    // 2. Logo and color.
    html += '<div class="card"><h3>Logo and color</h3>' + (c.logo ? '<img src="' + esc(c.thumb || c.logo) + '" alt="" style="width:120px;max-height:120px;object-fit:contain;display:block;margin:6px 0">' : '') +
      '<label class="btn sm" style="display:inline-block">' + (c.logo ? 'Different logo' : 'Upload their logo') + '<input type="file" accept="image/png,image/jpeg" hidden data-pr-logo></label>' +
      '<p class="small dim" style="margin:6px 0 0">A screenshot of their profile picture works. A black square around it is trimmed off.</p>' +
      (sw.length ? '<p class="small" style="margin:10px 0 0">The page’s color, from their logo:</p><div class="swatches" style="margin-top:6px">' + sw.map(function (x) {
        return '<button type="button" data-pr-color="' + esc(x) + '" aria-pressed="' + (x === c.accent) + '" style="background:' + esc(x) + '" aria-label="' + esc(x) + '"></button>'; }).join('') + '</div>' : '') +
      '<div class="msg" id="prLogoMsg" role="status"></div></div>';

    // 3. Details.
    html += '<div class="card"><h3>Details</h3><form id="prDetails">' +
      '<label for="pdName">Club name</label><input id="pdName" maxlength="60" required value="' + esc(c.name) + '">' +
      '<label for="pdIg">Instagram</label><input id="pdIg" maxlength="60" autocapitalize="off" value="' + esc(c.instagram) + '">' +
      '<label for="pdLine">A line under the logo</label><input id="pdLine" maxlength="80" placeholder="Phoenix · Est. 2019" value="' + esc(c.tagline) + '">' +
      '<label for="pdSlug">Page address</label><div class="suffix"><span>/c/</span><input id="pdSlug" maxlength="40" autocapitalize="off" value="' + esc(c.slug) + '"></div>' +
      '<label for="pdMeet">Their next meet (optional)</label><select id="pdMeet"><option value="">None</option>' + meets.map(function (m) {
        return '<option value="' + m.id + '"' + (m.id === c.nextMeetId ? ' selected' : '') + '>' + esc(m.label) + '</option>'; }).join('') + '</select>' +
      '<div class="bar"><button class="btn go" type="submit">Save</button></div><div class="msg" id="prDetMsg" role="status"></div></form></div>';

    // 4. The clip.
    html += '<div class="card"><h3>Background clip</h3><p class="small dim">Your footage of them, behind the whole page.</p>' +
      (v.status === 'ready' ? '<img src="' + esc(v.thumb || v.poster) + '" alt="" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;margin:6px 0">' : '') +
      (v.status === 'processing' ? '<p class="msg ok">Processing…</p>' : '') +
      '<div class="bar"><button class="btn go sm" type="button" data-pr-pick="club">' + (v.status === 'ready' ? 'Pick a different clip' : 'Pick from your footage') + '</button>' +
      (c.footageId ? '<button class="btn sm" type="button" data-pr-unpick="club">Take it off</button>' : '') + '</div>' +
      (picking === 'club' ? pickerHtml(c.footageId) : '') + '</div>';

    // 5. Members.
    html += '<div class="card"><h3>Members</h3><p class="small dim">Two or three is plenty: a photo or two each, and a clip behind their page. They finish the rest when the club claims it.</p>' +
      c.members.map(function (m) {
        var mv = m.video || {};
        return '<div class="pr-mem"><div class="rowx" style="border:0;padding:0"><div style="min-width:0"><div>' + esc(m.name || m.car || '@' + m.handle) + '</div><div class="tag">@' + esc(m.handle) + (m.car && m.name ? ' · ' + esc(m.car) : '') + ' · ' + m.photos.length + ' photo' + (m.photos.length === 1 ? '' : 's') + (mv.status === 'ready' ? ' · clip' : '') + '</div></div>' +
          '<div class="bar" style="margin:0"><button class="btn sm" data-pr-pick="' + m.id + '">Clip</button><button class="btn sm go" data-pr-edit="' + m.id + '">' + (editing === m.id ? 'Close' : 'Photos') + '</button><button class="btn sm" data-pr-mdel="' + m.id + '" aria-label="Remove">✕</button></div></div>' +
          (picking === m.id ? pickerHtml(m.footageId, m.footageId ? m.id : null) : '') + (editing === m.id ? '<div id="prMemBox"></div>' : '') + '</div>';
      }).join('') +
      '<form id="prAdd" style="margin-top:8px"><div class="grid2"><input id="paName" maxlength="60" placeholder="Name" aria-label="Name"><input id="paIg" maxlength="60" autocapitalize="off" placeholder="@instagram" aria-label="Instagram"></div>' +
      '<input id="paCar" maxlength="80" placeholder="Car" aria-label="Car" style="margin-top:8px">' +
      '<div class="bar"><button class="btn sm" type="submit">Add a member</button></div><div class="msg" id="prAddMsg" role="status"></div></form></div>';

    // 6. Look it over.
    html += '<div class="card"><h3>Look it over on your phone</h3><p class="small dim">Open it like they will: does the logo sit right on the footage, are the car names right (a “?” is a guess), does the crew look good?</p>' +
      '<div class="bar"><a class="btn go sm" href="' + esc(c.url) + '" target="_blank" rel="noopener">Open the page</a></div></div>';

    // 7. Send.
    html += '<div class="card"><h3>Send it</h3>' + (c.claimed
      ? '<p class="small dim">They claimed it. They change it from their own link now; you can still change anything here.</p>'
      : '<p class="small dim">Change the message if you like, then copy it into their DMs. Send it to the president or whoever runs the club’s account.</p>' +
        '<textarea class="pr-dm" id="prDm">' + esc(c.dm) + '</textarea>' +
        '<div class="bar"><button class="btn go sm" type="button" data-pr-copy>Copy message</button>' + (c.instagram ? '<a class="btn sm" href="https://ig.me/m/' + encodeURIComponent(c.instagram) + '" target="_blank" rel="noopener">Open their DMs</a>' : '') + '</div>' +
        '<p class="small dim" style="margin-top:12px">' + c.daysLeft + ' day' + (c.daysLeft === 1 ? '' : 's') + ' until it comes down on its own.</p>') +
      '<div class="bar">' + (c.claimed ? '' : '<button class="btn sm" type="button" data-pr-extend>Keep it 30 more days</button>') + '<button class="btn sm" type="button" data-pr-del>Take it down</button></div></div>';

    html += '</div>';
    view(html);
    if (editing && window.MemberEditor && $('prMemBox')) window.MemberEditor.mount($('prMemBox'), { id: editing, host: true, clubs: [{ id: c.id, name: c.name }] });
    $('prDetails').onsubmit = function (e) {
      e.preventDefault();
      api('PUT', '/prospects/' + c.id, { name: $('pdName').value.trim(), instagram: $('pdIg').value.trim(), tagline: $('pdLine').value.trim(), slug: $('pdSlug').value.trim(), nextMeetId: $('pdMeet').value ? +$('pdMeet').value : null }).then(function (r) {
        if (!r.ok) return say($('prDetMsg'), r.d.error); club = r.d.club; render(); say($('prDetMsg'), 'Saved.', true);
      });
    };
    $('prAdd').onsubmit = function (e) {
      e.preventDefault();
      api('POST', '/prospects/' + c.id + '/members', { members: [{ name: $('paName').value.trim(), instagram: $('paIg').value.trim(), car: $('paCar').value.trim() }] }).then(function (r) {
        if (!r.ok) return say($('prAddMsg'), r.d.error); club = r.d.club; render();
      });
    };
    var waiting = v.status === 'processing' || c.members.some(function (m) { return (m.video || {}).status === 'processing'; });
    if (waiting) later(drawOne);
  }
  function foundHtml() {
    var f = found;
    return '<div class="pr-found" style="margin-top:10px"><p class="small" style="margin:0 0 4px">Found: tick what’s right, fix anything off.</p>' +
      '<label><input type="checkbox" data-f-detail checked><span class="fields" style="grid-template-columns:1fr"><input data-f-name value="' + esc(f.name) + '" placeholder="Club name" aria-label="Club name"><input data-f-ig value="' + esc(f.instagram) + '" placeholder="@instagram" aria-label="Instagram"><input data-f-line value="' + esc(f.tagline) + '" placeholder="A line" aria-label="A line"></span></label>' +
      f.members.map(function (m, i) {
        return '<label><input type="checkbox" data-f-mem="' + i + '"' + (m.have ? ' disabled' : i < 3 ? ' checked' : '') + '><span class="fields"><input data-f-mig="' + i + '" value="' + esc(m.instagram) + '" placeholder="@instagram" aria-label="Instagram"><input data-f-mcar="' + i + '" value="' + esc(m.car) + '" placeholder="Car" aria-label="Car">' +
          '<input data-f-mname="' + i + '" value="' + esc(m.name) + '" placeholder="Name" aria-label="Name" style="grid-column:span 2">' + (m.have ? '<span class="small dim" style="grid-column:span 2">On the page already</span>' : '') + '</span></label>';
      }).join('') +
      '<div class="bar"><button class="btn go sm" type="button" data-f-apply>Put these on the page</button><button class="btn sm" type="button" data-f-clear>Clear</button></div><div class="msg" id="prFoundMsg" role="status"></div></div>';
  }

  /* ---------- the footage picker (inside a card) and the library itself ---------- */
  function pickerHtml(current, memberId) {
    return '<div style="margin-top:10px"><input type="search" placeholder="Search tags: club, car, meet" value="' + esc(q) + '" data-pr-q aria-label="Search footage">' +
      '<div class="pr-clips" id="prClips">' + clipsHtml(current) + '</div>' + (memberId ? '<div class="bar"><button class="btn sm" type="button" data-pr-unpick="' + memberId + '">Take theirs off</button></div>' : '') +
      '<p class="small dim">Not there? <button class="link" type="button" data-pr-lib>Add it to the library</button></p></div>';
  }
  function clipsHtml(current) {
    var ready = clips.filter(function (f) { return f.video.status === 'ready'; });
    if (!ready.length) return '<p class="small dim">' + (q ? 'Nothing tagged “' + esc(q) + '”.' : 'No clips yet.') + '</p>';
    return ready.map(function (f) {
      return '<button type="button" data-pr-use="' + f.id + '" aria-pressed="' + (f.id === current) + '"><img src="' + esc(f.video.thumb || f.video.poster) + '" alt="" loading="lazy"><span>' + esc(f.title || f.tags || 'Clip') + '</span></button>';
    }).join('');
  }
  function loadClips(then) {
    api('GET', '/footage' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (r) { clips = r.ok ? r.d.footage : []; then(); });
  }
  function drawLibrary() {
    loadClips(function () {
      var html = '<p class="small"><button class="link" data-pr-libback>' + (open ? 'Back to ' + esc(club ? club.name : 'the club') : 'All club pages') + '</button></p>' +
        '<div class="card"><h3>Footage library</h3><p class="small dim">Clips you filmed, tagged so you find them in seconds: the club, the cars, the meet. Tag new clips the night you film them. Each becomes a 15-second 1080p loop.</p>' +
        '<label for="flTitle">What it is (optional)</label><input id="flTitle" maxlength="80" placeholder="Unforsaken roll-in, Dunlap">' +
        '<label for="flTags">Tags, with commas</label><input id="flTags" maxlength="300" placeholder="unforsaken, m3, supra, tasty tuesday">' +
        '<input type="file" accept="video/*" id="flFile" style="margin-top:10px" aria-label="Choose a clip"><div class="msg" id="flMsg" role="status"></div></div>' +
        '<input type="search" placeholder="Search tags" value="' + esc(q) + '" data-pr-q aria-label="Search footage" style="margin-top:6px">' +
        '<div class="pr-clips" id="flGrid">' + libGridHtml() + '</div>';
      view(html);
      $('flFile').onchange = function () { upload(this); };
      if (clips.some(function (f) { return f.video.status === 'processing'; })) later(drawLibrary);
    });
  }
  function libGridHtml() {
    return (clips.length ? clips.map(function (f) {
        var st = f.video.status;
        return '<figure>' + (st === 'ready' ? '<img src="' + esc(f.video.thumb || f.video.poster) + '" alt="" loading="lazy">' : '<div style="aspect-ratio:16/10;display:grid;place-items:center;background:#000" class="small dim">' + (st === 'failed' ? 'Didn’t work' : 'Processing…') + '</div>') +
          '<span>' + esc(f.title || 'Clip') + '</span><span class="dim">' + esc(f.tags || 'no tags') + (f.used ? ' · on ' + f.used + ' page' + (f.used === 1 ? '' : 's') : '') + '</span>' +
          '<div class="bar"><button class="btn sm" type="button" data-fl-tags="' + f.id + '">Tags</button><button class="btn sm" type="button" data-fl-del="' + f.id + '" aria-label="Delete">✕</button></div></figure>';
      }).join('') : '<p class="small dim">' + (q ? 'Nothing tagged “' + esc(q) + '”.' : 'No clips yet.') + '</p>');
  }
  function upload(input) {
    var f = input.files[0]; if (!f) return;
    var msg = $('flMsg');
    if (f.size > 400 * 1024 * 1024) return say(msg, 'That clip is over 400 MB. Trim it on your phone first.');
    var x = new XMLHttpRequest();
    x.open('POST', '/api/host/footage?title=' + encodeURIComponent($('flTitle').value.trim()) + '&tags=' + encodeURIComponent($('flTags').value.trim()));
    x.setRequestHeader('Content-Type', f.type || 'video/mp4');
    x.upload.onprogress = function (e) { if (e.lengthComputable) say(msg, 'Uploading… ' + Math.round(e.loaded / e.total * 100) + '%', true); };
    x.onload = function () { P().forget(); var d = {}; try { d = JSON.parse(x.responseText); } catch (e) {} if (x.status >= 400) return say(msg, d.error || 'The upload didn’t go through.'); drawLibrary(); };
    x.onerror = function () { say(msg, 'The upload stopped. Try again on a stronger signal.'); };
    input.disabled = true; x.send(f);
  }

  /** A screenshot at most 1600 px on its long side, as JPEG base64 (a phone screenshot is several MB as it comes). */
  function shrink(file) {
    return new Promise(function (ok) {
      var done = function (blob) { var r = new FileReader(); r.onload = function () { ok({ type: blob.type || 'image/jpeg', data: String(r.result).split(',')[1], url: String(r.result) }); }; r.readAsDataURL(blob); };
      if (!window.createImageBitmap) return done(file);
      createImageBitmap(file).then(function (bmp) {
        var k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        var cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
        cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
        cv.toBlob(function (b) { done(b || file); }, 'image/jpeg', 0.85);
      }).catch(function () { done(file); });
    });
  }

  /* ---------- taps and changes ---------- */
  document.addEventListener('click', function (e) {
    if (!P() || !P().on('prospects')) return;
    var b = e.target.closest('[data-pr-open],[data-pr-back],[data-pr-lib],[data-pr-libback],[data-pr-color],[data-pr-pick],[data-pr-unpick],[data-pr-use],[data-pr-edit],[data-pr-mdel],[data-pr-copy],[data-pr-extend],[data-pr-del],[data-f-apply],[data-f-clear],[data-fl-tags],[data-fl-del]');
    if (!b) return;
    var c = club;
    if (b.hasAttribute('data-pr-open')) { open = +b.getAttribute('data-pr-open'); found = null; shots = []; picking = null; editing = null; startClock(open); draw(); }
    else if (b.hasAttribute('data-pr-back')) { open = null; club = null; draw(); }
    else if (b.hasAttribute('data-pr-lib')) { lib = true; draw(); }
    else if (b.hasAttribute('data-pr-libback')) { lib = false; draw(); }
    else if (b.hasAttribute('data-pr-color')) api('PUT', '/prospects/' + c.id, { accent: b.getAttribute('data-pr-color') }).then(function (r) { if (r.ok) { club = r.d.club; render(); } });
    else if (b.hasAttribute('data-pr-pick')) {
      var t = b.getAttribute('data-pr-pick'); t = t === 'club' ? 'club' : +t;
      if (picking === t) { picking = null; return render(); }
      picking = t; loadClips(render);
    } else if (b.hasAttribute('data-pr-use')) {
      var fid = +b.getAttribute('data-pr-use');
      var url = picking === 'club' ? '/prospects/' + c.id + '/footage' : '/members/' + picking + '/footage';
      api('PUT', url, { footageId: fid }).then(function (r) { if (!r.ok) return alert(r.d.error); picking = null; drawOne(); });
    } else if (b.hasAttribute('data-pr-unpick')) {
      var u = b.getAttribute('data-pr-unpick');
      api('PUT', u === 'club' ? '/prospects/' + c.id + '/footage' : '/members/' + u + '/footage', { footageId: null }).then(function () { picking = null; drawOne(); });
    } else if (b.hasAttribute('data-pr-edit')) { var mid = +b.getAttribute('data-pr-edit'); editing = editing === mid ? null : mid; if (!editing) return drawOne(); render(); }
    else if (b.hasAttribute('data-pr-mdel')) {
      if (!confirm('Take this member’s page off, with its photos?')) return;
      api('DELETE', '/prospects/' + c.id + '/members/' + b.getAttribute('data-pr-mdel')).then(function (r) { if (r.ok) { club = r.d.club; render(); } });
    } else if (b.hasAttribute('data-pr-copy')) P().copy($('prDm').value, b);
    else if (b.hasAttribute('data-pr-extend')) api('POST', '/prospects/' + c.id + '/extend', {}).then(function (r) { if (r.ok) { club = r.d.club; render(); } });
    else if (b.hasAttribute('data-pr-del')) {
      if (!confirm('Take ' + c.name + '’s page down now, with its member pages and photos? Your footage stays in the library.')) return;
      api('DELETE', '/prospects/' + c.id).then(function () { try { localStorage.removeItem(START + c.id); } catch (er) {} open = null; club = null; draw(); });
    } else if (b.hasAttribute('data-f-clear')) { found = null; shots = []; render(); }
    else if (b.hasAttribute('data-f-apply')) applyFound(b);
    else if (b.hasAttribute('data-fl-tags')) {
      var f = clips.filter(function (x) { return x.id === +b.getAttribute('data-fl-tags'); })[0]; if (!f) return;
      var tags = prompt('Tags, with commas', f.tags); if (tags === null) return;
      api('PUT', '/footage/' + f.id, { tags: tags }).then(drawLibrary);
    } else if (b.hasAttribute('data-fl-del')) {
      if (!confirm('Delete this clip from the library?')) return;
      api('DELETE', '/footage/' + b.getAttribute('data-fl-del')).then(function (r) { if (!r.ok) return alert(r.d.error); drawLibrary(); });
    }
  });
  function applyFound(btn) {
    var c = club, box = btn.closest('.pr-found'), msg = $('prFoundMsg');
    var val = function (sel) { var el = box.querySelector(sel); return el ? el.value.trim() : ''; };
    var jobs = [];
    if (box.querySelector('[data-f-detail]').checked) {
      var d = { tagline: val('[data-f-line]') };
      if (val('[data-f-name]')) d.name = val('[data-f-name]');
      if (val('[data-f-ig]')) d.instagram = val('[data-f-ig]');
      jobs.push(function () { return api('PUT', '/prospects/' + c.id, d); });
    }
    var mem = [];
    Array.prototype.forEach.call(box.querySelectorAll('[data-f-mem]'), function (cb) {
      var i = cb.getAttribute('data-f-mem');
      if (cb.checked && !cb.disabled) mem.push({ instagram: val('[data-f-mig="' + i + '"]'), car: val('[data-f-mcar="' + i + '"]'), name: val('[data-f-mname="' + i + '"]') });
    });
    if (mem.length) jobs.push(function () { return api('POST', '/prospects/' + c.id + '/members', { members: mem }); });
    if (!jobs.length) return say(msg, 'Tick something first.');
    btn.disabled = true;
    (function next(i, last) {
      if (i >= jobs.length) { found = null; shots = []; if (last && last.d.club) club = last.d.club; return drawOne(); }
      jobs[i]().then(function (r) { if (!r.ok) { btn.disabled = false; return say(msg, r.d.error); } next(i + 1, r); });
    })(0, null);
  }
  document.addEventListener('change', function (e) {
    if (!P() || !P().on('prospects')) return;
    var i = e.target;
    if (i.hasAttribute('data-pr-shots') && i.files.length) {
      var files = Array.prototype.slice.call(i.files, 0, 8);
      say($('prReadMsg'), 'Reading ' + files.length + ' screenshot' + (files.length === 1 ? '' : 's') + '… (up to a minute)', true);
      i.disabled = true;
      Promise.all(files.map(shrink)).then(function (list) {
        shots = list.map(function (x) { return x.url; });
        return api('POST', '/prospects/' + club.id + '/read', { files: list.map(function (x) { return { type: x.type, data: x.data }; }) });
      }).then(function (r) {
        if (!r.ok) { i.disabled = false; return say($('prReadMsg'), r.d.error); }
        found = r.d.read; render();
        say($('prReadMsg'), found.members.length ? 'Check the cars: a “?” on the end is a guess from the photo.' : 'No members found. Add them by hand below.', true);
      });
    } else if (i.hasAttribute('data-pr-logo') && i.files[0]) {
      var f = i.files[0];
      say($('prLogoMsg'), 'Uploading…', true);
      api('POST', '/prospects/' + club.id + '/logo', undefined, f).then(function (r) {
        if (!r.ok) return say($('prLogoMsg'), r.d.error);
        colors[club.id] = r.d.colors || []; club = r.d.club; render();
      });
    }
  });
  var qt = null;
  document.addEventListener('input', function (e) {
    if (!P() || !P().on('prospects') || !e.target.hasAttribute('data-pr-q')) return;
    q = e.target.value.trim();
    clearTimeout(qt);
    qt = setTimeout(function () {
      loadClips(function () {
        if (lib) { var g = $('flGrid'); if (g) g.innerHTML = libGridHtml(); return; }
        var box = $('prClips'); if (!box) return;
        var cur = picking === 'club' ? club.footageId : (club.members.filter(function (m) { return m.id === picking; })[0] || {}).footageId;
        box.innerHTML = clipsHtml(cur);
      });
    }, 250);
  });

  window.PortalProspects = { draw: draw };
})();
