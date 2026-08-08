import { env } from '../env.js';
import { signOciRequest, ociEndpoint, type OciCredentials } from './oci-signer.js';
import { LlmError, type ChatMessage, type ChatResponse } from './providers.js';

/**
 * Oracle Cloud Infrastructure Generative AI.
 *
 * The second provider here that does not speak OpenAI's chat/completions, and
 * the only one that also signs its requests. Its chat API is a single action:
 *
 *   POST https://inference.generativeai.{region}.oci.oraclecloud.com
 *        /20231130/actions/chat
 *
 * The body carries a servingMode naming the model, a compartment to bill, and
 * a chatRequest whose shape depends on the model family. Oracle hosts models
 * from several vendors behind one endpoint and does not normalise between
 * them: Cohere models take a single message plus chatHistory, everything else
 * takes a GENERIC message list. Getting this wrong returns a validation error
 * about a field the caller never sent, so the family is chosen from the model
 * id rather than guessed.
 */

export interface OciRequest {
  credentials: OciCredentials;
  baseUrl?: string;
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

/**
 * Which request dialect a model wants.
 *
 * Cohere's models predate the generic shape and keep their own. Meta, xAI and
 * Mistral models on OCI all take GENERIC.
 */
function apiFormatFor(modelId: string): 'COHERE' | 'GENERIC' {
  return /(^|\.)cohere\b|command/i.test(modelId) ? 'COHERE' : 'GENERIC';
}

function toChatRequest(req: OciRequest) {
  const format = apiFormatFor(req.modelId);
  const maxTokens = req.maxTokens ?? 8000;
  const temperature = req.temperature ?? 0.4;

  if (format === 'COHERE') {
    // Cohere takes the latest turn separately from the history, and its own
    // role spelling. System turns become a preamble.
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const conversation = req.messages.filter((m) => m.role !== 'system');
    const latest = conversation[conversation.length - 1];

    return {
      apiFormat: 'COHERE',
      message: latest?.content ?? '',
      chatHistory: conversation.slice(0, -1).map((m) => ({
        role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
        message: m.content,
      })),
      ...(system ? { preambleOverride: system } : {}),
      maxTokens,
      temperature,
      isStream: false,
    };
  }

  return {
    apiFormat: 'GENERIC',
    messages: req.messages.map((m) => ({
      role: m.role.toUpperCase(), // SYSTEM | USER | ASSISTANT
      content: [{ type: 'TEXT', text: m.content }],
    })),
    maxTokens,
    temperature,
    isStream: false,
  };
}

export async function ociChat(req: OciRequest): Promise<ChatResponse> {
  const url = ociEndpoint(req.credentials.region, req.baseUrl);
  const body = JSON.stringify({
    compartmentId: req.credentials.compartmentId,
    servingMode: { servingType: 'ON_DEMAND', modelId: req.modelId },
    chatRequest: toChatRequest(req),
  });

  const started = Date.now();
  const headers = signOciRequest({ method: 'POST', url, body }, req.credentials);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new LlmError(
        `Oracle Cloud did not respond within ${Math.round(env.LLM_TIMEOUT_MS / 1000)}s. Try a smaller batch or a faster model.`,
      );
    }
    throw new LlmError(`Could not reach Oracle Cloud: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw ociError(res, text, req);

  let json: OciChatResponse;
  try {
    json = JSON.parse(text) as OciChatResponse;
  } catch {
    throw new LlmError('Oracle Cloud returned a response that was not valid JSON.', res.status, text.slice(0, 2000));
  }

  const content = extractText(json).trim();
  if (!content) {
    const stop = json.chatResponse?.finishReason ? ` (finish reason: ${json.chatResponse.finishReason})` : '';
    throw new LlmError(`Oracle Cloud returned an empty message${stop}.`, res.status, text.slice(0, 2000));
  }

  return {
    text: content,
    promptTokens: json.chatResponse?.usage?.promptTokens,
    completionTokens: json.chatResponse?.usage?.completionTokens,
    latencyMs: Date.now() - started,
  };
}

interface OciChatResponse {
  chatResponse?: {
    /** Cohere replies here. */
    text?: string;
    /** GENERIC replies here. */
    choices?: Array<{ message?: { content?: Array<{ text?: string }> } }>;
    finishReason?: string;
    usage?: { promptTokens?: number; completionTokens?: number };
  };
}

/** Both reply shapes, read without the caller having to know which came back. */
function extractText(json: OciChatResponse): string {
  const chat = json.chatResponse;
  if (!chat) return '';
  if (typeof chat.text === 'string') return chat.text;
  return (chat.choices ?? [])
    .flatMap((c) => c.message?.content ?? [])
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * OCI's failures are specific and its raw messages are terse. The commonest by
 * far is a model not being available in the chosen region, which reads as a
 * plain 404 and looks like a wrong endpoint.
 */
function ociError(res: Response, text: string, req: OciRequest): LlmError {
  let detail = text.slice(0, 600);
  let code = '';
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.message ?? detail;
    code = parsed?.code ?? '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail).slice(0, 600);
  } catch {
    /* keep raw */
  }

  const where = `${req.modelId} in ${req.credentials.region}`;

  const hint =
    res.status === 401 && /signature|verify/i.test(detail + code)
      ? ' (the signature was rejected - check the private key matches the fingerprint on the API key, and that the clock on this server is right)'
      : res.status === 401
        ? ' (the tenancy, user or fingerprint is wrong, or the API key has been deleted)'
        : res.status === 404 || code === 'NotAuthorizedOrNotFound'
          ? ` (either ${where} does not exist, or the user has no policy allowing generative-ai-family use in that compartment - OCI returns the same 404 for both, deliberately)`
          : res.status === 400 && /compartment/i.test(detail)
            ? ' (the compartment OCID is wrong, or the model is not enabled in it)'
            : res.status === 429
              ? ' (Oracle is throttling - wait a moment, or ask for a higher limit on this model)'
              : '';

  return new LlmError(`Oracle Cloud returned ${res.status}${hint}: ${detail}`, res.status, text);
}
