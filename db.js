'use strict';
/* db.js — one SQLite file. Tables only ever gain columns or tables, so older code still runs on a newer file. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'meets.sqlite');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new sqlite3.Database(DB_FILE);

const run = (sql, p = []) => new Promise((ok, no) => db.run(sql, p, function (e) { return e ? no(e) : ok({ lastID: this.lastID, changes: this.changes }); }));
const get = (sql, p = []) => new Promise((ok, no) => db.get(sql, p, (e, r) => (e ? no(e) : ok(r))));
const all = (sql, p = []) => new Promise((ok, no) => db.all(sql, p, (e, r) => (e ? no(e) : ok(r))));
const exec = (sql) => new Promise((ok, no) => db.exec(sql, (e) => (e ? no(e) : ok())));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

async function addColumn(table, col, def) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === col)) await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

async function ensureSchema() {
  await exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  await exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
      tagline TEXT, city TEXT, accent TEXT, logo TEXT, instagram TEXT, tiktok TEXT, youtube TEXT, rules TEXT,
      close_minutes INTEGER NOT NULL DEFAULT 120, timezone TEXT, custom_domain TEXT, domain_on INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, host_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER NOT NULL, ref TEXT UNIQUE NOT NULL, title TEXT, day TEXT NOT NULL,
      start_time TEXT NOT NULL, end_time TEXT NOT NULL, place TEXT NOT NULL, address TEXT, notes TEXT,
      status TEXT NOT NULL DEFAULT 'on', synced_at INTEGER, sync_error TEXT,
      turnout_people INTEGER, turnout_cars INTEGER, turnout_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meets_host_day ON meets (host_id, day);
    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL,
      verified_at INTEGER, off_at INTEGER, created_at INTEGER NOT NULL, sent_at INTEGER, UNIQUE (host_id, email)
    );
    CREATE TABLE IF NOT EXISTS vendor_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER NOT NULL, name TEXT NOT NULL, contact TEXT NOT NULL, food TEXT,
      note TEXT, status TEXT NOT NULL DEFAULT 'new', ip_hash TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_vendors (
      host_id INTEGER NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT, last_meet_at INTEGER, PRIMARY KEY (host_id, slug)
    );
    CREATE TABLE IF NOT EXISTS recaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER NOT NULL, meet_id INTEGER, video_url TEXT, caption TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recap_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recap_id INTEGER NOT NULL, host_id INTEGER NOT NULL, file TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE NOT NULL, meet_id INTEGER NOT NULL, host_id INTEGER NOT NULL,
      vendor_slug TEXT NOT NULL, vendor_name TEXT, name TEXT, email TEXT, ticket INTEGER, status TEXT, payment TEXT,
      pickup_at INTEGER, total REAL, items_json TEXT, mailed_paid INTEGER NOT NULL DEFAULT 0, mailed_ready INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER NOT NULL, meet_id INTEGER, subject TEXT NOT NULL, body TEXT NOT NULL,
      to_alerts INTEGER NOT NULL DEFAULT 0, to_vendors INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT UNIQUE, payload TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, done_at INTEGER
    );
  `);
  // Later additions go here, with addColumn, so a database from an older version picks them up.
  await addColumn('hosts', 'plan', "TEXT NOT NULL DEFAULT 'free'");
  // Background video behind the meet's date (video.js): the loop, its still frame, and where processing stands.
  // The site's own front page (one row): its background video, set by the site owner (SITE_OWNER_EMAIL).
  await exec("CREATE TABLE IF NOT EXISTS site (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at INTEGER)");
  await run('INSERT OR IGNORE INTO site (id, updated_at) VALUES (1, 0)');
  // Each meet's flyer (the one they post on Instagram), shown as the page's main picture.
  await addColumn('meets', 'flyer', 'TEXT');
  // The flyer kit: vendor and car group logos a host keeps on hand to paste onto each week's flyer.
  await exec(`CREATE TABLE IF NOT EXISTS kit_logos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  // Vendors from the flyer kit a host lists on a meet's page (trucks not on the ordering system), in the order added.
  await exec(`CREATE TABLE IF NOT EXISTS meet_kit_vendors (
    meet_id INTEGER NOT NULL, kit_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (meet_id, kit_id)
  )`);
  for (const t of ['hosts', 'meets', 'site']) {
    await addColumn(t, 'video', 'TEXT');
    await addColumn(t, 'video_poster', 'TEXT');
    await addColumn(t, 'video_status', 'TEXT'); // processing | ready | failed
    await addColumn(t, 'video_error', 'TEXT');
  }
}

module.exports = { db, run, get, all, exec, sha, token, ensureSchema, DB_FILE };
