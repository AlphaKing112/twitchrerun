import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

const app = new Hono<{ Bindings: { RERUN_STORE: KVNamespace } }>();

// API: Get VODs
app.get('/api/vods', async (c) => {
  const vodData = await c.env.RERUN_STORE.get('vod_list');
  const vods = vodData ? JSON.parse(vodData) : [];
  return c.json(vods);
});

// API: Add VOD
app.post('/api/vods', async (c) => {
  const { vodId, title } = await c.req.json();
  if (!vodId) return c.json({ error: 'VOD ID is required' }, 400);

  const vodData = await c.env.RERUN_STORE.get('vod_list');
  const vods = vodData ? JSON.parse(vodData) : [];

  if (!vods.some((v: any) => v.id === vodId)) {
    vods.push({ id: vodId, title: title || `VOD ${vodId}`, addedAt: new Date().toISOString() });
    await c.env.RERUN_STORE.put('vod_list', JSON.stringify(vods));
  }

  return c.json(vods);
});

// API: Delete VOD
app.delete('/api/vods', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'ID is required' }, 400);

  const vodData = await c.env.RERUN_STORE.get('vod_list');
  let vods = vodData ? JSON.parse(vodData) : [];
  vods = vods.filter((v: any) => v.id !== id);
  
  await c.env.RERUN_STORE.put('vod_list', JSON.stringify(vods));
  return c.json(vods);
});

