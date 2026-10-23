/* order.js — one pre-order: paid, cooking, ready. Back from the card page it checks the payment first; then it looks
   again every 20 seconds while the order is still open. */
(function () {
  'use strict';
  var root = document.getElementById('order-app'); if (!root) return;
  var token = root.getAttribute('data-token');
  var q = new URLSearchParams(location.search);
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var money = function (n) { return '$' + (Number(n) || 0).toFixed(2); };
  var timer = null;

  function call(method, path) {
    return fetch('/api/orders/' + token + path, { method: method, cache: 'no-store', headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? '{}' : undefined })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
  }
  function words(o) {
    if (o.status === 'Canceled') return o.payment === 'refunded' ? ['Canceled', 'The truck canceled it and refunded your card.'] : ['Not placed', 'The payment didn’t go through, so nothing was charged.'];
    if (o.payment === 'pending') return ['Waiting for payment', 'Finish on the card page. If you closed it, start the order again.'];
    if (o.status === 'Ready') return ['Ready', 'Grab it at ' + o.vendor + '’s window.'];
    if (o.status === 'Fulfilled') return ['Picked up', 'Enjoy the meet.'];
    return ['Paid', o.vendor + ' will have it ready ' + (o.dayLabel ? o.dayLabel + ' at ' : '') + o.pickupLabel + (o.place ? ' at ' + o.place : '') + '. We’ll email you when it’s ready.'];
  }
  function draw(o) {
    var w = words(o);
    root.innerHTML = '<section><p class="small dim"><a href="' + esc(o.meetUrl) + '">Back to the meet</a></p>' +
      '<p class="dim">Order from ' + esc(o.vendor) + (o.name ? ' for ' + esc(o.name) : '') + '</p>' +
      (o.ticket && o.payment !== 'pending' && o.status !== 'Canceled' ? '<div class="ticket">#' + esc(o.ticket) + '</div>' : '') +
      '<h1 class="' + (o.status === 'Ready' ? 'status-ready' : '') + '" style="font-size:34px;margin:4px 0 8px">' + esc(w[0]) + '</h1><p>' + esc(w[1]) + '</p>' +
      '<table class="lines">' + (o.items || []).map(function (it) { return '<tr><td>' + it.qty + '× ' + esc(it.name) + '</td><td>' + money(it.price * it.qty) + '</td></tr>'; }).join('') +
      '<tr><td><b>Total</b></td><td><b>' + money(o.total) + '</b></td></tr></table>' +
      '<p class="small dim" style="margin-top:12px">Keep this page. Show the number at the window.</p></section>';
    clearTimeout(timer);
    if (['Fulfilled', 'Canceled'].indexOf(o.status) < 0) timer = setTimeout(refresh, 20000);
  }
  function refresh() { call('GET', '').then(function (r) { if (r.ok) draw(r.d); else root.innerHTML = '<p class="msg bad">' + esc(r.d.error || 'Couldn’t find that order.') + '</p>'; }).catch(function () { timer = setTimeout(refresh, 20000); }); }

  var first = q.get('paid') ? call('POST', '/confirm') : q.get('canceled') ? call('POST', '/cancel') : call('GET', '');
  first.then(function (r) {
    if (q.get('paid') || q.get('canceled')) history.replaceState(null, '', location.pathname);
    if (r.ok) draw(r.d); else root.innerHTML = '<p class="msg bad">' + esc(r.d.error || 'Couldn’t find that order.') + '</p>';
  }).catch(function () { root.innerHTML = '<p class="msg bad">No connection. Refresh to try again.</p>'; });
})();
