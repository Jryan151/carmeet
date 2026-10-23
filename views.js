'use strict';
/* views.js — the public pages, written on the server (fast on a phone, and link previews show the meet). */
const U = require('./util');
const { esc } = U;

const SITE = () => process.env.SITE_NAME || 'Meet Night';
// A new version on every restart, so phones never keep an old stylesheet after an update.
const STARTED = Date.now().toString(36);
const ver = () => process.env.ASSET_VERSION || STARTED;
// The flyer's own font, only when its file has been put in public/fonts (see the README there).
const fs = require('fs');
const path = require('path');
function ownFont() {
  const dir = path.join(__dirname, 'public', 'fonts');
  const f = ['good-times.woff2', 'good-times.otf', 'good-times.ttf'].find((n) => fs.existsSync(path.join(dir, n)));
  if (!f) return '';
  const fmt = f.endsWith('woff2') ? 'woff2' : f.endsWith('otf') ? 'opentype' : 'truetype';
  return `<style>@font-face{font-family:"Good Times";src:url("/static/fonts/${f}") format("${fmt}");font-display:swap}</style>`;
}

function layout({ title, description, host, body, scripts = [], noindex, image }) {
  const accent = host && /^#[0-9a-f]{6}$/i.test(host.accent || '') ? host.accent : null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
<meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="theme-color" content="#07060b">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Michroma&family=Instrument+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/static/site.css?v=${ver()}">
${ownFont()}
${accent ? `<style>:root{--accent:${accent}}</style>` : ''}
</head>
<body>
${body}
${scripts.map((s) => `<script src="/static/${s}?v=${ver()}" defer></script>`).join('\n')}
</body>
</html>`;
}

function top(host, base) {
  return `<header class="wrap top">
  <div><a class="who" href="${esc(base || '/')}" style="text-decoration:none">${esc(host.name)}</a>${host.city ? `<div class="city">${esc(host.city)}</div>` : ''}</div>
</header>`;
}

function footer(host, base, { badge }) {
  const s = [];
  if (host.instagram) s.push(`<a href="https://instagram.com/${esc(host.instagram)}" rel="noopener">Instagram</a>`);
  if (host.tiktok) s.push(`<a href="https://tiktok.com/@${esc(host.tiktok)}" rel="noopener">TikTok</a>`);
  if (host.youtube) s.push(`<a href="https://youtube.com/@${esc(host.youtube)}" rel="noopener">YouTube</a>`);
  return `<footer><div class="wrap">
  ${s.length ? `<div class="social">${s.join('')}</div>` : ''}
  <details class="ask" id="spot">
    <summary>Food vendor? Ask for a spot</summary>
    <form data-form="vendor" data-host="${esc(host.slug)}">
      <label for="vrName">Business name</label><input id="vrName" name="name" maxlength="60" required>
      <label for="vrContact">Phone or email</label><input id="vrContact" name="contact" maxlength="80" required>
      <label for="vrFood">What you serve</label><input id="vrFood" name="food" maxlength="80" placeholder="Birria tacos, lemonade">
      <label for="vrNote">Anything else (optional)</label><textarea id="vrNote" name="note" maxlength="400"></textarea>
      <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <p style="margin-top:12px"><button class="btn" type="submit">Send to ${esc(host.name)}</button></p>
      <div class="msg" role="status"></div>
    </form>
  </details>
  ${badge ? `<p style="margin-top:20px">Page by <a href="/">${esc(SITE())}</a></p>` : ''}
</div></footer>`;
}

/** The background loop behind the top of the page (a meet's own clip, or the host's usual one). */
function heroBg(vid) {
  if (!vid) return '';
  // Fixed behind the whole page: everything scrolls over the loop.
  return `<div class="page-bg" aria-hidden="true" style="background-image:url('/uploads/${esc(vid.video_poster)}')">
    <video autoplay muted loop playsinline preload="auto" poster="/uploads/${esc(vid.video_poster)}" disablepictureinpicture><source src="/uploads/${esc(vid.video)}" type="video/mp4"></video>
  </div>`;
}

/** The host's logo as a round profile picture: the top of their main page, no words. */
function avatar(host) {
  return host.logo ? `<div class="avatar"><img src="${esc(host.logo)}" alt="${esc(host.name)}"></div>` : '';
}
/** Where a truck's menu opens: the food side's own page through this site (meet mode), or the old page here. */
function menuLink(v, m, mpath, ctx, canOrder) {
  if (ctx.meetMode) return `/meet/${encodeURIComponent(m.ref)}/${encodeURIComponent(v.slug)}/`;
  return canOrder ? `${mpath}/food/${encodeURIComponent(v.slug)}` : null;
}

/** The meet in its parking space: day, date, time, spot, and how soon. */
function stall(m, tz, { live, logo } = {}) {
  const t = U.meetTimes(m, tz);
  const off = m.status === 'canceled';
  const date = U.fmt(t.startsAt, tz, { month: 'short', day: 'numeric' });
  const dow = U.fmt(t.startsAt, tz, { weekday: 'long' });
  const maps = m.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.address)}` : null;
  return `<div class="stall${off ? ' off' : ''}">
  <div class="halo" aria-hidden="true"></div>
  ${logo ? `<img class="mark" src="${esc(logo)}" alt="">` : ''}
  <div class="dow">${esc(dow)}${m.title ? ` · ${esc(m.title)}` : ''}</div>
  <div class="date">${esc(date)}</div>
  <div class="time">${esc(U.time12(t.startsAt, tz))}–${esc(U.time12(t.endsAt, tz))}</div>
  <div class="where">${esc(m.place)}${maps ? ` · <a href="${esc(maps)}" rel="noopener">Directions</a>` : ''}</div>
  ${off ? '<div class="soon">Canceled</div>' : live ? `<div class="soon" data-countdown="${t.startsAt}" data-ends="${t.endsAt}"></div>` : ''}
</div>`;
}

