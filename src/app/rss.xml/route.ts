import { getBlogIndex } from '@/utils/blog';
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN_WITH_BASE,
  postUrl,
} from '@/utils/site';

type FeedPost = {
  slug: string;
  title: string;
  date: string;
  description?: string;
  tags?: string[];
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function GET() {
  const { posts } = getBlogIndex() as { posts: FeedPost[] };
  const items = posts
    .map((post) => {
      const url = postUrl(post.slug);
      const pubDate = new Date(`${post.date}T00:00:00Z`).toUTCString();

      return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <description>${escapeXml(post.description || '')}</description>
      <pubDate>${pubDate}</pubDate>
      ${(post.tags || []).map((tag) => `<category>${escapeXml(tag)}</category>`).join('\n      ')}
    </item>`;
    })
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(SITE_NAME)}</title>
    <link>${escapeXml(SITE_ORIGIN_WITH_BASE)}</link>
    <description>${escapeXml(SITE_DESCRIPTION)}</description>
    <language>en-us</language>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
