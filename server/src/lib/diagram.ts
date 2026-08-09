import type { Block, DiagramSpec } from './content.js';

/**
 * Catching a drawing that cannot be what it says it is.
 *
 * The failure this exists for: a model returns
 *
 *   { "type": "svg", "caption": "Similar Triangles ABC and DEF",
 *     "svg": "<svg viewBox='0 0 300 300'><path d='M20 280 L120 100' stroke='#000'/></svg>" }
 *
 * One diagonal stroke. The SVG is valid, it sanitises cleanly, it renders, and
 * it is completely meaningless - there are no triangles and no labels. Nothing
 * in the pipeline noticed, so it reached the review screen looking like a
 * diagram, and would have reached a child as a question with a picture that
 * does not contain the information the question refers to.
 *
 * Every check here is structural and cheap. None of them can tell a good
 * diagram from a mediocre one - that is what review is for - but all of them
 * catch a drawing that is definitively not the thing described:
 *
 *   1. no viewBox        it will not scale, and it is not what was asked for
 *   2. too few marks     a "triangle" made of one line segment
 *   3. missing labels    "triangle ABC" with no A, B or C anywhere in it
 *
 * Where the model supplied a spec, its labels are the contract. Where it did
 * not, the labels are inferred from the question's own text - which is what
 * makes this work on the questions already in the bank.
 */

/** Elements that put a mark on the page. <g>, <defs> and <text> do not count. */
const DRAWING_ELEMENTS = /<\s*(line|polyline|polygon|path|rect|circle|ellipse)\b([^>]*)>/gi;

/** Path commands that move the pen somewhere, ignoring the opening moveto. */
const PATH_STEPS = /[LlHhVvCcSsQqTtAaZz]/g;

/** The text a drawing actually contains, from <text> and <tspan>. */
function textIn(svg: string): string {
  const out: string[] = [];
  const re = /<\s*(text|tspan)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    // Nested tspans are matched again by the outer pass; stripping tags here
    // means the parent contributes its children's text once more, which is
    // harmless for a containment test.
    out.push(m[2].replace(/<[^>]*>/g, ' '));
  }
  return out.join(' ');
}

/**
 * Roughly how much figure is on the page.
 *
 * Not a count of elements: a triangle is legitimately one <polygon>, while
 * "triangle ABC" drawn as a single <line> is not a triangle at all. So a closed
 * shape scores as a whole figure and an open stroke scores as a stroke, and the
 * bar is set at one whole figure's worth. Everything below is a drawing that
 * cannot be what its caption says it is.
 */
const WHOLE_FIGURE = 2;

function drawingWeight(svg: string): number {
  DRAWING_ELEMENTS.lastIndex = 0;
  let score = 0;
  let m: RegExpExecArray | null;
  while ((m = DRAWING_ELEMENTS.exec(svg)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (tag === 'rect' || tag === 'circle' || tag === 'ellipse' || tag === 'polygon') {
      score += WHOLE_FIGURE;
    } else if (tag === 'polyline') {
      const points = (attrs.match(/[-\d.]+\s*[, ]\s*[-\d.]+/g) ?? []).length;
      score += points > 2 ? WHOLE_FIGURE : 1;
    } else if (tag === 'path') {
      const d = /\bd\s*=\s*("([^"]*)"|'([^']*)')/.exec(attrs);
      const steps = ((d?.[2] ?? d?.[3] ?? '').match(PATH_STEPS) ?? []).length;
      score += steps > 1 ? WHOLE_FIGURE : 1;
    } else {
      score += 1; // <line>
    }
  }
  return score;
}

/**
 * Vertex names the question itself uses, e.g. "triangle ABC", "quadrilateral
 * PQRS", "the segment XY".
 *
 * Deliberately anchored to a shape word. Bare capitals in a sentence are
 * everywhere - "If AB = 15 cm" is one, but so is "A student in Grade B" - and
 * an over-eager rule here would reject good diagrams, which is worse than
 * missing a bad one.
 */
const SHAPE_WORDS =
  /\b(?:triangles?|quadrilaterals?|rectangles?|squares?|parallelograms?|trapezi(?:um|ums|a)|trapezoids?|rhombus(?:es)?|polygons?|pentagons?|hexagons?|circles?|segments?|lines?|angles?|arcs?|chords?)\s+([A-Za-z]{2,6})\b/gi;

/** "…ABC and DEF", "…PQR, STU" - further names sharing one shape word. */
const MORE_NAMES = /(?:\s*,\s*|\s+and\s+)([A-Za-z]{2,6})\b/y;

