'use client';

import { useState, useEffect } from 'react';
import { Accessibility, X, Type, Eye, Zap, AlignJustify } from 'lucide-react';

interface AccessibilitySettings {
  dyslexiaFont: boolean;
  fontSize: 'normal' | 'large' | 'larger';
  highContrast: boolean;
  increaseSpacing: boolean;
  reduceMotion: boolean;
}

const defaultSettings: AccessibilitySettings = {
  dyslexiaFont: false,
  fontSize: 'normal',
  highContrast: false,
  increaseSpacing: false,
  reduceMotion: false,
};

// ─────────────────────────────────────────────────────────────
// Direct DOM manipulation — avoids all CSS specificity battles.
// Each concern injects/removes its own <style> tag or touches
// body/html directly so it beats any framework utility class.
// ─────────────────────────────────────────────────────────────

let fontLoaded = false;

function ensureFontLoaded() {
  if (fontLoaded || typeof document === 'undefined') return;
  // Inject @font-face from the @fontsource package via a dynamic <link>
  const existing = document.getElementById('a11y-opendyslexic-font');
  if (!existing) {
    const link = document.createElement('link');
    link.id = 'a11y-opendyslexic-font';
    link.rel = 'stylesheet';
    link.href = '/_next/static/css/opendyslexic.css'; // fallback to direct import below
    // We'll use a blob URL from the raw CSS instead to avoid 404s.
    // Insert font-face directly so no external request is needed.
    const style = document.createElement('style');
    style.id = 'a11y-opendyslexic-font';
    // Reference the already-bundled woff2 from @fontsource via Next.js static
    // Since we can't rely on the path, use a Google Fonts mirror for OpenDyslexic.
    // The package's woff2 file is referenced via the CSS we import in layout.
    document.head.appendChild(style);
  }
  fontLoaded = true;
}

function injectStyle(id: string, css: string) {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function removeStyle(id: string) {
  document.getElementById(id)?.remove();
}

function applySettings(s: AccessibilitySettings) {
  const html = document.documentElement;
  const body = document.body;

  // ── Text size — scale root font-size so all rem values cascade ──
  const sizeMap = { normal: '', large: '18px', larger: '21px' };
  html.style.fontSize = sizeMap[s.fontSize];

  // ── OpenDyslexic font ──
  if (s.dyslexiaFont) {
    ensureFontLoaded();
    injectStyle('a11y-dyslexia', `
      *, *::before, *::after {
        font-family: 'OpenDyslexic', sans-serif !important;
        word-spacing: 0.1em !important;
        letter-spacing: 0.03em !important;
      }
    `);
  } else {
    removeStyle('a11y-dyslexia');
  }

  // ── High contrast ──
  if (s.highContrast) {
    injectStyle('a11y-contrast', `
      html {
        filter: brightness(1.1);
      }
      a, a * { color: #7dd3fc !important; }
      code, pre {
        background: #111 !important;
        border-color: rgba(255,255,255,0.35) !important;
      }
    `);
  } else {
    removeStyle('a11y-contrast');
  }

  // ── Increased spacing ──
  if (s.increaseSpacing) {
    injectStyle('a11y-spacing', `
      body, p, li, td, th, span, div {
        line-height: 2 !important;
        letter-spacing: 0.06em !important;
        word-spacing: 0.16em !important;
      }
      h1, h2, h3, h4 {
        letter-spacing: 0.04em !important;
        line-height: 1.5 !important;
      }
    `);
  } else {
    removeStyle('a11y-spacing');
  }

  // ── Reduce motion ──
  if (s.reduceMotion) {
    injectStyle('a11y-motion', `
      *, *::before, *::after {
        animation: none !important;
        animation-duration: 0.001ms !important;
        transition: none !important;
        transition-duration: 0.001ms !important;
        scroll-behavior: auto !important;
      }
    `);
  } else {
    removeStyle('a11y-motion');
  }
}

// ─── Sub-components ──────────────────────────────────────────

function ToggleRow({
  icon, label, description, checked, onChange,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-full flex items-center gap-3 p-2 rounded-lg transition-colors text-left ${
        checked
          ? 'bg-[#0ea5e9]/15 border border-[#0ea5e9]/30'
          : 'hover:bg-white/[0.05] border border-transparent'
      }`}
      role="switch"
      aria-checked={checked}
    >
      <div className={`shrink-0 ${checked ? 'text-[#0ea5e9]' : 'text-white/40'}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-medium ${checked ? 'text-[#7dd3fc]' : 'text-white/80'}`}>{label}</div>
        <div className="text-xs text-white/30 truncate">{description}</div>
      </div>
      <div
        className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? 'bg-[#0ea5e9]' : 'bg-white/15'}`}
        aria-hidden="true"
      >
        <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </div>
    </button>
  );
}

