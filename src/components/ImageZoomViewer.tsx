'use client';

import React, { useEffect, useRef, useState } from 'react';

/** Full-screen image viewer shared by Markdown images, compares, and galleries. */
export default function ImageZoomViewer({ src, alt, onClose }: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setScale(current => Math.min(8, Math.max(0.25, current * (event.deltaY > 0 ? 0.9 : 1.1))));
    };
    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', onWheel);
  }, []);

  const reset = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] flex touch-none select-none items-center justify-center overflow-hidden bg-black/90"
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Zoomed image: ${alt}` : 'Zoomed image'}
      onClick={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="pointer-events-none absolute left-5 top-5 text-xs text-white/55">Scroll to zoom · Drag to pan</div>
      <img
        src={src}
        alt={alt || ''}
        draggable={false}
        className="max-h-[90vh] max-w-[90vw] cursor-grab object-contain active:cursor-grabbing"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        onPointerDown={event => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={event => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
        }}
        onPointerUp={event => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}
        onPointerCancel={() => { drag.current = null; }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image viewer"
        className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-xl text-white/80 transition hover:bg-white/20 hover:text-white"
      >
        ✕
      </button>
      <button
        type="button"
        onClick={reset}
        className="absolute bottom-5 right-5 rounded bg-white/10 px-3 py-1.5 text-xs text-white/75 transition hover:bg-white/20 hover:text-white"
      >
        Reset
      </button>
    </div>
  );
}
