import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Modal, PageLoader, Spinner, humanizeTag } from '../../components/ui';
import { ContentRenderer, BlocksRenderer } from '../../renderers/BlockRenderer';
import type { BankQuestion, Tag } from '../../lib/types';

/**
 * The question bank and draft review screen.
 *
 * This is where LLM output becomes a real question: the admin sees it rendered
 * exactly as a student will (maths, diagrams, charts and all), fixes anything
 * wrong, then approves it.
 */

export default function AdminQuestions() {
  const [params, setParams] = useSearchParams();
  const [questions, setQuestions] = useState<BankQuestion[]>([]);
  const [tags, setTags] = useState<{ difficulty: Tag[]; cognitive: Tag[]; skill: Tag[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<BankQuestion | null>(null);

  const status = params.get('status') ?? 'DRAFT';
  const subject = params.get('subject') ?? '';
  const runId = params.get('generationRunId') ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ pageSize: '50' });
      if (status) query.set('status', status);
      if (subject) query.set('subject', subject);
      if (runId) query.set('generationRunId', runId);

      const res = await api.get<{ questions: BankQuestion[] }>(`/api/admin/questions?${query}`);
      setQuestions(res.questions);
      setSelected(new Set());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load questions.');
    } finally {
      setLoading(false);
    }
  }, [status, subject, runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .get<{ tags: { difficulty: Tag[]; cognitive: Tag[]; skill: Tag[] } }>('/api/admin/generation/context')
      .then((res) => setTags(res.tags))
      .catch(() => undefined);
  }, []);

  const setStatus = async (ids: string[], next: 'APPROVED' | 'REJECTED' | 'DRAFT') => {
    if (ids.length === 0) return;
    try {
      const res = await api.post<{ updated: number }>('/api/admin/questions/bulk-status', { ids, status: next });
      setNotice(`${res.updated} question${res.updated === 1 ? '' : 's'} marked ${next.toLowerCase()}.`);
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
          <select
            className="input w-auto text-xs py-1.5"
            value={status}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set('status', e.target.value);
              setParams(next);
            }}
          >
            <option value="DRAFT">Drafts awaiting review</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
          </select>

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

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {selected.size > 0 && (
        <div className="sticky top-[104px] z-20 card px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-pop">
          <span className="text-sm">{selected.size} selected</span>
          <div className="flex gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={() => setStatus([...selected], 'APPROVED')}>
              Approve
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setStatus([...selected], 'REJECTED')}>
              Reject
            </button>
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
            title={status === 'DRAFT' ? 'No drafts awaiting review' : `No ${status.toLowerCase()} questions`}
            hint={status === 'DRAFT' ? 'Generate questions from the "Set test" screen to see them here.' : undefined}
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
              />
            ))}
          </ul>
        </>
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
  question, index, selected, onToggle, onEdit, onStatus,
}: {
  question: BankQuestion;
  index: number;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onStatus: (status: 'APPROVED' | 'REJECTED' | 'DRAFT') => void;
}) {
  const [showAnswer, setShowAnswer] = useState(false);

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

          {showAnswer && question.format === 'NUMERIC' && (
            <p className="mt-2 text-sm">
              <span className="text-xs text-ink-muted">Answer: </span>
              <span className="font-mono text-good">
                {String(question.answerKey?.value)}
                {question.answerKey?.tolerance ? ` ± ${question.answerKey.tolerance}` : ''}
                {question.answerKey?.unit ? ` ${question.answerKey.unit}` : ''}
              </span>
            </p>
          )}

          {showAnswer && question.format === 'TRUE_FALSE' && (
            <p className="mt-2 text-sm">
              <span className="text-xs text-ink-muted">Answer: </span>
              <span className="text-good">{question.answerKey?.value ? 'True' : 'False'}</span>
            </p>
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
              <button type="button" className="btn-primary btn-sm" onClick={() => onStatus('APPROVED')}>
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
              {question.topic ? ` · ${question.topic}` : ''}
              {question.sourceModel ? ` · ${question.sourceModel}` : ''}
            </span>
          </div>
        </div>
      </div>
    </li>
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