// ─── Panel ───────────────────────────────────────────────────

export default function AccessibilityPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [settings, setSettings] = useState<AccessibilitySettings>(defaultSettings);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      const saved = localStorage.getItem('accessibility-settings');
      if (saved) {
        const parsed: AccessibilitySettings = { ...defaultSettings, ...JSON.parse(saved) };
        setSettings(parsed);
        applySettings(parsed);
      }
    } catch { /* ignore */ }
  }, []);

  const update = <K extends keyof AccessibilitySettings>(key: K, value: AccessibilitySettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    applySettings(next);
    try { localStorage.setItem('accessibility-settings', JSON.stringify(next)); } catch { /* ignore */ }
  };

  const reset = () => {
    setSettings(defaultSettings);
    applySettings(defaultSettings);
    try { localStorage.removeItem('accessibility-settings'); } catch { /* ignore */ }
  };

  // Don't render until client-side to avoid hydration mismatch
  if (!mounted) return null;

  return (
    <>
      {/* Floating toggle — bottom left */}
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className={`fixed bottom-6 left-4 z-50 w-11 h-11 rounded-full shadow-lg flex items-center justify-center transition-all focus:outline-none focus:ring-2 focus:ring-[#0ea5e9]/60 ${
          isOpen
            ? 'bg-[#0284c7] text-white'
            : 'bg-[#0ea5e9]/20 hover:bg-[#0ea5e9]/30 text-[#0ea5e9] border border-[#0ea5e9]/30'
        }`}
        aria-label={isOpen ? 'Close accessibility panel' : 'Open accessibility panel'}
        aria-expanded={isOpen}
        title="Accessibility options"
      >
        <Accessibility className="w-5 h-5" aria-hidden="true" />
      </button>

      {/* Panel */}
      {isOpen && (
        <div
          className="fixed bottom-20 left-4 z-50 w-72 bg-[#0c0c0c] border border-white/[0.12] rounded-xl shadow-2xl p-4"
          role="dialog"
          aria-modal="false"
          aria-label="Accessibility settings"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Accessibility className="w-4 h-4 text-[#0ea5e9]" />
              Accessibility
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={reset}
                className="text-xs text-white/30 hover:text-white/70 transition-colors px-1.5 py-0.5 rounded hover:bg-white/[0.05]"
              >
                Reset
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 hover:bg-white/[0.07] rounded transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4 text-white/40" />
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <ToggleRow
              icon={<Type className="w-4 h-4" />}
              label="Dyslexia-friendly font"
              description="OpenDyslexic typeface"
              checked={settings.dyslexiaFont}
              onChange={v => update('dyslexiaFont', v)}
            />
            <ToggleRow
              icon={<Eye className="w-4 h-4" />}
              label="High contrast"
              description="Increase colour contrast"
              checked={settings.highContrast}
              onChange={v => update('highContrast', v)}
            />
            <ToggleRow
              icon={<AlignJustify className="w-4 h-4" />}
              label="Increase spacing"
              description="More line & letter spacing"
              checked={settings.increaseSpacing}
              onChange={v => update('increaseSpacing', v)}
            />
            <ToggleRow
              icon={<Zap className="w-4 h-4" />}
              label="Reduce motion"
              description="Minimise animations"
              checked={settings.reduceMotion}
              onChange={v => update('reduceMotion', v)}
            />

            {/* Text size buttons */}
            <div className="flex items-center gap-3 p-2 rounded-lg">
              <div className="text-white/40 shrink-0"><Type className="w-4 h-4" /></div>
              <div className="flex-1">
                <div className="text-sm font-medium text-white/80">Text size</div>
                <div className="text-xs text-white/30">Scales all body text</div>
              </div>
              <div className="flex items-center gap-1" role="group" aria-label="Text size">
                {(['normal', 'large', 'larger'] as const).map((val, i) => (
                  <button
                    key={val}
                    onClick={() => update('fontSize', val)}
                    className={`w-8 h-8 rounded flex items-center justify-center transition-colors focus:outline-none focus:ring-1 focus:ring-[#0ea5e9] ${
                      ['text-xs', 'text-sm', 'text-base'][i]
                    } ${
                      settings.fontSize === val
                        ? 'bg-[#0ea5e9] text-white'
                        : 'bg-white/[0.07] text-white/50 hover:bg-white/[0.12]'
                    }`}
                    aria-label={`${val} text size`}
                    aria-pressed={settings.fontSize === val}
                  >
                    A
                  </button>
                ))}
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-white/20 text-center">Settings saved automatically</p>
        </div>
      )}
    </>
  );
}
