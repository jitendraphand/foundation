/**
 * Turning an admin-supplied video URL into something safe to put on the page.
 *
 * Embedding an arbitrary URL in an iframe hands that origin a frame inside our
 * own page, so this never happens. Only YouTube and Vimeo are recognised, and
 * only their official player origins are ever framed - and even then inside a
 * sandboxed iframe. Anything else becomes a plain link that opens in a new tab,
 * which is honest about what it is and costs the student one click.
 *
 * Pure functions with no I/O, so the parsing rules are testable directly.
 */

export type VideoProvider = 'youtube' | 'vimeo' | 'external';

export interface ParsedVideo {
  provider: VideoProvider;
  /** The URL the student is sent to, or that is framed. Always https. */
  url: string;
  /** Present only for youtube/vimeo: the safe player URL to frame. */
  embedUrl: string | null;
  /** Provider's video id, for the record. */
  videoId: string | null;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;

/**
 * Parses and normalises. Throws with a readable message rather than silently
 * accepting something that will not play.
 */
export function parseVideoUrl(raw: string): ParsedVideo {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Enter a video link.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('That does not look like a web address. It should start with https://');
  }

  // Only ever http(s). Blocks javascript:, data:, file: and friends outright.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('A video link must start with https://');
  }
  // Upgrade http to https: these players all serve https, and a mixed-content
  // frame would be blocked by the browser anyway.
  url.protocol = 'https:';

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  // --- YouTube -------------------------------------------------------------
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    let id = url.searchParams.get('v');
    if (!id) {
      // /embed/ID, /v/ID, /live/ID, /shorts/ID
      const match = /^\/(?:embed|v|live|shorts)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
      id = match?.[1] ?? null;
    }
    if (!id || !YOUTUBE_ID.test(id)) {
      throw new Error('That YouTube link does not contain a video id. Copy the address from the browser bar while the video is playing.');
    }
    return youtube(id, url);
  }

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (!YOUTUBE_ID.test(id)) throw new Error('That YouTube link does not contain a valid video id.');
    return youtube(id, url);
  }

  // --- Vimeo ---------------------------------------------------------------
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const match = /(\d{6,12})/.exec(url.pathname);
    const id = match?.[1];
    if (!id || !VIMEO_ID.test(id)) throw new Error('That Vimeo link does not contain a video id.');
    return {
      provider: 'vimeo',
      url: `https://vimeo.com/${id}`,
      embedUrl: `https://player.vimeo.com/video/${id}`,
      videoId: id,
    };
  }

  // --- Anything else -------------------------------------------------------
  // Not framed. The student gets a button that opens it in a new tab.
  return { provider: 'external', url: url.toString(), embedUrl: null, videoId: null };
}

function youtube(id: string, original: URL): ParsedVideo {
  // youtube-nocookie.com is YouTube's own privacy-enhanced player domain: it
  // does not set tracking cookies until the student actually presses play,
  // which matters when the audience is schoolchildren.
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
  embed.searchParams.set('rel', '0'); // no unrelated videos afterwards
  embed.searchParams.set('modestbranding', '1');

  // Preserve a start offset if the admin linked to a specific moment.
  const start = original.searchParams.get('t') ?? original.searchParams.get('start');
  const seconds = parseTimeOffset(start);
  if (seconds > 0) embed.searchParams.set('start', String(seconds));

  return {
    provider: 'youtube',
    url: `https://www.youtube.com/watch?v=${id}`,
    embedUrl: embed.toString(),
    videoId: id,
  };
}

/** YouTube writes offsets as "90", "1m30s" or "1h2m3s". */
export function parseTimeOffset(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value.trim().toLowerCase());
  if (!match || (!match[1] && !match[2] && !match[3])) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}
