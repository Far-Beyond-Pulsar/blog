/**
 * Single source of truth for how this site addresses itself.
 *
 * Social scrapers (Facebook, X, LinkedIn, Slack, Discord, iMessage) will not
 * follow a relative og:image — the URL has to be absolute, scheme and all.
 * Because this is a static export served under a basePath, every outward-facing
 * URL has to be assembled as SITE_URL + BASE_PATH + path, and getting any of
 * those three wrong fails silently: the tags render, the crawler fetches
 * nothing, the card shows up bare. So it happens in exactly one place.
 */

/** Origin only, no trailing slash: "https://pulsarnative.com". */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '');

/** Subdirectory the app is mounted at, no trailing slash: "/blog". */
export const BASE_PATH = (process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '').replace(/\/$/, '');

/** Public root of the blog itself: "https://pulsarnative.com/blog". */
export const SITE_ORIGIN_WITH_BASE = `${SITE_URL}${BASE_PATH}`;

export const SITE_NAME = 'Pulsar Blog';

export const SITE_DESCRIPTION =
  "What we're building, breaking, and fixing inside the Pulsar game engine — renderer deep dives, Rust patterns, and everything we learn along the way.";

/**
 * Fallback card image for pages with no thumbnail of their own.
 * Square rather than 1.91:1, so it degrades to a small card instead of a
 * letterboxed wide one — which is the better failure mode.
 */
export const DEFAULT_OG_IMAGE = {
  path: '/assets/pulsar.png',
  width: 503,
  height: 496,
  alt: 'Pulsar Engine',
};

/**
 * Absolute URL for a site-relative path.
 *
 * Accepts paths with or without BASE_PATH already applied, and passes through
 * anything already absolute. The index generator prepends BASE_PATH to
 * thumbnails; page code generally does not. Both must land on the same string,
 * so the base is detected rather than assumed.
 */
export function absoluteUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;

  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;

  // Already carries the base path — don't apply it twice.
  if (BASE_PATH && (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`))) {
    return `${SITE_URL}${path}`;
  }
  return `${SITE_URL}${BASE_PATH}${path}`;
}

/** Canonical absolute URL for a post. */
export function postUrl(slug: string): string {
  return `${SITE_ORIGIN_WITH_BASE}/${slug}`;
}

/** Canonical absolute URL for a tag archive. */
export function tagUrl(tag: string): string {
  return `${SITE_ORIGIN_WITH_BASE}/tags/${encodeURIComponent(tag)}`;
}

type OgImage = { url: string; width?: number; height?: number; alt: string };

/**
 * Resolve a post's card image, falling back to the site default.
 *
 * Width and height are emitted when known (the index generator reads them out
 * of the file header at build time). Slack and LinkedIn in particular will lay
 * out the card from these without waiting on the image fetch, and a card that
 * renders immediately is the difference between a link that looks intentional
 * and one that looks broken.
 */
export function resolveOgImage(
  thumbnail?: string | null,
  width?: number | null,
  height?: number | null,
  alt?: string,
): OgImage {
  const url = absoluteUrl(thumbnail);
  if (url) {
    return {
      url,
      ...(width && height ? { width, height } : {}),
      alt: alt || SITE_NAME,
    };
  }
  return {
    url: absoluteUrl(DEFAULT_OG_IMAGE.path)!,
    width: DEFAULT_OG_IMAGE.width,
    height: DEFAULT_OG_IMAGE.height,
    alt: DEFAULT_OG_IMAGE.alt,
  };
}
