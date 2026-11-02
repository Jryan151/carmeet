'use strict';
/* prospects.js — club prospects, the footage library, and a club's own editor. Mounted on the portal's API (/api/host).

   A prospect is a club's page built before asking them: their logo and colors, a clip from the site owner's footage,
   two or three members' pages. It lives at /c/<name>, unlisted (not on /members, never indexed) and is deleted with
   its member pages 30 days after it was made unless the club claims it. Claiming: someone from the club types an email,
   gets a 6-digit code, and the page is theirs: listed, kept, and an editor link (no account) to change it and send each
   member the link to finish their own page.

   Admin (the site owner only, signed in): /prospects*, /footage*, /members/:id/footage.
   Public: /club/:slug/code and /club/:slug/verify (claim, or a new editor link to the email that claimed it).
   The club's editor (its key, or the owner signed in): /club-edit/:id*. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const D = require('./db');
const U = require('./util');
const V = require('./video');
const Vw = require('./views');
const mail = require('./mail');
const { run, get, all } = D;

const DAYS = 30;
const DAY_MS = 864e5;
const CODE_MS = 15 * 60 * 1000;
const SCHEME = () => process.env.PUBLIC_SCHEME || 'https';
const SITE_DOMAIN = () => String(process.env.SITE_DOMAIN || 'localhost').toLowerCase();
const SITE = () => process.env.SITE_NAME || 'Meet Night';
const HEX = /^#[0-9a-f]{6}$/i;
const clubUrl = (k) => `${SCHEME()}://${SITE_DOMAIN()}/c/${k.page_slug}`;

/** What a prospect's DM says by default; the owner can change it before copying. */
function dmText(k) {
  return `Hey! I've filmed you guys at a few meets, so I put together a page for ${k.name} with that footage: ${clubUrl(k)}\n\n` +
    `A couple of your members are on it already. If you like it, tap "Make it ours" to keep it (free). If not, no worries, it comes down on its own in ${DAYS} days.`;
}

/* ---------- reading screenshots of a club's Instagram (AI) ----------
   ANTHROPIC_API_KEY in .env (the same key Online Kitchen uses works). ANTHROPIC_MODEL picks the model. */
const READ_PROMPT = `These are screenshots of a car club's Instagram: their profile and some posts.
Reply with JSON only, no other text:
{"name": "the club's name", "instagram": "the club's handle, no @", "tagline": "a short line from their bio, under 80 characters, no emoji or hashtags",
 "members": [{"instagram": "a member's handle, no @", "name": "their first name if shown", "car": "year make model"}]}
Members: people tagged in or posting the club's photos, at most 12, each once. For "car", use what a caption or tag says;
if nothing says it, give your best reading of the car in the photo and end it with "?". Leave a field "" when you can't tell.
Never make up handles.`;
async function readScreens(files) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { status: 503, error: 'Reading screenshots needs ANTHROPIC_API_KEY in the server’s .env. Type the details for now.' };
  const content = files.map((f) => ({ type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } }));
  content.push({ type: 'text', text: READ_PROMPT });
  let txt = '';
  try {
    const r = await fetch(String(process.env.ANTHROPIC_BASE || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content }] }),
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) { console.error('screenshot read:', r.status, d && d.error && d.error.message); return { status: 502, error: 'Reading the screenshots didn’t work. Try again, or type the details.' }; }
    txt = (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  } catch (e) { return { status: 502, error: 'Reading the screenshots took too long. Try fewer at once.' }; }
  let j = null;
  try { j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch (e) { j = null; }
  if (!j || typeof j !== 'object') return { status: 502, error: 'Couldn’t make sense of those screenshots. Try clearer ones.' };
  const seen = new Set();
  const members = (Array.isArray(j.members) ? j.members : []).map((m) => ({
    instagram: U.handle(m && m.instagram) || '', name: U.clean(m && m.name, 60), car: U.clean(m && m.car, 80) }))
    .filter((m) => (m.instagram || m.name || m.car) && !(m.instagram && seen.has(m.instagram.toLowerCase())) && (m.instagram ? seen.add(m.instagram.toLowerCase()) : true))
    .slice(0, 12);
  return { read: { name: U.clean(j.name, 60), instagram: U.handle(j.instagram) || '', tagline: U.clean(j.tagline, 80), members } };
}

