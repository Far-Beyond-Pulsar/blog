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

  // Native event listeners for zoom and pan on the overlay
  useEffect(() => {
    if (!fullscreen || !overlayRef.current) return;
    const el = overlayRef.current;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      panRef.current.scale = Math.min(Math.max(panRef.current.scale * delta, 0.25), 8);
      applyTransform();
    };

    const onPointerDown = (e: PointerEvent) => {
      dragRef.current.dragging = true;
      dragRef.current.startX = e.clientX - dragRef.current.panX;
      dragRef.current.startY = e.clientY - dragRef.current.panY;
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragRef.current.dragging) return;
      dragRef.current.panX = e.clientX - dragRef.current.startX;
      dragRef.current.panY = e.clientY - dragRef.current.startY;
      applyTransform();
    };

    const onPointerUp = () => { dragRef.current.dragging = false; };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointerleave', onPointerUp);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointerleave', onPointerUp);
    };
  }, [fullscreen]);

  const applyTransform = () => {
    if (imgRef.current) {
      const { x, y } = dragRef.current;
      const { scale } = panRef.current;
      imgRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
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
            className="pointer-events-none"
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

export default function BlogMarkdown({ content }: { content: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkAlertPlugin]}
        rehypePlugins={[rehypeSlug, rehypeRaw, rehypeKatex]}
        components={{
          pre:   PreBlock  as any,
          code:  InlineCode as any,
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
