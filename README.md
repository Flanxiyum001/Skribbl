# 🎨 DoodleDash — multiplayer drawing & guessing

An original, private-room drawing game inspired by the familiar **draw-and-guess** party-game format. Built for quick browser-based games with friends. No accounts or database setup required.

## What works

- Create a private 6-character room and share its invite link
- Up to 12 players; live synchronized drawing over WebSockets
- Server-authoritative rounds, secret words and validated guesses
- 3 word choices for the artist, timed turns, letter hints, scoring and leaderboard
- Colors, brush sizes, eraser, clear canvas, chat and auto-reconnect
- Mobile and desktop layouts; automatically selected new host when the host leaves
- Game-state persistence across server hibernation using Cloudflare Durable Objects

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run check
npm run dev
```

Open the localhost URL shown by Wrangler. To test multiplayer, open the site in two **separate browser tabs** with different nicknames. Create a room in the first tab, then use its invite link in the second tab. (Each tab gets its own session token.)

## Deploy for free on Cloudflare Workers

1. Create a free account at https://dash.cloudflare.com/ and verify your email.
2. Install project dependencies with `npm install`.
3. Run `npx wrangler login` to authenticate with Cloudflare.
4. Run `npm run deploy`. Approve the `doodledash-office` Worker name and Durable Object migration if prompted.
5. Wrangler prints the public URL, usually `https://doodledash-office.<your-subdomain>.workers.dev`. Visit it and create a room.
6. Send the room's shareable URL to friends. Everyone opens the same website; no installation needed.

**Important:** This uses **Workers Static Assets** and a **SQLite-backed Durable Object**, which Cloudflare currently supports on its Workers Free plan subject to usage quotas. See https://developers.cloudflare.com/durable-objects/platform/pricing/.

The repo does **not** publish automatically when you push to GitHub. To deploy from GitHub automatically, configure a Cloudflare Worker Git integration in the Cloudflare dashboard with the deploy command `npx wrangler deploy` (and install dependencies first).

### GitHub Pages?

GitHub Pages hosts static files only; it cannot run this game's room server or WebSocket coordination. You *can* host the HTML/CSS/JS on Pages, but you'd still need a separately deployed backend and would need to change the client WebSocket/API URLs and CORS/origin policy. The simplest, most reliable setup is a **single Cloudflare Worker URL** for both front end and real-time game server.

### Office firewall/network restrictions

Use this only if your workplace allows personal games and access to the hosting domain. HTTPS doesn't guarantee that a corporate firewall, proxy or browser policy will permit WebSockets. Do not try to evade company network controls; check with IT or play using a permitted network/device.

## Architecture

`public/` contains the browser game. `src/index.js` routes HTTPS and WebSocket requests. `src/room.js` implements a single-authority game state machine per room using a Cloudflare Durable Object. `src/words.js` contains the word list and guess utilities.

All secret words and guesses are checked by the server. The host controls round count and drawing time. Reconnect uses a random per-tab secret token saved in session storage. No chat logs or player profiles are sent to external analytics services; game room history is stored temporarily in Cloudflare Durable Object storage.

## Current limitations

- English words only, no login or moderation UI, no custom word packs.
- Anyone with the invite link can join; it is not password-protected.
- History persists in Durable Object storage and is not auto-deleted; do not post sensitive information.
- If an active artist leaves, their turn is skipped. This is a lightweight party game, not a competitive anti-cheat platform.
