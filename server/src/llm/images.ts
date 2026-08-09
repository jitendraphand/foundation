import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { callParamsFor } from './credentials.js';
import { imageProblem } from './capabilities.js';
import { LlmError } from './providers.js';
import type { LlmImagePrompt } from './schema.js';

/**
 * Making the picture a question asks for.
 *
 * Every text provider here refuses to draw, which is why a question that needs
 * a photograph carries a ready-written prompt instead. Until now an
 * administrator had to take that prompt somewhere else, generate the image,
 * download it and upload it back - four steps and a context switch, per
 * question, which is why questions sat in the queue.
 *
 * This closes the loop. One button, same screen.
 *
 * Only the OpenAI images shape is spoken, because it is the one several
 * services agree on: OpenAI, Azure OpenAI and a number of the OpenAI-compatible
 * routers all expose /images/generations with the same body. Which credentials
 * are actually used for it is an administrator's choice per credential - see
 * llm/capabilities.ts - rather than a fixed list of provider names, because
 * whether a given account and model can draw is not visible from the provider.
 *
 * Bedrock, Vertex and OCI each have their own image API and their own request
 * shape; they are refused with the reason rather than half-supported.
 */

/** Which credential and model draw pictures. Chosen by an administrator. */
export const IMAGE_SETTING = 'images.provider';

export interface ImageConfig {
  credentialId: string;
  model?: string;
}

export async function getImageConfig(): Promise<ImageConfig | null> {
  const row = await prisma.setting.findUnique({ where: { key: IMAGE_SETTING } }).catch(() => null);
  const value = row?.value as Partial<ImageConfig> | null;
  return value?.credentialId ? { credentialId: value.credentialId, model: value.model } : null;
}

export async function setImageConfig(config: ImageConfig | null): Promise<void> {
  if (!config) {
    await prisma.setting.deleteMany({ where: { key: IMAGE_SETTING } });
    return;
  }
  const value = { credentialId: config.credentialId, ...(config.model ? { model: config.model } : {}) };
  await prisma.setting.upsert({
    where: { key: IMAGE_SETTING },
    update: { value },
    create: { key: IMAGE_SETTING, value },
  });
}

/**
 * The API takes one of a fixed set of sizes, not arbitrary pixels.
 *
 * The model's requested dimensions are a hint about shape rather than an
 * instruction, so the nearest supported aspect is chosen and the real size is
 * recorded on the asset afterwards. Asking for 800x600 verbatim is rejected.
 */
function nearestSize(widthPx: number, heightPx: number): '1024x1024' | '1536x1024' | '1024x1536' {
  const ratio = widthPx / Math.max(1, heightPx);
  if (ratio > 1.25) return '1536x1024';
  if (ratio < 0.8) return '1024x1536';
  return '1024x1024';
}

/** Everything a picture generator needs, in one string. */
export function flattenImagePrompt(spec: LlmImagePrompt): string {
  return [
    spec.prompt,
    spec.details.length ? `Must show: ${spec.details.join('; ')}.` : '',
    spec.style ? `Style: ${spec.style}.` : '',
    // Diagrams for an exam paper, not illustrations: text in a generated image
    // is unreliable, so the prompt says to keep it minimal rather than hoping.
    'This is a figure for a school examination question. It must be clear, unambiguous and free of decoration. ' +
      'Do not add any text, labels, watermarks or captions unless the description explicitly asks for them.',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface GeneratedImage {
  assetId: string;
  width: number;
  height: number;
  byteSize: number;
}

/**
 * Generates one picture and stores it as an asset, ready to attach.
 *
 * Content-addressed like an upload, so regenerating the same prompt twice does
 * not fill the disk with duplicates.
 */
export async function generateImage(spec: LlmImagePrompt): Promise<GeneratedImage> {
  const config = await getImageConfig();
  if (!config) {
    throw new LlmError(
      'No image provider is set up. Choose one under Settings > LLM providers > Image generation, ' +
        'or generate the picture elsewhere and upload it.',
    );
  }

  const credential = await prisma.apiCredential.findUnique({ where: { id: config.credentialId } });
  if (!credential || !credential.isActive) {
    throw new LlmError('The image provider is unavailable. Check it under Settings > LLM providers.');
  }
  const problem = imageProblem(credential);
  if (problem) throw new LlmError(problem);

  const call = await callParamsFor(credential);
  const model = config.model || 'gpt-image-1';
  const size = nearestSize(spec.widthPx, spec.heightPx);

  // Azure addresses a deployment in the path, exactly as it does for chat.
  const base = call.baseUrl.replace(/\/+$/, '');
  const url =
    call.dialect === 'azure'
      ? `${base}/openai/deployments/${encodeURIComponent(model)}/images/generations?api-version=${encodeURIComponent(call.azure?.apiVersion ?? '2024-10-21')}`
      : `${base}/images/generations`;

  const controller = new AbortController();
  // Image models are slower than text ones; a shared timeout would cut them off.
  const timer = setTimeout(() => controller.abort(), Math.max(env.LLM_TIMEOUT_MS, 120_000));

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(call.dialect === 'azure' ? { 'api-key': call.apiKey } : { Authorization: `Bearer ${call.apiKey}` }),
      },
      body: JSON.stringify({ model, prompt: flattenImagePrompt(spec), size, n: 1 }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new LlmError('The image provider did not respond in time.');
    throw new LlmError(`Could not reach the image provider: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 500);
    try {
      detail = JSON.parse(text)?.error?.message ?? detail;
    } catch {
      /* keep raw */
    }
    const hint =
      res.status === 403 && /moderation|safety|content/i.test(detail)
        ? ' (the prompt was refused by the provider\'s content filter - reword the description)'
        : res.status === 404
          ? ' (no such image model or deployment)'
          : '';
    throw new LlmError(`The image provider returned ${res.status}${hint}: ${detail}`, res.status, text);
  }

  const json = JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string }> };
  const first = json.data?.[0];
  if (!first) throw new LlmError('The image provider returned no image.');

  // gpt-image-1 always returns base64; the older models return a URL that
  // expires, so it is fetched immediately rather than stored as a link.
  let buffer: Buffer;
  if (first.b64_json) {
    buffer = Buffer.from(first.b64_json, 'base64');
  } else if (first.url) {
    const download = await fetch(first.url);
    if (!download.ok) throw new LlmError('The generated image could not be downloaded before its link expired.');
    buffer = Buffer.from(await download.arrayBuffer());
  } else {
    throw new LlmError('The image provider returned neither image data nor a link.');
  }

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await prisma.asset.findFirst({ where: { sha256: sha } });
  if (existing) {
    return {
      assetId: existing.id,
      width: existing.width ?? 0,
      height: existing.height ?? 0,
      byteSize: existing.byteSize,
    };
  }

  const [width, height] = size.split('x').map(Number);
  const storageKey = `${sha.slice(0, 2)}/${sha}.png`;
  const target = path.join(env.UPLOAD_DIR, storageKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);

  const asset = await prisma.asset.create({
    data: {
      kind: 'IMAGE',
      mimeType: 'image/png',
      byteSize: buffer.byteLength,
      sha256: sha,
      storageKey,
      width,
      height,
      altText: spec.altText ?? '',
    },
  });

  return { assetId: asset.id, width, height, byteSize: buffer.byteLength };
}
