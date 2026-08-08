import { notFound } from 'next/navigation';
import { getBlogIndex } from '@/utils/blog';
import PostCard from '@/components/PostCard';
import { SITE_NAME, SITE_DESCRIPTION, tagUrl, resolveOgImage } from '@/utils/site';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

export async function generateStaticParams() {
  const { allTags } = getBlogIndex();
  return allTags.map((tag: string) => ({ tag }));
}

export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const { posts } = getBlogIndex();
  const count = posts.filter((p: { tags: string[] }) => p.tags.includes(tag)).length;

  const title = `Posts tagged "${tag}"`;
  const description = `${count} ${count === 1 ? 'post' : 'posts'} tagged "${tag}" on ${SITE_NAME} — ${SITE_DESCRIPTION}`;
  const url = tagUrl(tag);

  // Lead with the newest tagged post's thumbnail so a shared tag archive gets a
  // card that reflects its contents rather than the generic site image.
  const newest = posts.find((p: { tags: string[] }) => p.tags.includes(tag));
  const image = resolveOgImage(newest?.thumbnail, newest?.thumbnailWidth, newest?.thumbnailHeight, title);

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      url,
      locale: 'en_US',
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [image.url],
    },
  };
}

export default async function TagPage({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  const { posts, allTags } = getBlogIndex();

  if (!allTags.includes(tag)) notFound();

  const filtered = posts.filter((p: { tags: string[] }) => p.tags.includes(tag));

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="border-b border-white/[0.07] bg-[#030303]">
        <div className="max-w-5xl mx-auto px-5 pt-16 pb-12">
          <a
            href={`${BASE}/`}
            className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-white/35 hover:text-white/70 transition-colors mb-8"
          >
            ← All posts
          </a>
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40 mb-4">
            <span className="w-8 h-px bg-[#38bdf8]/70" />
            Tag Archive
          </p>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">
              <span className="text-white/30">#</span>{tag}
            </h1>
            <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/25">{filtered.length} {filtered.length === 1 ? 'post' : 'posts'}</span>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-14">
        {/* Tag filter row */}
        <div className="flex flex-wrap gap-2 mb-12">
          <a href={`${BASE}/`} className="px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] bg-white/[0.06] text-white/50 hover:bg-white/[0.1] hover:text-white/80 transition-colors">
            All
          </a>
          {allTags.map((t: string) => (
            <a
              key={t}
              href={`${BASE}/tags/${t}`}
              className={`px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${
                t === tag
                  ? 'bg-[#0ea5e9] text-white'
                  : 'bg-white/[0.06] text-white/50 hover:bg-white/[0.1] hover:text-white/80'
              }`}
            >
              {t}
            </a>
          ))}
        </div>

        <div className="space-y-px">
          {filtered.map((post: any, i: number) => (
            <PostCard key={post.slug} post={post} featured={i === 0 && filtered.length > 1} />
          ))}
        </div>
      </div>
    </div>
  );
}
