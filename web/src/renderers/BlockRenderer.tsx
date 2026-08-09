import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import katex from 'katex';
import type { Block, ChartSpec, Content } from '../lib/types';
import { BarChart, LineChart, NumberLine, PieChart, ScatterChart, DataTable } from '../components/charts';
import { samplePoints } from '../lib/expr';

/**
 * Renders question content.
 *
 * Content is a list of typed blocks rather than an HTML string, which is what
 * makes it possible to support maths, diagrams, charts and (later) interactive
 * simulations without ever putting model-authored markup into the DOM.
 *
 * To add a new content type - a simulation, an audio clip, a drag-and-drop
 * figure - add a case here and a matching entry in the server's block schema.
 * Nothing else changes, and existing questions are unaffected.
 */

/**
 * Whether a block belongs in the flow of a sentence rather than on its own.
 *
 * Text and inline maths do; display maths, diagrams, tables and code are
 * paragraph-level things that earn their own line.
 */
function isInline(block: Block): boolean {
  return block.type === 'text' || (block.type === 'math' && !block.display);
}

/**
 * Groups blocks into rendering runs.
 *
 * Each block used to render as its own paragraph, so a question written as
 * text + inline maths + text - "the area of a circle is", A = πr², "where r is
 * the radius" - came out as three stacked lines instead of one sentence. That
 * is a single sentence the model happened to send in three pieces, and it
 * should read as one.
 *
 * A run is only merged when it actually mixes types. Two consecutive text
 * blocks stay two paragraphs, because a model that sends two paragraphs means
 * two paragraphs; it is the mixing that was never intended as a line break.
 */
function groupBlocks(blocks: Block[]): Array<{ inline: boolean; blocks: Block[] }> {
  const groups: Array<{ inline: boolean; blocks: Block[] }> = [];

  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (isInline(block) && last?.inline) last.blocks.push(block);
    else groups.push({ inline: isInline(block), blocks: [block] });
  }

  // A run of nothing but text is still separate paragraphs.
  return groups.map((g) =>
    g.inline && g.blocks.every((b) => b.type === 'text')
      ? { inline: false, blocks: g.blocks }
      : g,
  ).flatMap((g) =>
    g.inline ? [g] : g.blocks.map((b) => ({ inline: false, blocks: [b] })),
  );
}

function GroupedBlocks({ blocks, className = '' }: { blocks: Block[]; className?: string }) {
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);

  return (
    <div className={className}>
      {groups.map((group, i) =>
        group.inline ? (
          <p key={i} className="my-1.5 whitespace-pre-wrap leading-relaxed">
            {group.blocks.map((block, j) => (
              <InlineBlock key={j} block={block} spaceBefore={needsSpaceBetween(group.blocks[j - 1], block)} />
            ))}
          </p>
        ) : (
          <BlockRenderer key={i} block={group.blocks[0]} />
        ),
      )}
    </div>
  );
}

/**
 * Whether two adjacent pieces of one sentence need a space between them.
 *
 * The model sends "the area of a circle is" and the formula as separate
 * blocks, neither carrying a space of its own, so without this they render as
 * "circle isA = pi r^2". A formula counts as having no whitespace on either
 * side; text is inspected for its own.
 */
function needsSpaceBetween(before: Block | undefined, after: Block): boolean {
  if (!before) return false;
  const endsOpen = before.type === 'text' ? !/\s$/.test(before.value) : true;
  const startsOpen = after.type === 'text' ? !/^\s/.test(after.value) : true;
  return endsOpen && startsOpen;
}

/** The inline half of BlockRenderer: never emits a block-level element. */
function InlineBlock({ block, spaceBefore }: { block: Block; spaceBefore: boolean }) {
  const content =
    block.type === 'math' ? <InlineMath tex={block.tex} />
    : block.type === 'text' ? <InlineText value={block.value} />
    : null;

  if (!content) return null;
  return spaceBefore ? <>{' '}{content}</> : content;
}

export function ContentRenderer({ content, className = '' }: { content?: Content | null; className?: string }) {
  if (!content?.blocks?.length) return null;
  return <GroupedBlocks blocks={content.blocks} className={className} />;
}

export function BlocksRenderer({ blocks, className = '' }: { blocks?: Block[] | null; className?: string }) {
  if (!blocks?.length) return null;
  return <GroupedBlocks blocks={blocks} className={className} />;
}

