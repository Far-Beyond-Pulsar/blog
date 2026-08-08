"use client";

import PostCard from "@/components/PostCard";
import OutlineText from "@/components/OutlineText";
import { useState, useMemo, useRef, useEffect } from "react";

const styles = `
.tag-dropdown-scroll::-webkit-scrollbar { width: 5px; }
.tag-dropdown-scroll::-webkit-scrollbar-track { background: transparent; }
.tag-dropdown-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 999px; }
.tag-dropdown-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
`;

export default function BlogHomeClient({
  posts,
  allTags,
  tagFreq,
  allAuthors,
  total,
  base,
  visibleTags,
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [tagOpen, setTagOpen] = useState(false);
  const [authorOpen, setAuthorOpen] = useState(false);
  const [activeAuthor, setActiveAuthor] = useState(null);
  const [activeTags, setActiveTags] = useState([]);
  const tagRef = useRef(null);
  const authorRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (tagRef.current && !tagRef.current.contains(e.target)) setTagOpen(false);
      if (authorRef.current && !authorRef.current.contains(e.target)) setAuthorOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filteredPosts = useMemo(() => {
    let result = posts;
    if (activeAuthor) {
      result = result.filter((p) => (p.authorData || []).some((a) => a.login === activeAuthor));
    }
    if (activeTags.length > 0) {
      result = result.filter((p) => activeTags.some((t) => (p.tags || []).includes(t)));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((p) =>
        p.title.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    return result;
  }, [posts, activeAuthor, activeTags, searchQuery]);

  const tagSearchRef = useRef(null);
  const [tagSearch, setTagSearch] = useState("");
  const filteredAllTags = tagSearch
    ? allTags.filter((t) => t.toLowerCase().includes(tagSearch.toLowerCase()))
    : allTags;

  return (
    <div className="min-h-screen bg-black text-white">
      <style>{styles}</style>
      <div className="border-b border-white/[0.07] bg-[#030303]">
        <div className="max-w-5xl mx-auto px-5 pt-20 pb-16">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-white/40 mb-6">
            <span className="w-8 h-px bg-[#38bdf8]/70" />
            01 / Engineering Blog
          </p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-tight mb-4">
            From the Pulsar <OutlineText text="team." />
          </h1>
          <p className="text-white/45 text-base sm:text-lg max-w-2xl leading-relaxed">
            What happens when you build a GPU-driven game engine from nothing —
            the breakthroughs, the rabbit holes, and all the bugs we found along the way.
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/20 mt-8">
            {filteredPosts.length} of {total} posts
            {(activeAuthor || activeTags.length > 0) && (
              <button
                onClick={() => { setActiveAuthor(null); setActiveTags([]); }}
                className="ml-3 text-[#0ea5e9] hover:underline normal-case font-sans tracking-normal"
              >
                &larr; clear filters
              </button>
            )}
          </p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-5 py-14">
        {/* Filter bar */}
        <div className="flex flex-col sm:flex-row gap-3 mb-10 items-start sm:items-center">
          {/* Search — full left */}
          <div className="w-full sm:flex-1 relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input
              placeholder="Search posts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-white text-sm placeholder-white/15 outline-none focus:bg-white/[0.06] focus:border-[#0ea5e9]/30 focus:shadow-[0_0_20px_-8px_rgba(14,165,233,0.08)] transition-all duration-200"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>

          {/* Dropdowns */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {/* Tags */}
            {allTags.length > 0 && (
              <div className="relative" ref={tagRef}>
                <button
                  onClick={() => { setTagOpen(!tagOpen); setAuthorOpen(false); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 ${
                    activeTags.length > 0
                      ? 'bg-[#0ea5e9]/10 border-[#0ea5e9]/25 text-[#0ea5e9]'
                      : 'bg-white/[0.05] border-white/[0.08] text-white/50 hover:bg-white/[0.08] hover:border-white/[0.15] hover:text-white/80'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
                  {activeTags.length === 0 ? 'Tags' : `${activeTags.length}`}
                  <svg className={`w-3 h-3 transition-transform duration-200 ${tagOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                {tagOpen && (
                  <div className="absolute top-full right-0 mt-2 w-56 bg-[#141414] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/60 z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                    <div className="p-2">
                      <input
                        ref={tagSearchRef}
                        autoFocus
                        placeholder="Search tags..."
                        value={tagSearch}
                        onChange={(e) => setTagSearch(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg bg-black border border-white/[0.08] text-white text-xs placeholder-white/20 outline-none focus:border-[#0ea5e9]/40 transition-colors"
                      />
                    </div>
                    <div className="tag-dropdown-scroll max-h-60 overflow-y-auto p-1.5">
                      {activeTags.length > 0 && (
                        <button
                          onClick={() => { setActiveTags([]); setTagOpen(false); setTagSearch(''); }}
                          className="flex items-center gap-1.5 w-full px-3 py-2 text-xs text-white/30 hover:text-white/60 hover:bg-white/[0.04] rounded-lg transition-colors text-left"
                        >
                          Clear all tags
                        </button>
                      )}
                      {filteredAllTags.length === 0 ? (
                        <p className="px-3 py-4 text-xs text-white/20 text-center">No tags match</p>
                      ) : (
                        filteredAllTags.map((tag) => (
                          <button
                            key={tag}
                            onClick={() => {
                              setActiveTags((prev) =>
                                prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
                              );
                            }}
                            className={`flex items-center justify-between w-full px-3 py-2 text-xs rounded-lg transition-colors text-left ${
                              activeTags.includes(tag)
                                ? "bg-[#0ea5e9]/10 text-white font-medium"
                                : "text-white/50 hover:bg-white/[0.04] hover:text-white/80"
                            }`}
                          >
                            <span>{tag}</span>
                            <span className="text-white/15 text-[10px]">{tagFreq[tag]}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Authors */}
            {allAuthors && allAuthors.length > 0 && (
              <div className="relative" ref={authorRef}>
                <button
                  onClick={() => { setAuthorOpen(!authorOpen); setTagOpen(false); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 ${
                    activeAuthor
                      ? 'bg-[#0ea5e9]/10 border-[#0ea5e9]/25 text-[#0ea5e9]'
                      : 'bg-white/[0.05] border-white/[0.08] text-white/50 hover:bg-white/[0.08] hover:border-white/[0.15] hover:text-white/80'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z" /></svg>
                  {activeAuthor ? (() => {
                    const a = allAuthors.find(x => x.login === activeAuthor);
                    return a ? <span className="truncate max-w-20">{a.name || a.login}</span> : 'Author';
                  })() : 'Author'}
                  <svg className={`w-3 h-3 transition-transform duration-200 ${authorOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                </button>
                {authorOpen && (
                  <div className="absolute top-full right-0 mt-2 w-56 bg-[#141414] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/60 z-50 overflow-hidden">
                    <div className="tag-dropdown-scroll max-h-72 overflow-y-auto p-1.5">
                      {activeAuthor && (
                        <button
                          onClick={() => { setActiveAuthor(null); setAuthorOpen(false); }}
                          className="flex items-center gap-2 w-full px-3 py-2 text-xs text-white/30 hover:text-white/60 hover:bg-white/[0.04] rounded-lg transition-colors text-left"
                        >
                          All authors
                        </button>
                      )}
                      {allAuthors.map((author) => (
                        <button
                          key={author.login}
                          onClick={() => { setActiveAuthor(author.login); setAuthorOpen(false); }}
                          className={`flex items-center justify-between w-full px-3 py-2 text-xs rounded-lg transition-colors text-left ${
                            activeAuthor === author.login
                              ? "bg-[#0ea5e9]/10 text-white font-medium"
                              : "text-white/50 hover:bg-white/[0.04] hover:text-white/80"
                          }`}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {author.avatar_url && <img src={author.avatar_url} alt="" className="w-5 h-5 rounded-full shrink-0 ring-1 ring-white/10" />}
                            <span className="truncate">{author.name || author.login}</span>
                          </span>
                          <span className="text-white/15 text-[10px] shrink-0 ml-2">{author.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Active filter pills */}
        {(activeTags.length > 0 || activeAuthor) && (
          <div className="flex flex-wrap items-center gap-2 mb-8">
            <span className="text-[11px] text-white/20 mr-0.5">Filtering:</span>
            {activeTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTags((prev) => prev.filter((t) => t !== tag))}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#0ea5e9]/10 text-[#0ea5e9] border border-[#0ea5e9]/20 hover:bg-[#0ea5e9]/18 hover:border-[#0ea5e9]/30 transition-all duration-150"
              >
                {tag}
                <svg className="w-3 h-3 opacity-60 hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            ))}
            {activeAuthor && (
              <button
                onClick={() => setActiveAuthor(null)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#0ea5e9]/10 text-[#0ea5e9] border border-[#0ea5e9]/20 hover:bg-[#0ea5e9]/18 hover:border-[#0ea5e9]/30 transition-all duration-150"
              >
                {(allAuthors.find(a => a.login === activeAuthor)?.name || activeAuthor)}
                <svg className="w-3 h-3 opacity-60 hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
            <button
              onClick={() => { setActiveTags([]); setActiveAuthor(null); }}
              className="px-2 py-1 rounded-full text-[11px] text-white/25 hover:text-white/50 transition-colors ml-1"
            >
              Clear all
            </button>
          </div>
        )}

        {filteredPosts.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-white/30 text-sm">
              No posts match your filters.{" "}
              <button onClick={() => { setActiveAuthor(null); setActiveTags([]); setSearchQuery(''); }} className="text-[#0ea5e9] hover:underline">
                Show all posts
              </button>
            </p>
          </div>
        ) : (
          <>
            <PostCard key={filteredPosts[0].slug} post={filteredPosts[0]} featured={true} />
            {filteredPosts.length > 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
                {filteredPosts.slice(1).map((post) => (
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
