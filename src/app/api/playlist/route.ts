import { getRequestContext } from '@cloudflare/next-on-pages';
import { getTwitchVodPlaylist } from '@/lib/twitch';

export const runtime = 'edge';

export async function GET() {
  const { env } = getRequestContext() as any;
  
  let vods = [];
  try {
    const vodData = await env.RERUN_STORE.get('vod_list');
    vods = vodData ? JSON.parse(vodData) : [];
  } catch (e) {
    console.error('Error fetching VOD list from KV:', e);
  }

  if (vods.length === 0) {
    return new Response('#EXTM3U\n', {
      headers: { 'Content-Type': 'audio/x-mpegurl' },
    });
  }

  // Resolve VODs to their stream URLs
  const resolvedVods = await Promise.all(
    vods.map(async (vod: any) => {
      try {
        const streamUrl = await getTwitchVodPlaylist(vod.id);
        return { ...vod, streamUrl };
      } catch (e) {
        return { ...vod, streamUrl: null };
      }
    })
  );

  let m3u = '#EXTM3U\n';
  for (const vod of resolvedVods) {
    if (vod.streamUrl) {
      m3u += `#EXTINF:-1,${vod.title}\n${vod.streamUrl}\n`;
    }
  }

  return new Response(m3u, {
    headers: {
      'Content-Type': 'audio/x-mpegurl',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
