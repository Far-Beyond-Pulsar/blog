'use client';

import { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeSlug from 'rehype-slug';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// Lazy-load Monaco so it doesn't inflate the initial bundle
const MonacoCodeBlock = dynamic(() => import('./MonacoCodeBlock'), {
  ssr: false,
  loading: () => null,
});

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    import('mermaid').then(({ default: mermaid }) => {
      if (cancelled || !ref.current) return;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', darkMode: true });
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      mermaid.render(id, code).then(({ svg }) => {
        if (ref.current && !cancelled) ref.current.innerHTML = svg;
      }).catch(() => {
        if (ref.current && !cancelled) {
          ref.current.innerHTML = `<pre class="text-red-400 text-xs p-4">${code}</pre>`;
        }
      });
    });
    return () => { cancelled = true; };
  }, [code]);

  return (
    <div
      ref={ref}
      className="my-6 flex justify-center bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-6 overflow-x-auto"
    />
  );
}

// Override <pre> so we intercept fenced code blocks before rehype can mangle children
function PreBlock({ children }: { children?: React.ReactNode }) {
  // react-markdown renders fenced blocks as <pre><code className="language-*">…</code></pre>
  const child = Array.isArray(children) ? children[0] : children;
  if (!child || typeof child !== 'object' || !('props' in (child as any))) {
    return <pre>{children}</pre>;
  }
  const { className = '', children: codeChildren } = (child as any).props as {
    className?: string;
    children?: React.ReactNode;
  };
  const lang = /language-(\w+)/.exec(className)?.[1] ?? '';
  const code = extractText(codeChildren);

  if (lang === 'mermaid') return <MermaidBlock code={code} />;
  return <MonacoCodeBlock lang={lang} code={code} />;
}

// Flatten React children to a plain string (handles string | string[] | nested elements)
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node.trimEnd();
  if (Array.isArray(node)) return node.map(extractText).join('').trimEnd();
  if (node && typeof node === 'object' && 'props' in (node as any)) {
    return extractText((node as any).props.children);
  }
  return '';
}

// Inline <code> — colored accent to stand out from surrounding text
function InlineCode({ children }: { children?: React.ReactNode }) {
  return <code className="inline-code">{children}</code>;
}

export default function BlogMarkdown({ content }: { content: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeSlug, rehypeRaw, rehypeKatex]}
        components={{
          pre:  PreBlock  as any,
          code: InlineCode as any,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
