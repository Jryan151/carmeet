'use strict';
/* views.js — the public pages, written on the server (fast on a phone, and link previews show the meet). */
const fs = require('fs');
const path = require('path');
const U = require('./util');
const LotMap = require('./public/lotmap');
const geo = require('./geo');
const { esc } = U;

const SITE = () => process.env.SITE_NAME || 'Meet Night';
/** The phone-size copy of an upload when there is one (video.small), else the upload itself. A copy found is
    remembered; a missing one is looked for again after a minute (it may be being made). */
const UPLOADS = () => process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const smallSeen = new Map();
function small(file, size) {
  if (!file) return '';
  const f = path.basename(String(file));
  const s = f.replace(/\.[A-Za-z0-9]+$/, '') + `.s${size}.webp`;
  const hit = smallSeen.get(s);
  if (hit === true || (hit && Date.now() - hit < 60000)) return '/uploads/' + (hit === true ? s : f);
  const there = fs.existsSync(path.join(UPLOADS(), s));
  smallSeen.set(s, there ? true : Date.now());
  if (!there) makeSmall(f, size);
  return '/uploads/' + (there ? s : f);
}
/* A missing copy is made in the background the first time a page wants it (one at a time, so the server
   never spends more than one ffmpeg on this); the next visit gets it. */
const making = new Set(); const queue = [];
let busy = false;
function makeSmall(f, size) {
  if (!/\.(png|jpe?g|webp|gif)$/i.test(f) || making.has(f + size)) return;
  making.add(f + size); queue.push([f, size]); drain();
}
async function drain() {
  if (busy) return; busy = true;
  try {
    for (let job; (job = queue.shift());) {
      const [f, size] = job;
      const src = path.join(UPLOADS(), f);
      if (fs.existsSync(src)) {
        const name = await require('./video').small(src, UPLOADS(), size);
        if (name) smallSeen.set(name, true);
      }
    }
  } finally { busy = false; }
}
// A new version on every restart, so phones never keep an old stylesheet after an update.
const STARTED = Date.now().toString(36);
const ver = () => process.env.ASSET_VERSION || STARTED;
// The flyer's own font, only when its file has been put in public/fonts (see the README there).
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
<link rel="preload" href="/static/fonts/instrument-sans-400.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="/static/fonts.css?v=${ver()}">
<link rel="stylesheet" href="/static/site.css?v=${ver()}">
${ownFont()}
${accent ? `<style>:root{--accent:${accent}}</style>` : ''}
</head>
<body>
${body}
${(body.includes('class="page-bg"') ? ['bgloop.js'] : []).concat(scripts).map((s) => `<script src="/static/${s}?v=${ver()}" defer></script>`).join('\n')}
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
  return `<div class="page-bg" aria-hidden="true" style="background-image:url('${esc(small(vid.video_poster, 1280))}')">
    <video muted loop playsinline preload="none" poster="${esc(small(vid.video_poster, 1280))}" disablepictureinpicture data-bg>${vid.video_hevc ? `<source data-src="/uploads/${esc(vid.video_hevc)}" type='video/mp4; codecs="hvc1"'>` : ''}<source data-src="/uploads/${esc(vid.video)}" type="video/mp4"></video>
    <noscript><style>.page-bg video{display:none}</style></noscript>
  </div>`;
}

/** The top button for news of the next meet: the host's Instagram when they've added it, else the email alerts. */
function alertsBtn(host, main) {
  const cls = `btn${main ? ' go' : ''}`;
  return host.instagram
    ? `<a class="${cls}" href="https://instagram.com/${esc(host.instagram)}" rel="noopener">Follow on Instagram</a>`
    : host.alerts_on ? `<a class="${cls}" href="#alerts">Get alerts</a>` : '';
}
/** Little round logos, like profile pictures (vendors under Food, car clubs under Clubs). One with a menu is a link,
    marked with a small tag under it. */
