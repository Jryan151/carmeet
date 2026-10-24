'use strict';
/* Section 8 — branding. Crawls every public page (front, meets, members, vendors and the vendor sign-up, hosts,
   meet names and weeks, vendor profiles, member pages, food and order pages, privacy, messages) and every script and
   style they load, following links on the site. Fails on "Online Kitchen", "onlinekitchen" or a link to the food
   side's address. Also checks what a vendor is sent (the invite text a host copies from the portal).
   node test/stress/run-branding.js */
const path = require('path');
const S = require('./lib/site');
const { seed } = require('./lib/seed');

const BAD = /online ?kitchen|onlinekitchen/i;
(async () => {
  const ctx = await S.start({ env: { MEET_MODE: '0' } });
  const w = await seed(ctx, { members: 40, photosEach: 2, withoutCopies: 0 });
  const kitchenHost = new URL(ctx.kitchenBase).host;
  const seen = new Map();
  const queue = ['/', '/meets', '/members', '/vendors', '/vendors?host=tasty-tuesday', '/privacy', '/nothing-here', '/o/' + 'a'.repeat(24),
    ...w.hosts.map((h) => '/' + h.slug), ...w.meetNames.map((n) => '/' + n), ...w.vendorSlugs.map((s) => '/v/' + s), ...w.members.slice(0, 40).map((m) => '/@' + m.handle),
    ...w.meets.map((m) => new URL(m.url).pathname), ...w.meets.slice(0, 5).map((m) => new URL(m.url).pathname + '/food/birria-bros'), '/@' + w.members[0].handle + '/edit', '/host'];
  const hits = [];
  while (queue.length && seen.size < 600) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    const r = await S.req(ctx, 'GET', p, { headers: { 'Accept-Encoding': 'identity' } });
    seen.set(p, r.status);
    const body = r.buf ? r.buf.toString('utf8') : '';
    const type = String(r.headers && r.headers['content-type'] || '');
    if (!/text\/html|javascript|css|json|svg/.test(type)) continue;
    const m = BAD.exec(body);
    if (m) hits.push({ page: p, found: m[0], context: body.slice(Math.max(0, m.index - 90), m.index + 60).replace(/\s+/g, ' ') });
    if (body.includes(kitchenHost)) hits.push({ page: p, found: 'link to the food side (' + kitchenHost + ')', context: body.slice(Math.max(0, body.indexOf(kitchenHost) - 80), body.indexOf(kitchenHost) + 40) });
    for (const mm of body.matchAll(/(?:href|src|data-src)="([^"#]+)"/g)) {
      let u; try { u = new URL(mm[1].replace(/&amp;/g, '&'), 'http://meets.test' + p); } catch (e) { continue; }
      if (u.hostname !== 'meets.test') continue;
      const next = u.pathname + u.search;
      if (/\.(webp|jpe?g|png|mp4|woff2?|gif)$/.test(u.pathname)) continue;
      if (!seen.has(next)) queue.push(next);
    }
  }
  // What a vendor is sent: the invite text the host copies (it carries the food side's own link).
  const h = w.hosts[0];
  const meet = w.meets.find((m) => m.hostIdx === 0);
  const kit = w.kit.find((k) => k.hostId === h.id && k.kind === 'vendor');
  const inv = await S.req(ctx, 'POST', `/api/host/meets/${meet.id}/send-link`, { cookie: h.cookie, body: { kitId: kit.id }, headers: { Origin: 'http://meets.test' } });
  const inv2 = await S.req(ctx, 'POST', `/api/host/meets/${meet.id}/invite`, { cookie: h.cookie, body: {}, headers: { Origin: 'http://meets.test' } });
  const sent = [inv.json && inv.json.text, inv2.json && inv2.json.text].filter(Boolean);
  for (const t of sent) { const host = (/https?:\/\/([^/\s]+)/.exec(t) || [])[1]; if (host && !/meets\.test$/.test(host)) hits.push({ page: '(text the host sends a vendor)', found: 'link to the food side: ' + host, context: t.slice(0, 200) }); }
  console.log(`crawled ${seen.size} addresses (${[...seen.values()].filter((s) => s === 200).length} answered 200)`);
  for (const x of hits) console.log(`FAIL  ${x.page}: ${x.found} · …${x.context}…`);
  if (!hits.length) console.log('PASS  nothing names or links the ordering system');
  S.writeJson(path.join(__dirname, 'out', 'branding.json'), { crawled: [...seen.entries()], hits, vendorTexts: sent });
  await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
