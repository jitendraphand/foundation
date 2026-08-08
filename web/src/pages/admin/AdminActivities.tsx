import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageLoader, formatDate } from '../../components/ui';
import { BlocksRenderer } from '../../renderers/BlockRenderer';
import { CARD_ACCENTS, type CardAccent } from '../../lib/types';
import type {
  ActivityCard,
  ActivityCompletionRow,
  ActivityKind,
  ActivityStatus,
  AdminActivity,
  Block,
} from '../../lib/types';

/**
 * Activities: the flashcards and videos a student is made to go through
 * before anything else.
 *
 * Publishing one is a blunt instrument - it stops the whole class until they
 * have read it - so the screen keeps the audience, the status and the
 * "who has actually done it" list all within reach.
 */

const KIND_LABEL: Record<ActivityKind, string> = {
  FLASHCARD: 'Cards',
  VIDEO: 'Video',
  MIXED: 'Cards + video',
};

export default function AdminActivities() {
  const [activities, setActivities] = useState<AdminActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<ActivityStatus | ''>('');
  const [editing, setEditing] = useState<AdminActivity | 'new' | null>(null);
  const [viewing, setViewing] = useState<AdminActivity | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ pageSize: '50' });
      if (status) query.set('status', status);
      const res = await api.get<{ activities: AdminActivity[] }>(`/api/admin/activities?${query}`);
      setActivities(res.activities);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load activities.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeStatus = async (id: string, next: ActivityStatus) => {
    setError(null);
    try {
      const res = await api.post<{ message: string }>(`/api/admin/activities/${id}/publish`, { status: next });
      setNotice(res.message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the status.');
    }
  };

  const remove = async (activity: AdminActivity) => {
    if (!confirm(`Delete "${activity.title}"? Students will no longer see it.`)) return;
    setError(null);
    try {
      const res = await api.delete<{ mode: string; message?: string }>(`/api/admin/activities/${activity.id}`);
      setNotice(res.message ?? 'Activity deleted.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete the activity.');
    }
  };


  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Activities</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Flashcards and videos. A published, required activity must be completed before the student can do anything
            else — including starting a test.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="input w-auto text-xs py-1.5"
            value={status}
            onChange={(e) => setStatus(e.target.value as ActivityStatus | '')}
          >
            <option value="">All</option>
            <option value="DRAFT">Drafts</option>
            <option value="PUBLISHED">Live</option>
            <option value="ARCHIVED">Archived</option>
          </select>
          <button type="button" className="btn-primary btn-sm" onClick={() => setEditing('new')}>
            New activity
          </button>
        </div>
      </div>

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {loading ? (
        <PageLoader label="Loading activities" />
      ) : activities.length === 0 ? (
        <Card>
          <EmptyState
            title="No activities yet"
            hint="Create one to put a notice, a revision card or a video in front of a class before they carry on."
            action={<button type="button" className="btn-primary btn-sm" onClick={() => setEditing('new')}>New activity</button>}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Audience</th>
                  <th className="text-center">Cards</th>
                  <th className="text-center">Done</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activities.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono text-xs text-ink-muted whitespace-nowrap">{a.publicId}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <button type="button" className="font-medium hover:text-series-1 text-left" onClick={() => setEditing(a)}>
                          {a.title}
                        </button>
                        {a.isMandatory ? <Badge tone="warn">required</Badge> : <Badge>optional</Badge>}
                        {a.minSeconds > 0 && <span className="text-[11px] text-ink-faint">min {formatSeconds(a.minSeconds)}</span>}
                      </div>
                    </td>
                    <td className="text-ink-muted text-xs">{KIND_LABEL[a.kind]}</td>
                    <td className="text-xs text-ink-muted">
                      {a.targetUser
                        ? `${a.targetUser.firstName} ${a.targetUser.lastName}`
                        : a.targetGrades.length || a.targetDivisions.length
                          ? [
                              a.targetGrades.length ? `Grade ${a.targetGrades.join(', ')}` : null,
                              a.targetDivisions.length ? `Div ${a.targetDivisions.join(', ')}` : null,
                            ].filter(Boolean).join(' · ')
                          : 'Everyone'}
                    </td>
                    <td className="text-center tabular-nums">{a.cardCount}</td>
                    <td className="text-center tabular-nums text-xs">
                      <button type="button" className="hover:text-series-1" onClick={() => setViewing(a)}>
                        {a.completedCount ?? 0}
                        <span className="text-ink-faint"> / {a.startedCount ?? 0} opened</span>
                      </button>
                    </td>
                    <td>
                      {a.status === 'PUBLISHED' ? (
                        <Badge tone="good">live</Badge>
                      ) : a.status === 'ARCHIVED' ? (
                        <Badge>archived</Badge>
                      ) : (
                        <Badge tone="warn">draft</Badge>
                      )}
                    </td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(a.createdAt)}</td>
                    <td className="text-right whitespace-nowrap">
                      {a.status === 'PUBLISHED' ? (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => void changeStatus(a.id, 'DRAFT')}>
                          Unpublish
                        </button>
                      ) : (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => void changeStatus(a.id, 'PUBLISHED')}>
                          Publish
                        </button>
                      )}
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setViewing(a)}>
                        Who
                      </button>
                      <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => void remove(a)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {editing && (
        <ActivityEditor
          activity={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setNotice(message);
            setEditing(null);
            void load();
          }}
        />
      )}

      {viewing && <CompletionsModal activity={viewing} onClose={() => setViewing(null)} onChanged={() => void load()} />}
    </div>
  );
}