function minis(list) {
  return `<div class="minis">${list.map((k) => {
    const face = k.img ? `<img src="${esc(k.img)}" alt="" loading="lazy">` : `<span class="emoji" aria-hidden="true">${esc(k.emoji || '🍽')}</span>`;
    const open = k.open ? '<span class="live" aria-hidden="true"></span>' : '';
    const label = `${k.name}${k.open ? ', open now' : ''}${k.tag ? ': ' + (k.can ? 'pre-order' : 'menu') : k.profile ? '' : k.external ? ': Instagram' : ''}`;
    const newTab = !k.profile && (k.external || !k.tag);
    return k.href
      ? `<a class="mini${k.tag ? ' menu' : ''}" href="${esc(k.href)}"${newTab ? ' rel="noopener" target="_blank"' : ''} aria-label="${esc(label)}" title="${esc(k.name)}">${face}${open}${k.tag ? `<span class="tag">${k.tag}</span>` : ''}</a>`
      : `<span class="mini" role="img" aria-label="${esc(label)}" title="${esc(k.name)}">${face}${open}</span>`;
  }).join('')}</div>`;
}
/** The host's logo as a round profile picture: the top of their main page, no words. */
function avatar(host, m) {
  const logo = (m && m.logo ? '/uploads/' + m.logo : '') || host.logo;
  return logo ? `<div class="avatar"><img src="${esc(/^\/uploads\//.test(logo) ? small(logo, 720) : logo)}" alt="${esc((m && m.title) || host.name)}"></div>` : '';
}
/** Where a truck's menu opens: the food side's own page through this site (meet mode), or the old page here. */
function menuLink(v, m, mpath, ctx, canOrder) {
  if (ctx.demo) return '#food'; // demo mode: sample trucks have no menu
  if (ctx.meetMode) return `/meet/${encodeURIComponent(m.ref)}/${encodeURIComponent(v.slug)}/`;
  return canOrder ? `${mpath}/food/${encodeURIComponent(v.slug)}` : null;
}

/** When and where: day, date, time, the spot with directions, and how soon. Shown under "The spot". */
function when(m, tz, { live } = {}) {
  const t = U.meetTimes(m, tz);
  const off = m.status === 'canceled';
  const date = U.fmt(t.startsAt, tz, { month: 'short', day: 'numeric' });
  const dow = U.fmt(t.startsAt, tz, { weekday: 'long' });
  const maps = m.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(m.address)}` : null;
  return `<div class="when${off ? ' off' : ''}">
  <div class="dow">${esc(dow)}${m.title ? ` · ${esc(m.title)}` : ''}</div>
  <div class="date">${esc(date)}</div>
  <div class="time">${esc(U.time12(t.startsAt, tz))}–${esc(U.time12(t.endsAt, tz))}</div>
  ${off ? '<div class="soon">Canceled</div>' : live ? `<div class="soon" data-countdown="${t.startsAt}" data-ends="${t.endsAt}"></div>` : ''}
  <p class="where">${esc(m.place)}${m.address ? `<br><span class="dim">${esc(m.address)}</span>` : ''}</p>
  ${maps ? `<a class="btn" href="${esc(maps)}" rel="noopener">Directions</a>` : ''}
