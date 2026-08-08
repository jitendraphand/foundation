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
  } | null;
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

  const setFallback = async (credential: Credential, useAsFallback: boolean) => {
    try {
      await api.patch(`/api/admin/credentials/${credential.id}`, { useAsFallback });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that setting.');
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
                  <th className="text-center">Fallback</th>
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
                    <td className="text-center">
                      <input
                        type="checkbox"
                        className="accent-series-1"
                        checked={credential.meta?.useAsFallback === true}
                        onChange={(e) => void setFallback(credential, e.target.checked)}
                        aria-label={`Use ${credential.label} as a fallback`}
                      />
                    </td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(credential.createdAt)}</td>
                    <td className="text-right whitespace-nowrap">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => test(credential)} disabled={testing === credential.id}>
                        {testing === credential.id ? 'Testing…' : 'Test connection'}
                      </button>
                      <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => remove(credential)}>Delete</button>
                    </td>
                  </tr>
                ))}
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

// --- Prompts ---------------------------------------------------------------

interface Template {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  userTemplate: string;
  kind: 'REGULAR' | 'PRACTICE';
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
                  <Badge>{template.kind.toLowerCase()}</Badge>
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

        <Field label="User message template" hint="Placeholders: {{count}} {{subject}} {{topic}} {{subtopic}} {{grade}} {{marksPerQuestion}} {{difficultyMix}} {{cognitiveMix}} {{formats}} {{skillFocus}} {{extraInstructions}}">
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

function Classes() {
  const [data, setData] = useState<{ grades: SchoolClass[]; divisions: SchoolClass[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading" />;

  return (
    <div className="space-y-4">
      {/*
        The old label read "Hide from signup" with nothing to say what that
        meant. It controls one thing: whether this grade or division is offered
        in the dropdown when a student creates their own account. Existing
        students keep theirs, and an administrator can still assign it.
      */}
      <Alert tone="info">
        These are the grades and divisions a student can choose when they create their own account. Clearing the tick
        takes one off that form without affecting anybody already in it — useful for a class that has left, or one you
        want to assign yourself rather than let students pick.
      </Alert>

      <div className="grid md:grid-cols-2 gap-4">
      {([['Grades', data.grades], ['Divisions', data.divisions]] as const).map(([title, rows]) => (
        <Card key={title} title={title} padded={false}>
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-2 flex items-center justify-between gap-3">
                <span className="text-sm">
                  {row.label}
                  <span className="ml-2 font-mono text-xs text-ink-faint">{row.code}</span>
                </span>
                <label className="flex items-center gap-2 text-xs text-ink-muted whitespace-nowrap cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-series-1"
                    checked={row.isActive}
                    onChange={() => toggle(row)}
                  />
                  Offered at signup
                </label>
              </li>
            ))}
          </ul>
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
