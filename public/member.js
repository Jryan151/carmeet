/* member.js — a member's page: Share (the phone's share sheet, else copy the link), and the photos easing in as
   they scroll up over the footage. */
(function () {
  'use strict';
  var b = document.querySelector('[data-share]');
  if (b) b.addEventListener('click', function () {
    var url = location.origin + location.pathname, title = document.title;
    if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { b.textContent = 'Link copied'; setTimeout(function () { b.textContent = 'Share'; }, 1600); });
  });
  var shots = document.querySelectorAll('.m-shot');
  if (!('IntersectionObserver' in window) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  var io = new IntersectionObserver(function (list) {
    list.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' });
  for (var i = 0; i < shots.length; i++) { shots[i].classList.add('rise'); io.observe(shots[i]); }
})();