</div>`;
}

/** The parking map: the satellite view of the spot, flat and north up, with the host's zones (club parking, vendors,
    overflow...) and pins drawn on it and a key. Written here, so it shows with no script. */
function parkingMap(m) {
  const lot = LotMap.clean(m.lot);
  if (!lot) return '';
  const f = LotMap.frame(lot);
  const pc = (v) => (v / LotMap.FRAME * 100).toFixed(3) + '%';
  const tpl = geo.tiles();
  const tiles = f.tiles.map((t) => `<img class="tile" src="${esc(LotMap.tileUrl(tpl, t))}" alt="" draggable="false" loading="lazy" decoding="async" style="left:${pc(t.left)};top:${pc(t.top)}">`).join('');
  const zones = lot.zones.map((z) => ({ z, pts: z.pts.map((p) => LotMap.inFrame(lot, f, p.lat, p.lng)) }));
  const svg = `<svg class="zones" viewBox="0 0 ${LotMap.FRAME} ${LotMap.FRAME}" aria-hidden="true">${zones.map(({ z, pts }) =>
    `<polygon points="${pts.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" style="--z:${z.color}"${z.kind === 'nopark' ? ' class="no"' : ''}/>`).join('')}</svg>`;
  const tags = zones.filter(({ z }) => z.label).map(({ z, pts }) => {
    const c = LotMap.middle(pts);
    return `<span class="pin zone" style="left:${pc(c.x)};top:${pc(c.y)};--pin:${z.color}"><b>${esc(z.label || LotMap.ZONES[z.kind])}</b></span>`;
  }).join('') + lot.pins.map((p) => {
    const c = LotMap.inFrame(lot, f, p.lat, p.lng);
    return `<span class="pin" style="left:${pc(c.x)};top:${pc(c.y)};--pin:${LotMap.PIN_COLOR[p.kind]}"><b>${esc(p.label || LotMap.PINS[p.kind])}</b></span>`;
  }).join('');
  // The key: each zone once (by its name and color), then the kinds of pins.
  const seen = new Set(); const key = [];
  for (const z of lot.zones) { const n = z.label || LotMap.ZONES[z.kind]; if (!seen.has(n + z.color)) { seen.add(n + z.color); key.push([n, z.color]); } }
  for (const k of [...new Set(lot.pins.map((p) => p.kind))]) key.push([LotMap.PINS[k], LotMap.PIN_COLOR[k]]);
  const there = `https://www.google.com/maps/search/?api=1&query=${lot.lat},${lot.lng}`;
  return `<div class="lot flat">
  <div class="lot-stage"><div class="lot-plane"><div class="lot-map"><div class="lot-img">${tiles}${svg}</div>${tags}</div></div></div>
  <div class="lot-bar">
    ${key.length ? `<div class="lot-key">${key.slice(0, 12).map(([n, c]) => `<span style="--pin:${c}">${esc(n)}</span>`).join('')}</div>` : '<span></span>'}
  </div>
  <p class="small dim lot-hint"><a href="${esc(there)}" target="_blank" rel="noopener">Open in Maps</a>${geo.credit() ? ` · <span class="lot-credit">${esc(geo.credit())}</span>` : ''}</p>
</div>`;
}

/** The business the meet is at (it lets them use its lot): logo, name, a line about it, its Instagram. */
function venueCard(v) {
  if (!v) return '';
  const ig = v.instagram ? `https://instagram.com/${encodeURIComponent(v.instagram)}` : null;
  return `<div class="venue">
  <div class="mini">${v.file ? `<img src="${esc(small(v.file, 256))}" alt="" loading="lazy">` : '<span class="emoji" aria-hidden="true">📍</span>'}</div>
  <div class="v-info"><div class="small dim">At</div><div class="v-title">${esc(v.name)}</div>${v.note ? `<div class="small dim">${esc(v.note)}</div>` : ''}</div>
  ${ig ? `<a class="btn sm" href="${esc(ig)}" rel="noopener" target="_blank">Instagram</a>` : ''}
</div>`;
}

