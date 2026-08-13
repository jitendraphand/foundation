import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageLoader, Spinner, Tabs, formatDate } from '../../components/ui';
import type { Tag } from '../../lib/types';

type SettingsTab = 'school' | 'providers' | 'prompts' | 'tags' | 'classes' | 'audit';

export default function AdminSettings() {
  const [tab, setTab] = useState<SettingsTab>('school');

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Tabs
        tabs={[
          { id: 'school', label: 'School' },
          { id: 'providers', label: 'LLM providers' },
          { id: 'prompts', label: 'Prompts' },
          { id: 'tags', label: 'Tags' },
          { id: 'classes', label: 'Grades & divisions' },
          { id: 'audit', label: 'Activity log' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'school' && <SchoolSettings />}
      {tab === 'providers' && <Providers />}
      {tab === 'prompts' && <Prompts />}
      {tab === 'tags' && <Tags />}
      {tab === 'classes' && <Classes />}
      {tab === 'audit' && <AuditLog />}
    </div>
  );
}

// --- School ----------------------------------------------------------------

/**
 * The school's timezone. Every daily availability window on every test is
 * wall-clock time in this zone; the server itself runs UTC, so getting this
 * wrong shifts every window by the offset.
 */
function SchoolSettings() {
  const [data, setData] = useState<{ timezone: string; common: string[]; localTimeNow: string; serverTimeUtc: string } | null>(null);
  const [timezone, setTimezone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ timezone: string; common: string[]; localTimeNow: string; serverTimeUtc: string }>('/api/admin/timezone');
      setData(res);
      setTimezone(res.timezone);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the school settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ message: string }>('/api/admin/timezone', { timezone: timezone.trim() });
      setNotice(res.message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the timezone.');
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <PageLoader label="Loading" />;

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <Card title="Timezone">
        <p className="text-xs text-ink-muted mb-3">
          Used for every daily availability window - &ldquo;only during school hours&rdquo;, &ldquo;paused overnight&rdquo;
          and so on. The server runs in UTC, so this is what makes 8am mean your 8am.
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="School timezone">
            <input
              className="input font-mono text-xs"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              list="tz-list"
              placeholder="Asia/Kolkata"
            />
            <datalist id="tz-list">
              {data.common.map((tz) => <option key={tz} value={tz} />)}
            </datalist>
          </Field>

          <div>
            <span className="label">Right now</span>
            <p className="text-sm">
              <span className="font-medium">{data.localTimeNow}</span>
              <span className="text-ink-muted"> in {data.timezone}</span>
            </p>
            <p className="text-[11px] text-ink-faint mt-0.5">
              Server clock: {new Date(data.serverTimeUtc).toISOString().slice(11, 16)} UTC
            </p>
          </div>
        </div>

        <div className="flex justify-end mt-3">
          <button type="button" className="btn-primary btn-sm" onClick={save} disabled={busy || timezone.trim() === data.timezone}>
            {busy ? <Spinner label="Saving" /> : 'Save timezone'}
          </button>
        </div>
      </Card>
    </div>
  );
}

// --- Providers -------------------------------------------------------------

interface Credential {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  keyHint: string;
  defaultModel: string | null;
  isActive: boolean;
  createdAt: string;
  /**
   * Whatever the provider needed beyond a key - region, auth mode, project,
   * API version. Never holds anything secret.
   */
  meta?: {
    region?: string;
    authMode?: 'apiKey' | 'sigv4';
    projectId?: string;
    apiVersion?: string;
    useAsFallback?: boolean;
    /** An administrator's explicit ceiling on one reply's length. */
    maxOutputTokens?: number;
    /** What each model was observed to refuse above, learned from a refusal. */
    tokenCeilings?: Record<string, number>;
    /** Per-model request settings; see the server's llm/tuning.ts. */
    tuning?: ModelTuning;
  } | null;
  /** Resolved server-side from the ticks and what the provider can do. */
  capabilities: { text: boolean; images: boolean };
  /**
   * Whether the Images tick can be offered at all: "no" means the provider
   * draws through an API this system does not speak, so ticking it is refused.
   */
  imageSupport: 'yes' | 'maybe' | 'no';
}

/**
 * The cloud providers are configured per region or per resource, and a model
 * enabled in one is not enabled in another - so that detail is what tells two
 * otherwise identical credentials apart, and it belongs on the row.
 */
function describeProvider(credential: Credential, providers: ProviderDef[]): string {
  const name = providers.find((p) => p.id === credential.provider)?.label ?? credential.provider;
  const meta = credential.meta;

  if (credential.provider === 'bedrock' && meta?.region) {
    return `${name} · ${meta.region} · ${meta.authMode === 'sigv4' ? 'IAM' : 'API key'}`;
  }
  if (credential.provider === 'vertex' && meta?.projectId) {
    return `${name} · ${meta.projectId} · ${meta.region ?? ''}`.trim();
  }
  if (credential.provider === 'oci' && meta?.region) {
    return `${name} · ${meta.region}`;
  }
  if (credential.provider === 'azure') {
    // The resource name is the hostname, which is the identifying part.
    const host = (() => {
      try {
        return new URL(credential.baseUrl).hostname.split('.')[0];
      } catch {
        return '';
      }
    })();
    return host ? `${name} · ${host}` : name;
  }
  return name;
}

/** One row of the all-providers health check. */
interface HealthRow {
  id: string;
  label: string;
  provider: string;
  model: string | null;
  ok: boolean;
  latencyMs: number | null;
  message: string;
  useAsFallback: boolean;
}

/**
 * The per-model knobs. Everything build.nvidia.com's snippets differ by, as
 * settings rather than as code - see the server's llm/tuning.ts for why this
 * is emphatically not a box you paste Python into.
 */
interface ModelTuning {
  extraBody?: Record<string, unknown>;
  temperature?: number;
  topP?: number;
  seed?: number;
  stream?: boolean;
  thinking?: 'auto' | 'yes' | 'no';
  jsonMode?: 'auto' | 'on' | 'off';
}

/** What a real two-question trial reported. */
interface TrialResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  firstTokenMs?: number;
  streamed?: boolean;
  parsed: number;
  reasoningChars?: number;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  sample?: string;
}

interface ProviderDef {
  id: string;
  label: string;
  defaultBaseUrl: string;
  docsUrl: string;
  keyUrl?: string;
  /** Shown under the model box; says what a model id looks like here. */
  modelHint?: string;
  suggestedModels: string[];
  supportsJsonMode: boolean;
}

