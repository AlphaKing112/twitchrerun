# Twitch Rerun Manager

A modern web dashboard to manage a playlist of Twitch VODs for OBS VLC Video Source. Direct stream resolution ensures your reruns play smoothly in OBS without ads or browser overlays.

## Features

- **Easy Management**: Add/Remove Twitch VODs via URL.
- **Auto-Resolution**: Automatically resolves Twitch VODs to direct `.m3u8` stream URLs.
- **OBS Ready**: Generates an M3U playlist URL compatible with OBS VLC Video Source.
- **Cloud Powered**: Built for Cloudflare Pages + KV for high availability.

## Setup & Deployment

### 1. Cloudflare Configuration

1.  Initialize a new Cloudflare Pages project pointing to this repo.
2.  Create a **KV Namespace** named `RERUN_STORE`.
3.  Bind the KV Namespace to your Pages project with the variable name `RERUN_STORE`.

### 2. Deployment

Run the following to deploy:

```bash
npm run build
npx wrangler pages deploy .next
```

## Usage in OBS

1.  Open **OBS Studio**.
2.  Add a new source: **VLC Video Source**.
3.  Give it a name (e.g., "Twitch Rerun").
4.  In the **Playlist** section, click **+** and select **Add Path/URL**.
5.  Paste your deployment URL followed by `/api/playlist`:
    `https://your-app.pages.dev/api/playlist`
6.  Set **Loop Playlist** and **Shuffle** as desired.

## Development

```bash
npm run dev
```

Note: To use KV locally with `next-on-pages`, you may need to use `wrangler pages dev`.
