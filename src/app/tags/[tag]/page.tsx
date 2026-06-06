import { notFound } from 'next/navigation';
import { getBlogIndex } from '@/utils/blog';
import PostCard from '@/components/PostCard';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

export async function generateStaticParams() {
  const { allTags } = getBlogIndex();
  return allTags.map((tag: string) => ({ tag }));
}

export async function generateMetadata({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return { title: `Posts tagged "${tag}"` };
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
            className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white/70 transition-colors mb-8"
          >
            ← All posts
          </a>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">
              <span className="text-white/30">#</span>{tag}
            </h1>
            <span className="text-sm text-white/25">{filtered.length} {filtered.length === 1 ? 'post' : 'posts'}</span>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-14">
        {/* Tag filter row */}
        <div className="flex flex-wrap gap-2 mb-12">
          <a href={`${BASE}/`} className="px-3 py-1 rounded-full text-xs font-medium bg-white/[0.06] text-white/50 hover:bg-white/[0.1] hover:text-white/80 transition-colors">
            All
          </a>
          {allTags.map((t: string) => (
            <a
              key={t}
              href={`${BASE}/tags/${t}`}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
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
