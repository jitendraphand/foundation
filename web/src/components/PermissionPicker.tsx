import { useMemo } from 'react';
import { Badge } from './ui';
import type { PermissionDef, PermissionPreset } from '../lib/types';

/**
 * The privilege checkboxes.
 *
 * Grouped by area, with a one-line explanation under each so whoever is
 * granting them does not have to guess what "settings.manage" reaches. The
 * presets are a shortcut, not a separate concept: picking one simply ticks a
 * set of boxes that can then be adjusted.
 */

export function PermissionPicker({
  catalogue,
  presets,
  value,
  onChange,
  disabled = false,
  disabledCodes = [],
  disabledReason,
}: {
  catalogue: PermissionDef[];
  presets: PermissionPreset[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Individually locked boxes, e.g. you cannot revoke your own. */
  disabledCodes?: string[];
  disabledReason?: string;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, PermissionDef[]>();
    for (const p of catalogue) {
      const list = map.get(p.group) ?? [];
      list.push(p);
      map.set(p.group, list);
    }
    return [...map.entries()];
  }, [catalogue]);

  const selected = new Set(value);
  const allCodes = catalogue.map((p) => p.code);
  const allChecked = allCodes.length > 0 && allCodes.every((c) => selected.has(c));

  const toggle = (code: string) => {
    if (disabled || disabledCodes.includes(code)) return;
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange([...next]);
  };

  const applyPreset = (preset: PermissionPreset) => {
    if (disabled) return;
    // Locked boxes stay as they are - a preset must not silently revoke a
    // privilege the current user is not allowed to remove.
    const kept = value.filter((c) => disabledCodes.includes(c));
    onChange([...new Set([...kept, ...preset.permissions])]);
  };

  const matchingPreset = presets.find(
    (p) => p.permissions.length === value.length && p.permissions.every((c) => selected.has(c)),
  );

  return (
    <div className="space-y-4">
      <div>
        <span className="label">Start from a common role</span>
        <div className="flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.code}
              type="button"
              title={preset.description}
              disabled={disabled}
              onClick={() => applyPreset(preset)}
              className={`badge ${matchingPreset?.code === preset.code ? 'border-series-1/40 bg-series-1/[0.08] text-series-1' : ''} disabled:opacity-50`}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(value.filter((c) => disabledCodes.includes(c)))}
            className="badge disabled:opacity-50"
          >
            Clear all
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pb-1 border-b border-line">
        <span className="text-xs font-medium text-ink-muted">
          {value.length} of {allCodes.length} privileges selected
        </span>
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            className="accent-series-1"
            checked={allChecked}
            disabled={disabled}
            onChange={() =>
              onChange(allChecked ? value.filter((c) => disabledCodes.includes(c)) : [...allCodes])
            }
          />
          Select all
        </label>
      </div>

      {groups.map(([group, items]) => (
        <fieldset key={group}>
          <legend className="text-xs font-semibold text-ink mb-1.5">{group}</legend>
          <div className="space-y-1.5">
            {items.map((item) => {
              const locked = disabled || disabledCodes.includes(item.code);
              return (
                <label
                  key={item.code}
                  className={`flex items-start gap-2.5 p-2 rounded-lg border transition-colors ${
                    selected.has(item.code) ? 'border-series-1/30 bg-series-1/[0.04]' : 'border-line'
                  } ${locked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-sunken'}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-series-1"
                    checked={selected.has(item.code)}
                    disabled={locked}
                    onChange={() => toggle(item.code)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {item.label}
                      {item.sensitive && <Badge tone="warn">sensitive</Badge>}
                    </span>
                    <span className="block text-[11px] text-ink-muted mt-0.5">{item.description}</span>
                    {locked && disabledReason && disabledCodes.includes(item.code) && (
                      <span className="block text-[11px] text-warn mt-0.5">{disabledReason}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

/** Compact read-only summary, for a table cell. */
export function PermissionSummary({ permissions, catalogue }: { permissions: string[]; catalogue: PermissionDef[] }) {
  if (permissions.length === 0) return <span className="text-xs text-ink-faint">none</span>;
  if (catalogue.length > 0 && permissions.length === catalogue.length) {
    return <Badge tone="info">full administrator</Badge>;
  }

  const labelFor = (code: string) => catalogue.find((c) => c.code === code)?.label ?? code;

  return (
    <span className="flex flex-wrap gap-1">
      {permissions.slice(0, 3).map((code) => (
        <Badge key={code}>{labelFor(code)}</Badge>
      ))}
      {permissions.length > 3 && (
        <span className="text-[11px] text-ink-faint self-center">+{permissions.length - 3} more</span>
      )}
    </span>
  );
}
