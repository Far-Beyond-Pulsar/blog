import { getBlogIndex } from "@/utils/blog";
import PostCard from "@/components/PostCard";

export const metadata = {
  title: "Pulsar Blog",
  description:
    "Engineering updates, deep dives, and release notes from the Pulsar game engine team.",
};

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || "";

export default function BlogHome() {
  const { posts, allTags, total } = getBlogIndex();

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Hero */}
      <div className="border-b border-white/[0.07] bg-[#030303]">
        <div className="max-w-5xl mx-auto px-5 pt-20 pb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#0ea5e9]/25 bg-[#0ea5e9]/10 text-[#0ea5e9] text-xs font-semibold tracking-wide mb-6">
            Engineering Blog
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight mb-4">
            From the Pulsar team
          </h1>
          <p className="text-white/45 text-base sm:text-lg max-w-2xl leading-relaxed">
            Deep dives into renderer architecture, ECS design, Rust patterns,
            and everything else we learn building a GPU-driven game engine from
            scratch.
          </p>
          <p className="text-xs text-white/20 mt-6">
            {total} {total === 1 ? "post" : "posts"} published
          </p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-14">
        {/* Tag filter row */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-12">
            <a
              href="/"
              className="px-3 py-1 rounded-full text-xs font-medium bg-[#0ea5e9] text-white transition-colors"
            >
              All
            </a>
            {allTags.map((tag) => (
              <a
                key={tag}
                href={`${BASE}/tags/${tag}`}
                className="px-3 py-1 rounded-full text-xs font-medium bg-white/[0.06] text-white/50 hover:bg-white/[0.1] hover:text-white/80 transition-colors"
              >
                {tag}
              </a>
            ))}
          </div>
        )}

        {/* Post list */}
        {posts.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-white/30 text-sm">
              No posts yet. Add markdown files to{" "}
              <code className="font-mono text-white/50">public/posts/</code>
            </p>
          </div>
        ) : (
          <div className="space-y-px">
            {posts.map((post, i) => (
              <PostCard key={post.slug} post={post} featured={i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
