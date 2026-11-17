"use client";

/**
 * The Pulsar site header. This exact file is shared by every Pulsar site:
 * pulsarnative.com (far-beyond-pulsar.github.io), /blog, /docs and
 * dev.pulsarnative.com. Edit the nav in all four together; each site only
 * differs in the small `Header.tsx` wrapper that passes `current`, `prefix`,
 * `logoSrc` and `solid`.
 */

import React, { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Download, Github, Menu, X } from "lucide-react";

const GITHUB = "https://github.com/Far-Beyond-Pulsar/Pulsar-Native";

type Item = { key: string; label: string; desc: string; href: string; newTab?: boolean };
type Entry =
  | { key: string; label: string; href: string; newTab?: boolean }
  | { key: string; label: string; items: Item[] };

// Paths starting with "/" belong to pulsarnative.com; everything else is absolute.
const NAV: Entry[] = [
  { key: "docs", label: "Docs", href: "/docs" },
  { key: "blog", label: "Blog", href: "/blog" },
  { key: "studio", label: "Studio", href: "/studio" },
  {
    key: "developers",
    label: "Developers",
    items: [
      { key: "dev", label: "Contribute", desc: "Setup, architecture, workflow", href: "https://dev.pulsarnative.com" },
      { key: "research", label: "Research", desc: "Papers and design notes", href: "/Research" },
      { key: "wgpui", label: "WGPUI", desc: "The GPU-accelerated UI framework", href: "/UI" },
      { key: "roadmap", label: "Roadmap", desc: "Projects and milestones", href: "https://github.com/orgs/Far-Beyond-Pulsar/projects", newTab: true },
    ],
  },
  {
    key: "community",
    label: "Community",
    items: [
      { key: "discussions", label: "Discussions", desc: "Questions and design proposals", href: "https://github.com/orgs/Far-Beyond-Pulsar/discussions", newTab: true },
      { key: "discord", label: "Discord", desc: "Real-time chat with the team", href: "https://discord.gg/5eAKDC53SX", newTab: true },
      { key: "changelog", label: "Changelog", desc: "Release notes", href: `${GITHUB}/releases`, newTab: true },
      { key: "issues", label: "Issues", desc: "Bug reports and feature requests", href: `${GITHUB}/issues`, newTab: true },
    ],
  },
];

export type SiteHeaderProps = {
  /** Which entry or dropdown item is the current page (e.g. "docs", "dev"). */
  current?: string;
  /** "" on pulsarnative.com itself, "https://pulsarnative.com" elsewhere. */
  prefix?: string;
  /** The logo image URL as this site serves it. */
  logoSrc: string;
  /** Always draw the bar's background (pages without a hero beneath it). */
  solid?: boolean;
};

const linkCls =
  "px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors rounded-md hover:bg-white/[0.05] hover:text-white";

