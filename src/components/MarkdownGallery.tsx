'use client';

import React, { useEffect, useRef, useState } from 'react';
import ImageZoomViewer from './ImageZoomViewer';

export type MarkdownGalleryItem = {
  src: string;
  alt: string;
};

export default function MarkdownGallery({ items }: { items: MarkdownGalleryItem[] }) {
  if (items.length === 0) return null;
  if (items.length <= 9) return <GalleryGrid items={items} />;
  return <GalleryCarousel items={items} />;
}

function GalleryGrid({ items }: { items: MarkdownGalleryItem[] }) {
  const [zoomed, setZoomed] = useState<MarkdownGalleryItem | null>(null);
  const desktopColumns = items.length === 4 ? 2 : Math.min(items.length, 3);
  const mobileColumns = Math.min(items.length, 2);
  const desktopSpans = balancedSpans(items.length, desktopColumns);
  const mobileSpans = balancedSpans(items.length, mobileColumns);

  return (
    <div className="markdown-gallery-grid not-prose my-8 grid gap-4">
      {items.map((item, index) => (
        <figure
          key={`${item.src}-${index}`}
          style={{
            '--gallery-mobile-span': mobileSpans[index],
            '--gallery-desktop-span': desktopSpans[index],
          } as React.CSSProperties}
          className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#0b0e14]"
        >
          <button
            type="button"
            onClick={() => setZoomed(item)}
            aria-label={`Zoom image: ${item.alt || `image ${index + 1}`}`}
            className="block w-full cursor-zoom-in"
          >
            <img
              src={item.src}
              alt={item.alt}
              loading="lazy"
              className="block aspect-video w-full object-contain bg-black"
            />
          </button>
          {item.alt && <figcaption className="px-3 py-2 text-xs leading-5 text-white/65">{item.alt}</figcaption>}
        </figure>
      ))}
      {zoomed && <ImageZoomViewer src={zoomed.src} alt={zoomed.alt} onClose={() => setZoomed(null)} />}
    </div>
  );
}

function balancedSpans(count: number, columns: number) {
  const remainder = count % columns || columns;
  const lastRowStart = count - remainder;
  return Array.from({ length: count }, (_, index) =>
    index >= lastRowStart ? 6 / remainder : 6 / columns,
  );
}

function GalleryCarousel({ items }: { items: MarkdownGalleryItem[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomed, setZoomed] = useState<MarkdownGalleryItem | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeItem = items[activeIndex];

  useEffect(() => {
    const track = trackRef.current;
    const selected = track?.querySelector<HTMLElement>(`[data-gallery-index="${activeIndex}"]`);
    if (!track || !selected) return;
    const left = selected.offsetLeft - (track.clientWidth - selected.clientWidth) / 2;
    track.scrollTo({ left, behavior: 'smooth' });
  }, [activeIndex]);

  const go = (delta: number) => {
    setActiveIndex(index => (index + delta + items.length) % items.length);
  };

  return (
    <section className="not-prose my-8" aria-label="Image gallery">
      <div
        className="relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-black"
        role="region"
        aria-roledescription="carousel"
        aria-label={activeItem.alt || 'Image gallery'}
        tabIndex={0}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            go(-1);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            go(1);
          }
        }}
      >
        <button
          type="button"
          onClick={() => setZoomed(activeItem)}
          aria-label={`Zoom image: ${activeItem.alt || `image ${activeIndex + 1}`}`}
          className="absolute inset-0 z-0 flex cursor-zoom-in items-center justify-center"
        >
          <img
            src={activeItem.src}
            alt={activeItem.alt}
            loading="lazy"
            className="h-full w-full object-contain"
          />
        </button>
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous image"
          className="absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-2xl text-white shadow-lg backdrop-blur transition hover:bg-black/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="Next image"
          className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/60 text-2xl text-white shadow-lg backdrop-blur transition hover:bg-black/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
        >
          ›
        </button>
        <span className="absolute bottom-3 right-3 rounded bg-black/70 px-2 py-1 text-xs tabular-nums text-white/85">
          {activeIndex + 1} / {items.length}
        </span>
      </div>

      <div className="mt-2 flex min-h-6 items-center justify-between gap-3 text-sm text-white/65" aria-live="polite">
        <span className="min-w-0 truncate">{activeItem.alt || `Image ${activeIndex + 1}`}</span>
        <span className="shrink-0 text-xs text-white/40">Use arrows or ← →</span>
      </div>

      <div
        ref={trackRef}
        className="lens-gallery-track mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto pb-3"
        role="list"
        aria-label="Choose an image"
      >
        {items.map((item, index) => (
          <div key={`${item.src}-${index}`} role="listitem" className="w-36 shrink-0 snap-start sm:w-44">
            <div className={`group w-full overflow-hidden rounded-md border text-left transition ${
              index === activeIndex
                ? 'border-white/90 ring-1 ring-white/70'
                : 'border-white/10 opacity-65 hover:border-white/45 hover:opacity-100'
            }`}>
              <button
                type="button"
                onClick={() => { setActiveIndex(index); setZoomed(item); }}
                aria-label={`Zoom image ${index + 1}: ${item.alt || 'untitled'}`}
                className="block w-full cursor-zoom-in"
              >
                <img src={item.src} alt={item.alt} loading="lazy" className="block aspect-video w-full bg-black object-cover" />
              </button>
              <button
                type="button"
                data-gallery-index={index}
                aria-label={`Show image ${index + 1}: ${item.alt || 'untitled'}`}
                aria-current={index === activeIndex ? 'true' : undefined}
                onClick={() => setActiveIndex(index)}
                className="block w-full truncate px-2 py-1.5 text-left text-[11px] text-white/75"
              >
                {item.alt || `Image ${index + 1}`}
              </button>
            </div>
          </div>
        ))}
      </div>
      {zoomed && <ImageZoomViewer src={zoomed.src} alt={zoomed.alt} onClose={() => setZoomed(null)} />}
    </section>
  );
}
