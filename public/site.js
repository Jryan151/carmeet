/* site.js — the meet page: how long until it starts, the alerts form, and a vendor's request for a spot. */
(function () {
  'use strict';
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .catch(function () { return { ok: false, d: { error: 'No connection. Try again.' } }; });
  }

  // Data saver on: keep the still frame, skip the background video.
  var bgv = document.querySelector('.page-bg video');
  if (bgv && navigator.connection && navigator.connection.saveData) { bgv.removeAttribute('autoplay'); bgv.pause(); bgv.remove(); bgv = null; }
  // Each clip is saved on the phone the first time it plays (sw.js), so it never downloads twice. The truck's menu is on
  // the same address, so its clip comes from the saved copy too.
  if (bgv && 'serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  }

  // "Starts in 2 days 4 hrs" / "Happening now" / "Starts in 35 min".
  var cd = document.querySelector('[data-countdown]');
  function tick() {
    if (!cd) return;
    var start = +cd.getAttribute('data-countdown'), end = +cd.getAttribute('data-ends'), now = Date.now();
    if (now >= end) { cd.textContent = ''; return; }
    if (now >= start) { cd.textContent = 'Happening now'; return; }
    var m = Math.round((start - now) / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    cd.textContent = 'Starts in ' + (d ? d + (d === 1 ? ' day ' : ' days ') + h + ' hr' : h ? h + ' hr ' + mm + ' min' : mm + ' min');
  }
  tick(); setInterval(tick, 30000);

  function wire(form, url, extra) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = form.parentNode.querySelector('.msg') || form.querySelector('.msg');
      var body = { host: form.getAttribute('data-host') };
      Array.prototype.forEach.call(form.elements, function (el) { if (el.name) body[el.name] = el.value; });
      var btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
      post(url, body).then(function (r) {
        btn.disabled = false;
        msg.className = 'msg ' + (r.ok ? 'ok' : 'bad');
        msg.textContent = r.ok ? (r.d.message || 'Done.') : (r.d.error || 'That didn’t go through. Try again.');
        if (r.ok) { if (extra) extra(form); }
      });
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('form[data-form="alerts"]'), function (f) { wire(f, '/api/alerts', function (form) { form.reset(); }); });
  Array.prototype.forEach.call(document.querySelectorAll('form[data-form="vendor"]'), function (f) { wire(f, '/api/vendor-request', function (form) { form.reset(); }); });
})();