/** A host's page for one meet (their home page shows the next one). */
function meetPage(host, m, ctx) {
  const tz = ctx.tz;
  const base = ctx.base;
  const t = U.meetTimes(m, tz);
  const over = t.endsAt < Date.now();
  const trucks = (ctx.trucks || []).filter((v) => v.status === 'in');
  const anyPreorder = !over && m.status === 'on' && trucks.some((v) => v.cardReady);
  const mpath = `${base}/${m.day}`;
  const rules = String(host.rules || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const desc = `${U.dayLong(t.startsAt, tz)}, ${U.time12(t.startsAt, tz)} at ${m.place}.${trucks.length ? ' Food: ' + trucks.map((v) => v.name).join(', ') + '.' : ''}`;
  // The background loop: this meet's own clip, or the host's usual one.
  const vid = m.video && m.video_status === 'ready' ? m : host.video && host.video_status === 'ready' ? host : null;
  // The main page opens on the round logo (no header text); the other meet pages keep the name at the top.
  const round = ctx.isHome && host.logo;
  let body = (round ? '' : top(host, base)) + `<main class="wrap">
<section class="hero${vid ? ' has-video' : ''}${m.flyer ? ' with-flyer' : ''}${round ? ' has-avatar' : ''}">
  ${heroBg(vid)}
  ${round ? avatar(host) : ''}
  ${ctx.isHome ? '' : `<p class="small dim"><a href="${esc(base || '/')}">Next meet</a></p>`}
  ${m.flyer ? `<figure class="flyer"><img src="/uploads/${esc(m.flyer)}" alt="${esc(host.name)} flyer for ${esc(U.dayLong(t.startsAt, tz))}"></figure>` : ''}
  ${stall(m, tz, { live: !over, logo: m.flyer || round ? null : host.logo })}
  ${over ? '<p class="dim">This meet is over.</p>' : ''}
  ${!over && m.status === 'on' ? `<div class="actions">
    ${anyPreorder ? `<a class="btn go" href="#food">Pre-order food</a>` : ''}
    <a class="btn${anyPreorder ? '' : ' go'}" href="#alerts">Get alerts</a>
  </div>` : ''}
  ${m.notes ? `<p class="dim" style="margin-top:10px">${esc(m.notes)}</p>` : ''}
</section>`;
  body += `<section id="food"><h2>Food</h2>`;
  if (!trucks.length) body += `<p class="dim">${over ? 'No food trucks were listed for this meet.' : 'Food trucks will show here once they’re confirmed.'}</p>`;
  for (const v of trucks) {
    const can = anyPreorder && v.cardReady;
    const href = over || m.status !== 'on' ? null : menuLink(v, m, mpath, ctx, can);
    const note = can ? 'Pre-order, pick up at the meet' : href ? 'See the menu' : 'Order at the truck';
    const inner = `${v.logo ? `<img class="tlogo" src="${esc(v.logo)}" alt="" loading="lazy">` : `<span class="tlogo emoji" aria-hidden="true">${esc(v.emoji || '🍽')}</span>`}
      <div class="tinfo"><div class="name">${esc(v.name)}</div><div class="note">${note}</div></div>
      ${href ? `<span class="btn${can ? ' go' : ''}">${can ? 'Pre-order' : 'Menu'}</span>` : ''}`;
    body += href ? `<a class="truck" href="${esc(href)}">${inner}</a>` : `<div class="truck">${inner}</div>`;
  }
  body += `</section>`;
  if (ctx.last && ctx.last.people) {
    body += `<section><p class="turnout">Last meet: about ${ctx.last.people} people${ctx.last.cars ? `, ${ctx.last.cars} cars` : ''}</p>
    <p class="small dim">${esc(U.dayShort(ctx.last.at, tz))}${ctx.last.place ? ` at ${esc(ctx.last.place)}` : ''}</p></section>`;
  }
  if (m.address || rules.length) {
    body += `<section><h2>The spot</h2><p>${esc(m.place)}${m.address ? `<br><span class="dim">${esc(m.address)}</span>` : ''}</p>
    ${rules.length ? `<h3 style="margin:16px 0 8px">House rules</h3><ul class="rules">${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</section>`;
  }
  const rc = ctx.recap;
  if (rc && (rc.video_url || (rc.photos && rc.photos.length))) {
    body += `<section><h2>Recap</h2>
    ${rc.video_url ? `<a class="video" href="${esc(rc.video_url)}" rel="noopener"><b>Watch the recap</b><span class="dim small">${esc(rc.caption || 'Video from the last meet')}</span></a>` : (rc.caption ? `<p>${esc(rc.caption)}</p>` : '')}
    ${rc.photos && rc.photos.length ? `<div class="photos">${rc.photos.map((p) => `<img src="${esc(p)}" alt="" loading="lazy">`).join('')}</div>` : ''}</section>`;
  }
  body += `<section id="alerts"><h2>Get alerts</h2>
  <p class="dim">An email when the next meet is posted or something changes. Nothing else.</p>
  <form class="row" data-form="alerts" data-host="${esc(host.slug)}">
    <input type="email" name="email" required maxlength="120" placeholder="you@email.com" aria-label="Your email">
    <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
    <button class="btn go" type="submit">Join</button>
  </form>
  <div class="msg" role="status"></div></section>`;
  if (ctx.upcoming && ctx.upcoming.length > 1) {
    body += `<section><h2>Coming up</h2><div class="list-meets">${ctx.upcoming.filter((u) => u.id !== m.id).slice(0, 4).map((u) => {
      const ut = U.meetTimes(u, tz);
      return `<a href="${esc(base)}/${esc(u.day)}"><b>${esc(U.dayShort(ut.startsAt, tz))}</b> <span class="dim">${esc(U.time12(ut.startsAt, tz))} · ${esc(u.place)}${u.status === 'canceled' ? ' · canceled' : ''}</span></a>`;
    }).join('')}</div></section>`;
  }
  body += `</main>` + footer(host, base, ctx);
  return layout({ title: `${host.name}: ${U.dayShort(t.startsAt, tz)}${m.title ? ' · ' + m.title : ''}`, description: desc, host, body, scripts: ['site.js'], image: !ctx.origin ? null : m.flyer ? `${ctx.origin}/uploads/${m.flyer}` : vid ? `${ctx.origin}/uploads/${vid.video_poster}` : null });
}

/** A host with nothing scheduled yet. */
function hostEmpty(host, ctx) {
  const vid = host.video && host.video_status === 'ready' ? host : null;
  const body = (host.logo ? '' : top(host, ctx.base)) + `<main class="wrap"><section class="hero${vid ? ' has-video' : ''}${host.logo ? ' has-avatar' : ''}">
  ${heroBg(vid)}
  ${avatar(host)}
  <div class="stall"><div class="halo" aria-hidden="true"></div><div class="dow">Next meet</div><div class="date">Soon</div><div class="time">Get an alert when it’s posted</div></div>
  <div class="actions"><a class="btn go" href="#alerts">Get alerts</a></div>
  </section>
  <section id="alerts"><h2>Get alerts</h2><p class="dim">An email when the next meet is posted. Nothing else.</p>
  <form class="row" data-form="alerts" data-host="${esc(host.slug)}"><input type="email" name="email" required maxlength="120" placeholder="you@email.com" aria-label="Your email">
  <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="btn go" type="submit">Join</button></form><div class="msg" role="status"></div></section></main>` + footer(host, ctx.base, ctx);
  return layout({ title: host.name, description: `${host.name}: car meets${host.city ? ' in ' + host.city : ''}.`, host, body, scripts: ['site.js'] });
}

/** A truck's menu for a meet, with pickup times and the cart (site.js builds it from the menu data). */
function foodPage(host, m, truck, ctx) {
  const tz = ctx.tz;
  const t = U.meetTimes(m, tz);
  const body = top(host, ctx.base) + `<main class="wrap">
<section>
  <p class="small dim"><a href="${esc(ctx.base)}/${esc(m.day)}">${esc(U.dayShort(t.startsAt, tz))} at ${esc(m.place)}</a></p>
  <h1 style="font-size:40px;margin:6px 0 4px">${esc(truck.emoji ? truck.emoji + ' ' : '')}${esc(truck.name)}</h1>
  <p class="dim">Pay now, pick up at the meet. Your food is made to be ready at the time you pick.</p>
</section>
<div id="food-app" data-meet="${m.id}" data-truck="${esc(truck.slug)}"><p class="dim">Loading the menu…</p></div>
</main>`;
  return layout({ title: `${truck.name} at ${host.name}`, description: `Pre-order from ${truck.name} for ${U.dayShort(t.startsAt, tz)}.`, host, body, scripts: ['food.js'], noindex: true });
}

function orderPage(host, ctx) {
  const body = (host ? top(host, ctx.base) : `<header class="wrap top"><a class="who" href="/" style="text-decoration:none">${esc(SITE())}</a></header>`) +
    `<main class="wrap"><div id="order-app" data-token="${esc(ctx.token)}"><p class="dim">Loading your order…</p></div></main>`;
  return layout({ title: 'Your order', host, body, scripts: ['order.js'], noindex: true });
}

function message(host, { title, text, href, cta }) {
  const body = (host ? top(host, '') : `<header class="wrap top"><a class="who" href="/" style="text-decoration:none">${esc(SITE())}</a></header>`) +
    `<main class="wrap"><section><h1 style="font-size:36px;margin-bottom:12px">${esc(title)}</h1><p class="dim">${esc(text)}</p>
    ${href ? `<p><a class="btn" href="${esc(href)}">${esc(cta || 'Go back')}</a></p>` : ''}</section></main>`;
  return layout({ title, host, body, noindex: true });
}

/** What this site keeps and why. Plain facts; the operator should have it checked before launch. */
function privacy(host) {
  const who = host ? host.name : SITE();
  const body = (host ? top(host, '') : `<header class="wrap top"><a class="who" href="/" style="text-decoration:none">${esc(SITE())}</a></header>`) + `<main class="wrap"><section class="prose">
<h1 style="font-size:36px;margin-bottom:12px">Privacy</h1>
<p class="dim">What ${esc(who)}’s pages keep, and why.</p>
<h2>Meet alerts</h2><p>If you join alerts, we keep your email address to send you new meets and changes. Every email has a link to stop them, and stopping deletes the address from the list.</p>
<h2>Food pre-orders</h2><p>Menus and pre-orders are run by each food truck’s ordering service. A pre-order keeps the name you give for pickup, what you ordered and the pickup time, so the truck can make it. Cards are paid through Stripe; this site never sees or keeps card numbers.</p>
<h2>Vendor requests</h2><p>If you ask for a vendor spot, the details you send go to the meet’s host so they can reply.</p>
<h2>What we don’t do</h2><p>No ads, no tracking scripts, and we don’t sell or share your details with anyone else. Pages keep a small note in your browser (like an order in progress) that never leaves your phone.</p>
<h2>Questions</h2><p>${host && host.instagram ? `Message <a href="https://instagram.com/${esc(host.instagram)}" rel="noopener">@${esc(host.instagram)}</a>` : 'Message the meet’s host'} to see or delete anything kept about you.</p>
</section></main>`;
  return layout({ title: `Privacy · ${who}`, host, body });
}

/** The site's own front page: the meets coming up, and how a host gets a page. */
function home(list, site) {
  const tz = process.env.TIMEZONE || 'America/Phoenix';
  const body = `<header class="wrap top"><span class="who">${esc(SITE())}</span></header>
<main class="wrap">
<section class="hero${site && site.video && site.video_status === 'ready' ? ' has-video' : ''}">
  ${heroBg(site && site.video && site.video_status === 'ready' ? site : null)}
  <div class="stall"><div class="halo" aria-hidden="true"></div><div class="dow">Car meets</div><div class="date word">${esc(SITE())}</div><div class="time">Where they are, when, and what’s to eat</div></div>
</section>
<section><h2>Coming up</h2>
${list.length ? `<div class="list-meets">${list.map((r) => {
    const t = U.meetTimes(r, r.timezone || tz);
    return `<a href="/${esc(r.slug)}/${esc(r.day)}"><b>${esc(r.host_name)}</b><span class="dim">${esc(U.dayShort(t.startsAt, r.timezone || tz))}, ${esc(U.time12(t.startsAt, r.timezone || tz))} · ${esc(r.place)}</span></a>`;
  }).join('')}</div>` : '<p class="dim">Nothing posted yet.</p>'}
</section>
</main>
<footer><div class="wrap">${esc(SITE())}</div></footer>`;
  return layout({ title: `${SITE()}: car meets`, description: 'Car meets: where, when, and food you can pre-order.', body });
}

module.exports = { layout, meetPage, hostEmpty, foodPage, orderPage, message, home, privacy };
