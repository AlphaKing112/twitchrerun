import { Hono } from 'hono';
import { handle } from 'hono/cloudflare-pages';

const app = new Hono<{ Bindings: { RERUN_STORE: KVNamespace; TWITCH_CLIENT_ID: string; TWITCH_CLIENT_SECRET: string; } }>();

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
    let finalTitle = title || `VOD ${vodId}`;
    let author = 'Unknown';
    let thumbnailUrl = '';
    let duration = '';

    try {
      // Check both storage locations for a token
      const statsData = await c.env.RERUN_STORE.get('_twitch_stats_settings');
      const stats = statsData ? JSON.parse(statsData) : null;
      const rawAuth = await c.env.RERUN_STORE.get('_twitch_token');
      const auth = rawAuth ? JSON.parse(rawAuth) : null;

      const token = stats?.token || auth?.token;
      const clientId = stats?.clientId || auth?.clientId || 'ue6666qo983tsx6so1t0vnawi233wa';

      const headers: Record<string, string> = { 'Client-ID': clientId };
      if (token) headers['Authorization'] = `Bearer ${token.replace('oauth:', '')}`;

      const videoRes = await fetch(`https://api.twitch.tv/helix/videos?id=${vodId}`, { headers });
      const videoData = (await videoRes.json()) as any;
      const v = videoData.data?.[0];
      if (v) {
        finalTitle = v.title;
        author = v.user_name;
        thumbnailUrl = (v.thumbnail_url || '').replace('%{width}', '320').replace('%{height}', '180');
        duration = v.duration || '';
      }
    } catch (e) {
      console.error('Enrichment error:', e);
    }

    vods.push({ 
      id: vodId, 
      title: finalTitle, 
      author, 
      thumbnailUrl,
      duration,
      enabled: true,
      addedAt: new Date().toISOString()
    });
    
    await c.env.RERUN_STORE.put('vod_list', JSON.stringify(vods));
  }

  return c.json(vods);
});

