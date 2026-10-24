'use strict';
/* fixtures.js — media for the stress runs, made once with ffmpeg into test/stress/.fixtures (not committed).
   node test/stress/fixtures.js [--big]   (--big also makes the 4K 60 fps clip and the 400 MB file) */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '.fixtures');
fs.mkdirSync(DIR, { recursive: true });
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit', timeout: 30 * 60 * 1000 });
const have = (f) => fs.existsSync(path.join(DIR, f)) && fs.statSync(path.join(DIR, f)).size > 0;
const out = (f) => path.join(DIR, f);

// A phone photo (busy enough to compress like one), a logo with a black margin, the copies pages ask for.
if (!have('photo.jpg')) ff(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1350', '-frames:v', '1', '-q:v', '3', out('photo.jpg')]);
if (!have('logo.png')) ff(['-f', 'lavfi', '-i', 'color=c=black:s=600x600', '-f', 'lavfi', '-i', 'testsrc=size=360x360', '-filter_complex', '[0][1]overlay=120:120', '-frames:v', '1', out('logo.png')]);
for (const s of [24, 256, 480, 512, 720, 1080, 1280]) {
  const f = `photo.s${s}.webp`;
  if (!have(f)) ff(['-i', out('photo.jpg'), '-vf', s >= 1000 ? `scale='min(${s},iw)':-2` : `scale=w='min(${s},iw)':h='min(${s},ih)':force_original_aspect_ratio=decrease`, '-c:v', 'libwebp', '-quality', '80', '-frames:v', '1', out(f)]);
}
// A finished background loop (what video.js makes) and its still, for seeded rows.
if (!have('loop.mp4')) ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-t', '15', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-maxrate', '1800k', '-bufsize', '3600k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out('loop.mp4')]);
if (!have('loop.jpg')) ff(['-ss', '1', '-i', out('loop.mp4'), '-frames:v', '1', '-q:v', '5', out('loop.jpg')]);
// Phone-like uploads: a 1080p 30 fps clip of 30 s with sound, an upright one.
if (!have('phone-1080p.mp4')) ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '12M', '-c:a', 'aac', '-shortest', out('phone-1080p.mp4')]);
if (!have('phone-upright.mov')) ff(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '10M', '-f', 'mov', out('phone-upright.mov')]);
// Broken inputs: a truncated video, an HTML file and an SVG named like pictures, a "JPEG bomb" (tiny file, huge canvas).
if (!have('truncated.mp4')) { const b = fs.readFileSync(out('phone-1080p.mp4')); fs.writeFileSync(out('truncated.mp4'), b.subarray(0, Math.floor(b.length / 3))); }
fs.writeFileSync(out('evil.html.png'), '<html><script>alert(document.domain)</script></html>');
fs.writeFileSync(out('evil.svg.png'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
if (!have('bomb.jpg')) {
  // 16000 x 16000 grey JPEG: about 1 MB on disk, 768 MB of pixels once decoded.
  ff(['-f', 'lavfi', '-i', 'color=c=gray:s=16000x16000', '-frames:v', '1', '-q:v', '31', out('bomb.jpg')]);
}
if (process.argv.includes('--big')) {
  if (!have('4k60.mp4')) ff(['-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '40M', '-c:a', 'aac', '-shortest', out('4k60.mp4')]);
  // Just under 400 MB: 4K 30 fps at a phone's top bitrate, about 50 s.
  if (!have('big-395mb.mp4')) ff(['-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30', '-t', '50', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '62M', '-maxrate', '62M', '-bufsize', '20M', out('big-395mb.mp4')]);
}
for (const f of fs.readdirSync(DIR)) console.log(f.padEnd(24), (fs.statSync(out(f)).size / 1048576).toFixed(2), 'MB');
