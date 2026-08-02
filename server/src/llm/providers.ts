import { env } from '../env.js';

/**
 * All three supported providers speak the OpenAI chat-completions shape, so a
 * single adapter covers them. Adding Groq, Together, Fireworks or a local
 * Ollama later means inserting one row in PROVIDERS - no code change.
 */

export interface ProviderDef {
  id: string;
  label: string;
  defaultBaseUrl: string;
  docsUrl: string;
  suggestedModels: string[];
  /** Whether the provider honours response_format: { type: "json_object" }. */
  supportsJsonMode: boolean;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/docs',
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
    label: 'NVIDIA NIM (build.nvidia.com)',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://build.nvidia.com/',
    suggestedModels: [
      'meta/llama-3.3-70b-instruct',
      'qwen/qwen2.5-coder-32b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'deepseek-ai/deepseek-r1',
      'mistralai/mixtral-8x22b-instruct-v0.1',
    ],
    supportsJsonMode: false,
  },
  custom: {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    defaultBaseUrl: '',
    docsUrl: '',
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

export async function chatComplete(req: ChatRequest): Promise<ChatResponse> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.4,
    max_tokens: req.maxTokens ?? 8000,
  };
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
        // OpenRouter asks for these; harmless elsewhere.
        'HTTP-Referer': `https://${env.PUBLIC_HOST}`,
        'X-Title': 'Foundation Exam System',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw new LlmError(`Provider did not respond within ${Math.round(env.LLM_TIMEOUT_MS / 1000)}s. Try a smaller batch or a faster model.`);
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
      detail = parsed?.error?.message ?? parsed?.message ?? detail;
    } catch {
      /* keep the raw text */
    }
    const hint =
      res.status === 401 ? ' (check the API key in Admin > Settings)' :
      res.status === 402 ? ' (the provider account is out of credit)' :
      res.status === 404 ? ' (check the model name is exactly right for this provider)' :
      res.status === 429 ? ' (rate limited - wait a moment and retry)' : '';
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
export async function pingProvider(baseUrl: string, apiKey: string, model: string): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
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
