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

/* Video work never crowds out the pages: ffmpeg runs at the lowest priority and leaves a core free (the server also
   runs the food side). An encode takes a little longer; the site stays quick while it does. VIDEO_THREADS overrides. */
const THREADS = () => String(Math.max(1, parseInt(process.env.VIDEO_THREADS, 10) || (require('os').cpus().length - 1) || 1));
function run(args, ms) {
  return new Promise((ok, no) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    try { if (p.pid) require('os').setPriority(p.pid, 19); } catch (e) { /* not allowed here: it still runs */ }
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('close', (code) => { clearTimeout(t); code === 0 ? ok() : no(new Error(err.split('\n').filter(Boolean).slice(-1)[0] || 'ffmpeg failed')); });
    p.on('error', (e) => { clearTimeout(t); no(e); });
  });
}

let hasX265 = null;
function x265Ok() {
  if (hasX265 === null) { try { hasX265 = /libx265/.test(spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-encoders'], { timeout: 5000 }).stdout.toString()); } catch (e) { hasX265 = false; } }
  return hasX265;
}
// 1080p on the short side, whichever way the phone was held (1920×1080 sideways, 1080×1920 upright), at 24 fps.
const VF = "scale='if(gte(iw,ih),-2,trunc(min(iw,1080)/2)*2)':'if(gte(iw,ih),trunc(min(ih,1080)/2)*2,-2)',fps=24,format=yuv420p";
/**
 * The loop: the first 15 seconds, 1080p (never blown up), 24 fps, no sound, no metadata, the index at the front so
 * it starts before it's all downloaded. The footage sits under a dark overlay and grain, so it's compressed harder
 * than a video you'd watch on its own, with a hard ceiling on the size:
 *   - H.264, which every phone plays: at most about 3.4 MB (usually 1.5–2.5).
 *   - HEVC, the same picture at about half the size, for phones that play it (iPhones, most newer Androids). Pages
 *     offer it first; a phone that can't play it takes the H.264 one. Skipped when ffmpeg has no x265.
 * Then a still from 1 second in. Resolves { video, hevc: null, poster }: the HEVC copy comes after, from hevcOf().
 */
async function process_(input, dir) {
  const id = crypto.randomBytes(10).toString('hex');
  const video = `bg-${id}.mp4`, poster = `bg-${id}.jpg`;
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-t', String(SECONDS), '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-vf', VF];
  // "medium": about a third faster than "slow" for the same size here (the bitrate ceiling sets the size).
  await run(common.concat(['-threads', THREADS(), '-c:v', 'libx264', '-preset', process.env.VIDEO_PRESET || 'medium', '-crf', '26', '-maxrate', '1800k', '-bufsize', '3600k',
    '-profile:v', 'high', '-level', '4.1', '-g', '48', '-movflags', '+faststart', path.join(dir, video)]), 10 * 60 * 1000);
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', path.join(dir, video), '-frames:v', '1', '-q:v', '5', '-vf', "scale='min(1280,iw)':-2", path.join(dir, poster)], 60 * 1000)
    .catch(() => run(['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, video), '-frames:v', '1', '-q:v', '5', path.join(dir, poster)], 60 * 1000));
  return { video, hevc: null, poster };
}
/**
 * The smaller HEVC copy, made after the clip is already showing (it takes about four times as long as the H.264 one,
 * so it no longer holds up "Processing"). Made from the finished loop: already 15 seconds, scaled and silent.
 * Resolves its file name, or null when there's no x265 or it fails.
 */
async function hevcOf(video, dir) {
  if (!x265Ok() || process.env.VIDEO_HEVC === '0') return null;
  const hevc = String(video).replace(/\.mp4$/, '') + '.hevc.mp4';
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, video), '-an', '-c:v', 'libx265', '-preset', process.env.VIDEO_PRESET === 'veryfast' ? 'veryfast' : 'medium', '-crf', '28', '-tag:v', 'hvc1',
      '-x265-params', `log-level=error:keyint=48:vbv-maxrate=1000:vbv-bufsize=2000:pools=${THREADS()}:frame-threads=1`, '-movflags', '+faststart', path.join(dir, hevc)], 15 * 60 * 1000);
    return hevc;
  } catch (e) { fs.promises.unlink(path.join(dir, hevc)).catch(() => {}); return null; }
}

// The image read back as a small grid of RGBA pixels (S×S, stretched), plus its real size. ffmpeg's own
// cropdetect gets the edges wrong on some images (it kept a thin middle strip of a crest), so the edges are
// worked out here from the pixels instead.
const S = 400;
function pixels(input) {
  return new Promise((ok) => {
    const p = spawn(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-i', input, '-frames:v', '1', '-vf', `scale=${S}:${S},format=rgba`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    const t = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', () => {
      clearTimeout(t);
      const buf = Buffer.concat(out), m = err.match(/Video:[^\n]*?, (\d{1,5})x(\d{1,5})[,\s]/);
      ok(buf.length === S * S * 4 && m ? { buf, w: +m[1], h: +m[2] } : null);
    });
    p.on('error', () => { clearTimeout(t); ok(null); });
  });
}
/** The logo's box inside the image: everything that isn't near-black (or see-through) margin, and whether the
    background is black (so it can be made see-through). Null box = keep it all. */
function logoBox(px) {
  const { buf, w, h } = px;
  const at = (x, y) => (y * S + x) * 4;
  // A see-through background (PNG with transparent corners): anything visible counts. Otherwise anything not near-black.
  const corners = [at(0, 0), at(S - 1, 0), at(0, S - 1), at(S - 1, S - 1)];
  const clear = corners.filter((i) => buf[i + 3] < 128).length >= 2;
  const black = !clear && corners.filter((i) => Math.max(buf[i], buf[i + 1], buf[i + 2]) < 40).length >= 3;
  const on = (i) => (clear ? buf[i + 3] > 40 : buf[i + 3] > 40 && Math.max(buf[i], buf[i + 1], buf[i + 2]) > 40);
  const rows = new Array(S).fill(0), cols = new Array(S).fill(0);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (on(at(x, y))) { rows[y]++; cols[x]++; }
  const first = (a) => a.findIndex((n) => n >= 2), last = (a) => a.length - 1 - [...a].reverse().findIndex((n) => n >= 2);
  const y0 = first(rows), x0 = first(cols);
  if (y0 < 0 || x0 < 0) return { box: null, black };
  const y1 = last(rows), x1 = last(cols);
  const pad = 0.02 * S;
  const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad), bx1 = Math.min(S, x1 + 1 + pad), by1 = Math.min(S, y1 + 1 + pad);
  const cw = Math.round(((bx1 - bx0) / S) * w), ch = Math.round(((by1 - by0) / S) * h);
  const cx = Math.round((bx0 / S) * w), cy = Math.round((by0 / S) * h);
  if (cw < 8 || ch < 8 || (cw >= w - 2 && ch >= h - 2)) return { box: null, black };
  return { box: { w: Math.min(cw, w - cx), h: Math.min(ch, h - cy), x: cx, y: cy }, black };
}

/** Logo files made by trimLogo end in "-k.png": trimmed, and a black background made see-through. */
const TRIMMED = /-k\.png$/;
/**
 * A logo cut down to the logo itself, as a PNG at most 900 px wide. A black background becomes see-through (soft at
 * the edges), so the logo sits on the night footage with no black box around it. Returns the new file name, or
 * null when ffmpeg isn't there or can't read it.
 */
async function trimLogo(input, dir) {
  if (!ffmpegOk()) return null;
  const px = await pixels(input);
  const { box, black } = (px && logoBox(px)) || { box: null, black: false };
  const name = `logo-${crypto.randomBytes(8).toString('hex')}-k.png`;
  const vf = (box ? `crop=${box.w}:${box.h}:${box.x}:${box.y},` : '') + "scale='min(900,iw)':-2,format=rgba" +
    (black ? ',colorkey=0x000000:0.16:0.12' : '');
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map_metadata', '-1', '-vf', vf, '-frames:v', '1', path.join(dir, name)], 60000);
    return name;
  } catch (e) { return null; }
}

