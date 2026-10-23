/* portal.js — the host portal: sign in with an emailed code, then the next meet at a glance, meets, trucks,
   updates, turnout and history, settings and recaps. Talks only to this site's /api/host. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var me = null, tab = 'next', openMeet = null, invite = null;
  var ACCENTS = ['#f2a33a', '#e8e4d8', '#5fb3d9', '#e0574f', '#7cc47f', '#c792ea'];

  function api(method, url, body, raw) {
    var o = { method: method, cache: 'no-store', headers: {} };
    if (raw) { o.headers['Content-Type'] = raw.type; o.body = raw; }
    else if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch('/api/host' + url, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && me) { me = null; showSignin('Signed out. Sign in again.'); }
        return { ok: r.ok, status: r.status, d: d };
      });
    }).catch(function () { return { ok: false, status: 0, d: { error: 'No connection. Try again.' } }; });
  }
  function say(el, text, ok) { if (!el) return; el.className = 'msg ' + (ok ? 'ok' : 'bad'); el.textContent = text || ''; }
  function view(html) { $('view').innerHTML = html; }
  function copy(text, btn) {
    var done = function () { if (btn) { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1500); } };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {}); else done();
  }

  /* ---------- sign in ---------- */
  function showSignin(text) { $('signin').hidden = false; $('portal').hidden = true; $('whoName').textContent = 'Host portal'; $('whoUrl').textContent = ''; if (text) say($('signMsg'), text); }
  $('fEmail').addEventListener('submit', function (e) {
    e.preventDefault();
    api('POST', '/code', { email: $('email').value.trim() }).then(function (r) {
      if (!r.ok) return say($('signMsg'), r.d.error);
      $('fEmail').hidden = true; $('fCode').hidden = false; $('newHost').hidden = r.d.known;
      say($('signMsg'), 'We sent a code to ' + $('email').value.trim() + '.' + (r.d.devCode ? ' (Test code: ' + r.d.devCode + ')' : ''), true);
      $('code').focus();
    });
  });
  $('again').addEventListener('click', function () { $('fCode').hidden = true; $('fEmail').hidden = false; say($('signMsg'), ''); });
  $('hName').addEventListener('input', function () {
    if ($('hSlug').getAttribute('data-touched')) return;
    $('hSlug').value = $('hName').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); slugPreview();
  });
  $('hSlug').addEventListener('input', function () { $('hSlug').setAttribute('data-touched', '1'); slugPreview(); });
  function slugPreview() { $('slugPreview').textContent = $('hSlug').value ? location.host + '/' + $('hSlug').value : ''; }
  $('fCode').addEventListener('submit', function (e) {
    e.preventDefault();
    api('POST', '/login', { email: $('email').value.trim(), code: $('code').value.trim(), name: $('hName').value.trim(), slug: $('hSlug').value.trim(), city: $('hCity').value.trim() }).then(function (r) {
      if (r.d.needsName) { $('newHost').hidden = false; }
      if (!r.ok) return say($('signMsg'), r.d.error);
      say($('signMsg'), ''); boot();
    });
  });

  function boot() {
    api('GET', '/me').then(function (r) {
      if (!r.ok) return showSignin();
      me = r.d.host;
      $('signin').hidden = true; $('portal').hidden = false;
      $('whoName').textContent = me.name; $('whoUrl').innerHTML = '<a href="' + esc(me.pageUrl) + '" target="_blank" rel="noopener">' + esc(me.pageUrl.replace(/^https?:\/\//, '')) + '</a>';
      if (me.accent) document.documentElement.style.setProperty('--accent', me.accent);
      show(tab);
    });
  }
  document.querySelector('.tabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]'); if (!b) return;
    openMeet = null; invite = null; show(b.getAttribute('data-tab'));
  });
  function show(t) {
    tab = t;
    Array.prototype.forEach.call(document.querySelectorAll('.tabs [data-tab]'), function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === t)); });
    view('<p class="dim" style="padding:20px 0">Loading…</p>');
    ({ next: drawNext, meets: drawMeets, updates: drawUpdates, history: drawHistory, settings: drawSettings })[t]();
  }

  /* ---------- trucks for one meet ---------- */
  function trucksHtml(m, trucks, known) {
    var html = '<div class="card"><h3>Food trucks</h3>';
    if (!me.foodOn) html += '<p class="small dim">Food pre-orders aren’t connected on this site yet.</p>';
    html += trucks.length ? trucks.map(function (v) {
      var name = v.name ? (v.emoji ? v.emoji + ' ' : '') + v.name : 'Invite ' + (v.code || '');
      var st = v.status === 'in' ? '<span class="tag in">Confirmed · ' + v.preorders + ' pre-order' + (v.preorders === 1 ? '' : 's') + (v.plates !== null ? ' · ' + v.plates + ' plates sold' : '') + (v.cardReady ? '' : ' · order at the truck') + '</span>'
        : v.status === 'invited' ? '<span class="tag">Invited, waiting</span>' : '<span class="tag">' + esc(v.status === 'declined' ? 'Declined' : v.status === 'left' ? 'Not coming' : v.status) + '</span>';
      return '<div class="rowx"><div><div>' + esc(name) + '</div>' + st + '</div>' +
        (['in', 'invited'].indexOf(v.status) >= 0 && !m.over ? '<button class="btn sm" data-drop-truck="' + v.inviteId + '">Remove</button>' : '') + '</div>';
    }).join('') : '<p class="small dim">No trucks yet.</p>';
    if (!m.over && m.status === 'on' && me.foodOn) {
      if (invite && invite.meet === m.id) {
        html += '<div style="margin-top:12px"><p class="small dim">Text this to the truck’s owner. The link works once, for one truck.</p><div class="copybox" id="inviteText">' + esc(invite.text) + '</div>' +
          '<div class="bar"><button class="btn go sm" data-copy-invite>Copy message</button><a class="btn sm" href="sms:?&body=' + encodeURIComponent(invite.text) + '">Text it</a><button class="btn sm" data-new-invite="' + m.id + '">Another link</button></div></div>';
      } else html += '<div class="bar"><button class="btn go sm" data-new-invite="' + m.id + '">Invite a truck</button></div>';
      if (known && known.length) html += '<p class="small dim" style="margin:14px 0 6px">Trucks you’ve had before (one tap, they accept in their app):</p><div class="bar">' +
        known.map(function (k) { return '<button class="btn sm" data-add-known="' + esc(k.slug) + '">+ ' + esc((k.emoji ? k.emoji + ' ' : '') + k.name) + '</button>'; }).join('') + '</div>';
    }
    return html + '<div class="msg" id="truckMsg" role="status"></div></div>';
  }
  function truckActions(e, m, redraw) {
    var b;
    if ((b = e.target.closest('[data-new-invite]'))) {
      b.disabled = true;
      api('POST', '/meets/' + m.id + '/invite', {}).then(function (r) { if (!r.ok) { b.disabled = false; return say($('truckMsg'), r.d.error); } invite = { meet: m.id, text: r.d.text, url: r.d.url }; redraw(); });
      return true;
    }
    if ((b = e.target.closest('[data-copy-invite]'))) { copy(invite.text, b); return true; }
    if ((b = e.target.closest('[data-add-known]'))) {
      api('POST', '/meets/' + m.id + '/trucks', { slug: b.getAttribute('data-add-known') }).then(function (r) { if (!r.ok) return say($('truckMsg'), r.d.error); redraw(); });
      return true;
    }
    if ((b = e.target.closest('[data-drop-truck]'))) {
      if (!confirm('Take this truck off the meet? It comes off their schedule too.')) return true;
      api('DELETE', '/meets/' + m.id + '/trucks/' + b.getAttribute('data-drop-truck')).then(function (r) { if (!r.ok) return say($('truckMsg'), r.d.error); redraw(); });
      return true;
    }
    return false;
  }

  /* ---------- next meet ---------- */
  function drawNext() {
    api('GET', '/dashboard').then(function (r) {
      if (!r.ok) return view('<p class="msg bad">' + esc(r.d.error) + '</p>');
      var d = r.d, m = d.meet, html = '';
      d.unlogged.forEach(function (u) {
        html += '<div class="card"><h3>How many came on ' + esc(u.label.split(', ').slice(0, 2).join(', ')) + '?</h3><p class="small dim">Past turnout is what shows a truck your spot is worth it.</p>' +
          '<form data-turnout="' + u.id + '" class="grid2"><input name="people" inputmode="numeric" placeholder="People" aria-label="About how many people" required><input name="cars" inputmode="numeric" placeholder="Cars" aria-label="About how many cars"></form>' +
          '<div class="bar"><button class="btn go sm" data-save-turnout="' + u.id + '">Save count</button></div><div class="msg" role="status"></div></div>';
      });
      if (!m) {
        html += '<div class="card"><h3>No meet posted</h3><p class="dim">Post your next one and people with alerts hear about it.</p><div class="bar"><button class="btn go" data-go-new>Post a meet</button>' +
          (d.last ? '<button class="btn" data-again="' + d.last.id + '">Same as last time, next week</button>' : '') + '</div></div>';
      } else {
        html += '<div class="stall" style="margin-top:16px"><div class="dow">' + esc(m.label.split(', ')[0] + (m.title ? ' · ' + m.title : '')) + '</div><div class="date" style="font-size:64px">' + esc(m.label.split(', ')[1]) + '</div>' +
          '<div class="time">' + esc(m.label.split(', ').slice(2).join(', ')) + '</div><div class="where">' + esc(m.place) + '</div></div>' +
          '<div class="bar"><button class="btn sm" data-copy-link="' + esc(m.url) + '">Copy page link</button><a class="btn sm" href="' + esc(m.url) + '" target="_blank" rel="noopener">Open page</a><button class="btn sm" data-edit="' + m.id + '">Edit</button></div>' +
          (m.syncError ? '<p class="msg bad">Food side not updated: ' + esc(m.syncError) + ' <button class="link" data-resync="' + m.id + '">Try again</button></p>' : '') +
          '<div class="stats"><div class="stat"><b>' + d.preorders + '</b><span>pre-orders paid</span></div><div class="stat"><b>' + d.trucks.filter(function (v) { return v.status === 'in'; }).length + '</b><span>trucks confirmed</span></div><div class="stat"><b>' + d.subscribers + '</b><span>on alerts</span></div></div>' +
          '<div id="trucksBox"></div>';
      }
      if (d.last && d.last.people) html += '<p class="small dim">Last logged: about ' + d.last.people + ' people' + (d.last.cars ? ', ' + d.last.cars + ' cars' : '') + ' on ' + esc(d.last.label.split(', ').slice(0, 2).join(', ')) + ' at ' + esc(d.last.place) + '.</p>';
      html += '<div id="reqBox"></div>';
      view(html);
      if (m) api('GET', '/meets/' + m.id + '/trucks').then(function (t) { if (t.ok) $('trucksBox').innerHTML = trucksHtml(m, t.d.trucks, t.d.known); });
      if (d.requests) drawRequests();
      $('view').onclick = function (e) {
        if (m && truckActions(e, m, drawNext)) return;
        var b;
        if ((b = e.target.closest('[data-copy-link]'))) copy(b.getAttribute('data-copy-link'), b);
        else if ((b = e.target.closest('[data-edit]'))) { tab = 'meets'; openMeet = { edit: +b.getAttribute('data-edit') }; show('meets'); }
        else if (e.target.closest('[data-go-new]')) { openMeet = { edit: 'new' }; show('meets'); }
        else if ((b = e.target.closest('[data-again]'))) api('POST', '/meets/' + b.getAttribute('data-again') + '/again', {}).then(function (r2) { if (!r2.ok) return alert(r2.d.error); drawNext(); });
        else if ((b = e.target.closest('[data-resync]'))) api('POST', '/meets/' + b.getAttribute('data-resync') + '/resync', {}).then(function () { drawNext(); });
        else if ((b = e.target.closest('[data-save-turnout]'))) saveTurnout(b.getAttribute('data-save-turnout'), b, drawNext);
        else if ((b = e.target.closest('[data-req]'))) api('PUT', '/requests/' + b.getAttribute('data-req'), { status: b.getAttribute('data-to') }).then(drawRequests);
      };
    });
  }
  function saveTurnout(id, btn, after) {
    var f = document.querySelector('form[data-turnout="' + id + '"]'), msg = btn.closest('.card').querySelector('.msg');
    api('POST', '/meets/' + id + '/turnout', { people: f.people.value.trim(), cars: f.cars.value.trim() }).then(function (r) { if (!r.ok) return say(msg, r.d.error); after(); });
  }
  function drawRequests() {
    api('GET', '/requests').then(function (r) {
      if (!r.ok || !$('reqBox')) return;
      var list = r.d.requests.filter(function (x) { return x.status === 'new'; });
      $('reqBox').innerHTML = list.length ? '<div class="card"><h3>Trucks asking for a spot</h3>' + list.map(function (x) {
        return '<div class="rowx"><div><div>' + esc(x.name) + (x.food ? ' <span class="tag">· ' + esc(x.food) + '</span>' : '') + '</div><div class="tag">' + esc(x.contact) + (x.note ? ' · ' + esc(x.note) : '') + '</div></div>' +
          '<div class="bar" style="margin:0"><button class="btn sm" data-req="' + x.id + '" data-to="invited">Invited</button><button class="btn sm" data-req="' + x.id + '" data-to="dismissed">Dismiss</button></div></div>';
      }).join('') + '<p class="small dim" style="margin-top:8px">Reach out, then send them an invite link from the meet.</p></div>' : '';
    });
  }

  /* ---------- meets ---------- */
  function meetForm(m) {
    m = m || {};
    var tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    return '<div class="card"><h3>' + (m.id ? 'Edit meet' : 'New meet') + '</h3><form id="meetForm">' +
      '<label for="mDay">Date</label><input id="mDay" type="date" required value="' + esc(m.day || tomorrow) + '">' +
      '<div class="grid2"><div><label for="mStart">Starts</label><input id="mStart" type="time" required value="' + esc(m.start || '19:00') + '"></div><div><label for="mEnd">Ends</label><input id="mEnd" type="time" required value="' + esc(m.end || '22:00') + '"></div></div>' +
      '<label for="mPlace">Spot</label><input id="mPlace" maxlength="80" required placeholder="Dunlap shopping center, back lot" value="' + esc(m.place || '') + '">' +
      '<label for="mAddr">Street address (for directions)</label><input id="mAddr" maxlength="160" placeholder="3500 W Dunlap Ave, Phoenix, AZ" value="' + esc(m.address || '') + '">' +
      '<label for="mTitle">Name for this one (optional)</label><input id="mTitle" maxlength="80" placeholder="JDM night" value="' + esc(m.title || '') + '">' +
      '<label for="mNotes">Notes (optional)</label><textarea id="mNotes" maxlength="300" placeholder="Enter from 35th Ave. Overflow parking on the north side.">' + esc(m.notes || '') + '</textarea>' +
      '<div class="checks"><label><input type="checkbox" id="mTell"' + (m.id ? '' : ' checked') + '> ' + (m.id ? 'If the time or place changed, email the alert list' : 'Email the alert list') + '</label></div>' +
      '<div class="bar"><button class="btn go" type="submit">' + (m.id ? 'Save' : 'Post meet') + '</button><button class="btn" type="button" data-close-form>Cancel</button></div>' +
      '<div class="msg" id="meetMsg" role="status"></div></form></div>';
  }
  function drawMeets() {
    api('GET', '/meets').then(function (r) {
      if (!r.ok) return view('<p class="msg bad">' + esc(r.d.error) + '</p>');
      var list = r.d.meets;
      var editing = openMeet && openMeet.edit !== undefined ? (openMeet.edit === 'new' ? {} : list.filter(function (x) { return x.id === openMeet.edit; })[0]) : null;
      var detail = openMeet && openMeet.id ? list.filter(function (x) { return x.id === openMeet.id; })[0] : null;
      var html = '';
      if (editing) html += meetForm(editing);
      else if (detail) html += '<p class="small"><button class="link" data-back>All meets</button></p><div class="card"><h3>' + esc(detail.title || detail.label) + '</h3><p class="dim">' + esc(detail.label) + ' · ' + esc(detail.place) + (detail.status === 'canceled' ? ' · canceled' : '') + '</p>' +
        '<div class="bar"><button class="btn sm" data-edit="' + detail.id + '">Edit</button><button class="btn sm" data-again="' + detail.id + '">Repeat next week</button>' +
        (detail.status === 'canceled' ? '<button class="btn sm" data-uncancel="' + detail.id + '">Put it back on</button>' : '<button class="btn sm" data-cancel="' + detail.id + '">Cancel meet</button>') + '</div></div><div id="trucksBox"></div>';
      else html += '<div class="bar" style="margin:16px 0"><button class="btn go" data-new>Post a meet</button></div>' + (list.length ? list.map(function (m) {
        return '<div class="rowx"><div><div><b>' + esc(m.label) + '</b></div><div class="tag">' + esc(m.place) + (m.title ? ' · ' + esc(m.title) : '') + (m.status === 'canceled' ? ' · canceled' : '') + '</div></div><button class="btn sm" data-open="' + m.id + '">Open</button></div>';
      }).join('') : '<p class="dim">Nothing coming up.</p>');
      view(html);
      if (detail) api('GET', '/meets/' + detail.id + '/trucks').then(function (t) { if (t.ok && $('trucksBox')) $('trucksBox').innerHTML = trucksHtml(detail, t.d.trucks, t.d.known); });
      var form = $('meetForm');
      if (form) form.onsubmit = function (e) {
        e.preventDefault();
        var body = { day: $('mDay').value, start: $('mStart').value, end: $('mEnd').value, place: $('mPlace').value.trim(), address: $('mAddr').value.trim(), title: $('mTitle').value.trim(), notes: $('mNotes').value.trim(), tellAlerts: $('mTell').checked };
        api(editing.id ? 'PUT' : 'POST', editing.id ? '/meets/' + editing.id : '/meets', body).then(function (r2) {
          if (!r2.ok) return say($('meetMsg'), r2.d.error);
          openMeet = { id: r2.d.meet.id }; drawMeets();
        });
      };
      $('view').onclick = function (e) {
        if (detail && truckActions(e, detail, drawMeets)) return;
        var b;
        if (e.target.closest('[data-new]')) { openMeet = { edit: 'new' }; drawMeets(); }
        else if (e.target.closest('[data-close-form]') || e.target.closest('[data-back]')) { openMeet = editing && editing.id ? { id: editing.id } : null; invite = null; drawMeets(); }
        else if ((b = e.target.closest('[data-open]'))) { openMeet = { id: +b.getAttribute('data-open') }; invite = null; drawMeets(); }
        else if ((b = e.target.closest('[data-edit]'))) { openMeet = { edit: +b.getAttribute('data-edit') }; drawMeets(); }
        else if ((b = e.target.closest('[data-again]'))) api('POST', '/meets/' + b.getAttribute('data-again') + '/again', {}).then(function (r2) { if (!r2.ok) return alert(r2.d.error); openMeet = { id: r2.d.meet.id }; drawMeets(); });
        else if ((b = e.target.closest('[data-cancel]'))) {
          if (!confirm('Cancel this meet? Trucks in it are told and it comes off their schedule.')) return;
          var tell = confirm('Email the alert list that it’s canceled?');
          api('POST', '/meets/' + b.getAttribute('data-cancel') + '/cancel', { tellAlerts: tell }).then(drawMeets);
        } else if ((b = e.target.closest('[data-uncancel]'))) api('POST', '/meets/' + b.getAttribute('data-uncancel') + '/cancel', { undo: true }).then(drawMeets);
      };
    });
  }

  /* ---------- updates ---------- */
  function drawUpdates() {
    Promise.all([api('GET', '/updates'), api('GET', '/meets')]).then(function (rs) {
      var u = rs[0].d, meets = (rs[1].d.meets || []).filter(function (m) { return m.status === 'on'; });
      var html = '<div class="card"><h3>Send an update</h3><p class="small dim">Weather, a new spot, running late. Goes out by email now.</p><form id="updForm">' +
        (meets.length ? '<label for="uMeet">About</label><select id="uMeet">' + meets.map(function (m) { return '<option value="' + m.id + '">' + esc(m.label + ' · ' + m.place) + '</option>'; }).join('') + '</select>' : '') +
        '<label for="uMsg">Message</label><textarea id="uMsg" maxlength="600" required placeholder="Moving to the north lot tonight. Same time."></textarea>' +
        '<div class="checks"><label><input type="checkbox" id="uAlerts" checked> Alert list (' + u.subscribers + ')</label>' + (meets.length ? '<label><input type="checkbox" id="uTrucks"> Food trucks in this meet</label>' : '') + '</div>' +
        (u.mailOn ? '' : '<p class="small dim">Email isn’t set up on this site yet, so nothing will actually send.</p>') +
        '<div class="bar"><button class="btn go" type="submit">Send</button></div><div class="msg" id="updMsg" role="status"></div></form></div>';
      html += u.updates.length ? '<h3 style="margin:20px 0 8px">Sent</h3>' + u.updates.map(function (x) {
        return '<div class="rowx"><div><div>' + esc(x.subject) + '</div><div class="tag">' + new Date(x.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' + [x.to_alerts ? 'alerts' : '', x.to_vendors ? 'trucks' : ''].filter(Boolean).join(' + ') + ' · ' + x.sent + ' sent</div></div></div>';
      }).join('') : '';
      view(html);
      $('updForm').onsubmit = function (e) {
        e.preventDefault();
        api('POST', '/updates', { message: $('uMsg').value.trim(), meetId: $('uMeet') ? +$('uMeet').value : null, toAlerts: $('uAlerts').checked, toVendors: !!($('uTrucks') && $('uTrucks').checked) }).then(function (r) {
          if (!r.ok) return say($('updMsg'), r.d.error);
          drawUpdates();
        });
      };
    });
  }

  /* ---------- history ---------- */
  function drawHistory() {
    api('GET', '/history').then(function (r) {
      if (!r.ok) return view('<p class="msg bad">' + esc(r.d.error) + '</p>');
      var html = '';
      if (r.d.spots.length) html += '<div class="card"><h3>Turnout by spot</h3>' + r.d.spots.map(function (s) {
        return '<div class="rowx"><div>' + esc(s.place) + '<div class="tag">' + s.meets + ' meet' + (s.meets === 1 ? '' : 's') + ' logged</div></div><div style="text-align:right"><b>~' + s.avgPeople + '</b> people' + (s.avgCars !== null ? '<div class="tag">~' + s.avgCars + ' cars</div>' : '') + '</div></div>';
      }).join('') + '<p class="small dim" style="margin-top:8px">Show this to a truck deciding whether to come.</p></div>';
      html += '<h3 style="margin:20px 0 8px">Past meets</h3>' + (r.d.meets.length ? r.d.meets.map(function (m) {
        return '<div class="card" style="padding:12px"><div><b>' + esc(m.label.split(', ').slice(0, 2).join(', ')) + '</b> <span class="tag">' + esc(m.place) + (m.status === 'canceled' ? ' · canceled' : '') + '</span></div>' +
          (m.status === 'canceled' ? '' : m.people ? '<div class="tag">~' + m.people + ' people' + (m.cars !== null && m.cars !== undefined ? ', ' + m.cars + ' cars' : '') + (m.preorders !== null && m.preorders !== undefined ? ' · ' + m.preorders + ' pre-orders · ' + (m.trucks || 0) + ' trucks' : '') + '</div>'
            : '<form data-turnout="' + m.id + '" class="grid2" style="margin-top:8px"><input name="people" inputmode="numeric" placeholder="People" aria-label="About how many people"><input name="cars" inputmode="numeric" placeholder="Cars" aria-label="About how many cars"></form><div class="bar"><button class="btn sm" data-save-turnout="' + m.id + '">Log count</button></div><div class="msg" role="status"></div>') + '</div>';
      }).join('') : '<p class="dim">No past meets yet.</p>');
      view(html);
      $('view').onclick = function (e) { var b = e.target.closest('[data-save-turnout]'); if (b) saveTurnout(b.getAttribute('data-save-turnout'), b, drawHistory); };
    });
  }

  /* ---------- settings and recaps ---------- */
  function drawSettings() {
    Promise.all([api('GET', '/me'), api('GET', '/recaps'), api('GET', '/meets')]).then(function (rs) {
      me = rs[0].d.host; var recaps = rs[1].d.recaps || [];
      var html = '<div class="card"><h3>Your page</h3><form id="setForm">' +
        '<label for="sName">Meet name</label><input id="sName" maxlength="60" value="' + esc(me.name) + '">' +
        '<label for="sCity">City</label><input id="sCity" maxlength="60" value="' + esc(me.city) + '">' +
        '<label>Color</label><div class="swatches">' + ACCENTS.map(function (c) { return '<button type="button" data-accent="' + c + '" aria-label="Color ' + c + '" aria-pressed="' + ((me.accent || ACCENTS[0]) === c) + '" style="background:' + c + '"></button>'; }).join('') + '</div>' +
        '<label for="sIg">Instagram</label><input id="sIg" maxlength="60" placeholder="@yourmeet" value="' + esc(me.instagram) + '">' +
        '<div class="grid2"><div><label for="sTt">TikTok</label><input id="sTt" maxlength="60" value="' + esc(me.tiktok) + '"></div><div><label for="sYt">YouTube</label><input id="sYt" maxlength="60" value="' + esc(me.youtube) + '"></div></div>' +
        '<label for="sRules">House rules (one per line)</label><textarea id="sRules" maxlength="600">' + esc(me.rules) + '</textarea>' +
        '<label for="sClose">Food pre-orders close</label><select id="sClose">' + [[30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [180, '3 hours before'], [240, '4 hours before'], [360, '6 hours before']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === me.closeMinutes ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        '<div class="bar"><button class="btn go" type="submit">Save</button></div><div class="msg" id="setMsg" role="status"></div></form></div>';
      html += '<div class="card"><h3>Logo</h3>' + (me.logo ? '<img src="' + esc(me.logo) + '" alt="" style="width:64px;height:64px;border-radius:10px;object-fit:cover;margin-bottom:8px">' : '') +
        '<input type="file" id="logoFile" accept="image/jpeg,image/png" aria-label="Logo image"><div class="msg" id="logoMsg" role="status"></div></div>';
      html += '<div class="card"><h3>Recap</h3><p class="small dim">The newest recap shows on your page: a video link and up to 9 photos.</p><form id="recapForm">' +
        '<label for="rVideo">Video link (YouTube, Instagram, TikTok, Vimeo)</label><input id="rVideo" maxlength="300" placeholder="https://youtube.com/watch?v=…">' +
        '<label for="rCap">Caption</label><input id="rCap" maxlength="140" placeholder="Last Tuesday at Dunlap">' +
        '<label for="rPhotos">Photos (JPEG or PNG)</label><input id="rPhotos" type="file" accept="image/jpeg,image/png" multiple>' +
        '<div class="bar"><button class="btn go" type="submit">Post recap</button></div><div class="msg" id="recapMsg" role="status"></div></form>' +
        recaps.map(function (x) { return '<div class="rowx"><div>' + esc(x.caption || x.video_url || 'Recap') + '<div class="tag">' + x.photos.length + ' photo' + (x.photos.length === 1 ? '' : 's') + '</div></div><button class="btn sm" data-del-recap="' + x.id + '">Delete</button></div>'; }).join('') + '</div>';
      html += '<div class="card"><h3>Your own domain</h3><p class="small dim">Already have a domain like tuesdaymeets.com? Your page can live there, without the ' + esc(me.siteName) + ' line at the bottom.</p>' +
        '<form id="domForm" class="row"><input id="sDomain" maxlength="120" placeholder="tuesdaymeets.com" value="' + esc(me.customDomain) + '" aria-label="Your domain"><button class="btn" type="submit">Save</button></form>' +
        '<p class="small dim" style="margin-top:8px">' + (me.customDomain ? (me.domainOn ? 'Live at ' + esc(me.customDomain) + '.' : 'Waiting for setup. We’ll reach out with the one DNS step.') : '') + '</p><div class="msg" id="domMsg" role="status"></div></div>';
      html += '<p><button class="btn" id="signOut">Sign out</button></p>';
      view(html);
      var accent = me.accent || ACCENTS[0];
      $('view').onclick = function (e) {
        var b;
        if ((b = e.target.closest('[data-accent]'))) { accent = b.getAttribute('data-accent'); Array.prototype.forEach.call(document.querySelectorAll('[data-accent]'), function (x) { x.setAttribute('aria-pressed', String(x === b)); }); document.documentElement.style.setProperty('--accent', accent); }
        else if ((b = e.target.closest('[data-del-recap]'))) { if (confirm('Delete this recap and its photos?')) api('DELETE', '/recaps/' + b.getAttribute('data-del-recap')).then(drawSettings); }
        else if (e.target.id === 'signOut') api('POST', '/logout', {}).then(function () { me = null; showSignin(); });
      };
      $('setForm').onsubmit = function (e) {
        e.preventDefault();
        api('PUT', '/settings', { name: $('sName').value.trim(), city: $('sCity').value.trim(), accent: accent, instagram: $('sIg').value.trim(), tiktok: $('sTt').value.trim(), youtube: $('sYt').value.trim(), rules: $('sRules').value, closeMinutes: +$('sClose').value })
          .then(function (r) { if (!r.ok) return say($('setMsg'), r.d.error); me = r.d.host; $('whoName').textContent = me.name; say($('setMsg'), 'Saved.', true); });
      };
      $('domForm').onsubmit = function (e) {
        e.preventDefault();
        api('PUT', '/settings', { customDomain: $('sDomain').value.trim() }).then(function (r) { if (!r.ok) return say($('domMsg'), r.d.error); me = r.d.host; drawSettings(); });
      };
      $('logoFile').onchange = function () {
        var f = this.files[0]; if (!f) return;
        if (f.size > 6 * 1024 * 1024) return say($('logoMsg'), 'That image is over 6 MB.');
        api('POST', '/logo', null, f).then(function (r) { if (!r.ok) return say($('logoMsg'), r.d.error); me = r.d.host; drawSettings(); });
      };
      $('recapForm').onsubmit = function (e) {
        e.preventDefault();
        var files = Array.prototype.slice.call($('rPhotos').files, 0, 9);
        if (!$('rVideo').value.trim() && !files.length) return say($('recapMsg'), 'Add a video link or some photos.');
        say($('recapMsg'), 'Posting…', true);
        api('POST', '/recaps', { videoUrl: $('rVideo').value.trim(), caption: $('rCap').value.trim() }).then(function (r) {
          if (!r.ok) return say($('recapMsg'), r.d.error);
          var id = r.d.id, i = 0, failed = 0;
          (function next() {
            if (i >= files.length) { if (failed) say($('recapMsg'), failed + ' photo' + (failed === 1 ? '' : 's') + ' didn’t upload (JPEG or PNG, under 6 MB).'); else drawSettings(); return; }
            var f = files[i++];
            if (f.size > 6 * 1024 * 1024) { failed++; return next(); }
            api('POST', '/recaps/' + id + '/photos', null, f).then(function (p) { if (!p.ok) failed++; next(); });
          })();
        });
      };
    });
  }

  boot();
})();
