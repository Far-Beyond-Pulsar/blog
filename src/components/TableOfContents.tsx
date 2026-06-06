'use client';

import { useEffect, useState } from 'react';

interface Heading {
  id: string;
  text: string;
  level: number;
}

export default function TableOfContents({ headings }: { headings: Heading[] }) {
  const [active,   setActive]   = useState('');
  const [scrolled, setScrolled] = useState(false);

  // Track whether the user has scrolled far enough to warrant the card
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Highlight the active heading via IntersectionObserver
  useEffect(() => {
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );

    headings.forEach(h => {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav
      aria-label="Table of contents"
      style={{
        borderRadius: 12,
        padding: scrolled ? '16px 18px' : '0px',
        background:   scrolled ? 'rgba(9,9,11,0.82)' : 'transparent',
        border:       scrolled ? '1px solid rgba(255,255,255,0.07)' : '1px solid transparent',
        boxShadow:    scrolled ? '0 8px 32px rgba(0,0,0,0.45)' : 'none',
        backdropFilter: scrolled ? 'blur(14px)' : 'none',
        transition:   'background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease, padding 0.3s ease',
      }}
    >
      <p style={{
        fontSize: '0.7rem',
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.25)',
        marginBottom: 14,
        marginTop: 0,
      }}>
        On this page
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {headings.map(h => (
          <li key={h.id} style={{ paddingLeft: `${(h.level - 2) * 12}px` }}>
            <a
              href={`#${h.id}`}
              onClick={() => setActive(h.id)}
              style={{
                display: 'block',
                fontSize: '0.8125rem',
                lineHeight: 1.55,
                padding: '3px 0',
                color: active === h.id ? '#0ea5e9' : 'rgba(255,255,255,0.32)',
                textDecoration: 'none',
                transition: 'color 0.15s, border-color 0.15s, padding-left 0.15s',
                borderLeft: active === h.id ? '2px solid #0ea5e9' : '2px solid transparent',
                paddingLeft: active === h.id ? `${(h.level - 2) * 12 + 8}px` : `${(h.level - 2) * 12}px`,
              } as any}
              onMouseEnter={e => {
                if (active !== h.id) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.62)';
              }}
              onMouseLeave={e => {
                if (active !== h.id) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.32)';
              }}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
