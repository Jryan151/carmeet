/* food.js — a truck's menu for a meet: pick food, a pickup time, then pay on the card page.
   Prices shown here are a preview; the food side works out the real total from the truck's own menu. */
(function () {
  'use strict';
  var root = document.getElementById('food-app'); if (!root) return;
  var meetId = root.getAttribute('data-meet'), truck = root.getAttribute('data-truck');
  var data = null, cart = [], pickupAt = null, tipPct = 0, busy = false, seenTotal = null;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var money = function (n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); };
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return v; }
  function rid(n) { var a = new Uint8Array(n); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (x, i) { a[i] = Math.random() * 256; }); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  var device = store('mn_device') || store('mn_device', rid(16));
  var orderKey = rid(12); // one key per order attempt: a double tap or a retry can't place two orders

  function when(t, opts) { try { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: data.timezone }, opts)).format(new Date(t)); } catch (e) { return new Date(t).toLocaleString(); } }
  function unit(item) { return item.salePrice && item.salePrice > 0 && item.salePrice < item.price ? item.salePrice : item.price; }
  function lineExtra(item, picks) {
    var x = 0; (item.groups || []).forEach(function (g, gi) { (picks[gi] || []).forEach(function (ci) { var c = g.choices[ci]; if (c) x += c.price || 0; }); }); return x;
  }
  function subtotal() { return cart.reduce(function (s, l) { return s + (unit(l.item) + lineExtra(l.item, l.picks)) * l.qty; }, 0); }
  function tipCents() { return data && data.tips && data.tips.on && tipPct ? Math.round(subtotal() * tipPct) : 0; }

  function load() {
    fetch('/api/meets/' + meetId + '/food/' + encodeURIComponent(truck), { cache: 'no-store' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) { if (!r.ok) { root.innerHTML = '<p class="msg bad">' + esc(r.d.error || 'The menu didn’t load.') + '</p>'; return; } data = r.d; render(); })
      .catch(function () { root.innerHTML = '<p class="msg bad">No connection. Refresh to try again.</p>'; });
  }

  function gate() {
    var w = data.window || {};
    if (!data.cardReady) return 'This truck isn’t taking pre-orders. Order at the truck.';
    if (w.open) return '';
    if (Date.now() < w.opensAt) return 'Pre-orders open ' + when(w.opensAt, { weekday: 'long', hour: 'numeric', minute: '2-digit' }) + '. Come back then, or order at the truck.';
    return 'Pre-orders are closed. Order at the truck.';
  }

  function render() {
    var closed = gate();
    var cats = {}, order = [];
    data.menu.forEach(function (it) { var c = (it.category || '').trim() || 'Menu'; if (!cats[c]) { cats[c] = []; order.push(c); } cats[c].push(it); });
    var html = closed ? '<section><p class="turnout">' + esc(closed) + '</p></section>' : '';
    order.forEach(function (c) {
      html += '<section><h2>' + esc(c) + '</h2>';
      cats[c].forEach(function (it) {
        var out = it.soldOut || it.left === 0;
        var p = unit(it);
        var inCart = cart.filter(function (l) { return l.item.id === it.id; }).reduce(function (n, l) { return n + l.qty; }, 0);
        var hasGroups = it.groups && it.groups.length;
        html += '<div class="menu-item' + (it.photo ? ' has-photo' : '') + (out ? ' out' : '') + '">' +
          (it.photo ? '<img src="' + esc(it.photo) + '" alt="" loading="lazy">' : '') +
          '<div><div class="n">' + esc(it.name) + '</div>' + (it.description ? '<div class="d">' + esc(it.description) + '</div>' : '') +
          (out ? '<div class="d">Sold out</div>' : it.left ? '<div class="d">' + it.left + ' left</div>' : '') +
          (!closed && !out ? (hasGroups ? '<div class="choices" id="ch' + it.id + '" hidden></div><button class="btn" style="margin-top:8px;min-height:40px" data-open="' + it.id + '">' + (inCart ? 'Add another' : 'Choose') + '</button>' + (inCart ? ' <span class="d">' + inCart + ' in your order</span>' : '')
            : '<div class="qty"><button aria-label="One less ' + esc(it.name) + '" data-less="' + it.id + '">−</button><span aria-live="polite">' + inCart + '</span><button aria-label="One more ' + esc(it.name) + '" data-more="' + it.id + '">+</button></div>') : '') +
          '</div><div class="p">' + (p < it.price ? '<s class="dim">' + money(it.price) + '</s> ' : '') + money(p) + '</div></div>';
      });
      html += '</section>';
    });
    if (!closed) html += checkout();
    root.innerHTML = html;
  }

  function checkout() {
    var sub = subtotal();
    var lines = cart.map(function (l, i) {
      var names = []; (l.item.groups || []).forEach(function (g, gi) { (l.picks[gi] || []).forEach(function (ci) { if (g.choices[ci]) names.push(g.choices[ci].name); }); });
      return '<tr><td>' + l.qty + '× ' + esc(l.item.name) + (names.length ? ' <span class="dim">(' + esc(names.join(', ')) + ')</span>' : '') +
        ' <button class="link" data-drop="' + i + '" aria-label="Remove ' + esc(l.item.name) + '">remove</button></td><td>' + money((unit(l.item) + lineExtra(l.item, l.picks)) * l.qty) + '</td></tr>';
    }).join('');
    var slots = (data.slots || []).map(function (s) {
      return '<button type="button" data-slot="' + s.at + '" aria-pressed="' + (pickupAt === s.at) + '"' + (s.full ? ' disabled' : '') + '>' + esc(s.label) + '</button>';
    }).join('');
    var tips = data.tips && data.tips.on ? '<label>Tip for the crew</label><div class="tips">' + [0].concat(data.tips.pcts.map(function (p) { return p / 100; })).map(function (p) {
      return '<button type="button" data-tip="' + p + '" aria-pressed="' + (tipPct === p) + '">' + (p ? Math.round(p * 100) + '%' : 'No tip') + '</button>';
    }).join('') + '</div>' : '';
    return '<section id="checkout"><h2>Your order</h2>' +
      (cart.length ? '<table class="lines">' + lines + '</table>' : '<p class="dim">Add something above.</p>') +
      '<label>Pickup time</label><div class="slots">' + (slots || '<p class="dim">No pickup times left.</p>') + '</div>' +
      '<form id="pay">' +
      '<label for="fName">Name for the order</label><input id="fName" name="name" maxlength="40" autocomplete="given-name" required>' +
      '<label for="fEmail">Email (we’ll tell you when it’s ready)</label><input id="fEmail" name="email" type="email" maxlength="120" autocomplete="email" required>' +
      (data.allergyOn ? '<label for="fAllergy">Allergies (optional)</label><input id="fAllergy" name="allergy" maxlength="120">' : '') +
      tips + '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
      '<div class="cartbar"><button class="btn go wide" type="submit"' + (cart.length && pickupAt ? '' : ' disabled') + '>Pay ' + money(sub + tipCents() / 100) + '</button>' +
      '<div class="msg" id="payMsg" role="status">' + (cart.length && !pickupAt ? 'Pick a pickup time.' : '') + '</div>' +
      '<p class="small dim" style="margin:6px 0 0">Card payment goes to the truck. Tax, if any, is added on the card page.</p></div></form></section>';
  }

  function openChoices(it) {
    var box = document.getElementById('ch' + it.id); if (!box) return;
    box.hidden = false;
    box.innerHTML = it.groups.map(function (g, gi) {
      return '<fieldset><legend>' + esc(g.name) + (g.required ? '' : ' (optional)') + (g.pick === 'many' && g.max > 1 ? ' · up to ' + g.max : '') + '</legend>' +
        g.choices.map(function (c, ci) {
          return '<label><input type="' + (g.pick === 'one' ? 'radio' : 'checkbox') + '" name="g' + it.id + '_' + gi + '" value="' + ci + '"' + (c.out ? ' disabled' : '') + '> ' +
            esc(c.name) + (c.price ? ' <span class="dim">+' + money(c.price) + '</span>' : '') + (c.out ? ' <span class="dim">out</span>' : '') + '</label>';
        }).join('') + '</fieldset>';
    }).join('') + '<button class="btn go" data-add="' + it.id + '">Add to order</button><div class="msg" role="status"></div>';
  }
  function addWithChoices(it) {
    var box = document.getElementById('ch' + it.id), picks = [];
    for (var gi = 0; gi < it.groups.length; gi++) {
      var g = it.groups[gi];
      var sel = Array.prototype.map.call(box.querySelectorAll('input[name="g' + it.id + '_' + gi + '"]:checked'), function (x) { return +x.value; });
      if (g.required && !sel.length) { box.querySelector('.msg').className = 'msg bad'; box.querySelector('.msg').textContent = 'Pick one for “' + g.name + '”.'; return; }
      if (g.pick === 'many' && sel.length > g.max) { box.querySelector('.msg').className = 'msg bad'; box.querySelector('.msg').textContent = 'Up to ' + g.max + ' for “' + g.name + '”.'; return; }
      picks.push(sel);
    }
    cart.push({ item: it, qty: 1, picks: picks });
    render();
  }
  function itemById(id) { return data.menu.filter(function (m) { return m.id === id; })[0]; }

  root.addEventListener('click', function (e) {
    var el = e.target.closest('button'); if (!el) return;
    var id;
    if (el.hasAttribute('data-more')) { id = +el.getAttribute('data-more'); var l = cart.filter(function (x) { return x.item.id === id; })[0]; if (l) l.qty = Math.min(50, l.qty + 1); else cart.push({ item: itemById(id), qty: 1, picks: [] }); render(); }
    else if (el.hasAttribute('data-less')) { id = +el.getAttribute('data-less'); cart = cart.map(function (x) { if (x.item.id === id) x.qty--; return x; }).filter(function (x) { return x.qty > 0; }); render(); }
    else if (el.hasAttribute('data-open')) openChoices(itemById(+el.getAttribute('data-open')));
    else if (el.hasAttribute('data-add')) { e.preventDefault(); addWithChoices(itemById(+el.getAttribute('data-add'))); }
    else if (el.hasAttribute('data-drop')) { cart.splice(+el.getAttribute('data-drop'), 1); render(); }
    else if (el.hasAttribute('data-slot')) { pickupAt = +el.getAttribute('data-slot'); keepForm(render); }
    else if (el.hasAttribute('data-tip')) { tipPct = +el.getAttribute('data-tip'); keepForm(render); }
  });
  // Re-drawing the order keeps what was typed.
  function keepForm(fn) {
    var keep = {}; ['fName', 'fEmail', 'fAllergy'].forEach(function (k) { var x = document.getElementById(k); if (x) keep[k] = x.value; });
    fn();
    Object.keys(keep).forEach(function (k) { var x = document.getElementById(k); if (x) x.value = keep[k]; });
  }

  root.addEventListener('submit', function (e) {
    if (e.target.id !== 'pay') return;
    e.preventDefault();
    if (busy) return;
    var f = e.target, msg = document.getElementById('payMsg');
    var total = Math.round(subtotal() * 100) / 100;
    var body = {
      name: document.getElementById('fName').value.trim(), email: document.getElementById('fEmail').value.trim(),
      allergy: document.getElementById('fAllergy') ? document.getElementById('fAllergy').value.trim() : '', website: f.querySelector('.hp').value,
      items: cart.map(function (l) { return { id: l.item.id, qty: l.qty, choices: l.picks }; }), pickupAt: pickupAt, tipCents: tipCents(),
      seenTotal: seenTotal !== null ? seenTotal : total, clientKey: orderKey, device: device,
    };
    busy = true; msg.className = 'msg'; msg.textContent = 'Opening the card page…';
    fetch('/api/meets/' + meetId + '/food/' + encodeURIComponent(truck) + '/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (r) {
        busy = false;
        if (r.ok && r.d.checkoutUrl) { location.href = r.d.checkoutUrl; return; }
        if (r.ok && r.d.token) { location.href = '/o/' + r.d.token; return; }
        msg.className = 'msg bad'; msg.textContent = r.d.error || 'That didn’t go through. Try again.';
        if (r.d.priceChanged) { seenTotal = r.d.total; msg.textContent += ' Tap Pay again to continue.'; }
        if (r.d.slotGone || r.d.stock) { orderKey = rid(12); var keep = pickupAt; load(); pickupAt = r.d.slotGone ? null : keep; }
      })
      .catch(function () { busy = false; msg.className = 'msg bad'; msg.textContent = 'No connection. Try again.'; });
  });

  load();
})();
