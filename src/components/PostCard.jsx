'use client';

import { useState } from 'react';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function AuthorStack({ authors, size = 20 }) {
  const [hovered, setHovered] = useState(false);
  if (!authors || authors.length === 0) return null;
  const max = 3;
  const visible = authors.slice(0, max);
  const extra = authors.length - max;
  const overlap = Math.round(size * 0.35);

  return (
    <div
      className="relative flex items-center"
      style={{ height: size }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {visible.map((a, i) => (
        <div
          key={a.login}
          className="rounded-full ring-2 ring-[#0a0a0a] shrink-0 transition-transform duration-200"
          style={{
            marginLeft: i === 0 ? 0 : -overlap,
            zIndex: visible.length - i,
            width: size,
            height: size,
            transform: hovered ? `translateX(${i * 2}px)` : 'none',
          }}
        >
          <img
            src={a.avatar_url}
            alt={a.name || a.login}
            width={size}
            height={size}
            className="rounded-full object-cover"
            style={{ width: size, height: size }}
          />
        </div>
      ))}
      {extra > 0 && (
        <div
          className="rounded-full ring-2 ring-[#0a0a0a] bg-white/[0.08] border border-white/[0.12] flex items-center justify-center text-[10px] text-white/50 font-medium shrink-0"
          style={{ marginLeft: -overlap, zIndex: 0, width: size, height: size }}
        >
          +{extra}
        </div>
      )}
      {/* Tooltip */}
      {hovered && (
        <div className="absolute bottom-full left-0 mb-2 px-2 py-1 bg-[#1a1a1a] border border-white/[0.07] rounded-md shadow-lg z-50 pointer-events-none whitespace-nowrap">
          <div className="text-[11px] text-white/80">
            {authors.map(a => a.name || a.login).join(', ')}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PostCard({ post, featured = false }) {
  const href = `${BASE}/${post.slug}`;

  if (featured) {
    return (
      <a
        href={href}
        className="group block bg-[#080808] border border-white/[0.08] mb-6 hover:border-white/[0.16] hover:bg-[#0a0a0a] hover:shadow-[0_0_30px_-10px_rgba(14,165,233,0.08)] transition-all duration-300 overflow-hidden"
      >
        <div className="flex flex-col sm:flex-row">
          <div className="flex-1 p-8 flex flex-col justify-between min-w-0">
            <div>
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className="px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] bg-[#0ea5e9]/15 border border-[#0ea5e9]/25 text-[#0ea5e9]">
                  Latest
                </span>
                {post.tags.slice(0, 3).map((tag, i) => (
                  <span key={tag} className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                    <span className="text-white/15 mr-1">0{i + 2}</span>
                    {tag}
                  </span>
                ))}
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold text-white group-hover:text-white transition-colors mb-3 leading-snug">
                {post.title}
              </h2>
              <p className="text-white/45 text-base leading-relaxed mb-6 max-w-2xl line-clamp-3">
                {post.description}
              </p>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.12em] text-white/30">
                <AuthorStack authors={post.authorData} size={22} />
                <time>{formatDate(post.date)}</time>
                <span>·</span>
                <span>{post.readingTime} min</span>
              </div>
              <span className="text-[#0ea5e9] font-mono text-[11px] uppercase tracking-[0.14em] group-hover:underline shrink-0 ml-4">
                Read →
              </span>
            </div>
          </div>
          {post.thumbnail ? (
            <div className="sm:w-72 lg:w-96 shrink-0 sm:border-l border-t sm:border-t-0 border-white/[0.08] overflow-hidden relative">
              <div className="absolute inset-0 bg-gradient-to-r from-black/20 to-transparent z-10 sm:hidden" />
              <img
                src={post.thumbnail}
                alt={post.title}
                className="w-full h-52 sm:h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-[1.03] transition-all duration-500"
                loading="lazy"
                decoding="async"
              />
            </div>
          ) : (
            <div className="sm:w-72 lg:w-96 shrink-0 sm:border-l border-t sm:border-t-0 border-white/[0.08] bg-gradient-to-br from-[#0ea5e9]/10 to-[#0c4a6e]/20 flex items-center justify-center relative overflow-hidden">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(14,165,233,0.05),transparent_70%)]" />
              <span className="text-[#0ea5e9]/20 text-7xl font-black select-none hidden sm:block relative">P</span>
            </div>
          )}
        </div>
      </a>
    );
  }

  return (
    <a
      href={href}
      className="group flex flex-col bg-[#080808] border border-white/[0.08] overflow-hidden hover:border-white/[0.16] hover:bg-[#0a0a0a] hover:shadow-[0_0_25px_-12px_rgba(14,165,233,0.06)] hover:-translate-y-0.5 transition-all duration-300"
    >
      <div className="w-full aspect-[16/9] overflow-hidden bg-gradient-to-br from-[#0ea5e9]/10 to-[#0c4a6e]/20 shrink-0 relative">
        {post.thumbnail ? (
          <>
            <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <img
              src={post.thumbnail}
              alt={post.title}
              className="w-full h-full object-cover opacity-75 group-hover:opacity-100 group-hover:scale-[1.05] transition-all duration-500"
              loading="lazy"
              decoding="async"
            />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[#0ea5e9]/20 text-5xl font-black select-none group-hover:scale-110 transition-transform duration-300">P</span>
          </div>
        )}
      </div>
      <div className="flex flex-col flex-1 p-5">
        <div className="flex flex-wrap items-center gap-2 mb-2.5">
          {post.tags.slice(0, 2).map((tag, i) => (
            <span key={tag} className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
              <span className="text-white/15 mr-1">0{i + 1}</span>
              {tag}
            </span>
          ))}
        </div>
        <h2 className="text-sm font-semibold text-white/85 group-hover:text-white transition-colors mb-1.5 leading-snug line-clamp-2">
          {post.title}
        </h2>
        <p className="text-xs text-white/40 leading-relaxed line-clamp-3 flex-1">
          {post.description}
        </p>
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-white/[0.06]">
          <AuthorStack authors={post.authorData} size={18} />
          <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-white/25">
            <time>{formatDate(post.date)}</time>
            <span>·</span>
            <span>{post.readingTime} min</span>
          </div>
        </div>
      </div>
    </a>
  );
}