module.exports = function prospects(r, H) {
  const { signedIn, session, limited, rawImage, saveImage, unlinkUpload, takeVideo, dropVideo, videoShape, memberShape, freeSlug, freeHandle, isOwner, UPLOAD_DIR } = H;

  /* ---------- shapes ---------- */
  const daysLeft = (k) => (k.prospect && k.expires_at ? Math.max(0, Math.ceil((k.expires_at - Date.now()) / DAY_MS)) : null);
  async function clubShape(k, { owner } = {}) {
    const rows = await all(`SELECT * FROM members WHERE club_id = ? ORDER BY created_at`, [k.id]);
    const members = await Promise.all(rows.map(memberShape));
    return { id: k.id, name: k.name, instagram: k.instagram || '', tagline: k.note || '', accent: HEX.test(k.accent || '') ? k.accent : '',
      logo: k.file ? '/uploads/' + k.file : '', thumb: k.file ? Vw.small(k.file, 256) : '', slug: k.page_slug, url: clubUrl(k),
      prospect: !!k.prospect, daysLeft: daysLeft(k), claimed: !!k.claimed_at, claimEmail: owner ? k.claim_email || '' : undefined,
      nextMeetId: k.next_meet_id || null, footageId: k.footage_id || null, video: videoShape(k), videoReady: V.ffmpegOk(),
      dm: owner && k.prospect ? dmText(k) : undefined,
      members: members.map((m) => Object.assign(m, { footageId: (rows.find((x) => x.id === m.id) || {}).footage_id || null })) };
  }
  const footageShape = (f) => ({ id: f.id, title: f.title || '', tags: f.tags || '', video: videoShape(f), created: f.created_at });

  /* ---------- removing a club page and everything on it ---------- */
  async function removeMember(m) {
    for (const x of await all('SELECT file, poster, hevc FROM member_photos WHERE member_id = ?', [m.id])) { unlinkUpload(x.file); unlinkUpload(x.poster); unlinkUpload(x.hevc); }
    if (!m.footage_id) { unlinkUpload(m.video); unlinkUpload(m.video_poster); unlinkUpload(m.video_hevc); }
    unlinkUpload(m.header_file);
    await run('DELETE FROM member_photos WHERE member_id = ?', [m.id]);
    await run('DELETE FROM members WHERE id = ?', [m.id]);
  }
  async function removeClub(k) {
    for (const m of await all('SELECT * FROM members WHERE club_id = ?', [k.id])) await removeMember(m);
    if (k.file) unlinkUpload(k.file);
    if (!k.footage_id) { unlinkUpload(k.video); unlinkUpload(k.video_poster); unlinkUpload(k.video_hevc); }
    await run('DELETE FROM club_codes WHERE kit_id = ?', [k.id]);
    await run('DELETE FROM meet_kit_vendors WHERE kit_id = ?', [k.id]);
    await run('DELETE FROM kit_logos WHERE id = ?', [k.id]);
  }
  /* Unclaimed prospects past their 30 days go, with their members' pages. Footage uploads that never became a clip
     (the upload stopped) go after a day. Every hour, and once a minute after starting. */
  async function sweep() {
    for (const k of await all("SELECT * FROM kit_logos WHERE kind = 'group' AND prospect = 1 AND expires_at IS NOT NULL AND expires_at < ?", [Date.now()])) {
      await removeClub(k).catch((e) => console.error('prospect sweep:', e.message));
    }
    for (const f of await all("SELECT * FROM footage WHERE (video IS NULL OR video_status = 'failed') AND COALESCE(video_status, '') != 'processing' AND created_at < ?", [Date.now() - DAY_MS])) {
      unlinkUpload(f.video_poster); await run('DELETE FROM footage WHERE id = ?', [f.id]);
    }
  }
  if (process.env.NODE_ENV !== 'test' || process.env.SWEEP_NOW) setTimeout(() => sweep().catch(() => {}), process.env.SWEEP_NOW ? 500 : 60000).unref();
  setInterval(() => sweep().catch(() => {}), 60 * 60 * 1000).unref();

  /* ---------- the owner's screen: Admin › Prospects ---------- */
  const owner = async (req, res, next) => { req.me = await session(req); if (!req.me) return res.status(401).json({ error: 'Sign in again.' }); if (!isOwner(req.me)) return res.status(404).json({ error: 'Not found.' }); next(); };
  const prospectOf = (req) => get("SELECT * FROM kit_logos WHERE id = ? AND host_id = ? AND kind = 'group' AND page_slug IS NOT NULL", [parseInt(req.params.id, 10) || 0, req.me.id]);
  const one = async (req, res, k) => res.set('Cache-Control', 'no-store').json({ club: await clubShape(await get('SELECT * FROM kit_logos WHERE id = ?', [k.id]), { owner: true }) });

  r.get('/prospects', owner, async (req, res) => {
    await sweep().catch((e) => console.error('prospect sweep:', e.message)); // the list never shows one that's past its days
    const rows = await all("SELECT * FROM kit_logos WHERE host_id = ? AND kind = 'group' AND page_slug IS NOT NULL AND (prospect = 1 OR claimed_at IS NOT NULL) ORDER BY prospect DESC, created_at DESC", [req.me.id]);
    const counts = await all('SELECT club_id, COUNT(*) AS n FROM members WHERE club_id IN (' + (rows.map((x) => x.id).join(',') || '0') + ') GROUP BY club_id');
    const meets = await all("SELECT id, title, day, place FROM meets WHERE host_id = ? AND status = 'on' AND day >= ? ORDER BY day LIMIT 30", [req.me.id, U.addDays(U.dayKey(Date.now(), process.env.TIMEZONE || 'America/Phoenix'), -1)]);
    res.set('Cache-Control', 'no-store').json({
      clubs: rows.map((k) => ({ id: k.id, name: k.name, thumb: k.file ? Vw.small(k.file, 256) : '', url: clubUrl(k), prospect: !!k.prospect, daysLeft: daysLeft(k),
        claimed: !!k.claimed_at, members: (counts.find((c) => c.club_id === k.id) || { n: 0 }).n })),
      meets: meets.map((m) => ({ id: m.id, label: `${m.title || req.me.name} · ${m.day} · ${m.place}` })),
      aiReady: !!process.env.ANTHROPIC_API_KEY,
    });
  });
  // A new prospect from a name (and Instagram). An existing club in the lists with that name becomes the prospect.
  r.post('/prospects', owner, async (req, res) => {
    const b = req.body || {};
    const name = U.clean(b.name, 60);
    if (!name) return res.status(400).json({ error: 'Name the club.' });
    const n = await get('SELECT COUNT(*) AS n FROM kit_logos WHERE host_id = ?', [req.me.id]);
    if (n.n >= 200) return res.status(400).json({ error: 'Your lists have 200 entries. Delete a few first.' });
    let k = await get("SELECT * FROM kit_logos WHERE host_id = ? AND kind = 'group' AND lower(name) = lower(?)", [req.me.id, name]);
    if (k && k.page_slug) return res.status(409).json({ error: `${k.name} already has a page.`, id: k.id });
    const slug = await freeSlug(U.pageSlugFrom(name).replace(/-food$/, '-club'), k ? k.id : 0);
    if (!slug) return res.status(400).json({ error: 'Pick another name.' });
    const ig = U.handle(b.instagram) || (k && k.instagram) || null;
    if (k) await run('UPDATE kit_logos SET page_slug = ?, instagram = ?, prospect = 1, expires_at = ? WHERE id = ?', [slug, ig, Date.now() + DAYS * DAY_MS, k.id]);
    else {
      const ins = await run("INSERT INTO kit_logos (host_id, kind, name, file, instagram, page_slug, prospect, expires_at, created_at) VALUES (?, 'group', ?, '', ?, ?, 1, ?, ?)",
        [req.me.id, name, ig, slug, Date.now() + DAYS * DAY_MS, Date.now()]);
      k = { id: ins.lastID };
    }
    res.status(201);
    return one(req, res, k);
  });
  r.get('/prospects/:id', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    return one(req, res, k);
  });
  async function saveDetails(k, b, res) {
    const f = {};
    if (b.name !== undefined) { f.name = U.clean(b.name, 60); if (!f.name) { res.status(400).json({ error: 'Name the club.' }); return false; } }
    if (b.instagram !== undefined) f.instagram = U.handle(b.instagram) || null;
    if (b.tagline !== undefined) f.note = U.clean(b.tagline, 80) || null;
    if (b.accent !== undefined) f.accent = HEX.test(String(b.accent || '')) ? String(b.accent).toLowerCase() : null;
    if (b.nextMeetId !== undefined) {
      const m = b.nextMeetId ? await get("SELECT id FROM meets WHERE id = ? AND host_id = ? AND status = 'on'", [parseInt(b.nextMeetId, 10) || 0, k.host_id]) : null;
      f.next_meet_id = m ? m.id : null;
    }
    if (b.slug !== undefined && String(b.slug).toLowerCase() !== k.page_slug) {
      const s = String(b.slug).toLowerCase().trim();
      if (!U.pageSlugOk(s)) { res.status(400).json({ error: 'Page address: 3 to 40 letters, numbers or dashes.' }); return false; }
      if ((await freeSlug(s, k.id)) !== s) { res.status(409).json({ error: 'That address is taken. Try another.' }); return false; }
      f.page_slug = s;
    }
    const keys = Object.keys(f);
    if (keys.length) await run(`UPDATE kit_logos SET ${keys.map((x) => x + ' = ?').join(', ')} WHERE id = ?`, keys.map((x) => f[x]).concat([k.id]));
    return true;
  }
  r.put('/prospects/:id', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    if (!(await saveDetails(k, req.body || {}, res))) return;
    return one(req, res, k);
  });
  // The logo: trimmed (a black background made see-through), and the colors it's made of to pick the page's color from.
  async function takeLogo(k, req, res) {
    let name = Buffer.isBuffer(req.body) ? await saveImage(req.body) : null;
    if (!name) { res.status(400).json({ error: 'Use a JPEG or PNG logo (a screenshot works).' }); return null; }
    const trimmed = await V.trimLogo(path.join(UPLOAD_DIR, name), UPLOAD_DIR);
    if (trimmed) { unlinkUpload(name); name = trimmed; }
    const colors = await V.colors(path.join(UPLOAD_DIR, name)).catch(() => []);
    if (k.file) unlinkUpload(k.file);
    await run('UPDATE kit_logos SET file = ?, accent = COALESCE(accent, ?) WHERE id = ?', [name, colors[0] || null, k.id]);
    return colors;
  }
  r.post('/prospects/:id/logo', owner, rawImage, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    const colors = await takeLogo(k, req, res);
    if (!colors) return;
    res.json({ colors, club: await clubShape(await get('SELECT * FROM kit_logos WHERE id = ?', [k.id]), { owner: true }) });
  });
  // Screenshots of their Instagram → name, handle, a line, members and their cars. Nothing is saved: the owner checks it first.
  r.post('/prospects/:id/read', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    if (limited('read:' + req.me.id, 30, 60 * 60000)) return res.status(429).json({ error: 'That’s a lot of reads this hour. Wait a bit.' });
    const files = (Array.isArray((req.body || {}).files) ? req.body.files : []).slice(0, 8)
      .map((f) => ({ type: String(f && f.type || ''), data: String(f && f.data || '') }))
      .filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type) && /^[A-Za-z0-9+/=]+$/.test(f.data.slice(0, 200)) && f.data.length < 6.5e6);
    if (!files.length) return res.status(400).json({ error: 'Add a screenshot or two (JPEG or PNG).' });
    const out = await readScreens(files);
    if (out.error) return res.status(out.status).json({ error: out.error });
    const have = new Set((await all('SELECT instagram FROM members WHERE club_id = ? AND instagram IS NOT NULL', [k.id])).map((x) => String(x.instagram).toLowerCase()));
    out.read.members.forEach((m) => { m.have = !!(m.instagram && have.has(m.instagram.toLowerCase())); });
    res.json(out);
  });
  // Members from the read (or typed): each one's page started under this club. One already there (same Instagram) is skipped.
  r.post('/prospects/:id/members', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    const list = (Array.isArray((req.body || {}).members) ? req.body.members : []).slice(0, 20);
    let added = 0;
    for (const x of list) {
      const out = await addMember(k, x);
      if (out.member) added++;
      else if (out.error && list.length === 1) return res.status(out.status || 400).json({ error: out.error });
    }
    res.status(201).json({ added, club: await clubShape(await get('SELECT * FROM kit_logos WHERE id = ?', [k.id]), { owner: true }) });
  });
  async function addMember(k, x) {
    const name = U.clean(x && x.name, 60), car = U.clean(x && x.car, 80), ig = U.handle(x && x.instagram) || null;
    if (!name && !car && !ig) return { error: 'Give them a name, a car or an Instagram.' };
    if (ig && (await get('SELECT 1 AS x FROM members WHERE club_id = ? AND lower(instagram) = lower(?)', [k.id, ig]))) return { error: `@${ig} is on the page already.`, status: 409 };
    const n = await get('SELECT COUNT(*) AS n FROM members WHERE host_id = ?', [k.host_id]);
    if (n.n >= 500) return { error: '500 member pages at most for now.' };
    const raw = U.pageSlugFrom(ig || name || car || '').replace(/-food$/, '');
    const handle = await freeHandle(raw.length >= 3 ? raw : (raw || 'member') + '-car', 0);
    if (!handle) return { error: 'Couldn’t make a page name. Add an Instagram.' };
    const now = Date.now();
    const ins = await run('INSERT INTO members (host_id, club_id, handle, name, car, instagram, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [k.host_id, k.id, handle, name, car || null, ig, now, now]);
    return { member: { id: ins.lastID, handle } };
  }
  r.delete('/prospects/:id/members/:mid', owner, async (req, res) => {
    const k = await prospectOf(req);
    const m = k && await get('SELECT * FROM members WHERE id = ? AND club_id = ?', [parseInt(req.params.mid, 10) || 0, k.id]);
    if (!m) return res.status(404).json({ error: 'That page is gone.' });
    await removeMember(m);
    return one(req, res, k);
  });
  // A clip from the library behind the club's page (footageId: null takes it off).
  r.put('/prospects/:id/footage', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    const err = await useFootage('kit_logos', k, (req.body || {}).footageId, req.me.id);
    if (err) return res.status(err.status).json({ error: err.error });
    return one(req, res, k);
  });
  r.post('/prospects/:id/video', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    return takeVideo(req, res, 'kit_logos', k.id);
  });
  // A member's page gets a library clip too.
  r.put('/members/:id/footage', owner, async (req, res) => {
    const m = await get('SELECT * FROM members WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!m) return res.status(404).json({ error: 'That page is gone.' });
    const err = await useFootage('members', m, (req.body || {}).footageId, req.me.id);
    if (err) return res.status(err.status).json({ error: err.error });
    res.json({ member: await memberShape(await get('SELECT * FROM members WHERE id = ?', [m.id])) });
  });
  /** Points a page's background at a library clip (the same files: nothing copied, nothing deleted later), or takes it off. */
  async function useFootage(table, row, footageId, hostId) {
    if (row.video_status === 'processing') return { status: 409, error: 'A clip is still processing for this page. Give it a minute.' };
    if (!footageId) {
      if (row.footage_id) await dropVideo(table, row.id);
      return null;
    }
    const f = await get("SELECT * FROM footage WHERE id = ? AND host_id = ? AND video_status = 'ready'", [parseInt(footageId, 10) || 0, hostId]);
    if (!f) return { status: 404, error: 'That clip is gone or still processing.' };
    await dropVideo(table, row.id); // its own upload goes; a library clip it had stays in the library
    await run(`UPDATE ${table} SET video = ?, video_poster = ?, video_hevc = ?, video_status = 'ready', video_error = NULL, footage_id = ? WHERE id = ?`,
      [f.video, f.video_poster, f.video_hevc, f.id, row.id]);
    return null;
  }
  r.post('/prospects/:id/extend', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    if (k.prospect) await run('UPDATE kit_logos SET expires_at = ? WHERE id = ?', [Date.now() + DAYS * DAY_MS, k.id]);
    return one(req, res, k);
  });
  // Taken down: the page, its member pages and their photos. A library clip it used stays in the library.
  r.delete('/prospects/:id', owner, async (req, res) => {
    const k = await prospectOf(req);
    if (!k) return res.status(404).json({ error: 'That club is gone.' });
    await removeClub(k);
    res.json({ ok: true });
  });

  /* ---------- the footage library ---------- */
  r.get('/footage', owner, async (req, res) => {
    const words = U.clean(req.query.q, 80).toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 6);
    const where = words.map(() => "(lower(COALESCE(title, '')) LIKE ? OR lower(COALESCE(tags, '')) LIKE ?)").join(' AND ');
    const rows = await all(`SELECT * FROM footage WHERE host_id = ?${where ? ' AND ' + where : ''} ORDER BY created_at DESC LIMIT 120`,
      [req.me.id].concat(...words.map((w) => ['%' + w + '%', '%' + w + '%'])));
    const used = await all('SELECT footage_id, COUNT(*) AS n FROM (SELECT footage_id FROM kit_logos WHERE footage_id IS NOT NULL UNION ALL SELECT footage_id FROM members WHERE footage_id IS NOT NULL) GROUP BY footage_id');
    res.set('Cache-Control', 'no-store').json({ footage: rows.map((f) => Object.assign(footageShape(f), { used: (used.find((u) => u.footage_id === f.id) || { n: 0 }).n })) });
  });
  // A new clip: tags and a title in the address, the video as the body (it becomes a 15-second 1080p loop).
  r.post('/footage', owner, async (req, res) => {
    const n = await get('SELECT COUNT(*) AS n FROM footage WHERE host_id = ?', [req.me.id]);
    if (n.n >= 400) return res.status(400).json({ error: '400 clips at most. Delete a few first.' });
    const ins = await run('INSERT INTO footage (host_id, title, tags, created_at) VALUES (?, ?, ?, ?)', [req.me.id, U.clean(req.query.title, 80) || null, tagsOf(req.query.tags), Date.now()]);
    return takeVideo(req, res, 'footage', ins.lastID);
  });
  const tagsOf = (s) => U.clean(s, 300).toLowerCase().split(/\s*,\s*/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean).slice(0, 20).join(', ') || null;
  r.put('/footage/:id', owner, async (req, res) => {
    const f = await get('SELECT * FROM footage WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!f) return res.status(404).json({ error: 'That clip is gone.' });
    const b = req.body || {};
    await run('UPDATE footage SET title = ?, tags = ? WHERE id = ?', [b.title === undefined ? f.title : U.clean(b.title, 80) || null, b.tags === undefined ? f.tags : tagsOf(b.tags), f.id]);
    res.json({ footage: footageShape(await get('SELECT * FROM footage WHERE id = ?', [f.id])) });
  });
  r.delete('/footage/:id', owner, async (req, res) => {
    const f = await get('SELECT * FROM footage WHERE id = ? AND host_id = ?', [parseInt(req.params.id, 10) || 0, req.me.id]);
    if (!f) return res.status(404).json({ error: 'That clip is gone.' });
    const used = await get('SELECT (SELECT COUNT(*) FROM kit_logos WHERE footage_id = ?) + (SELECT COUNT(*) FROM members WHERE footage_id = ?) AS n', [f.id, f.id]);
    if (used.n) return res.status(409).json({ error: `It’s behind ${used.n} page${used.n === 1 ? '' : 's'}. Pick another clip on ${used.n === 1 ? 'it' : 'those'} first.` });
    unlinkUpload(f.video); unlinkUpload(f.video_poster); unlinkUpload(f.video_hevc);
    await run('DELETE FROM footage WHERE id = ?', [f.id]);
    res.json({ ok: true });
  });

  /* ---------- claiming: an emailed code, then the page is theirs ---------- */
  const clubBySlug = (slug) => (U.SLUG_RE.test(String(slug || '')) ? get("SELECT * FROM kit_logos WHERE page_slug = ? AND kind = 'group'", [String(slug).toLowerCase()]) : Promise.resolve(null));
  r.post('/club/:slug/code', async (req, res) => {
    const k = await clubBySlug(req.params.slug);
    if (!k || (!k.prospect && !k.claimed_at)) return res.status(404).json({ error: 'That page is gone.' });
    const email = U.clean((req.body || {}).email, 120).toLowerCase();
    if (!U.EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email doesn’t look right.' });
    if (limited('ccode:' + (req.ip || ''), 8, 15 * 60000) || limited('ccode:' + k.id, 6, 15 * 60000)) return res.status(429).json({ error: 'Too many codes. Wait a few minutes.' });
    // Already claimed: a new editor link goes only to the email that claimed it (and says nothing either way).
    const ok = k.prospect || email === String(k.claim_email || '').toLowerCase();
    const code = String(crypto.randomInt(100000, 1000000));
    if (ok) {
      await run('INSERT INTO club_codes (kit_id, email, code_hash, expires_at, tries, sent_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (kit_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0, sent_at = excluded.sent_at',
        [k.id, email, D.sha(k.id + ':' + email + ':' + code), Date.now() + CODE_MS, Date.now()]);
      await mail.send({ key: 'club-code-' + D.sha(email + code + Date.now()).slice(0, 24), to: email, subject: `${code} is your code for ${k.name}’s page`,
        text: `Your code is ${code}. It works for 15 minutes.\n\nDidn't ask for it? Ignore this email.`,
        html: mail.shell({ from: SITE(), title: `Your code: ${code}`, html: `<p>Type it on ${mail.esc(k.name)}’s page. It works for 15 minutes.</p>`, footer: 'Didn’t ask for it? Ignore this email.' }) }).catch(() => {});
    }
    const dev = ok && process.env.DEV_CODES === 'true' && process.env.NODE_ENV !== 'production' ? { devCode: code } : {};
    res.json(Object.assign({ ok: true }, dev));
  });
  r.post('/club/:slug/verify', async (req, res) => {
    const k = await clubBySlug(req.params.slug);
    if (!k || (!k.prospect && !k.claimed_at)) return res.status(404).json({ error: 'That page is gone.' });
    if (limited('cverify:' + (req.ip || ''), 20, 15 * 60000)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const b = req.body || {};
    const email = U.clean(b.email, 120).toLowerCase();
    const code = String(b.code || '').replace(/\D/g, '');
    const row = await get('SELECT * FROM club_codes WHERE kit_id = ?', [k.id]);
    if (!row || row.email !== email || row.expires_at < Date.now() || row.tries >= 5) return res.status(400).json({ error: 'That code expired. Get a new one.' });
    if (D.sha(k.id + ':' + email + ':' + code) !== row.code_hash) { await run('UPDATE club_codes SET tries = tries + 1 WHERE kit_id = ?', [k.id]); return res.status(400).json({ error: 'That code isn’t right.' }); }
    await run('DELETE FROM club_codes WHERE kit_id = ?', [k.id]);
    const claiming = !!k.prospect;
    const key = crypto.randomBytes(20).toString('hex');
    if (claiming) await run('UPDATE kit_logos SET prospect = 0, expires_at = NULL, claimed_at = ?, claim_email = ?, edit_hash = ? WHERE id = ? AND prospect = 1', [Date.now(), email, D.sha('club:' + key), k.id]);
    else await run('UPDATE kit_logos SET edit_hash = ? WHERE id = ?', [D.sha('club:' + key), k.id]);
    const editUrl = `${clubUrl(k)}/edit#${k.id}.${key}`;
    await mail.send({ key: 'club-link-' + k.id + '-' + key.slice(0, 12), to: email, subject: `Your link to edit ${k.name}’s page`,
      text: `${claiming ? `${k.name}'s page is yours: ${clubUrl(k)}\n\n` : ''}Edit it here (no account, keep this link to yourself; a new one turns this one off): ${editUrl}`,
      html: mail.shell({ from: SITE(), title: claiming ? `${k.name}’s page is yours` : 'Your editor link',
        html: `<p><a href="${mail.esc(clubUrl(k))}">${mail.esc(clubUrl(k).replace(/^https?:\/\//, ''))}</a></p><p>Change the page and send your members their links here. No account: keep this link to yourself.</p><p><a href="${mail.esc(editUrl)}" style="display:inline-block;background:#1d1f24;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none">Edit the page</a></p>`,
        footer: 'A new link turns this one off.' }) }).catch(() => {});
    if (claiming) {
      // The site owner hears about it right away.
      const ownerHost = process.env.SITE_OWNER_EMAIL ? { email: process.env.SITE_OWNER_EMAIL } : await get('SELECT email FROM hosts WHERE id = ?', [k.host_id]);
      if (ownerHost && ownerHost.email) {
        await mail.send({ key: 'club-claimed-' + k.id, to: ownerHost.email, subject: `${k.name} claimed their page`,
          text: `${k.name} kept their page (${clubUrl(k)}). They used ${email}.`,
          html: mail.shell({ from: SITE(), title: `${k.name} claimed their page`, html: `<p><a href="${mail.esc(clubUrl(k))}">${mail.esc(clubUrl(k).replace(/^https?:\/\//, ''))}</a> is theirs now. They used ${mail.esc(email)}.</p>` }) }).catch(() => {});
      }
    }
    res.json({ ok: true, claimed: claiming, editUrl });
  });

  /* ---------- the club's editor: their key (from the link), or the owner signed in ---------- */
  async function clubFor(req) {
    const id = parseInt(req.params.id, 10) || 0;
    const k = await get("SELECT * FROM kit_logos WHERE id = ? AND kind = 'group' AND page_slug IS NOT NULL", [id]);
    if (!k) return null;
    const key = String(req.get('x-club-key') || '');
    if (key && /^[a-f0-9]{40}$/.test(key) && k.edit_hash && !k.prospect && D.sha('club:' + key) === k.edit_hash) return k;
    const me = await session(req);
    if (me && me.id === k.host_id && isOwner(me)) { req.me = me; return k; }
    return null;
  }
  const clubOnly = async (req, res, next) => {
    if (limited('clubedit:' + (req.ip || ''), 300, 15 * 60000)) return res.status(429).json({ error: 'Too many changes at once. Wait a minute.' });
    req.club = await clubFor(req);
    if (!req.club) return res.status(404).json({ error: 'That link is old. Get a new one from the page.' });
    next();
  };
  const fresh = async (req, res) => res.set('Cache-Control', 'no-store').json({ club: await clubShape(await get('SELECT * FROM kit_logos WHERE id = ?', [req.club.id])) });
  r.get('/club-edit/:id', clubOnly, fresh);
  r.put('/club-edit/:id', clubOnly, async (req, res) => {
    const b = Object.assign({}, req.body || {}); delete b.slug; delete b.nextMeetId; // the address and the meet stay the owner's to set
    if (!(await saveDetails(req.club, b, res))) return;
    return fresh(req, res);
  });
  r.post('/club-edit/:id/logo', clubOnly, rawImage, async (req, res) => {
    const colors = await takeLogo(req.club, req, res);
    if (!colors) return;
    res.json({ colors, club: await clubShape(await get('SELECT * FROM kit_logos WHERE id = ?', [req.club.id])) });
  });
  r.post('/club-edit/:id/video', clubOnly, (req, res) => takeVideo(req, res, 'kit_logos', req.club.id));
  r.post('/club-edit/:id/members', clubOnly, async (req, res) => {
    const out = await addMember(req.club, req.body || {});
    if (out.error) return res.status(out.status || 400).json({ error: out.error });
    res.status(201); return fresh(req, res);
  });
  r.delete('/club-edit/:id/members/:mid', clubOnly, async (req, res) => {
    const m = await get('SELECT * FROM members WHERE id = ? AND club_id = ?', [parseInt(req.params.mid, 10) || 0, req.club.id]);
    if (!m) return res.status(404).json({ error: 'That page is gone.' });
    await removeMember(m);
    return fresh(req, res);
  });
  // A member's own link to finish their page (a new one turns the last one off), and a message to text them.
  r.post('/club-edit/:id/members/:mid/link', clubOnly, async (req, res) => {
    const m = await get('SELECT * FROM members WHERE id = ? AND club_id = ?', [parseInt(req.params.mid, 10) || 0, req.club.id]);
    if (!m) return res.status(404).json({ error: 'That page is gone.' });
    const key = crypto.randomBytes(20).toString('hex');
    await run('UPDATE members SET edit_hash = ? WHERE id = ?', [D.sha('member:' + key), m.id]);
    const page = `${SCHEME()}://${SITE_DOMAIN()}/@${m.handle}`;
    const url = `${page}/edit#${m.id}.${key}`;
    res.status(201).json({ url, text: `Hey${m.name ? ' ' + m.name.split(' ')[0] : ''}! Your page on ${req.club.name}’s site is started: ${page}. Add your car photos, a clip and your mods here (no account needed, keep this link to yourself): ${url}` });
  });
};
module.exports.readScreens = readScreens;
module.exports.dmText = dmText;
