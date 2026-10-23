'use strict';
/* mail.js — email from this site's own domain (Resend). A message that can't go out right away waits in the outbox
   and is retried (1, 5, 15 minutes, then hourly) for up to a day, always with the same key, so it never arrives twice. */
const { run, get, all } = require('./db');

const SITE = () => process.env.SITE_NAME || 'Meet Night';
const configured = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
const BACKOFF_MIN = [1, 5, 15, 60, 60, 120, 240];
const GIVE_UP_MS = 24 * 60 * 60 * 1000;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The one look every email has: plain, readable, the host's name on top, an unsubscribe line when there is one. */
function shell({ from, title, html, footer }) {
  return `<!doctype html><html><body style="margin:0;background:#f3f1ec;font-family:Helvetica,Arial,sans-serif;color:#1d1f24">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<div style="font-size:13px;color:#6b6e75;margin-bottom:10px">${esc(from)}</div>
<div style="background:#fff;border-radius:10px;padding:24px;border-top:6px solid #f2a33a">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25">${esc(title)}</h1>
<div style="font-size:15px;line-height:1.55">${html}</div></div>
<div style="font-size:12px;color:#8a8d93;margin-top:14px;line-height:1.5">${footer || ''}</div>
</div></body></html>`;
}

async function deliver(msg) {
  if (!configured()) return { ok: false, retry: false, error: 'email not set up' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json', 'idempotency-key': msg.key },
      body: JSON.stringify({ from: msg.fromName ? `${msg.fromName.replace(/[<>"]/g, '')} <${String(process.env.MAIL_FROM).replace(/^.*</, '').replace(/>.*$/, '')}>` : process.env.MAIL_FROM,
        to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers }),
    });
    if (r.ok) return { ok: true };
    return { ok: false, retry: r.status === 429 || r.status >= 500, error: 'HTTP ' + r.status };
  } catch (e) { return { ok: false, retry: true, error: e.message }; }
}

/** Sends now if it can; otherwise keeps it and tries again later. Resolves true when it went out right away. */
async function send(msg) {
  if (!msg.key) throw new Error('mail needs a key');
  if (!configured()) { if (process.env.NODE_ENV !== 'test') console.log(`[mail off] to ${msg.to}: ${msg.subject}`); return false; }
  if (await get('SELECT 1 AS x FROM mail_outbox WHERE idem_key = ?', [msg.key])) return false;
  const r = await deliver(msg);
  if (r.ok || !r.retry) {
    await run('INSERT OR IGNORE INTO mail_outbox (idem_key, payload, tries, next_at, last_error, created_at, done_at) VALUES (?, ?, 1, 0, ?, ?, ?)',
      [msg.key, '{}', r.error || null, Date.now(), Date.now()]);
    return r.ok;
  }
  await run('INSERT OR IGNORE INTO mail_outbox (idem_key, payload, tries, next_at, last_error, created_at) VALUES (?, ?, 1, ?, ?, ?)',
    [msg.key, JSON.stringify(msg), Date.now() + BACKOFF_MIN[0] * 60000, r.error, Date.now()]);
  return false;
}
async function retry() {
  const rows = await all('SELECT * FROM mail_outbox WHERE done_at IS NULL AND next_at <= ? ORDER BY id LIMIT 20', [Date.now()]);
  for (const row of rows) {
    const msg = JSON.parse(row.payload);
    const r = await deliver(msg);
    const done = r.ok || !r.retry || Date.now() - row.created_at > GIVE_UP_MS;
    await run('UPDATE mail_outbox SET tries = tries + 1, next_at = ?, last_error = ?, done_at = ? WHERE id = ?',
      [Date.now() + BACKOFF_MIN[Math.min(row.tries, BACKOFF_MIN.length - 1)] * 60000, r.error || null, done ? Date.now() : null, row.id]);
  }
}
function start() { setInterval(() => retry().catch((e) => console.error('mail retry:', e.message)), 60 * 1000).unref(); }

module.exports = { send, retry, start, shell, esc, configured, SITE };
