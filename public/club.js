/* club.js — a club's page (/c/<name>): "Make it ours" (an email, a 6-digit code, then the page is theirs and the editor
   opens), and on a claimed page, a new editor link for the email that claimed it. */
(function () {
  'use strict';
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .catch(function () { return { ok: false, d: { error: 'No connection. Try again.' } }; });
  }
  var dlg = document.getElementById('claim');
  var open = document.querySelector('[data-claim-open]');
  if (open && dlg) open.addEventListener('click', function () {
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    var i = dlg.querySelector('input[name=email]'); if (i) setTimeout(function () { i.focus(); }, 50);
  });

  Array.prototype.forEach.call(document.querySelectorAll('form[data-claim]'), function (f) {
    var slug = f.getAttribute('data-claim'), relink = f.hasAttribute('data-relink');
    var msg = f.querySelector('.msg'), stepEmail = f.querySelector('[data-step=email]'), stepCode = f.querySelector('[data-step=code]');
    var email = f.querySelector('input[name=email]'), code = f.querySelector('input[name=code]');
    var say = function (t, ok) { msg.className = 'msg ' + (ok ? 'ok' : 'bad'); msg.textContent = t || ''; };
    var busy = false;
    f.addEventListener('submit', function (e) {
      e.preventDefault(); if (busy) return; busy = true;
      var btn = f.querySelector(stepCode.hidden ? '[data-step=email] button[type=submit]' : '[data-step=code] button[type=submit]'); if (btn) btn.disabled = true;
      var done = function () { busy = false; if (btn) btn.disabled = false; };
      if (stepCode.hidden) {
        post('/api/host/club/' + slug + '/code', { email: email.value.trim() }).then(function (r) {
          done();
          if (!r.ok) return say(r.d.error);
          stepEmail.hidden = true; stepCode.hidden = false; code.required = true; code.focus();
          say((relink ? 'If that’s the email the page was claimed with, a code is on its way to ' : 'We sent a code to ') + email.value.trim() + '.' + (r.d.devCode ? ' (Test code: ' + r.d.devCode + ')' : ''), true);
        });
      } else {
        post('/api/host/club/' + slug + '/verify', { email: email.value.trim(), code: code.value.trim() }).then(function (r) {
          done();
          if (!r.ok) return say(r.d.error);
          say(r.d.claimed ? 'It’s yours. Opening your editor… (the link is in your email too)' : 'Opening your editor… (the link is in your email too)', true);
          var u = r.d.editUrl; try { var x = new URL(u); u = x.pathname + x.hash; } catch (er) {} // same site, whichever address it was opened on
          setTimeout(function () { location.href = u; }, 900);
        });
      }
    });
    var again = f.querySelector('[data-claim-again]');
    if (again) again.addEventListener('click', function () { stepCode.hidden = true; stepEmail.hidden = false; code.required = false; code.value = ''; say(''); });
  });
})();
