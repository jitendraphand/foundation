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
    modelHint: 'Format: vendor/model, e.g. anthropic/claude-sonnet-4.5',
    suggestedModels: [
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-pro',
      'openai/gpt-4.1',
      'deepseek/deepseek-chat',
      'qwen/qwen-2.5-72b-instruct',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    supportsJsonMode: true,
  },

  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://docs.api.nvidia.com/nim/',
    keyUrl: 'https://build.nvidia.com/',
    modelHint: 'Format: vendor/model, exactly as shown on build.nvidia.com',
    suggestedModels: [
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'qwen/qwen2.5-coder-32b-instruct',
      'deepseek-ai/deepseek-r1',
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
}

export interface ChatResponse {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
}

export class LlmError extends Error {
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
function isReasoningModel(model: string): boolean {
  const name = model.toLowerCase().split('/').pop() ?? '';
  return /^(o\d|gpt-5)/.test(name);
}

export async function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const started = Date.now();
  const reasoning = isReasoningModel(req.model);

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };

  if (reasoning) {
    body.max_completion_tokens = req.maxTokens ?? 8000;
  } else {
    body.temperature = req.temperature ?? 0.4;
    body.max_tokens = req.maxTokens ?? 8000;
  }

  if (req.jsonMode) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
        // OpenRouter asks for these; harmless everywhere else.
        'HTTP-Referer': `https://${env.PUBLIC_HOST}`,
        'X-Title': 'Foundation Exam System',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
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

  if (!res.ok) {
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
      res.status === 402 ? ' (the provider account is out of credit)' :
      res.status === 403 ? ' (the key is valid but not allowed to use this model)' :
      res.status === 404 ? ' (check the model name is exactly right for this provider)' :
      res.status === 429 ? ' (rate limited - wait a moment and retry)' :
      res.status === 503 ? ' (the model is loading or temporarily unavailable - retry shortly)' : '';
    throw new LlmError(`Provider returned ${res.status}${hint}: ${detail}`, res.status, text);
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError('Provider returned a response that was not valid JSON.', res.status, text.slice(0, 2000));
  }

  const content: string | undefined = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError('Provider returned an empty message.', res.status, text.slice(0, 2000));
  }

  return {
    text: content,
    promptTokens: json?.usage?.prompt_tokens,
    completionTokens: json?.usage?.completion_tokens,
    latencyMs: Date.now() - started,
  };
}

/** Cheap credential check used by the "Test connection" button. */
export async function pingProvider(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  try {
    const res = await chatComplete({
      baseUrl,
      apiKey,
      model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 12,
      temperature: 0,
    });
    return { ok: true, message: `Connected. Model replied in ${res.latencyMs} ms.`, latencyMs: res.latencyMs };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