/** A host's page for one meet (their home page shows the next one). */
function meetPage(host, m, ctx) {
  const tz = ctx.tz;
  const base = ctx.base;
  const t = U.meetTimes(m, tz);
  const over = t.endsAt < Date.now();
  const trucks = (ctx.trucks || []).filter((v) => v.status === 'in');
  // Who takes pre-orders: card trucks, and in meet mode also trucks paid at the truck (the night kit), unless paused.
  const takes = (v) => !v.paused && (v.cardReady || (ctx.meetMode && v.payAtTruck));
  const anyPreorder = !over && m.status === 'on' && trucks.some(takes);
  const mpath = `${base}/${m.day}`;
  const rules = String(host.rules || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const foodNames = trucks.map((v) => v.name).concat((ctx.kitVendors || []).filter((k) => k.kind === 'vendor').map((k) => k.name)).filter((n, i, a) => n && a.indexOf(n) === i);
  const desc = `${U.dayLong(t.startsAt, tz)}, ${U.time12(t.startsAt, tz)} at ${ctx.venue ? ctx.venue.name + ', ' : ''}${m.place}.${foodNames.length ? ' Food: ' + foodNames.join(', ') + '.' : ''}`;
  // The background loop: this meet's own clip, or the host's usual one.
  const vid = m.video && m.video_status === 'ready' ? m : host.video && host.video_status === 'ready' ? host : null;
  // The top of the page: the host's logo (or name), the flyer, and the buttons. When and where are under "The spot".
  const round = !!(m.logo || host.logo); // the meet's own header logo, else the host's usual one
  let body = (ctx.demo ? `<div class="demo-bar" role="note"><b>Demo mode</b> · sample trucks and every logo in your kit. Only you see this. <a href="/host">Back to the portal</a></div>` : '') +
    (round ? '' : top(host, base)) + `<main class="wrap">
<section class="hero${vid ? ' has-video' : ''}${m.flyer ? ' with-flyer' : ''}${round ? ' has-avatar' : ''}">
  ${heroBg(vid)}
  ${round ? avatar(host, m) : ''}
  ${m.flyer ? `<figure class="flyer"><img src="${esc(small(m.flyer, 1080))}" alt="${esc(m.title || host.name)} flyer for ${esc(U.dayLong(t.startsAt, tz))}"></figure>` : '<div class="showcase" aria-hidden="true"></div>'}
  ${ctx.isHome ? '' : `<p class="small dim" style="text-align:center"><a href="${esc(base || '/')}">Next meet</a></p>`}
  ${over ? '<p class="dim" style="text-align:center">This meet is over.</p>' : m.status === 'canceled' ? '<p class="soon-line">This meet is canceled.</p>' : ''}
  ${!over && m.status === 'on' ? `<div class="actions">
    ${anyPreorder ? `<a class="btn go" href="#food">Pre-order food</a>` : ''}
    ${alertsBtn(host, !anyPreorder)}
  </div>` : ''}
  ${m.notes ? `<p class="dim" style="margin-top:10px">${esc(m.notes)}</p>` : ''}
</section>`;
  // When and where, right under the top.
  body += `<section id="spot"><h2>The spot</h2>${when(m, tz, { live: !over })}${venueCard(ctx.venue)}
    ${m.lot && !over ? `<h3 style="margin:20px 0 10px" id="parking">Where to park</h3>${parkingMap(m)}` : ''}
    ${rules.length ? `<h3 style="margin:16px 0 8px">House rules</h3><ul class="rules">${rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</section>`;
  body += `<section id="food"><h2>Food</h2>`;
  // Everyone serving food, as little round logos (like profile pictures). Each truck in the meet uses the logo from
  // the host's Food vendors (tied to its profile, or the same name), else its own logo or emoji, and opens its menu
  // (its pre-orders, or a night kit's menu for the night). Food vendors the host picked who aren't on the food side
  // open their Instagram. "Open" shows when the truck tapped We're open.
  const norm = (x) => String(x || '').trim().toLowerCase();
  const all = ctx.kitAll || [];
  const ig = (h) => (h ? `https://instagram.com/${encodeURIComponent(h)}` : null);
  const live = !over && m.status === 'on';
  const hrefOf = (v) => (live ? menuLink(v, m, mpath, ctx, anyPreorder && takes(v)) : null);
  const picked = (ctx.kitVendors || []).filter((k) => k.kind === 'vendor');
  const kitOf = (v) => all.find((k) => k.kind === 'vendor' && k.truck_slug === v.slug) || picked.find((k) => k.meet_truck === v.slug) ||
    all.find((k) => k.kind === 'vendor' && !k.truck_slug && norm(k.name) === norm(v.name));
  const used = new Set();
  const profileHref = (k) => (k && k.page_on && k.page_slug && !ctx.demo ? U.vendorUrl(k.page_slug) : null);
  const items = trucks.map((v) => {
    const k = kitOf(v); if (k) used.add(k.id);
    const href = hrefOf(v);
    // A vendor whose profile page is on opens it (their Order button is there); the tag still says they're serving.
    const page = profileHref(k);
    return { img: k && k.file ? small(k.file, 256) : v.logo || null, emoji: v.emoji, name: v.name, href: page || href || ig(k && k.instagram) || ig(v.instagram),
      tag: href ? (live && anyPreorder && takes(v) ? 'Order' : 'Menu') : null, can: !!(href && live && anyPreorder && takes(v)), open: !!(live && v.openNow), profile: !!page };
  });
  // A Food vendor the host sent a link to shows right away (their Order button comes once they've set up).
  for (const v of (ctx.trucks || []).filter((x) => x.status === 'invited' && x.slug)) {
    const k = all.find((x) => x.kind === 'vendor' && x.truck_slug === v.slug);
    if (!k || used.has(k.id)) continue;
    used.add(k.id);
    const page = profileHref(k);
    items.push({ img: k.file ? small(k.file, 256) : v.logo || null, emoji: v.emoji, name: k.name, href: page || ig(k.instagram), tag: null, external: !page && !!k.instagram, profile: !!page });
  }
  for (const k of picked) {
    if (used.has(k.id)) continue;
    const page = profileHref(k);
    items.push({ img: k.file ? small(k.file, 256) : null, name: k.name, href: page || ig(k.instagram), tag: null, external: !page && !!k.instagram, profile: !!page });
  }
  const clubs = (ctx.kitVendors || []).filter((k) => k.kind === 'group');
  const others = (ctx.kitVendors || []).filter((k) => k.kind === 'sponsor');
  if (!items.length) body += `<p class="dim">${over ? 'No food trucks were listed for this meet.' : 'Food trucks will show here once they’re confirmed.'}</p>`;
  else body += minis(items);
  body += `</section>`;
  // The car clubs coming out, the same little round logos; each opens the club's Instagram.
  if (clubs.length) body += `<section id="clubs"><h2>Clubs</h2>${minis(clubs.map((k) => ({ img: k.file ? small(k.file, 256) : null, emoji: '🚗', name: k.name, href: ig(k.instagram), external: !!k.instagram })))}</section>`;
  // Other vendors (shops, merch, sponsors): their own row, each opening its Instagram.
  if (others.length) body += `<section id="vendors"><h2>Vendors</h2>${minis(others.map((k) => ({ img: k.file ? small(k.file, 256) : null, emoji: '🛍', name: k.name, href: ig(k.instagram), external: !!k.instagram })))}</section>`;
  if (ctx.last && ctx.last.people) {
    body += `<section><p class="turnout">Last meet: about ${ctx.last.people} people${ctx.last.cars ? `, ${ctx.last.cars} cars` : ''}</p>
    <p class="small dim">${esc(U.dayShort(ctx.last.at, tz))}${ctx.last.place ? ` at ${esc(ctx.last.place)}` : ''}</p></section>`;
  }
  const rc = ctx.recap;
  if (rc && (rc.video_url || (rc.photos && rc.photos.length))) {
    body += `<section><h2>Recap</h2>
    ${rc.video_url ? `<a class="video" href="${esc(rc.video_url)}" rel="noopener"><b>Watch the recap</b><span class="dim small">${esc(rc.caption || 'Video from the last meet')}</span></a>` : (rc.caption ? `<p>${esc(rc.caption)}</p>` : '')}
    ${rc.photos && rc.photos.length ? `<div class="photos">${rc.photos.map((p) => `<img src="${esc(p)}" alt="" loading="lazy">`).join('')}</div>` : ''}</section>`;
  }
  // Email alerts only when the host has turned them on (Settings).
  if (host.alerts_on) body += `<section id="alerts"><h2>Get alerts</h2>
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

/**
 * A Food vendor's profile: their own clip behind everything, their logo, what they serve, the Order button (or "Not
 * serving tonight"), their story, food photos, the spots they park at, and their logos over the years.
 * ctx: { tz, vid, logos, photos, spots, meets, at: { m, label, href, go, text, note } | null, hostUrl, igUrl, preview, origin }
 */
function vendorPage(host, k, ctx) {
  const name = k.name;
  const logo = k.file ? small(k.file, 512) : null;
  const at = ctx.at;
  const ig = k.instagram ? `https://instagram.com/${encodeURIComponent(k.instagram)}` : null;
  const desc = [k.serves, k.about].filter(Boolean).join('. ').slice(0, 200) || `${name}, food at ${host.name}.`;
  let body = ctx.preview ? `<div class="demo-bar" role="note"><b>Preview</b> · this page is off, so only you see it. Turn it on in the portal. <a href="/host">Back to the portal</a></div>` : '';
  body += `<main class="wrap vendor">
<section class="hero${ctx.vid ? ' has-video' : ''}">
  ${heroBg(ctx.vid)}
  <div class="v-face">${logo ? `<img src="${esc(logo)}" alt="${esc(name)}">` : `<span aria-hidden="true">🍽</span>`}</div>
  <h1 class="v-name">${esc(name)}</h1>
  ${k.serves ? `<p class="v-serves">${esc(k.serves)}</p>` : ''}
  ${k.since ? `<p class="v-since">Serving since ${esc(k.since)}</p>` : ''}
  <div class="actions">
    ${at && at.href ? `<a class="btn${at.go ? ' go' : ''}" href="${esc(at.href)}">${esc(at.text)}</a>` : `<span class="btn" aria-disabled="true">${esc(at ? at.text : 'Not serving tonight')}</span>`}
    ${ig ? `<a class="btn" href="${esc(ig)}" rel="noopener" target="_blank">Instagram</a>` : ''}
  </div>
  ${at ? `<p class="v-at"><a href="${esc(ctx.hostUrl)}/${esc(at.m.day)}">${esc(at.label)}</a>${at.note ? `<br><span class="dim">${esc(at.note)}</span>` : ''}</p>` : ''}
</section>`;
  if (k.about || k.signature) {
    body += `<section class="v-about">${k.signature ? `<p class="v-known"><span>Known for</span> ${esc(k.signature)}</p>` : ''}
    ${k.about ? String(k.about).split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') : ''}</section>`;
  }
  if (ctx.photos && ctx.photos.length) {
    body += `<section><h2>The food</h2><div class="photos v-photos">${ctx.photos.map((p) => `<figure><img src="${esc(small(p.file, 480))}" alt="${esc(p.label || name)}" loading="lazy">${p.label ? `<figcaption>${esc(p.label)}</figcaption>` : ''}</figure>`).join('')}</div></section>`;
  }
  if (ctx.spots && ctx.spots.length) {
    body += `<section><h2>Find them</h2><div class="v-spots">${ctx.spots.map((s) => {
      const maps = s.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}` : null;
      return `<div class="truck"><div class="tinfo"><div class="name">${esc(s.name)}</div>${s.when_text ? `<div class="note">${esc(s.when_text)}</div>` : ''}${s.address ? `<div class="note">${esc(s.address)}</div>` : ''}</div>${maps ? `<a class="btn" href="${esc(maps)}" rel="noopener" target="_blank">Directions</a>` : ''}</div>`;
    }).join('')}</div></section>`;
  }
  const past = ctx.logos || [];
  if (past.length) {
    // The logo now, then the old ones, newest first: the truck's look over the years.
    const tiles = (logo ? [{ src: small(k.file, 256), label: 'Now' }] : []).concat(past.map((l) => ({ src: small(l.file, 256), label: l.label || '' })));
    body += `<section><h2>Through the years</h2><div class="v-logos">${tiles.map((t) => `<figure><div class="mini"><img src="${esc(t.src)}" alt="" loading="lazy"></div>${t.label ? `<figcaption>${esc(t.label)}</figcaption>` : ''}</figure>`).join('')}</div></section>`;
  }
  if (ctx.meets > 0) body += `<section><p class="turnout">At ${ctx.meets} ${esc(host.name)} meet${ctx.meets === 1 ? '' : 's'}</p></section>`;
  body += `</main><footer><div class="wrap"><p><a href="${esc(ctx.hostUrl)}">${esc(host.name)}</a></p></div></footer>`;
  const img = ctx.origin ? (ctx.vid ? `${ctx.origin}/uploads/${ctx.vid.video_poster}` : logo ? ctx.origin + logo : null) : null;
  return layout({ title: `${name} · ${host.name}`, description: desc, host, body, scripts: ['site.js'], noindex: !!ctx.preview, image: img });
}

/** A host with nothing scheduled yet. */
function hostEmpty(host, ctx) {
  const vid = host.video && host.video_status === 'ready' ? host : null;
  const body = (host.logo ? '' : top(host, ctx.base)) + `<main class="wrap"><section class="hero${vid ? ' has-video' : ''}${host.logo ? ' has-avatar' : ''}">
  ${heroBg(vid)}
  ${avatar(host)}
  <p class="soon-line">Next meet: soon.${host.alerts_on ? ' Get an alert when it’s posted.' : host.instagram ? ' Follow along for the date.' : ''}</p>
  <div class="actions">${alertsBtn(host, true)}</div>
  </section>
  ${host.alerts_on ? `<section id="alerts"><h2>Get alerts</h2><p class="dim">An email when the next meet is posted. Nothing else.</p>
  <form class="row" data-form="alerts" data-host="${esc(host.slug)}"><input type="email" name="email" required maxlength="120" placeholder="you@email.com" aria-label="Your email">
  <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="btn go" type="submit">Join</button></form><div class="msg" role="status"></div></section>` : ''}</main>` + footer(host, ctx.base, ctx);
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
  <div class="stall"><div class="dow">Car meets</div><div class="date word">${esc(SITE())}</div><div class="time">Where they are, when, and what’s to eat</div></div>
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

module.exports = { small, ver, layout, meetPage, vendorPage, hostEmpty, foodPage, orderPage, message, home, privacy };
