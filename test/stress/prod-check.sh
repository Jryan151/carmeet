#!/usr/bin/env bash
# Section 9 — production, read-only and light (one request a second, about 30 requests in all).
# Run from your own computer (this sandbox's network can't reach azmonarchy.com):
#   bash test/stress/prod-check.sh [azmonarchy.com] [/a-meet-page]
# Checks TLS and redirects (apex, www, http), compression, cache headers on /static and /uploads, page weight of /
# and a meet page, and time to first byte. Nothing is written; no forms are sent.
set -u
D="${1:-azmonarchy.com}"
MEET="${2:-}"
pause() { sleep 1; }
hr() { printf '\n== %s\n' "$1"; }

hr "TLS: certificate and protocol (apex and www)"
for h in "$D" "www.$D"; do
  echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null | sed "s/^/$h  /"
  curl -sS -o /dev/null -w "$h  http=%{http_version} tls=%{ssl_verify_result}(0=ok)\n" "https://$h/"; pause
done

hr "Redirects (http → https, www → apex?)"
for u in "http://$D/" "http://www.$D/" "https://www.$D/"; do
  curl -sS -o /dev/null -w "$u → %{http_code} %{redirect_url}\n" "$u"; pause
done
echo "HSTS: $(curl -sSI "https://$D/" | grep -i '^strict-transport-security' || echo 'none')"; pause

hr "Compression (a page, a script, the portal's script)"
for p in "/" "/static/site.js" "/static/portal.js" "/members"; do
  curl -sS -o /dev/null -D - -H 'Accept-Encoding: zstd, br, gzip' "https://$D$p" | grep -iE '^(content-encoding|content-length|vary|cache-control|content-type)' | sed "s|^|$p  |"; pause
done

hr "Cache headers on /static and /uploads"
V=$(curl -sS "https://$D/" | grep -o '/static/[a-z]*\.js?v=[a-z0-9]*' | head -1); pause
[ -n "$V" ] && curl -sSI "https://$D$V" | grep -iE '^(cache-control|etag|last-modified)' | sed "s|^|$V  |"; pause
IMG=$(curl -sS "https://$D/" | grep -o '/uploads/[A-Za-z0-9._-]*\.webp' | head -1); pause
[ -n "$IMG" ] && curl -sSI "https://$D$IMG" | grep -iE '^(cache-control|content-type|content-length|etag)' | sed "s|^|$IMG  |"; pause
curl -sSI "https://$D/sw.js" | grep -iE '^(cache-control|service-worker-allowed)' | sed 's|^|/sw.js  |'; pause

hr "Page weight and time to first byte (5 tries each)"
for p in "/" ${MEET:+"$MEET"}; do
  for i in 1 2 3 4 5; do
    curl -sS -o /dev/null -H 'Accept-Encoding: gzip, br' -w "$p  ttfb=%{time_starttransfer}s total=%{time_total}s bytes_on_wire=%{size_download} tls=%{time_appconnect}s\n" "https://$D$p"; pause
  done
done
echo; echo "Uncompressed size of /: $(curl -sS "https://$D/" | wc -c) bytes"
