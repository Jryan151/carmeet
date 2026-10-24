/* member.js — a member's page: Share (the phone's share sheet, else copy the link); the feed easing in as it scrolls
   up over the footage; and each clip in the feed loading and playing only while it's on screen (a weak signal never
   downloads a clip nobody scrolled to). */
(function () {
  'use strict';
  var b = document.querySelector('[data-share]');
  if (b) b.addEventListener('click', function () {
    var url = location.origin + location.pathname, title = document.title;
    if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { b.textContent = 'Link copied'; setTimeout(function () { b.textContent = 'Share'; }, 1600); });
  });
  if (!('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(document.querySelectorAll('video[data-feed] source[data-src]'), function (s) { s.src = s.getAttribute('data-src'); });
    return;
  }
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var save = navigator.connection && navigator.connection.saveData;
  // Clips: start when most of one is on screen, pause when it leaves.
  var clips = new IntersectionObserver(function (list) {
    list.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting && e.intersectionRatio >= 0.5) {
        if (!v.hasAttribute('data-on')) {
          v.setAttribute('data-on', '');
          Array.prototype.forEach.call(v.querySelectorAll('source[data-src]'), function (s) { s.src = s.getAttribute('data-src'); });
          v.load();
        }
        v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function () {});
      } else if (!v.paused) v.pause();
    });
  }, { threshold: [0, 0.5] });
  if (!still && !save) Array.prototype.forEach.call(document.querySelectorAll('video[data-feed]'), function (v) { clips.observe(v); });
  else Array.prototype.forEach.call(document.querySelectorAll('video[data-feed]'), function (v) { v.controls = true; v.addEventListener('play', function () { if (!v.hasAttribute('data-on')) { v.setAttribute('data-on', ''); Array.prototype.forEach.call(v.querySelectorAll('source[data-src]'), function (s) { s.src = s.getAttribute('data-src'); }); v.load(); v.play(); } }, { once: true }); });
  if (still) return;
  var shots = document.querySelectorAll('.m-shot');
  var io = new IntersectionObserver(function (list) {
    list.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  for (var i = 0; i < shots.length; i++) { shots[i].classList.add('rise'); io.observe(shots[i]); }
})();
