'use client';

import React, { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeSlug from 'rehype-slug';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import { visit } from 'unist-util-visit';
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

const ALERT_TYPES = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']);

// Remark plugin: transform > [!NOTE] / > [!CAUTION] blockquotes into <div data-alert="NOTE">
function remarkAlertPlugin() {
  return (tree: any) => {
    visit(tree, 'blockquote', (node: any, index: number | undefined, parent: any | null) => {
      const first = node.children?.[0];
      if (!first || first.type !== 'paragraph') return;
      const text = first.children?.[0]?.value || '';
      const match = text.match(/^\[!(\w+)\]/);
      if (!match || !ALERT_TYPES.has(match[1].toUpperCase())) return;
      // Strip the marker from the first text node
      const marker = match[0];
      first.children[0].value = first.children[0].value.slice(marker.length).trimStart();
      // Transform blockquote to a div with data attribute
      node.type = 'div';
      node.data = node.data || {};
      node.data.hProperties = { 'data-alert': match[1].toUpperCase() };
    });
  };
}

function AlertBlock({ alertType, children }: { alertType: string; children?: React.ReactNode }) {
  const cfg: Record<string, { icon: string; label: string; border: string; bg: string; badge: string }> = {
    NOTE:      { icon: 'ℹ️', label: 'Note',      border: 'border-l-blue-500',    bg: 'bg-blue-500/5',   badge: 'bg-blue-500/15 text-blue-400' },
    TIP:       { icon: '💡', label: 'Tip',       border: 'border-l-emerald-500', bg: 'bg-emerald-500/5', badge: 'bg-emerald-500/15 text-emerald-400' },
    IMPORTANT: { icon: '⚠️', label: 'Important', border: 'border-l-violet-500',  bg: 'bg-violet-500/5',  badge: 'bg-violet-500/15 text-violet-400' },
    WARNING:   { icon: '⚠️', label: 'Warning',   border: 'border-l-yellow-500',  bg: 'bg-yellow-500/10', badge: 'bg-yellow-500/20 text-yellow-400' },
    CAUTION:   { icon: '⚡', label: 'Caution',   border: 'border-l-red-500',     bg: 'bg-red-500/5',    badge: 'bg-red-500/15 text-red-400' },
  };
  const c = cfg[alertType] || cfg.NOTE;
  return (
    <div className={`not-prose my-6 border-l-4 ${c.border} ${c.bg} rounded-r-lg px-5 py-4 border-white/[0.04]`}>
      <div className="flex items-start gap-3">
        <span className="text-lg shrink-0 mt-0.5">{c.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5">
            <span className={`inline-block px-2 py-0.5 rounded ${c.badge}`}>{c.label}</span>
          </div>
          <div className="text-sm text-white/80 [&_p]:my-0 [&_code]:text-[#7dd3fc] [&_a]:text-[#7dd3fc] [&_a]:underline [&_pre]:mt-2 [&_pre]:text-xs [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BlogMarkdown({ content }: { content: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkAlertPlugin]}
        rehypePlugins={[rehypeSlug, rehypeRaw, rehypeKatex]}
        components={{
          pre:  PreBlock  as any,
          code: InlineCode as any,
          div:  (props: any) => {
            if (props['data-alert']) {
              return <AlertBlock alertType={props['data-alert']}>{props.children}</AlertBlock>;
            }
            return <div {...props} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