function Providers() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [providers, setProviders] = useState<ProviderDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [tuningFor, setTuningFor] = useState<string | null>(null);
  const [trialling, setTrialling] = useState<string | null>(null);
  const [trials, setTrials] = useState<Record<string, TrialResult | null>>({});
  const [requestFor, setRequestFor] = useState<string | null>(null);
  const [requests, setRequests] = useState<Record<string, RequestPreviewData>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ credentials: Credential[]; providers: ProviderDef[] }>('/api/admin/credentials');
      setCredentials(res.credentials);
      setProviders(res.providers);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load providers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async (credential: Credential) => {
    setTesting(credential.id);
    setNotice(null);
    setError(null);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/api/admin/credentials/${credential.id}/test`, {});
      if (res.ok) setNotice(`${credential.label}: ${res.message}`);
      else setError(`${credential.label}: ${res.message}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The connection test failed.');
    } finally {
      setTesting(null);
    }
  };

  /**
   * Tests everything at once. The free tiers are erratic enough that "is it me
   * or is it them" is a question worth being able to answer in one click,
   * rather than by spending a generation run to find out.
   */
  const checkAll = async () => {
    setChecking(true);
    setError(null);
    try {
      const res = await api.post<{ results: HealthRow[] }>('/api/admin/credentials/health', {});
      setHealth(res.results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the providers.');
    } finally {
      setChecking(false);
    }
  };

  /**
   * The largest reply this endpoint will accept.
   *
   * Almost never needed: a provider that refuses an oversized request names its
   * real limit, and that number is remembered automatically. This is for the
   * cases where nobody is told - a self-hosted endpoint that truncates in
   * silence, or provisioned throughput whose limit differs from the published
   * one. Blank hands the decision back to what was learned.
   */
  const setMaxOutputTokens = async (credential: Credential, raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 256)) {
      setError('A reply limit has to be at least 256 tokens. Leave it blank to remove the limit.');
      return;
    }
    setError(null);
    try {
      await api.patch(`/api/admin/credentials/${credential.id}`, { maxOutputTokens: value });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that limit.');
    }
  };

  /**
   * What a credential is used for. Text, images, or both.
   *
   * Not derivable from the provider: the same key can do both, and a school may
   * hold a second key it wants used only for pictures so that spend is separate
   * on the bill.
   */
  const setCapability = async (credential: Credential, key: 'text' | 'images', on: boolean) => {
    setError(null);
    try {
      await api.patch(`/api/admin/credentials/${credential.id}`, {
        capabilities: { ...credential.capabilities, [key]: on },
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change what that credential is used for.');
    }
  };

  /**
   * A trial that actually generates.
   *
   * "Test connection" sends five words and asks for 64 tokens, which proves a
   * key works and a model is routable. It cannot say whether the model will
   * hold the whole system prompt, produce the required JSON, or finish before
   * a free tier gives up - and those are the three ways a real run fails. A
   * provider can read "up" for weeks while every generation stalls.
   */
  const runTrial = async (credential: Credential) => {
    setTrialling(credential.id);
    setTrials((prev) => ({ ...prev, [credential.id]: null }));
    try {
      const res = await api.post<TrialResult>(`/api/admin/credentials/${credential.id}/trial`, {});
      setTrials((prev) => ({ ...prev, [credential.id]: res }));
    } catch (err) {
      setTrials((prev) => ({
        ...prev,
        [credential.id]: {
          ok: false,
          parsed: 0,
          latencyMs: 0,
          message: err instanceof ApiError ? err.message : 'The trial could not be run.',
        },
      }));
    } finally {
      setTrialling(null);
    }
  };

  const setFallback = async (credential: Credential, useAsFallback: boolean) => {
    try {
      await api.patch(`/api/admin/credentials/${credential.id}`, { useAsFallback });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that setting.');
    }
  };

  /**
   * Fetch and show the real request body for one credential.
   *
   * The vendor's page shows their Python; this shows the equivalent JSON this
   * system would send, so the two can be compared line by line. That comparison
   * is what an administrator is actually trying to make when they ask why the
   * code is different for every model.
   */
  const showRequest = async (credential: Credential) => {
    if (requestFor === credential.id) {
      setRequestFor(null);
      return;
    }
    setRequestFor(credential.id);
    if (requests[credential.id]) return;
    try {
      const preview = await api.get<RequestPreviewData>(`/api/admin/credentials/${credential.id}/request`);
      setRequests((p) => ({ ...p, [credential.id]: preview }));
    } catch (err) {
      setRequests((p) => ({
        ...p,
        [credential.id]: { shown: false, model: '', note: err instanceof ApiError ? err.message : 'Could not build the request.' },
      }));
    }
  };

  const saveTuning = async (credential: Credential, tuning: ModelTuning) => {
    setError(null);
    try {
      await api.patch(`/api/admin/credentials/${credential.id}`, { tuning });
      setTuningFor(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save those settings.');
    }
  };

  const remove = async (credential: Credential) => {
    try {
      await api.delete(`/api/admin/credentials/${credential.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that credential.');
    }
  };

  if (loading) return <PageLoader label="Loading" />;

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <Card
        title="API credentials"
        action={<button type="button" className="btn-primary btn-sm" onClick={() => setAdding(true)}>Add credential</button>}
        padded={false}
      >
        {credentials.length === 0 ? (
          <EmptyState
            title="No providers configured"
            hint="Add an OpenRouter or NVIDIA API key to start generating questions."
            action={<button type="button" className="btn-primary btn-sm" onClick={() => setAdding(true)}>Add credential</button>}
          />
        ) : (
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Provider</th>
                  <th>Key</th>
                  <th>Default model</th>
                  <th className="text-center">Used for</th>
                  <th className="text-center">Fallback</th>
                  <th>Reply limit</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {credentials.map((credential) => (
                  <tr key={credential.id}>
                    <td className="font-medium">{credential.label}</td>
                    <td className="text-ink-muted">{describeProvider(credential, providers)}</td>
                    <td className="font-mono text-xs text-ink-faint">{credential.keyHint}</td>
                    <td className="font-mono text-xs text-ink-muted">{credential.defaultModel ?? '—'}</td>
                    <td>
                      <div className="flex items-center justify-center gap-3">
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            className="accent-series-1"
                            checked={credential.capabilities.text}
                            onChange={(e) => void setCapability(credential, 'text', e.target.checked)}
                          />
                          <span className="text-ink-muted">Text</span>
                        </label>
                        <label
                          className={`flex items-center gap-1.5 text-xs ${
                            credential.imageSupport === 'no' ? 'opacity-40' : 'cursor-pointer'
                          }`}
                          title={
                            credential.imageSupport === 'no'
                              ? 'This provider draws through its own API, not the OpenAI one, so it cannot be used for pictures here.'
                              : 'Offer this credential for drawing the pictures questions ask for.'
                          }
                        >
                          <input
                            type="checkbox"
                            className="accent-series-1"
                            checked={credential.capabilities.images}
                            disabled={credential.imageSupport === 'no'}
                            onChange={(e) => void setCapability(credential, 'images', e.target.checked)}
                          />
                          <span className="text-ink-muted">Images</span>
                        </label>
                      </div>
                    </td>
                    <td className="text-center">
                      <input
                        type="checkbox"
                        className="accent-series-1"
                        checked={credential.meta?.useAsFallback === true}
                        onChange={(e) => void setFallback(credential, e.target.checked)}
                        aria-label={`Use ${credential.label} as a fallback`}
                      />
                    </td>
                    <td>
                      <input
                        className="input w-24 text-xs tabular-nums"
                        type="number"
                        min={256}
                        step={256}
                        placeholder={
                          // What was learned from a refusal, when anything has
                          // been - shown as the placeholder so it reads as the
                          // value in force rather than something typed in.
                          Object.values(credential.meta?.tokenCeilings ?? {}).length
                            ? String(Math.min(...Object.values(credential.meta!.tokenCeilings!)))
                            : 'auto'
                        }
                        defaultValue={credential.meta?.maxOutputTokens ?? ''}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          const current = credential.meta?.maxOutputTokens;
                          if (next === String(current ?? '')) return;
                          void setMaxOutputTokens(credential, next);
                        }}
                        aria-label={`Largest reply ${credential.label} accepts, in tokens`}
                        title="Tokens per reply. Leave blank unless this endpoint refuses long replies without saying so."
                      />
                    </td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(credential.createdAt)}</td>
                    <td className="text-right whitespace-nowrap">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => test(credential)} disabled={testing === credential.id}>
                        {testing === credential.id ? 'Testing…' : 'Test connection'}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => void runTrial(credential)}
                        disabled={trialling === credential.id}
                        title="Ask for two real questions through the real prompt. Slower than the connection test, and the only check that proves a run would work."
                      >
                        {trialling === credential.id ? 'Generating…' : 'Try 2 questions'}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => setTuningFor(tuningFor === credential.id ? null : credential.id)}
                      >
                        {tuningFor === credential.id ? 'Close' : 'Model settings'}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => void showRequest(credential)}
                      >
                        {requestFor === credential.id ? 'Close' : 'Show the request'}
                      </button>
                      <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => remove(credential)}>Delete</button>
                    </td>
                  </tr>
                ))
                  .flatMap((row, i) => {
                    const credential = credentials[i];
                    const trial = trials[credential.id];
                    const extras = [row];

                    if (trial) {
                      extras.push(
                        <tr key={`${credential.id}-trial`}>
                          <td colSpan={9} className="bg-surface-sunken">
                            <TrialReport result={trial} onDismiss={() => setTrials((p) => ({ ...p, [credential.id]: null }))} />
                          </td>
                        </tr>,
                      );
                    }
                    if (tuningFor === credential.id) {
                      extras.push(
                        <tr key={`${credential.id}-tuning`}>
                          <td colSpan={9} className="bg-surface-sunken">
                            <ModelSettings
                              credential={credential}
                              onCancel={() => setTuningFor(null)}
                              onSave={(tuning) => void saveTuning(credential, tuning)}
                            />
                          </td>
                        </tr>,
                      );
                    }
                    if (requestFor === credential.id) {
                      extras.push(
                        <tr key={`${credential.id}-request`}>
                          <td colSpan={9} className="bg-surface-sunken">
                            <RequestPreview preview={requests[credential.id] ?? null} />
                          </td>
                        </tr>,
                      );
                    }
                    return extras;
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Check every provider"
        action={
          <button type="button" className="btn-secondary btn-sm" onClick={() => void checkAll()} disabled={checking}>
            {checking ? <Spinner label="Checking" /> : 'Check all now'}
          </button>
        }
      >
        <p className="text-xs text-ink-muted">
          Sends one tiny request to each active provider and reports whether it answered and how fast. The free tiers
          rate-limit and go down without warning, so this is the quick way to tell a broken key from a busy service.
          Anything slower than a few seconds will struggle with a long generation run.
        </p>

        {health && (
          <ul className="mt-3 divide-y divide-line text-sm">
            {health.map((row) => (
              <li key={row.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={row.ok ? 'good' : 'bad'}>{row.ok ? 'up' : 'down'}</Badge>
                <span className="font-medium">{row.label}</span>
                {row.latencyMs !== null && (
                  <span className={'tabular-nums text-xs ' + (row.latencyMs > 5000 ? 'text-warn' : 'text-ink-faint')}>
                    {row.latencyMs} ms
                  </span>
                )}
                {row.useAsFallback && <span className="badge">fallback</span>}
                <span className="text-xs text-ink-muted basis-full sm:basis-auto sm:flex-1">{row.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <StepUpSettings credentials={credentials} />
      <ImageSettings />

      <Alert tone="info">
        A provider ticked as <strong>fallback</strong> is used when the one you chose keeps refusing — rate limited,
        overloaded, or unreachable. The chosen provider is always tried first and retried before anything else is
        touched, so a fallback only ever rescues a run that would have been lost. Nothing is used as a fallback unless
        you tick it, so a free key running out cannot quietly start billing a paid one.
      </Alert>

      <Alert tone="info">
        API keys are encrypted before they are stored and are never shown in full again. If you change{' '}
        <code className="font-mono">ENCRYPTION_KEY</code> in <code className="font-mono">.env</code>, saved keys can no
        longer be decrypted and must be re-entered.
      </Alert>

      {adding && (
        <AddCredentialModal
          providers={providers}
          onClose={() => setAdding(false)}
          onAdded={async (warning) => {
            setAdding(false);
            setNotice(warning ?? 'Credential saved. Use "Test connection" to check it works.');
            await load();
          }}
        />
      )}
    </div>
  );
}

function AddCredentialModal({ providers, onClose, onAdded }: { providers: ProviderDef[]; onClose: () => void; onAdded: (warning?: string) => void }) {
  const [provider, setProvider] = useState(providers[0]?.id ?? 'openrouter');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  // Bedrock only.
  const [region, setRegion] = useState('us-east-1');
  const [awsAuthMode, setAwsAuthMode] = useState<'apiKey' | 'sigv4'>('apiKey');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  // Azure only.
  const [resourceName, setResourceName] = useState('');
  const [apiVersion, setApiVersion] = useState('2024-10-21');
  // Oracle Cloud only.
  const [tenancyId, setTenancyId] = useState('');
  const [userId, setUserId] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [compartmentId, setCompartmentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const def = providers.find((p) => p.id === provider);
  const isBedrock = provider === 'bedrock';
  const isAzure = provider === 'azure';
  const isVertex = provider === 'vertex';
  const isOci = provider === 'oci';
  // Bedrock, Azure and Vertex all derive their endpoint from something else -
  // a region, a resource, a project - so none of them shows a base URL box.
  const derivesEndpoint = isBedrock || isAzure || isVertex || isOci;

  // What the label box was last filled in with on the admin's behalf. Changing
  // provider should move a label nobody has touched along with it - otherwise
  // picking Bedrock after the default OpenAI saves a credential called
  // "OpenAI" - but must never overwrite one that was typed.
  const autoLabel = useRef('');

  useEffect(() => {
    setBaseUrl(def?.defaultBaseUrl ?? '');
    setDefaultModel(def?.suggestedModels[0] ?? '');

    // Both reads happen here rather than inside the updater: React may call an
    // updater more than once, so it has to be a pure function of values fixed
    // before it runs.
    const previous = autoLabel.current;
    const next = def?.label ?? '';
    autoLabel.current = next;
    setLabel((current) => (current && current !== previous ? current : next));

    // AWS and Google name their regions differently, so carrying us-east-1
    // across to Vertex would offer a region that does not exist there.
    setRegion((current) =>
      provider === 'oci'
        ? (current && /^[a-z]{2}-[a-z]+-\d$/.test(current) && current !== 'us-east-1' ? current : 'us-chicago-1')
        : provider === 'vertex'
        ? (current && !/^[a-z]{2}-[a-z]+-\d$/.test(current) ? current : 'us-central1')
        : provider === 'bedrock'
          ? (current && !/^[a-z]+-[a-z]+\d$/.test(current) ? current : 'us-east-1')
          : current,
    );
  }, [provider, def]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ warning?: string }>('/api/admin/credentials', {
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
        // Bedrock derives its endpoint from the region, and the box is hidden.
        // Sending the stale default would override that derivation and point
        // every request at us-east-1 whatever region was chosen.
        baseUrl: derivesEndpoint ? undefined : baseUrl.trim() || undefined,
        defaultModel: defaultModel.trim() || undefined,
        ...(isBedrock
          ? {
              region: region.trim(),
              awsAuthMode,
              ...(awsAuthMode === 'sigv4'
                ? { accessKeyId: accessKeyId.trim(), sessionToken: sessionToken.trim() || undefined }
                : {}),
            }
          : {}),
        ...(isAzure ? { resourceName: resourceName.trim(), apiVersion: apiVersion.trim() } : {}),
        ...(isVertex ? { region: region.trim() } : {}),
        ...(isOci
          ? {
              region: region.trim(),
              tenancyId: tenancyId.trim(),
              userId: userId.trim(),
              fingerprint: fingerprint.trim(),
              compartmentId: compartmentId.trim() || undefined,
            }
          : {}),
      });
      onAdded(res.warning);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that credential.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Add an API credential">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <Field label="Provider" required>
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>

        <Field label="Label" required hint="Just for you, so you can tell several keys apart.">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>

        {isBedrock && (
          <Field
            label="How to authenticate"
            hint={
              awsAuthMode === 'apiKey'
                ? 'Bedrock > API keys in the AWS console. Simplest, and what to use unless your account forbids long-lived keys.'
                : 'An IAM user or role with bedrock:InvokeModel. Each request is signed; nothing long-lived is sent.'
            }
          >
            <select className="input" value={awsAuthMode} onChange={(e) => setAwsAuthMode(e.target.value as 'apiKey' | 'sigv4')}>
              <option value="apiKey">Bedrock API key (recommended)</option>
              <option value="sigv4">AWS access key and secret</option>
            </select>
          </Field>
        )}

        {isBedrock && awsAuthMode === 'sigv4' && (
          <>
            <Field label="Access key ID" required hint="The shorter one, starting AKIA or ASIA.">
              <input
                className="input font-mono text-xs"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                placeholder="AKIA…"
                required
                autoComplete="off"
              />
            </Field>
            <Field label="Session token" hint="Only for temporary credentials from STS. Leave empty for a normal IAM user.">
              <input
                className="input font-mono text-xs"
                type="password"
                value={sessionToken}
                onChange={(e) => setSessionToken(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </>
        )}

        {isAzure && (
          <>
            <Field
              label="Resource name or endpoint"
              required
              hint='The bit before .openai.azure.com, or paste the whole "Endpoint" URL from the resource overview in the portal.'
            >
              <input
                className="input font-mono text-xs"
                value={resourceName}
                onChange={(e) => setResourceName(e.target.value)}
                placeholder="my-school-openai"
                required
              />
            </Field>
            <Field label="API version" hint="Azure pins its API surface to a date. Leave this unless your resource is older.">
              <input
                className="input font-mono text-xs"
                value={apiVersion}
                onChange={(e) => setApiVersion(e.target.value)}
                placeholder="2024-10-21"
              />
            </Field>
          </>
        )}

        {isOci && (
          <>
            <p className="text-xs text-ink-muted -mb-1">
              All four values below are on the API key page in the Oracle Cloud console, and in the configuration
              snippet it offers to generate there. None of them is secret — only the private key is.
            </p>
            <Field label="Tenancy OCID" required>
              <input className="input font-mono text-[11px]" value={tenancyId} onChange={(e) => setTenancyId(e.target.value)} placeholder="ocid1.tenancy.oc1..&hellip;" required />
            </Field>
            <Field label="User OCID" required>
              <input className="input font-mono text-[11px]" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="ocid1.user.oc1..&hellip;" required />
            </Field>
            <Field label="Key fingerprint" required hint="Shown beside the API key: sixteen pairs of hex digits.">
              <input className="input font-mono text-[11px]" value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} placeholder="20:3b:97:&hellip;" required />
            </Field>
            <Field label="Compartment OCID" hint="Which compartment to bill and scope the call to. Leave empty to use the tenancy root.">
              <input className="input font-mono text-[11px]" value={compartmentId} onChange={(e) => setCompartmentId(e.target.value)} placeholder="ocid1.compartment.oc1..&hellip;" />
            </Field>
          </>
        )}

        <Field
          label={
            isBedrock ? (awsAuthMode === 'sigv4' ? 'Secret access key' : 'Bedrock API key')
            : isAzure ? 'Azure API key'
            : isVertex ? 'Service account JSON'
            : isOci ? 'Private key (PEM)'
            : 'API key'
          }
          required
          hint={
            isBedrock
              ? awsAuthMode === 'sigv4'
                ? 'Shown once when the access key is created. Encrypted before it is stored.'
                : 'Copy it when you generate it in the Bedrock console — it is shown in full only that once. Encrypted before it is stored.'
              : isAzure
                ? 'Either of the two keys on the resource, under Keys and Endpoint. Encrypted before it is stored.'
                : isVertex
                  ? 'Paste the whole JSON key file you downloaded from IAM & Admin → Service Accounts → Keys, ' +
                    'braces and all. The project is read out of the file. Encrypted before it is stored.'
                  : isOci
                    ? 'The .pem file downloaded when you created the API key, starting with -----BEGIN. ' +
                      'It must not be passphrase-protected. Encrypted before it is stored.'
                  : 'Paste the whole key. Providers show it in full only once, then display a shortened version ' +
                    'like sk-or-v1-… — that shortened form is not a key and will not work. Encrypted before it is stored.'
          }
        >
          {/* The service-account file is far too long for a single line, and
              an admin needs to see they pasted the whole thing. */}
          {isVertex || isOci ? (
            <textarea
              className="input font-mono text-[11px] h-32"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isOci ? '-----BEGIN PRIVATE KEY-----\n...' : '{ "type": "service_account", "project_id": "...", ... }'}
              required
              autoComplete="off"
            />
          ) : (
            <input className="input font-mono text-xs" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required minLength={8} autoComplete="off" />
          )}
        </Field>

        {isBedrock || isVertex || isOci ? (
          <Field
            label="Region"
            required
            hint={
              isVertex
                ? 'Vertex is regional and models are enabled per region, e.g. us-central1 or europe-west4.'
                : isOci
                  ? 'Oracle regions look like us-chicago-1 or eu-frankfurt-1, and models are available in some only.'
                  : 'Bedrock has a separate endpoint in every region, and models are enabled per region. Use the one where you turned the model on.'
            }
          >
            <input
              className="input font-mono text-xs"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder={isVertex ? 'us-central1' : isOci ? 'us-chicago-1' : 'us-east-1'}
              required
            />
          </Field>
        ) : isAzure ? null : (
          <Field label="Base URL" required={provider === 'custom'}>
            <input className="input font-mono text-xs" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" />
          </Field>
        )}

        <Field label="Default model" hint={def?.modelHint}>
          <input className="input font-mono text-xs" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} list="provider-models" />
          <datalist id="provider-models">
            {def?.suggestedModels.map((m) => <option key={m} value={m} />)}
          </datalist>
        </Field>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? <Spinner label="Saving" /> : 'Save credential'}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Which provider answers a student pressing "5 more like this".
 *
 * Separate from the credential papers are set with, on purpose: Step-up is
 * triggered by students, several times a day across a class, so a school will
 * usually want it pointed somewhere cheap even when papers use the best model
 * they have. Leaving it unset switches the feature off rather than falling
 * back to an expensive default nobody chose.
 */
function StepUpSettings({ credentials }: { credentials: Credential[] }) {
  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState('');
  const [dailyQuota, setDailyQuota] = useState('5');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ config: { credentialId: string; model?: string; dailyQuota?: number } | null }>('/api/admin/step-up')
      .then((res) => {
        setCredentialId(res.config?.credentialId ?? '');
        setModel(res.config?.model ?? '');
        setDailyQuota(String(res.config?.dailyQuota ?? 5));
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ message: string }>('/api/admin/step-up', {
        credentialId: credentialId || null,
        model: model.trim() || undefined,
        dailyQuota: Number(dailyQuota) || 0,
      });
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  const chosen = credentials.find((c) => c.id === credentialId);

  return (
    <Card title="Step-up tests">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <p className="text-xs text-ink-muted mb-3">
        When a student reviews a result, each question offers them five more like it, or five building up to it,
        generated on the spot and marked straight away. Choose which provider answers those. Students trigger this
        themselves, so point it at something cheap; leave it as &ldquo;off&rdquo; and the buttons do not appear.
      </p>

      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Provider">
          <select className="input" value={credentialId} onChange={(e) => { setCredentialId(e.target.value); setModel(''); }}>
            <option value="">Off — students see no Step-up buttons</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Model" hint={chosen?.defaultModel ? `Leave empty to use ${chosen.defaultModel}.` : undefined}>
          <input
            className="input font-mono text-xs"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={chosen?.defaultModel ?? ''}
            disabled={!credentialId}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field
          label="Each student may build"
          hint={
            Number(dailyQuota) > 0
              ? 'Per student, per day, counted from midnight in the school timezone. Students are told how many they have left.'
              : 'No limit. A class of thirty pressing this all afternoon is a real bill — set a number unless you are watching it.'
          }
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              className="input w-24"
              value={dailyQuota}
              onChange={(e) => setDailyQuota(e.target.value)}
              disabled={!credentialId}
            />
            <span className="text-sm text-ink-muted">
              {Number(dailyQuota) > 0 ? 'a day' : 'as many as they like'}
            </span>
          </div>
        </Field>
      </div>

      <div className="flex justify-end mt-3">
        <button type="button" className="btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner label="Saving" /> : 'Save'}
        </button>
      </div>
    </Card>
  );
}

/**
 * Which provider draws the pictures a question asks for.
 *
 * Only OpenAI and Azure are offered, because they are the two that share the
 * /images/generations shape. Bedrock, Vertex and Oracle each have their own
 * image API; listing them here and failing at the point of use would be worse
 * than not listing them.
 */
function ImageSettings() {
  const [credentials, setCredentials] = useState<Array<{ id: string; label: string; provider: string }>>([]);
  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState('gpt-image-1');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ config: { credentialId: string; model?: string } | null; credentials: Array<{ id: string; label: string; provider: string }> }>(
        '/api/admin/image-provider',
      )
      .then((res) => {
        setCredentials(res.credentials);
        setCredentialId(res.config?.credentialId ?? '');
        setModel(res.config?.model ?? 'gpt-image-1');
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.put<{ message: string }>('/api/admin/image-provider', {
        credentialId: credentialId || null,
        model: model.trim() || undefined,
      });
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Image generation">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <p className="text-xs text-ink-muted mb-3">
        None of the question models can draw, so a question needing a photograph carries a written prompt instead.
        Set a provider here and that prompt turns into a &ldquo;Generate the picture&rdquo; button in the review
        screen. Leave it off and pictures are made elsewhere and uploaded, exactly as before.
      </p>

      {credentials.length === 0 ? (
        <Alert tone="info">
          No credential is ticked for <strong>Images</strong> yet. Tick it beside a credential in the table above and
          it will appear here. OpenAI and Azure OpenAI are ticked from the start; the OpenAI-compatible routers can
          be ticked and will work if your account and model offer an image endpoint. Amazon Bedrock, Vertex AI and
          Oracle Cloud draw through their own APIs, which this system does not speak, so their tick is greyed out.
        </Alert>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Provider">
              <select className="input" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                <option value="">Off — upload pictures by hand</option>
                {credentials.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Image model" hint="gpt-image-1 on OpenAI; on Azure this is the deployment name.">
              <input
                className="input font-mono text-xs"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-image-1"
                disabled={!credentialId}
              />
            </Field>
          </div>
          <div className="flex justify-end mt-3">
            <button type="button" className="btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
              {busy ? <Spinner label="Saving" /> : 'Save'}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

// --- Prompts ---------------------------------------------------------------

interface Template {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  userTemplate: string;
  /** Which generator uses it. STEP_UP papers are stored as practice tests. */
  kind: 'REGULAR' | 'PRACTICE' | 'STEP_UP';
  isDefault: boolean;
  isActive: boolean;
  version: number;
}

function Prompts() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Template | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ templates: Template[] }>('/api/admin/prompts');
      setTemplates(res.templates.filter((t) => t.isActive));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load prompts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <PageLoader label="Loading" />;

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <p className="text-xs text-ink-muted">
        The system prompt defines the strict JSON reply format, the block types for maths and diagrams, and the tag
        vocabulary. Past generation runs keep their own frozen copy, so editing here never rewrites history.
      </p>

      <ul className="space-y-3">
        {templates.map((template) => (
          <li key={template.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-medium">
                  {template.name}
                  {template.isDefault && <Badge tone="info">default</Badge>}
                  <Badge>{template.kind.toLowerCase().replace('_', '-')}</Badge>
                  <span className="ml-2 text-[11px] text-ink-faint">v{template.version}</span>
                </h3>
                {template.description && <p className="text-xs text-ink-muted mt-1">{template.description}</p>}
              </div>
              <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setEditing(template)}>Edit</button>
            </div>
            <pre className="mt-3 max-h-28 overflow-y-auto scroll-x rounded-lg bg-surface-sunken border border-line p-2 text-[11px] font-mono whitespace-pre-wrap text-ink-muted">
              {template.systemPrompt.slice(0, 500)}…
            </pre>
          </li>
        ))}
      </ul>

      {editing && (
        <EditPromptModal
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </div>
  );
}

function EditPromptModal({ template, onClose, onSaved }: { template: Template; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template.name);
  const [systemPrompt, setSystemPrompt] = useState(template.systemPrompt);
  const [userTemplate, setUserTemplate] = useState(template.userTemplate);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/admin/prompts/${template.id}`, { name, systemPrompt, userTemplate });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit "${template.name}"`} wide>
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>

        <Field label="System prompt" hint="Defines the reply contract. Keep the JSON schema section intact or generation will fail.">
          <textarea className="input font-mono text-[11px]" rows={18} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} spellCheck={false} />
        </Field>

        {/* The placeholders differ by generator: Step-up is handed one
            existing question and the mode the student chose, not a spec. */}
        <Field
          label="User message template"
          hint={
            template.kind === 'STEP_UP'
              ? 'Placeholders: {{modeInstructions}} — “more like this” or “build up to it”, whichever the student ' +
                'chose; {{source}} — the original question with its options and tags; {{count}} — how many to write.'
              : 'Placeholders: {{count}} {{subject}} {{topic}} {{subtopic}} {{grade}} {{marksPerQuestion}} ' +
                '{{difficultyMix}} {{cognitiveMix}} {{formats}} {{skillFocus}} {{extraInstructions}}'
          }
        >
          <textarea className="input font-mono text-[11px]" rows={8} value={userTemplate} onChange={(e) => setUserTemplate(e.target.value)} spellCheck={false} />
        </Field>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

// --- Tags ------------------------------------------------------------------

/**
 * What a real two-question trial found.
 *
 * Reported in more detail than the ping deliberately: when a run is going to
 * fail, the useful information is *how* - nothing arrived, or plenty arrived
 * and none of it was the required format, or it arrived and was cut off. Those
 * three need three different fixes and the old check could not tell them apart.
 */
function TrialReport({ result, onDismiss }: { result: TrialResult; onDismiss: () => void }) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-start gap-2">
        <Badge tone={result.ok ? 'good' : 'bad'}>{result.ok ? 'generated' : 'failed'}</Badge>
        <p className="text-xs text-ink-muted flex-1">{result.message}</p>
        <button type="button" className="btn-ghost btn-sm" onClick={onDismiss}>Dismiss</button>
      </div>

      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-ink-muted">
        <div><dt className="inline font-medium">Took: </dt><dd className="inline tabular-nums">{seconds(result.latencyMs)}</dd></div>
        {result.firstTokenMs !== undefined && (
          <div>
            <dt className="inline font-medium">First words after: </dt>
            <dd className="inline tabular-nums">{seconds(result.firstTokenMs)}</dd>
          </div>
        )}
        <div><dt className="inline font-medium">Streamed: </dt><dd className="inline">{result.streamed ? 'yes' : 'no'}</dd></div>
        {result.finishReason && (
          <div><dt className="inline font-medium">Stopped because: </dt><dd className="inline">{result.finishReason}</dd></div>
        )}
        {result.completionTokens !== undefined && (
          <div><dt className="inline font-medium">Reply tokens: </dt><dd className="inline tabular-nums">{result.completionTokens}</dd></div>
        )}
        {/* The number that explains an "empty" answer: a model can spend
            thousands of characters thinking and never start writing. */}
        {result.reasoningChars ? (
          <div>
            <dt className="inline font-medium">Thought first: </dt>
            <dd className="inline tabular-nums">{result.reasoningChars} characters</dd>
          </div>
        ) : null}
      </dl>

      {result.sample && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-muted">What it actually sent back</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-white p-2 text-[11px] whitespace-pre-wrap break-words">
            {result.sample}
          </pre>
        </details>
      )}
    </div>
  );
}

interface RequestPreviewData {
  model: string;
  shown: boolean;
  note?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  streaming?: boolean;
}

/**
 * The request this credential actually sends.
 *
 * This exists to answer one question directly: "the vendor's page shows
 * different code for every model - what does mine send?". Prose cannot answer
 * it; the body can. It is built by the same function the real call uses, so it
 * cannot drift into being a flattering description of what we wish we sent.
 *
 * The key is never in it. This is the panel most likely to be screenshotted
 * into a support thread.
 */
function RequestPreview({ preview }: { preview: RequestPreviewData | null }) {
  if (!preview) {
    return <div className="p-3"><Spinner label="Building the request" /></div>;
  }

  if (!preview.shown) {
    return (
      <div className="p-3">
        <p className="text-xs text-ink-muted">{preview.note}</p>
      </div>
    );
  }

  const curl = [
    `curl ${preview.url} \\`,
    ...Object.entries(preview.headers ?? {}).map(([k, v]) => `  -H '${k}: ${v}' \\`),
    `  -d '${JSON.stringify(preview.body)}'`,
  ].join('\n');

  return (
    <div className="p-3 space-y-3">
      <div>
        <h4 className="text-xs font-semibold">What this credential sends</h4>
        <p className="text-[11px] text-ink-faint mt-0.5">
          The real request for <code>{preview.model}</code>, assembled by the same code that makes the call.
          Compare it with the vendor&rsquo;s sample; anything that differs can be set under <strong>Model settings</strong>.
          {preview.streaming ? ' The reply is read as it arrives.' : ' Streaming is off for this credential.'}
        </p>
      </div>

      <label className="block">
        <span className="text-[11px] font-medium text-ink-muted">Request body</span>
        <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-line bg-white p-2 text-[11px] whitespace-pre-wrap break-words">
          {JSON.stringify(preview.body, null, 2)}
        </pre>
      </label>

      <details className="text-xs">
        <summary className="cursor-pointer text-ink-muted">As a curl command, to try it outside the system</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-line bg-white p-2 text-[11px] whitespace-pre-wrap break-words">
          {curl}
        </pre>
        <p className="mt-1 text-[11px] text-ink-faint">
          Your key is not shown here — put it in place of <code>&lt;your API key&gt;</code> if you run this.
        </p>
      </details>
    </div>
  );
}

/**
 * The per-model settings.
 *
 * Every vendor hands out a slightly different code sample per model - NVIDIA's
 * differ by sampling defaults, by an `extra_body` carrying `enable_thinking`
 * and a reasoning budget, and by whether the reply has to be read out of
 * `reasoning_content`. None of that is a different protocol, so none of it
 * needs different code: it is four settings and a JSON object.
 *
 * The extra fields box takes JSON, never code. Nothing typed here is executed;
 * it is parsed and merged into the request body, and the fields the server owns
 * are refused rather than silently dropped.
 */
function ModelSettings({
  credential, onCancel, onSave,
}: {
  credential: Credential;
  onCancel: () => void;
  onSave: (tuning: ModelTuning) => void;
}) {
  const saved = credential.meta?.tuning ?? {};
  const [thinking, setThinking] = useState<'auto' | 'yes' | 'no'>(saved.thinking ?? 'auto');
  const [jsonMode, setJsonMode] = useState<'auto' | 'on' | 'off'>(saved.jsonMode ?? 'auto');
  const [stream, setStream] = useState(saved.stream !== false);
  const [temperature, setTemperature] = useState(saved.temperature?.toString() ?? '');
  const [topP, setTopP] = useState(saved.topP?.toString() ?? '');
  const [seed, setSeed] = useState(saved.seed?.toString() ?? '');
  const [extra, setExtra] = useState(saved.extraBody ? JSON.stringify(saved.extraBody, null, 2) : '');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const num = (raw: string) => (raw.trim() === '' ? undefined : Number(raw));

  const submit = () => {
    let extraBody: Record<string, unknown> | undefined;
    if (extra.trim() !== '') {
      try {
        const parsed = JSON.parse(extra);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setJsonError('That has to be a JSON object — it should start with { and end with }.');
          return;
        }
        extraBody = parsed as Record<string, unknown>;
      } catch (err) {
        setJsonError(`That is not valid JSON: ${err instanceof Error ? err.message : 'check the brackets and commas.'}`);
        return;
      }
    }
    setJsonError(null);
    onSave({
      ...(extraBody ? { extraBody } : {}),
      ...(num(temperature) !== undefined ? { temperature: num(temperature) } : {}),
      ...(num(topP) !== undefined ? { topP: num(topP) } : {}),
      ...(num(seed) !== undefined ? { seed: num(seed) } : {}),
      stream,
      thinking,
      jsonMode,
    });
  };

  const field = 'input text-xs w-28 tabular-nums';

  return (
    <div className="p-3 space-y-3">
      <div>
        <h4 className="text-xs font-semibold">Model settings for {credential.label}</h4>
        <p className="text-[11px] text-ink-faint mt-0.5">
          These are the things a vendor&rsquo;s per-model code sample differs by. Set them here and any model works
          without a code change.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-ink-muted">
          <span className="block mb-1">Thinking model</span>
          <select className="input text-xs w-32" value={thinking} onChange={(e) => setThinking(e.target.value as typeof thinking)}>
            <option value="auto">Work it out</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label className="text-[11px] text-ink-muted">
          <span className="block mb-1">JSON mode</span>
          <select className="input text-xs w-32" value={jsonMode} onChange={(e) => setJsonMode(e.target.value as typeof jsonMode)}>
            <option value="auto">As the provider</option>
            <option value="on">Always ask</option>
            <option value="off">Never ask</option>
          </select>
        </label>
        <label className="text-[11px] text-ink-muted">
          <span className="block mb-1">Temperature</span>
          <input className={field} value={temperature} onChange={(e) => setTemperature(e.target.value)} placeholder="default" />
        </label>
        <label className="text-[11px] text-ink-muted">
          <span className="block mb-1">Top P</span>
          <input className={field} value={topP} onChange={(e) => setTopP(e.target.value)} placeholder="default" />
        </label>
        <label className="text-[11px] text-ink-muted">
          <span className="block mb-1">Seed</span>
          <input className={field} value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="none" />
        </label>
        <label className="flex items-center gap-2 text-[11px] text-ink-muted pb-2">
          <input type="checkbox" className="accent-series-1" checked={stream} onChange={(e) => setStream(e.target.checked)} />
          Read the reply as it arrives
        </label>
      </div>

      <label className="block">
        <span className="text-[11px] font-medium text-ink-muted">
          Extra request fields — JSON, copied from the vendor&rsquo;s <code>extra_body</code>
        </span>
        <textarea
          className="w-full rounded-lg border border-line bg-white p-2 text-xs font-mono"
          rows={4}
          spellCheck={false}
          value={extra}
          onChange={(e) => { setExtra(e.target.value); setJsonError(null); }}
          placeholder={'{\n  "chat_template_kwargs": { "enable_thinking": true },\n  "reasoning_budget": 16384\n}'}
        />
        {jsonError
          ? <p className="mt-1 text-[11px] text-bad">{jsonError}</p>
          : (
            <p className="mt-1 text-[11px] text-ink-faint">
              Merged into every request to this credential. Data only — nothing here is ever run as code, and the
              model, the messages and the streaming flag are set by the server.
            </p>
          )}
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary btn-sm" onClick={submit}>Save settings</button>
        <button type="button" className="btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <span className="text-[11px] text-ink-faint">
          Then press <strong>Try 2 questions</strong> to see whether it worked.
        </span>
      </div>
    </div>
  );
}

function Tags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ tags: Tag[] }>('/api/admin/tags')
      .then((res) => setTags(res.tags))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load tags.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageLoader label="Loading" />;
  if (error) return <Alert tone="error">{error}</Alert>;

  const axes: Array<{ axis: Tag['axis']; title: string; description: string }> = [
    { axis: 'DIFFICULTY', title: 'Difficulty', description: 'How hard the question is.' },
    { axis: 'COGNITIVE', title: 'Cognitive level', description: 'What the student has to do: recall, understand, apply, reason, analyse.' },
    { axis: 'SKILL', title: 'Skill', description: 'Which ability the question exercises.' },
  ];

  return (
    <div className="space-y-4">
      <Alert tone="info">
        These three axes are deliberately independent. Because a question carries one difficulty, one cognitive level
        and one or more skills, a wrong answer lands in a specific cell of the grid — which is what makes the weak-area
        reports and targeted practice tests possible. Tag codes cannot be renamed once questions use them; deactivate
        and add a replacement instead.
      </Alert>

      {axes.map((axis) => (
        <Card key={axis.axis} title={axis.title} padded={false}>
          <p className="px-4 pt-3 text-xs text-ink-muted">{axis.description}</p>
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr><th>Code</th><th>Label</th><th>Description</th><th className="text-center">Weight</th><th>Status</th></tr>
              </thead>
              <tbody>
                {tags.filter((t) => t.axis === axis.axis).map((tag) => (
                  <tr key={tag.id}>
                    <td className="font-mono text-xs">{tag.code}</td>
                    <td className="font-medium">{tag.label}</td>
                    <td className="text-xs text-ink-muted">{tag.description ?? '—'}</td>
                    <td className="text-center tabular-nums">{tag.weight || '—'}</td>
                    <td><Badge tone={tag.isActive ? 'good' : 'neutral'}>{tag.isActive ? 'active' : 'inactive'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}

// --- Classes ---------------------------------------------------------------

interface SchoolClass {
  id: string;
  kind: string;
  code: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Adds a grade or a division.
 *
 * The code is what gets written onto every student row and into every saved
 * breakdown, so it is derived from the label rather than typed separately -
 * two fields where one has to be machine-safe is a trap - and it can never be
 * edited afterwards. It is shown while typing so nobody is surprised by what
 * lands in their exports.
 */
function AddClass({ kind, onAdded }: { kind: 'GRADE' | 'DIVISION'; onAdded: (message: string) => void }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const code = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  const noun = kind === 'GRADE' ? 'grade' : 'division';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/classes', { kind, code, label: label.trim(), sortOrder: 100 });
      setLabel('');
      onAdded(`${label.trim()} added.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not add that ${noun}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="px-4 py-3 border-t border-line space-y-2">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      <div className="flex gap-2">
        <input
          className="input"
          placeholder={kind === 'GRADE' ? 'e.g. Grade 11' : 'e.g. Music Foundation'}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={60}
        />
        <button type="submit" className="btn-secondary btn-sm shrink-0" disabled={busy || !code}>
          {busy ? 'Adding…' : `Add ${noun}`}
        </button>
      </div>
      {code && (
        <p className="text-[11px] text-ink-faint">
          Stored as <span className="font-mono text-ink-muted">{code}</span>, which cannot be changed later.
        </p>
      )}
    </form>
  );
}

function Classes() {
  const [data, setData] = useState<{ grades: SchoolClass[]; divisions: SchoolClass[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<{ grades: SchoolClass[]; divisions: SchoolClass[] }>('/api/admin/classes'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load classes.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (row: SchoolClass) => {
    await api.patch(`/api/admin/classes/${row.id}`, { isActive: !row.isActive }).catch(() => undefined);
    await load();
  };

  const remove = async (row: SchoolClass) => {
    setError(null);
    try {
      const res = await api.delete<{ message: string }>(`/api/admin/classes/${row.id}`);
      setNotice(res.message);
      await load();
    } catch (err) {
      // The refusal explains itself - who is still in it, and what to do
      // instead - so it is shown as-is.
      setError(err instanceof ApiError ? err.message : 'Could not delete that.');
    }
  };

  if (!data) return error ? <Alert tone="error">{error}</Alert> : <PageLoader label="Loading" />;

  return (
    <div className="space-y-4">
      {/*
        The old label read "Hide from signup" with nothing to say what that
        meant. It controls one thing: whether this grade or division is offered
        in the dropdown when a student creates their own account. Existing
        students keep theirs, and an administrator can still assign it.
      */}
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <Alert tone="info">
        These are the grades and divisions a student can choose when they create their own account. Clearing the tick
        takes one off that form without affecting anybody already in it — useful for a class that has left, or one you
        want to assign yourself rather than let students pick. A student can be in more than one division; set that
        on the student under Students → Edit.
      </Alert>

      <div className="grid md:grid-cols-2 gap-4">
      {([['Grades', data.grades, 'GRADE'], ['Divisions', data.divisions, 'DIVISION']] as const).map(
        ([title, rows, kind]) => (
        <Card key={title} title={title} padded={false}>
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="text-sm">
                  {row.label}
                  <span className="ml-2 font-mono text-xs text-ink-faint">{row.code}</span>
                </span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-ink-muted whitespace-nowrap cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-series-1"
                      checked={row.isActive}
                      onChange={() => toggle(row)}
                    />
                    Offered at signup
                  </label>
                  {/* Refused server-side the moment anybody is in it, with a
                      message naming how many - so no confirmation here. */}
                  <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => void remove(row)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <AddClass kind={kind} onAdded={async (message) => { setNotice(message); await load(); }} />
        </Card>
      ))}
      </div>
    </div>
  );
}

// --- Audit -----------------------------------------------------------------

interface AuditEntry {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  ip: string | null;
  createdAt: string;
  actor: { username: string } | null;
}

function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ entries: AuditEntry[] }>('/api/admin/audit?pageSize=100')
      .then((res) => setEntries(res.entries))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <PageLoader label="Loading" />;

  return (
    <Card padded={false}>
      <div className="scroll-x">
        <table className="table-base">
          <thead>
            <tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>IP</th></tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(entry.createdAt, true)}</td>
                <td className="font-mono text-xs">{entry.actor?.username ?? '—'}</td>
                <td className="font-mono text-xs">{entry.action}</td>
                <td className="text-xs text-ink-muted">{entry.entity ?? '—'}</td>
                <td className="font-mono text-xs text-ink-faint">{entry.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