export function SiteHeader({ current, prefix = "", logoSrc, solid = false }: SiteHeaderProps) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // A click pins a menu open (hover alone opens and closes it).
  const [pinned, setPinned] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  const url = (href: string) => (href.startsWith("/") ? `${prefix}${href}` : href);
  const tab = (newTab?: boolean) => (newTab ? { target: "_blank", rel: "noopener noreferrer" } : {});
  const isActive = (e: Entry) =>
    e.key === current || ("items" in e && e.items.some((i) => i.key === current));

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setOpen(null);
        setPinned(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(null);
        setPinned(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const filled = solid || scrolled;

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 border-b transition-all duration-300 ${
        filled ? "bg-black/90 backdrop-blur-md border-white/[0.07]" : "bg-transparent border-transparent"
      }`}
    >
      <div className="max-w-7xl mx-auto px-5 h-14 grid grid-cols-[1fr_auto_1fr] items-center">
        <a href={url("/")} className="flex items-center gap-2.5 shrink-0 justify-self-start">
          <img
            src={logoSrc}
            alt="Pulsar"
            width={26}
            height={26}
            style={{ objectFit: "contain", width: 26, height: 26, opacity: 0.9 }}
          />
          <span className="text-white font-semibold text-[15px] tracking-tight">Pulsar</span>
        </a>

        {/* Desktop nav */}
        <nav ref={navRef} className="hidden md:flex items-center gap-0.5 justify-self-center">
          {NAV.map((e, i) => {
            const active = isActive(e);
            const tone = active ? "text-white" : "text-white/45";
            const num = (
              <span className={`mr-1.5 ${active ? "text-[#38bdf8]" : "text-[#38bdf8]/60"}`}>0{i + 1}</span>
            );
            if (!("items" in e)) {
              return (
                <a key={e.key} href={url(e.href)} {...tab(e.newTab)} className={`${linkCls} ${tone}`}>
                  {num}
                  {e.label}
                </a>
              );
            }
            const isOpen = open === e.key;
            return (
              <div
                key={e.key}
                className="relative"
                onMouseEnter={() => setOpen(e.key)}
                onMouseLeave={() => pinned !== e.key && setOpen((o) => (o === e.key ? null : o))}
              >
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  onClick={() => {
                    const pin = pinned !== e.key;
                    setPinned(pin ? e.key : null);
                    setOpen(pin ? e.key : null);
                  }}
                  className={`${linkCls} ${tone} inline-flex items-center`}
                >
                  {num}
                  {e.label}
                  <ChevronDown
                    className={`w-3 h-3 ml-1 transition-transform ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {isOpen && (
                  <div className="absolute left-1/2 -translate-x-1/2 top-full pt-2 z-50">
                    <div
                      role="menu"
                      className="w-[272px] bg-[#0b0c0e] border border-white/[0.08] rounded-md p-1.5 shadow-2xl shadow-black/60"
                    >
                      {e.items.map((it) => (
                        <a
                          key={it.key}
                          role="menuitem"
                          href={url(it.href)}
                          {...tab(it.newTab)}
                          onClick={() => {
                            setOpen(null);
                            setPinned(null);
                          }}
                          className="group flex items-start justify-between gap-3 px-3 py-2.5 rounded hover:bg-white/[0.05] transition-colors"
                        >
                          <span>
                            <span
                              className={`block text-[13px] font-medium ${
                                it.key === current ? "text-white" : "text-white/80"
                              }`}
                            >
                              {it.label}
                            </span>
                            <span className="block text-[11.5px] text-white/35 mt-0.5 normal-case tracking-normal font-sans">
                              {it.desc}
                            </span>
                          </span>
                          {it.newTab && (
                            <ArrowUpRight className="w-3.5 h-3.5 mt-0.5 shrink-0 text-white/20 group-hover:text-white/60" />
                          )}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Right actions */}
        <div className="flex items-center gap-2 justify-self-end">
          <a
            href={GITHUB}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden md:flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-white/55 hover:text-white transition-colors"
          >
            <Github className="w-3.5 h-3.5" />
            <span>GitHub</span>
          </a>
          <a
            href={url("/download")}
            className="hidden md:flex items-center gap-1.5 px-4 py-1.5 bg-[#0ea5e9] hover:bg-[#0284c7] text-white font-mono text-[11px] uppercase tracking-[0.12em] rounded-md transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </a>
          <button
            className="md:hidden p-2 text-white/60 hover:text-white"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden bg-black/95 backdrop-blur-lg border-t border-white/[0.07] px-5 py-4 flex flex-col gap-1 max-h-[calc(100vh-3.5rem)] overflow-y-auto">
          {NAV.map((e) =>
            "items" in e ? (
              <div key={e.key}>
                <button
                  type="button"
                  aria-expanded={mobileOpen === e.key}
                  onClick={() => setMobileOpen(mobileOpen === e.key ? null : e.key)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-sm text-white/60 hover:text-white hover:bg-white/[0.05] rounded-md transition-colors"
                >
                  {e.label}
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${mobileOpen === e.key ? "rotate-180" : ""}`}
                  />
                </button>
                {mobileOpen === e.key && (
                  <div className="ml-3 pl-3 border-l border-white/[0.08] flex flex-col">
                    {e.items.map((it) => (
                      <a
                        key={it.key}
                        href={url(it.href)}
                        {...tab(it.newTab)}
                        onClick={() => setMenuOpen(false)}
                        className="px-3 py-2 text-sm text-white/55 hover:text-white rounded-md"
                      >
                        {it.label}
                        <span className="block text-[11.5px] text-white/30">{it.desc}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <a
                key={e.key}
                href={url(e.href)}
                {...tab(e.newTab)}
                onClick={() => setMenuOpen(false)}
                className="px-3 py-2.5 text-sm text-white/60 hover:text-white hover:bg-white/[0.05] rounded-md transition-colors"
              >
                {e.label}
              </a>
            ),
          )}
          <div className="mt-3 pt-3 border-t border-white/[0.07] flex flex-col gap-2">
            <a
              href={GITHUB}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 text-sm text-white/60 hover:text-white"
            >
              <Github className="w-4 h-4" /> GitHub
            </a>
            <a
              href={url("/download")}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0ea5e9] text-white text-sm font-medium rounded-lg"
            >
              <Download className="w-4 h-4" />
              Download
            </a>
          </div>
        </div>
      )}
    </header>
  );
}

export default SiteHeader;
