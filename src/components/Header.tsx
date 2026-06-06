'use client';

import { useState, useEffect } from 'react';
import { Github, Menu, X } from 'lucide-react';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

const NAV_LINKS = [
  { label: 'Features', href: 'https://pulsarnative.com/#features', external: true },
  { label: 'Docs', href: 'https://pulsarnative.com/docs', external: true },
  { label: 'Blog', href: `${BASE}/`, external: false },
  { label: 'Changelog', href: 'https://github.com/Far-Beyond-Pulsar/Pulsar-Native/releases', external: true },
  { label: 'Community', href: 'https://github.com/orgs/Far-Beyond-Pulsar/discussions', external: true },
];

export default function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-black/90 backdrop-blur-md border-b border-white/[0.07]'
          : 'bg-black/80 backdrop-blur-sm border-b border-white/[0.07]'
      }`}
    >
      <div className="max-w-7xl mx-auto px-5 h-14 flex items-center justify-between">
        {/* Logo */}
        <a href={`${BASE}/`} className="flex items-center gap-2.5 shrink-0">
          <img
            src={`${BASE}/assets/pulsar.png`}
            alt="Pulsar"
            width={26}
            height={26}
            style={{ objectFit: 'contain', width: 26, height: 26, opacity: 0.9 }}
          />
          <span className="text-white font-semibold text-[15px] tracking-tight">Pulsar</span>
          <span className="text-white/30 text-sm font-normal tracking-tight">/ Blog</span>
        </a>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1">
          {NAV_LINKS.map(({ label, href, external }) => (
            <a
              key={label}
              href={href}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className={`px-3.5 py-1.5 text-sm transition-colors rounded-md hover:bg-white/[0.05] ${
                label === 'Blog'
                  ? 'text-white font-medium'
                  : 'text-white/55 hover:text-white'
              }`}
            >
              {label}
            </a>
          ))}
        </nav>

        {/* Right actions */}
        <div className="hidden md:flex items-center gap-2">
          <a
            href="https://github.com/Far-Beyond-Pulsar/Pulsar-Native"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white/55 hover:text-white transition-colors"
          >
            <Github className="w-4 h-4" />
            <span>GitHub</span>
          </a>
          <a
            href="https://pulsarnative.com/docs/getting-started/installation/windows"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center px-4 py-1.5 bg-[#0ea5e9] hover:bg-[#0284c7] text-white text-sm font-medium rounded-lg transition-colors"
          >
            Get Started
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          className="md:hidden p-2 text-white/60 hover:text-white"
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Toggle menu"
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden bg-black/95 backdrop-blur-lg border-t border-white/[0.07] px-5 py-4 flex flex-col gap-1">
          {NAV_LINKS.map(({ label, href, external }) => (
            <a
              key={label}
              href={href}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="px-3 py-2.5 text-sm text-white/60 hover:text-white hover:bg-white/[0.05] rounded-md transition-colors"
              onClick={() => setMenuOpen(false)}
            >
              {label}
            </a>
          ))}
          <div className="mt-3 pt-3 border-t border-white/[0.07] flex flex-col gap-2">
            <a
              href="https://github.com/Far-Beyond-Pulsar/Pulsar-Native"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2.5 text-sm text-white/60 hover:text-white"
            >
              <Github className="w-4 h-4" /> GitHub
            </a>
            <a
              href="https://pulsarnative.com/docs/getting-started/installation/windows"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2.5 bg-[#0ea5e9] text-white text-sm font-medium rounded-lg text-center"
              onClick={() => setMenuOpen(false)}
            >
              Get Started
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
