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

  // The parking map: drag to turn it (and tilt it a little), "Flat" lays it down to read. It eases in with a small turn.
  Array.prototype.forEach.call(document.querySelectorAll('[data-lot]'), function (lot) {
    var stage = lot.querySelector('.lot-stage'), flatBtn = lot.querySelector('[data-lot-flat]');
    var spin = 0, tilt = 52, start = null, img = lot.querySelector('img');
    // The map's shape (tall or wide) sets how big it can be and still fit.
    function shape() { if (img.naturalWidth) lot.style.setProperty('--lot-ratio', (img.naturalHeight / img.naturalWidth).toFixed(3)); }
    if (img.complete) shape(); else img.addEventListener('load', shape);
    function set() { lot.style.setProperty('--spin', spin + 'deg'); lot.style.setProperty('--tilt', tilt + 'deg'); }
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!still && 'IntersectionObserver' in window) {
      spin = -16; set();
      var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { io.disconnect(); setTimeout(function () { spin = 0; set(); }, 120); } }, { threshold: 0.4 });
      io.observe(stage);
    }
    stage.addEventListener('pointerdown', function (e) {
      if (lot.classList.contains('flat')) return;
      start = { x: e.clientX, y: e.clientY, spin: spin, tilt: tilt, id: e.pointerId, moved: false };
    });
    stage.addEventListener('pointermove', function (e) {
      if (!start || e.pointerId !== start.id) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      // Mostly up and down on a phone means scrolling the page: leave it alone.
      if (!start.moved && Math.abs(dy) > Math.abs(dx) && e.pointerType === 'touch') { start = null; return; }
      if (!start.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (!start.moved) { start.moved = true; lot.classList.add('dragging'); try { stage.setPointerCapture(e.pointerId); } catch (x) {} }
      spin = Math.max(-60, Math.min(60, start.spin + dx * 0.35));
      tilt = e.pointerType === 'touch' ? tilt : Math.max(25, Math.min(62, start.tilt - dy * 0.15));
      set();
    });
    function end() { if (!start) return; start = null; lot.classList.remove('dragging'); }
    stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
    flatBtn.addEventListener('click', function () {
      var flat = !lot.classList.contains('flat');
      lot.classList.toggle('flat', flat);
      flatBtn.setAttribute('aria-pressed', String(flat)); flatBtn.textContent = flat ? 'Tilt' : 'Flat';
      if (flat) { lot.style.removeProperty('--spin'); lot.style.removeProperty('--tilt'); } else { spin = 0; tilt = 52; set(); }
    });
  });

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
