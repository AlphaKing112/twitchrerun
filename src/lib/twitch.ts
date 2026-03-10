export async function getTwitchVodPlaylist(vodId: string) {
  const GQL_URL = "https://gql.twitch.tv/gql";
  const CLIENT_ID = "kimne78kx3ncx6brs4s58wrn98p417";

  try {
    const response = await fetch(GQL_URL, {
      method: "POST",
      headers: {
        "Client-ID": CLIENT_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          operationName: "PlaybackAccessToken",
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash:
                "0828119ded1c13477966434e15800ff57dd2a3933f122117185573f5d51bcbbd",
            },
          },
          variables: {
            isLive: false,
            login: "",
            isVod: true,
            vodID: vodId,
            playerType: "embed",
          },
        },
      ]),
    });

    const data = (await response.json()) as { data?: { videoPlaybackAccessToken?: { value: string; signature: string } } }[];
    const tokenData = data[0]?.data?.videoPlaybackAccessToken;

    if (!tokenData) {
      console.error("No token data for VOD:", vodId, data);
      return null;
    }

    const { value: token, signature: sig } = tokenData;
    const playlistUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauthor=twitch&allow_source=true&player=twitchweb&playlist_include_framerate=true&reassignments_supported=true&sig=${sig}&token=${encodeURIComponent(token)}`;

    return playlistUrl;
  } catch (error) {
    console.error("Error fetching Twitch VOD playlist:", error);
    return null;
  }
}

export function extractVodId(url: string): string | null {
  const match = url.match(/(?:\/videos\/|v=)(\d+)/);
  return match ? match[1] : url.match(/^\d+$/) ? url : null;
}
