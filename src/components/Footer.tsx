import { Github } from 'lucide-react';

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || '';

const SECTIONS = [
  {
    title: 'Engine',
    links: [
      { label: 'Features', href: 'https://pulsarnative.com/#features' },
      { label: 'Documentation', href: 'https://pulsarnative.com/docs' },
      { label: 'Getting Started', href: 'https://pulsarnative.com/docs/getting-started/installation/windows' },
      { label: 'Changelog', href: 'https://github.com/Far-Beyond-Pulsar/Pulsar-Native/releases' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'GitHub Discussions', href: 'https://github.com/orgs/Far-Beyond-Pulsar/discussions' },
      { label: 'Contribute', href: 'https://github.com/Far-Beyond-Pulsar/Pulsar-Native/blob/main/CONTRIBUTING.md' },
      { label: 'Roadmap', href: 'https://github.com/orgs/Far-Beyond-Pulsar/projects' },
      { label: 'Issues', href: 'https://github.com/Far-Beyond-Pulsar/Pulsar-Native/issues' },
    ],
  },
  {
    title: 'Blog',
    links: [
      { label: 'All Posts', href: `${BASE}/` },
      { label: 'RSS Feed', href: `${BASE}/rss.xml` },
    ],
  },
];

function FooterCol({ title, links, index }: { title: string; links: { label: string; href: string }[]; index: number }) {
  const isExternal = (href: string) => href.startsWith('http');
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/30 mb-4">
        <span className="text-[#38bdf8]/60 mr-2">0{index + 2}</span>
        {title}
      </p>
      <ul className="space-y-2.5">
        {links.map(({ label, href }) => (
          <li key={label}>
            <a
              href={href}
              {...(isExternal(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="text-sm text-white/45 hover:text-white/80 transition-colors"
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Footer() {
  return (
    <footer className="border-t border-white/[0.07] bg-black overflow-hidden">
      <div className="max-w-5xl mx-auto px-5 pt-16 pb-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-10 mb-14">
          <div className="col-span-2 md:col-span-1">
            <a href={`${BASE}/`} className="flex items-center gap-2 mb-4">
              <img
                src={`${BASE}/assets/pulsar.png`}
                alt="Pulsar"
                width={20}
                height={20}
                style={{ objectFit: 'contain', width: 20, height: 20 }}
              />
              <span className="text-sm font-semibold text-white">Pulsar</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">Blog</span>
            </a>
            <p className="text-sm text-white/40 leading-relaxed max-w-[220px]">
              Engineering updates, deep dives, and release notes from the Pulsar game engine team.
            </p>
            <div className="flex items-center gap-3 mt-5">
              <a
                href="https://github.com/Far-Beyond-Pulsar"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/35 hover:text-white/70 transition-colors"
                aria-label="GitHub"
              >
                <Github className="w-4 h-4" />
              </a>
            </div>
          </div>

          {SECTIONS.map((s, i) => (
            <FooterCol key={s.title} title={s.title} links={s.links} index={i} />
          ))}
        </div>

        <div
          className="mb-8"
          style={{
            height: '1px',
            background: 'linear-gradient(90deg, transparent 0%, rgba(14,165,233,0.2) 30%, rgba(14,165,233,0.2) 70%, transparent 100%)',
          }}
        />

        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/25">
            © {new Date().getFullYear()} Far Beyond Dev — MIT license
          </p>
          <div className="flex items-center gap-5">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/15 hidden sm:block">
              rust · gpu-driven · open source
            </span>
            <a
              href="https://github.com/Far-Beyond-Pulsar/Pulsar-Native/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/25 hover:text-white/50 transition-colors"
            >
              Report an issue
            </a>
          </div>
        </div>

        {/* Ghost wordmark */}
        <div className="select-none pointer-events-none mt-10 -mb-6 text-center">
          <p className="text-outline-faint text-[clamp(3rem,12vw,10rem)] font-bold tracking-[-0.04em] leading-[0.8] whitespace-nowrap" data-text="PULSAR">
            PULSAR
          </p>
        </div>
      </div>
    </footer>
  );
}
