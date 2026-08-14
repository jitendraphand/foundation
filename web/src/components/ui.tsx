import { Children, Fragment, cloneElement, isValidElement, useEffect, useId, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-muted" role="status">
      <span className="w-3.5 h-3.5 rounded-full border-2 border-line border-t-series-1 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-20">
      <Spinner label={label} />
    </div>
  );
}

export function Alert({
  tone = 'error',
  children,
  onDismiss,
}: {
  tone?: 'error' | 'success' | 'info' | 'warn';
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  const styles = {
    error: 'border-bad/30 bg-bad/[0.06] text-bad',
    success: 'border-good/30 bg-good/[0.06] text-good',
    warn: 'border-warn/30 bg-warn/[0.06] text-warn',
    info: 'border-series-1/30 bg-series-1/[0.06] text-series-1',
  }[tone];

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm flex items-start gap-2 ${styles}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
  padded = true,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
          {typeof title === 'string' ? <h2 className="text-sm font-semibold">{title}</h2> : title}
          {action}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

const LABELABLE = new Set(['input', 'select', 'textarea']);

/**
 * Finds the form control a Field is naming and gives it an id.
 *
 * Not always the direct child: a field often renders `<><input list=… />
 * <datalist>…</datalist></>`, and the control that needs the label is inside
 * the fragment. Anything that is not a form control - a group of checkboxes,
 * a custom picker - is returned untouched and gets no `htmlFor`, since a label
 * pointing at a div names nothing.
 *
 * Plain wrappers are looked through as well. Seven of the ninety-nine fields in
 * this app render `<div className="flex gap-2"><input /><button>Suggest</button>
 * </div>` or similar - every temporary-password box among them - and stopping at
 * that div left the label naming nothing, which is the exact failure the id
 * above exists to prevent. Custom components are still left alone: their
 * children here are the arguments they were given, not the markup they will
 * render, so there is nothing reliable to find inside one.
 */
function wireControl(node: ReactNode, id: string): { node: ReactNode; controlId?: string } {
  // Several children arrive as a plain array, not a fragment - which is the
  // usual shape when an input is followed by its <datalist>.
  if (Array.isArray(node)) return wireList(Children.toArray(node), id);

  if (!isValidElement(node)) return { node };
  const element = node as ReactElement<{ id?: string; children?: ReactNode }>;

  if (typeof element.type === 'string' && LABELABLE.has(element.type)) {
    if (element.props.id) return { node, controlId: element.props.id };
    return { node: cloneElement(element, { id }), controlId: id };
  }

  if (element.type === Fragment) return wireList(Children.toArray(element.props.children), id);

  // A wrapper the field put its control inside. Not <label>: a control already
  // wrapped in one has a name, and pointing a second label at it gives it two.
  if (typeof element.type === 'string' && element.type !== 'label') {
    const found = wireList(Children.toArray(element.props.children), id);
    if (found.controlId) return { node: cloneElement(element, undefined, found.node), controlId: found.controlId };
  }

  return { node };
}

/** Wires the first labelable element in a list, leaving the rest alone. */
function wireList(kids: ReactNode[], id: string): { node: ReactNode; controlId?: string } {
  for (let i = 0; i < kids.length; i++) {
    const found = wireControl(kids[i], id);
    if (found.controlId) {
      const next: ReactNode[] = [...kids];
      next[i] = found.node;
      return { node: <>{next}</>, controlId: found.controlId };
    }
  }
  return { node: <>{kids}</> };
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  required?: boolean;
}) {
  const autoId = useId();

  // Tie the label to the control it names. Without this the label is only
  // text sitting above a box: a screen reader announces an unnamed field, and
  // clicking the label does nothing.
  const { node: control, controlId } = wireControl(children, autoId);

  return (
    <div>
      <label className="label" htmlFor={controlId}>
        {label}
        {required && <span className="text-bad ml-0.5">*</span>}
      </label>
      {control}
      {hint && !error && <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>}
      {error && <p className="mt-1 text-[11px] text-bad">{error}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info';
}) {
  const styles = {
    neutral: '',
    good: 'border-good/30 bg-good/[0.08] text-good',
    warn: 'border-warn/30 bg-warn/[0.08] text-warn',
    bad: 'border-bad/30 bg-bad/[0.08] text-bad',
    info: 'border-series-1/30 bg-series-1/[0.08] text-series-1',
  }[tone];

  return <span className={`badge ${styles}`}>{children}</span>;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/20 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} className={`card shadow-pop w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} my-auto`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="btn-ghost btn-sm" aria-label="Close">
            ×
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="text-center py-10 px-4">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 text-xs text-ink-faint max-w-sm mx-auto">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-line overflow-x-auto" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
            active === tab.id
              ? 'border-series-1 text-ink font-medium'
              : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ml-1.5 text-xs text-ink-faint tabular-nums">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function formatDate(value: string | Date | null | undefined, withTime = false): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Turns a tag code such as `algebraic_manipulation` into `Algebraic manipulation`. */
export function humanizeTag(code: string): string {
  return code.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
