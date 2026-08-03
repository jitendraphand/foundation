import { z } from 'zod';

/**
 * The question content format.
 *
 * A question is an ordered list of typed blocks rather than a single HTML
 * string. That is the single most important decision for the "diagrams and
 * future simulations" requirement: rendering a new kind of content means
 * adding one renderer component on the frontend and one entry in this union.
 * Existing questions in the database are untouched.
 *
 * Every block carries only data, never executable markup. Nothing here is ever
 * passed to innerHTML without the sanitisation below.
 */

export const CONTENT_VERSION = 1;

// --- SVG sanitisation ------------------------------------------------------

/**
 * The LLM returns SVG as text. Rendering untrusted SVG is genuinely dangerous
 * (it can carry <script>, event handlers, <foreignObject> with HTML, and
 * external references), so we allow-list rather than block-list: unknown
 * elements and unknown attributes are dropped, not sanitised in place.
 */
const SVG_ALLOWED_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use', 'marker',
  'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
]);

const SVG_ALLOWED_ATTRS = new Set([
  'viewBox', 'xmlns', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-opacity', 'fill-opacity', 'opacity', 'font-size', 'font-family',
  'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy',
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
  'id', 'class', 'marker-end', 'marker-start', 'orient', 'refX', 'refY',
  'markerWidth', 'markerHeight', 'patternUnits', 'clip-path', 'mask',
  'text-decoration', 'letter-spacing', 'preserveAspectRatio', 'vector-effect',
]);

