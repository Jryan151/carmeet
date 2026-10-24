'use strict';
/* Section 3 — the food side failing.
   node test/stress/run-kitchen.js
   For each failure (hang 30 s, 500, garbage JSON, wrong shape, a null truck, connection reset, connection refused):
   public meet pages (cold and warm truck cache), a vendor profile, the menu and order APIs, and the portal calls that
   reach the food side (trucks panel, dashboard, send-link, invite, meet create/edit, settings, logo reading, kit list,
   deleting a vendor, history). Each call is timed (client gives up at 200 s); the server's crash/error counters and
   the rows left behind are checked. Writes test/stress/out/kitchen.json. */
const path = require('path');
const fs = require('fs');
const S = require('./lib/site');
const { seed, db } = require('./lib/seed');

const OUT = path.join(__dirname, 'out');
const MODES = (process.argv[2] || 'hang,500,garbage,wrongshape,nullvendor,reset,refused').split(',');

(async () => {
  const ctx = await S.start({ cpus: '0,1' });
  const w = await seed(ctx, { members: 30, photosEach: 2, withoutCopies: 0 });
  const h = w.hosts[0];
  const D = db(ctx.dbFile);
  const myMeets = w.meets.filter((m) => m.hostIdx === 0);
  const vendorKits = w.kit.filter((k) => k.hostId === h.id && k.kind === 'vendor');
  // Three Food vendors tied to trucks on the food side with logos not sent yet (GET /kit sends them).
  for (const k of vendorKits.slice(0, 3)) await D.run('UPDATE kit_logos SET truck_slug = ?, logo_synced = NULL WHERE id = ?', ['t-' + k.id, k.id]);
  // An order to look up.
  const orderTok = 'a'.repeat(24);
  await D.run("INSERT INTO orders (token, meet_id, host_id, vendor_slug, vendor_name, status, payment, total, items_json, created_at, updated_at) VALUES (?, ?, ?, 'birria-bros', 'Birria Bros', 'Paid', 'paid', 14, '[]', ?, ?)", [orderTok, myMeets[0].id, h.id, Date.now(), Date.now() - 6 * 60000]);
  ctx.kitchen.state.orders[orderTok] = { token: orderTok, ticket: 101, status: 'Paid', payment: 'paid', total: 14 };

  const T = 200000;
  const time = async (label, fn) => { const t0 = Date.now(); let r; try { r = await fn(); } catch (e) { r = { status: 0, error: e.message }; } return { label, ms: Date.now() - t0, status: r.status, note: r.json ? JSON.stringify(r.json).slice(0, 160) : (r.text || r.error || '').replace(/\s+/g, ' ').slice(0, 120) }; };
  const page = (p) => S.req(ctx, 'GET', p, { timeout: T });
  const api = (m, p, body) => S.req(ctx, m, '/api/host' + p, { cookie: h.cookie, body, headers: { Origin: 'http://meets.test' }, timeout: T });
  const warmAll = async () => { for (const m of w.meets) await page(new URL(m.url).pathname); };
  const results = {};
  let meetIdx = 1;
  let kitIdx = 3;

  // Warm every truck list once, then let the copies age past a minute (the page refreshes them behind the scenes).
  await warmAll();
  console.log('warm: waiting 61 s for the kept truck lists to age');
  await S.sleep(61000);

  for (const mode of MODES) {
    console.log('\n== food side:', mode);
    const before = await ctx.probe('/');
    if (mode === 'refused') await ctx.fault.refuse(); else ctx.fault.mode = mode;
    const rows = [];
    // A meet whose truck list was kept a minute ago (warm), and one never shown since start (cold: a fresh week).
    const warm = myMeets[(meetIdx++) % myMeets.length];
    const Ut = require('../../util');
    const coldRes = await api('POST', '/meets', { day: Ut.addDays(Ut.dayKey(Date.now(), 'America/Phoenix'), 40 + meetIdx), start: '19:00', end: '22:00', place: 'Cold lot ' + mode, title: 'Cold ' + mode });
    rows.push({ label: 'portal: post a meet (sync)', ms: coldRes.ms, status: coldRes.status, note: coldRes.json ? JSON.stringify({ synced: coldRes.json.meet && coldRes.json.meet.synced, syncError: coldRes.json.meet && coldRes.json.meet.syncError }) : coldRes.text.slice(0, 80) });
    const cold = coldRes.json && coldRes.json.meet;
    rows.push(await time('page: meet, warm truck list', () => page(new URL(warm.url).pathname)));
    if (cold) rows.push(await time('page: meet, cold (never loaded)', () => page(new URL(cold.url).pathname)));
    rows.push(await time('page: host home', () => page('/' + h.slug)));
    rows.push(await time('page: meet name address', () => page('/fuel-friday')));
    rows.push(await time('page: vendor profile /v/', () => page('/v/' + w.kit.find((k) => k.hostId === h.id && k.pageSlug).pageSlug)));
    rows.push(await time('page: food page (menu)', () => page(new URL(warm.url).pathname + '/food/birria-bros')));
    rows.push(await time('api: menu /api/meets/:id/food/:truck', () => page(`/api/meets/${warm.id}/food/birria-bros`)));
    rows.push(await time('api: order status /api/orders/:t', () => page('/api/orders/' + orderTok)));
    rows.push(await time('portal: dashboard', () => api('GET', '/dashboard')));
    rows.push(await time('portal: trucks panel', () => api('GET', `/meets/${warm.id}/trucks`)));
    rows.push(await time('portal: vendors tab', () => api('GET', '/vendors')));
    rows.push(await time('portal: send-link (new vendor)', () => api('POST', `/meets/${warm.id}/send-link`, { kitId: vendorKits[(kitIdx++) % vendorKits.length].id })));
    rows.push(await time('portal: invite link', () => api('POST', `/meets/${warm.id}/invite`, {})));
    rows.push(await time('portal: edit a meet (sync)', () => api('PUT', `/meets/${warm.id}`, { day: warm.day, start: warm.start, end: warm.end, place: warm.place, address: warm.address, title: warm.title, notes: 'edit ' + mode })));
    rows.push(await time('portal: settings name change (re-syncs every upcoming meet)', () => api('PUT', '/settings', { name: 'Tasty Tuesday ' + mode })));
    rows.push(await time('portal: kit list (sends unsent logos)', () => api('GET', '/kit')));
    rows.push(await time('portal: read logos', () => api('POST', '/kit/read', { ids: vendorKits.slice(10, 12).map((k) => k.id) })));
    rows.push(await time('portal: history', () => api('GET', '/history')));
    // Deleting a Food vendor tied to a truck: it should leave every upcoming meet on the food side.
    const victim = vendorKits[kitIdx % vendorKits.length]; kitIdx++;
    await D.run('UPDATE kit_logos SET truck_slug = ? WHERE id = ?', ['victim-' + mode, victim.id]);
    for (const m of myMeets) { const km = ctx.kitchen.state.meets[m.ref]; if (km) km.vendors.push({ inviteId: ctx.kitchen.state.nextInvite++, status: 'invited', slug: 'victim-' + mode, name: 'Victim' }); }
    const del = await time('portal: delete a vendor (drops its invites)', () => api('DELETE', `/kit/${victim.id}`));
    rows.push(del);
    if (mode === 'refused') await ctx.fault.restore(); else ctx.fault.mode = 'ok';
    const stillInvited = myMeets.filter((m) => (ctx.kitchen.state.meets[m.ref] || { vendors: [] }).vendors.some((v) => v.slug === 'victim-' + mode && v.status === 'invited')).length;
    const gone = await D.get('SELECT COUNT(*) AS n FROM kit_gone WHERE truck_slug = ?', ['victim-' + mode]);
    del.note += ` | after: kit row gone, kit_gone=${gone.n}, still invited on the food side in ${stillInvited}/${myMeets.length} meets`;
    // After it comes back: do the pages heal?
    await S.sleep(1500);
    rows.push(await time('after recovery: meet page', () => page(new URL(warm.url).pathname)));
    if (cold) rows.push(await time('after recovery: cold meet page', () => page(new URL(cold.url).pathname)));
    const after = await ctx.probe('/');
    const alive = ctx.child.exitCode === null;
    results[mode] = { rows, alive, uncaught: after.uncaught - before.uncaught, unhandled: after.unhandled - before.unhandled, appErrors: after.errors - before.errors };
    for (const r of rows) console.log(`  ${String(r.ms).padStart(7)} ms  ${String(r.status).padStart(3)}  ${r.label}${r.note ? '  · ' + r.note.slice(0, 150) : ''}`);
    console.log(`  server alive: ${alive}, uncaught: ${results[mode].uncaught}, unhandled: ${results[mode].unhandled}, errors logged: ${results[mode].appErrors}`);
    if (!alive) break;
  }
  results.lastLog = (await ctx.probe('/lines').catch(() => [])).slice(-30);
  S.writeJson(path.join(OUT, 'kitchen.json'), results);
  await D.close();
  await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
