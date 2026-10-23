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
  // Logos from the flyer kit a host lists on a meet's page, in the order added: vendors under Food, car clubs under Clubs.
  await exec(`CREATE TABLE IF NOT EXISTS meet_kit_vendors (
    meet_id INTEGER NOT NULL, kit_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (meet_id, kit_id)
  )`);
  // A kit logo can be linked to one of the meet's trucks (its slug), so tapping the logo opens that truck's menu.
  await addColumn('meet_kit_vendors', 'truck_slug', 'TEXT');
  // A Food vendor or Club in the host's lists (kept in kit_logos): their Instagram, a club's short line, and the
  // truck profile on the food side a Food vendor is tied to (its pre-order link and menu).
  await addColumn('kit_logos', 'instagram', 'TEXT');
  await addColumn('kit_logos', 'note', 'TEXT');
  await addColumn('kit_logos', 'truck_slug', 'TEXT');
  // A Food vendor's profile page: what they're about, what they sell, what they're known for, since when, and its
  // address (/v/<page_slug>, or <page_slug>.<site domain>). Off until the host turns it on (after asking the truck).
  await addColumn('kit_logos', 'about', 'TEXT');
  await addColumn('kit_logos', 'serves', 'TEXT');
  await addColumn('kit_logos', 'signature', 'TEXT');
  await addColumn('kit_logos', 'since', 'TEXT');
  await addColumn('kit_logos', 'page_slug', 'TEXT');
  await addColumn('kit_logos', 'page_on', 'INTEGER NOT NULL DEFAULT 0');
  await exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_kit_page_slug ON kit_logos (page_slug) WHERE page_slug IS NOT NULL');
  // A profile's pictures: past logos (with a label like "2022") and food photos.
  await exec(`CREATE TABLE IF NOT EXISTS kit_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kit_id INTEGER NOT NULL, host_id INTEGER NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL,
    label TEXT, created_at INTEGER NOT NULL
  )`);
  await exec('CREATE INDEX IF NOT EXISTS idx_kit_media ON kit_media (kit_id, kind)');
  // The spots a vendor parks at regularly (from their location tags and "find us" posts).
  await exec(`CREATE TABLE IF NOT EXISTS kit_spots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kit_id INTEGER NOT NULL, host_id INTEGER NOT NULL, name TEXT NOT NULL, address TEXT,
    when_text TEXT, created_at INTEGER NOT NULL
  )`);
  // The meets a vendor served at (a truck that was in, or a logo the host listed), for "At 6 meets".
  await exec('CREATE TABLE IF NOT EXISTS kit_meets (kit_id INTEGER NOT NULL, meet_id INTEGER NOT NULL, PRIMARY KEY (kit_id, meet_id))');
  // A profile's old addresses, so a shared link still lands after a rename.
  await exec('CREATE TABLE IF NOT EXISTS kit_old_slugs (slug TEXT PRIMARY KEY, kit_id INTEGER NOT NULL, created_at INTEGER NOT NULL)');
  // A meet's parking map on the satellite view (public/lotmap.js): its spot and zoom, the zones the host drew (club
  // parking, vendors, overflow...) and pins (entrances...), as JSON.
  await addColumn('meets', 'lot', 'TEXT');
  // Addresses already looked up, so the map search doesn't ask the geocoder twice for the same one.
  await exec('CREATE TABLE IF NOT EXISTS geocache (q TEXT PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL)');
  // The host portal's own background video (one row per host, id = the host's id).
  await exec('CREATE TABLE IF NOT EXISTS host_portal (id INTEGER PRIMARY KEY)');
  for (const t of ['hosts', 'meets', 'site', 'host_portal', 'kit_logos']) {
    await addColumn(t, 'video', 'TEXT');
    await addColumn(t, 'video_poster', 'TEXT');
    await addColumn(t, 'video_status', 'TEXT'); // processing | ready | failed
    await addColumn(t, 'video_error', 'TEXT');
  }
}

module.exports = { db, run, get, all, exec, sha, token, ensureSchema, DB_FILE };
