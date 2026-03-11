# Twitch Rerun Manager 🎮

A self-hosted Twitch VOD rerun system built entirely with **Hono + Cloudflare Pages + KV**. Play your old VODs on loop through OBS with a VLC source, complete with live overlays and automatic stream category updates. No React or Next.js required.

## Features

- 📺 **VOD Playlist** — Add Twitch VOD URLs, auto-resolves stream URLs for VLC
- ✅ **Enable/Disable VODs** — Toggle individual VODs without deleting them
- 🎮 **OBS Remote Control** — Play, pause, stop, next, previous, shuffle via WebSocket over Local or Remote tunnels.
- 🔄 **Auto Category Update** — Automatically updates your Twitch stream category when a new VOD starts
- ⏳ **Countdown Overlay** — Dynamic "Going Live" countdown timer
- 📊 **Follower & Sub Overlays** — Live browser source overlays with customizable progress bars and goals
- ❤️ **Recent Followers Ticker** — Scrolling marquee of your latest followers
- 🎨 **Fully Customizable** — Colors, sizes, timezones, scroll speed, follower count — all visually configurable from the dashboard.

## Deploy Your Own (Cloudflare Pages)

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Cloudflare account](https://dash.cloudflare.com/) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`

### 2. Clone & Install

```bash
git clone https://github.com/AlphaKing112/twitchrerun.git
cd twitchrerun
npm install
```

### 3. Create a KV Namespace

```bash
wrangler kv namespace create RERUN_STORE
```

Copy the `id` from the output and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "RERUN_STORE"
id = "YOUR_KV_ID_HERE"
```

### 4. Deploy

```bash
# Deploys directly to Cloudflare Pages without compiling
npm run deploy
```

### 5. Set Up the Dashboard

1. Open your deployed URL.
2. Connect to OBS WebSocket (Tools → WebSocket Server Settings in OBS).
3. Go to **Twitch Access** and enter your User Access Token.

### Getting a Twitch Token

Go to [twitchtokengenerator.com](https://twitchtokengenerator.com/) and generate a **Custom Bot Token** (or User Token) with these specific scopes required for the dashboard features:

- `moderator:read:followers` — Required for follower count & recent followers lists
- `channel:read:subscriptions` — Required for subscriber counts
- `channel:manage:broadcast` — Required for auto category updates when a new rerun starts

### Adding Overlays to OBS

Copy the overlay URLs from the dashboard and add them as **Browser Sources** in OBS:

| Overlay                 | Recommended Size |
| ----------------------- | ---------------- |
| Followers Goal          | 280 × 80         |
| Subscribers Goal        | 280 × 80         |
| Recent Followers Ticker | 1200 × 60        |
| Countdown Timer         | 800 × 120        |

## Local Development & Testing

Since this project has been streamlined from Next.js to pure Cloudflare Pages functions, local development is instantaneous.

```bash
# Run with Cloudflare Workers runtime (full local test with KV emulation)
npm run dev
```

## Tech Stack

- [Hono](https://hono.dev/) — Lightweight web framework powering the backend routes and HTML injection.
- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/) — Serverless edge hosting.
- [Cloudflare KV](https://developers.cloudflare.com/kv/) — Persistent key-value storage for dashboard settings and playlists.
- [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) — Browser-side OBS remote control over WebSockets.
