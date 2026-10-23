'use strict';
/* video.js — the background loop behind a meet's date. The host uploads any phone clip; the server (ffmpeg) turns it
   into a 1080p, silent, 15-second loop that starts playing fast, plus a still frame for while it loads (and for
   anyone with reduced motion or data saver on). Location and camera data are dropped; the original is deleted. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const MAX_UPLOAD = 400 * 1024 * 1024; // a few minutes of 4K phone video
const SECONDS = 15;
const ACCEPT = /^video\/(mp4|quicktime|webm|x-m4v|3gpp)$/;

let hasFfmpeg = null;
function ffmpegOk() {
  if (hasFfmpeg === null) { try { hasFfmpeg = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-version'], { timeout: 5000 }).status === 0; } catch (e) { hasFfmpeg = false; } }
  return hasFfmpeg;
}

/** Streams the upload to a temp file (never all in memory). Resolves the file path, or rejects with a message. */
function receive(req, dir) {
  return new Promise((ok, no) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    // A refused upload is still read to the end (and thrown away) before the answer goes back: answering mid-upload
    // makes the connection close under the browser, which then shows a dropped connection instead of the reason.
    const refuse = (msg) => { let done = false; const fin = () => { if (!done) { done = true; no(new Error(msg)); } }; req.on('end', fin); req.on('close', fin); req.resume(); };
    if (!ACCEPT.test(type)) return refuse('Use a video file (MP4, MOV or WebM).');
    const len = parseInt(req.headers['content-length'], 10);
    if (len > MAX_UPLOAD) return no(new Error('That video is over 400 MB. Trim it on your phone first.'));
    const file = path.join(dir, 'in-' + crypto.randomBytes(8).toString('hex'));
    const out = fs.createWriteStream(file);
    let n = 0, failed = false;
    const fail = (msg) => { if (failed) return; failed = true; out.destroy(); fs.promises.unlink(file).catch(() => {}); no(new Error(msg)); };
    req.on('data', (c) => { n += c.length; if (n > MAX_UPLOAD) { fail('That video is over 400 MB. Trim it on your phone first.'); req.destroy(); } });
    req.on('error', () => fail('The upload stopped. Try again on a stronger signal.'));
    req.on('aborted', () => fail('The upload stopped. Try again on a stronger signal.'));
    req.pipe(out);
    out.on('finish', () => { if (!failed) ok({ file, bytes: n }); });
    out.on('error', () => fail('Couldn’t save the upload.'));
  });
}

function run(args, ms) {
  return new Promise((ok, no) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('close', (code) => { clearTimeout(t); code === 0 ? ok() : no(new Error(err.split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed')); });
    p.on('error', (e) => { clearTimeout(t); no(e); });
  });
}

/**
 * The loop: the first 15 seconds, 1080p (never blown up), 30 fps, H.264 that every phone plays,
 * no sound, no metadata, the index at the front so it starts before it's all downloaded. About 6–9 MB.
 * Then a still from 1 second in. Resolves { video, poster } file names.
 */
async function process_(input, dir) {
  const id = crypto.randomBytes(10).toString('hex');
  const video = `bg-${id}.mp4`, poster = `bg-${id}.jpg`;
  // 1080p on the short side, whichever way the phone was held (1920×1080 sideways, 1080×1920 upright).
  const vf = "scale='if(gte(iw,ih),-2,trunc(min(iw,1080)/2)*2)':'if(gte(iw,ih),trunc(min(ih,1080)/2)*2,-2)',fps=30,format=yuv420p";
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', String(SECONDS), '-map', '0:v:0', '-an', '-sn', '-dn',
    '-map_metadata', '-1', '-map_chapters', '-1', '-vf', vf, '-c:v', 'libx264', '-preset', process.env.VIDEO_PRESET || 'medium', '-crf', '23', '-maxrate', '5M', '-bufsize', '10M',
    '-profile:v', 'high', '-level', '4.1', '-movflags', '+faststart', path.join(dir, video)], 10 * 60 * 1000);
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', path.join(dir, video), '-frames:v', '1', '-q:v', '4', path.join(dir, poster)], 60 * 1000)
    .catch(() => run(['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, video), '-frames:v', '1', '-q:v', '4', path.join(dir, poster)], 60 * 1000));
  return { video, poster };
}

/**
 * A logo cut down to the logo itself: the empty black (or near-black) margin around it is trimmed, and it's
 * kept to at most 900 px wide, as a PNG. A logo posted as a tall phone-sized image with black above and below
 * becomes just the crest. Returns the new file name, or null when ffmpeg isn't there or can't read it.
 */
async function trimLogo(input, dir) {
  if (!ffmpegOk()) return null;
  const crop = await new Promise((ok) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loop', '1', '-i', input, '-vf', 'format=yuv420p,cropdetect=limit=0.12:round=2:reset=0', '-frames:v', '5', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    // Only a positive size counts: a negative one means nothing but margin was found.
    p.on('close', () => { clearTimeout(t); const m = err.match(/crop=\d+:\d+:\d+:\d+/g); ok(m ? m[m.length - 1] : null); });
    p.on('error', () => { clearTimeout(t); ok(null); });
  });
  const name = `logo-${crypto.randomBytes(8).toString('hex')}.png`;
  const vf = (crop && !/crop=0:0/.test(crop) ? crop + ',' : '') + "scale='min(900,iw)':-2";
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map_metadata', '-1', '-vf', vf, '-frames:v', '1', path.join(dir, name)], 60000);
    return name;
  } catch (e) { return null; }
}

module.exports = { receive, process: process_, ffmpegOk, trimLogo, MAX_UPLOAD, SECONDS };
