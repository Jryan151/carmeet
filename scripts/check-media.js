#!/usr/bin/env node
/* Lists every picture or clip the site points at whose file isn't in the uploads folder (shows as a broken picture).
     node scripts/check-media.js          just list them
     node scripts/check-media.js --fix    clear those links, so the portal shows "upload again" / the emoji instead */
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const D = require('../db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const FIX = process.argv.includes('--fix');
const CHECKS = [
  ['kit_logos', 'file', 'name', "''"], ['kit_media', 'file', 'label', null], ['meets', 'flyer', 'title', 'NULL'], ['meets', 'logo', 'title', 'NULL'],
  ['hosts', 'logo', 'name', 'NULL'],
];

(async () => {
  await D.ensureSchema();
  console.log('Uploads folder:', UPLOAD_DIR, fs.existsSync(UPLOAD_DIR) ? `(${fs.readdirSync(UPLOAD_DIR).length} files)` : '(NOT FOUND)');
  let bad = 0;
  for (const [t, col, label, clear] of CHECKS) {
    let rows; try { rows = await D.all(`SELECT id, ${col} AS f, ${label} AS n FROM ${t} WHERE ${col} IS NOT NULL AND ${col} != ''`); } catch (e) { continue; }
    for (const r of rows) {
      const f = String(r.f).replace(/^\/uploads\//, '');
      if (/^https?:/.test(f) || fs.existsSync(path.join(UPLOAD_DIR, path.basename(f)))) continue;
      bad++; console.log(`missing: ${t} #${r.id} (${r.n || ''}) → ${f}`);
      if (FIX) {
        if (clear) await D.run(`UPDATE ${t} SET ${col} = ${clear} WHERE id = ?`, [r.id]);
        else await D.run(`DELETE FROM ${t} WHERE id = ?`, [r.id]);
      }
    }
  }
  console.log(bad ? `${bad} missing${FIX ? ', cleared' : ' (run with --fix to clear them)'}.` : 'Every file is there.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