export function BlockRenderer({ block }: { block: Block }) {
  switch (block.type) {
    case 'text':
      return <TextBlock value={block.value} />;
    case 'math':
      return <MathBlock tex={block.tex} display={block.display} />;
    case 'svg':
      return <SvgBlock svg={block.svg} caption={block.caption} />;
    case 'mermaid':
      return <MermaidBlock code={block.code} caption={block.caption} />;
    case 'chart':
      return <ChartBlock spec={block.spec} caption={block.caption} />;
    case 'table':
      return <TableBlock headers={block.headers} rows={block.rows} caption={block.caption} />;
    case 'image':
      return (
        <ImageBlock
          assetId={block.assetId}
          alt={block.alt}
          caption={block.caption}
          width={block.width}
          height={block.height}
        />
      );
    case 'code':
      return <CodeBlock language={block.language} value={block.value} caption={block.caption} />;
    default:
      return null;
  }
}

// --- Text ------------------------------------------------------------------

/**
 * Plain text. Inline `$...$` is still rendered as maths, because models slip
 * LaTeX into text blocks however firmly the prompt tells them not to.
 */
function TextBlock({ value }: { value: string }) {
  return (
    <p className="my-1.5 whitespace-pre-wrap leading-relaxed">
      <InlineText value={value} />
    </p>
  );
}

/** The same text without the paragraph, so it can sit mid-sentence. */
function InlineText({ value }: { value: string }) {
  const parts = useMemo(() => splitInlineMath(value), [value]);

  return (
    <>
      {parts.map((part, i) =>
        part.type === 'math' ? <InlineMath key={i} tex={part.value} /> : <span key={i}>{part.value}</span>,
      )}
    </>
  );
}

