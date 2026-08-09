/**
 * How a paper behaves while a student sits it: shuffling, what they see
 * afterwards, and whether it is proctored.
 *
 * Shared between the "New test" form and the test builder deliberately. These
 * used to live only on the create form, which meant they could be chosen once
 * and never changed - and the question bank's own "create a test" dialog
 * promised the builder covered "everything else before publishing", which was
 * not true of these. One component, so the two screens cannot drift apart and
 * so the wording explaining what proctoring does not do is written once.
 */

export interface ExamRules {
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  showAnswersAfter: boolean;
  proctored: boolean;
  proctorAllowance: number;
  proctorFullscreen: boolean;
}

export const DEFAULT_EXAM_RULES: ExamRules = {
  shuffleQuestions: true,
  shuffleOptions: true,
  showAnswersAfter: true,
  proctored: false,
  proctorAllowance: 3,
  proctorFullscreen: true,
};

/** The shape a test comes back from the API in, as far as this cares. */
export interface TestWithRules {
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  showAnswersAfter: boolean;
  meta?: { proctoring?: { enabled?: boolean; allowance?: number; requireFullscreen?: boolean } } | null;
}

export function rulesFromTest(test: TestWithRules): ExamRules {
  const p = test.meta?.proctoring;
  return {
    shuffleQuestions: test.shuffleQuestions,
    shuffleOptions: test.shuffleOptions,
    showAnswersAfter: test.showAnswersAfter,
    proctored: p?.enabled === true,
    proctorAllowance: p?.allowance ?? DEFAULT_EXAM_RULES.proctorAllowance,
    proctorFullscreen: p?.requireFullscreen ?? DEFAULT_EXAM_RULES.proctorFullscreen,
  };
}

/** The request body, for both POST /tests and PATCH /tests/:id. */
export function rulesToBody(rules: ExamRules) {
  return {
    shuffleQuestions: rules.shuffleQuestions,
    shuffleOptions: rules.shuffleOptions,
    showAnswersAfter: rules.showAnswersAfter,
    proctoring: {
      enabled: rules.proctored,
      allowance: rules.proctorAllowance,
      requireFullscreen: rules.proctorFullscreen,
    },
  };
}

/** One line for the collapsed view, saying what is actually in force. */
export function describeExamRules(rules: ExamRules): string {
  const shuffle =
    rules.shuffleQuestions && rules.shuffleOptions ? 'Questions and options shuffled'
    : rules.shuffleQuestions ? 'Questions shuffled, options in order'
    : rules.shuffleOptions ? 'Options shuffled, questions in order'
    : 'Same order for everyone';

  const proctor = rules.proctored
    ? `Proctored — ${rules.proctorAllowance} departure${rules.proctorAllowance === 1 ? '' : 's'} allowed` +
      (rules.proctorFullscreen ? ', fullscreen required' : '')
    : 'Not proctored';

  const answers = rules.showAnswersAfter ? 'Answers shown once released' : 'Answers never shown';

  return `${shuffle}. ${proctor}. ${answers}.`;
}

export function ExamRulesEditor({
  value, onChange,
}: {
  value: ExamRules;
  onChange: (next: ExamRules) => void;
}) {
  const set = <K extends keyof ExamRules>(key: K, next: ExamRules[K]) => onChange({ ...value, [key]: next });

  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-2 gap-2 text-sm">
        {([
          ['shuffleQuestions', 'Shuffle question order'],
          ['shuffleOptions', 'Shuffle option order'],
          ['showAnswersAfter', 'Show correct answers once released'],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-series-1"
              checked={value[key]}
              onChange={(e) => set(key, e.target.checked)}
            />
            <span className="text-ink-muted">{label}</span>
          </label>
        ))}
      </div>

      <p className="text-[11px] text-ink-faint">
        Shuffling makes it harder to copy from the next desk. Turn it off for a paper whose questions build on each
        other, or one you want every student to sit in the same order.
      </p>

      <div className="pt-3 border-t border-line space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-series-1"
            checked={value.proctored}
            onChange={(e) => set('proctored', e.target.checked)}
          />
          <span>Proctored exam</span>
        </label>

        {value.proctored && (
          <div className="pl-6 space-y-2">
            <p className="text-xs text-ink-muted">
              Records when a student leaves the paper — another tab, another app, or leaving fullscreen — and
              submits automatically once the allowance is used up. It cannot see a second device, a phone, or notes
              on the desk, so it is a deterrent and a record, not a substitute for invigilation.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <span className="text-ink-muted">Allowed departures</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="input w-20"
                  value={value.proctorAllowance}
                  onChange={(e) => set('proctorAllowance', Number(e.target.value) || 1)}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="accent-series-1"
                  checked={value.proctorFullscreen}
                  onChange={(e) => set('proctorFullscreen', e.target.checked)}
                />
                <span className="text-ink-muted">Leaving fullscreen counts too</span>
              </label>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
