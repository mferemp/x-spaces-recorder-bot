import axios from 'axios';

const SPACE_ID = /(?:x|twitter)\.com\/(?:i\/spaces|[^/]+\/status)\/([0-9A-Za-z]+)/i;

export function extractSpaceId(input) {
  const match = input.match(SPACE_ID);
  return match?.[1] || null;
}

function authHeaders() {
  const bearer = process.env.X_BEARER_TOKEN;
  const guest = process.env.X_GUEST_TOKEN;
  const cookie = process.env.X_COOKIE;
  const headers = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    accept: 'application/json, text/plain, */*'
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (guest) headers['x-guest-token'] = guest;
  if (cookie) headers.cookie = cookie;
  return headers;
}

export async function resolveSpace(spaceId) {
  const urls = [
    `https://api.x.com/2/spaces/${spaceId}?space.fields=created_at,ended_at,host_ids,lang,participant_count,scheduled_start,state,title`,
    `https://api.twitter.com/2/spaces/${spaceId}?space.fields=created_at,ended_at,host_ids,lang,participant_count,scheduled_start,state,title`
  ];

  let data;
  let lastError;
  for (const url of urls) {
    try {
      const response = await axios.get(url, { headers: authHeaders(), timeout: 15000 });
      data = response.data?.data;
      if (data) break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!data) {
    const detail = lastError?.response?.status === 401 || lastError?.response?.status === 403
      ? 'X denied metadata access. Add a current X_BEARER_TOKEN or X_GUEST_TOKEN in your host environment variables, then retry.'
      : 'The Space could not be found or X is temporarily unavailable.';
    throw new Error(detail);
  }

  const playlistUrl = findPlaylist(data);
  if (!playlistUrl) {
    throw new Error('X returned Space metadata but no public audio playlist. The Space may be unavailable, ended without replay, private, geo-restricted, or require an updated resolver token/cookie.');
  }

  return {
    id: spaceId,
    title: data.title || `X Space ${spaceId}`,
    state: data.state || 'unknown',
    playlistUrl,
    raw: data
  };
}

function findPlaylist(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && (item.includes('.m3u8') || key.toLowerCase().includes('playlist'))) return item;
    if (item && typeof item === 'object') {
      const candidate = findPlaylist(item);
      if (candidate) return candidate;
    }
  }
  return null;
}
