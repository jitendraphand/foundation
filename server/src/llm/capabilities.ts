import type { ApiCredential } from '@prisma/client';
import { PROVIDERS } from './providers.js';

/**
 * What each saved credential is allowed to be used for.
 *
 * A key is not a capability. The same OpenAI key can write questions and draw
 * pictures; an OpenRouter key can write questions and, depending on the model
 * behind it, draw as well; a school may hold a second key it wants used only
 * for pictures so the image spend is separate on the bill. None of that is
 * visible from the provider name, so it is a per-credential setting rather than
 * a hard-coded list of which services can draw.
 *
 * Two things it is NOT:
 *
 *   - a claim about the model. Ticking "images" on a credential whose model
 *     cannot draw gets an error from the provider, which is the right place for
 *     that to be discovered.
 *   - a way round a protocol we do not speak. Bedrock, Vertex and Oracle all
 *     generate images, through three different APIs that share nothing with the
 *     OpenAI one; ticking a box cannot make those work, so the box is refused
 *     with the reason rather than offered and then failing.
 */

export interface Capabilities {
  /** Writes questions. Every provider here can, so this is on unless turned off. */
  text: boolean;
  /** Draws pictures through POST {base}/images/generations. */
  images: boolean;
}

/**
 * Whether a provider can be asked to draw at all, before any admin choice.
 *
 *   yes    the OpenAI images endpoint, and on by default - this is what the
 *          service is normally used for
 *   maybe  the endpoint may exist depending on the model or the deployment, so
 *          it is offered but off until somebody ticks it
 *   no     the service does generate images, through an API that shares nothing
 *          with the OpenAI one. Not implemented, so not offered.
 */
export type ImageSupport = 'yes' | 'maybe' | 'no';

const IMAGE_SUPPORT: Record<string, ImageSupport> = {
  openai: 'yes',
  azure: 'yes',
  // OpenAI-shaped routers and gateways. Several of them do proxy an image
  // endpoint; whether a given account and model can reach it is not something
  // we can know from here, so it is the administrator's call.
  openrouter: 'maybe',
  nvidia: 'maybe',
  huggingface: 'maybe',
  google: 'maybe',
  custom: 'maybe',
  // Amazon Titan / Nova Canvas, Google Imagen and Oracle's own image service:
  // three separate protocols, none of them /images/generations.
  bedrock: 'no',
  vertex: 'no',
  oci: 'no',
};

export function imageSupportOf(provider: string): ImageSupport {
  return IMAGE_SUPPORT[provider] ?? 'maybe';
}

/** The tick boxes a credential starts with, before anybody changes them. */
export function defaultCapabilities(provider: string): Capabilities {
  return { text: true, images: imageSupportOf(provider) === 'yes' };
}

/**
 * What this credential may be used for now.
 *
 * A stored `images: true` on a provider whose image API we cannot speak is
 * ignored rather than honoured - that can only come from a provider being
 * reclassified after the fact, and the alternative is a button that produces a
 * 404 nobody can explain.
 */
export function capabilitiesOf(credential: Pick<ApiCredential, 'provider' | 'meta'>): Capabilities {
  const stored = ((credential.meta ?? {}) as { capabilities?: Partial<Capabilities> }).capabilities ?? {};
  const fallback = defaultCapabilities(credential.provider);

  return {
    text: stored.text ?? fallback.text,
    images: imageSupportOf(credential.provider) === 'no' ? false : stored.images ?? fallback.images,
  };
}

/** Why a credential cannot be used to draw, in words, or null when it can. */
export function imageProblem(credential: Pick<ApiCredential, 'provider' | 'meta'>): string | null {
  const label = PROVIDERS[credential.provider]?.label ?? credential.provider;

  if (imageSupportOf(credential.provider) === 'no') {
    return (
      `${label} generates images through its own API rather than the OpenAI one, which this system does not ` +
      'speak. Use an OpenAI or Azure OpenAI credential for pictures, or make them elsewhere and upload them.'
    );
  }
  if (!capabilitiesOf(credential).images) {
    return `${label} is not ticked for images. Tick "Images" beside it under Settings > LLM providers.`;
  }
  return null;
}
