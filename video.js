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
    if (!ACCEPT.test(type)) return no(new Error('Use a video file (MP4, MOV or WebM).'));
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

module.exports = { receive, process: process_, ffmpegOk, MAX_UPLOAD, SECONDS };
