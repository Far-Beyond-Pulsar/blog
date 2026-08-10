import type { CSSProperties } from 'react';

type OutlineTextProps = {
  text: string;
  color?: string;
  fill?: string;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * Clean "ghost outline" text. Uses SVG <text> with paint-order="stroke fill"
 * so the fill paints over the stroke: the stroke's inner half (and its
 * internal crossings on letters like 't', 'x', 'A') is masked by the fill,
 * leaving only a crisp outer ring. Single element => pixel-perfect alignment
 * that a CSS ::before overlay can never match.
 *
 * A hidden copy of the text reserves the inline layout box; the SVG (an
 * absolute overlay) is sized to the line box and vertically centered, so the
 * glyphs sit on the same baseline as surrounding text with no JS.
 */
export default function OutlineText({
  text,
  color = 'rgba(255, 255, 255, 0.55)',
  fill = '#000',
  strokeWidth = 2,
  className,
  style,
}: OutlineTextProps) {
  return (
    <span
      className={className}
      aria-label={text}
      style={{ ...style, position: 'relative', display: 'inline-block' }}
    >
      <span aria-hidden style={{ visibility: 'hidden' }}>
        {text}
      </span>
      <svg
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: '50%',
          width: '100%',
          height: '1em',
          transform: 'translateY(-50%)',
          overflow: 'visible',
          pointerEvents: 'none',
        }}
      >
        <text
          x="0"
          y="0.5em"
          dominantBaseline="central"
          paintOrder="stroke fill"
          stroke={color}
          strokeWidth={strokeWidth}
          fill={fill}
        >
          {text}
        </text>
      </svg>
    </span>
  );
}
