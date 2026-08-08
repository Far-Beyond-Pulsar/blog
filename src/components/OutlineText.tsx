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
 * A hidden copy of the text keeps the inline layout width, so the SVG (an
 * absolute overlay) aligns with the surrounding typography with no JS.
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
          inset: 0,
          width: '100%',
          height: '100%',
          overflow: 'visible',
          pointerEvents: 'none',
        }}
      >
        <text
          x="0"
          y="0"
          dominantBaseline="text-before-edge"
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
