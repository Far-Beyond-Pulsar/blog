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

function FooterCol({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  const isExternal = (href: string) => href.startsWith('http');
  return (
    <div>
      <p className="text-xs font-semibold tracking-widest uppercase text-white/25 mb-4">{title}</p>
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
    <footer className="border-t border-white/[0.07] bg-black">
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
              <span className="text-white/30 text-sm">Blog</span>
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

          {SECTIONS.map(s => (
            <FooterCol key={s.title} title={s.title} links={s.links} />
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
          <p className="text-xs text-white/25">
            © {new Date().getFullYear()} Far Beyond Dev. Open source under MIT.
          </p>
          <a
            href="https://github.com/Far-Beyond-Pulsar/Pulsar-Native/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-white/25 hover:text-white/50 transition-colors"
          >
            Report an issue
          </a>
        </div>
      </div>
    </footer>
  );
}
