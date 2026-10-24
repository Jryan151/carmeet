/* bgloop.js — keeps the background footage looping. Phones pause or freeze a muted background video on their own
   (power saving, coming back to the tab or app, a hiccup at the loop point, a dropped connection) and often don't
   start it again. This watches every background clip on the page (.page-bg video, including ones added later, like
   the portal's) and gets it going again: back to the start when it ends, play again when it's paused, a small skip
   when it's frozen, and a fresh load when it's stalled. Nothing happens for reduced motion or data saver. */
(function () {
  'use strict';
  // The sharp still behind the page, once the page has shown (it came as a blur until then). Always, even with no footage.
  function stills() {
    Array.prototype.forEach.call(document.querySelectorAll('.page-bg[data-still]'), function (bg) {
      var src = bg.getAttribute('data-still'); bg.removeAttribute('data-still');
      var im = new Image(); im.onload = function () { bg.style.backgroundImage = 'url("' + src + '")'; }; im.src = src;
    });
  }
  if (document.readyState === 'complete') setTimeout(stills, 30); else window.addEventListener('load', function () { setTimeout(stills, 30); });
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (navigator.connection && navigator.connection.saveData) return;

  /* The clip loads after the page has shown (the words, the flyer and the still frame come first), then fades in
     over the still. On a weak signal the page is usable long before the footage arrives. */
  function begin() {
    var list = document.querySelectorAll('.page-bg video[data-bg]:not([data-started])');
    for (var i = 0; i < list.length; i++) {
      var v = list[i]; v.setAttribute('data-started', '');
      var srcs = v.querySelectorAll('source[data-src]');
      for (var j = 0; j < srcs.length; j++) srcs[j].src = srcs[j].getAttribute('data-src');
      if (v.getAttribute('data-poster')) v.poster = v.getAttribute('data-poster');
      v.preload = 'auto';
      v.addEventListener('playing', function () { this.classList.add('on'); state(this).reloads = 0; }); // playing again: a fresh start on tries
      v.load(); play(v);
    }
  }
  var begun = false;
  var go = function () { if (!begun) { begun = true; setTimeout(begin, 60); } };
  if (document.readyState === 'complete') go(); else { window.addEventListener('load', go); setTimeout(go, 2500); }
  var seen = typeof WeakMap === 'function' ? new WeakMap() : null;
  function state(v) { var s = seen && seen.get(v); if (!s) { s = { at: -1, still: 0, reloads: 0 }; if (seen) seen.set(v, s); watch(v); } return s; }
  function play(v) { v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  function watch(v) {
    v.muted = true; v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.addEventListener('ended', function () { try { v.currentTime = 0; } catch (e) {} play(v); });
    v.addEventListener('stalled', function () { setTimeout(function () { if (v.readyState < 3) reload(v); }, 4000); });
    v.addEventListener('error', function () { setTimeout(function () { reload(v); }, 3000); });
  }
  function reload(v) {
    var s = state(v);
    // A clip that keeps failing rests as its still frame, then tries again every 30 s (the signal comes back at a meet);
    // it never gives up for the rest of the visit.
    if (s.reloads > 5) { if (!s.later) s.later = setTimeout(function () { s.later = null; s.reloads = 4; reload(v); }, 30000); return; }
    s.reloads++; var t = v.currentTime || 0;
    v.load();
    v.addEventListener('loadedmetadata', function once() { v.removeEventListener('loadedmetadata', once); try { v.currentTime = t; } catch (e) {} play(v); });
  }
  function check() {
    if (document.hidden) return;
    var list = document.querySelectorAll('.page-bg video');
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v.hasAttribute('data-bg') && !v.hasAttribute('data-started')) continue; // not started yet
      var s = state(v);
      if (v.paused) { play(v); s.still = 0; s.at = v.currentTime; continue; }
      if (v.currentTime === s.at) {
        // Playing but not moving: skip a hair forward (past a bad frame or the loop seam), then reload if it stays stuck.
        if (++s.still === 2) { try { v.currentTime = v.duration && v.currentTime + 0.1 < v.duration ? v.currentTime + 0.1 : 0; } catch (e) {} play(v); }
        else if (s.still >= 4) { s.still = 0; reload(v); }
      } else s.still = 0;
      s.at = v.currentTime;
    }
  }
  setInterval(check, 1500);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(check, 50); });
  window.addEventListener('pageshow', function () { setTimeout(check, 50); });
  window.addEventListener('focus', function () { setTimeout(check, 50); });
  // Back online: anything stuck tries again now.
  window.addEventListener('online', function () {
    var list = document.querySelectorAll('.page-bg video');
    for (var i = 0; i < list.length; i++) { var s = state(list[i]); s.reloads = 0; if (list[i].readyState < 3) reload(list[i]); }
  });
})();
