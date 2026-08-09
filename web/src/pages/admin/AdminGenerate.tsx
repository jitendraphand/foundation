import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, Field, Modal, PageLoader, Spinner, formatDate, humanizeTag } from '../../components/ui';
import type { Tag } from '../../lib/types';

/**
 * "Set test" - the generation screen.
 *
 * The admin controls the provider, the model, the full system prompt, the
 * difficulty/cognitive mix and the exact user prompt. Nothing is hidden: the
 * prompt preview shows byte-for-byte what will be sent.
 */

interface Credential {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  keyHint: string;
  defaultModel: string | null;
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  kind: 'REGULAR' | 'PRACTICE';
  isDefault: boolean;
  systemPrompt: string;
  userTemplate: string;
}

interface Provider {
  id: string;
  label: string;
  defaultBaseUrl: string;
  suggestedModels: string[];
  supportsJsonMode: boolean;
}

interface Context {
  tags: { difficulty: Tag[]; cognitive: Tag[]; skill: Tag[] };
  credentials: Credential[];
  templates: Template[];
  providers: Provider[];
  defaults: { systemPrompt: string; userTemplate: string };
  formats: Array<{ code: string; label: string }>;
}

interface Outcome {
  runId: string;
  accepted: number;
  parsed: number;
  needingImages: number;
  rejected: Array<{ index: number; reason: string }>;
  warnings: string[];
}

