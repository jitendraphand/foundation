import { env } from '../env.js';

/**
 * Supported question-generation providers.
 *
 * All four speak the OpenAI chat-completions shape, so one adapter covers them
 * all. Adding another OpenAI-compatible service later means one row here - no
 * code change.
 *
 * None of these generate images. Where a question needs a picture, the model
 * is required to flag it and supply an image-generation prompt instead; see
 * llm/prompts.ts and the IMAGE POLICY section of the system prompt.
 */

export interface ProviderDef {
  id: string;
  label: string;
  defaultBaseUrl: string;
  docsUrl: string;
  keyUrl: string;
  /** Shown under the model box in the admin UI. */
  modelHint: string;
  suggestedModels: string[];
  /** Whether the provider honours response_format: { type: "json_object" }. */
  supportsJsonMode: boolean;
  /**
   * How the HTTP call is shaped. Most services copy OpenAI exactly; the ones
   * that do not get a named dialect rather than a pile of conditionals.
   *
   *   openai  POST {base}/chat/completions, Authorization: Bearer
   *   azure   the deployment is in the path and the key is an api-key header
   *   bedrock its own protocol entirely; see bedrock.ts
   *   oci     its own protocol and its own request signing; see oci.ts
   */
  dialect?: 'openai' | 'azure' | 'bedrock' | 'oci';
  /**
   * The largest completion this provider will accept a request for.
   *
   * Not a suggestion: OCI rejects the whole call with 400 when maxTokens is
   * over its limit, so asking for more is not merely wasteful, it fails. Left
   * undefined where the ceiling is high enough that our own 32k cap binds
   * first.
   *
   * It also decides how many questions fit in one call - see planBatches -
   * because clamping the request without shrinking the batch just moves the
   * failure from a clear 400 to a truncated reply that will not parse.
   */
  maxOutputTokens?: number;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keyUrl: 'https://platform.openai.com/api-keys',
    modelHint: 'e.g. gpt-4.1 for the best questions, gpt-4.1-mini to keep costs down.',
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'],
    supportsJsonMode: true,
  },

  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/docs',
    keyUrl: 'https://openrouter.ai/keys',
    modelHint:
      'Format: vendor/model, e.g. anthropic/claude-sonnet-4.5. There is no ' +
      'model called "openrouter/free" - free models are ordinary ids with a ' +
      ':free suffix, and openrouter/auto picks one for you.',
    suggestedModels: [
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-pro',
      'openai/gpt-4.1',
      'deepseek/deepseek-chat',
      'meta-llama/llama-3.3-70b-instruct',
      'openrouter/auto',
    ],
    supportsJsonMode: true,
  },

  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://docs.api.nvidia.com/nim/',
    keyUrl: 'https://build.nvidia.com/',
    modelHint:
      'Copy the model id exactly as it appears on build.nvidia.com - vendor/model, ' +
      'e.g. zai-org/glm-4.6 or meta/llama-3.3-70b-instruct. The list below is a ' +
      'starting point, not a restriction: any id the catalogue offers will work.',
    suggestedModels: [
      'zai-org/glm-4.6',
      'zai-org/glm-4.5',
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'deepseek-ai/deepseek-r1',
      'qwen/qwen2.5-coder-32b-instruct',
      'mistralai/mixtral-8x22b-instruct-v0.1',
    ],
    supportsJsonMode: false,
  },

  huggingface: {
    id: 'huggingface',
    label: 'Hugging Face Inference Providers',
    // The OpenAI-compatible router that fronts Together, Groq, Cerebras,
    // Fireworks, Replicate and others behind a single HF token.
    defaultBaseUrl: 'https://router.huggingface.co/v1',
    docsUrl: 'https://huggingface.co/docs/inference-providers',
    keyUrl: 'https://huggingface.co/settings/tokens',
    modelHint:
      'Format: owner/model. Add a routing suffix to pin a backend, e.g. ' +
      'openai/gpt-oss-120b:groq, or :cheapest / :fastest. With no suffix the ' +
      'fastest available provider is chosen automatically.',
    suggestedModels: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'mistralai/Mistral-Small-24B-Instruct-2501',
      'openai/gpt-oss-120b',
    ],
    supportsJsonMode: false,
  },

  bedrock: {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    // Filled in from the region when the credential is saved; Bedrock has one
    // endpoint per region rather than one global one.
    defaultBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/',
    keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys',
    modelHint:
      'The model id exactly as Bedrock shows it, e.g. ' +
      'anthropic.claude-sonnet-4-20250514-v1:0. Many newer models are only ' +
      'callable through a cross-region inference profile, whose id carries a ' +
      'us. eu. or apac. prefix - if a model id is refused as "on-demand not ' +
      'supported", that is why.',
    suggestedModels: [
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'us.amazon.nova-pro-v1:0',
      'us.amazon.nova-lite-v1:0',
      'us.meta.llama3-3-70b-instruct-v1:0',
      'mistral.mistral-large-2407-v1:0',
    ],
    // Converse has no response_format; the JSON contract is enforced by the
    // prompt and the repair rounds, as with NVIDIA and Hugging Face.
    supportsJsonMode: false,
  },

  azure: {
    id: 'azure',
    label: 'Azure OpenAI',
    // Filled in from the resource name when the credential is saved: every
    // Azure OpenAI resource has its own hostname.
    defaultBaseUrl: '',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/reference',
    keyUrl: 'https://portal.azure.com/',
    modelHint:
      'On Azure the model is the DEPLOYMENT name you chose in Azure AI Foundry, not the ' +
      'underlying model - so if you deployed gpt-4o as "exam-writer", put exam-writer here.',
    suggestedModels: ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
    supportsJsonMode: true,
    dialect: 'azure',
  },

  google: {
    id: 'google',
    label: 'Google Gemini (AI Studio key)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    modelHint: 'e.g. gemini-2.5-pro for the best questions, gemini-2.5-flash to keep costs down.',
    suggestedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    supportsJsonMode: true,
  },

  vertex: {
    id: 'vertex',
    label: 'Google Vertex AI (service account)',
    // Derived from the project and region on the service account.
    defaultBaseUrl: '',
    docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library',
    keyUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    modelHint:
      'e.g. google/gemini-2.5-pro. Vertex model ids carry a publisher prefix, and the model must be ' +
      'enabled in the region on the service account.',
    suggestedModels: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.0-flash'],
    supportsJsonMode: true,
  },

  oci: {
    id: 'oci',
    label: 'Oracle Cloud Generative AI',
    // Derived from the region when the credential is saved.
    defaultBaseUrl: '',
    docsUrl: 'https://docs.oracle.com/en-us/iaas/Content/generative-ai/home.htm',
    keyUrl: 'https://cloud.oracle.com/identity/domains/my-profile/api-keys',
    modelHint:
      'The model OCID or its short name, e.g. meta.llama-3.3-70b-instruct or cohere.command-r-plus-08-2024. ' +
      'Models are available in some regions only.',
    suggestedModels: [
      'meta.llama-3.3-70b-instruct',
      'meta.llama-3.2-90b-vision-instruct',
      'cohere.command-r-plus-08-2024',
      'cohere.command-r-08-2024',
      'xai.grok-3',
    ],
    // The chat action has no JSON mode; the contract is held by the prompt and
    // the repair rounds, as with Bedrock.
    supportsJsonMode: false,
    dialect: 'oci',
    // Oracle caps completions per model and refuses the request outright above
    // it: "Invalid 'maxTokens': Value is greater than maximum: 4096". 4096 is
    // the ceiling for the Llama and Cohere models it hosts.
    maxOutputTokens: 4096,
  },

  custom: {
    id: 'custom',
    label: 'Other OpenAI-compatible endpoint',
    defaultBaseUrl: '',
    docsUrl: '',
    keyUrl: '',
    modelHint: 'Whatever model id your endpoint expects.',
    suggestedModels: [],
    supportsJsonMode: false,
  },
};

