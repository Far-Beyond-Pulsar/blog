'use client';

import { useState, useRef, useEffect } from 'react';

interface Author {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
  bio?: string;
}

const GAP = 6;
const OVERLAP = -8;
const CIRCLE = 28;

export default function AuthorAvatars({ authors }: { authors: Author[] }) {
  const [expanded, setExpanded] = useState(false);
  const [hoveredAuthor, setHoveredAuthor] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const maxVisible = 4;
  const showExtra = authors.length > maxVisible && !expanded;
  const visible = showExtra ? authors.slice(0, maxVisible - 1) : authors;
  const extraCount = authors.length - (maxVisible - 1);
  const expandedWidth = visible.length * (CIRCLE + GAP) - GAP + (showExtra ? CIRCLE + GAP : 0);

  if (authors.length === 0) return null;

  return (
    <div
      className="relative select-none"
      style={{ width: expandedWidth }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => { setExpanded(false); setHoveredAuthor(null); }}
    >
      <div className="flex items-center" style={{ gap: expanded ? GAP : 0 }}>
        {visible.map((author, i) => {
          const offset = expanded ? 0 : i === 0 ? 0 : (CIRCLE + OVERLAP) * i;
          const isHovered = hoveredAuthor === author.login;
          return (
            <div
              key={author.login}
              className="relative shrink-0"
              style={{
                transform: `translateX(${expanded ? 0 : -offset}px)`,
                transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
                zIndex: isHovered ? 100 : visible.length - i,
              }}
              onMouseEnter={() => setHoveredAuthor(author.login)}
              onMouseLeave={() => setHoveredAuthor(null)}
            >
              <a
                href={author.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className={`block rounded-full transition-all duration-200 ${
                  isHovered ? 'ring-[#0ea5e9] ring-2' : 'ring-2 ring-black'
                }`}
              >
                <img
                  src={author.avatar_url}
                  alt=""
                  width={CIRCLE}
                  height={CIRCLE}
                  className="rounded-full object-cover"
                  style={{ width: CIRCLE, height: CIRCLE }}
                />
              </a>

              {isHovered && (
                <div
                  ref={tooltipRef}
                  className="absolute z-50 px-3 py-2 bg-[#1a1a1a] border border-white/[0.07] rounded-lg shadow-xl pointer-events-none backdrop-blur-sm"
                  style={{ left: '50%', transform: 'translateX(-50%)', top: 'calc(100% + 8px)' }}
                >
                  <div className="flex items-center gap-2.5">
                    <img src={author.avatar_url} alt="" width={22} height={22} className="rounded-full w-5.5 h-5.5 shrink-0 ring-1 ring-white/10" />
                    <div>
                      <div className="text-sm font-medium text-white whitespace-nowrap">{author.name}</div>
                      {author.bio && (
                        <div className="text-[11px] text-white/50 leading-tight mt-0.5 max-w-40 line-clamp-2">{author.bio}</div>
                      )}
                    </div>
                  </div>
                  <div
                    className="absolute w-2 h-2 bg-[#1a1a1a] border-l border-t border-white/[0.07] rotate-45"
                    style={{ left: '50%', marginLeft: -4, bottom: -5 }}
                  />
                </div>
              )}
            </div>
          );
        })}

        {showExtra && (
          <div
            className="shrink-0"
            style={{
              transform: expanded ? 'translateX(0)' : `translateX(${-(CIRCLE + OVERLAP) * (maxVisible - 1)}px)`,
              transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
            }}
          >
            <div
              className="rounded-full flex items-center justify-center text-[11px] text-white/50 font-medium"
              style={{
                width: CIRCLE,
                height: CIRCLE,
                backgroundColor: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              +{extraCount}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