// --- Editor ----------------------------------------------------------------

interface EditorForm {
  title: string;
  description: string;
  kind: ActivityKind;
  videoUrl: string;
  minSeconds: number;
  isMandatory: boolean;
  targetGrades: string;
  targetDivisions: string;
  cards: ActivityCard[];
}

function ActivityEditor({
  activity,
  onClose,
  onSaved,
}: {
  activity: AdminActivity | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [form, setForm] = useState<EditorForm>({
    title: activity?.title ?? '',
    description: activity?.description ?? '',
    kind: activity?.kind ?? 'FLASHCARD',
    videoUrl: activity?.videoUrl ?? '',
    minSeconds: activity?.minSeconds ?? 0,
    isMandatory: activity?.isMandatory ?? true,
    targetGrades: (activity?.targetGrades ?? []).join(', '),
    targetDivisions: (activity?.targetDivisions ?? []).join(', '),
    cards: activity?.content?.cards ?? [newCard(0)],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const wantsCards = form.kind === 'FLASHCARD' || form.kind === 'MIXED';
  const wantsVideo = form.kind === 'VIDEO' || form.kind === 'MIXED';

  const patchCard = (index: number, next: ActivityCard) =>
    setForm((f) => ({ ...f, cards: f.cards.map((c, i) => (i === index ? next : c)) }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    // Blank blocks are the usual result of adding one and changing your mind;
    // drop them here rather than making the server complain about them.
    const cards = wantsCards
      ? form.cards
          .map((c) => ({ ...c, blocks: c.blocks.filter(isNonEmptyBlock) }))
          .filter((c) => c.blocks.length > 0)
      : [];

    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      kind: form.kind,
      content: { version: 1, cards },
      videoUrl: wantsVideo ? form.videoUrl.trim() || null : null,
      minSeconds: form.minSeconds,
      isMandatory: form.isMandatory,
      targetGrades: splitList(form.targetGrades),
      targetDivisions: splitList(form.targetDivisions),
    };

    try {
      if (activity) {
        await api.patch(`/api/admin/activities/${activity.id}`, payload);
        onSaved('Activity saved.');
      } else {
        await api.post('/api/admin/activities', payload);
        onSaved('Activity created as a draft. Publish it when you are ready.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the activity.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={activity ? `Edit ${activity.publicId}` : 'New activity'} wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        {activity?.status === 'PUBLISHED' && (
          <Alert tone="warn">
            This activity is live. Students are being held at it right now, so it cannot be saved in a state they
            could not finish.
          </Alert>
        )}

        <Field label="Title" required>
          <input className="input" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required autoFocus />
        </Field>

        <Field label="Short note" hint="Shown above the cards. Optional.">
          <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Type">
            <select className="input" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ActivityKind }))}>
              <option value="FLASHCARD">Cards only</option>
              <option value="VIDEO">Video only</option>
              <option value="MIXED">Cards and video</option>
            </select>
          </Field>
          <Field label="Minimum time (s)" hint="0 = no minimum">
            <input
              type="number"
              min={0}
              max={3600}
              className="input"
              value={form.minSeconds}
              onChange={(e) => setForm((f) => ({ ...f, minSeconds: Number(e.target.value) }))}
            />
          </Field>
          <Field label="Blocking">
            <label className="flex items-center gap-2 h-9 text-sm">
              <input
                type="checkbox"
                className="accent-series-1"
                checked={form.isMandatory}
                onChange={(e) => setForm((f) => ({ ...f, isMandatory: e.target.checked }))}
              />
              <span className="text-ink-muted">Must be done first</span>
            </label>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Grades" hint="Comma separated. Empty = everyone.">
            <input className="input" value={form.targetGrades} onChange={(e) => setForm((f) => ({ ...f, targetGrades: e.target.value }))} placeholder="8, 9" />
          </Field>
          <Field label="Divisions" hint="Comma separated. Empty = everyone.">
            <input className="input" value={form.targetDivisions} onChange={(e) => setForm((f) => ({ ...f, targetDivisions: e.target.value }))} placeholder="A, B" />
          </Field>
        </div>

        {wantsVideo && (
          <Field
            label="Video link"
            required
            hint="YouTube and Vimeo play inside the page. Any other link opens in a new tab."
          >
            <input
              className="input"
              value={form.videoUrl}
              onChange={(e) => setForm((f) => ({ ...f, videoUrl: e.target.value }))}
              placeholder="https://www.youtube.com/watch?v=…"
            />
          </Field>
        )}

        {wantsCards && (
          <div className="pt-3 border-t border-line space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">
                Cards <span className="text-ink-faint font-normal">({form.cards.length})</span>
              </h3>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-ghost btn-sm" onClick={() => setPreview((p) => !p)}>
                  {preview ? 'Back to editing' : 'Preview'}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setForm((f) => ({ ...f, cards: [...f.cards, newCard(f.cards.length)] }))}
                >
                  Add card
                </button>
              </div>
            </div>

            {preview ? (
              <div className="space-y-3">
                {form.cards.map((c, i) => (
                  <div key={c.id}>
                    <p className="text-[11px] text-ink-faint mb-1.5">Card {i + 1} of {form.cards.length}</p>
                    {/* Exactly the markup the student gets, so the preview is
                        a preview rather than an approximation. */}
                    <article className={`flashcard accent-${c.accent ?? 'slate'}`}>
                      <div className="flashcard-bar" />
                      <div className="flashcard-body">
                        {c.eyebrow && <p className="flashcard-eyebrow">{c.eyebrow}</p>}
                        {c.title && <h4 className="flashcard-title">{c.title}</h4>}
                        <BlocksRenderer blocks={c.blocks.filter(isNonEmptyBlock)} />
                      </div>
                    </article>
                  </div>
                ))}
              </div>
            ) : (
              form.cards.map((card, index) => (
                <CardEditor
                  key={card.id}
                  card={card}
                  index={index}
                  total={form.cards.length}
                  onChange={(next) => patchCard(index, next)}
                  onRemove={() => setForm((f) => ({ ...f, cards: f.cards.filter((_, i) => i !== index) }))}
                  onMove={(delta) =>
                    setForm((f) => {
                      const target = index + delta;
                      if (target < 0 || target >= f.cards.length) return f;
                      const cards = [...f.cards];
                      [cards[index], cards[target]] = [cards[target], cards[index]];
                      return { ...f, cards };
                    })
                  }
                />
              ))
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-line">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : activity ? 'Save changes' : 'Create activity'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * One card.
 *
 * Cards are made of the same blocks as questions, so a card can carry a
 * formula, a diagram or a table rather than only prose. The type dropdown is
 * the whole of the complexity the admin is exposed to.
 */
function CardEditor({
  card,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: {
  card: ActivityCard;
  index: number;
  total: number;
  onChange: (next: ActivityCard) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const setBlock = (i: number, block: Block) =>
    onChange({ ...card, blocks: card.blocks.map((b, j) => (j === i ? block : b)) });

  const accent = card.accent ?? 'slate';

  return (
    <div className={`accent-${accent} rounded-xl border p-3 space-y-2`} style={{ borderColor: 'var(--accent-line)', background: 'var(--accent-soft)' }}>
      <div className="flex items-center gap-2">
        <span className="text-[11px] w-12 shrink-0 font-medium" style={{ color: 'var(--accent-ink)' }}>Card {index + 1}</span>
        <input
          className="input flex-1 py-1.5 text-sm"
          placeholder="Card heading (optional)"
          value={card.title ?? ''}
          onChange={(e) => onChange({ ...card, title: e.target.value })}
        />
        <button type="button" className="btn-ghost btn-sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">↑</button>
        <button type="button" className="btn-ghost btn-sm" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="Move down">↓</button>
        <button type="button" className="btn-ghost btn-sm text-bad" disabled={total === 1} onClick={onRemove} aria-label="Remove card">×</button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="input flex-1 min-w-[10rem] py-1.5 text-xs"
          placeholder="Small line above the heading, e.g. Remember this"
          value={card.eyebrow ?? ''}
          onChange={(e) => onChange({ ...card, eyebrow: e.target.value })}
          aria-label="Line above the heading"
        />
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Card colour">
          {CARD_ACCENTS.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={accent === name}
              aria-label={name}
              title={name}
              onClick={() => onChange({ ...card, accent: name })}
              className={`accent-${name} accent-dot ${accent === name ? 'ring-2 ring-offset-1 ring-ink/40' : ''}`}
            />
          ))}
        </div>
      </div>

      {card.blocks.map((block, i) => (
        <div key={i} className="flex items-start gap-2">
          <select
            className="input w-32 shrink-0 py-1.5 text-xs"
            value={block.type}
            onChange={(e) => setBlock(i, blankBlock(e.target.value as Block['type']))}
          >
            <option value="text">Text</option>
            <option value="math">Maths</option>
            <option value="table">Table</option>
            <option value="image">Picture</option>
            <option value="svg">Diagram (SVG)</option>
            <option value="mermaid">Diagram (Mermaid)</option>
            <option value="code">Code</option>
          </select>

          <BlockInput block={block} onChange={(next) => setBlock(i, next)} />

          <button
            type="button"
            className="btn-ghost btn-sm text-bad shrink-0"
            disabled={card.blocks.length === 1}
            onClick={() => onChange({ ...card, blocks: card.blocks.filter((_, j) => j !== i) })}
            aria-label="Remove block"
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        className="btn-ghost btn-sm"
        onClick={() => onChange({ ...card, blocks: [...card.blocks, blankBlock('text')] })}
      >
        + Add content
      </button>
    </div>
  );
}

function BlockInput({ block, onChange }: { block: Block; onChange: (next: Block) => void }) {
  switch (block.type) {
    case 'text':
      return (
        <textarea
          className="input flex-1 text-sm"
          rows={2}
          placeholder="What the student should read"
          value={block.value}
          onChange={(e) => onChange({ ...block, value: e.target.value })}
        />
      );
    case 'math':
      return (
        <input
          className="input flex-1 font-mono text-sm"
          placeholder="LaTeX, e.g. \frac{a}{b} = c"
          value={block.tex}
          onChange={(e) => onChange({ ...block, tex: e.target.value, display: true })}
        />
      );
    case 'svg':
      return (
        <textarea
          className="input flex-1 font-mono text-xs"
          rows={3}
          placeholder="<svg viewBox='0 0 100 100'>…</svg>"
          value={block.svg}
          onChange={(e) => onChange({ ...block, svg: e.target.value })}
        />
      );
    case 'mermaid':
      return (
        <textarea
          className="input flex-1 font-mono text-xs"
          rows={3}
          placeholder={'graph TD; A-->B;'}
          value={block.code}
          onChange={(e) => onChange({ ...block, code: e.target.value })}
        />
      );
    case 'code':
      return (
        <textarea
          className="input flex-1 font-mono text-xs"
          rows={3}
          placeholder="Shown as text. Never run."
          value={block.value}
          onChange={(e) => onChange({ ...block, value: e.target.value })}
        />
      );
    case 'table':
      return (
        <textarea
          className="input flex-1 font-mono text-xs"
          rows={3}
          placeholder={'One row per line, cells separated by |\nHeading A | Heading B\n1 | 2'}
          value={[block.headers.join(' | '), ...block.rows.map((r) => r.join(' | '))].join('\n')}
          onChange={(e) => {
            const lines = e.target.value.split('\n');
            const [head = '', ...rest] = lines;
            onChange({
              ...block,
              headers: head.split('|').map((s) => s.trim()),
              rows: rest.filter((l) => l.trim()).map((l) => l.split('|').map((s) => s.trim())),
            });
          }}
        />
      );
    case 'image':
      return <ImageBlockInput block={block} onChange={onChange} />;
    default:
      return <div className="flex-1 text-xs text-ink-faint py-2">This content type is edited elsewhere.</div>;
  }
}

/**
 * Uploading a picture for a card.
 *
 * Images are stored as assets and referenced by id, exactly as a question's
 * figure is - so a picture used on a card and a picture used in a question are
 * the same thing, backed up the same way and served from the same route.
 */
function ImageBlockInput({
  block,
  onChange,
}: {
  block: Extract<Block, { type: 'image' }>;
  onChange: (next: Block) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('altText', block.alt ?? '');
      const res = await api.upload<{ asset: { id: string } }>('/api/admin/assets', form);
      onChange({ ...block, assetId: res.asset.id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not upload that picture.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 space-y-2">
      <div className="flex items-start gap-3">
        {block.assetId ? (
          <img
            src={`/uploads/${block.assetId}`}
            alt=""
            className="w-24 h-24 object-contain rounded-lg border border-line bg-white shrink-0"
          />
        ) : (
          <div className="w-24 h-24 rounded-lg border border-dashed border-line bg-surface grid place-items-center text-[11px] text-ink-faint shrink-0">
            No picture
          </div>
        )}

        <div className="flex-1 space-y-2 min-w-0">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
          <button type="button" className="btn-secondary btn-sm" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? 'Uploading…' : block.assetId ? 'Replace picture' : 'Choose a picture'}
          </button>
          <input
            className="input py-1.5 text-xs"
            placeholder="Describe the picture, for a student who cannot see it"
            value={block.alt ?? ''}
            onChange={(e) => onChange({ ...block, alt: e.target.value })}
            aria-label="Picture description"
          />
          <input
            className="input py-1.5 text-xs"
            placeholder="Caption (optional)"
            value={block.caption ?? ''}
            onChange={(e) => onChange({ ...block, caption: e.target.value })}
            aria-label="Picture caption"
          />
        </div>
      </div>
      {error && <p className="text-[11px] text-bad">{error}</p>}
      <p className="text-[11px] text-ink-faint">PNG, JPEG, WebP or GIF, up to 4 MB.</p>
    </div>
  );
}

// --- Completions -----------------------------------------------------------

function CompletionsModal({
  activity,
  onClose,
  onChanged,
}: {
  activity: AdminActivity;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<{
    total: number;
    completed: number;
    inProgress: number;
    notStarted: number;
    rows: ActivityCompletionRow[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/admin/activities/${activity.id}/completions`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the list.');
    }
  }, [activity.id]);

  useEffect(() => {
    void load();
  }, [load]);


  return (
    <Modal open onClose={onClose} title={`${activity.title} — who has done it`} wide>
      {error && <Alert tone="error">{error}</Alert>}
      {!data ? (
        <PageLoader label="Loading" />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone="good">{data.completed} completed</Badge>
            <Badge tone="warn">{data.inProgress} part way</Badge>
            <Badge>{data.notStarted} not started</Badge>
          </div>

          {data.rows.length === 0 ? (
            <EmptyState title="Nobody is in this audience yet" hint="Check the grades and divisions on the activity." />
          ) : (
            <div className="scroll-x max-h-[55vh] overflow-y-auto">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Class</th>
                    <th className="text-center">Cards</th>
                    <th className="text-center">Time</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.user.id}>
                      <td>
                        <span className="font-medium">{row.user.firstName} {row.user.lastName}</span>
                        <span className="text-ink-faint text-xs"> · {row.user.username}</span>
                      </td>
                      <td className="text-xs text-ink-muted">
                        {row.user.grade}{row.user.division ? `-${row.user.division}` : ''}
                        {row.user.rollNo ? ` · ${row.user.rollNo}` : ''}
                      </td>
                      <td className="text-center tabular-nums text-xs">{row.cardsSeen}</td>
                      <td className="text-center tabular-nums text-xs">{formatSeconds(row.secondsSpent)}</td>
                      <td className="text-xs">
                        {row.state === 'completed' ? (
                          <span className="text-good">Done {formatDate(row.completedAt, true)}</span>
                        ) : row.state === 'in_progress' ? (
                          <span className="text-warn">Part way</span>
                        ) : (
                          <span className="text-ink-faint">Not started</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// --- Helpers ---------------------------------------------------------------

/** Cards cycle through the palette, so a new stack is colourful by default. */
function newCard(index = 0): ActivityCard {
  return {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: '',
    accent: CARD_ACCENTS[index % CARD_ACCENTS.length],
    blocks: [blankBlock('text')],
  };
}

function blankBlock(type: Block['type']): Block {
  switch (type) {
    case 'math': return { type: 'math', tex: '', display: true };
    case 'svg': return { type: 'svg', svg: '' };
    case 'mermaid': return { type: 'mermaid', code: '' };
    case 'code': return { type: 'code', language: 'text', value: '' };
    case 'table': return { type: 'table', headers: [''], rows: [] };
    case 'chart': return { type: 'chart', spec: { kind: 'line' } };
    case 'image': return { type: 'image', assetId: '', alt: '' };
    default: return { type: 'text', value: '' };
  }
}

/** Empty blocks are dropped before saving; the server requires content. */
function isNonEmptyBlock(block: Block): boolean {
  switch (block.type) {
    case 'text': return block.value.trim().length > 0;
    case 'math': return block.tex.trim().length > 0;
    case 'svg': return block.svg.trim().length > 0;
    case 'mermaid': return block.code.trim().length > 0;
    case 'code': return block.value.trim().length > 0;
    case 'table': return block.headers.some((h) => h.trim()) || block.rows.length > 0;
    // An image block with nothing uploaded yet would fail the server's uuid
    // check; drop it rather than making the admin hunt for the reason.
    case 'image': return !!block.assetId;
    default: return true;
  }
}

/** Seconds as a teacher would read them: 45s, 2m 30s. */
function formatSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}
