'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface Heading {
  id: string;
  text: string;
  level: number;
}

interface Section {
  id: string;
  text: string;
  subs: Heading[];
}

function groupSections(headings: Heading[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;

  for (const h of headings) {
    if (h.level === 2) {
      cur = { id: h.id, text: h.text, subs: [] };
      sections.push(cur);
    } else if (cur) {
      cur.subs.push(h);
    }
  }

  return sections;
}

export default function TableOfContents({ headings }: { headings: Heading[] }) {
  const [active,   setActive]   = useState('');
  const [scrolled, setScrolled] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  const sections = useMemo(() => groupSections(headings), [headings]);

  // Track page scroll for glass-effect card
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // IntersectionObserver for active-heading tracking
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
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    );

    headings.forEach(h => {
      const el = document.getElementById(h.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  // Which section (h2) is the active heading inside
  const activeSection = useMemo(() => {
    if (!active) return null;
    return sections.find(
      s => s.id === active || s.subs.some(sub => sub.id === active),
    )?.id ?? null;
  }, [active, sections]);

  // Derive what should be open: all sections reachable from active heading up to the root
  // Since we only have one level of nesting, it's just activeSection.
  const openSections = useMemo(() => {
    if (!activeSection) return new Set<string>();
    return new Set([activeSection]);
  }, [activeSection]);

  // Auto-scroll the sidebar so the active link is always visible
  useEffect(() => {
    if (!active || !navRef.current) return;

    const link = navRef.current.querySelector(
      `[href="#${active}"]`,
    ) as HTMLElement | null;
    if (!link) return;

    const navRect   = navRef.current.getBoundingClientRect();
    const linkRect  = link.getBoundingClientRect();
    const style     = getComputedStyle(navRef.current);
    const pt        = parseFloat(style.paddingTop) || 0;
    const pb        = parseFloat(style.paddingBottom) || 0;

    if (linkRect.top < navRect.top + pt) {
      navRef.current.scrollTop -= (navRect.top + pt - linkRect.top) + 4;
    } else if (linkRect.bottom > navRect.bottom - pb) {
      navRef.current.scrollTop += (linkRect.bottom - navRect.bottom + pb) + 4;
    }
  }, [active, openSections]);

  if (headings.length === 0) return null;

  return (
    <nav
      ref={navRef}
      aria-label="Table of contents"
      className="toc-scroll"
      style={{
        borderRadius: 12,
        padding: scrolled ? '16px 18px' : '0px',
        background: scrolled ? 'rgba(9,9,11,0.82)' : 'transparent',
        border: scrolled ? '1px solid rgba(255,255,255,0.07)' : '1px solid transparent',
        boxShadow: scrolled ? '0 8px 32px rgba(0,0,0,0.45)' : 'none',
        backdropFilter: scrolled ? 'blur(14px)' : 'none',
        transition: 'background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease, padding 0.3s ease',
        overflowY: 'visible',
        overscrollBehavior: 'contain',
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(255,255,255,0.08) transparent',
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
        {sections.map(sec => {
          const sectionActive = active === sec.id || sec.subs.some(s => s.id === active);
          const isOpen = openSections.has(sec.id);

          return (
            <li key={sec.id}>
              {/* Section heading (h2) */}
              <a
                href={`#${sec.id}`}
                onClick={() => setActive(sec.id)}
                style={{
                  display: 'block',
                  fontSize: '0.8125rem',
                  lineHeight: 1.55,
                  padding: '3px 0',
                  color: sectionActive ? '#0ea5e9' : 'rgba(255,255,255,0.32)',
                  textDecoration: 'none',
                  transition: 'color 0.15s, border-color 0.15s, padding-left 0.15s',
                  borderLeft: sectionActive ? '2px solid #0ea5e9' : '2px solid transparent',
                  paddingLeft: sectionActive ? '8px' : '0px',
                }}
                onMouseEnter={e => {
                  if (!sectionActive) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.62)';
                }}
                onMouseLeave={e => {
                  if (!sectionActive) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.32)';
                }}
              >
                {sec.text}
              </a>

              {/* Sub-headings (h3 / h4) — collapsible */}
              {sec.subs.length > 0 && (
                <div
                  style={{
                    overflow: 'hidden',
                    maxHeight: isOpen ? '2000px' : '0px',
                    transition: 'max-height 0.25s ease',
                  }}
                >
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {sec.subs.map(sub => {
                      const subActive = active === sub.id;

                      return (
                        <li key={sub.id}>
                          <a
                            href={`#${sub.id}`}
                            onClick={() => setActive(sub.id)}
                            style={{
                              display: 'block',
                              fontSize: '0.8125rem',
                              lineHeight: 1.55,
                              padding: '2px 0 2px 0',
                              color: subActive ? '#0ea5e9' : 'rgba(255,255,255,0.28)',
                              textDecoration: 'none',
                              transition: 'color 0.15s, border-color 0.15s, padding-left 0.15s',
                              borderLeft: subActive ? '2px solid #0ea5e9' : '2px solid transparent',
                              paddingLeft: subActive
                                ? `${(sub.level - 2) * 12 + 8}px`
                                : `${(sub.level - 2) * 12}px`,
                            }}
                            onMouseEnter={e => {
                              if (!subActive) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.55)';
                            }}
                            onMouseLeave={e => {
                              if (!subActive) (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.28)';
                            }}
                          >
                            {sub.text}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
