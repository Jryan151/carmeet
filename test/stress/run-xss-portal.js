'use strict';
/* Section 5 — XSS in what the browser draws: the portal's tabs, the member editor, the vendor requests list, an order
   page, a menu. Payloads go into every field a host, a member, a vendor (the request form) or the food side (truck
   names, counts, invite ids, menu items) can set. Any script that runs sets window.__xss or opens a dialog.
   node test/stress/run-xss-portal.js */
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const S = require('./lib/site');

const P = (tag) => `"'><img src=x onerror="window.__xss=(window.__xss||[]).concat('${tag}')"><svg onload="window.__xss=(window.__xss||[]).concat('${tag}-svg')">`;
(async () => {
  const ctx = await S.start({ env: { MEET_MODE: '0' } });
  const H = { Origin: 'http://meets.test' };
  const c = await S.signIn(ctx, { email: 'x@x.test', name: 'XSS Host', slug: 'xss-host' });
  const api = (m, p, body) => S.req(ctx, m, '/api/host' + p, { cookie: c, body, headers: H });
  await api('PUT', '/settings', { alertsOn: true, tagline: P('tagline'), city: P('city'), rules: P('rules'), name: 'XSS Host' });
  const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const m = (await api('POST', '/meets', { day, start: '19:00', end: '22:00', place: P('place'), address: P('address'), title: P('title'), notes: P('notes') })).json.meet;
  const k = (await api('POST', '/kit/entry', { kind: 'vendor', name: P('kitname'), instagram: 'x', note: P('kitnote') })).json.logo;
  await api('POST', '/kit/entry', { kind: 'group', name: P('club') });
  await api('PUT', `/kit/${k.id}/profile`, { about: P('about'), serves: P('serves'), signature: P('signature'), since: P('since') });
  await api('POST', `/kit/${k.id}/spots`, { name: P('spot'), address: P('spotaddr'), when: P('spotwhen') });
  const mem = (await api('POST', '/members', { name: P('member'), car: P('car'), mods: P('mods'), about: P('memabout') })).json.member;
  await api('POST', '/recaps', { caption: P('recap') });
  await S.req(ctx, 'POST', '/api/vendor-request', { body: { host: 'xss-host', name: P('vrname'), contact: P('vrcontact'), food: P('vrfood'), note: P('vrnote'), instagram: 'abc' } });
  await api('POST', '/updates', { message: P('update'), subject: P('subject'), toAlerts: true });
  // The food side's own data: truck names, emoji, counts, invite ids, menu items.
  const ks = ctx.kitchen.state;
  ks.meets[m.ref].vendors = [{ inviteId: P('inviteId'), status: 'in', slug: 'evil', name: P('truckname'), emoji: P('emoji'), cardReady: true, preorders: P('preorders'), plates: P('plates') }];
  ks.menu = [{ id: 1, name: P('menuname'), description: P('menudesc'), price: 5, groups: [{ name: P('group'), options: [{ name: P('option'), price: 1 }] }], category: P('category') }];
  const browser = await chromium.launch();
  const ctxB = await browser.newContext();
  await ctxB.addCookies([{ name: 'mh_session', value: c.split('=')[1], domain: '127.0.0.1', path: '/' }]);
  const page = await ctxB.newPage();
  const fired = new Set();
  page.on('dialog', (d) => { fired.add('dialog:' + d.message()); d.dismiss().catch(() => {}); });
  const look = async (where) => { const x = await page.evaluate(() => window.__xss || []).catch(() => []); for (const t of x) fired.add(`${t} @ ${where}`); };
  await page.goto(ctx.base + '/host', { waitUntil: 'load' });
  await page.waitForSelector('#portal:not([hidden])', { timeout: 30000 });
  for (const tab of ['next', 'meets', 'kit', 'updates', 'vendors', 'members', 'history', 'settings']) {
    await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(1500); await look('portal:' + tab);
    if (tab === 'meets') { await page.click('[data-open-meet], .rowx button, [data-meet]').catch(() => {}); await page.waitForTimeout(1500); await look('portal:meet-detail'); }
  }
  for (const p of [`/@${mem.handle}/edit`, new URL(m.url).pathname, new URL(m.url).pathname + '/food/evil', `/v/${(await api('GET', `/kit/${k.id}/profile`)).json.profile.suggestSlug}`, '/xss-host']) {
    await page.goto(ctx.base + p, { waitUntil: 'load' }).catch(() => {}); await page.waitForTimeout(2000); await look(p);
  }
  const out = [...fired];
  console.log(out.length ? 'FAIL  scripts ran:\n  ' + out.join('\n  ') : 'PASS  no script ran');
  S.writeJson(path.join(__dirname, 'out', 'xss-portal.json'), { fired: out });
  await browser.close(); await ctx.stop();
})().catch((e) => { console.error(e); process.exit(1); });
