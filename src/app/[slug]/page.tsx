import { notFound } from 'next/navigation';
import { getBlogIndex, getPostMeta, getPostContent, extractHeadings } from '@/utils/blog';
import BlogMarkdown from '@/components/BlogMarkdown';
import TableOfContents from '@/components/TableOfContents';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

export async function generateStaticParams() {
  const { posts } = getBlogIndex();
  return posts.map((p: { slug: string }) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const meta = getPostMeta(slug);
  if (!meta) return { title: 'Not Found' };
  return {
    title: meta.title,
    description: meta.description,
    openGraph: {
      title: meta.title,
      description: meta.description,
      type: 'article',
      publishedTime: meta.date,
      tags: meta.tags,
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

  return (
    <div className="min-h-screen bg-black text-white">

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
            className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white/70 transition-colors mb-8"
          >
            ← All posts
          </a>

          {meta.tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-5">
              {meta.tags.map((tag: string) => (
                <a
                  key={tag}
                  href={`${BASE}/tags/${tag}`}
                  className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-white/[0.08] text-white/60 hover:bg-white/[0.14] hover:text-white/90 transition-colors"
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

          <div className="flex items-center gap-3 text-sm text-white/40">
            <span className="font-medium text-white/60">{meta.author}</span>
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
            <BlogMarkdown content={content} />

            {/* Footer nav */}
            <div className="mt-16 pt-8 border-t border-white/[0.07] flex items-center justify-between">
              <a
                href={`${BASE}/`}
                className="text-sm text-white/40 hover:text-white/70 transition-colors"
              >
                ← All posts
              </a>
              <a
                href="https://github.com/Far-Beyond-Pulsar/Pulsar-Native/discussions"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#0ea5e9] hover:underline"
              >
                Discuss on GitHub →
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
