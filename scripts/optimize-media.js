#!/usr/bin/env node
/* One-time catch-up for pictures and clips uploaded before the speed pass. Safe to run again (it skips what's done).

     node scripts/optimize-media.js            clips re-encoded + phone-size pictures made
     node scripts/optimize-media.js --dry      just says what it would do

   - Every background clip without an HEVC copy is re-made from its current file: 1080p, 24 fps, capped H.264
     plus the HEVC copy. The new files replace the old ones (old ones deleted after the row points at the new).
   - Phone-size WebP copies of logos, flyers, photos and stills (the site also makes these on first view; this
     just does them all now so nobody waits).
   - Phone-size copies whose original is gone are removed. */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const D = require('../db');
const V = require('../video');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const DRY = process.argv.includes('--dry');
const up = (f) => path.join(UPLOAD_DIR, path.basename(String(f)));
const has = (f) => f && fs.existsSync(up(f));
const say = (...a) => console.log(...a);

async function cols(t) { return (await D.all(`PRAGMA table_info(${t})`)).map((c) => c.name); }

async function clips() {
  let n = 0;
  for (const t of ['hosts', 'meets', 'site', 'host_portal', 'kit_logos']) {
    if (!(await cols(t)).includes('video_hevc')) continue;
    const rows = await D.all(`SELECT id, video, video_poster FROM ${t} WHERE video IS NOT NULL AND video_hevc IS NULL`);
    for (const r of rows) {
      if (!has(r.video)) continue;
      say(`clip ${t} #${r.id}: ${r.video} (${(fs.statSync(up(r.video)).size / 1e6).toFixed(1)} MB)`);
      if (DRY) continue;
      try {
        const out = await V.process(up(r.video), UPLOAD_DIR);
        await D.run(`UPDATE ${t} SET video = ?, video_hevc = ?, video_poster = ? WHERE id = ?`, [out.video, out.hevc, out.poster, r.id]);
        for (const f of [r.video, r.video_poster]) if (f) fs.promises.unlink(up(f)).catch(() => {});
        const mb = (f) => f && has(f) ? (fs.statSync(up(f)).size / 1e6).toFixed(1) + ' MB' : '-';
        say(`   → ${mb(out.video)} H.264, ${mb(out.hevc)} HEVC`); n++;
      } catch (e) { say('   failed:', e.message); }
    }
  }
  return n;
}

async function pictures() {
  const want = []; // [file, size]
  const add = (f, size) => { if (has(f) && /\.(png|jpe?g|webp|gif)$/i.test(f)) want.push([path.basename(f), size]); };
  for (const r of await D.all('SELECT file FROM kit_logos WHERE file IS NOT NULL')) { add(r.file, 256); add(r.file, 512); }
  const mc = await cols('meets');
  for (const r of await D.all(`SELECT flyer${mc.includes('logo') ? ', logo' : ''} FROM meets`)) { add(r.flyer, 1080); if (r.logo) add(r.logo, 720); }
  for (const r of await D.all('SELECT logo FROM hosts WHERE logo IS NOT NULL')) if (/^\/uploads\//.test(r.logo)) add(r.logo, 720);
  for (const t of ['hosts', 'meets', 'site', 'host_portal', 'kit_logos']) {
    for (const r of await D.all(`SELECT video_poster FROM ${t} WHERE video_poster IS NOT NULL`)) add(r.video_poster, 1280);
  }
  try { for (const r of await D.all('SELECT file FROM kit_media WHERE file IS NOT NULL')) add(r.file, 480); } catch (e) { /* no photos table yet */ }
  let n = 0;
  for (const [f, size] of want) {
    const name = f.replace(/\.[A-Za-z0-9]+$/, '') + `.s${size}.webp`;
    if (has(name)) continue;
    if (DRY) { say(`picture ${f} → ${name}`); continue; }
    const made = await V.small(up(f), UPLOAD_DIR, size);
    if (made) { n++; say(`picture ${f}: ${(fs.statSync(up(f)).size / 1024).toFixed(0)} KB → ${(fs.statSync(up(made)).size / 1024).toFixed(0)} KB`); }
  }
  return n;
}

function sweep() {
  let n = 0;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const m = /^(.+)\.s\d+\.webp$/.exec(f);
    if (!m) continue;
    const orig = fs.readdirSync(UPLOAD_DIR).some((g) => g !== f && g.startsWith(m[1] + '.') && !/\.s\d+\.webp$/.test(g));
    if (!orig) { say('removing leftover', f); if (!DRY) fs.unlinkSync(up(f)); n++; }
  }
  return n;
}

(async () => {
  if (!V.ffmpegOk()) { console.error('ffmpeg is not installed on this server (apt install ffmpeg).'); process.exit(1); }
  await D.ensureSchema();
  const c = await clips();
  const p = await pictures();
  const s = sweep();
  say(`Done${DRY ? ' (dry run)' : ''}: ${c} clips re-made, ${p} phone-size pictures, ${s} leftovers removed.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
