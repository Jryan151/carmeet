/* bgloop.js — keeps the background footage looping. Phones pause or freeze a muted background video on their own
   (power saving, coming back to the tab or app, a hiccup at the loop point, a dropped connection) and often don't
   start it again. This watches every background clip on the page (.page-bg video, including ones added later, like
   the portal's) and gets it going again: back to the start when it ends, play again when it's paused, a small skip
   when it's frozen, and a fresh load when it's stalled. Nothing happens for reduced motion or data saver. */
(function () {
  'use strict';
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (navigator.connection && navigator.connection.saveData) return;
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
    var s = state(v); if (s.reloads > 5) return; // a clip that keeps failing is left as its still frame
    s.reloads++; var t = v.currentTime || 0;
    v.load();
    v.addEventListener('loadedmetadata', function once() { v.removeEventListener('loadedmetadata', once); try { v.currentTime = t; } catch (e) {} play(v); });
  }
  function check() {
    if (document.hidden) return;
    var list = document.querySelectorAll('.page-bg video');
    for (var i = 0; i < list.length; i++) {
      var v = list[i], s = state(v);
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
})();
