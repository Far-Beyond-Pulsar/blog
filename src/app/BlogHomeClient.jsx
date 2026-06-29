"use client";

import PostCard from "@/components/PostCard";
import { useState, useMemo, useRef, useEffect } from "react";

export default function BlogHomeClient({
  posts,
  allTags,
  tagFreq,
  total,
  base,
  visibleTags,
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const topTags = useMemo(() => allTags.slice(0, visibleTags), [allTags, visibleTags]);
  const moreTags = useMemo(() => allTags.slice(visibleTags), [allTags, visibleTags]);
  const filtered = query
    ? moreTags.filter((t) => t.toLowerCase().includes(query.toLowerCase()))
    : moreTags;

  return (
    <div className="min-h-screen bg-black text-white">
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
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-12 items-center">
            <a
              href="/"
              className="px-3 py-1 rounded-full text-xs font-medium bg-[#0ea5e9] text-white transition-colors"
            >
              All
            </a>
            {topTags.map((tag) => (
              <a
                key={tag}
                href={`${base}/tags/${tag}`}
                className="px-3 py-1 rounded-full text-xs font-medium bg-white/[0.06] text-white/50 hover:bg-white/[0.1] hover:text-white/80 transition-colors"
              >
                {tag}
              </a>
            ))}

            {moreTags.length > 0 && (
              <div className="relative" ref={ref}>
                <button
                  onClick={() => setOpen(!open)}
                  className="px-3 py-1 rounded-full text-xs font-medium bg-white/[0.06] text-white/40 hover:bg-white/[0.1] hover:text-white/70 transition-colors border border-dashed border-white/[0.1]"
                >
                  +{moreTags.length} more
                </button>
                {open && (
                  <div className="absolute top-full left-0 mt-2 w-56 bg-[#111] border border-white/[0.08] rounded-xl shadow-2xl z-50 overflow-hidden">
                    <div className="p-2">
                      <input
                        autoFocus
                        placeholder="Search tags…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg bg-black border border-white/[0.08] text-white text-xs placeholder-white/20 outline-none focus:border-[#0ea5e9]/40 transition-colors"
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                      {filtered.length === 0 ? (
                        <p className="px-3 py-4 text-xs text-white/20 text-center">
                          No tags match
                        </p>
                      ) : (
                        filtered.map((tag) => (
                          <a
                            key={tag}
                            href={`${base}/tags/${tag}`}
                            onClick={() => setOpen(false)}
                            className="flex items-center justify-between px-3 py-2 text-xs text-white/50 hover:bg-white/[0.04] hover:text-white/80 transition-colors"
                          >
                            <span>{tag}</span>
                            <span className="text-white/15 text-[10px]">{tagFreq[tag]}</span>
                          </a>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {posts.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-white/30 text-sm">
              No posts yet. Add markdown files to{" "}
              <code className="font-mono text-white/50">public/posts/</code>
            </p>
          </div>
        ) : (
          <>
            <PostCard key={posts[0].slug} post={posts[0]} featured={true} />
            {posts.length > 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
                {posts.slice(1).map((post) => (
                  <PostCard key={post.slug} post={post} featured={false} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
