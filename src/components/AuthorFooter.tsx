import { ExternalLink } from 'lucide-react';

interface Author {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
  bio?: string;
}

export default function AuthorFooter({ authors }: { authors: Author[] }) {
  if (authors.length === 0) return null;

  return (
    <div className="border-t border-white/[0.07] pt-10 mt-16">
      <h3 className="text-xs font-medium text-white/30 mb-6 uppercase tracking-widest">
        About the author{authors.length > 1 ? 's' : ''}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {authors.map((author) => (
          <a
            key={author.login}
            href={author.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="group relative flex items-start gap-4 p-4 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04] hover:border-white/[0.1] hover:shadow-[0_0_20px_-8px_rgba(14,165,233,0.06)] transition-all duration-200 overflow-hidden"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-[#0ea5e9]/[0.02] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
            <img
              src={author.avatar_url}
              alt={author.name}
              width={48}
              height={48}
              className="rounded-full object-cover w-12 h-12 shrink-0 ring-1 ring-white/[0.06] group-hover:ring-[#0ea5e9]/30 group-hover:shadow-[0_0_15px_-5px_rgba(14,165,233,0.15)] transition-all duration-300 relative"
            />
            <div className="min-w-0 flex-1 relative">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-white group-hover:text-[#0ea5e9] transition-colors">
                  {author.name}
                </span>
                <ExternalLink className="w-3 h-3 text-white/20 group-hover:text-[#0ea5e9]/50 transition-colors shrink-0" />
              </div>
              <div className="text-xs text-white/30 mt-0.5 font-mono">@{author.login}</div>
              {author.bio && (
                <div className="text-sm text-white/50 mt-2 leading-relaxed line-clamp-3">
                  {author.bio}
                </div>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
