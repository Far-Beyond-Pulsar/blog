const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function PostCard({ post, featured = false }) {
  const href = `${BASE}/${post.slug}`;

  if (featured) {
    return (
      <a
        href={href}
        className="group block bg-[#080808] border border-white/[0.07] rounded-2xl p-8 mb-4 hover:border-white/[0.14] hover:bg-[#0a0a0a] transition-all duration-200"
      >
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide bg-[#0ea5e9]/15 border border-[#0ea5e9]/25 text-[#0ea5e9] uppercase">
            Latest
          </span>
          {post.tags.slice(0, 3).map(tag => (
            <span key={tag} className="text-xs text-white/30">{tag}</span>
          ))}
        </div>

        <h2 className="text-2xl sm:text-3xl font-bold text-white group-hover:text-white/90 transition-colors mb-3 leading-snug">
          {post.title}
        </h2>
        <p className="text-white/45 text-base leading-relaxed mb-6 max-w-2xl">
          {post.description}
        </p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm text-white/30">
            <span>{post.author}</span>
            <span>·</span>
            <time>{formatDate(post.date)}</time>
            <span>·</span>
            <span>{post.readingTime} min read</span>
          </div>
          <span className="text-[#0ea5e9] text-sm font-medium group-hover:underline">
            Read →
          </span>
        </div>
      </a>
    );
  }

  return (
    <a
      href={href}
      className="group flex items-start justify-between gap-6 py-6 border-b border-white/[0.05] last:border-0 hover:bg-white/[0.02] -mx-3 px-3 rounded-lg transition-colors"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          {post.tags.slice(0, 2).map(tag => (
            <span key={tag} className="text-[11px] text-white/30 font-medium">{tag}</span>
          ))}
        </div>
        <h2 className="text-base font-semibold text-white/85 group-hover:text-white transition-colors mb-1 leading-snug">
          {post.title}
        </h2>
        <p className="text-sm text-white/40 leading-relaxed line-clamp-2">
          {post.description}
        </p>
      </div>

      <div className="shrink-0 text-right hidden sm:block">
        <time className="text-xs text-white/25 whitespace-nowrap">{formatDate(post.date)}</time>
        <p className="text-xs text-white/20 mt-1">{post.readingTime} min</p>
      </div>
    </a>
  );
}