// API: M3U Playlist
app.get('/api/playlist', async (c) => {
  const vodData = await c.env.RERUN_STORE.get('vod_list');
  const vods = vodData ? JSON.parse(vodData) : [];

  if (vods.length === 0) {
    return c.text('#EXTM3U\n', { headers: { 'Content-Type': 'audio/x-mpegurl' } });
  }

  const GQL_URL = 'https://gql.twitch.tv/gql';
  const CLIENT_ID = 'kimne78kx3ncx6brs4s58wrn98p417';

  const resolvedVods = await Promise.all(
    vods.map(async (vod: any) => {
      try {
        const response = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
          body: JSON.stringify([{
            operationName: 'PlaybackAccessToken',
            extensions: { persistedQuery: { version: 1, sha256Hash: '0828119ded1c13477966434e15800ff57dd2a3933f122117185573f5d51bcbbd' } },
            variables: { isLive: false, login: '', isVod: true, vodID: vod.id, playerType: 'embed' },
          }]),
        });
        const data = (await response.json()) as any;
        const tokenData = data[0]?.data?.videoPlaybackAccessToken;
        if (!tokenData) return null;

        const { value: token, signature: sig } = tokenData;
        const streamUrl = `https://usher.ttvnw.net/vod/${vod.id}.m3u8?nauthor=twitch&allow_source=true&player=twitchweb&playlist_include_framerate=true&reassignments_supported=true&sig=${sig}&token=${encodeURIComponent(token)}`;
        return { title: vod.title, streamUrl };
      } catch (e) { return null; }
    })
  );

  let m3u = '#EXTM3U\n';
  for (const v of resolvedVods) {
    if (v) m3u += `#EXTINF:-1,${v.title}\n${v.streamUrl}\n`;
  }

  return c.text(m3u, {
    headers: {
      'Content-Type': 'audio/x-mpegurl',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// Serve the Frontend UI (HTML/CSS)
app.get('/', (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Twitch Rerun Manager</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --background: #0a0a0c;
            --foreground: #f0f0f5;
            --primary: #9146ff;
            --primary-hover: #7b2df5;
            --surface: #18181b;
            --border: #3f3f46;
            --glass: rgba(24, 24, 27, 0.8);
            --glass-border: rgba(255, 255, 255, 0.1);
        }
        * { box-sizing: border-box; padding: 0; margin: 0; }
        body {
            background: var(--background);
            color: var(--foreground);
            font-family: 'Outfit', sans-serif;
            min-height: 100vh;
            background-image: radial-gradient(circle at 0% 0%, rgba(145, 70, 255, 0.1) 0%, transparent 50%), radial-gradient(circle at 100% 100%, rgba(145, 70, 255, 0.1) 0%, transparent 50%);
            display: flex; justify-content: center; padding: 2rem;
        }
        .container { max-width: 800px; width: 100%; }
        header { text-align: center; margin-bottom: 3rem; }
        h1 { font-size: 3rem; font-weight: 800; background: linear-gradient(to right, #9146ff, #d49aff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }
        .subtitle { color: #a1a1aa; font-size: 1.1rem; }
        .card { background: var(--glass); backdrop-filter: blur(12px); border: 1px solid var(--glass-border); border-radius: 1.5rem; padding: 2rem; box-shadow: 0 10px 30px rgba(0,0,0,0.5); margin-bottom: 2rem; }
        .input-group { display: flex; gap: 1rem; margin-bottom: 2rem; }
        input { flex: 1; background: #121214; border: 1px solid var(--border); border-radius: 0.75rem; padding: 1rem; color: white; font-size: 1rem; transition: 0.2s; }
        input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px rgba(145, 70, 255, 0.2); }
        button { cursor: pointer; border: none; border-radius: 0.75rem; padding: 1rem 2rem; font-size: 1rem; font-weight: 600; transition: 0.2s; background: var(--primary); color: white; }
        button:hover { background: var(--primary-hover); transform: translateY(-1px); }
        button.secondary { background: #27272a; padding: 0.5rem 1rem; font-size: 0.8rem; }
        button.danger { background: rgba(235, 4, 0, 0.1); color: #ef4444; padding: 0.5rem; display: flex; align-items: center; }
        .vod-item { display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: #18181b; border: 1px solid var(--border); border-radius: 1rem; margin-bottom: 0.75rem; }
        .playlist-url { background: rgba(145, 70, 255, 0.05); border: 1px dashed var(--primary); padding: 1rem; border-radius: 0.75rem; display: flex; justify-content: space-between; align-items: center; margin-top: 1rem; overflow: hidden; }
        code { color: #d49aff; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 1rem; }
        .empty { text-align: center; padding: 3rem; color: #71717a; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Rerun Manager</h1>
            <p class="subtitle">Twitch VOD to OBS VLC Playlist</p>
        </header>

        <section class="card">
            <div class="input-group">
                <input type="text" id="vodInput" placeholder="Twitch VOD URL or ID">
                <button onclick="addVod()">Add VOD</button>
            </div>
            
            <div id="vodList"></div>
            
            <div id="playlistSection" style="display:none; margin-top: 2rem;">
                <p style="font-size: 0.9rem; color: #a1a1aa; margin-bottom: 0.5rem;">OBS VLC Source URL:</p>
                <div class="playlist-url">
                    <code id="playlistUrl"></code>
                    <button class="secondary" onclick="copyUrl()">Copy</button>
                </div>
            </div>
        </section>
    </div>

    <script>
        const input = document.getElementById('vodInput');
        const list = document.getElementById('vodList');
        const playlistSection = document.getElementById('playlistSection');
        const playlistUrl = document.getElementById('playlistUrl');

        async function loadVods() {
            const res = await fetch('/api/vods');
            const vods = await res.json();
            renderVods(vods);
        }

        function renderVods(vods) {
            if (vods.length === 0) {
                list.innerHTML = '<div class="empty">No VODs added yet.</div>';
                playlistSection.style.display = 'none';
                return;
            }
            
            playlistSection.style.display = 'block';
            playlistUrl.innerText = window.location.origin + '/api/playlist';
            
            list.innerHTML = vods.map(v => \`
                <div class="vod-item">
                    <div>
                        <div style="font-weight:600">\${v.title}</div>
                        <div style="font-size:0.8rem; color:#71717a">ID: \${v.id}</div>
                    </div>
                    <button class="danger" onclick="deleteVod('\${v.id}')">Remove</button>
                </div>
            \`).join('');
        }

        async function addVod() {
            const val = input.value;
            const match = val.match(/(?:\\/videos\\/|v=)(\\d+)/);
            const vodId = match ? match[1] : val.match(/^\\d+$/) ? val : null;
            
            if (!vodId) return alert('Invalid Twitch URL');
            
            const res = await fetch('/api/vods', {
                method: 'POST',
                body: JSON.stringify({ vodId }),
                headers: { 'Content-Type': 'application/json' }
            });
            input.value = '';
            renderVods(await res.json());
        }

        async function deleteVod(id) {
            const res = await fetch('/api/vods?id=' + id, { method: 'DELETE' });
            renderVods(await res.json());
        }

        function copyUrl() {
            navigator.clipboard.writeText(playlistUrl.innerText);
            alert('Copied to clipboard!');
        }

        loadVods();
    </script>
</body>
</html>
  `);
});

export default app;
