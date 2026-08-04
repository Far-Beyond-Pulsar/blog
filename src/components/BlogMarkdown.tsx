'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeSlug from 'rehype-slug';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import { visit } from 'unist-util-visit';
import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { BASE_PATH } from '@/utils/site';
import 'katex/dist/katex.min.css';

// Lazy-load Monaco so it doesn't inflate the initial bundle
const MonacoCodeBlock = dynamic(() => import('./MonacoCodeBlock'), {
  ssr: false,
  loading: () => null,
});

// Suppress mermaid/Monaco cancelation errors in Strict Mode
if (typeof window !== 'undefined') {
  const orig = window.onunhandledrejection;
  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    if (err && typeof err === 'object' && err.type === 'cancelation') {
      e.preventDefault();
    }
  });
}

let mermaidPromise: Promise<any> | null = null;

function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const panRef = useRef({ x: 0, y: 0, scale: 1 });
  const imgRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, panX: 0, panY: 0 });
  const svgRef = useRef('');

  useEffect(() => {
    if (!ref.current) return;
    let el = ref.current;

    if (!mermaidPromise) {
      mermaidPromise = import('mermaid').then(m => (m as any).default || m);
    }

    mermaidPromise.then((mermaid: any) => {
      if (!el.isConnected) return;
      mermaid.initialize({ startOnLoad: false, theme: 'dark', darkMode: true });
      const id = `m-${Math.random().toString(36).slice(2, 8)}`;
      mermaid.render(id, code).then(({ svg }: any) => {
        if (el.isConnected) el.innerHTML = svg;
        svgRef.current = svg;
      }).catch(() => {});
    }).catch(() => {});

    return () => { el = null!; };
  }, [code]);

  // Lock body scroll and render the SVG in the overlay
  useEffect(() => {
    if (!fullscreen) {
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = 'hidden';
    if (imgRef.current && svgRef.current) {
      const cleaned = svgRef.current
        .replace(/\s+width="[^"]*"/, '')
        .replace(/\s+height="[^"]*"/, '')
        .replace(/\s+style="[^"]*"/, '')
        .replace('<svg', '<svg style="width:90vw;height:90vh"');
      imgRef.current.innerHTML = cleaned;
    }
  }, [fullscreen]);

  // Native wheel listener on overlay for zoom (keeps page from scrolling)
  useEffect(() => {
    if (!fullscreen || !overlayRef.current) return;
    const el = overlayRef.current;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      panRef.current.scale = Math.min(Math.max(panRef.current.scale * delta, 0.25), 8);
      applyTransform();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fullscreen]);

  const applyTransform = () => {
    if (imgRef.current) {
      const { panX, panY } = dragRef.current;
      const { scale } = panRef.current;
      const t = `translate(${panX}px, ${panY}px) scale(${scale})`;
      imgRef.current.style.transform = t;
    }
  };

  const resetView = () => {
    panRef.current = { x: 0, y: 0, scale: 1 };
    dragRef.current.panX = 0;
    dragRef.current.panY = 0;
    applyTransform();
  };

  return (
    <>
      <div className="relative group">
        <div
          ref={ref}
          className="my-6 flex justify-center bg-[#0a0a0a] border border-white/[0.07] rounded-xl p-6 overflow-x-auto"
        />
        <button
          onClick={() => {
            panRef.current = { x: 0, y: 0, scale: 1 };
            dragRef.current.panX = 0;
            dragRef.current.panY = 0;
            setFullscreen(true);
          }}
          className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity px-2.5 py-1 text-xs rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90"
        >
          ⛶ Fullscreen
        </button>
      </div>

      {fullscreen && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center overflow-hidden touch-none select-none"
          style={{ cursor: dragRef.current.dragging ? 'grabbing' : 'grab' }}
        >
          <button
            onClick={() => setFullscreen(false)}
            className="absolute top-5 right-5 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors text-lg"
          >
            ✕
          </button>
          <button
            onClick={resetView}
            className="absolute bottom-5 right-5 z-10 px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90 transition-colors"
          >
            Reset
          </button>
          <div className="absolute top-5 left-5 text-xs text-white/30 select-none pointer-events-none">
            Scroll to zoom · Drag to pan
          </div>
          <div
            ref={imgRef}
            onMouseDown={e => {
              dragRef.current.dragging = true;
              dragRef.current.startX = e.clientX - dragRef.current.panX;
              dragRef.current.startY = e.clientY - dragRef.current.panY;
              e.preventDefault();
            }}
            onMouseMove={e => {
              if (!dragRef.current.dragging) return;
              dragRef.current.panX = e.clientX - dragRef.current.startX;
              dragRef.current.panY = e.clientY - dragRef.current.startY;
              applyTransform();
            }}
            onMouseUp={() => { dragRef.current.dragging = false; }}
            onMouseLeave={() => { dragRef.current.dragging = false; }}
            style={{ transform: 'translate(0px, 0px) scale(1)' }}
          />
        </div>
      )}
    </>
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

function ImageBlock({ src, alt }: { src?: string; alt?: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const panRef = useRef({ x: 0, y: 0, scale: 1 });
  const imgRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, panX: 0, panY: 0 });

  useEffect(() => {
    if (!fullscreen) { document.body.style.overflow = ''; return; }
    document.body.style.overflow = 'hidden';
    if (imgRef.current) {
      imgRef.current.innerHTML = `<img src="${src}" style="width:90vw;height:90vh;object-fit:contain" />`;
    }
    return () => { document.body.style.overflow = ''; };
  }, [fullscreen, src]);

  useEffect(() => {
    if (!fullscreen || !overlayRef.current) return;
    const el = overlayRef.current;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      panRef.current.scale = Math.min(Math.max(panRef.current.scale * delta, 0.25), 8);
      applyTransform();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fullscreen]);

  const applyTransform = () => {
    if (imgRef.current) {
      const { panX, panY } = dragRef.current;
      const { scale } = panRef.current;
      imgRef.current.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }
  };

  const resetView = () => {
    panRef.current = { x: 0, y: 0, scale: 1 };
    dragRef.current.panX = 0; dragRef.current.panY = 0;
    applyTransform();
  };

  return (
    <>
      <span className="inline-block relative group">
        <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg cursor-zoom-in" onClick={() => setFullscreen(true)} />
        <button onClick={(e) => { e.stopPropagation(); setFullscreen(true); }} className="absolute top-2 right-2 px-3 py-1.5 text-sm rounded bg-black/60 hover:bg-black/80 text-white/80 hover:text-white transition-colors shadow-lg">
          ⛶ Fullscreen
        </button>
      </span>
      {fullscreen && (
        <div ref={overlayRef} className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center overflow-hidden touch-none select-none"
          onMouseDown={e => {
            dragRef.current.dragging = true;
            dragRef.current.startX = e.clientX - dragRef.current.panX;
            dragRef.current.startY = e.clientY - dragRef.current.panY;
          }}
          onMouseMove={e => {
            if (!dragRef.current.dragging) return;
            dragRef.current.panX = e.clientX - dragRef.current.startX;
            dragRef.current.panY = e.clientY - dragRef.current.startY;
            applyTransform();
          }}
          onMouseUp={() => { dragRef.current.dragging = false; }}
          onMouseLeave={() => { dragRef.current.dragging = false; }}
        >
          <button onClick={() => { setFullscreen(false); document.body.style.overflow = ''; }} className="absolute top-5 right-5 z-10 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors text-lg">✕</button>
          <button onClick={resetView} className="absolute bottom-5 right-5 z-10 px-3 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/90 transition-colors">Reset</button>
          <div className="absolute top-5 left-5 text-xs text-white/30 select-none pointer-events-none">Scroll to zoom · Drag to pan</div>
          <div ref={imgRef} className="pointer-events-none" style={{ transform: 'translate(0px, 0px) scale(1)' }} />
        </div>
      )}
    </>
  );
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

function TableWrapper({ children }: { children?: React.ReactNode }) {
  return (
    <div className="overflow-x-auto my-6">
      <table className="min-w-full">{children}</table>
    </div>
  );
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

/** Left alone: absolute URLs, protocol-relative, data URIs, anchors, mail/tel. */
const NON_RELATIVE = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Collapse "." and ".." segments so the emitted URL is the real path rather
 * than something the browser has to normalise (".../slug/../foo.png").
 */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return '/' + out.join('/');
}

/**
 * Resolve a post-relative asset reference to a deployable absolute path.
 *
 * Folder posts keep their images beside the markdown and reference them as
 * "./assets/foo.png". Those files are copied to /posts/<slug>/assets/foo.png,
 * which under a basePath deployment is served from <base>/posts/<slug>/...
 * Forgetting the base yields a URL that resolves fine on a local dev server
 * mounted at the root and 404s in production — so the base is applied here,
 * once, for every reference the markdown can contain.
 */
function resolveAssetUrl(url: string, slug: string, base: string): string {
  if (!url || NON_RELATIVE.test(url)) return url;

  // Post-relative ("./x", "../x") — resolve against the post's own folder.
  if (url.startsWith('./') || url.startsWith('../')) {
    return base + normalizePath(`/posts/${slug}/${url}`);
  }

  // Root-relative ("/post_thumb/x.png") — already site-absolute, just needs
  // the base, and must not get it twice.
  if (url.startsWith('/')) {
    if (base && (url === base || url.startsWith(`${base}/`))) return url;
    return base + url;
  }

  // Bare relative ("assets/foo.png") — same folder as the post.
  return base + normalizePath(`/posts/${slug}/${url}`);
}

function remarkRewriteRelative(slug: string): Plugin<[], Root> {
  return () => (tree) => {
    visit(tree, ['image', 'link'], (node: any) => {
      if (typeof node.url === 'string') {
        node.url = resolveAssetUrl(node.url, slug, BASE_PATH);
      }
    });
    // Raw HTML blocks bypass the mdast node types above, so src/href inside
    // them are rewritten textually. Both quote styles, both relative forms.
    visit(tree, 'html', (node: any) => {
      if (typeof node.value !== 'string') return;
      node.value = node.value.replace(
        /\b(src|href)=("|')([^"']+)\2/g,
        (match: string, attr: string, quote: string, value: string) => {
          const resolved = resolveAssetUrl(value, slug, BASE_PATH);
          return resolved === value ? match : `${attr}=${quote}${resolved}${quote}`;
        },
      );
    });
  };
}

export default function BlogMarkdown({ content, slug }: { content: string; slug?: string }) {
  const plugins = slug ? [remarkGfm, remarkMath, remarkAlertPlugin, remarkRewriteRelative(slug)] : [remarkGfm, remarkMath, remarkAlertPlugin];

  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={plugins}
        rehypePlugins={[rehypeSlug, rehypeRaw, rehypeKatex]}
        components={{
          pre:   PreBlock  as any,
          code:  InlineCode as any,
          img:   ImageBlock as any,
          table: TableWrapper as any,
          div:   (props: any) => {
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
