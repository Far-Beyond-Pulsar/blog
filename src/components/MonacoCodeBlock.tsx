'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';

const LINE_HEIGHT = 20;
const MIN_HEIGHT  = 60;

const LANG_ALIASES: Record<string, string> = {
  js:    'javascript',
  jsx:   'javascript',
  ts:    'typescript',
  tsx:   'typescript',
  sh:    'shell',
  bash:  'shell',
  zsh:   'shell',
  py:    'python',
  yml:   'yaml',
  toml:  'ini',
  'c++': 'cpp',
  md:    'markdown',
};

function resolveLang(raw: string): string {
  return LANG_ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
}

export default function MonacoCodeBlock({ lang, code }: { lang: string; code: string }) {
  const monaco       = useMonaco();
  const containerRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [editorHeight, setEditorHeight] = useState(
    Math.max(code.split('\n').length * LINE_HEIGHT + 24, MIN_HEIGHT)
  );

  useEffect(() => {
    if (!monaco) return;
    monaco.editor.defineTheme('helio-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background':                   '#09090b',
        'editor.lineHighlightBackground':      '#ffffff08',
        'editorLineNumber.foreground':         '#ffffff22',
        'editorLineNumber.activeForeground':   '#ffffff45',
        'editor.selectionBackground':          '#0ea5e930',
        'editorIndentGuide.background1':       '#ffffff0a',
        'editorIndentGuide.activeBackground1': '#ffffff18',
        'scrollbarSlider.background':          '#ffffff10',
        'scrollbarSlider.hoverBackground':     '#ffffff20',
        'scrollbarSlider.activeBackground':    '#ffffff30',
        'editor.lineHighlightBorder':          '#00000000',
      },
    });
    monaco.editor.setTheme('helio-dark');
  }, [monaco]);

  const handleEditorMount = useCallback((editor: any) => {
    const syncHeight = () => {
      setEditorHeight(Math.max(editor.getContentHeight(), MIN_HEIGHT));
    };
    editor.onDidContentSizeChange(syncHeight);
    syncHeight();
  }, []);

  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div
      ref={containerRef}
      style={{
        margin: '1.5em 0', borderRadius: 10, overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.07)', background: '#09090b',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: '#0c0c0f',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: '0.72rem',
          color: 'rgba(255,255,255,0.35)', letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {lang || 'text'}
        </span>
        <button
          onClick={copy}
          aria-label="Copy code"
          style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 5,
            color: copied ? '#0ea5e9' : 'rgba(255,255,255,0.40)', cursor: 'pointer',
            fontSize: '0.72rem', padding: '2px 9px', fontFamily: 'var(--font-mono)',
            transition: 'color 0.15s, border-color 0.15s',
          }}
        >
          {copied ? 'copied!' : 'copy'}
        </button>
      </div>

      <Editor
        height={editorHeight}
        language={resolveLang(lang)}
        value={code}
        theme="helio-dark"
        onMount={handleEditorMount}
        options={{
          readOnly:             true,
          domReadOnly:          true,
          minimap:              { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers:          'on',
          lineNumbersMinChars:  3,
          glyphMargin:          false,
          folding:              false,
          lineDecorationsWidth: 10,
          renderLineHighlight:  'none',
          overviewRulerBorder:  false,
          overviewRulerLanes:   0,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            vertical:                'hidden',
            horizontal:              'hidden',
            alwaysConsumeMouseWheel: false,
          },
          fontSize:       13,
          lineHeight:     LINE_HEIGHT,
          fontFamily:     '"JetBrains Mono", ui-monospace, monospace',
          fontLigatures:  true,
          padding:        { top: 12, bottom: 12 },
          contextmenu:    false,
          links:          false,
          occurrencesHighlight:       'off',
          selectionHighlight:         false,
          matchBrackets:              'never',
          guides:                     { indentation: true, bracketPairs: false },
          wordWrap:                   'off',
          renderWhitespace:           'none',
          cursorWidth:                0,
          mouseWheelZoom:             false,
          quickSuggestions:           false,
          suggestOnTriggerCharacters: false,
          acceptSuggestionOnEnter:    'off',
          tabCompletion:              'off',
          wordBasedSuggestions:       'off',
          parameterHints:             { enabled: false },
          hover:                      { enabled: 'off' },
          fixedOverflowWidgets:       true,
        }}
        loading={
          <div style={{
            height: editorHeight, background: '#09090b',
            display: 'flex', alignItems: 'center', paddingLeft: 56,
            fontFamily: 'var(--font-mono)', fontSize: 13, color: 'rgba(255,255,255,0.15)',
          }}>
            {code}
          </div>
        }
      />
    </div>
  );
}
