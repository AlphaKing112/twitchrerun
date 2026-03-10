# Twitch Rerun Manager 🎮

A self-hosted Twitch VOD rerun system built with **Hono + Cloudflare Pages + KV**. Play your old VODs on loop through OBS with a VLC source, complete with live overlays and automatic stream category updates.

## Features

- 📺 **VOD Playlist** — Add Twitch VOD URLs, auto-resolves stream URLs for VLC
- ✅ **Enable/Disable VODs** — Toggle individual VODs without deleting them
- 🎮 **OBS Remote Control** — Play, pause, stop, next, previous, shuffle via WebSocket
- 🔄 **Auto Category Update** — Automatically updates your Twitch stream category when a new VOD starts
- 📊 **Follower & Sub Overlays** — Live browser source overlays with progress bars and goals
- ❤️ **Recent Followers Ticker** — Scrolling marquee of your latest followers
- 🎨 **Fully Customizable** — Colors, sizes, scroll speed, follower count — all from the dashboard

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

### 4. Build & Deploy

```bash
npm run build
npx wrangler pages deploy .next --project-name your-project-name
```

### 5. Set Up the Dashboard

1. Open your deployed URL
2. Connect to OBS WebSocket (Tools → WebSocket Server Settings in OBS)
3. Go to **Twitch Overlays** and enter your User Access Token

### Getting a Twitch Token

Go to [twitchtokengenerator.com](https://twitchtokengenerator.com/) and generate a token with these scopes:

- `moderator:read:followers` — for follower count & recent followers
- `channel:read:subscriptions` — for subscriber count
- `channel:manage:broadcast` — for auto category updates

### Adding Overlays to OBS

Copy the overlay URLs from the dashboard and add them as **Browser Sources** in OBS:

| Overlay                 | Recommended Size |
| ----------------------- | ---------------- |
| Followers               | 300 × 80         |
| Subscribers             | 300 × 80         |
| Recent Followers Ticker | 1200 × 50        |

## Local Development

```bash
# Run Next.js dev server (UI only)
npm run dev

# Run with Cloudflare Workers runtime (full local test)
npx wrangler pages dev .next
```

## Tech Stack

- [Hono](https://hono.dev/) — Lightweight web framework for Cloudflare Workers
- [Next.js](https://nextjs.org/) — Frontend build tool
- [@cloudflare/next-on-pages](https://github.com/cloudflare/next-on-pages) — Adapter
- [Cloudflare KV](https://developers.cloudflare.com/kv/) — Persistent storage
- [obs-websocket-js](https://github.com/obs-websocket-community-projects/obs-websocket-js) — OBS remote control
