# Car meet site

Hosts' pages for their car meets, on a neutral domain of its own. The food side (trucks, menus, pre-orders,
payments, the kitchen) runs on Online Kitchen; this site talks to it server to server and never shows it to
the crowd: menus, photos, checkout returns and order emails all come through here, in the host's name.

## What's here

**For the crowd** (`/<host>` and `/<host>/<date>`)
- The next meet in its "parking space": day, date, time, spot, directions, how soon it starts.
- Last meet's turnout (from the host's count), the food trucks confirmed, house rules, the latest recap.
- **Pre-order** from a truck that takes cards: pick food and a pickup time, pay on the card page, get a paid email
  and a ready email from this site. The order page (`/o/<token>`) updates itself.
- **Get alerts**: email, confirmed with one tap; unsubscribe link in every email.
- **Food vendor? Ask for a spot**: a request the host sees in the portal.
- No RSVPs (they invite pranks). Demand comes from paid pre-orders, confirmed alert sign-ups and logged turnout.

**For hosts** (`/host`, sign in with an emailed code, no password)
- **Next meet**: pre-orders paid, trucks confirmed, people on alerts; the trucks and their pre-order counts
  (never money); invite a truck (a message with a link to text them), or add a truck you've had before in one
  tap; trucks asking for a spot; "how many came?" after a meet.
- **Meets**: post one (optionally emailing the alert list), edit, repeat next week, cancel.
- **Send update**: to the alert list and/or the trucks in a meet.
- **History**: turnout by spot (the number a truck wants to see) and past meets.
- **Settings**: name, city, color, socials, house rules, when pre-orders close, logo, recap (video link and up to
  9 photos, location data removed), and their own domain.
- **Background video**: any phone clip (up to 400 MB) becomes a silent, 15-second, 1080p loop behind the date,
  with a still frame while it loads (and for reduced motion or data saver). One for the page, and optionally one
  per meet (Meets › open a meet). Sound, camera and location data are dropped; the original is deleted.

**Paid later: their own domain.** A host saves `tuesdaymeets.com` in Settings; once DNS points here and the
upgrade is settled, you turn it on (below). Their page then lives there, without the "Page by" line, and the old
address redirects. Everything else is free.

## Run it

Node 20 or newer, and ffmpeg for background videos (`sudo apt install ffmpeg`). Without it the site runs; the
portal just says video processing isn't set up.

```
cp .env.example .env     # fill it in
npm install
npm start                # port 4100
npm test
```

## Connect the food side

1. Pick a key: `openssl rand -hex 24`.
2. Here, in `.env`: `KITCHEN_API=https://onlinekitchen.fyi` and `MEET_PARTNER_KEY=<key>`.
3. On Online Kitchen, in `.env`: `MEET_PARTNER_KEY=<same key>` and `MEET_HOOK_URL=https://<this domain>/hooks/kitchen`.
4. Restart both.

## Email

A second verified domain in the same Resend account, with its own send-only key for that domain. Set
`RESEND_API_KEY` and `MAIL_FROM` (an address on this domain). Emails go out "from" the host's name.

## Food vendor profiles

Settings › Food vendors › Edit › **Edit profile page**: their clip (any phone clip becomes the loop behind their profile
and their menu), what they sell, known for, serving since, an about in their words, up to 12 food photos, up to 12 past
logos with the year, and up to 8 spots they park at. "At 6 meets" counts itself. A page is **off** until you turn it on
(ask the truck first); while it's off, only you see it, as a preview. The Food logos on a meet page open a vendor's
profile once it's on. Its Order button opens their menu when they're at one of your next meets taking pre-orders, and
says "Not serving tonight" otherwise.

Addresses: `/v/<name>` on the site. With `VENDOR_SUBDOMAINS=1` each one gets its own, `<name>.azmonarchy.com`, and
`/v/<name>` moves there. Renaming keeps the old address working (it redirects).

Clips are saved on the phone the first time they play (`public/sw.js`) and play from there after: no second download,
and it works with no signal. The truck's menu is on the same address, so its clip comes from that copy too.

## Domain and server (Caddy)

```
meetnight.example, www.meetnight.example {
  reverse_proxy 127.0.0.1:4100
}
```

For vendor subdomains (and hosts' own domains without editing Caddy each time), use on-demand certificates. Caddy asks
this site before getting one, and it only says yes for the site, a host's own domain, or a vendor page that exists:

```
{
  on_demand_tls {
    ask http://127.0.0.1:4100/caddy/ask
  }
}

azmonarchy.com, www.azmonarchy.com {
  reverse_proxy 127.0.0.1:4100
}

https:// {
  tls {
    on_demand
  }
  reverse_proxy 127.0.0.1:4100
}
```

DNS: one wildcard record at Porkbun, `*.azmonarchy.com` → the server's IP (an A record, plus AAAA if it has IPv6). Then
`VENDOR_SUBDOMAINS=1` in `.env` and restart. A vendor's first visit takes a few seconds while its certificate is made.

A host's own domain gets its own block pointing at the same port (or the on-demand block above). Then turn it on:

```
curl -X POST https://<this domain>/api/host/admin/domain \
  -H 'x-admin-token: <ADMIN_TOKEN>' -H 'content-type: application/json' -d '{"slug":"tasty-tuesday"}'
```

## Files

`server.js` pages, public API, the food side's notices · `host.js` portal API · `kitchen.js` the only code that
talks to the food side · `views.js` server-written pages · `mail.js` email with retries · `db.js` SQLite ·
`public/` styles and page scripts.
