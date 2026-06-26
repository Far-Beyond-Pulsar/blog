const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function Thumbnail({ src, alt, className }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt={alt || ''}
      className={className}
      loading="lazy"
      decoding="async"
    />
  );
}

export default function PostCard({ post, featured = false }) {
  const href = `${BASE}/${post.slug}`;

  if (featured) {
    return (
      <a
        href={href}
        className="group block bg-[#080808] border border-white/[0.07] rounded-2xl mb-6 hover:border-white/[0.14] hover:bg-[#0a0a0a] transition-all duration-200 overflow-hidden"
      >
        <div className="flex flex-col sm:flex-row">
          {/* Text side */}
          <div className="flex-1 p-8 flex flex-col justify-between min-w-0">
            <div>
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
              <p className="text-white/45 text-base leading-relaxed mb-6 max-w-2xl line-clamp-3">
                {post.description}
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-sm text-white/30">
                <span>{post.author}</span>
                <span>·</span>
                <time>{formatDate(post.date)}</time>
                <span>·</span>
                <span>{post.readingTime} min read</span>
              </div>
              <span className="text-[#0ea5e9] text-sm font-medium group-hover:underline shrink-0 ml-4">
                Read →
              </span>
            </div>
          </div>

          {/* Thumbnail side */}
          {post.thumbnail ? (
            <div className="sm:w-72 lg:w-96 shrink-0 sm:border-l border-t sm:border-t-0 border-white/[0.07] overflow-hidden">
              <Thumbnail
                src={post.thumbnail}
                alt={post.title}
                className="w-full h-52 sm:h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300"
              />
            </div>
          ) : (
            <div className="sm:w-72 lg:w-96 shrink-0 sm:border-l border-t sm:border-t-0 border-white/[0.07] bg-gradient-to-br from-[#0ea5e9]/10 to-[#0c4a6e]/20 flex items-center justify-center">
              <span className="text-[#0ea5e9]/20 text-7xl font-black select-none hidden sm:block">P</span>
            </div>
          )}
        </div>
      </a>
    );
  }

  // Grid card (non-featured)
  return (
    <a
      href={href}
      className="group flex flex-col bg-[#080808] border border-white/[0.07] rounded-xl overflow-hidden hover:border-white/[0.15] hover:bg-[#0a0a0a] transition-all duration-200"
    >
      {/* Thumbnail */}
      <div className="w-full aspect-[16/9] overflow-hidden bg-gradient-to-br from-[#0ea5e9]/10 to-[#0c4a6e]/20 shrink-0">
        {post.thumbnail ? (
          <Thumbnail
            src={post.thumbnail}
            alt={post.title}
            className="w-full h-full object-cover opacity-75 group-hover:opacity-100 group-hover:scale-[1.02] transition-all duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[#0ea5e9]/20 text-5xl font-black select-none">P</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-col flex-1 p-5">
        <div className="flex flex-wrap items-center gap-2 mb-2.5">
          {post.tags.slice(0, 2).map(tag => (
            <span key={tag} className="text-[11px] text-white/30 font-medium">{tag}</span>
          ))}
        </div>
        <h2 className="text-sm font-semibold text-white/85 group-hover:text-white transition-colors mb-1.5 leading-snug line-clamp-2">
          {post.title}
        </h2>
        <p className="text-xs text-white/40 leading-relaxed line-clamp-3 flex-1">
          {post.description}
        </p>

        <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.05]">
          <time className="text-[11px] text-white/25">{formatDate(post.date)}</time>
          <span className="text-[11px] text-white/20">{post.readingTime} min</span>
        </div>
      </div>
    </a>
  );
}
