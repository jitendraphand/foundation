import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageLoader, Spinner, humanizeTag } from '../../components/ui';
import { ContentRenderer, BlocksRenderer } from '../../renderers/BlockRenderer';
import type { BankQuestion, Tag } from '../../lib/types';

/**
 * The question bank and draft review screen.
 *
 * This is where LLM output becomes a real question: the admin sees it rendered
 * exactly as a student will (maths, diagrams, charts and all), fixes anything
 * wrong, then approves it.
 */

type Bucket = 'DRAFT' | 'APPROVED' | 'ON_TEST' | 'REJECTED';

const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: 'DRAFT', label: 'Awaiting review' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'ON_TEST', label: 'On a test' },
  { id: 'REJECTED', label: 'Rejected' },
];

export default function AdminQuestions() {
  const [params, setParams] = useSearchParams();
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [tags, setTags] = useState<{ difficulty: Tag[]; cognitive: Tag[]; skill: Tag[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<BankQuestion | null>(null);
  const [allocating, setAllocating] = useState(false);
  // Approving reloads the list, which normally clears the selection. These
  // ids are re-selected once they reappear under "Approved", so the admin can
  // put them straight on a paper instead of hunting for them again.
  const carryOver = useRef<string[] | null>(null);
  const [counts, setCounts] = useState<Record<Bucket, number> | null>(null);

  // Four exclusive places, not three states: an approved question already on
  // a paper is spoken for, and showing it under "Approved" made an admin
  // building a second test think it was still free.
  const bucket = (params.get('bucket') ?? params.get('status') ?? 'DRAFT') as Bucket;
  const subject = params.get('subject') ?? '';
  const runId = params.get('generationRunId') ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ pageSize: '50' });
      if (bucket) query.set('bucket', bucket);
      if (subject) query.set('subject', subject);
      if (runId) query.set('generationRunId', runId);

      const res = await api.get<{ questions: BankQuestion[]; counts: Record<Bucket, number> }>(
        `/api/admin/questions?${query}`,
      );
      setQuestions(res.questions);
      setCounts(res.counts);

      const keep = carryOver.current;
      carryOver.current = null;
      setSelected(keep ? new Set(keep.filter((id) => res.questions.some((q) => q.id === id))) : new Set());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load questions.');
    } finally {
      setLoading(false);
    }
  }, [bucket, subject, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ tags: { difficulty: Tag[]; cognitive: Tag[]; skill: Tag[] } }>('/api/admin/generation/context')
      .then((res) => setTags(res.tags))
      .catch(() => undefined);
  }, []);

  /**
   * Really deletes, rather than retiring. Only offered from Rejected, because
   * that is the only list where an admin has already decided the question is
   * no good; anywhere else this would be a slip waiting to happen.
   */
  const removeForGood = async (ids: string[]) => {
    if (ids.length === 0) return;
    const plural = ids.length === 1 ? '' : 's';
    if (!window.confirm(
      `Permanently delete ${ids.length} question${plural}? This cannot be undone. ` +
      'Any that students have already answered will be kept instead, so released results stay explainable.',
    )) return;

    try {
      const results = await Promise.all(ids.map((id) => api.delete<{ mode: string }>(`/api/admin/questions/${id}`)));
      const hard = results.filter((r) => r.mode === 'hard').length;
      const soft = results.length - hard;
      setNotice(
        `${hard} question${hard === 1 ? '' : 's'} deleted for good.` +
          (soft ? ` ${soft} had already been answered, so ${soft === 1 ? 'it was' : 'they were'} retired instead.` : ''),
      );
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete those questions.');
    }
  };

  const setStatus = async (ids: string[], next: 'APPROVED' | 'REJECTED' | 'DRAFT') => {
    if (ids.length === 0) return;
    try {
      const res = await api.post<{ updated: number; blocked: number; message?: string }>(
        '/api/admin/questions/bulk-status',
        { ids, status: next },
      );

      const n = res.updated;
      const plural = n === 1 ? '' : 's';
      setNotice(
        next === 'APPROVED' && n > 0
          ? `${n} question${plural} approved — still selected, ready to go on a test.`
          : next === 'REJECTED' && n > 0
            ? `${n} question${plural} rejected and taken out of use. ${res.message ?? ''}`.trim()
            : next === 'DRAFT' && n > 0
              ? `${n} question${plural} put back to draft.`
              : `${n} question${plural} marked ${next.toLowerCase()}.`,
      );
      // Questions still waiting for a picture are skipped rather than approved.
      if (res.blocked > 0 && res.message) setError(res.message);

      // Approving is not the end of the job, so land where the next step is.
      if (next === 'APPROVED' && res.updated > 0 && bucket !== 'APPROVED') {
        carryOver.current = ids;
        const params2 = new URLSearchParams(params);
        params2.set('bucket', 'APPROVED');
        setParams(params2);
        return; // the filter change reloads the list
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update those questions.');
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Question bank</h1>

        <div className="flex flex-wrap items-center gap-2">
          {runId && (

            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('generationRunId');
                setParams(next);
              }}
            >
              Clear run filter ×
            </button>
          )}
        </div>
      </div>

      <div className="scroll-x -mx-1 px-1">
        <div className="flex gap-1 border-b border-line" role="tablist">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={bucket === b.id}
              className={
                'px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ' +
                (bucket === b.id
                  ? 'border-brand text-brand font-medium'
                  : 'border-transparent text-ink-muted hover:text-ink')
              }
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('bucket', b.id);
                next.delete('status');
                setParams(next);
              }}
            >
              {b.label}
              {counts && (
                <span className="ml-1.5 tabular-nums text-xs text-ink-faint">{counts[b.id]}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {bucket === 'REJECTED' && (
        <Alert tone="info">
          Rejected questions are out of use: taken off every test that has not been sat yet, and never given to a
          student starting a new paper. They stay here so a mistake can be undone — select and choose
          “Back to draft”. A test students have already sat keeps its copy, so their results do not change.
        </Alert>
      )}

      {selected.size > 0 && (
        <div className="sticky top-[104px] z-20 card px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-pop">
          <span className="text-sm">{selected.size} selected</span>
          <div className="flex gap-2">
            {/* Approving used to be the end of the road here: the admin then
                had to go to Tests, make one, and hope its subject matched.
                Putting them on a paper belongs at the moment of approval. */}
            {bucket === 'APPROVED' && (
              <button type="button" className="btn-primary btn-sm" onClick={() => setAllocating(true)}>
                Put on a test
              </button>
            )}
            {/* A question can be sent to any of the other places from wherever
                it is now, so a mis-click is never a one-way door. */}
            {bucket !== 'APPROVED' && bucket !== 'ON_TEST' && (
              <button type="button" className="btn-primary btn-sm" onClick={() => setStatus([...selected], 'APPROVED')}>
                Approve
              </button>
            )}
            {bucket !== 'DRAFT' && (
              <button type="button" className="btn-secondary btn-sm" onClick={() => setStatus([...selected], 'DRAFT')}>
                Back to draft
              </button>
            )}
            {bucket !== 'REJECTED' && (
              <button type="button" className="btn-secondary btn-sm" onClick={() => setStatus([...selected], 'REJECTED')}>
                Reject
              </button>
            )}
            {bucket === 'REJECTED' && (
              <button type="button" className="btn-secondary btn-sm text-bad" onClick={() => void removeForGood([...selected])}>
                Delete for good
              </button>
            )}
            <button type="button" className="btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <PageLoader label="Loading questions" />
      ) : questions.length === 0 ? (
        <Card>
          <EmptyState
            title={
              bucket === 'DRAFT'
                ? 'No drafts awaiting review'
                : bucket === 'ON_TEST'
                  ? 'No questions are on a test yet'
                  : `No ${bucket.toLowerCase()} questions`
            }
            hint={
              bucket === 'DRAFT'
                ? 'Generate questions from the "Set test" screen to see them here.'
                : bucket === 'ON_TEST'
                  ? 'Approve questions, then use "Put on a test" to build a paper.'
                  : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setSelected(selected.size === questions.length ? new Set() : new Set(questions.map((q) => q.id)))}
            >
              {selected.size === questions.length ? 'Deselect all' : `Select all ${questions.length}`}
            </button>
          </div>

          <ul className="space-y-3">
            {questions.map((question, i) => (
              <QuestionCard
                key={question.id}
                question={question}
                index={i}
                selected={selected.has(question.id)}
                onToggle={() => toggle(question.id)}
                onEdit={() => setEditing(question)}
                onStatus={(next) => setStatus([question.id], next)}
                onChanged={load}
              />
            ))}
          </ul>
        </>
      )}

      {allocating && (
        <AddToTestModal
          questionIds={[...selected]}
          defaultSubject={questions.find((q) => selected.has(q.id))?.subject ?? ''}
          onClose={() => setAllocating(false)}
          onDone={(message) => {
            setAllocating(false);
            setSelected(new Set());
            setNotice(message);
          }}
        />
      )}

      {editing && tags && (
        <EditQuestionModal
          question={editing}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

// --- One question ----------------------------------------------------------

function QuestionCard({
  question, index, selected, onToggle, onEdit, onStatus, onChanged,
}: {
  question: BankQuestion;
  index: number;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onStatus: (status: 'APPROVED' | 'REJECTED' | 'DRAFT') => void;
  onChanged: () => void;
}) {
  const [showAnswer, setShowAnswer] = useState(false);
  const needsImage = question.imageRequired && !question.imageFulfilled;

  return (
    <li className={`card p-4 ${selected ? 'ring-2 ring-series-1/40' : ''}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1 accent-series-1" aria-label={`Select question ${index + 1}`} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-xs font-medium text-ink-muted">Q{index + 1}</span>
            <Badge tone={question.status === 'APPROVED' ? 'good' : question.status === 'REJECTED' ? 'bad' : 'warn'}>
              {question.status.toLowerCase()}
            </Badge>
            <Badge>{question.format.replace('_', ' ').toLowerCase()}</Badge>
            <Badge>{humanizeTag(question.difficultyTag)}</Badge>
            <Badge>{humanizeTag(question.cognitiveTag)}</Badge>
            {question.skillTags.map((t) => <Badge key={t}>{humanizeTag(t)}</Badge>)}
            {question.isAdminEdited && <Badge tone="info">edited</Badge>}
            {needsImage && <Badge tone="warn">image needed</Badge>}
            {question.imageRequired && question.imageFulfilled && <Badge tone="good">image attached</Badge>}
            {question.timesServed > 0 && (
              <span className="text-[11px] text-ink-faint">
                {Math.round(question.observedP * 100)}% correct over {question.timesServed} attempts
              </span>
            )}
          </div>

          {/* Rendered exactly as a student will see it. */}
          <ContentRenderer content={question.content} />

          {question.options.length > 0 && (
            <ul className="mt-3 space-y-1">
              {question.options.map((option) => {
                const correct =
                  question.answerKey?.correctOptionId === option.id ||
                  question.answerKey?.correctOptionIds?.includes(option.id);
                return (
                  <li
                    key={option.id}
                    className={`flex items-start gap-2 p-2 rounded-lg border text-sm ${
                      showAnswer && correct ? 'border-good/40 bg-good/[0.06]' : 'border-line'
                    }`}
                  >
                    <span className="text-xs font-medium text-ink-faint mt-0.5">{option.id.toUpperCase()}.</span>
                    <span className="min-w-0 flex-1">
                      <BlocksRenderer blocks={option.blocks} className="[&>p]:my-0" />
                    </span>
                    {showAnswer && correct && <span className="text-[11px] text-good shrink-0">correct</span>}
                  </li>
                );
              })}
            </ul>
          )}

          {question.imageRequired && !question.imageFulfilled && (
            <ImageNeededPanel question={question} onAttached={onChanged} />
          )}

          {showAnswer && question.explanation?.blocks?.length ? (
            <div className="mt-3 rounded-lg bg-surface-sunken border border-line p-3">
              <h4 className="text-xs font-medium text-ink-muted mb-1">Explanation</h4>
              <ContentRenderer content={question.explanation} className="text-sm" />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-line">
            <button type="button" className="btn-ghost btn-sm" onClick={() => setShowAnswer((v) => !v)}>
              {showAnswer ? 'Hide answer' : 'Show answer'}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={onEdit}>
              Edit
            </button>
            {question.status !== 'APPROVED' && (
              <button
                type="button"
                className="btn-primary btn-sm"
                onClick={() => onStatus('APPROVED')}
                disabled={needsImage}
                title={needsImage ? 'Attach the image first — a student cannot answer this without it.' : undefined}
              >
                Approve
              </button>
            )}
            {question.status !== 'REJECTED' && (
              <button type="button" className="btn-ghost btn-sm" onClick={() => onStatus('REJECTED')}>
                Reject
              </button>
            )}
            <span className="ml-auto text-[11px] text-ink-faint truncate max-w-[220px]">
              {question.subject}
              {question.sourceModel ? ` · ${question.sourceModel}` : ''}
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}

// --- Questions that need a picture -----------------------------------------

/**
 * None of the supported providers generate images, so the model supplies a
 * ready-made prompt instead. This panel puts that prompt one click from the
 * clipboard, then accepts the finished picture.
 */
function ImageNeededPanel({ question, onAttached }: { question: BankQuestion; onAttached: () => void }) {
  const spec = question.imagePrompt;
  const [copied, setCopied] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState<{ assetId: string; width: number; height: number } | null>(null);
  const [imageProviderReady, setImageProviderReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Only offer the button when a provider is actually configured; otherwise it
  // is a button whose only outcome is an error message.
  useEffect(() => {
    api
      .get<{ config: { credentialId: string } | null }>('/api/admin/image-provider')
      .then((res) => setImageProviderReady(!!res.config))
      .catch(() => setImageProviderReady(false));
  }, []);

  if (!spec) {
    return (
      <div className="mt-3 rounded-lg border border-warn/30 bg-warn/[0.06] p-3 text-xs text-warn">
        This question is flagged as needing an image, but no image prompt was supplied. Edit the question to add one,
        or clear the flag if you have drawn the figure yourself.
      </div>
    );
  }

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError('Could not copy automatically. Select the text and copy it by hand.');
    }
  };

  // Everything a picture generator needs, in one paste.
  const fullPrompt = [
    spec.prompt,
    spec.details.length ? `Must show: ${spec.details.join('; ')}.` : '',
    spec.style ? `Style: ${spec.style}.` : '',
    `Size: ${spec.widthPx}x${spec.heightPx} pixels${spec.aspectRatio ? ` (${spec.aspectRatio})` : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');

  /** Draws the picture, but does not attach it - that is a separate decision. */
  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await api.post<{ assetId: string; width: number; height: number }>(
        `/api/admin/questions/${question.id}/generate-image`,
        {},
      );
      setPreview({ assetId: res.assetId, width: res.width, height: res.height });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate a picture just now.');
    } finally {
      setGenerating(false);
    }
  };

  const attach = async (assetId: string) => {
    setUploading(true);
    setError(null);
    try {
      await api.post(`/api/admin/questions/${question.id}/image`, {
        assetId,
        altText: spec.altText || undefined,
      });
      onAttached();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not attach that image.');
    } finally {
      setUploading(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('altText', spec.altText || '');
      form.append('questionId', question.id);

      const res = await api.upload<{ asset: { id: string } }>('/api/admin/assets', form);
      await api.post(`/api/admin/questions/${question.id}/image`, {
        assetId: res.asset.id,
        altText: spec.altText || undefined,
      });
      onAttached();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not attach that image.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-warn/30 bg-warn/[0.05] p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-warn">This question needs a picture</h4>
          <p className="text-xs text-ink-muted mt-0.5">{spec.description}</p>
        </div>
        <span className="badge shrink-0">
          {spec.placement === 'OPTION' ? `option ${String(spec.optionId ?? '').toUpperCase()}` : 'question'}
        </span>
      </div>

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-[11px] font-medium text-ink-muted">
            Prompt — paste this into any image generator
          </span>
          <button type="button" className="btn-secondary btn-sm" onClick={() => copy(fullPrompt, 'prompt')}>
            {copied === 'prompt' ? 'Copied' : 'Copy prompt'}
          </button>
        </div>
        <p className="rounded-lg border border-line bg-white p-2 text-xs font-mono whitespace-pre-wrap break-words">
          {fullPrompt}
        </p>
      </div>

      {spec.details.length > 0 && (
        <div>
          <span className="text-[11px] font-medium text-ink-muted">The picture must show</span>
          <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted space-y-0.5">
            {spec.details.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        </div>
      )}

      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-ink-muted">
        <div><dt className="inline font-medium">Size: </dt><dd className="inline tabular-nums">{spec.widthPx} × {spec.heightPx} px</dd></div>
        {spec.aspectRatio && <div><dt className="inline font-medium">Ratio: </dt><dd className="inline">{spec.aspectRatio}</dd></div>}
        {spec.style && <div><dt className="inline font-medium">Style: </dt><dd className="inline">{spec.style}</dd></div>}
        {spec.altText && <div><dt className="inline font-medium">Alt text: </dt><dd className="inline">{spec.altText}</dd></div>}
      </dl>

      {/* The generated image is shown before it is attached: a picture going
          onto a paper a child will sit is worth one look first. */}
      {preview && (
        <div className="rounded-lg border border-line bg-white p-2">
          <img
            src={`/uploads/${preview.assetId}`}
            alt={spec.altText || 'Generated figure'}
            width={preview.width}
            height={preview.height}
            className="mx-auto max-h-64 w-auto rounded"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={() => void attach(preview.assetId)} disabled={uploading}>
              {uploading ? <Spinner label="Attaching" /> : 'Use this picture'}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => void generate()} disabled={generating}>
              {generating ? <Spinner label="Drawing" /> : 'Try again'}
            </button>
            <span className="text-[11px] text-ink-faint tabular-nums">{preview.width} × {preview.height} px</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-warn/20">
        {imageProviderReady && !preview && (
          <button type="button" className="btn-primary btn-sm" onClick={() => void generate()} disabled={generating}>
            {generating ? <Spinner label="Drawing" /> : 'Generate the picture'}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className={imageProviderReady ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? <Spinner label="Uploading" /> : 'Upload one instead'}
        </button>
        <span className="text-[11px] text-ink-faint">
          PNG, JPEG, WebP or GIF, up to 4 MB. It is placed above the {spec.placement === 'OPTION' ? 'option' : 'question'} text.
        </span>
      </div>
    </div>
  );
}

// --- Editing ---------------------------------------------------------------

function EditQuestionModal({
  question, tags, onClose, onSaved,
}: {
  question: BankQuestion;
  tags: { difficulty: Tag[]; cognitive: Tag[]; skill: Tag[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [contentJson, setContentJson] = useState(() => JSON.stringify(question.content, null, 2));
  const [optionsJson, setOptionsJson] = useState(() => JSON.stringify(question.options, null, 2));
  const [answerJson, setAnswerJson] = useState(() => JSON.stringify(question.answerKey, null, 2));
  const [explanationJson, setExplanationJson] = useState(() => JSON.stringify(question.explanation ?? { version: 1, blocks: [] }, null, 2));

  const [difficultyTag, setDifficultyTag] = useState(question.difficultyTag);
  const [cognitiveTag, setCognitiveTag] = useState(question.cognitiveTag);
  const [skillTags, setSkillTags] = useState<string[]>(question.skillTags);
  const [subject, setSubject] = useState(question.subject);
  const [topic, setTopic] = useState(question.topic ?? '');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Live preview of the edited JSON, so a broken diagram is obvious immediately.
  let previewContent: BankQuestion['content'] | null = null;
  let previewError: string | null = null;
  try {
    previewContent = JSON.parse(contentJson);
  } catch (err) {
    previewError = err instanceof Error ? err.message : 'Invalid JSON';
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/admin/questions/${question.id}`, {
        content: JSON.parse(contentJson),
        options: JSON.parse(optionsJson),
        answerKey: JSON.parse(answerJson),
        explanation: JSON.parse(explanationJson),
        difficultyTag,
        cognitiveTag,
        skillTags,
        subject,
        topic: topic || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Edit question" wide>
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Question content (blocks)</label>
            <textarea
              className="input font-mono text-[11px]"
              rows={14}
              value={contentJson}
              onChange={(e) => setContentJson(e.target.value)}
              spellCheck={false}
            />
            <p className="mt-1 text-[11px] text-ink-faint">
              Block types: text, math (LaTeX), svg, mermaid, chart, table, image, code.
            </p>
          </div>

          <div>
            <span className="label">Live preview</span>
            <div className="rounded-lg border border-line bg-surface-sunken p-3 min-h-[200px] max-h-[340px] overflow-y-auto">
              {previewError ? (
                <p className="text-xs text-bad">Invalid JSON: {previewError}</p>
              ) : (
                <ContentRenderer content={previewContent} />
              )}
            </div>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Options</label>
            <textarea className="input font-mono text-[11px]" rows={7} value={optionsJson} onChange={(e) => setOptionsJson(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <label className="label">Answer key</label>
            <textarea className="input font-mono text-[11px]" rows={7} value={answerJson} onChange={(e) => setAnswerJson(e.target.value)} spellCheck={false} />
          </div>
          <div>
            <label className="label">Explanation</label>
            <textarea className="input font-mono text-[11px]" rows={7} value={explanationJson} onChange={(e) => setExplanationJson(e.target.value)} spellCheck={false} />
          </div>
        </div>

        <div className="grid sm:grid-cols-4 gap-3">
          <div>
            <label className="label">Difficulty</label>
            <select className="input" value={difficultyTag} onChange={(e) => setDifficultyTag(e.target.value)}>
              {tags.difficulty.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Cognitive level</label>
            <select className="input" value={cognitiveTag} onChange={(e) => setCognitiveTag(e.target.value)}>
              {tags.cognitive.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Subject</label>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <label className="label">Topic</label>
            <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </div>
        </div>

        <div>
          <span className="label">Skills</span>
          <div className="flex flex-wrap gap-2">
            {tags.skill.map((tag) => {
              const on = skillTags.includes(tag.code);
              return (
                <button
                  key={tag.code}
                  type="button"
                  onClick={() => setSkillTags((s) => (on ? s.filter((x) => x !== tag.code) : [...s, tag.code]))}
                  className={`badge ${on ? 'border-series-1/40 bg-series-1/[0.08] text-series-1' : ''}`}
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || !!previewError}>
            {busy ? <Spinner label="Saving" /> : 'Save changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Putting approved questions on a paper ---------------------------------

interface TestOption {
  id: string;
  publicId: string;
  title: string;
  subject: string;
  kind: 'REGULAR' | 'PRACTICE';
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  marksPerQuestion: number;
  _count: { questions: number; attempts: number };
}

/**
 * The step that used to be missing.
 *
 * Approving a question left the admin on this screen with nothing to do next;
 * allocating it meant going to Tests, creating a paper, opening the builder
 * and hoping its subject string matched. Both halves of that now happen here:
 * add to a paper that already exists, or make one on the spot.
 */
function AddToTestModal({
  questionIds,
  defaultSubject,
  onClose,
  onDone,
}: {
  questionIds: string[];
  defaultSubject: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [tests, setTests] = useState<TestOption[] | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [testId, setTestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    subject: defaultSubject,
    durationMinutes: 30,
    marksPerQuestion: 1,
    negativeMarks: 0,
    targetGrades: '',
    targetDivisions: '',
  });

  useEffect(() => {
    api
      .get<{ tests: TestOption[] }>('/api/admin/tests?pageSize=100')
      .then((res) => {
        // A paper students have already sat cannot take new questions.
        const open = res.tests.filter((t) => t._count.attempts === 0);
        setTests(open);
        // Prefer one on the same subject; otherwise leave it to the admin.
        const match = open.find((t) => t.subject.toLowerCase() === defaultSubject.toLowerCase());
        setTestId(match?.id ?? open[0]?.id ?? '');
        if (open.length === 0) setMode('new');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the list of tests.'));
  }, [defaultSubject]);

  const addTo = async (id: string, title: string) => {
    const res = await api.post<{ message: string }>(`/api/admin/tests/${id}/questions/add`, { questionIds });
    onDone(res.message);
    // Straight into the builder, which is where they will want to be next.
    navigate(`/admin/tests/${id}`);
    return title;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'existing') {
        const target = tests?.find((t) => t.id === testId);
        if (!target) throw new ApiError('Choose a test first.', 400);
        await addTo(target.id, target.title);
      } else {
        const created = await api.post<{ test: { id: string; title: string } }>('/api/admin/tests', {
          title: form.title.trim(),
          subject: form.subject.trim(),
          kind: 'REGULAR',
          durationMinutes: form.durationMinutes,
          marksPerQuestion: form.marksPerQuestion,
          negativeMarks: form.negativeMarks,
          targetGrades: form.targetGrades.split(',').map((x) => x.trim()).filter(Boolean),
          targetDivisions: form.targetDivisions.split(',').map((x) => x.trim()).filter(Boolean),
        });
        await addTo(created.test.id, created.test.title);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not put the questions on a test.');
      setBusy(false);
    }
  };

  const count = questionIds.length;

  return (
    <Modal open onClose={onClose} title={`Put ${count} question${count === 1 ? '' : 's'} on a test`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        {tests === null ? (
          <PageLoader label="Loading tests" />
        ) : (
          <>
            <div className="flex gap-2">
              <button
                type="button"
                className={mode === 'existing' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => setMode('existing')}
                disabled={tests.length === 0}
              >
                An existing test
              </button>
              <button
                type="button"
                className={mode === 'new' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => setMode('new')}
              >
                A new test
              </button>
            </div>

            {mode === 'existing' ? (
              tests.length === 0 ? (
                <Alert tone="info">
                  There is no test that can still take questions. Papers students have already attempted are locked, so
                  make a new one.
                </Alert>
              ) : (
                <Field label="Test">
                  <select className="input" value={testId} onChange={(e) => setTestId(e.target.value)}>
                    {tests.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.publicId} · {t.title} — {t.subject} · {t._count.questions} question
                        {t._count.questions === 1 ? '' : 's'}
                        {t.status === 'PUBLISHED' ? ' · live' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )
            ) : (
              <>
                <Field label="Title" required>
                  <input
                    className="input"
                    value={form.title}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                    placeholder="Science — Unit 1"
                    required
                    autoFocus
                  />
                </Field>

                <Field label="Subject" required hint="Prefilled from the questions you picked.">
                  <input
                    className="input"
                    value={form.subject}
                    onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                    required
                  />
                </Field>

                <div className="grid grid-cols-3 gap-3">
                  <Field label="Duration (min)">
                    <input
                      type="number"
                      min={1}
                      className="input"
                      value={form.durationMinutes}
                      onChange={(e) => setForm((f) => ({ ...f, durationMinutes: Number(e.target.value) }))}
                    />
                  </Field>
                  <Field label="Marks / question">
                    <input
                      type="number"
                      min={0.25}
                      step={0.25}
                      className="input"
                      value={form.marksPerQuestion}
                      onChange={(e) => setForm((f) => ({ ...f, marksPerQuestion: Number(e.target.value) }))}
                    />
                  </Field>
                  <Field label="Negative marks">
                    <input
                      type="number"
                      min={0}
                      step={0.25}
                      className="input"
                      value={form.negativeMarks}
                      onChange={(e) => setForm((f) => ({ ...f, negativeMarks: Number(e.target.value) }))}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Grades" hint="Comma separated. Empty = everyone.">
                    <input
                      className="input"
                      value={form.targetGrades}
                      onChange={(e) => setForm((f) => ({ ...f, targetGrades: e.target.value }))}
                      placeholder="8, 9"
                    />
                  </Field>
                  <Field label="Divisions" hint="Comma separated. Empty = everyone.">
                    <input
                      className="input"
                      value={form.targetDivisions}
                      onChange={(e) => setForm((f) => ({ ...f, targetDivisions: e.target.value }))}
                      placeholder="A, B"
                    />
                  </Field>
                </div>

                <p className="text-[11px] text-ink-faint">
                  It is created as a draft. You will land on the builder, where you can set the timing, the daily
                  window and everything else before publishing.
                </p>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={busy || (mode === 'existing' && !testId)}>
                {busy ? 'Adding…' : mode === 'existing' ? `Add ${count}` : `Create and add ${count}`}
              </button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
