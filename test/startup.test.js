'use strict';
/* Startup tidy: a video left "processing" by a restart is marked failed (so a new one can be uploaded), and a logo
   saved before logos were made see-through is redone. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carmeet-start-'));
process.env.DB_FILE = path.join(tmp, 'meets.sqlite');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('a restart frees stuck videos and makes old logos see-through', async () => {
  const D = require('../db');
  const S = require('../server');
  await S.ready();
  const now = Date.now();
  await D.run("INSERT INTO hosts (name, slug, email, created_at, updated_at) VALUES ('Tasty Tuesday', 'tasty', 't@x.test', ?, ?)", [now, now]);
  const h = await D.get("SELECT id FROM hosts WHERE slug = 'tasty'");
  let logo = null;
  if (ffmpeg) {
    logo = 'old.png';
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=300x200', '-frames:v', '1',
      '-vf', 'drawbox=x=80:y=50:w=140:h=100:color=0xd4a640:t=fill', path.join(process.env.UPLOAD_DIR, logo)]);
  }
  await D.run("UPDATE hosts SET video_status = 'processing', logo = ? WHERE id = ?", [logo ? '/uploads/' + logo : null, h.id]);
  await S.tidyAtStart();
  const after = await D.get('SELECT * FROM hosts WHERE id = ?', [h.id]);
  assert.equal(after.video_status, 'failed');
  assert.match(after.video_error, /restarted/);
  if (ffmpeg) {
    assert.match(after.logo, /^\/uploads\/logo-[0-9a-f]+-k\.png$/);
    assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, path.basename(after.logo))));
    await S.tidyAtStart(); // a second start leaves it alone
    assert.equal((await D.get('SELECT logo FROM hosts WHERE id = ?', [h.id])).logo, after.logo);
  }
});