export default function AdminGenerate() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const practiceFor = params.get('practiceFor');
  const seedSubject = params.get('subject') ?? '';
  const seedTopics = params.get('topics') ?? '';

  const [ctx, setCtx] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [preview, setPreview] = useState<{ systemPrompt: string; userPrompt: string } | null>(null);

  const [form, setForm] = useState({
    credentialId: '',
    model: '',
    templateId: '',
    subject: seedSubject,
    topic: seedTopics,
    subtopic: '',
    grade: '',
    count: 10,
    marksPerQuestion: 1,
    temperature: 0.4,
    formats: ['MCQ_SINGLE'] as string[],
    extraInstructions: '',
    avoidImages: false,
  });

  // Seeded from the live tag vocabulary once it arrives, never from a hard-coded
  // list. It used to start { easy: 4, moderate: 4, difficult: 2 } - the codes
  // from before difficulty was renamed to easy/medium/hard. The two retired keys
  // had no box to show them in, so they were invisible, but they were still
  // counted: putting 10 in Hard read "16 allocated, 10 requested".
  const [difficultyMix, setDifficultyMix] = useState<Record<string, number>>({});
  const [cognitiveMix, setCognitiveMix] = useState<Record<string, number>>({});
  const [skillFocus, setSkillFocus] = useState<string[]>([]);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [editingPrompt, setEditingPrompt] = useState(false);

  useEffect(() => {
    api
      .get<Context>('/api/admin/generation/context')
      .then((data) => {
        setCtx(data);
        const kind = practiceFor ? 'PRACTICE' : 'REGULAR';
        const template = data.templates.find((t) => t.isDefault && t.kind === kind) ?? data.templates[0];
        const credential = data.credentials[0];
        setForm((f) => ({
          ...f,
          credentialId: credential?.id ?? '',
          model: credential?.defaultModel ?? '',
          templateId: template?.id ?? '',
        }));
        setSystemPrompt(template?.systemPrompt ?? data.defaults.systemPrompt);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the generation settings.'));
  }, [practiceFor]);

  const credential = ctx?.credentials.find((c) => c.id === form.credentialId);
  const provider = ctx?.providers.find((p) => p.id === credential?.provider);

  const difficultyCodes = useMemo(() => ctx?.tags.difficulty.map((t) => t.code) ?? [], [ctx]);

  // Only codes that exist. A key left over from a renamed tag cannot inflate
  // the total again, whatever put it there.
  const mixTotal = useMemo(
    () => difficultyCodes.reduce((sum, code) => sum + (difficultyMix[code] ?? 0), 0),
    [difficultyMix, difficultyCodes],
  );

  /** Spreads `count` across the difficulty levels, remainder to the easier end. */
  const spreadMix = useCallback(
    (count: number, codes: string[]): Record<string, number> => {
      if (codes.length === 0) return {};
      const each = Math.floor(count / codes.length);
      let left = count - each * codes.length;
      return Object.fromEntries(codes.map((code) => [code, each + (left-- > 0 ? 1 : 0)]));
    },
    [],
  );

  // Seed once the vocabulary is known.
  useEffect(() => {
    if (difficultyCodes.length === 0) return;
    setDifficultyMix((m) => (Object.keys(m).length ? m : spreadMix(form.count, difficultyCodes)));
    // form.count is deliberately not a dependency: this seeds, it does not follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [difficultyCodes, spreadMix]);

  // Follow the requested count while the mix is still whatever we spread. The
  // moment an admin types a number of their own the totals stop matching and
  // this leaves them alone - it is their allocation, not ours to overwrite.
  const lastCount = useRef(form.count);
  useEffect(() => {
    const previous = lastCount.current;
    lastCount.current = form.count;
    if (previous === form.count || difficultyCodes.length === 0) return;
    setDifficultyMix((m) => {
      const total = difficultyCodes.reduce((sum, code) => sum + (m[code] ?? 0), 0);
      return total === previous ? spreadMix(form.count, difficultyCodes) : m;
    });
  }, [form.count, difficultyCodes, spreadMix]);

  const spec = () => ({
    subject: form.subject.trim(),
    topic: form.topic.trim() || undefined,
    subtopic: form.subtopic.trim() || undefined,
    grade: form.grade || undefined,
    count: form.count,
    marksPerQuestion: form.marksPerQuestion,
    // Only real codes travel: the server rejects a question tagged with
    // vocabulary it does not know, so asking for one would be self-defeating.
    difficultyMix: Object.fromEntries(difficultyCodes.map((c) => [c, difficultyMix[c] ?? 0])),
    cognitiveMix: Object.keys(cognitiveMix).length ? cognitiveMix : undefined,
    skillFocus: skillFocus.length ? skillFocus : undefined,
    formats: form.formats,
    extraInstructions: form.extraInstructions.trim() || undefined,
    avoidImages: form.avoidImages,
  });

  const showPreview = async () => {
    try {
      const res = await api.post<{ systemPrompt: string; userPrompt: string }>('/api/admin/generation/preview-prompt', {
        spec: spec(),
        systemPrompt,
        promptTemplateId: form.templateId || undefined,
      });
      setPreview(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build the prompt preview.');
    }
  };

  // A run is not tied to this page. Closing the tab or signing out does not
  // stop it - the questions still land in the bank - but the summary is only
  // shown to whoever is still watching, so say so before it is lost.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await api.post<Outcome>('/api/admin/generation/run', {
        credentialId: form.credentialId,
        model: form.model,
        promptTemplateId: form.templateId || undefined,
        systemPrompt,
        temperature: form.temperature,
        kind: practiceFor ? 'PRACTICE' : 'REGULAR',
        targetUserId: practiceFor ?? undefined,
        spec: spec(),
      });
      setOutcome(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Generation failed.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !ctx) return <Alert tone="error">{error}</Alert>;
  if (!ctx) return <PageLoader label="Loading" />;

  if (ctx.credentials.length === 0) {
    return (
      <Card title="Set test">
        <Alert tone="warn">
          No LLM provider is configured yet. Add an API key in <strong>Settings</strong> before generating questions.
        </Alert>
        <button type="button" className="btn-primary btn-sm mt-3" onClick={() => navigate('/admin/settings')}>
          Go to settings
        </button>
      </Card>
    );
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-lg font-semibold">{practiceFor ? 'Generate a practice test' : 'Set a test'}</h1>
        <p className="text-xs text-ink-muted mt-1">
          {practiceFor
            ? 'Questions target this student’s weak areas. Practice results stay separate from class test results.'
            : 'Generate draft questions, review them, then choose which ones make the final paper.'}
        </p>
      </div>

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <div className="flex justify-end">
        <button type="button" className="btn-secondary btn-sm" onClick={() => setImporting(true)}>
          Import from a file instead
        </button>
      </div>

      {importing && (
        <ImportQuestionsModal
          onClose={() => setImporting(false)}
          onImported={(result) => {
            setImporting(false);
            setOutcome(result);
          }}
        />
      )}

      {outcome && (
        <Card title="Generation complete">
          <div className="space-y-3">
            <Alert tone={outcome.rejected.length ? 'warn' : 'success'}>
              {outcome.accepted} of {outcome.parsed} questions were accepted and saved as drafts.
            </Alert>

            {outcome.needingImages > 0 && (
              <Alert tone="warn">
                {outcome.needingImages} question{outcome.needingImages === 1 ? '' : 's'} need
                {outcome.needingImages === 1 ? 's' : ''} a picture. The model could not draw
                {outcome.needingImages === 1 ? ' it' : ' them'}, so it wrote an image-generation prompt for each one.
                Open the review screen, copy the prompt into any image generator, and upload the result — they cannot
                be approved until you do.
              </Alert>
            )}

            {outcome.rejected.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-ink-muted">{outcome.rejected.length} rejected — why?</summary>
                <ul className="mt-2 space-y-1 text-ink-muted">
                  {outcome.rejected.map((r) => (
                    <li key={r.index}>Question {r.index + 1}: {r.reason}</li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => navigate(`/admin/questions?generationRunId=${outcome.runId}&status=DRAFT`)}
              >
                Review the {outcome.accepted} draft{outcome.accepted === 1 ? '' : 's'}
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setOutcome(null)}>
                Generate more
              </button>
            </div>
          </div>
        </Card>
      )}

      <Card title="Provider">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="API credential">
            <select
              className="input"
              value={form.credentialId}
              onChange={(e) => {
                const next = ctx.credentials.find((c) => c.id === e.target.value);
                setForm((f) => ({ ...f, credentialId: e.target.value, model: next?.defaultModel ?? '' }));
              }}
            >
              {ctx.credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.provider} · {c.keyHint})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Model" hint={provider?.supportsJsonMode ? 'This provider supports strict JSON mode.' : 'Strict JSON is enforced by validation and retry.'}>
            <input
              className="input font-mono text-xs"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              list="model-suggestions"
              placeholder="provider/model-name"
            />
            <datalist id="model-suggestions">
              {provider?.suggestedModels.map((m) => <option key={m} value={m} />)}
            </datalist>
          </Field>
        </div>
      </Card>

      <Card title="Test content">
        <div className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Subject" required>
              <input className="input" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Mathematics" />
            </Field>
            <Field label="Topic">
              <input className="input" value={form.topic} onChange={(e) => setForm((f) => ({ ...f, topic: e.target.value }))} placeholder="Quadratic equations" />
            </Field>
            <Field label="Subtopic">
              <input className="input" value={form.subtopic} onChange={(e) => setForm((f) => ({ ...f, subtopic: e.target.value }))} placeholder="Discriminant" />
            </Field>
          </div>

          <div className="grid sm:grid-cols-4 gap-4">
            <Field label="Grade">
              <input className="input" value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))} placeholder="8" />
            </Field>
            <Field
              label="Number of questions"
              required
              hint={form.count > 10 ? `Asked for in ${Math.ceil(form.count / 10)} calls — allow a few minutes.` : undefined}
            >
              <input
                type="number" min={1} max={100} className="input"
                value={form.count}
                onChange={(e) => setForm((f) => ({ ...f, count: Number(e.target.value) }))}
              />
            </Field>
            <Field label="Marks per question" required>
              <input
                type="number" min={0.25} step={0.25} className="input"
                value={form.marksPerQuestion}
                onChange={(e) => setForm((f) => ({ ...f, marksPerQuestion: Number(e.target.value) }))}
              />
            </Field>
            <Field label="Temperature" hint="Lower is more predictable.">
              <input
                type="number" min={0} max={2} step={0.1} className="input"
                value={form.temperature}
                onChange={(e) => setForm((f) => ({ ...f, temperature: Number(e.target.value) }))}
              />
            </Field>
          </div>

          <Field label="Question formats">
            <div className="flex flex-wrap gap-2">
              {ctx.formats.map((format) => {
                const on = form.formats.includes(format.code);
                return (
                  <button
                    key={format.code}
                    type="button"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        // Never let the last format be switched off.
                        formats: on
                          ? f.formats.length > 1
                            ? f.formats.filter((x) => x !== format.code)
                            : f.formats
                          : [...f.formats, format.code],
                      }))
                    }
                    className={`badge ${on ? 'border-series-1/40 bg-series-1/[0.08] text-series-1' : ''}`}
                  >
                    {format.label}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Difficulty and tags">
        <div className="space-y-4">
          <div>
            <span className="label">
              Difficulty mix
              {mixTotal !== form.count && (
                <span className="ml-2 text-warn">({mixTotal} allocated, {form.count} requested)</span>
              )}
            </span>
            {/* One per row on a phone, three across from sm. Three fixed
                columns squeezed an 80px label and a number box into 110px,
                which left the input with no width at all. */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {ctx.tags.difficulty.map((tag) => (
                <label key={tag.code} className="flex items-center gap-2">
                  <span className="text-xs text-ink-muted flex-1 sm:flex-none sm:w-20">{tag.label}</span>
                  <input
                    type="number" min={0} className="input py-1.5 w-24 sm:w-auto"
                    value={difficultyMix[tag.code] ?? 0}
                    onChange={(e) => setDifficultyMix((m) => ({ ...m, [tag.code]: Number(e.target.value) }))}
                  />
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="label">Cognitive mix (optional — leave empty for a balanced spread)</span>
            <div className="grid sm:grid-cols-5 gap-3">
              {ctx.tags.cognitive.map((tag) => (
                <label key={tag.code} className="flex items-center gap-2" title={tag.description ?? ''}>
                  <span className="text-xs text-ink-muted flex-1 truncate">{tag.label}</span>
                  <input
                    type="number" min={0} className="input py-1.5 w-14"
                    value={cognitiveMix[tag.code] ?? 0}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setCognitiveMix((m) => {
                        const next = { ...m };
                        if (n > 0) next[tag.code] = n;
                        else delete next[tag.code];
                        return next;
                      });
                    }}
                  />
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="label">Skill focus (optional)</span>
            <div className="flex flex-wrap gap-2">
              {ctx.tags.skill.map((tag) => {
                const on = skillFocus.includes(tag.code);
                return (
                  <button
                    key={tag.code}
                    type="button"
                    title={tag.description ?? ''}
                    onClick={() => setSkillFocus((s) => (on ? s.filter((x) => x !== tag.code) : [...s, tag.code]))}
                    className={`badge ${on ? 'border-series-1/40 bg-series-1/[0.08] text-series-1' : ''}`}
                  >
                    {tag.label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-series-1 mt-0.5"
              checked={form.avoidImages}
              onChange={(e) => setForm((f) => ({ ...f, avoidImages: e.target.checked }))}
            />
            <span className="text-ink-muted">
              Text and drawn diagrams only
              <span className="block text-[11px] text-ink-faint">
                No question will need a photograph, so every draft is ready to approve immediately. Figures are still
                drawn as SVG, flow charts and graphs.
              </span>
            </span>
          </label>

          <Field label="Extra instructions to the model (optional)">
            <textarea
              className="input font-mono text-xs"
              rows={3}
              value={form.extraInstructions}
              onChange={(e) => setForm((f) => ({ ...f, extraInstructions: e.target.value }))}
              placeholder="e.g. Use Indian currency and metric units. Include at least two questions with a diagram."
            />
          </Field>
        </div>
      </Card>

      <Card
        title="System prompt"
        action={
          <div className="flex gap-2">
            <select
              className="input w-auto text-xs py-1"
              value={form.templateId}
              onChange={(e) => {
                const template = ctx.templates.find((t) => t.id === e.target.value);
                setForm((f) => ({ ...f, templateId: e.target.value }));
                if (template) setSystemPrompt(template.systemPrompt);
              }}
            >
              {ctx.templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setEditingPrompt(true)}>
              Edit
            </button>
          </div>
        }
      >
        <p className="text-xs text-ink-muted mb-2">
          This defines the strict reply format, the block types for maths and diagrams, and the tag vocabulary.
          Editing it here affects only this run; save a template in Settings to keep changes.
        </p>
        <pre className="scroll-x max-h-40 overflow-y-auto rounded-lg bg-surface-sunken border border-line p-3 text-[11px] font-mono whitespace-pre-wrap text-ink-muted">
          {systemPrompt.slice(0, 1200)}
          {systemPrompt.length > 1200 && '\n…'}
        </pre>
      </Card>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy || !form.subject.trim() || !form.model} onClick={generate}>
          {busy ? <Spinner label="Generating — this can take a minute" /> : `Generate ${form.count} questions`}
        </button>
        <button type="button" className="btn-secondary" onClick={showPreview} disabled={busy}>
          Preview the exact prompt
        </button>
      </div>

      {busy && (
        <Alert tone="info">
          This keeps going on the server even if you close the tab or sign out — the questions still arrive in the
          question bank. What you would lose is this summary, and <strong>Recent runs</strong> below has it.
        </Alert>
      )}

      <RecentRuns refreshKey={outcome?.runId ?? (busy ? 'running' : '')} />

      <Modal open={editingPrompt} onClose={() => setEditingPrompt(false)} title="Edit the system prompt" wide>
        <textarea
          className="input font-mono text-xs"
          rows={24}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
        <div className="flex justify-between gap-2 mt-3">
          <button type="button" className="btn-ghost btn-sm" onClick={() => setSystemPrompt(ctx.defaults.systemPrompt)}>
            Reset to default
          </button>
          <button type="button" className="btn-primary btn-sm" onClick={() => setEditingPrompt(false)}>
            Done
          </button>
        </div>
      </Modal>

      <Modal open={!!preview} onClose={() => setPreview(null)} title="Exactly what will be sent" wide>
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-medium text-ink-muted mb-1">System message</h3>
            <pre className="scroll-x max-h-64 overflow-y-auto rounded-lg bg-surface-sunken border border-line p-3 text-[11px] font-mono whitespace-pre-wrap">
              {preview?.systemPrompt}
            </pre>
          </div>
          <div>
            <h3 className="text-xs font-medium text-ink-muted mb-1">User message</h3>
            <pre className="scroll-x rounded-lg bg-surface-sunken border border-line p-3 text-[11px] font-mono whitespace-pre-wrap">
              {preview?.userPrompt}
            </pre>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// --- What happened to the last few runs ------------------------------------

interface RunRow {
  id: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  provider: string;
  model: string;
  createdAt: string;
  completedAt: string | null;
  questionsRequested: number;
  questionsAccepted: number | null;
  errorMessage: string | null;
  requestedBy: { username: string } | null;
  requestSpec: { subject?: string } | null;
}

/**
 * The last few generation runs and how they ended.
 *
 * A run is not tied to the page that started it: it lives on the server and
 * finishes whether or not anybody is watching. Without this, switching tabs
 * during a long batch meant the outcome was simply gone - the questions were in
 * the bank, but how many were rejected and why was not recoverable, and the
 * deployment notes pointed at a "generation history" screen that did not exist.
 *
 * A run still in progress is polled, so leaving this page open and coming back
 * shows the result rather than a stale spinner.
 */
function RecentRuns({ refreshKey }: { refreshKey: string }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ runs: RunRow[] }>('/api/admin/generation/runs?pageSize=5');
      setRuns(res.runs);
      return res.runs;
    } catch {
      setRuns([]);
      return [];
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Only while something is actually in flight; a finished list polls nothing.
  useEffect(() => {
    if (!runs?.some((r) => r.status === 'RUNNING' || r.status === 'PENDING')) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [runs, load]);

  if (!runs || runs.length === 0) return null;

  return (
    <Card title="Recent runs" padded={false}>
      <ul className="divide-y divide-line">
        {runs.map((run) => {
          const spec = run.requestSpec ?? {};
          const running = run.status === 'RUNNING' || run.status === 'PENDING';
          return (
            <li key={run.id} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge tone={running ? 'warn' : run.status === 'SUCCEEDED' ? 'good' : 'bad'}>
                {running ? 'running' : run.status.toLowerCase()}
              </Badge>
              <span className="text-sm">
                {spec.subject ?? 'questions'}
                <span className="text-ink-muted">
                  {' '}
                  — {run.questionsAccepted ?? 0} of {run.questionsRequested} accepted
                </span>
              </span>
              <span className="text-[11px] text-ink-faint font-mono truncate">{run.model}</span>
              <span className="text-[11px] text-ink-faint ml-auto whitespace-nowrap">
                {formatDate(run.createdAt, true)}
              </span>
              {(run.questionsAccepted ?? 0) > 0 && (
                <button
                  type="button"
                  className="btn-ghost btn-sm"
                  onClick={() => navigate(`/admin/questions?bucket=DRAFT&generationRunId=${run.id}`)}
                >
                  See them
                </button>
              )}
              {run.errorMessage && !running && (
                <p className="w-full text-[11px] text-bad whitespace-pre-wrap">
                  {run.errorMessage.slice(0, 400)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// --- Loading questions without an API --------------------------------------

/**
 * The offline way in.
 *
 * Question generation depends on somebody else's service being up, in credit,
 * and reachable from the school's connection. When it is not — and the exam is
 * tomorrow — this takes the same JSON the model would have produced, from
 * wherever it came from, and puts it through exactly the same validation and
 * the same review queue.
 */
function ImportQuestionsModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (outcome: Outcome) => void;
}) {
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<{ notes: string[] }>('/api/admin/questions/import-template')
      .then((res) => setNotes(res.notes))
      .catch(() => undefined);
  }, []);

  const downloadTemplate = async () => {
    try {
      const res = await api.get<{ filename: string; template: unknown }>('/api/admin/questions/import-template');
      const blob = new Blob([JSON.stringify(res.template, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not fetch the template.');
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.post<Outcome>('/api/admin/questions/import', {
        payload: text,
        sourceLabel: label.trim() || undefined,
      });
      onImported(outcome);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import that file.');
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Import questions from a file" wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error"><span className="whitespace-pre-wrap">{error}</span></Alert>}

        <Alert tone="info">
          Use this when the provider is down, out of credit, or unreachable. The questions go through the same checks
          and land as drafts for review, exactly like generated ones.
        </Alert>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={() => void downloadTemplate()}>
            Download the template
          </button>
          <button type="button" className="btn-secondary btn-sm" onClick={() => fileInput.current?.click()}>
            Choose a .json file
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json,.txt"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setLabel(file.name);
              setText(await file.text());
            }}
          />
        </div>

        <Field
          label="Questions"
          required
          hint="Paste the JSON, or the whole reply it came in — fences and surrounding chatter are ignored."
        >
          <textarea
            className="input font-mono text-xs"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'{\n  "questions": [ … ]\n}'}
            required
          />
        </Field>

        <Field label="Where it came from" hint="Optional. Recorded against the batch so you can find it later.">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="questions-week-3.json" />
        </Field>

        {notes.length > 0 && (
          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer">What the file has to contain</summary>
            <ul className="mt-2 space-y-1 list-disc pl-4">
              {notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </details>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || text.trim().length < 2}>
            {busy ? <Spinner label="Importing" /> : 'Import'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