/**
 * Is this string actually a key?
 *
 * Every provider shows a new key once and then displays an elided version -
 * `sk-or-v1-...`. Pasting that is an easy mistake to make, it is long enough
 * to pass any length check, and the failure surfaces much later as a 401 from
 * the provider that reads like the key is wrong rather than truncated.
 *
 * `error` means it cannot possibly work and is refused. `warning` means it
 * looks unusual but is saved anyway - provider prefixes do change, and being
 * wrong about that must not stop someone using their own key.
 */
export function describeKeyProblem(provider: string, key: string): { error?: string; warning?: string } {
  // Vertex's "key" is the whole service-account JSON file, which legitimately
  // contains braces, newlines and a PEM block. Every check below is about the
  // shape of a bearer token and would reject a perfectly good key file; the
  // file gets its own, stricter validation in google-auth.ts instead.
  if (provider === 'vertex' || provider === 'oci') return {};

  if (/\.\.\.|…/.test(key)) {
    return {
      error:
        'That looks like the shortened key the provider displays after creating it, not the key itself. ' +
        'A key is only shown in full once - create a new one and copy it straight away.',
    };
  }
  if (/\s/.test(key)) {
    return { error: 'That key contains a space or a line break. Copy it again without any surrounding text.' };
  }
  if (/^["'`<]|["'`>]$/.test(key)) {
    return { error: 'That key has quotes or angle brackets around it. Paste just the key itself.' };
  }
  if (/^(your|my|paste|enter|xxx|test)[-_ ]?(api)?[-_ ]?key/i.test(key)) {
    return { error: 'That is the placeholder text, not a key.' };
  }

  // Bedrock is deliberately absent: an API key and a secret access key look
  // nothing alike and neither has a stable prefix worth guessing at.
  const expected: Record<string, { prefix: string; example: string }> = {
    openai: { prefix: 'sk-', example: 'sk-proj-…' },
    openrouter: { prefix: 'sk-or-', example: 'sk-or-v1-…' },
    huggingface: { prefix: 'hf_', example: 'hf_…' },
    nvidia: { prefix: 'nvapi-', example: 'nvapi-…' },
  };

  const want = expected[provider];
  if (want && !key.startsWith(want.prefix)) {
    return {
      warning:
        `${PROVIDERS[provider]?.label ?? provider} keys normally start with "${want.prefix}" (${want.example}). ` +
        'Saved anyway - test the connection to check it works.',
    };
  }

  return {};
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  /**
   * Set for Bedrock only. Its API is not OpenAI-shaped, so chatComplete hands
   * the whole call to the Bedrock adapter rather than trying to bend one
   * request shape around two protocols.
   */
  bedrock?: import('./bedrock.js').BedrockConfig;

  /**
   * Set for Oracle Cloud only. Like Bedrock it has its own protocol, and
   * unlike everything else it also signs each request.
   */
  oci?: {
    credentials: import('./oci-signer.js').OciCredentials;
    baseUrl?: string;
  };

  /** See ProviderDef.dialect. Absent means the ordinary OpenAI shape. */
  dialect?: ProviderDef['dialect'];

  /**
   * Azure only. The deployment name goes in the path rather than the body, and
   * the API version is a required query parameter that Azure pins per feature.
   */
  azure?: { apiVersion: string };

  /**
   * The administrator's per-model settings; see llm/tuning.ts. Sampling
   * defaults, vendor extensions and whether to stream all come from here.
   */
  tuning?: import('./tuning.js').ModelTuning;
}

export interface ChatResponse {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  /**
   * A thinking model's working, kept apart from the answer.
   *
   * Never parsed - it is here so a stalled or empty reply can be explained
   * ("it thought for 4,000 tokens and never started the answer") instead of
   * arriving as an unexplained blank.
   */
  reasoningText?: string;
  /** "stop", "length", … as the provider reported it. */
  finishReason?: string;
  /** Whether the reply was streamed, for the diagnostics screen. */
  streamed?: boolean;
  /** How long until the first token arrived. Streaming only. */
  firstTokenMs?: number;
}

export class LlmError extends Error {
  /**
   * How much working the model produced before failing, when that is the
   * explanation. Carried structurally as well as in the message so a screen
   * can show it as a figure rather than having to read English back out.
   */
  reasoningChars?: number;

  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * OpenAI's reasoning models (o1, o3, o4, and the gpt-5 reasoning line) reject
 * `max_tokens` in favour of `max_completion_tokens`, and reject any
 * temperature other than the default. Sending the usual parameters gets a 400
 * that reads like a bad API key, so detect them and adjust.
 */
/**
 * Azure pins its API surface to a dated version. This one is the current
 * generally-available release; an admin whose resource is older can override
 * it per credential.
 */
export const DEFAULT_AZURE_API_VERSION = '2024-10-21';

function isReasoningModel(model: string): boolean {
  const name = model.toLowerCase().split('/').pop() ?? '';
  return /^(o\d|gpt-5)/.test(name);
}

/**
 * Models that write their working out before the answer.
 *
 * They spend output tokens on reasoning that never reaches us, so a budget
 * sized for the answer alone runs out mid-thought and the reply arrives
 * truncated - which looks like the model ignoring the format. Give them room.
 * See stripReasoning in llm/schema.ts for the other half of this.
 */
export function emitsReasoning(model: string, setting?: 'auto' | 'yes' | 'no'): boolean {
  if (setting === 'yes') return true;
  if (setting === 'no') return false;

  // Guessing from the name is wrong in both directions, which is why the
  // setting exists: nvidia/nemotron-3.5-lightning thinks and its name does not
  // say so, while thinkingmachines/inkling matches only because of the
  // vendor's name. The guess is the fallback, not the authority.
  //
  // The vendor segment is dropped first so a company name cannot decide how a
  // model is budgeted.
  const name = model.toLowerCase();
  const bare = name.split('/').pop() ?? name;
  return /^(o\d|gpt-5)|deepseek-r1|reasoner|qwq|glm-4\.[5-9]|glm-[5-9]|thinking|magistral|nemotron-[3-9]/.test(bare);
}

export async function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  // Bedrock speaks its own protocol. Everything below this line is the
  // OpenAI chat/completions shape that the other four providers share.
  if (req.bedrock) {
    const { bedrockChat } = await import('./bedrock.js');
    return bedrockChat({
      config: req.bedrock,
      modelId: req.model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
    });
  }

  if (req.oci) {
    const { ociChat } = await import('./oci.js');
    return ociChat({
      credentials: req.oci.credentials,
      baseUrl: req.oci.baseUrl,
      modelId: req.model,
      messages: req.messages,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
    });
  }

  const { url, headers, body, streaming } = await buildChatRequest(req);
  const started = Date.now();

  return streaming
    ? streamCompletion({ url, headers, body, started })
    : wholeCompletion({ url, headers, body, started });
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  streaming: boolean;
}

/**
 * Exactly what goes on the wire, in one place.
 *
 * Split out from chatComplete so the settings screen can show an administrator
 * the real request for a credential rather than a description of it. A vendor's
 * per-model sample is only useful if you can see what your own request differs
 * by, and a preview assembled separately would drift from the real one and be
 * worse than none at all. This is the same function the real call uses.
 */
export async function buildChatRequest(req: ChatRequest): Promise<BuiltRequest> {
  const isAzure = req.dialect === 'azure';
  const base = req.baseUrl.replace(/\/+$/, '');

  // Azure addresses a deployment, not a model: the name the admin chose when
  // they deployed goes in the path, and the api-version query parameter is
  // mandatory - omitting it returns a 404 that reads like a wrong hostname.
  const url = isAzure
    ? `${base}/openai/deployments/${encodeURIComponent(req.model)}/chat/completions` +
      `?api-version=${encodeURIComponent(req.azure?.apiVersion ?? DEFAULT_AZURE_API_VERSION)}`
    : `${base}/chat/completions`;

  const reasoning = isReasoningModel(req.model);
  const tuning = req.tuning ?? {};

  // The administrator's extra fields go in first, so anything the server owns
  // below overwrites them rather than the other way round. safeExtraBody has
  // already removed model, messages and stream; see llm/tuning.ts.
  const { safeExtraBody } = await import('./tuning.js');
  const body: Record<string, unknown> = {
    ...safeExtraBody(tuning.extraBody),
    // Azure ignores this - the deployment in the URL decides - but sending it
    // is harmless and keeps the request readable in a log.
    model: req.model,
    messages: req.messages,
  };

  if (reasoning) {
    body.max_completion_tokens = req.maxTokens ?? 8000;
  } else {
    body.temperature = tuning.temperature ?? req.temperature ?? 0.4;
    body.max_tokens = req.maxTokens ?? 8000;
  }
  if (tuning.topP !== undefined) body.top_p = tuning.topP;
  if (tuning.seed !== undefined) body.seed = tuning.seed;

  const wantsJson = tuning.jsonMode === 'on' ? true : tuning.jsonMode === 'off' ? false : req.jsonMode;
  if (wantsJson) body.response_format = { type: 'json_object' };

  // Streaming unless the administrator turned it off. Reading the reply as it
  // arrives is what makes a slow model distinguishable from a dead one, and it
  // means a stall is measured from the last token rather than from the start.
  const streaming = tuning.stream !== false;
  if (streaming) {
    body.stream = true;
    // Where it is supported this puts token counts in the final chunk; the
    // providers that do not know it ignore an unknown field.
    body.stream_options = { include_usage: true };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Azure authenticates with its own header; everyone else takes a
    // bearer token. Sending Bearer to Azure returns 401 PermissionDenied.
    ...(isAzure ? { 'api-key': req.apiKey } : { Authorization: `Bearer ${req.apiKey}` }),
    // OpenRouter asks for these; harmless everywhere else.
    'HTTP-Referer': `https://${env.PUBLIC_HOST}`,
    'X-Title': 'Foundation Exam System',
  };

  return { url, headers, body, streaming };
}

/**
 * Turns a provider's error body into a sentence an administrator can act on.
 */
async function providerError(res: Response, text: string): Promise<never> {
  let detail = text.slice(0, 600);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail).slice(0, 600);
  } catch {
    /* keep the raw text */
  }
  const hint =
    res.status === 401 ? ' (check the API key in Admin > Settings)' :
    res.status === 400 && /model/i.test(detail) ? ' (check the model name is exactly right for this provider)' :
    res.status === 402 ? ' (the provider account is out of credit)' :
    res.status === 403 ? ' (the key is valid but not allowed to use this model)' :
    res.status === 404 ? ' (check the model name is exactly right for this provider)' :
    res.status === 429 ? ' (rate limited - wait a moment and retry)' :
    res.status === 503 ? ' (the model is loading or temporarily unavailable - retry shortly)' : '';
  throw new LlmError(`Provider returned ${res.status}${hint}: ${detail}`, res.status, text);
}

