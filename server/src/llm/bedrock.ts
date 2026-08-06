import { env } from '../env.js';
import { signRequest } from './aws-sigv4.js';
import { LlmError, type ChatMessage, type ChatResponse } from './providers.js';

/**
 * Amazon Bedrock.
 *
 * The one provider here that does not speak OpenAI's chat/completions. It has
 * its own message API - Converse - which is model-agnostic: the same request
 * shape works for Claude, Nova, Llama, Mistral and the rest, so one adapter
 * covers everything Bedrock hosts rather than one per model family.
 *
 *   POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse
 *
 * Two ways to authenticate, both accepted by the service:
 *
 *   apiKey  - a bearer token generated in the Bedrock console. Simplest, and
 *             the one to use unless there is a reason not to.
 *   sigv4   - ordinary IAM access key and secret, signed per request. Needed
 *             where the school's AWS account does not allow long-lived API
 *             keys, and the only option for temporary STS credentials.
 *
 * Endpoint, path and auth schemes are taken from the service definition AWS
 * publishes with its own SDK, not from prose documentation.
 */

export type BedrockAuth =
  | { mode: 'apiKey'; apiKey: string }
  | { mode: 'sigv4'; accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export interface BedrockConfig {
  region: string;
  auth: BedrockAuth;
  /**
   * Overrides the derived host. Normally the regional endpoint, but a school
   * routing Bedrock through a VPC endpoint or an internal proxy has a
   * different one - and the signature covers whatever host is actually used.
   */
  baseUrl?: string;
}

export interface BedrockRequest {
  config: BedrockConfig;
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/** RFC 3986 escaping for a path segment, matching what the AWS SDK sends. */
function escapeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function bedrockEndpoint(region: string, modelId: string, baseUrl?: string): string {
  // The China and GovCloud partitions use different suffixes; everything else
  // is amazonaws.com. Handled here so a school in those partitions only has to
  // pick their region.
  const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  const host = (baseUrl || `https://bedrock-runtime.${region}.${suffix}`).replace(/\/+$/, '');
  return `${host}/model/${escapeSegment(modelId)}/converse`;
}

/**
 * Converse keeps system prompts out of the message list and requires the
 * conversation to alternate, starting with the user. Our messages already do
 * that - the repair rounds append assistant then user - so this only has to
 * lift the system turns out.
 */
function toConverseBody(req: BedrockRequest) {
  const system = req.messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
  const messages = req.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: [{ text: m.content }] }));

  return {
    ...(system.length ? { system } : {}),
    messages,
    inferenceConfig: {
      maxTokens: req.maxTokens ?? 8000,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
  };
}

export async function bedrockChat(req: BedrockRequest): Promise<ChatResponse> {
  const url = bedrockEndpoint(req.config.region, req.modelId, req.config.baseUrl);
  const body = JSON.stringify(toConverseBody(req));
  const started = Date.now();

  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };

  const headers =
    req.config.auth.mode === 'apiKey'
      ? { ...baseHeaders, authorization: `Bearer ${req.config.auth.apiKey}` }
      : signRequest(
          { method: 'POST', url, headers: baseHeaders, body, region: req.config.region, service: 'bedrock' },
          {
            accessKeyId: req.config.auth.accessKeyId,
            secretAccessKey: req.config.auth.secretAccessKey,
            sessionToken: req.config.auth.sessionToken,
          },
        );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new LlmError(
        `Bedrock did not respond within ${Math.round(env.LLM_TIMEOUT_MS / 1000)}s. Try a smaller batch or a faster model.`,
      );
    }
    throw new LlmError(`Could not reach Bedrock: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) throw bedrockError(res, text, req);

  let json: {
    output?: { message?: { content?: Array<{ text?: string }> } };
    usage?: { inputTokens?: number; outputTokens?: number };
    stopReason?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError('Bedrock returned a response that was not valid JSON.', res.status, text.slice(0, 2000));
  }

  // Only text blocks. A reasoning model also returns reasoningContent blocks,
  // which are its working rather than its answer - dropping them here is the
  // Bedrock equivalent of stripping <think> from the other providers.
  const content = (json.output?.message?.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim();

  if (!content) {
    const stop = json.stopReason ? ` (stop reason: ${json.stopReason})` : '';
    throw new LlmError(`Bedrock returned an empty message${stop}.`, res.status, text.slice(0, 2000));
  }

  return {
    text: content,
    promptTokens: json.usage?.inputTokens,
    completionTokens: json.usage?.outputTokens,
    latencyMs: Date.now() - started,
  };
}

/**
 * Bedrock's failures are specific enough to be worth naming. "Access denied"
 * on a model almost always means the model has not been enabled in that
 * region, which is a console step nobody guesses from the raw message.
 */
function bedrockError(res: Response, text: string, req: BedrockRequest): LlmError {
  let detail = text.slice(0, 600);
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.message ?? parsed?.Message ?? parsed?.error ?? detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail).slice(0, 600);
  } catch {
    /* keep the raw text */
  }

  const type = res.headers.get('x-amzn-errortype')?.split(':')[0] ?? '';
  const where = `${req.modelId} in ${req.config.region}`;

  const hint =
    res.status === 403 && /api key|authentication failed/i.test(detail)
      ? ' (the Bedrock API key is wrong or has been revoked - generate a new one under Bedrock > API keys)'
      : res.status === 403 && /security token|signature|credential/i.test(detail)
        ? ' (the access key or secret is wrong, or the clock on this server is out by more than a few minutes)'
      : res.status === 403 || type === 'AccessDeniedException'
        ? ` (the credential is valid but not allowed to invoke ${where} - enable the model under Bedrock > Model access in that region, and allow bedrock:InvokeModel)`
        : res.status === 404 || type === 'ResourceNotFoundException'
          ? ` (no such model in this region: check ${where}, and note that some models are only reachable through a cross-region inference profile id such as us.anthropic...)`
          : res.status === 400 && /on-demand|inference profile/i.test(detail)
            ? ' (this model cannot be called directly - use its inference profile id, which usually starts with us. eu. or apac.)'
            : res.status === 429 || type === 'ThrottlingException'
              ? ' (Bedrock is throttling - wait a moment, or ask AWS to raise the quota for this model)'
              : res.status === 424 || type === 'ModelErrorException'
                ? ' (the model itself failed to respond)'
                : '';

  return new LlmError(`Bedrock returned ${res.status}${hint}: ${detail}`, res.status, text);
}
