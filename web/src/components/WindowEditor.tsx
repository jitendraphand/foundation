import { Alert, Field } from './ui';

/**
 * Editor for a test's daily availability window.
 *
 * Two modes, because the two obvious requests are opposites: "only during
 * school hours" and "paused between 11pm and 5am". Everything is wall-clock
 * time in the school's timezone, shown alongside so nobody has to wonder.
 */

export interface WindowValue {
  availabilityMode: 'ALWAYS' | 'ALLOW_WINDOW' | 'BLOCK_WINDOW';
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  windowDays: number[];
  autoSubmitOnClose: boolean;
}

export interface WindowPreset {
  code: string;
  label: string;
  mode: 'ALLOW_WINDOW' | 'BLOCK_WINDOW';
  start: number;
  end: number;
  days: number[];
}

const DAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

/** "08:30" <-> 510, so a plain <input type="time"> can drive it. */
export function minuteToTime(minute: number | null): string {
  if (minute === null || minute === undefined) return '';
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function timeToMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute < 1440 ? minute : null;
}

export function describeWindowValue(value: WindowValue): string {
  if (value.availabilityMode === 'ALWAYS') return 'Available at any time of day';
  const start = minuteToTime(value.windowStartMinute);
  const end = minuteToTime(value.windowEndMinute);
  if (!start || !end) return 'Window not set';

  const days = value.windowDays.length === 0 || value.windowDays.length === 7
    ? 'every day'
    : DAYS.filter((d) => value.windowDays.includes(d.value)).map((d) => d.label).join(', ');

  return value.availabilityMode === 'ALLOW_WINDOW'
    ? `Only between ${start} and ${end}, ${days}`
    : `Paused between ${start} and ${end}, ${days}`;
}

export function WindowEditor({
  value,
  onChange,
  presets = [],
  timezone,
  localTimeNow,
}: {
  value: WindowValue;
  onChange: (next: WindowValue) => void;
  presets?: WindowPreset[];
  timezone?: string;
  localTimeNow?: string;
}) {
  const set = (patch: Partial<WindowValue>) => onChange({ ...value, ...patch });
  const active = value.availabilityMode !== 'ALWAYS';

  const wraps =
    active &&
    value.windowStartMinute !== null &&
    value.windowEndMinute !== null &&
    value.windowEndMinute <= value.windowStartMinute;

  const toggleDay = (day: number) => {
    const next = value.windowDays.includes(day)
      ? value.windowDays.filter((d) => d !== day)
      : [...value.windowDays, day].sort((a, b) => a - b);
    set({ windowDays: next });
  };

  return (
    <div className="space-y-3">
      <Field
        label="When can this test be attempted?"
        hint={timezone ? `Times are ${timezone}${localTimeNow ? `, where it is now ${localTimeNow}` : ''}.` : undefined}
      >
        <select
          className="input"
          value={value.availabilityMode}
          onChange={(e) => {
            const mode = e.target.value as WindowValue['availabilityMode'];
            // Seed sensible defaults so the time boxes are never blank.
            if (mode === 'ALLOW_WINDOW' && value.windowStartMinute === null) {
              set({ availabilityMode: mode, windowStartMinute: 8 * 60, windowEndMinute: 15 * 60, windowDays: [1, 2, 3, 4, 5] });
            } else if (mode === 'BLOCK_WINDOW' && value.windowStartMinute === null) {
              set({ availabilityMode: mode, windowStartMinute: 23 * 60, windowEndMinute: 5 * 60, windowDays: [] });
            } else {
              set({ availabilityMode: mode });
            }
          }}
        >
          <option value="ALWAYS">Any time of day</option>
          <option value="ALLOW_WINDOW">Only during set hours (e.g. school hours)</option>
          <option value="BLOCK_WINDOW">Paused during set hours (e.g. overnight)</option>
        </select>
      </Field>

      {active && (
        <>
          {presets.length > 0 && (
            <div>
              <span className="label">Quick presets</span>
              <div className="flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <button
                    key={preset.code}
                    type="button"
                    onClick={() =>
                      set({
                        availabilityMode: preset.mode,
                        windowStartMinute: preset.start,
                        windowEndMinute: preset.end,
                        windowDays: preset.days,
                      })
                    }
                    className="badge"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={value.availabilityMode === 'ALLOW_WINDOW' ? 'Available from' : 'Paused from'}>
              <input
                type="time"
                className="input"
                value={minuteToTime(value.windowStartMinute)}
                onChange={(e) => set({ windowStartMinute: timeToMinute(e.target.value) })}
              />
            </Field>
            <Field label={value.availabilityMode === 'ALLOW_WINDOW' ? 'Available until' : 'Paused until'}>
              <input
                type="time"
                className="input"
                value={minuteToTime(value.windowEndMinute)}
                onChange={(e) => set({ windowEndMinute: timeToMinute(e.target.value) })}
              />
            </Field>
          </div>

          {wraps && (
            <p className="text-[11px] text-ink-muted -mt-1">
              This window runs past midnight into the following morning.
            </p>
          )}

          <div>
            <span className="label">On which days? (none selected = every day)</span>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((day) => {
                const on = value.windowDays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleDay(day.value)}
                    className={`badge ${on ? 'border-series-1/40 bg-series-1/[0.08] text-series-1' : ''}`}
                  >
                    {day.label}
                  </button>
                );
              })}
              {value.windowDays.length > 0 && (
                <button type="button" onClick={() => set({ windowDays: [] })} className="badge">
                  Every day
                </button>
              )}
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-series-1 mt-0.5"
              checked={value.autoSubmitOnClose}
              onChange={(e) => set({ autoSubmitOnClose: e.target.checked })}
            />
            <span className="text-ink-muted">
              Submit papers still in progress when the window closes
              <span className="block text-[11px] text-ink-faint">
                Off by default: a student who started in time is allowed to finish. Turn this on only if nobody should
                be writing outside these hours at all.
              </span>
            </span>
          </label>

          <Alert tone="info">{describeWindowValue(value)}. Students see this on their dashboard.</Alert>
        </>
      )}
    </div>
  );
}
