import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

/**
 * Hand-rolled SVG charts.
 *
 * Written rather than imported so the bundle stays small on the A1 instance and
 * so the same primitives serve both the analytics dashboards and the `chart`
 * blocks inside questions.
 *
 * Design rules applied throughout (from the validated palette):
 *  - Categorical hues are assigned in a FIXED order and never cycled past 8.
 *  - A single series uses slot 1 and gets no legend box; the title names it.
 *  - Sequential/ordinal ramps are never used to re-encode bar length as hue.
 *  - Gridlines and axes are solid hairlines one shade off the surface.
 *  - Marks are thin: 2px lines, 4px rounded data-ends, >=8px markers.
 *  - Every chart has a hover layer and an accessible table fallback.
 */

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;

const GRID = '#e6e5e1';
const AXIS = '#d5d4cf';
const INK_MUTED = '#52514e';
const INK_FAINT = '#8a8983';
const SURFACE = '#fcfcfb';

/**
 * Measures the chart's own container so an SVG fills the card it sits in
 * rather than stranding empty space on a wide screen. The `width` prop
 * becomes a fallback for the first paint and a floor for narrow screens.
 */
function useContainerWidth(fallback: number, min = 320) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0].contentRect.width);
      if (next > 0) setWidth(Math.max(next, min));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [min]);

  return [ref, width] as const;
}

export function seriesColor(index: number): string {
  // Never generate a 9th hue - fold into the last slot instead.
  return SERIES[Math.min(index, SERIES.length - 1)];
}

// --- Shared scaffolding ----------------------------------------------------

interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const DEFAULT_PAD: Padding = { top: 14, right: 16, bottom: 34, left: 44 };

/** Chooses ~5 round tick values covering [min, max]. */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  const span = max - min;
  const rawStep = span / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const step = (normalized >= 5 ? 10 : normalized >= 2 ? 5 : normalized >= 1 ? 2 : 1) * magnitude;

  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step / 2; v += step) {
    ticks.push(Math.round(v * 1e10) / 1e10);
  }
  return ticks;
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 10000) return n.toLocaleString();
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

interface ChartFrameProps {
  title?: string;
  caption?: string;
  height?: number;
  /** Receives the measured container width so the plot fills its card. */
  children: (width: number) => React.ReactNode;
  fallbackWidth?: number;
  minWidth?: number;
  /** Rendered under a "Show data" toggle; required for accessibility relief. */
  table?: React.ReactNode;
  legend?: Array<{ label: string; color: string }>;
}

export function ChartFrame({ title, caption, children, table, legend, fallbackWidth = 640, minWidth = 320 }: ChartFrameProps) {
  const [showTable, setShowTable] = useState(false);
  const [ref, width] = useContainerWidth(fallbackWidth, minWidth);

  return (
    <figure className="my-2">
      {title && <figcaption className="text-sm font-medium text-ink mb-1">{title}</figcaption>}

      {/* A legend is always present for >= 2 series, so identity is never colour alone. */}
      {legend && legend.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
          {legend.map((entry) => (
            <span key={entry.label} className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: entry.color }} aria-hidden />
              {entry.label}
            </span>
          ))}
        </div>
      )}

      <div className="scroll-x" ref={ref}>{children(width)}</div>

      <div className="flex items-baseline justify-between gap-3 mt-1">
        {caption ? <span className="text-xs text-ink-faint">{caption}</span> : <span />}
        {table && (
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="text-xs text-ink-muted hover:text-ink underline underline-offset-2 shrink-0"
          >
            {showTable ? 'Hide data' : 'Show data'}
          </button>
        )}
      </div>

      {showTable && table && <div className="scroll-x mt-2">{table}</div>}
    </figure>
  );
}

interface Tooltip {
  x: number;
  y: number;
  lines: string[];
}