export function sanitizeSvg(input: string): string {
  let svg = input.trim();

  // Strip anything before the first <svg — models like to prefix prose.
  const start = svg.search(/<svg[\s>]/i);
  if (start === -1) throw new Error('SVG block does not contain an <svg> element.');
  svg = svg.slice(start);

  const end = svg.toLowerCase().lastIndexOf('</svg>');
  if (end === -1) throw new Error('SVG block has no closing </svg> tag.');
  svg = svg.slice(0, end + 6);

  // Remove comments, CDATA, doctypes and processing instructions outright.
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');
  svg = svg.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  svg = svg.replace(/<![\s\S]*?>/g, '');
  svg = svg.replace(/<\?[\s\S]*?\?>/g, '');

  // Drop dangerous elements together with their content.
  svg = svg.replace(/<(script|style|foreignObject|animate|set|handler|iframe|image|audio|video)\b[\s\S]*?<\/\1\s*>/gi, '');
  svg = svg.replace(/<(script|style|foreignObject|animate|set|handler|iframe|image|audio|video)\b[^>]*\/?>/gi, '');

  // Walk every remaining tag and filter tags + attributes against the allow-list.
  svg = svg.replace(/<\s*(\/?)([A-Za-z0-9:-]+)((?:[^>"']|"[^"]*"|'[^']*')*)(\/?)>/g, (_m, slash, rawTag, rawAttrs, selfClose) => {
    const tag = String(rawTag);
    if (!SVG_ALLOWED_TAGS.has(tag)) return '';
    if (slash) return `</${tag}>`;

    const attrs: string[] = [];
    const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(String(rawAttrs))) !== null) {
      const name = m[1];
      const value = m[3] ?? m[4] ?? '';
      if (!SVG_ALLOWED_ATTRS.has(name)) continue;
      // No javascript:, data:, or external URL references anywhere.
      if (/(javascript|data|vbscript)\s*:/i.test(value)) continue;
      if (/\burl\s*\(\s*['"]?\s*(https?:)?\/\//i.test(value)) continue;
      attrs.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
    }
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? '/' : ''}>`;
  });

  if (!/^<svg[\s>]/i.test(svg)) throw new Error('SVG block did not survive sanitisation.');
  if (svg.length > 200_000) throw new Error('SVG block is too large (limit 200 KB).');
  return svg;
}

// --- Block schemas ---------------------------------------------------------

const textBlock = z.object({
  type: z.literal('text'),
  value: z.string().max(8000),
});

const mathBlock = z.object({
  type: z.literal('math'),
  /// LaTeX. Rendered client-side by KaTeX, which never executes anything.
  /// Covers fractions, roots, integrals, matrices, vectors, chemistry arrows.
  tex: z.string().max(4000),
  display: z.boolean().default(false), // true = own line, false = inline
});

const svgBlock = z.object({
  type: z.literal('svg'),
  svg: z.string().max(200_000),
  caption: z.string().max(500).optional(),
});

const mermaidBlock = z.object({
  type: z.literal('mermaid'),
  /// Flowcharts, trees, sequence and state diagrams, mind maps.
  code: z.string().max(8000),
  caption: z.string().max(500).optional(),
});

const chartSpecSchema = z.object({
  kind: z.enum(['line', 'bar', 'scatter', 'pie', 'numberline', 'function']),
  title: z.string().max(200).optional(),
  xLabel: z.string().max(100).optional(),
  yLabel: z.string().max(100).optional(),
  xMin: z.number().optional(),
  xMax: z.number().optional(),
  yMin: z.number().optional(),
  yMax: z.number().optional(),
  /// For kind = "function": plotted by evaluating a restricted expression
  /// grammar on the client. Never eval(). e.g. "x^2 - 3*x + 2"
  expression: z.string().max(300).optional(),
  categories: z.array(z.string().max(60)).max(60).optional(),
  series: z
    .array(
      z.object({
        name: z.string().max(80).optional(),
        points: z.array(z.tuple([z.number(), z.number()])).max(500).optional(),
        values: z.array(z.number()).max(200).optional(),
      }),
    )
    .max(8)
    .optional(),
  /// For kind = "numberline": marked points and shaded intervals.
  marks: z.array(z.object({ at: z.number(), label: z.string().max(40).optional(), filled: z.boolean().default(true) })).max(40).optional(),
  intervals: z.array(z.object({ from: z.number(), to: z.number(), label: z.string().max(40).optional() })).max(20).optional(),
});

const chartBlock = z.object({
  type: z.literal('chart'),
  spec: chartSpecSchema,
  caption: z.string().max(500).optional(),
});

const tableBlock = z.object({
  type: z.literal('table'),
  headers: z.array(z.string().max(200)).max(12),
  rows: z.array(z.array(z.string().max(400)).max(12)).max(50),
  caption: z.string().max(500).optional(),
});

const imageBlock = z.object({
  type: z.literal('image'),
  assetId: z.string().uuid(),
  alt: z.string().max(500).default(''),
  caption: z.string().max(500).optional(),
});

const codeBlock = z.object({
  type: z.literal('code'),
  language: z.string().max(30).default('text'),
  value: z.string().max(8000),
  /// Displayed as source for the student to read. Never executed anywhere.
  caption: z.string().max(500).optional(),
});

export const blockSchema = z.discriminatedUnion('type', [
  textBlock, mathBlock, svgBlock, mermaidBlock, chartBlock, tableBlock, imageBlock, codeBlock,
]);

export type Block = z.infer<typeof blockSchema>;

export const contentSchema = z.object({
  version: z.number().int().default(CONTENT_VERSION),
  blocks: z.array(blockSchema).min(1).max(40),
});

export type Content = z.infer<typeof contentSchema>;

export const optionSchema = z.object({
  id: z.string().min(1).max(8),
  blocks: z.array(blockSchema).min(1).max(12),
});

/**
 * Validates and normalises content coming from an LLM or an admin edit.
 * SVG blocks are sanitised here, once, on the way into the database — so
 * nothing unsafe is ever stored, not merely never displayed.
 */
export function normalizeContent(raw: unknown): Content {
  const parsed = contentSchema.parse(raw);
  return {
    version: CONTENT_VERSION,
    blocks: parsed.blocks.map((b) => (b.type === 'svg' ? { ...b, svg: sanitizeSvg(b.svg) } : b)),
  };
}

export function normalizeBlocks(raw: unknown): Block[] {
  const parsed = z.array(blockSchema).parse(raw);
  return parsed.map((b) => (b.type === 'svg' ? { ...b, svg: sanitizeSvg(b.svg) } : b));
}

export const EMPTY_CONTENT: Content = { version: CONTENT_VERSION, blocks: [] };

// --- Activity flashcards ---------------------------------------------------

/**
 * A flashcard is a titled stack of the very same blocks a question is made of.
 * That is deliberate: an admin explaining a formula gets KaTeX, an admin
 * explaining a circuit gets SVG, and neither needed a new content pipeline.
 */
export const activityCardSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().max(200).optional(),
  blocks: z.array(blockSchema).min(1).max(20),
});

export type ActivityCard = z.infer<typeof activityCardSchema>;

export const activityContentSchema = z.object({
  version: z.number().int().default(CONTENT_VERSION),
  cards: z.array(activityCardSchema).max(50).default([]),
});

export type ActivityContent = z.infer<typeof activityContentSchema>;

/** Same contract as normalizeContent: SVG is sanitised on the way in. */
export function normalizeActivityContent(raw: unknown): ActivityContent {
  const parsed = activityContentSchema.parse(raw);
  return {
    version: CONTENT_VERSION,
    cards: parsed.cards.map((card) => ({
      ...card,
      blocks: card.blocks.map((b) => (b.type === 'svg' ? { ...b, svg: sanitizeSvg(b.svg) } : b)),
    })),
  };
}

export const EMPTY_ACTIVITY_CONTENT: ActivityContent = { version: CONTENT_VERSION, cards: [] };

/** Flattens blocks to plain text, for search and for CSV export. */
export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'text': return b.value;
        case 'math': return `$${b.tex}$`;
        case 'table': return [b.headers.join(' | '), ...b.rows.map((r) => r.join(' | '))].join(' ; ');
        case 'code': return b.value;
        case 'svg': return b.caption ? `[diagram: ${b.caption}]` : '[diagram]';
        case 'mermaid': return b.caption ? `[diagram: ${b.caption}]` : '[diagram]';
        case 'chart': return `[chart: ${b.spec.title ?? b.spec.kind}]`;
        case 'image': return `[image: ${b.alt || 'figure'}]`;
        default: return '';
      }
    })
    .filter(Boolean)
    .join(' ');
}
