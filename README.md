# peerbox

Peer-to-peer chat, voice calls, video calls, and file sharing — directly
between browsers. No accounts, no server-side database, and now, no
local storage of any kind either. Walkie-talkie model: use it live,
close the tab, everything is gone. See `PRIVACY.md` for the full
plain-language breakdown, and `LICENSE` (AGPL-3.0) for the license.

## Run it locally
Open `index.html` in a browser, or serve the folder with any static
file server (e.g. `npx serve .`). Open it in a second tab/device, swap
IDs, connect. All third-party libraries (PeerJS, Mammoth, SheetJS) are
vendored in `/vendor` — nothing loads from a CDN at runtime.

## Deploy it (so it works on phones too)
Camera/mic access requires **HTTPS** on mobile browsers. Free static
hosts that give you HTTPS automatically: Vercel, Netlify, GitHub Pages,
Cloudflare Pages. Single static folder, no build step, no backend.

## IP hiding
All connections are forced through a TURN relay (`iceTransportPolicy:
'relay'`), so neither side ever sees the other's real IP. Currently
using the free Open Relay Project TURN servers. The relay operator can
see connection metadata (two IDs talking, roughly how much data) but
not the encrypted content. Full anonymity beyond this would need Tor
routing — a bigger, slower change, not done here.

**Note on connection stability:** the free public relay can be flaky
under load (this is likely what caused the dropped iPhone test
session). `app.js` now auto-retries a dropped connection up to 3 times
with backoff. A self-hosted `coturn` server removes this dependency
entirely once it's worth the ~$5/month.

## Self-hosting your own TURN server
Rent a small VPS (DigitalOcean, Hetzner, ~$4-6/mo), install `coturn`
(open source), and replace `ICE_CONFIG` in `app.js` with your server's
address and credentials. This removes reliance on the free public
relay and gives you full control over that piece of infrastructure.

## Security hardening in this build
- **XSS-safe rendering** — all data from a remote peer (file names,
  chat text) is inserted via DOM properties (`textContent`, `.src`,
  `.alt`), never via `innerHTML` string concatenation, which is the
  classic hole that lets a malicious file name execute script.
- **Vendored dependencies** — PeerJS, Mammoth, and SheetJS are bundled
  locally in `/vendor` instead of loaded from a CDN, removing the risk
  of a compromised or MITM'd CDN injecting malicious code.
- **High-entropy, CSPRNG-generated IDs** — 12 characters from a 32-char
  alphabet (~10^18 combinations), generated with `crypto.getRandomValues`
  rather than `Math.random()`, making brute-force guessing infeasible.
- **One-peer-at-a-time** — unsolicited extra connection attempts are
  refused outright; calls are only accepted from the already-connected
  peer.
- **File size limits** — warns above 150MB, hard-refuses above 500MB
  (both sending and receiving) to prevent a browser tab from crashing
  on large transfers.
- **Bounds-checked file transfer** — chunk indices and declared sizes
  from the *sending* peer are validated before any memory is allocated,
  closing a basic memory-exhaustion path.
- **Auto-reconnect** — a dropped data connection retries up to 3 times
  with backoff instead of just dying.

**What this does *not* claim:** no software is unhackable. This closes
every concrete hole identified so far. It does not defend against a
compromised or physically-accessed device, a malicious browser
extension with broad permissions, or a state-level adversary — no
client-side app can.

## What "view every file format" currently means
Browsers/libraries here can render: images, video, audio, PDF, plain
text, docx, xlsx, csv. Everything else falls back to a direct download
link. Extending this further means adding a renderer per format.

## Status
Working: text chat, voice calls, video calls, file transfer, inline
viewing for images/video/audio/pdf/text/docx/xlsx/csv, IP hiding via
forced TURN relay, "wipe & disconnect" reset, zero storage of any kind,
security hardening listed above.
Not yet built: self-hosted TURN server (guidance above, not yet
deployed), multi-peer rooms, previews for less common file formats.