function TooltipBox({ tip, width }: { tip: Tooltip; width: number }) {
  const boxWidth = Math.max(...tip.lines.map((l) => l.length)) * 6.2 + 16;
  // Flip to the left of the cursor when it would otherwise run off the edge.
  const flip = tip.x + boxWidth + 12 > width;
  const x = flip ? tip.x - boxWidth - 10 : tip.x + 10;

  return (
    <g pointerEvents="none">
      <rect
        x={x}
        y={tip.y - 8}
        width={boxWidth}
        height={tip.lines.length * 15 + 10}
        rx={6}
        fill="#ffffff"
        stroke={AXIS}
        strokeWidth={1}
        opacity={0.98}
      />
      {tip.lines.map((line, i) => (
        <text
          key={i}
          x={x + 8}
          y={tip.y + 7 + i * 15}
          fontSize={11.5}
          fill={i === 0 ? '#0b0b0b' : INK_MUTED}
          fontWeight={i === 0 ? 600 : 400}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

// --- Line chart ------------------------------------------------------------

export interface LineSeries {
  name: string;
  points: [number, number][];
}

interface LineChartProps {
  series: LineSeries[];
  width?: number;
  height?: number;
  xLabel?: string;
  yLabel?: string;
  title?: string;
  caption?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  /** Labels for the x axis when x values are indices, e.g. test names. */
  xTickLabels?: string[];
  showMarkers?: boolean;
  /** Horizontal reference line, e.g. a pass mark. */
  reference?: { value: number; label: string };
  formatY?: (n: number) => string;
  table?: React.ReactNode;
}

export function LineChart(props: LineChartProps) {
  const { title, caption, table, series, width = 640 } = props;
  return (
    <ChartFrame
      title={title}
      caption={caption}
      table={table}
      fallbackWidth={width}
      legend={series.map((s, i) => ({ label: s.name, color: seriesColor(i) }))}
    >
      {(measured) => <LinePlot {...props} width={measured} />}
    </ChartFrame>
  );
}

function LinePlot({
  series, width = 640, height = 240, xLabel, yLabel, title,
  xMin, xMax, yMin, yMax, xTickLabels, showMarkers = true, reference, formatY = formatNumber,
}: LineChartProps) {
  const [tip, setTip] = useState<Tooltip | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const clipId = useId();

  const pad: Padding = { ...DEFAULT_PAD, left: yLabel ? 52 : 44, bottom: xLabel ? 46 : 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const all = series.flatMap((s) => s.points);
  if (all.length === 0) {
    return <EmptyChart title={title} height={height} message="No data yet." />;
  }

  const x0 = xMin ?? Math.min(...all.map((p) => p[0]));
  const x1 = xMax ?? Math.max(...all.map((p) => p[0]));
  const rawY0 = yMin ?? Math.min(...all.map((p) => p[1]));
  const rawY1 = yMax ?? Math.max(...all.map((p) => p[1]));

  const yTicks = niceTicks(rawY0, rawY1);
  const y0 = yMin ?? Math.min(rawY0, yTicks[0]);
  const y1 = yMax ?? Math.max(rawY1, yTicks[yTicks.length - 1]);

  const sx = (v: number) => pad.left + (x1 === x0 ? plotW / 2 : ((v - x0) / (x1 - x0)) * plotW);
  const sy = (v: number) => pad.top + plotH - (y1 === y0 ? plotH / 2 : ((v - y0) / (y1 - y0)) * plotH);

  const xTicks = xTickLabels
    ? xTickLabels.map((label, i) => ({ value: i, label }))
    : niceTicks(x0, x1).filter((t) => t >= x0 && t <= x1).map((t) => ({ value: t, label: formatNumber(t) }));

  // With many points, thin the x labels so they never collide.
  const labelStride = Math.ceil(xTicks.length / Math.max(2, Math.floor(plotW / 70)));

  const onMove = (event: React.MouseEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left + pad.left;
    const dataX = x0 + ((px - pad.left) / plotW) * (x1 - x0);

    let best: { d: number; point: [number, number]; name: string; color: string } | null = null;
    series.forEach((s, si) => {
      for (const point of s.points) {
        const d = Math.abs(point[0] - dataX);
        if (!best || d < best.d) best = { d, point, name: s.name, color: seriesColor(si) };
      }
    });
    if (!best) return;

    const found = best as { d: number; point: [number, number]; name: string; color: string };
    const xLabelText = xTickLabels?.[Math.round(found.point[0])] ?? formatNumber(found.point[0]);
    setHoverX(sx(found.point[0]));
    setTip({
      x: sx(found.point[0]),
      y: sy(found.point[1]),
      lines: [xLabelText, ...(series.length > 1 ? [`${found.name}: ${formatY(found.point[1])}`] : [formatY(found.point[1])])],
    });
  };

  return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={title ?? 'Line chart'}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.left} y={pad.top} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* Hairline grid, one shade off the surface, solid never dashed. */}
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.left - 8} y={sy(t) + 4} fontSize={11} fill={INK_FAINT} textAnchor="end">
              {formatY(t)}
            </text>
          </g>
        ))}

        <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH} y2={pad.top + plotH} stroke={AXIS} strokeWidth={1} />

        {xTicks.map((t, i) =>
          i % labelStride === 0 ? (
            <text key={`${t.value}-${i}`} x={sx(t.value)} y={pad.top + plotH + 16} fontSize={11} fill={INK_FAINT} textAnchor="middle">
              {t.label.length > 12 ? `${t.label.slice(0, 11)}…` : t.label}
            </text>
          ) : null,
        )}

        {reference && (
          <g>
            <line
              x1={pad.left} x2={pad.left + plotW} y1={sy(reference.value)} y2={sy(reference.value)}
              stroke={INK_FAINT} strokeWidth={1} strokeDasharray="4 3"
            />
            <text x={pad.left + plotW} y={sy(reference.value) - 5} fontSize={10.5} fill={INK_FAINT} textAnchor="end">
              {reference.label}
            </text>
          </g>
        )}

        {hoverX !== null && (
          <line x1={hoverX} x2={hoverX} y1={pad.top} y2={pad.top + plotH} stroke={AXIS} strokeWidth={1} />
        )}

        <g clipPath={`url(#${clipId})`}>
          {series.map((s, si) => {
            const color = seriesColor(si);
            const sorted = [...s.points].sort((a, b) => a[0] - b[0]);
            const d = sorted.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p[0]).toFixed(2)},${sy(p[1]).toFixed(2)}`).join(' ');
            return (
              <g key={s.name}>
                <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                {showMarkers && sorted.length <= 60 &&
                  sorted.map((p, i) => (
                    // 2px surface ring so overlapping markers stay separable.
                    <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={color} stroke={SURFACE} strokeWidth={2} />
                  ))}
              </g>
            );
          })}
        </g>

        {yLabel && (
          <text x={12} y={pad.top + plotH / 2} fontSize={11} fill={INK_MUTED} textAnchor="middle" transform={`rotate(-90 12 ${pad.top + plotH / 2})`}>
            {yLabel}
          </text>
        )}
        {xLabel && (
          <text x={pad.left + plotW / 2} y={height - 6} fontSize={11} fill={INK_MUTED} textAnchor="middle">
            {xLabel}
          </text>
        )}

        <rect
          x={pad.left} y={pad.top} width={plotW} height={plotH} fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => {
            setTip(null);
            setHoverX(null);
          }}
        />

        {tip && <TooltipBox tip={tip} width={width} />}
      </svg>
  );
}

// --- Bar chart -------------------------------------------------------------

interface BarChartProps {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  width?: number;
  height?: number;
  title?: string;
  caption?: string;
  xLabel?: string;
  yLabel?: string;
  yMax?: number;
  horizontal?: boolean;
  formatValue?: (n: number) => string;
  reference?: { value: number; label: string };
  table?: React.ReactNode;
  /** Show the value at each bar end. Use only when bars are few. */
  showValues?: boolean;
}

export function BarChart(props: BarChartProps) {
  const { title, caption, table, series, width = 640 } = props;
  return (
    <ChartFrame
      title={title}
      caption={caption}
      table={table}
      fallbackWidth={width}
      legend={series.map((s, i) => ({ label: s.name, color: seriesColor(i) }))}
    >
      {(measured) => <BarPlot {...props} width={measured} />}
    </ChartFrame>
  );
}

function BarPlot({
  categories, series, width = 640, height = 260, title, xLabel, yLabel,
  yMax, horizontal = false, formatValue = formatNumber, reference, showValues,
}: BarChartProps) {
  const [tip, setTip] = useState<Tooltip | null>(null);

  if (categories.length === 0 || series.length === 0) {
    return <EmptyChart title={title} height={height} message="No data yet." />;
  }

  const all = series.flatMap((s) => s.values);
  const maxValue = yMax ?? Math.max(0, ...all);
  const ticks = niceTicks(0, maxValue || 1);
  const top = Math.max(maxValue, ticks[ticks.length - 1]);

  if (horizontal) {
    const rowH = 26;
    const gap = 8;
    const labelW = Math.min(180, Math.max(...categories.map((c) => c.length)) * 6.6 + 12);
    const h = categories.length * (rowH + gap) + 34;
    const plotW = width - labelW - 56;

    return (
        <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} role="img" aria-label={title ?? 'Bar chart'}>
          {ticks.map((t) => (
            <line key={t} x1={labelW + (t / top) * plotW} x2={labelW + (t / top) * plotW} y1={4} y2={h - 26} stroke={GRID} strokeWidth={1} />
          ))}
          {reference && (
            <line
              x1={labelW + (reference.value / top) * plotW} x2={labelW + (reference.value / top) * plotW}
              y1={4} y2={h - 26} stroke={INK_FAINT} strokeWidth={1} strokeDasharray="4 3"
            />
          )}

          {categories.map((cat, i) => {
            const y = i * (rowH + gap) + 6;
            const value = series[0].values[i] ?? 0;
            const barW = Math.max(0, (value / top) * plotW);
            const label = formatValue(value);
            // Only put the value inside the bar when it genuinely fits.
            const insideFits = barW > label.length * 7 + 16;

            return (
              <g
                key={cat}
                onMouseEnter={() => setTip({ x: labelW + barW, y: y + rowH / 2, lines: [cat, formatValue(value)] })}
                onMouseLeave={() => setTip(null)}
              >
                <text x={labelW - 10} y={y + rowH / 2 + 4} fontSize={11.5} fill={INK_MUTED} textAnchor="end">
                  {cat.length > 26 ? `${cat.slice(0, 25)}…` : cat}
                </text>
                <rect x={labelW} y={y} width={plotW} height={rowH} fill={SURFACE} />
                <rect x={labelW} y={y} width={barW} height={rowH} rx={4} fill={seriesColor(0)} />
                <text
                  x={insideFits ? labelW + barW - 8 : labelW + barW + 6}
                  y={y + rowH / 2 + 4}
                  fontSize={11}
                  fill={insideFits ? '#ffffff' : INK_MUTED}
                  textAnchor={insideFits ? 'end' : 'start'}
                >
                  {label}
                </text>
              </g>
            );
          })}

          <line x1={labelW} x2={labelW} y1={4} y2={h - 26} stroke={AXIS} strokeWidth={1} />
          {tip && <TooltipBox tip={tip} width={width} />}
        </svg>
    );
  }

  const pad: Padding = { ...DEFAULT_PAD, left: yLabel ? 52 : 44, bottom: xLabel ? 50 : 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const groupW = plotW / categories.length;
  // A 2px surface gap between adjacent bars instead of a stroke around them.
  const barW = Math.max(3, (groupW - 8) / series.length - 2);

  const sy = (v: number) => pad.top + plotH - (v / top) * plotH;

  return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title ?? 'Bar chart'}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.left - 8} y={sy(t) + 4} fontSize={11} fill={INK_FAINT} textAnchor="end">{formatValue(t)}</text>
          </g>
        ))}

        {reference && (
          <g>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(reference.value)} y2={sy(reference.value)} stroke={INK_FAINT} strokeWidth={1} strokeDasharray="4 3" />
            <text x={pad.left + plotW} y={sy(reference.value) - 5} fontSize={10.5} fill={INK_FAINT} textAnchor="end">{reference.label}</text>
          </g>
        )}

        <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH} y2={pad.top + plotH} stroke={AXIS} strokeWidth={1} />

        {categories.map((cat, ci) => (
          <g key={cat}>
            {series.map((s, si) => {
              const value = s.values[ci] ?? 0;
              const barH = Math.max(0, (value / top) * plotH);
              const x = pad.left + ci * groupW + (groupW - series.length * (barW + 2)) / 2 + si * (barW + 2);
              return (
                <rect
                  key={s.name}
                  x={x}
                  y={pad.top + plotH - barH}
                  width={barW}
                  height={barH}
                  rx={4}
                  fill={seriesColor(si)}
                  onMouseEnter={() =>
                    setTip({
                      x: x + barW / 2,
                      y: pad.top + plotH - barH,
                      lines: [cat, ...(series.length > 1 ? [`${s.name}: ${formatValue(value)}`] : [formatValue(value)])],
                    })
                  }
                  onMouseLeave={() => setTip(null)}
                />
              );
            })}

            {showValues && series.length === 1 && (
              <text x={pad.left + ci * groupW + groupW / 2} y={sy(series[0].values[ci] ?? 0) - 6} fontSize={10.5} fill={INK_MUTED} textAnchor="middle">
                {formatValue(series[0].values[ci] ?? 0)}
              </text>
            )}

            <text x={pad.left + ci * groupW + groupW / 2} y={pad.top + plotH + 16} fontSize={10.5} fill={INK_FAINT} textAnchor="middle">
              {cat.length > 10 ? `${cat.slice(0, 9)}…` : cat}
            </text>
          </g>
        ))}

        {yLabel && (
          <text x={12} y={pad.top + plotH / 2} fontSize={11} fill={INK_MUTED} textAnchor="middle" transform={`rotate(-90 12 ${pad.top + plotH / 2})`}>
            {yLabel}
          </text>
        )}
        {xLabel && <text x={pad.left + plotW / 2} y={height - 6} fontSize={11} fill={INK_MUTED} textAnchor="middle">{xLabel}</text>}

        {tip && <TooltipBox tip={tip} width={width} />}
      </svg>
  );
}

// --- Scatter ---------------------------------------------------------------

interface ScatterProps {
  series: LineSeries[];
  width?: number; height?: number; title?: string; caption?: string;
  xLabel?: string; yLabel?: string; table?: React.ReactNode;
}

export function ScatterChart(props: ScatterProps) {
  const { title, caption, table, series, width = 560 } = props;
  return (
    <ChartFrame
      title={title}
      caption={caption}
      table={table}
      fallbackWidth={width}
      legend={series.slice(0, 3).map((s, i) => ({ label: s.name, color: seriesColor(i) }))}
    >
      {(measured) => <ScatterPlot {...props} width={measured} />}
    </ChartFrame>
  );
}

function ScatterPlot({ series, width = 560, height = 240, title, xLabel, yLabel }: ScatterProps) {
  const [tip, setTip] = useState<Tooltip | null>(null);
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) return <EmptyChart title={title} height={height} message="No data yet." />;

  const pad: Padding = { ...DEFAULT_PAD, left: 48, bottom: xLabel ? 46 : 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const xTicks = niceTicks(Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0])));
  const yTicks = niceTicks(Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
  const x0 = xTicks[0], x1 = xTicks[xTicks.length - 1];
  const y0 = yTicks[0], y1 = yTicks[yTicks.length - 1];

  const sx = (v: number) => pad.left + ((v - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (v: number) => pad.top + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;

  // Scatter puts all pairs on screen at once, so it carries the 3-series cap.
  const capped = series.slice(0, 3);

  return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title ?? 'Scatter plot'}>
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={pad.left + plotW} y1={sy(t)} y2={sy(t)} stroke={GRID} strokeWidth={1} />
            <text x={pad.left - 8} y={sy(t) + 4} fontSize={11} fill={INK_FAINT} textAnchor="end">{formatNumber(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={sx(t)} y={pad.top + plotH + 16} fontSize={11} fill={INK_FAINT} textAnchor="middle">{formatNumber(t)}</text>
        ))}
        <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH} y2={pad.top + plotH} stroke={AXIS} strokeWidth={1} />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={pad.top + plotH} stroke={AXIS} strokeWidth={1} />

        {capped.map((s, si) =>
          s.points.map((p, i) => (
            <circle
              key={`${si}-${i}`}
              cx={sx(p[0])} cy={sy(p[1])} r={4.5}
              fill={seriesColor(si)} stroke={SURFACE} strokeWidth={2}
              onMouseEnter={() => setTip({ x: sx(p[0]), y: sy(p[1]), lines: [s.name, `(${formatNumber(p[0])}, ${formatNumber(p[1])})`] })}
              onMouseLeave={() => setTip(null)}
            />
          )),
        )}

        {yLabel && <text x={12} y={pad.top + plotH / 2} fontSize={11} fill={INK_MUTED} textAnchor="middle" transform={`rotate(-90 12 ${pad.top + plotH / 2})`}>{yLabel}</text>}
        {xLabel && <text x={pad.left + plotW / 2} y={height - 6} fontSize={11} fill={INK_MUTED} textAnchor="middle">{xLabel}</text>}
        {tip && <TooltipBox tip={tip} width={width} />}
      </svg>
  );
}

// --- Pie -------------------------------------------------------------------

export function PieChart({
  labels, values, size = 200, title, caption, table,
}: {
  labels: string[]; values: number[]; size?: number; title?: string; caption?: string; table?: React.ReactNode;
}) {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (total <= 0) return <EmptyChart title={title} height={size} message="No data yet." />;

  // Part-to-whole at a glance only; past 6 slices a bar chart reads better.
  const capped = labels.slice(0, 6);
  const r = size / 2 - 4;
  const cx = size / 2;
  const cy = size / 2;

  let angle = -Math.PI / 2;
  const slices = capped.map((label, i) => {
    const value = Math.max(0, values[i] ?? 0);
    const sweep = (value / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;

    return {
      label,
      value,
      color: seriesColor(i),
      d: `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`,
      pct: Math.round((value / total) * 100),
    };
  });

  return (
    <ChartFrame
      title={title}
      caption={caption}
      table={table}
      fallbackWidth={size}
      minWidth={size}
      legend={slices.map((s) => ({ label: `${s.label} (${s.pct}%)`, color: s.color }))}
    >
      {() => (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={title ?? 'Pie chart'}>
          {slices.map((s) => (
            // 2px surface gap between segments rather than a border around them.
            <path key={s.label} d={s.d} fill={s.color} stroke={SURFACE} strokeWidth={2} />
          ))}
        </svg>
      )}
    </ChartFrame>
  );
}

// --- Number line -----------------------------------------------------------

export function NumberLine({
  xMin = -10, xMax = 10, marks = [], intervals = [], width = 560, title, caption,
}: {
  xMin?: number; xMax?: number;
  marks?: Array<{ at: number; label?: string; filled?: boolean }>;
  intervals?: Array<{ from: number; to: number; label?: string }>;
  width?: number; title?: string; caption?: string;
}) {
  return (
    <ChartFrame title={title} caption={caption} fallbackWidth={width}>
      {(measured) => <NumberLinePlot xMin={xMin} xMax={xMax} marks={marks} intervals={intervals} width={measured} title={title} />}
    </ChartFrame>
  );
}

function NumberLinePlot({
  xMin = -10, xMax = 10, marks = [], intervals = [], width = 560, title,
}: {
  xMin?: number; xMax?: number;
  marks?: Array<{ at: number; label?: string; filled?: boolean }>;
  intervals?: Array<{ from: number; to: number; label?: string }>;
  width?: number; title?: string;
}) {
  const height = 76;
  const pad = 26;
  const plotW = width - pad * 2;
  const y = 40;

  const sx = (v: number) => pad + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const ticks = niceTicks(xMin, xMax, 10).filter((t) => t >= xMin && t <= xMax);

  return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title ?? 'Number line'}>
        {intervals.map((interval, i) => (
          <rect
            key={i}
            x={sx(Math.min(interval.from, interval.to))}
            y={y - 7}
            width={Math.abs(sx(interval.to) - sx(interval.from))}
            height={14}
            fill={seriesColor(0)}
            opacity={0.18}
            rx={3}
          />
        ))}

        <line x1={pad} x2={pad + plotW} y1={y} y2={y} stroke="#0b0b0b" strokeWidth={1.5} />
        <path d={`M${pad + plotW},${y} l-7,-4 l0,8 z`} fill="#0b0b0b" />
        <path d={`M${pad},${y} l7,-4 l0,8 z`} fill="#0b0b0b" />

        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={y - 5} y2={y + 5} stroke={INK_MUTED} strokeWidth={1} />
            <text x={sx(t)} y={y + 20} fontSize={10.5} fill={INK_FAINT} textAnchor="middle">{formatNumber(t)}</text>
          </g>
        ))}

        {marks.map((mark, i) => (
          <g key={i}>
            <circle
              cx={sx(mark.at)} cy={y} r={5.5}
              fill={mark.filled === false ? SURFACE : seriesColor(0)}
              stroke={seriesColor(0)} strokeWidth={2}
            />
            {mark.label && (
              <text x={sx(mark.at)} y={y - 12} fontSize={11} fill={INK_MUTED} textAnchor="middle">{mark.label}</text>
            )}
          </g>
        ))}
      </svg>
  );
}

// --- Shared bits -----------------------------------------------------------

function EmptyChart({ title, height, message }: { title?: string; height: number; message: string }) {
  return (
    <figure className="my-2">
      {title && <figcaption className="text-sm font-medium text-ink mb-1">{title}</figcaption>}
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line text-xs text-ink-faint"
        style={{ height: Math.min(height, 160) }}
      >
        {message}
      </div>
    </figure>
  );
}

/**
 * A stat tile. Per the form heuristic, when the story is a single number this
 * is the right answer - not a one-bar bar chart.
 */
export function StatTile({
  label, value, unit, hint, tone = 'neutral',
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : 'text-ink';

  return (
    <div className="card p-4">
      <div className="text-xs font-medium text-ink-muted">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>
        {value}
        {unit && <span className="text-base font-normal text-ink-muted ml-0.5">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

/** Simple table used as the "Show data" fallback under every chart. */
export function DataTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <table className="table-base">
      <thead>
        <tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} className={typeof cell === 'number' ? 'tabular-nums' : ''}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal accuracy meter used in the weak-area lists. */
export function AccuracyMeter({ accuracy, threshold = 0.7 }: { accuracy: number; threshold?: number }) {
  const pct = Math.round(accuracy * 100);
  const tone = accuracy >= threshold ? '#1a7f4b' : accuracy >= threshold * 0.7 ? '#b06a00' : '#c0392b';

  return (
    <span className="inline-flex items-center gap-2 min-w-[104px]">
      <span className="relative h-1.5 w-14 rounded-full bg-line overflow-hidden shrink-0">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: tone }} />
      </span>
      <span className="text-xs tabular-nums text-ink-muted">{pct}%</span>
    </span>
  );
}

export { formatNumber, niceTicks };