/** The old behaviour: one request, wait for the whole body. */
async function wholeCompletion(args: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  started: number;
}): Promise<ChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(args.url, {
      method: 'POST',
      headers: args.headers,
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new LlmError(
        `Provider did not respond within ${Math.round(env.LLM_TIMEOUT_MS / 1000)}s. Try a smaller batch or a faster model.`,
      );
    }
    throw new LlmError(`Could not reach the provider: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) await providerError(res, text);

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError('Provider returned a response that was not valid JSON.', res.status, text.slice(0, 2000));
  }

  const message = json?.choices?.[0]?.message ?? {};
  const content: unknown = message.content;
  const reasoningText: string = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';

  if (typeof content !== 'string' || content.trim() === '') {
    throw emptyAnswer(reasoningText, json?.choices?.[0]?.finish_reason, res.status, text.slice(0, 2000));
  }

  return {
    text: content,
    reasoningText: reasoningText || undefined,
    finishReason: json?.choices?.[0]?.finish_reason,
    promptTokens: json?.usage?.prompt_tokens,
    completionTokens: json?.usage?.completion_tokens,
    latencyMs: Date.now() - args.started,
    streamed: false,
  };
}

/**
 * A reply read as it arrives.
 *
 * Two things this buys, and the second matters more than the first.
 *
 * The timeout stops meaning "the whole answer must be finished within N
 * seconds" and starts meaning "something must arrive every N seconds". A big
 * batch from a queued free tier no longer looks identical to a dead endpoint,
 * and when it does fail the message can say whether anything was ever coming.
 *
 * And a thinking model's working arrives in its own field, `reasoning_content`,
 * rather than inside the answer. Waiting for the whole body and reading only
 * `message.content` is how a model that spent its entire budget reasoning came
 * back as an unexplained empty reply.
 */
async function streamCompletion(args: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  started: number;
}): Promise<ChatResponse> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), env.LLM_MAX_MS);

  // Reset on every chunk: this is the "nothing is arriving" alarm, not a cap
  // on how long a long answer may legitimately take.
  let stall: NodeJS.Timeout | undefined;
  let stalled = false;
  const resetStall = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, env.LLM_TIMEOUT_MS);
  };
  const done = () => {
    if (stall) clearTimeout(stall);
    clearTimeout(deadline);
  };

  resetStall();

  let res: Response;
  try {
    res = await fetch(args.url, {
      method: 'POST',
      headers: { ...args.headers, Accept: 'text/event-stream' },
      body: JSON.stringify(args.body),
      signal: controller.signal,
    });
  } catch (err) {
    done();
    if ((err as Error).name === 'AbortError') throw stallError(stalled, 0);
    throw new LlmError(`Could not reach the provider: ${(err as Error).message}`);
  }

  if (!res.ok) {
    done();
    await providerError(res, await res.text());
  }

  // A provider may answer a streaming request with an ordinary JSON body -
  // some do when the request errors late, or when they do not stream at all.
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.body || contentType.includes('application/json')) {
    done();
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmError('Provider returned a response that was not valid JSON.', res.status, text.slice(0, 2000));
    }
    const message = json?.choices?.[0]?.message ?? {};
    if (typeof message.content === 'string' && message.content.trim() !== '') {
      return {
        text: message.content,
        reasoningText: typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
        finishReason: json?.choices?.[0]?.finish_reason,
        promptTokens: json?.usage?.prompt_tokens,
        completionTokens: json?.usage?.completion_tokens,
        latencyMs: Date.now() - args.started,
        streamed: false,
      };
    }
    throw emptyAnswer('', json?.choices?.[0]?.finish_reason, res.status, text.slice(0, 2000));
  }

  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let firstTokenMs: number | undefined;
  let buffer = '';

  const decoder = new TextDecoder();

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      resetStall();
      buffer += decoder.decode(chunk, { stream: true });

      // SSE events are separated by a blank line; a single chunk may hold
      // several, or half of one.
      let cut: number;
      while ((cut = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + (buffer[cut] === '\r' ? 4 : 2));

        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;

          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue; // a keep-alive or a comment; not our business
          }

          // Some providers report a mid-stream failure as a data event.
          if (parsed?.error) {
            const message = parsed.error?.message ?? JSON.stringify(parsed.error);
            throw new LlmError(`Provider failed part-way through the reply: ${String(message).slice(0, 400)}`);
          }

          if (parsed?.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
            completionTokens = parsed.usage.completion_tokens ?? completionTokens;
          }

          const choice = parsed?.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta ?? choice.message ?? {};
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
          if (typeof delta.content === 'string' && delta.content !== '') {
            if (firstTokenMs === undefined) firstTokenMs = Date.now() - args.started;
            content += delta.content;
          }
        }
      }
    }
  } catch (err) {
    done();
    if (err instanceof LlmError) throw err;
    if ((err as Error).name === 'AbortError') throw stallError(stalled, content.length + reasoning.length);
    throw new LlmError(`The reply stopped part-way through: ${(err as Error).message}`);
  }

  done();

  if (content.trim() === '') {
    throw emptyAnswer(reasoning, finishReason, 200, reasoning.slice(0, 2000));
  }

  return {
    text: content,
    reasoningText: reasoning || undefined,
    finishReason,
    promptTokens,
    completionTokens,
    latencyMs: Date.now() - args.started,
    streamed: true,
    firstTokenMs,
  };
}

function stallError(stalled: boolean, received: number): LlmError {
  const seconds = Math.round(env.LLM_TIMEOUT_MS / 1000);
  if (!stalled) {
    return new LlmError(
      `The reply ran past ${Math.round(env.LLM_MAX_MS / 1000)}s and was given up on. Ask for fewer questions at a time.`,
    );
  }
  return new LlmError(
    received > 0
      ? `The provider started answering and then went quiet for ${seconds}s. It is overloaded rather than unreachable - retry, or use a faster model.`
      : `Nothing arrived from the provider for ${seconds}s. Check the model name, or try a smaller batch or a faster model.`,
  );
}

/**
 * An empty answer, explained.
 *
 * The common cause on NVIDIA NIM is a thinking model with a budget that ran
 * out before it started writing: the tokens all went to reasoning_content,
 * which is not the answer and is never parsed. Saying so is the difference
 * between a fixable setting and an unexplained blank.
 */
function emptyAnswer(reasoning: string, finishReason: string | undefined, status: number, raw: string): LlmError {
  if (reasoning.trim() !== '') {
    const err = new LlmError(
      `The model spent its whole reply thinking (${reasoning.length} characters of working) and never wrote an answer. ` +
        'Raise the reply limit for this credential, or set Thinking to "no" if the model does not need it.',
      status,
      raw,
    );
    err.reasoningChars = reasoning.length;
    return err;
  }
  if (finishReason === 'length') {
    return new LlmError(
      'The reply hit the token limit before any of the answer arrived. Raise the reply limit, or ask for fewer questions at a time.',
      status,
      raw,
    );
  }
  return new LlmError('Provider returned an empty message.', status, raw);
}

/** Cheap credential check used by the "Test connection" button. */
export async function pingProvider(
  call: Pick<ChatRequest, 'baseUrl' | 'apiKey' | 'model' | 'bedrock' | 'oci' | 'dialect' | 'azure'>,
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  try {
    const res = await chatComplete({
      ...call,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      // Bedrock counts a reasoning model's working against this too, so it is
      // generous enough that a thinking model still gets a word out.
      maxTokens: 64,
      temperature: 0,
    });
    return { ok: true, message: `Connected. Model replied in ${res.latencyMs} ms.`, latencyMs: res.latencyMs };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