// API: Clear All
app.post('/api/vods/clear', async (c) => {
  await c.env.RERUN_STORE.put('vod_list', JSON.stringify([]));
  return c.json([]);
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

// API: Toggle VOD Status
app.post('/api/vods/toggle', async (c) => {
  const { id, enabled } = await c.req.json();
  const vodData = await c.env.RERUN_STORE.get('vod_list');
  let vods = vodData ? JSON.parse(vodData) : [];
  vods = vods.map((v: any) => v.id === id ? { ...v, enabled } : v);
  await c.env.RERUN_STORE.put('vod_list', JSON.stringify(vods));
  return c.json(vods);
});

async function getResolvedVods(env: any) {
  const vodData = await env.RERUN_STORE.get('vod_list');
  const vods = vodData ? JSON.parse(vodData) : [];

  if (vods.length === 0) return [];

  const settingsData = await env.RERUN_STORE.get('_twitch_stats_settings');
  const settings = settingsData ? JSON.parse(settingsData) : null;
  
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const PUBLIC_CLIENT_ID = 'ue6666qo983tsx6so1t0vnawi233wa';

  return Promise.all(
    vods.map(async (vod: any) => {
      try {
        const query = `query { videoPlaybackAccessToken(id: "${vod.id}", params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }) { value signature } }`;
        
        // Strategy 1: Try with user token if available
        if (settings?.token && settings?.clientId) {
          try {
            const cleanToken = settings.token.replace('oauth:', '');
            const resp = await fetch(GQL_URL, {
              method: 'POST',
              headers: { 
                'Client-Id': settings.clientId, 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cleanToken}`
              },
              body: JSON.stringify({ query }),
            });
            const result = await resp.json() as any;
            if (result?.data?.videoPlaybackAccessToken) {
              const { value, signature } = result.data.videoPlaybackAccessToken;
              return { ...vod, streamUrl: `https://usher.ttvnw.net/vod/${vod.id}.m3u8?nauthor=twitch&allow_source=true&player=twitchweb&playlist_include_framerate=true&reassignments_supported=true&sig=${signature}&token=${encodeURIComponent(value)}` };
            }
          } catch (e) {}
        }

        // Strategy 2: Fallback to public resolution
        const response = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'Client-Id': PUBLIC_CLIENT_ID, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        const result = (await response.json()) as any;
        const tokenData = result?.data?.videoPlaybackAccessToken;
        
        if (!tokenData || !tokenData.value || !tokenData.signature) {
          const errMsg = result?.message || result?.errors?.[0]?.message || 'No stream access';
          return { ...vod, error: `Stream Error: ${errMsg}` };
        }

        const { value: token, signature: sig } = tokenData;
        const streamUrl = `https://usher.ttvnw.net/vod/${vod.id}.m3u8?nauthor=twitch&allow_source=true&player=twitchweb&playlist_include_framerate=true&reassignments_supported=true&sig=${sig}&token=${encodeURIComponent(token)}`;
        return { ...vod, streamUrl };
      } catch (e: any) { 
        return { ...vod, error: `Fetch Error: ${e.message}` };
      }
    })
  );
}

// API: JSON Playlist
app.get('/api/playlist.json', async (c) => {
  const resolved = await getResolvedVods(c.env);
  return c.json(resolved.filter((v: any) => v.enabled !== false));
});

// API: M3U Playlist
app.get('/api/playlist', async (c) => {
  let resolved = await getResolvedVods(c.env);
  const shouldShuffle = c.req.query('shuffle') === 'true';

  if (shouldShuffle && resolved.length > 0) {
    resolved = [...resolved].sort(() => Math.random() - 0.5);
  }

  if (resolved.length === 0) {
    return c.text('#EXTM3U\n# No VODs in list\n', { headers: { 'Content-Type': 'audio/x-mpegurl' } });
  }

  let m3u = '#EXTM3U\n';
  for (const v of resolved) {
    if (v && v.streamUrl && v.enabled !== false) {
      m3u += `#EXTINF:-1,${v.title}\n${v.streamUrl}\n`;
    } else if (v && v.error && v.enabled !== false) {
      m3u += `# DEBUG ERROR: ${v.error}\n`;
    }
  }

  return c.text(m3u, {
    headers: {
      'Content-Type': 'audio/x-mpegurl',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// API: Save Twitch Stats Settings
app.post('/api/twitch/stats/settings', async (c) => {
  const body = await c.req.json();
  const { token, followerGoal, subGoal, followerColor, subColor, labelSize, valueSize, goalSize } = body;
  
  const existingData = await c.env.RERUN_STORE.get('_twitch_stats_settings');
  const existing = existingData ? JSON.parse(existingData) : null;

  let broadcasterId = existing?.broadcasterId;
  let username = existing?.username;
  let clientId = existing?.clientId;
  let cleanToken = existing?.token;

  // Handle new token validation
  if (token) {
    cleanToken = token.replace('oauth:', '');
    try {
      const valRes = await fetch('https://id.twitch.tv/oauth2/validate', {
        headers: { 'Authorization': `OAuth ${cleanToken}` }
      });
      
      if (!valRes.ok) {
        const errorData = await valRes.json() as any;
        return c.json({ error: 'Twitch Token Error: ' + (errorData.message || 'Invalid token') }, 401);
      }

      const valData = await valRes.json() as any;
      broadcasterId = valData.user_id;
      username = valData.login;
      clientId = valData.client_id;
    } catch (e: any) {
      return c.json({ error: 'Connection Error: ' + e.message }, 500);
    }
  }

  if (!cleanToken) return c.json({ error: 'Access token is required' }, 400);

  // Save updated settings
  await c.env.RERUN_STORE.put('_twitch_stats_settings', JSON.stringify({ 
    broadcasterId, 
    token: cleanToken, 
    username,
    clientId,
    followerGoal: followerGoal !== undefined ? followerGoal : existing?.followerGoal,
    subGoal: subGoal !== undefined ? subGoal : existing?.subGoal,
    followerColor: followerColor || existing?.followerColor || '#9146ff',
    subColor: subColor || existing?.subColor || '#d49aff',
    followerTextColor: body.followerTextColor || existing?.followerTextColor || '#a1a1aa',
    subTextColor: body.subTextColor || existing?.subTextColor || '#a1a1aa',
    labelSize: labelSize || existing?.labelSize || 16,
    valueSize: valueSize || existing?.valueSize || 38,
    goalSize: goalSize || existing?.goalSize || 22,
    scrollSpeed: body.scrollSpeed || existing?.scrollSpeed || 15,
    followerCount: body.followerCount || existing?.followerCount || 10,
    pollingInterval: body.pollingInterval || existing?.pollingInterval || 30,
    liveTimer: body.liveTimer || existing?.liveTimer || '',
    liveTimerLabel: body.liveTimerLabel || existing?.liveTimerLabel || 'NEXT LIVE STREAM',
    liveTimerTZ: body.liveTimerTZ || existing?.liveTimerTZ || 'local',
    timerColor: body.timerColor || existing?.timerColor || '#ffffff',
    timerLabelColor: body.timerLabelColor || existing?.timerLabelColor || '#9146ff',
    timerSize: body.timerSize || existing?.timerSize || 52,
    timerLabelSize: body.timerLabelSize || existing?.timerLabelSize || 18
  }));

  return c.json({ success: true, username, broadcasterId });
});

// API: Get Saved Stats Settings
app.get('/api/twitch/stats/settings', async (c) => {
  const data = await c.env.RERUN_STORE.get('_twitch_stats_settings');
  if (!data) return c.json(null);
  const settings = JSON.parse(data);
  // Mask token for safety but return other fields
  return c.json({
    username: settings.username,
    followerGoal: settings.followerGoal || '',
    subGoal: settings.subGoal || '',
    followerColor: settings.followerColor || '#9146ff',
    subColor: settings.subColor || '#d49aff',
    followerTextColor: settings.followerTextColor || '#a1a1aa',
    subTextColor: settings.subTextColor || '#a1a1aa',
    labelSize: settings.labelSize || 16,
    valueSize: settings.valueSize || 38,
    goalSize: settings.goalSize || 22,
    scrollSpeed: settings.scrollSpeed || 15,
    followerCount: settings.followerCount || 10,
    pollingInterval: settings.pollingInterval || 30,
    liveTimer: settings.liveTimer || '',
    liveTimerLabel: settings.liveTimerLabel || 'NEXT LIVE STREAM',
    liveTimerTZ: settings.liveTimerTZ || 'local',
    timerColor: settings.timerColor || '#ffffff',
    timerLabelColor: settings.timerLabelColor || '#9146ff',
    timerSize: settings.timerSize || 52,
    hasToken: !!settings.token,
    obsAddress: settings.obsAddress || 'localhost:44555',
    obsPassword: settings.obsPassword || '',
    obsSourceName: settings.obsSourceName || 'twitchreruns',
    obsMode: settings.obsMode || 'local'
  });
});

// API: Save OBS Settings
app.post('/api/obs/settings', async (c) => {
  const { address, password, sourceName, mode } = await c.req.json();
  const data = await c.env.RERUN_STORE.get('_twitch_stats_settings');
  const settings = data ? JSON.parse(data) : {};
  
  await c.env.RERUN_STORE.put('_twitch_stats_settings', JSON.stringify({
    ...settings,
    obsAddress: address,
    obsPassword: password,
    obsSourceName: sourceName,
    obsMode: mode || 'local'
  }));
  
  return c.json({ success: true });
});

// API: Get Twitch Stats (Followers & Subs)
app.get('/api/stats', async (c) => {
  const settingsData = await c.env.RERUN_STORE.get('_twitch_stats_settings');
  if (!settingsData) return c.json({ error: 'Stats not configured' });
  
  const settings = JSON.parse(settingsData);
  const { broadcasterId, token, clientId, followerGoal, subGoal } = settings;

  try {
    const [followRes, subRes] = await Promise.all([
      fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${broadcasterId}`, {
        headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` }
      }),
      fetch(`https://api.twitch.tv/helix/subscriptions?broadcaster_id=${broadcasterId}`, {
        headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` }
      })
    ]);

    const fData = await followRes.json() as any;
    const sData = await subRes.json() as any;

    return c.json({
      followers: fData.total || 0,
      subs: sData.total || 0,
      followerGoal: followerGoal || null,
      subGoal: subGoal || null,
      followerColor: settings.followerColor || '#9146ff',
      subColor: settings.subColor || '#d49aff',
      followerTextColor: settings.followerTextColor || '#a1a1aa',
      subTextColor: settings.subTextColor || '#a1a1aa',
      labelSize: settings.labelSize || 16,
      valueSize: settings.valueSize || 38,
      goalSize: settings.goalSize || 22,
      pollingInterval: settings.pollingInterval || 30
    });
  } catch(e) { return c.json({ error: true }); }
});

// API: Update Twitch Category
app.post('/api/twitch/update-category', async (c) => {
  const { vodId } = await c.req.json();
  const settingsData = await c.env.RERUN_STORE.get('_twitch_stats_settings');
  if (!settingsData) return c.json({ error: 'No settings configured' }, 400);
  
  const settings = JSON.parse(settingsData);
  if (!settings.token || !settings.broadcasterId || !settings.clientId) {
    return c.json({ error: 'Missing tokens' }, 400);
  }

  const cleanToken = settings.token.replace('oauth:', '');
  const publicClient = 'ue6666qo983tsx6so1t0vnawi233wa';

  try {
    // 1. Fetch the Game/Category of the VOD using GQL (safest way to get game without extra scopes)
    const gqlRes = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': publicClient },
      body: JSON.stringify({ query: `query { video(id: "${vodId}") { game { id name } } }` })
    });

    const gqlData = await gqlRes.json() as any;
    const game = gqlData?.data?.video?.game;

    if (!game || !game.id) {
      return c.json({ error: 'Could not find a category for this VOD' }, 404);
    }

    // 2. Patch the Broadcaster's Channel Info with the new game_id
    const patchRes = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${settings.broadcasterId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
        'Client-Id': settings.clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ game_id: game.id })
    });

    if (!patchRes.ok) {
      const err = await patchRes.json() as any;
      console.error('Twitch category update failing:', err);
      // Wait, patching requires `channel:manage:broadcast` scope.
      return c.json({ error: `Update failed: ${err.message || 'Check channel:manage:broadcast scope'}` }, patchRes.status as any);
    }

    return c.json({ success: true, gameName: game.name });
  } catch(e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// API: Get Recent Followers
app.get('/api/twitch/recent-followers', async (c) => {
  const settingsData = await c.env.RERUN_STORE.get('_twitch_stats_settings');
  if (!settingsData) return c.json({ error: 'No settings' }, 400);
  const settings = JSON.parse(settingsData);
  
  if (!settings.token || !settings.broadcasterId || !settings.clientId) {
    return c.json({ error: 'Missing tokens' }, 400);
  }

  try {
    const followerCount = settings.followerCount || 10;
    const res = await fetch(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${settings.broadcasterId}&first=${followerCount}`, {
      headers: {
        'Authorization': `Bearer ${settings.token.replace('oauth:', '')}`,
        'Client-Id': settings.clientId
      }
    });
    
    if (!res.ok) {
        return c.json({ error: 'Failed to fetch followers' }, res.status as any);
    }

    const data = await res.json() as any;
    return c.json(data.data || []);
  } catch(e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Overlay Pages
const overlayHtml = (title: string, field: string, goalField: string, colorField: string) => `
<!DOCTYPE html>
<html>
<head>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@800&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; padding: 10px; font-family: 'Outfit', sans-serif; color: white; overflow: hidden; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .wrapper { width: fit-content; white-space: nowrap; }
        .stat-box { 
            position: relative;
            background: rgba(0,0,0,0.7); 
            padding: 16px 24px 22px 24px; 
            border-radius: 14px; 
            border: 1px solid rgba(255,255,255,0.1); 
            backdrop-filter: blur(10px);
            overflow: hidden;
            width: fit-content;
        }
        .content { display: flex; justify-content: center; align-items: center; gap: 30px; }
        .label { font-size: var(--label-size); color: var(--label-color); text-transform: uppercase; letter-spacing: 0.15em; font-weight: 600; }
        .value-group { display: flex; align-items: baseline; gap: 8px; }
        .value { font-size: var(--value-size); text-shadow: 0 0 10px var(--glow); font-weight: 800; line-height: 1; }
        .goal { font-size: var(--goal-size); color: var(--label-color); line-height: 1; }
        
        .progress-container { 
            position: absolute;
            bottom: 0; left: 0; right: 0;
            height: 4px; background: rgba(255,255,255,0.1); 
            display: none;
        }
        .progress-bar { 
            height: 100%; width: 0%; background: var(--color);
            box-shadow: 0 0 10px var(--glow);
            transition: width 1s ease-in-out;
        }
    </style>
</head>
<body>
    <div class="wrapper" id="root" style="--color: #9146ff; --glow: rgba(145, 70, 255, 0.4); --label-size: 16px; --value-size: 38px; --goal-size: 22px; --label-color: #a1a1aa;">
        <div class="stat-box">
            <div class="content">
                <div class="label">${title}</div>
                <div class="value-group">
                    <span id="val" class="value">...</span>
                    <span id="goal" class="goal"></span>
                </div>
            </div>
            <div class="progress-container" id="progCont">
                <div class="progress-bar" id="progBar"></div>
            </div>
        </div>
    </div>
    <script>
        async function update() {
          try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            const color = data.${colorField} || '#9146ff';
            const textColor = data.${colorField.replace('Color', 'TextColor')} || '#a1a1aa';
            const root = document.getElementById('root');
            root.style.setProperty('--color', color);
            root.style.setProperty('--glow', color + '66');
            root.style.setProperty('--label-color', textColor);
            root.style.setProperty('--label-size', (data.labelSize || 16) + 'px');
            root.style.setProperty('--value-size', (data.valueSize || 38) + 'px');
            root.style.setProperty('--goal-size', (data.goalSize || 22) + 'px');

            if (data.${field} !== undefined) {
                const current = data.${field};
                const goal = data.${goalField};
                document.getElementById('val').innerText = current;
                
                if (goal) {
                    document.getElementById('goal').innerText = ' / ' + goal;
                    document.getElementById('progCont').style.display = 'block';
                    const pct = Math.min(100, Math.max(0, (current / goal) * 100));
                    document.getElementById('progBar').style.width = pct + '%';
                } else {
                    document.getElementById('goal').innerText = '';
                    document.getElementById('progCont').style.display = 'none';
                }
            }
          } catch(e) {}
        }
        function startSync() {
            update();
            fetch('/api/stats').then(r => r.json()).then(data => {
                const interval = (data.pollingInterval || 30) * 1000;
                setInterval(update, interval);
            });
        }
        startSync();
    </script>
</body>
</html>
`;

app.get('/overlay/followers', (c) => c.html(overlayHtml('Followers', 'followers', 'followerGoal', 'followerColor')));
app.get('/overlay/subs', (c) => c.html(overlayHtml('Subscribers', 'subs', 'subGoal', 'subColor')));

app.get('/overlay/recent-followers', (c) => {
  return c.html(`
<!DOCTYPE html>
<html>
<head>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;800&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; padding: 10px; font-family: 'Outfit', sans-serif; color: white; overflow: hidden; }
        .wrapper { width: 100%; white-space: nowrap; overflow: hidden; background: rgba(0,0,0,0.7); padding: 10px 0; border-radius: 14px; border: 1px solid rgba(255,255,255,0.1); backdrop-filter: blur(10px); display: flex; align-items: center; }
        .label { padding-left: 15px; font-size: 16px; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.15em; font-weight: 800; padding-right: 15px; border-right: 1px solid rgba(255,255,255,0.2); z-index: 2; background: inherit; }
        .marquee-container { flex: 1; overflow: hidden; position: relative; }
        .marquee { display: inline-block; animation: scroll linear infinite; font-size: 18px; font-weight: 600; padding-left: 100%; transition: animation-duration 0.5s ease; }
        .follower-item { margin-right: 40px; display: inline-flex; align-items: center; }
        .follower-item::before { content: '♥'; color: #ef4444; margin-right: 8px; font-size: 16px; }
        
        @keyframes scroll {
            0% { transform: translateX(0); }
            100% { transform: translateX(-100%); }
        }
    </style>
</head>
<body>
    <div class="wrapper">
        <div class="label" style="background: rgb(22 22 26);">Recent Followers</div>
        <div class="marquee-container">
            <div class="marquee" id="followerList">Loading...</div>
        </div>
    </div>
    <script>
        async function fetchFollowers() {
            try {
                const statRes = await fetch('/api/twitch/stats/settings');
                const statData = await statRes.json();
                if (statData && statData.scrollSpeed) {
                    document.querySelector('.marquee').style.animationDuration = statData.scrollSpeed + 's';
                }

                const res = await fetch('/api/twitch/recent-followers');
                const followers = await res.json();
                if (followers && Array.isArray(followers)) {
                    document.getElementById('followerList').innerHTML = followers.map(f => '<span class="follower-item">' + f.user_name + '</span>').join('');
                }
            } catch(e) {}
        }
        let syncInterval = null;
        async function startSync() {
            await fetchFollowers();
            const res = await fetch('/api/twitch/stats/settings');
            const data = await res.json();
            const interval = (data?.pollingInterval || 60) * 1000;
            if (syncInterval) clearInterval(syncInterval);
            syncInterval = setInterval(fetchFollowers, interval);
        }
        startSync();
    </script>
</body>
</html>
  `);
});

// Overlay: Going Live Countdown
app.get('/overlay/countdown', async (c) => {
  const data = await c.env.RERUN_STORE.get('_twitch_stats_settings');
  const settings = data ? JSON.parse(data) : {};
  const targetTime = settings.liveTimer || '';
  const label = settings.liveTimerLabel || 'NEXT LIVE STREAM';
  const tz = settings.liveTimerTZ || 'local';
  const timerColor = settings.timerColor || '#ffffff';
  const labelColor = settings.timerLabelColor || '#9146ff';
  const timerSize = settings.timerSize || 52;
  const labelSizeSetting = settings.timerLabelSize || Math.round(timerSize * 0.35);

  return c.html(`
<!DOCTYPE html>
<html>
<head>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700;900&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; padding: 0; color: white; font-family: 'Outfit', sans-serif; overflow: hidden; background: transparent; display: flex; justify-content: center; align-items: center; min-height: 100vh; text-align: center; }
        .container {
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            transition: all 0.3s ease;
        }
        .label {
            font-size: ${labelSizeSetting}px;
            font-weight: 800;
            color: ${labelColor};
            text-transform: uppercase;
            letter-spacing: 3px;
            margin-bottom: 4px;
            opacity: 0.9;
            text-shadow: 2px 2px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
        }
        .timer {
            font-size: ${timerSize}px;
            font-weight: 900;
            display: flex;
            gap: 12px;
            line-height: 1;
            color: ${timerColor};
            text-shadow: 3px 3px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;
        }
        .unit { display: flex; flex-direction: column; align-items: center; }
        .separator { color: ${labelColor}; transform: translateY(-4px); font-weight: 400; }
        .expired { color: #ef4444; font-size: ${Math.round(timerSize * 0.7)}px; font-weight: 900; letter-spacing: -1px; }
    </style>
</head>
<body>
    <div class="container" id="cont" style="display: none;">
        <div class="label" id="timerLabel">${label}</div>
        <div id="countdown" class="timer">
            <div class="unit"><div id="h">00</div></div>
            <div class="separator">:</div>
            <div class="unit"><div id="m">00</div></div>
            <div class="separator">:</div>
            <div class="unit"><div id="s">00</div></div>
        </div>
    </div>
    <script>
        const timeStr = "${targetTime}";
        const selectedTz = "${tz}";

        function getTargetTime() {
            if (!timeStr) return null;
            const [hours, minutes] = timeStr.split(':').map(Number);
            const now = new Date();
            
            // Create target date based on the chosen timezone
            const tz = selectedTz === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : selectedTz;
            
            // Get current time in selected TZ
            const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
            
            const target = new Date(nowInTz);
            target.setHours(hours, minutes, 0, 0);

            // If target is already in the past, move to tomorrow
            if (target < nowInTz) {
                target.setDate(target.getDate() + 1);
            }

            // Convert target TZ time back to browser local time for the interval
            const localOffset = now.getTimezoneOffset() * 60000;
            const tzOffset = now.getTime() - nowInTz.getTime();
            
            return target.getTime() + tzOffset;
        }

        const target = getTargetTime();

        function update() {
            if (!target) return;
            const now = new Date().getTime();
            const diff = target - now;
            
            document.getElementById('cont').style.display = 'inline-block';

            if (diff <= 0) {
                document.getElementById('countdown').innerHTML = '<div class="expired">STREAM STARTING SOON!</div>';
                return;
            }

            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);

            document.getElementById('h').innerText = String(h).padStart(2, '0');
            document.getElementById('m').innerText = String(m).padStart(2, '0');
            document.getElementById('s').innerText = String(s).padStart(2, '0');
        }
        setInterval(update, 1000);
        update();
    </script>
</body>
</html>
  `);
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
    <script src="https://cdn.jsdelivr.net/npm/obs-websocket-js@5.0.6/dist/obs-ws.global.js"></script>
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
            display: flex; justify-content: center; padding: 2rem 1rem;
        }
        .container { max-width: 800px; width: 100%; }
        header { text-align: center; margin-bottom: 2rem; }
        h1 { font-size: clamp(2rem, 8vw, 3rem); font-weight: 800; background: linear-gradient(to right, #9146ff, #d49aff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 0.5rem; }
        .subtitle { color: #a1a1aa; font-size: 1rem; }
        .card { background: var(--glass); backdrop-filter: blur(12px); border: 1px solid var(--glass-border); border-radius: 1.5rem; padding: 1.5rem; box-shadow: 0 10px 30px rgba(0,0,0,0.5); margin-bottom: 1.5rem; }
        .input-group { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; }
        input, select { flex: 1; min-width: 0; background: #121214; border: 1px solid var(--border); border-radius: 0.75rem; padding: 0.75rem 1rem; color: white; font-size: 1rem; transition: 0.2s; font-family: inherit; }
        input:focus, select:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 2px rgba(145, 70, 255, 0.2); }
        select { appearance: none; background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e"); background-repeat: no-repeat; background-position: right 1rem center; background-size: 1em; padding-right: 2.5rem; }
        button { cursor: pointer; border: none; border-radius: 0.75rem; padding: 0.75rem 1.5rem; font-size: 1rem; font-weight: 600; transition: 0.2s; background: var(--primary); color: white; }
        button:hover { background: var(--primary-hover); transform: translateY(-1px); }
        button.secondary { background: #27272a; padding: 0.5rem 1rem; font-size: 0.8rem; }
        button.danger { background: rgba(235, 4, 0, 0.1); color: #ef4444; padding: 0.5rem; display: flex; align-items: center; }
        .vod-item { 
            display: flex; justify-content: space-between; align-items: center; 
            padding: 1rem; background: #18181b; border: 1px solid var(--border); 
            border-radius: 1rem; margin-bottom: 0.75rem; gap: 1rem; transition: 0.2s;
        }
        .vod-item:hover { border-color: var(--primary); background: #1c1c1f; }
        .vod-item.disabled { opacity: 0.5; filter: grayscale(0.5); }
        
        /* Custom Checkbox */
        .custom-checkbox {
            position: relative; width: 24px; height: 24px; flex: none;
            appearance: none; background: #121214; border: 2px solid #3f3f46;
            border-radius: 6px; cursor: pointer; transition: 0.2s;
            display: grid; place-items: center; padding: 0 !important;
        }
        .custom-checkbox:checked {
            background: var(--primary);
            border-color: var(--primary);
        }
        .custom-checkbox:checked::after {
            content: "✓"; color: white; font-size: 14px; font-weight: bold;
        }
        
        .playlist-url { background: rgba(145, 70, 255, 0.05); border: 1px dashed var(--primary); padding: 0.6rem 1rem; border-radius: 0.75rem; display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem; overflow: hidden; gap: 0.75rem; width: 100%; box-sizing: border-box; }
        code { color: #d49aff; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; font-size: 0.85rem; }
        .empty { text-align: center; padding: 2rem; color: #71717a; }

        @media (max-width: 768px) {
            body { padding: 1rem 0.5rem; }
            .card { padding: 1rem 0.75rem; border-radius: 0.75rem; }
            .input-group { flex-direction: column; }
            .input-group button { width: 100%; }
            .vod-item { padding: 0.6rem; gap: 0.4rem; }
            .vod-item img { width: 80px !important; min-width: 80px !important; height: 45px !important; }
            .vod-item .vod-info { margin-top: 0; }
            .vod-item .vod-info div:first-child { font-size: 0.85rem !important; }
            .vod-item .vod-info div:last-child { font-size: 0.65rem !important; }
            .vod-item button.danger { width: auto !important; padding: 0.3rem 0.5rem !important; margin-left: auto !important; align-self: center; }
            .obs-grid { grid-template-columns: 1fr !important; }
            .playlist-url { flex-direction: column; align-items: stretch; }
            code { margin-bottom: 0.5rem; }
            .url-grid { grid-template-columns: 1fr !important; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Rerun Manager</h1>
            <p class="subtitle">Twitch VOD to OBS VLC Playlist</p>
        </header>

        <section class="card" id="obsConfigCard">
            <h2 style="font-size: 1.5rem; margin-bottom: 1rem;">OBS Connection</h2>

            <div style="margin-bottom: 1rem;">
                <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Connection Mode</label>
                <select id="obsMode" onchange="toggleObsMode()" style="width: 100%;">
                    <option value="local">🏠 Local (Home Network)</option>
                    <option value="remote">🌐 Remote (Cloudflare Tunnel / DDNS)</option>
                </select>
            </div>

            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                <div>
                   <label style="font-size: 0.8rem; color: #a1a1aa;" id="obsAddressLabel">OBS Address</label>
                   <input type="text" id="obsAddress" value="localhost:44555" style="width: 100%;">
                   <div id="obsAddressHint" style="font-size: 0.7rem; color: #52525b; margin-top: 0.25rem;">e.g. localhost:44555</div>
                </div>
                <div>
                   <label style="font-size: 0.8rem; color: #a1a1aa;">OBS Password</label>
                   <input type="password" id="obsPassword" placeholder="WebSocket Password" style="width: 100%;">
                </div>
            </div>
            <div style="margin-bottom: 1rem;">
                <label style="font-size: 0.8rem; color: #a1a1aa;">VLC Source Name</label>
                <input type="text" id="obsSourceName" value="twitchreruns" style="width: 100%;">
            </div>
            <button id="obsConnectBtn" onclick="connectOBS()" style="width: 100%;">Connect to OBS</button>
            <div id="obsStatus" style="font-size: 0.8rem; margin-top: 0.5rem; text-align: center; color: #71717a;">Disconnected</div>
        </section>

        <section class="card" id="obsRemoteCard" style="display:none; padding-bottom: 2rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                <h2 style="font-size: 1.5rem;">OBS Remote Control</h2>
                <div style="font-size: 0.9rem; color: #22c55e;" id="obsLiveStatus">● ONLINE</div>
            </div>
            <div style="background: #121214; padding: 1.5rem; border-radius: 1rem; text-align: center; margin-bottom: 1rem; border: 1px solid var(--border);">
               <div style="font-size: 0.8rem; color: #a1a1aa; margin-bottom: 0.25rem;">CONTROLLING SOURCE</div>
               <div id="activeSourceName" style="font-weight: 800; font-size: 1.2rem; color: #d49aff;">-</div>
            </div>

            <!-- PLAYING INFO -->
            <div id="playingInfo" style="display: none; margin-bottom: 1.5rem; text-align: left; background: rgba(145, 70, 255, 0.05); padding: 1rem; border-radius: 0.75rem; border: 1px solid rgba(145, 70, 255, 0.2);">
                <div style="font-size: 0.75rem; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">Now Playing</div>
                <div id="nowPlayingTitle" style="font-weight: 700; color: #f0f0f5; margin-bottom: 0.5rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">-</div>
                <div style="font-size: 0.75rem; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem;">Up Next</div>
                <div id="nextPlayingTitle" style="font-weight: 600; color: #a1a1aa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">-</div>
            </div>

            <!-- SEEK BAR -->
            <div style="margin-bottom: 1.5rem;">
                <input type="range" id="obsSeekBar" value="0" min="0" max="100" style="width: 100%; height: 6px; appearance: none; background: #3f3f46; border-radius: 3px; outline: none; cursor: pointer; margin-bottom: 0.5rem;">
                <div style="display: flex; justify-content: space-between; font-size: 0.8rem; color: #a1a1aa; font-family: monospace;">
                    <span id="obsCurrentTime">00:00:00</span>
                    <span id="obsTotalTime">00:00:00</span>
                </div>
            </div>

            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-bottom: 1rem;">
                <button onclick="obsCommand('play')" id="playBtn" style="background: #22c55e;">Play</button>
                <button onclick="obsCommand('pause')" id="pauseBtn" style="background: #f59e0b;">Pause</button>
            </div>
            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                <button onclick="obsCommand('previous')" class="secondary">⏮ Prev</button>
                <button onclick="obsCommand('next')" class="secondary">Next ⏭</button>
            </div>
            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem;">
                <button id="obsShuffleBtn" onclick="toggleObsShuffle()" class="secondary">Shuffle: OFF</button>
                <button onclick="obsCommand('restart')" class="secondary" style="color: #60a5fa;">Restart</button>
                <button onclick="obsCommand('stop')" class="secondary" style="color: #ef4444;">Stop</button>
            </div>
        </section>

        <section class="card">
            <div class="input-group">
                <input type="text" id="vodInput" placeholder="Twitch VOD URL or ID">
                <button id="addBtn" onclick="addVod()">Add VOD</button>
            </div>
            
            <div id="vodList"></div>
            
            <div id="listActions" style="display:none; text-align: right; margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 1rem;">
                <div id="totalDuration" style="float: left; font-size: 0.9rem; color: #a1a1aa; font-weight: 600; padding-top: 0.5rem;">Total Duration: -</div>
                <button class="secondary" onclick="clearVods()" style="color: #ef4444;">Clear All</button>
            </div>
            
            <div id="playlistSection" style="display:none; margin-top: 2rem;">
                <p style="font-size: 0.9rem; color: #a1a1aa; margin-bottom: 0.5rem;">OBS VLC Source URL:</p>
                <div class="playlist-url">
                    <code id="playlistUrl"></code>
                    <button class="secondary" onclick="copyUrl()">Copy</button>
                </div>
                <p style="font-size: 0.75rem; color: #71717a; margin-top: 0.5rem; line-height: 1.4;">
                    💡 <b>Tip:</b> If newly added VODs don't show up in OBS, click <b>Stop</b> and then <b>Restart</b> in the Remote Control above, or right-click the VLC source in OBS and click <b>Refresh/Reload</b>.
                </p>
            </div>
        </section>

        <!-- TWITCH ACCESS CONFIG -->
        <section class="card">
            <h2 style="font-size: 1.5rem; margin-bottom: 1rem;">Twitch Access</h2>
            <div style="margin-bottom: 1.5rem;">
                <label style="font-size: 0.8rem; color: #a1a1aa;">User Access Token</label>
                <input type="password" id="twStatToken" placeholder="oauth:xxxx" style="width: 100%;">
                <p style="font-size: 0.75rem; color: #71717a; margin-top: 0.5rem;">
                    Need a token? <a href="https://twitchtokengenerator.com/" target="_blank" style="color: #9146ff; text-decoration: none; font-weight: 600;">Click here</a> to generate one with <code>channel:read:subscriptions</code>, <code>moderator:read:followers</code>, and <code>channel:manage:broadcast</code> scopes.
                </p>
                <p style="font-size: 0.75rem; color: #71717a; margin-top: 0.5rem;">
                    Note: Total Subs requires <code>channel:read:subscriptions</code>. Followers requires <code>moderator:read:followers</code>. Category Auto-Update requires <code>channel:manage:broadcast</code>.
                </p>
            </div>
            <button onclick="saveTwitchStats(event)" style="width: 100%; background: #059669;">Save Access Token</button>
        </section>

        <!-- GOAL OVERLAYS (Followers/Subs) -->
        <section class="card">
            <h2 style="font-size: 1.5rem; margin-bottom: 1rem;">📊 Goal Overlays</h2>
            
            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                <div>
                   <label style="font-size: 0.8rem; color: #a1a1aa;">Follower Goal (e.g. 100)</label>
                   <input type="text" id="twFollowerGoal" placeholder="Leave empty for no goal" style="width: 100%;">
                </div>
                <div>
                   <label style="font-size: 0.8rem; color: #a1a1aa;">Sub Goal (e.g. 50)</label>
                   <input type="text" id="twSubGoal" placeholder="Leave empty for no goal" style="width: 100%;">
                </div>
            </div>

            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Follower Bar Color</label>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <input type="color" id="twFollowerColor" value="#9146ff" style="width: 50px; height: 35px; border: none; padding: 0; background: none; cursor: pointer;">
                        <input type="text" id="twFollowerHex" value="#9146ff" style="font-family: monospace; font-size: 0.8rem; padding: 0.25rem;">
                    </div>
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Sub Bar Color</label>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <input type="color" id="twSubColor" value="#d49aff" style="width: 50px; height: 35px; border: none; padding: 0; background: none; cursor: pointer;">
                        <input type="text" id="twSubHex" value="#d49aff" style="font-family: monospace; font-size: 0.8rem; padding: 0.25rem;">
                    </div>
                </div>
            </div>

            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Follower Label Color</label>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <input type="color" id="twFollowerTextColor" value="#a1a1aa" style="width: 50px; height: 35px; border: none; padding: 0; background: none; cursor: pointer;">
                        <input type="text" id="twFollowerTextHex" value="#a1a1aa" style="font-family: monospace; font-size: 0.8rem; padding: 0.25rem;">
                    </div>
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Sub Label Color</label>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <input type="color" id="twSubTextColor" value="#a1a1aa" style="width: 50px; height: 35px; border: none; padding: 0; background: none; cursor: pointer;">
                        <input type="text" id="twSubTextHex" value="#a1a1aa" style="font-family: monospace; font-size: 0.8rem; padding: 0.25rem;">
                    </div>
                </div>
            </div>

            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Label Size (<span id="labelSizeVal">16</span>px)</label>
                    <input type="range" id="twLabelSize" min="10" max="40" value="16" style="width: 100%;" oninput="document.getElementById('labelSizeVal').innerText = this.value">
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Number Size (<span id="valueSizeVal">38</span>px)</label>
                    <input type="range" id="twValueSize" min="20" max="80" value="38" style="width: 100%;" oninput="document.getElementById('valueSizeVal').innerText = this.value">
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Goal Size (<span id="goalSizeVal">22</span>px)</label>
                    <input type="range" id="twGoalSize" min="10" max="50" value="22" style="width: 100%;" oninput="document.getElementById('goalSizeVal').innerText = this.value">
                </div>
            </div>

            <div style="margin-bottom: 1.5rem;">
                <p style="font-size: 0.8rem; color: #a1a1aa; margin-bottom: 0.5rem; text-align: center;">Previews</p>
                <div style="display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap;">
                    <iframe id="followPreview" src="" style="border: 1px solid var(--border); width: 280px; height: 80px; border-radius: 8px; background: #000;"></iframe>
                    <iframe id="subPreview" src="" style="border: 1px solid var(--border); width: 280px; height: 80px; border-radius: 8px; background: #000;"></iframe>
                </div>
            </div>

            <div class="url-grid" style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem;">
                <div>
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Followers URL</label>
                    <div class="playlist-url">
                        <code id="followOverlayUrl"></code>
                        <button class="secondary" onclick="copyText('followOverlayUrl')">Copy</button>
                    </div>
                </div>
                <div>
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Subscribers URL</label>
                    <div class="playlist-url">
                        <code id="subOverlayUrl"></code>
                        <button class="secondary" onclick="copyText('subOverlayUrl')">Copy</button>
                    </div>
                </div>
            </div>
        </section>

        <!-- RECENT FOLLOWERS -->
        <section class="card">
            <h2 style="font-size: 1.5rem; margin-bottom: 1rem;">♥ Recent Followers</h2>
            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Scroll Speed (<span id="scrollSpeedVal">15</span>s)</label>
                    <input type="range" id="twScrollSpeed" min="5" max="120" value="15" style="width: 100%;" oninput="document.getElementById('scrollSpeedVal').innerText = this.value">
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Follower Count (<span id="followerCountVal">10</span>)</label>
                    <input type="range" id="twFollowerCount" min="1" max="100" value="10" style="width: 100%;" oninput="document.getElementById('followerCountVal').innerText = this.value">
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Polling Interval (<span id="pollingVal">30</span>s)</label>
                    <input type="range" id="twPollingInterval" min="5" max="300" value="30" step="5" style="width: 100%;" oninput="document.getElementById('pollingVal').innerText = this.value">
                </div>
            </div>

            <div style="margin-bottom: 1.5rem;">
                <p style="font-size: 0.8rem; color: #a1a1aa; margin-bottom: 0.5rem; text-align: center;">Recent Followers Preview</p>
                <div style="display: flex; justify-content: center;">
                    <iframe id="recentPreview" src="" style="border: 1px solid var(--border); width: 100%; height: 60px; border-radius: 8px; background: #000;"></iframe>
                </div>
            </div>

            <div>
                <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Recent Followers URL</label>
                <div class="playlist-url">
                    <code id="recentOverlayUrl"></code>
                    <button class="secondary" onclick="copyText('recentOverlayUrl')">Copy</button>
                </div>
            </div>
        </section>

        <!-- GOING LIVE COUNTDOWN -->
        <section class="card">
            <h2 style="font-size: 1.5rem; margin-bottom: 1rem;">⏳ Going Live Countdown</h2>
            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
                <div>
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Label</label>
                    <input type="text" id="twLiveLabel" placeholder="NEXT LIVE STREAM" style="width: 100%;">
                </div>
                <div>
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Time</label>
                    <input type="time" id="twLiveTime" style="width: 100%;">
                </div>
                <div>
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Timezone</label>
                    <select id="twLiveTZ" style="width: 100%;">
                        <option value="local">Detect (Browser)</option>
                        <option value="UTC">UTC</option>
                        <option value="America/New_York">Eastern Time (ET)</option>
                        <option value="America/Chicago">Central Time (CT)</option>
                        <option value="America/Denver">Mountain Time (MT)</option>
                        <option value="America/Los_Angeles">Pacific Time (PT)</option>
                        <option value="Europe/London">London (GMT/BST)</option>
                        <option value="Europe/Paris">Central Europe (CET)</option>
                        <option value="Asia/Tokyo">Tokyo (JST)</option>
                        <option value="Australia/Sydney">Sydney (AEST)</option>
                    </select>
                </div>
            </div>

            <div class="obs-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Label Color</label>
                    <div style="display: flex; gap: 0.5rem;">
                        <input type="color" id="twTimerLabelColor" value="#9146ff" style="width: 40px; height: 35px; border: none; background: none; cursor: pointer;">
                        <input type="text" id="twTimerLabelHex" value="#9146ff" style="flex: 1; padding: 0.3rem; font-size: 0.8rem; border-radius: 0.4rem; border: 1px solid var(--border); background: #18181b; color: white;">
                    </div>
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Number Color</label>
                    <div style="display: flex; gap: 0.5rem;">
                        <input type="color" id="twTimerColor" value="#ffffff" style="width: 40px; height: 35px; border: none; background: none; cursor: pointer;">
                        <input type="text" id="twTimerHex" value="#ffffff" style="flex: 1; padding: 0.3rem; font-size: 0.8rem; border-radius: 0.4rem; border: 1px solid var(--border); background: #18181b; color: white;">
                    </div>
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Label Size (<span id="timerLabelSizeVal">18</span>px)</label>
                    <input type="range" id="twTimerLabelSize" min="10" max="100" value="18" style="width: 100%;" oninput="document.getElementById('timerLabelSizeVal').innerText = this.value">
                </div>
                <div style="background: #121214; padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--border);">
                    <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Number Size (<span id="timerSizeVal">52</span>px)</label>
                    <input type="range" id="twTimerSize" min="20" max="150" value="52" style="width: 100%;" oninput="document.getElementById('timerSizeVal').innerText = this.value">
                </div>
            </div>

            <div style="margin-bottom: 1.5rem;">
                <p style="font-size: 0.8rem; color: #a1a1aa; margin-bottom: 0.5rem; text-align: center;">Countdown Preview</p>
                <div style="display: flex; justify-content: center;">
                    <iframe id="countdownPreview" src="" style="border: 1px solid var(--border); width: 100%; height: 120px; border-radius: 8px; background: #000;"></iframe>
                </div>
            </div>

            <div>
                <label style="font-size: 0.8rem; color: #a1a1aa; display: block; margin-bottom: 0.5rem;">Countdown URL</label>
                <div class="playlist-url">
                    <code id="countdownLink"></code>
                    <button class="secondary" onclick="copyText('countdownLink')">Copy</button>
                </div>
            </div>
        </section>
    </div>

    <script>
        const input = document.getElementById('vodInput');
        const list = document.getElementById('vodList');
        const listActions = document.getElementById('listActions');
        const playlistSection = document.getElementById('playlistSection');
        const playlistUrl = document.getElementById('playlistUrl');

        async function loadVods() {
            try {
                // Using playlist.json ensures we check stream status for each VOD
                const res = await fetch('/api/playlist.json');
                const vods = await res.json();
                renderVods(vods);
            } catch(e) { 
                list.innerHTML = '<div class="empty">Error connecting to database.</div>';
            }
        }

        function renderVods(vods) {
            if (!Array.isArray(vods) || vods.length === 0) {
                list.innerHTML = '<div class="empty">No VODs added yet. Add a Twitch VOD URL above ⬆️</div>';
                playlistSection.style.display = 'none';
                listActions.style.display = 'none';
                return;
            }
            
            playlistSection.style.display = 'block';
            listActions.style.display = 'block';
            
            // Add cache buster to the URL for copy-pasting
            const baseUrl = window.location.origin + '/api/playlist';
            playlistUrl.innerText = baseUrl + '?t=' + Date.now();
            
            list.innerHTML = vods.map(v => \`
                <div class="vod-item \${v.enabled === false ? 'disabled' : ''}">
                    <div style="display: flex; gap: 1rem; align-items: center; flex: 1; min-width: 0;">
                        <input type="checkbox" class="custom-checkbox" \${v.enabled !== false ? 'checked' : ''} 
                               onchange="toggleVod('\${v.id}', this.checked)">
                        <div style="position: relative;">
                            <img src="\${v.thumbnailUrl || ''}" 
                                 onerror="this.src='https://vod-secure.twitch.tv/_404/404_processing_320x180.png'" 
                                 style="width: 100px; min-width: 100px; height: 56px; border-radius: 0.5rem; object-fit: cover;" alt="thumbnail" />
                            \${v.error ? 
                                \`<div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(239, 68, 68, 0.9); color: white; font-size: 0.6rem; padding: 2px; text-align: center; border-bottom-left-radius: 0.5rem; border-bottom-right-radius: 0.5rem;">ERROR</div>\` : 
                                \`<div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(34, 197, 94, 0.9); color: white; font-size: 0.6rem; padding: 2px; text-align: center; border-bottom-left-radius: 0.5rem; border-bottom-right-radius: 0.5rem;">READY</div>\`
                            }
                        </div>
                        <div class="vod-info" style="min-width: 0; flex: 1;">
                            <div style="font-weight:600; margin-bottom: 0.1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.95rem;">\${v.title}</div>
                            <div style="font-size:0.75rem; color:#a1a1aa; line-height: 1;">\${v.author || 'Unknown'} &bull; \${v.duration || '0s'}</div>
                            \${v.error ? \`<div style="font-size: 0.65rem; color: #ef4444; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">\${v.error}</div>\` : ''}
                        </div>
                    </div>
                    <button class="danger" onclick="deleteVod('\${v.id}')" style="margin-left: 0.5rem; flex-shrink: 0; padding: 0.4rem;">✕</button>
                </div>
            \`.trim()).join('');

            // Calculate total duration
            let totalSeconds = 0;
            vods.forEach(v => {
                totalSeconds += parseDuration(v.duration);
            });
            
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            
            let durText = 'Total Duration: ';
            if (h > 0) durText += h + 'h ';
            if (m > 0 || h > 0) durText += m + 'm ';
            durText += s + 's';
            
            document.getElementById('totalDuration').innerText = durText;
            window.currentVods = vods; // Store globally for OBS sync
        }

        function parseDuration(d) {
            if (!d) return 0;
            // Handle Twitch format: 1h2m3s
            const h = d.match(/(\\d+)h/);
            const m = d.match(/(\\d+)m/);
            const s = d.match(/(\\d+)s/);
            if (h || m || s) {
                return (parseInt(h ? h[1] : 0) * 3600) + 
                       (parseInt(m ? m[1] : 0) * 60) + 
                       parseInt(s ? s[1] : 0);
            }
            // Fallback for HH:MM:SS
            const parts = d.split(':').map(Number);
            if (parts.length === 3) return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
            if (parts.length === 2) return (parts[0] * 60) + parts[1];
            return 0;
        }

        async function addVod() {
            const val = input.value.trim();
            const match = val.match(/(?:\\/videos\\/|v=)(\\d+)/);
            const vodId = match ? match[1] : val.match(/^\\d+$/) ? val : null;
            
            if (!vodId) return alert('Invalid Twitch VOD URL. Try: https://www.twitch.tv/videos/1234567');

            const btn = document.getElementById('addBtn');
            btn.disabled = true;
            btn.textContent = 'Loading...';
            
            try {
                const res = await fetch('/api/vods', {
                    method: 'POST',
                    body: JSON.stringify({ vodId }),
                    headers: { 'Content-Type': 'application/json' }
                });
                input.value = '';
                renderVods(await res.json());
            } finally {
                btn.disabled = false;
                btn.textContent = 'Add VOD';
            }
        }

        async function toggleVod(id, enabled) {
            const res = await fetch('/api/vods/toggle', {
                method: 'POST',
                body: JSON.stringify({ id, enabled }),
                headers: { 'Content-Type': 'application/json' }
            });
            renderVods(await res.json());
        }

        async function deleteVod(id) {
            const res = await fetch('/api/vods?id=' + id, { method: 'DELETE' });
            renderVods(await res.json());
        }

        async function clearVods() {
            if (!confirm('Are you sure you want to clear all VODs?')) return;
            const res = await fetch('/api/vods/clear', { method: 'POST' });
            renderVods(await res.json());
        }

        function copyUrl() {
            navigator.clipboard.writeText(playlistUrl.innerText);
            const btn = event.target;
            btn.textContent = '✓ Copied!';
            setTimeout(() => btn.textContent = 'Copy', 2000);
        }

        function copyText(id) {
            const el = document.getElementById(id);
            navigator.clipboard.writeText(el.innerText);
            const btn = event.target;
            const old = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => btn.textContent = old, 2000);
        }

        async function saveTwitchStats(e, previewIds = null) {
            const token = document.getElementById('twStatToken').value.trim();
            const followerGoal = document.getElementById('twFollowerGoal').value.trim();
            const subGoal = document.getElementById('twSubGoal').value.trim();
            const followerColor = document.getElementById('twFollowerColor').value;
            const subColor = document.getElementById('twSubColor').value;
            const followerTextColor = document.getElementById('twFollowerTextColor').value;
            const subTextColor = document.getElementById('twSubTextColor').value;
            const labelSize = parseInt(document.getElementById('twLabelSize').value);
            const valueSize = parseInt(document.getElementById('twValueSize').value);
            const goalSize = parseInt(document.getElementById('twGoalSize').value);
            const scrollSpeed = parseInt(document.getElementById('twScrollSpeed').value);
            const followerCount = parseInt(document.getElementById('twFollowerCount').value);
            const pollingInterval = parseInt(document.getElementById('twPollingInterval').value);
            const liveTimer = document.getElementById('twLiveTime').value;
            const liveTimerLabel = document.getElementById('twLiveLabel').value.trim() || 'NEXT LIVE STREAM';
            const liveTimerTZ = document.getElementById('twLiveTZ').value;
            const timerColor = document.getElementById('twTimerColor').value;
            const timerLabelColor = document.getElementById('twTimerLabelColor').value;
            const timerSize = parseInt(document.getElementById('twTimerSize').value);
            
            if (!token && !followerGoal && !subGoal && !followerColor) return;
            
            // If called from button click, show loading
            const btn = e?.target?.tagName === 'BUTTON' ? e.target : null;
            if (btn) {
                btn.textContent = 'Saving Settings...';
                btn.disabled = true;
            }

            try {
                const res = await fetch('/api/twitch/stats/settings', {
                    method: 'POST',
                    body: JSON.stringify({ 
                        token, followerGoal, subGoal, followerColor, subColor, 
                        followerTextColor, subTextColor, labelSize, valueSize, goalSize, scrollSpeed, followerCount, pollingInterval,
                        liveTimer, liveTimerLabel, liveTimerTZ,
                        timerColor, timerLabelColor, timerSize,
                        timerLabelSize: parseInt(document.getElementById('twTimerLabelSize').value)
                    }),
                    headers: { 'Content-Type': 'application/json' }
                });
                const data = await res.json();
                if (res.ok) {
                    if (btn) alert('Settings updated!');
                    if (data.username) {
                        document.getElementById('twStatToken').placeholder = 'Token Saved (' + data.username + ')';
                        document.getElementById('twStatToken').value = '';
                    }

                    // Refresh specific previews or all
                    const now = Date.now();
                    const targets = previewIds || ['followPreview', 'subPreview', 'recentPreview', 'countdownPreview'];
                    targets.forEach(id => {
                        const el = document.getElementById(id);
                        if (el) {
                            const baseUrl = el.src.split('?')[0];
                            el.src = baseUrl + '?t=' + now;
                        }
                    });
                    
                    // Always update the link text
                    document.getElementById('countdownLink').innerText = window.location.origin + '/overlay/countdown?t=' + now;
                } else {
                    if (btn) alert('Error: ' + data.error);
                }
            } catch(e) { if (btn) alert('Error: ' + e.message); }
            finally {
                if (btn) {
                    btn.textContent = 'Save Overlay Settings';
                    btn.disabled = false;
                }
            }
        }

        /* OBS REMOTE LOGIC */
        let obs;
        const obsStatus = document.getElementById('obsStatus');
        const obsRemoteCard = document.getElementById('obsRemoteCard');
        const obsConfigCard = document.getElementById('obsConfigCard');
        const activeSourceName = document.getElementById('activeSourceName');
        
        let obsConnected = false;
        let obsShuffle = false;

        async function connectOBS() {
            if (typeof OBSWebSocket === 'undefined') {
                obsStatus.innerText = 'Error: OBS Library not loaded';
                return;
            }
            if (!obs) obs = new OBSWebSocket();
            
            let address = document.getElementById('obsAddress').value.trim();
            const password = document.getElementById('obsPassword').value;
            const sourceName = document.getElementById('obsSourceName').value;

            // Auto-handle protocol
            if (!address.startsWith('ws://') && !address.startsWith('wss://')) {
                // Use wss:// for remote hostnames, ws:// for local IPs
                const isLocal = address.startsWith('localhost') || 
                                address.startsWith('127.') || 
                                address.startsWith('192.168.') || 
                                address.startsWith('10.') ||
                                /^172\.(1[6-9]|2\d|3[01])\./.test(address);
                address = (isLocal ? 'ws://' : 'wss://') + address;
            }
            
            // Strip port from cloudflare tunnel URLs (they don't use ports)
            if (address.includes('.trycloudflare.com:') || address.includes('.pages.dev:')) {
                address = address.replace(/:\d+$/, '');
            }

            obsStatus.innerText = 'Connecting...';
            try {
                await obs.connect(address, password);
                obsConnected = true;
                obsStatus.innerText = 'Connected!';
                obsConfigCard.style.display = 'none';
                obsRemoteCard.style.display = 'block';
                activeSourceName.innerText = sourceName;
                syncObsState();
            } catch (error) {
                let msg = error.message;
                if (window.location.protocol === 'https:' && address.startsWith('ws://')) {
                    msg = "⚠️ Mixed Content Blocked. Fix: Click the 🔒 lock icon in your browser → Site Settings → Insecure content → Allow. Then reload and try again.";
                }
                obsStatus.innerHTML = 'Connection Failed: ' + msg;
                console.error('OBS Connect Error:', error);
            }
        }

        async function obsCommand(action) {
            if (!obsConnected) return;
            const sourceName = document.getElementById('obsSourceName').value;
            
            try {
                // Correct 5.x request name is TriggerMediaInputAction
                let obsAction = '';
                if (action === 'playpause') obsAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY_PAUSE';
                if (action === 'play') obsAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY';
                if (action === 'pause') obsAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE';
                if (action === 'next') obsAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT';
                if (action === 'previous') obsAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS';
                if (action === 'stop') obsAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP';
                if (action === 'restart') obsAction = 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART';

                if (obsAction) {
                    await obs.call('TriggerMediaInputAction', {
                        inputName: sourceName,
                        mediaAction: obsAction
                    });
                    
                    // If stopped, hide playing info immediately
                    if (action === 'stop') {
                        const info = document.getElementById('playingInfo');
                        if (info) info.style.display = 'none';
                    }
                }
            } catch (e) {
                alert('OBS Error: ' + e.message);
            }
        }

        async function toggleObsShuffle() {
            if (!obsConnected) return;
            const sourceName = document.getElementById('obsSourceName').value;
            
            try {
                const { inputSettings, inputKind } = await obs.call('GetInputSettings', { inputName: sourceName });
                console.log('[OBS Debug] Current Source Kind:', inputKind);
                console.log('[OBS Debug] Current Settings:', inputSettings);

                if (inputKind !== 'vlc_source') {
                    alert('Shuffle Error: Source "' + sourceName + '" is a "' + inputKind + '". Shuffle only works with "VLC Video Source" plugins. Please check your OBS source type.');
                    return;
                }

                obsShuffle = !obsShuffle;
                
                // Rebuild the URL correctly to ensure there's a "?" and no double parameters
                if (inputSettings.playlist && inputSettings.playlist[0]) {
                    // Strip EVERYTHING after /api/playlist (including ? and &)
                    let cleanBase = inputSettings.playlist[0].value.split('/api/playlist')[0] + '/api/playlist';
                    inputSettings.playlist[0].value = cleanBase + '?shuffle=' + obsShuffle + '&t=' + Date.now();
                    console.log('[OBS Debug] Rebuilt URL:', inputSettings.playlist[0].value);
                }

                await obs.call('SetInputSettings', {
                    inputName: sourceName,
                    inputSettings: { ...inputSettings, shuffle: obsShuffle }
                });
                
                console.log('[OBS Debug] Successfully set Shuffle to:', obsShuffle, 'New URL:', inputSettings.playlist?.[0]?.value);
                document.getElementById('obsShuffleBtn').innerText = 'Shuffle: ' + (obsShuffle ? 'ON' : 'OFF');
                document.getElementById('obsShuffleBtn').style.color = obsShuffle ? '#d49aff' : 'inherit';
            } catch (e) {
                console.error('[OBS Debug] Shuffle Failed:', e);
                alert('Shuffle Failed: ' + e.message);
            }
        }

        async function syncObsState() {
            if (!obsConnected) return;
            const sourceName = document.getElementById('obsSourceName').value;
            try {
                const { inputSettings, inputKind } = await obs.call('GetInputSettings', { inputName: sourceName });
                console.log('[OBS Debug] Syncing State. Kind:', inputKind, 'Settings:', inputSettings);
                
                if (typeof inputSettings.shuffle !== 'undefined') {
                    obsShuffle = inputSettings.shuffle;
                    document.getElementById('obsShuffleBtn').innerText = 'Shuffle: ' + (obsShuffle ? 'ON' : 'OFF');
                    document.getElementById('obsShuffleBtn').style.color = obsShuffle ? '#d49aff' : 'inherit';
                }
            } catch(e) {
                console.warn('[OBS Debug] Sync state failed', e);
            }
        }

        const seekBar = document.getElementById('obsSeekBar');
        const currentTimeEl = document.getElementById('obsCurrentTime');
        const totalTimeEl = document.getElementById('obsTotalTime');
        let isSeeking = false;

        seekBar.onmousedown = () => { isSeeking = true; };
        seekBar.onmouseup = async () => {
            isSeeking = false;
            if (!obsConnected) return;
            const sourceName = document.getElementById('obsSourceName').value;
            try {
                await obs.call('SetMediaInputCursor', {
                    inputName: sourceName,
                    mediaCursor: parseInt(seekBar.value)
                });
            } catch(e) {}
        };

        function formatTime(ms) {
            const totalSeconds = Math.floor(ms / 1000);
            const h = Math.floor(totalSeconds / 3600);
            const m = Math.floor((totalSeconds % 3600) / 60);
            const s = totalSeconds % 60;
            return (h > 0 ? h + ':' : '') + 
                   (m < 10 && h > 0 ? '0' + m : m) + ':' + 
                   (s < 10 ? '0' + s : s);
        }

        setInterval(async () => {
            if (!obsConnected || isSeeking) return;
            const sourceName = document.getElementById('obsSourceName').value;
            try {
                const status = await obs.call('GetMediaInputStatus', { inputName: sourceName });
                const info = document.getElementById('playingInfo');

                if (status.mediaDuration > 0 && status.mediaState !== 'OBS_MEDIA_STATE_STOPPED') {
                    seekBar.max = status.mediaDuration;
                    seekBar.value = status.mediaCursor;
                    currentTimeEl.innerText = formatTime(status.mediaCursor);
                    totalTimeEl.innerText = formatTime(status.mediaDuration);

                    // Auto-sync playing info
                    if (window.currentVods) {
                        const obsDurationSec = Math.round(status.mediaDuration / 1000);
                        const currentIndex = window.currentVods.findIndex(v => {
                            const vSec = parseDuration(v.duration);
                            return Math.abs(vSec - obsDurationSec) < 5; // 5s tolerance
                        });

                        if (currentIndex !== -1) {
                            const currentVod = window.currentVods[currentIndex];
                            
                            // Check if VOD changed to auto-update category
                            if (window.currentPlayingVodId !== currentVod.id) {
                                window.currentPlayingVodId = currentVod.id;
                                fetch('/api/twitch/update-category', {
                                    method: 'POST',
                                    body: JSON.stringify({ vodId: currentVod.id }),
                                    headers: { 'Content-Type': 'application/json' }
                                }).catch(e => console.error('Auto category update failed', e));
                            }

                            if (info) info.style.display = 'block';
                            document.getElementById('nowPlayingTitle').innerText = currentVod.title;
                            
                            const nextIndex = (currentIndex + 1) % window.currentVods.length;
                            document.getElementById('nextPlayingTitle').innerText = obsShuffle ? 'Shuffle Active (Random)' : window.currentVods[nextIndex].title;
                        } else {
                            if (info) info.style.display = 'none';
                        }
                    }
                } else {
                    // Hide info if stopped or duration is 0
                    if (info) info.style.display = 'none';
                    seekBar.value = 0;
                    currentTimeEl.innerText = '00:00:00';
                }
            } catch(e) {}
        }, 1000);

        if (typeof OBSWebSocket !== 'undefined') {
            obs = new OBSWebSocket();
            obs.on('ConnectionClosed', () => {
                obsConnected = false;
                obsStatus.innerText = 'Connection Closed';
                obsConfigCard.style.display = 'block';
                obsRemoteCard.style.display = 'none';
            });
        }
        /* END OBS REMOTE LOGIC */

        async function loadSettings() {
            try {
                // Overlay links
                document.getElementById('followOverlayUrl').innerText = window.location.origin + '/overlay/followers';
                document.getElementById('subOverlayUrl').innerText = window.location.origin + '/overlay/subs';
                document.getElementById('recentOverlayUrl').innerText = window.location.origin + '/overlay/recent-followers';
                document.getElementById('countdownLink').innerText = window.location.origin + '/overlay/countdown';

                // Previews
                document.getElementById('followPreview').src = '/overlay/followers';
                document.getElementById('subPreview').src = '/overlay/subs';
                document.getElementById('recentPreview').src = '/overlay/recent-followers';
                document.getElementById('countdownPreview').src = '/overlay/countdown';
                
                // Fetch saved settings
                const res = await fetch('/api/twitch/stats/settings');
                const settings = await res.json();
                if (settings) {
                    if (settings.hasToken) {
                        document.getElementById('twStatToken').placeholder = 'Token Saved (' + settings.username + ')';
                    }
                    document.getElementById('twFollowerGoal').value = settings.followerGoal || '';
                    document.getElementById('twSubGoal').value = settings.subGoal || '';
                    
                    if (settings.followerColor) {
                        document.getElementById('twFollowerColor').value = settings.followerColor;
                        document.getElementById('twFollowerHex').value = settings.followerColor;
                    }
                    if (settings.subColor) {
                        document.getElementById('twSubColor').value = settings.subColor;
                        document.getElementById('twSubHex').value = settings.subColor;
                    }
                    if (settings.followerTextColor) {
                        document.getElementById('twFollowerTextColor').value = settings.followerTextColor;
                        document.getElementById('twFollowerTextHex').value = settings.followerTextColor;
                    }
                    if (settings.subTextColor) {
                        document.getElementById('twSubTextColor').value = settings.subTextColor;
                        document.getElementById('twSubTextHex').value = settings.subTextColor;
                    }
                    if (settings.labelSize) {
                        document.getElementById('twLabelSize').value = settings.labelSize;
                        document.getElementById('labelSizeVal').innerText = settings.labelSize;
                    }
                    if (settings.valueSize) {
                        document.getElementById('twValueSize').value = settings.valueSize;
                        document.getElementById('valueSizeVal').innerText = settings.valueSize;
                    }
                    if (settings.goalSize) {
                        document.getElementById('twGoalSize').value = settings.goalSize;
                        document.getElementById('goalSizeVal').innerText = settings.goalSize;
                    }
                    if (settings.scrollSpeed) {
                        document.getElementById('twScrollSpeed').value = settings.scrollSpeed;
                        document.getElementById('scrollSpeedVal').innerText = settings.scrollSpeed;
                    }
                    if (settings.followerCount) {
                        document.getElementById('twFollowerCount').value = settings.followerCount;
                        document.getElementById('followerCountVal').innerText = settings.followerCount;
                    }
                    if (settings.pollingInterval) {
                        document.getElementById('twPollingInterval').value = settings.pollingInterval;
                        document.getElementById('pollingVal').innerText = settings.pollingInterval;
                    }
                    if (settings.obsAddress) document.getElementById('obsAddress').value = settings.obsAddress;
                    if (settings.liveTimer) document.getElementById('twLiveTime').value = settings.liveTimer;
                    if (settings.liveTimerLabel) document.getElementById('twLiveLabel').value = settings.liveTimerLabel;
                    if (settings.liveTimerTZ) document.getElementById('twLiveTZ').value = settings.liveTimerTZ;
                    
                    if (settings.timerColor) {
                        document.getElementById('twTimerColor').value = settings.timerColor;
                        document.getElementById('twTimerHex').value = settings.timerColor;
                    }
                    if (settings.timerLabelColor) {
                        document.getElementById('twTimerLabelColor').value = settings.timerLabelColor;
                        document.getElementById('twTimerLabelHex').value = settings.timerLabelColor;
                    }
                    if (settings.timerSize) {
                        document.getElementById('twTimerSize').value = settings.timerSize;
                        document.getElementById('timerSizeVal').innerText = settings.timerSize;
                    }
                    if (settings.timerLabelSize) {
                        document.getElementById('twTimerLabelSize').value = settings.timerLabelSize;
                        document.getElementById('timerLabelSizeVal').innerText = settings.timerLabelSize;
                    }
                    if (settings.obsAddress) document.getElementById('obsAddress').value = settings.obsAddress;
                    if (settings.obsPassword) document.getElementById('obsPassword').value = settings.obsPassword;
                    if (settings.obsSourceName) document.getElementById('obsSourceName').value = settings.obsSourceName;
                    
                    // Restore connection mode
                    const savedMode = settings.obsMode || 'local';
                    document.getElementById('obsMode').value = savedMode;
                    if (savedMode === 'remote') {
                        const savedRemote = localStorage.getItem('obsRemoteAddress') || settings.obsAddress || '';
                        document.getElementById('obsAddress').value = savedRemote;
                        document.getElementById('obsAddressHint').innerHTML = 'e.g. pgp-kits-retro-railway.trycloudflare.com or obscontrol.ddns.net:44555';
                        document.getElementById('obsAddressLabel').innerText = 'OBS Address (Remote)';
                    }
                }
            } catch(e) {}
        }

        // Auto-save & sync
        const autoSave = (previewIds) => saveTwitchStats(null, previewIds);
        
        document.getElementById('twFollowerColor').oninput = (e) => {
            document.getElementById('twFollowerHex').value = e.target.value;
            autoSave(['followPreview']);
        };
        document.getElementById('twSubColor').oninput = (e) => {
            document.getElementById('twSubHex').value = e.target.value;
            autoSave(['subPreview']);
        };
        document.getElementById('twFollowerHex').onchange = (e) => {
            document.getElementById('twFollowerColor').value = e.target.value;
            autoSave(['followPreview']);
        };
        document.getElementById('twSubHex').onchange = (e) => {
            document.getElementById('twSubColor').value = e.target.value;
            autoSave(['subPreview']);
        };

        document.getElementById('twFollowerTextColor').oninput = (e) => {
            document.getElementById('twFollowerTextHex').value = e.target.value;
            autoSave(['followPreview']);
        };
        document.getElementById('twSubTextColor').oninput = (e) => {
            document.getElementById('twSubTextHex').value = e.target.value;
            autoSave(['subPreview']);
        };
        document.getElementById('twFollowerTextHex').onchange = (e) => {
            document.getElementById('twFollowerTextColor').value = e.target.value;
            autoSave(['followPreview']);
        };
        document.getElementById('twSubTextHex').onchange = (e) => {
            document.getElementById('twSubTextColor').value = e.target.value;
            autoSave(['subPreview']);
        };
        
        document.getElementById('twFollowerGoal').onchange = () => autoSave(['followPreview']);
        document.getElementById('twSubGoal').onchange = () => autoSave(['subPreview']);
        document.getElementById('twLabelSize').onchange = () => autoSave(['followPreview', 'subPreview']);
        document.getElementById('twValueSize').onchange = () => autoSave(['followPreview', 'subPreview']);
        document.getElementById('twGoalSize').onchange = () => autoSave(['followPreview', 'subPreview']);
        document.getElementById('twScrollSpeed').onchange = () => autoSave(['recentPreview']);
        document.getElementById('twFollowerCount').onchange = () => autoSave(['recentPreview']);
        document.getElementById('twPollingInterval').onchange = () => autoSave(['recentPreview']);
        document.getElementById('twLiveTime').onchange = () => autoSave(['countdownPreview']);
        document.getElementById('twLiveLabel').onchange = () => autoSave(['countdownPreview']);
        document.getElementById('twLiveTZ').onchange = () => autoSave(['countdownPreview']);

        document.getElementById('twTimerColor').oninput = (e) => {
            document.getElementById('twTimerHex').value = e.target.value;
            autoSave(['countdownPreview']);
        };
        document.getElementById('twTimerHex').onchange = (e) => {
            document.getElementById('twTimerColor').value = e.target.value;
            autoSave(['countdownPreview']);
        };
        document.getElementById('twTimerLabelColor').oninput = (e) => {
            document.getElementById('twTimerLabelHex').value = e.target.value;
            autoSave(['countdownPreview']);
        };
        document.getElementById('twTimerLabelHex').onchange = (e) => {
            document.getElementById('twTimerLabelColor').value = e.target.value;
            autoSave(['countdownPreview']);
        };
        document.getElementById('twTimerSize').onchange = () => autoSave(['countdownPreview']);
        document.getElementById('twTimerLabelSize').onchange = () => autoSave(['countdownPreview']);
        
        // OBS Auto-save
        const saveObsSettings = async () => {
            const address = document.getElementById('obsAddress').value.trim();
            const password = document.getElementById('obsPassword').value;
            const sourceName = document.getElementById('obsSourceName').value;
            const mode = document.getElementById('obsMode').value;
            await fetch('/api/obs/settings', {
                method: 'POST',
                body: JSON.stringify({ address, password, sourceName, mode }),
                headers: { 'Content-Type': 'application/json' }
            });
        };
        
        function toggleObsMode() {
            const mode = document.getElementById('obsMode').value;
            const addressInput = document.getElementById('obsAddress');
            const hint = document.getElementById('obsAddressHint');
            const label = document.getElementById('obsAddressLabel');
            
            if (mode === 'local') {
                addressInput.value = 'localhost:44555';
                hint.innerHTML = 'e.g. localhost:44555';
                label.innerText = 'OBS Address (Local)';
            } else {
                // Restore saved remote address or prompt
                const saved = localStorage.getItem('obsRemoteAddress') || '';
                addressInput.value = saved;
                hint.innerHTML = 'e.g. pgp-kits-retro-railway.trycloudflare.com or obscontrol.ddns.net:44555';
                label.innerText = 'OBS Address (Remote)';
            }
            saveObsSettings();
        }
        
        document.getElementById('obsAddress').onchange = () => {
            const mode = document.getElementById('obsMode').value;
            if (mode === 'remote') {
                localStorage.setItem('obsRemoteAddress', document.getElementById('obsAddress').value.trim());
            }
            saveObsSettings();
        };
        document.getElementById('obsPassword').onchange = saveObsSettings;
        document.getElementById('obsSourceName').onchange = saveObsSettings;

        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addVod(); });
        loadVods();
        loadSettings();
    </script>
</body>
</html>
  `);
});

export const onRequest = handle(app);