export function labelsInQuestionText(text: string): string[] {
  const found = new Set<string>();
  const take = (name: string): boolean => {
    // The shape word is matched case-insensitively so that a caption reading
    // "Triangle ABC" counts, but the name itself must still be written in
    // capitals - otherwise "the triangle above" contributes A, B, O, V and E.
    if (name !== name.toUpperCase()) return false;
    for (const letter of name) found.add(letter);
    return true;
  };

  SHAPE_WORDS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHAPE_WORDS.exec(text)) !== null) {
    if (!take(m[1])) continue;
    // "Similar Triangles ABC and DEF" names two figures off one shape word.
    MORE_NAMES.lastIndex = m.index + m[0].length;
    let more: RegExpExecArray | null;
    while ((more = MORE_NAMES.exec(text)) !== null && take(more[1])) {
      MORE_NAMES.lastIndex = more.index + more[0].length;
    }
  }
  return [...found];
}

export interface DiagramProblem {
  /** One sentence an administrator can act on. */
  reason: string;
  /** Labels the drawing was supposed to contain and does not. */
  missingLabels: string[];
}

/**
 * What is definitively wrong with this drawing, or null when nothing is.
 *
 * `questionText` is the stem, used to work out the expected labels when the
 * model did not supply a spec.
 */
export function checkDiagram(block: Block, questionText = ''): DiagramProblem | null {
  if (block.type === 'mermaid') {
    // Mermaid draws its own labels, so the only useful check is that there is
    // more than one node - a graph with a single box is not a diagram.
    const nodes = (block.code.match(/-->|---|-\.->|==>/g) ?? []).length;
    if (nodes === 0) {
      return { reason: 'the flow chart has no connections, so it shows a single box', missingLabels: [] };
    }
    return null;
  }

  if (block.type !== 'svg') return null;
  const svg = block.svg;

  if (!/viewBox\s*=/i.test(svg)) {
    return { reason: 'the drawing has no viewBox, so it cannot be sized on the page', missingLabels: [] };
  }

  const weight = drawingWeight(svg);
  if (weight < WHOLE_FIGURE) {
    return {
      reason:
        weight === 0
          ? 'the drawing contains nothing that would appear on the page'
          : 'the drawing is a single stroke, which cannot be the figure it is captioned as',
      missingLabels: [],
    };
  }

  // Which labels this drawing promised to contain.
  const spec = (block as { spec?: DiagramSpec }).spec;
  const expected = spec?.labels?.length
    ? spec.labels
    : labelsInQuestionText(`${questionText} ${block.caption ?? ''}`);

  if (expected.length === 0) return null;

  const drawn = textIn(svg);
  const missing = expected.filter((label) => !drawn.includes(label));

  // One missing label out of six is a model being sloppy; most of them missing
  // means the drawing is not of this figure at all. The line is drawn at half
  // so that a nearly-complete diagram still reaches review, where a human can
  // judge it, rather than being thrown out by a rule that cannot.
  if (missing.length > expected.length / 2) {
    return {
      reason:
        `the drawing does not contain ${missing.length === expected.length ? 'any' : 'most'} of the labels the ` +
        `question refers to (${missing.join(', ')})`,
      missingLabels: missing,
    };
  }

  return null;
}

/**
 * What the drawing was meant to show, in plain words.
 *
 * Used two ways: shown to an administrator next to a figure so they can judge
 * it against its own brief, and turned into a picture request when the drawing
 * is thrown away. Falls back to the caption when the model gave no spec, which
 * is all that questions generated before this existed have.
 */
export function describeDiagram(block: Block, questionText = ''): { description: string; details: string[] } {
  const spec = (block as { spec?: DiagramSpec }).spec;
  const caption = (block as { caption?: string }).caption?.trim();
  // An attached picture carries its wording in alt text rather than a spec.
  const alt = (block as { alt?: string }).alt?.trim();
  const description = spec?.description?.trim() || caption || alt || questionText.slice(0, 400).trim();

  const details: string[] = [];
  const labels = spec?.labels?.length ? spec.labels : labelsInQuestionText(`${questionText} ${caption ?? ''}`);
  if (labels.length) details.push(`Label these clearly: ${labels.join(', ')}.`);
  for (const item of spec?.mustShow ?? []) details.push(item);
  if (caption && caption !== description) details.push(`The figure is captioned "${caption}".`);
  return { description, details };
}

/** A block that shows a picture: one the model drew, or one attached later. */
export function isFigure(block: Block): boolean {
  return block.type === 'svg' || block.type === 'mermaid' || block.type === 'image';
}

/** Where this question's figure is, or -1 when it has none. */
export function figureIndex(blocks: Block[]): number {
  return blocks.findIndex(isFigure);
}