/* ---------- phone-size copies of pictures ----------
   A logo shown 60 px wide doesn't need a 1,000 px file. Next to each upload goes a small WebP copy,
   <name>.s<size>.webp (see-through kept), at most `size` px on its long side; pages use it when it's there
   (views.small). Sizes of 1000 and up (flyer, poster) cap the width only, so a tall flyer stays sharp on a phone.
   The original stays for the flyer maker and downloads. Resolves the copy's name, or null. */
async function small(input, dir, size) {
  if (!ffmpegOk()) return null;
  const base = path.basename(input).replace(/\.[A-Za-z0-9]+$/, '');
  const name = `${base}.s${size}.webp`;
  const tmp = path.join(dir, `.${name}.${process.pid}.tmp.webp`);
  try {
    await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', size >= 1000 ? `scale='min(${size},iw)':-2` : `scale=w='min(${size},iw)':h='min(${size},ih)':force_original_aspect_ratio=decrease`,
      '-c:v', 'libwebp', '-quality', '80', '-pix_fmt', 'yuva420p', '-frames:v', '1', tmp], 60 * 1000);
    await fs.promises.rename(tmp, path.join(dir, name)); // whole file or nothing, so a page never shows half a copy
    return name;
  } catch (e) { fs.promises.unlink(tmp).catch(() => {}); return null; }
}
module.exports = { receive, process: process_, hevcOf, ffmpegOk, trimLogo, small, TRIMMED, MAX_UPLOAD, SECONDS };
