import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getBlogIndex, getPostMeta, getPostContent, extractHeadings } from '@/utils/blog';
import { getAuthors } from '@/utils/authors';
import BlogMarkdown from '@/components/BlogMarkdown';
import TableOfContents from '@/components/TableOfContents';
import AuthorAvatars from '@/components/AuthorAvatars';
import AuthorFooter from '@/components/AuthorFooter';
import { SITE_NAME, SITE_ORIGIN_WITH_BASE, postUrl, resolveOgImage, absoluteUrl } from '@/utils/site';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

type Author = { login: string; name?: string; html_url?: string };

export async function generateStaticParams() {
  const { posts } = getBlogIndex();
  return posts.map((p: { slug: string }) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const meta = getPostMeta(slug);
  if (!meta) return { title: 'Not Found' };

  const url = postUrl(slug);
  const image = resolveOgImage(meta.thumbnail, meta.thumbnailWidth, meta.thumbnailHeight, meta.title);
  const authorNames: string[] = (meta.authorData?.length ? meta.authorData.map((a: Author) => a.name || a.login) : meta.author) || [];

  return {
    title: meta.title,
    description: meta.description,
    authors: authorNames.map((name) => ({ name })),
    keywords: meta.tags,
    alternates: {
      canonical: url,
      // Discord looks for an oEmbed document and, when it finds one, renders
      // the author byline above the embed title. Static JSON, generated per
      // post at build time.
      types: { 'application/json+oembed': `${SITE_ORIGIN_WITH_BASE}/oembed/${slug}.json` },
    },
    openGraph: {
      type: 'article',
      siteName: SITE_NAME,
      title: meta.title,
      description: meta.description,
      url,
      locale: 'en_US',
      publishedTime: meta.date,
      modifiedTime: meta.date,
      authors: authorNames,
      tags: meta.tags,
      // Explicit dimensions let Slack, LinkedIn and Discord reserve the card
      // layout before the image lands, instead of reflowing or giving up.
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title: meta.title,
      description: meta.description,
      images: [image.url],
    },
    other: {
      // Discord surfaces this as the small grey line above the title.
      'article:author': authorNames.join(', '),
    },
  };
}

function formatDate(dateStr: string) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = getPostMeta(slug);
  const content = getPostContent(slug);

  if (!meta || content === null) notFound();

  const headings = extractHeadings(content);
  const authorList = getAuthors(meta.author || 'Pulsar Team');

  // Structured data for search engines. Social scrapers ignore this and read
  // the OG tags instead — the two describe the same post and must not disagree.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: meta.title,
    description: meta.description,
    image: [resolveOgImage(meta.thumbnail, meta.thumbnailWidth, meta.thumbnailHeight, meta.title).url],
    datePublished: meta.date,
    dateModified: meta.date,
    author: authorList.map((a: Author) => ({
      '@type': 'Person',
      name: a.name || a.login,
      url: a.html_url,
    })),
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: { '@type': 'ImageObject', url: absoluteUrl('/assets/pulsar.png') },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': postUrl(slug) },
    keywords: meta.tags?.join(', '),
    wordCount: meta.wordCount,
  };

  return (
    <div className="min-h-screen bg-black text-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Post header */}
      <div className="relative border-b border-white/[0.07] overflow-hidden">
        {/* Thumbnail background */}
        {meta.thumbnail && (
          <>
            <img
              src={meta.thumbnail}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover object-center"
            />
            {/* dark overlay so text stays readable */}
            <div className="absolute inset-0 bg-black/65" />
          </>
        )}

        {/* Fallback background when no thumbnail */}
        {!meta.thumbnail && <div className="absolute inset-0 bg-[#030303]" />}

        <div className="relative max-w-5xl mx-auto px-5 pt-16 pb-12">
          <a
            href={`${BASE}/`}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-white/35 hover:text-white/70 transition-colors mb-8"
          >
            ← Back to blog
          </a>

          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40 mb-5">
            <span className="w-8 h-px bg-[#38bdf8]/70" />
            {meta.tags[0] || 'Post'}
          </p>

          {meta.tags.length > 1 && (
            <div className="flex flex-wrap gap-2 mb-5">
              {meta.tags.slice(1).map((tag: string) => (
                <a
                  key={tag}
                  href={`${BASE}/tags/${tag}`}
                  className="px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] bg-white/[0.06] text-white/50 hover:bg-white/[0.12] hover:text-white/80 transition-colors"
                >
                  {tag}
                </a>
              ))}
            </div>
          )}

          <h1 className="text-3xl sm:text-4xl font-bold leading-tight mb-4">{meta.title}</h1>

          {meta.description && (
            <p className="text-white/60 text-lg leading-relaxed mb-6 max-w-2xl">{meta.description}</p>
          )}

          <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-white/40">
            <AuthorAvatars authors={authorList} />
            <span>·</span>
            <time>{formatDate(meta.date)}</time>
            <span>·</span>
            <span>{meta.readingTime} min read</span>
          </div>
        </div>
      </div>

      {/* Two-column layout: content + TOC */}
      <div className="max-w-5xl mx-auto px-5 py-14">
        <div className="flex gap-14 items-start">

          {/* Main content */}
          <div className="flex-1 min-w-0">
            <BlogMarkdown content={content} slug={slug} />

            {/* Author details */}
            <AuthorFooter authors={authorList} />

            {/* Footer nav */}
            <div className="mt-10 pt-8 border-t border-white/[0.07] flex items-center justify-between">
              <a
                href={`${BASE}/`}
                className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/40 hover:text-white/70 transition-colors"
              >
                ← Back to blog
              </a>
              <a
                href="https://github.com/Far-Beyond-Pulsar/Pulsar-Native/discussions"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#0ea5e9] hover:underline"
              >
                Continue the discussion on GitHub →
              </a>
            </div>
          </div>

          {/* TOC — stickiness is handled inside the component */}
          {headings.length > 0 && (
            <aside className="hidden xl:block w-56 shrink-0 self-start sticky top-20">
              <TableOfContents headings={headings} />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