function splitInlineMath(text: string): Array<{ type: 'text' | 'math'; value: string }> {
  const out: Array<{ type: 'text' | 'math'; value: string }> = [];
  const re = /\$([^$\n]+)\$/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    out.push({ type: 'math', value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out.length ? out : [{ type: 'text', value: text }];
}

// --- Maths -----------------------------------------------------------------

function renderKatex(tex: string, displayMode: boolean): { html: string; error: string | null } {
  try {
    return {
      html: katex.renderToString(tex, {
        displayMode,
        throwOnError: false,
        strict: false,
        // Hard cap on macro expansion: a malicious or looping macro cannot
        // lock the browser during an exam.
        maxExpand: 200,
        trust: false,
        output: 'html',
      }),
      error: null,
    };
  } catch (err) {
    return { html: '', error: err instanceof Error ? err.message : 'Could not render this formula.' };
  }
}

function InlineMath({ tex }: { tex: string }) {
  const { html, error } = useMemo(() => renderKatex(tex, false), [tex]);
  if (error) return <code className="text-bad text-xs">{tex}</code>;
  // KaTeX output is generated by KaTeX from the TeX source, not model markup.
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function MathBlock({ tex, display }: { tex: string; display?: boolean }) {
  const { html, error } = useMemo(() => renderKatex(tex, !!display), [tex, display]);

  if (error) {
    return (
      <div className="my-2 rounded-lg border border-line bg-surface-sunken px-3 py-2">
        <div className="text-xs text-bad mb-1">This formula could not be rendered.</div>
        <code className="text-xs font-mono break-all">{tex}</code>
      </div>
    );
  }

  return (
    <div
      className={display ? 'my-2 overflow-x-auto' : 'inline'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// --- Figures ---------------------------------------------------------------

/**
 * A figure, capped in height, that opens to full size when clicked.
 *
 * Every diagram and picture is bounded by --fig-max-h (see index.css), because
 * an unbounded 1800px illustration fills the card and pushes the options and
 * every following question off the screen - reviewing twenty questions then
 * means scrolling past twenty posters.
 *
 * Capping costs detail, though: the labels on an anatomy diagram stop being
 * legible, and an admin reviewing that question needs to read them. So one
 * click lifts the cap for that one figure and a second click puts it back.
 *
 * A div with role="button" rather than a real <button>, because a <figure>'s
 * contents are flow content and nesting them inside a button is invalid markup
 * that some assistive technology flattens to nothing.
 */
function ZoomFigure({
  children, caption, label,
}: { children: ReactNode; caption?: string; label: string }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((o) => !o);

  return (
    <figure className={`my-3 ${open ? 'figure-open' : ''}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${open ? 'Shrink' : 'Enlarge'} this ${label}`}
        title={open ? 'Click to shrink' : 'Click to enlarge'}
        className={open ? 'cursor-zoom-out' : 'cursor-zoom-in'}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {children}
      </div>
      {caption && <figcaption className="mt-1 text-xs text-ink-faint">{caption}</figcaption>}
    </figure>
  );
}

// --- SVG -------------------------------------------------------------------

/**
 * SVG is sanitised on the server before it is ever stored. This second pass is
 * defence in depth: if a question were ever written to the database by another
 * route, it still cannot introduce script into the page.
 */
function clientSanitizeSvg(svg: string): string {
  return svg
    .replace(/<\s*(script|foreignObject|iframe|object|embed|animate|set|handler)\b[\s\S]*?<\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject|iframe|object|embed|animate|set|handler)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');
}

/**
 * The drawing's width:height ratio, read from its viewBox.
 *
 * A viewBox-only SVG has an intrinsic ratio but no intrinsic size, so the
 * browser cannot cap its height for us: `max-height` on the element letterboxes
 * the drawing inside a box that stays the full width. Sizing the container by
 * the ratio instead bounds the height exactly, with no empty margins.
 */
function aspectFromViewBox(svg: string): number | null {
  const m = /viewBox\s*=\s*["']\s*[-\d.eE]+[\s,]+[-\d.eE]+[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)/.exec(svg);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? width / height : null;
}

/** The host's own padding and border, which the height cap must not eat into. */
const SVG_HOST_CHROME_PX = 26;

function SvgBlock({ svg, caption }: { svg: string; caption?: string }) {
  const safe = useMemo(() => clientSanitizeSvg(svg), [svg]);
  const ratio = useMemo(() => aspectFromViewBox(svg), [svg]);

  // The generator is told to emit a viewBox and no fixed width/height, so the
  // SVG has no intrinsic size and must be given a display width here - without
  // one, a viewBox-only figure collapses to a few pixels. The width is bounded
  // three ways: by the column, by --fig-max-w, and by whatever width keeps the
  // drawing inside --fig-max-h.
  const chrome = `${SVG_HOST_CHROME_PX}px`;
  const width = ratio
    ? `min(100%, calc(var(--fig-max-w) + ${chrome}), calc(var(--fig-max-h) * ${ratio} + ${chrome}))`
    : `min(100%, calc(var(--fig-max-w) + ${chrome}))`;

  return (
    <ZoomFigure caption={caption} label="diagram">
      {/*
        svg-host supplies the stroke/fill defaults a model-authored diagram
        usually forgets; see the note in index.css.
      */}
      <div
        className="svg-host inline-block max-w-full overflow-x-auto rounded-lg border border-line bg-white p-3
                   text-ink [&>svg]:w-full [&>svg]:h-auto [&>svg]:block"
        style={{ width }}
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    </ZoomFigure>
  );
}

// --- Mermaid ---------------------------------------------------------------

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;

/** Loaded on demand: mermaid is large and most questions never use it. */
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict', // no click handlers, no raw HTML labels
        theme: 'base',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        themeVariables: {
          background: '#ffffff',
          primaryColor: '#f6f6f4',
          primaryTextColor: '#0b0b0b',
          primaryBorderColor: '#d5d4cf',
          lineColor: '#8a8983',
          fontSize: '14px',
        },
      });
      return mod;
    });
  }
  return mermaidPromise;
}

function MermaidBlock({ code, caption }: { code: string; caption?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    let cancelled = false;

    loadMermaid()
      .then(async (mod) => {
        const { svg: rendered } = await mod.default.render(idRef.current, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not draw this diagram.');
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-line bg-surface-sunken p-3">
        <div className="text-xs text-bad mb-1">This diagram could not be drawn.</div>
        <pre className="text-xs font-mono whitespace-pre-wrap text-ink-muted">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return <div className="my-3 h-24 rounded-lg border border-line bg-surface-sunken animate-pulse" aria-label="Loading diagram" />;
  }

  return (
    <ZoomFigure caption={caption} label="diagram">
      <div
        className="mermaid-host inline-block max-w-full overflow-x-auto rounded-lg border border-line bg-white p-3"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ZoomFigure>
  );
}

// --- Charts ----------------------------------------------------------------

function ChartBlock({ spec, caption }: { spec: ChartSpec; caption?: string }) {
  const common = { title: spec.title, caption, xLabel: spec.xLabel, yLabel: spec.yLabel };

  switch (spec.kind) {
    case 'bar': {
      const categories = spec.categories ?? [];
      const series = (spec.series ?? []).map((s, i) => ({ name: s.name ?? `Series ${i + 1}`, values: s.values ?? [] }));
      return (
        <BarChart
          {...common}
          categories={categories}
          series={series}
          table={
            <DataTable
              headers={[spec.xLabel ?? 'Category', ...series.map((s) => s.name)]}
              rows={categories.map((c, i) => [c, ...series.map((s) => s.values[i] ?? 0)])}
            />
          }
        />
      );
    }

    case 'line': {
      const series = (spec.series ?? []).map((s, i) => ({
        name: s.name ?? `Series ${i + 1}`,
        points: s.points ?? (s.values ?? []).map((v, x) => [x, v] as [number, number]),
      }));
      return (
        <LineChart
          {...common}
          series={series}
          xMin={spec.xMin} xMax={spec.xMax} yMin={spec.yMin} yMax={spec.yMax}
          xTickLabels={spec.categories}
          table={
            <DataTable
              headers={[spec.xLabel ?? 'x', ...series.map((s) => s.name)]}
              rows={(series[0]?.points ?? []).map((p, i) => [
                spec.categories?.[i] ?? p[0],
                ...series.map((s) => s.points[i]?.[1] ?? ''),
              ])}
            />
          }
        />
      );
    }

    case 'scatter': {
      const series = (spec.series ?? []).map((s, i) => ({ name: s.name ?? `Series ${i + 1}`, points: s.points ?? [] }));
      return <ScatterChart {...common} series={series} />;
    }

    case 'pie': {
      const values = spec.series?.[0]?.values ?? [];
      const labels = spec.categories ?? values.map((_, i) => `Item ${i + 1}`);
      return (
        <PieChart
          title={spec.title}
          caption={caption}
          labels={labels}
          values={values}
          table={<DataTable headers={['Category', 'Value']} rows={labels.map((l, i) => [l, values[i] ?? 0])} />}
        />
      );
    }

    case 'numberline':
      return (
        <NumberLine
          title={spec.title}
          caption={caption}
          xMin={spec.xMin ?? -10}
          xMax={spec.xMax ?? 10}
          marks={spec.marks}
          intervals={spec.intervals}
        />
      );

    case 'function': {
      const xMin = spec.xMin ?? -10;
      const xMax = spec.xMax ?? 10;

      let points: [number, number][] = [];
      let error: string | null = null;
      try {
        points = spec.expression ? samplePoints(spec.expression, xMin, xMax) : [];
      } catch (err) {
        error = err instanceof Error ? err.message : 'Could not plot this function.';
      }

      if (error || points.length === 0) {
        return (
          <div className="my-3 rounded-lg border border-line bg-surface-sunken p-3 text-xs">
            <span className="text-bad">This graph could not be plotted{error ? `: ${error}` : ''}.</span>
            {spec.expression && <code className="ml-1 font-mono">y = {spec.expression}</code>}
          </div>
        );
      }

      return (
        <LineChart
          {...common}
          title={spec.title ?? (spec.expression ? `y = ${spec.expression}` : undefined)}
          series={[{ name: spec.expression ?? 'f(x)', points }]}
          xMin={xMin} xMax={xMax} yMin={spec.yMin} yMax={spec.yMax}
          showMarkers={false}
        />
      );
    }

    default:
      return null;
  }
}

// --- Table -----------------------------------------------------------------

function TableBlock({ headers, rows, caption }: { headers: string[]; rows: string[][]; caption?: string }) {
  return (
    <figure className="my-3">
      <div className="scroll-x rounded-lg border border-line">
        <table className="table-base">
          <thead className="bg-surface-sunken">
            <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption && <figcaption className="mt-1 text-xs text-ink-faint">{caption}</figcaption>}
    </figure>
  );
}

// --- Image -----------------------------------------------------------------

/**
 * A picture attached to a question.
 *
 * width and height are given whenever they are known, so the browser reserves
 * the right space before the file arrives. Without them the figure is zero
 * pixels tall until it loads and then shoves the question text down - which,
 * mid-exam on a slow connection, means a student taps an option that has just
 * moved. aspect-ratio does the reserving; max-width keeps it inside the column
 * and max-height keeps a tall picture from filling the screen, both preserving
 * the ratio because the other dimension is auto.
 */
function ImageBlock({
  assetId, alt, caption, width, height,
}: { assetId: string; alt?: string; caption?: string; width?: number; height?: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className="my-3 rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-faint">
        {alt ? `Image unavailable: ${alt}` : 'This image is unavailable.'}
      </div>
    );
  }

  return (
    <ZoomFigure caption={caption} label="picture">
      <img
        src={`/uploads/${assetId}`}
        alt={alt ?? ''}
        loading="lazy"
        {...(width && height ? { width, height } : {})}
        onError={() => setFailed(true)}
        className="w-auto h-auto max-w-full max-h-[var(--fig-max-h)] rounded-lg border border-line bg-white"
        style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}
      />
    </ZoomFigure>
  );
}

// --- Code ------------------------------------------------------------------

/**
 * Source code shown to the student to read. It is never executed - not here,
 * not on the server.
 */
function CodeBlock({ language, value, caption }: { language?: string; value: string; caption?: string }) {
  return (
    <figure className="my-3">
      <div className="rounded-lg border border-line bg-surface-sunken overflow-hidden">
        {language && language !== 'text' && (
          <div className="px-3 py-1 text-[11px] font-medium text-ink-faint border-b border-line bg-white/60">
            {language}
          </div>
        )}
        <pre className="scroll-x p-3 text-xs font-mono leading-relaxed">
          <code>{value}</code>
        </pre>
      </div>
      {caption && <figcaption className="mt-1 text-xs text-ink-faint">{caption}</figcaption>}
    </figure>
  );
}
