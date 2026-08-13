import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { audit } from '../../middleware/auth.js';
import { encryptSecret, keyHint } from '../../lib/crypto.js';
import { PROVIDERS, describeKeyProblem, pingProvider, DEFAULT_AZURE_API_VERSION } from '../../llm/providers.js';
import { parseServiceAccount, vertexBaseUrl } from '../../llm/google-auth.js';
import { looksLikeOcid } from '../../llm/oci-signer.js';
import { getStepUpConfig, setStepUpConfig, DEFAULT_STEP_UP_QUOTA } from '../../llm/step-up.js';
import { getImageConfig, setImageConfig } from '../../llm/images.js';
import { capabilitiesOf, imageProblem, imageSupportOf } from '../../llm/capabilities.js';
import { callParamsFor, packIamSecret } from '../../llm/credentials.js';
import { buildChatRequest } from '../../llm/providers.js';
import { resolveCeiling } from '../../llm/limits.js';
import { modelTuningSchema, reservedKeysIn } from '../../llm/tuning.js';
import { trialGeneration } from '../../llm/generate.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE } from '../../llm/prompts.js';
import { COMMON_TIMEZONES, WINDOW_PRESETS, isValidTimezone, zonedNow, formatMinute } from '../../lib/availability.js';
import { getSchoolTimezone, setSchoolTimezone } from '../../services/settings.js';

/**
 * Bedrock needs more than a key: a region, and a choice of how to authenticate.
 * Assembled here so create and update cannot drift apart.
 */
interface BedrockFields {
  baseUrl: string;
  secret: string;
  meta: { authMode: 'apiKey' | 'sigv4'; region: string; accessKeyId?: string };
}

/** AWS regions, roughly - enough to catch a typo, not to gatekeep new ones. */
const REGION_SHAPE = /^[a-z]{2}(-[a-z]+)+-\d$/;

function buildBedrockFields(body: {
  apiKey: string;
  region?: string;
  awsAuthMode?: 'apiKey' | 'sigv4';
  accessKeyId?: string;
  sessionToken?: string;
}): BedrockFields | { error: string } {
  const region = body.region?.trim();
  if (!region) {
    return { error: 'Amazon Bedrock needs a region, for example us-east-1. Bedrock has a separate endpoint in each one.' };
  }
  if (!REGION_SHAPE.test(region)) {
    return { error: `"${region}" does not look like an AWS region. They look like us-east-1, eu-west-2 or ap-south-1.` };
  }

  const mode = body.awsAuthMode ?? 'apiKey';
  const suffix = region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  const baseUrl = `https://bedrock-runtime.${region}.${suffix}`;

  if (mode === 'apiKey') {
    return { baseUrl, secret: body.apiKey, meta: { authMode: 'apiKey', region } };
  }

  const accessKeyId = body.accessKeyId?.trim();
  if (!accessKeyId) {
    return { error: 'Signing with IAM credentials needs the access key ID as well as the secret access key.' };
  }
  // AKIA is a long-lived key, ASIA a temporary one from STS. Catching a
  // swapped pair here saves a SignatureDoesNotMatch that explains nothing.
  if (/^[A-Za-z0-9/+=]{40}$/.test(accessKeyId) && accessKeyId.length === 40) {
    return { error: 'That looks like the secret access key in the access key ID box. The ID is the shorter one, starting AKIA or ASIA.' };
  }

  return {
    baseUrl,
    // Secret access key and session token are packed together and encrypted;
    // neither is ever stored in plain text.
    secret: packIamSecret(body.apiKey, body.sessionToken || undefined),
    meta: { authMode: 'sigv4', region, accessKeyId },
  };
}

/**
 * Azure addresses a resource by hostname; the deployment name goes in the
 * model box, not here. Accepts either the bare resource name or the full URL,
 * because an administrator copying from the portal will have the URL.
 */
function buildAzureFields(body: { resourceName?: string; baseUrl?: string; apiVersion?: string }):
  | { baseUrl: string; meta: { apiVersion: string } }
  | { error: string } {
  const raw = (body.baseUrl || body.resourceName || '').trim();
  if (!raw) {
    return {
      error:
        'Azure OpenAI needs the resource name or its endpoint URL - the bit before .openai.azure.com, ' +
        'shown as "Endpoint" on the resource overview in the portal.',
    };
  }

  let baseUrl: string;
  if (/^https?:\/\//i.test(raw)) {
    try {
      baseUrl = new URL(raw).origin;
    } catch {
      return { error: `"${raw}" is not a valid URL.` };
    }
  } else if (/^[a-z0-9][a-z0-9-]{1,62}$/i.test(raw)) {
    baseUrl = `https://${raw.toLowerCase()}.openai.azure.com`;
  } else {
    return {
      error: `"${raw}" is not a resource name or a URL. A resource name is letters, digits and hyphens, e.g. my-school-openai.`,
    };
  }

  const apiVersion = (body.apiVersion || DEFAULT_AZURE_API_VERSION).trim();
  if (!/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(apiVersion)) {
    return { error: `"${apiVersion}" is not an Azure API version. They look like 2024-10-21 or 2025-01-01-preview.` };
  }

  return { baseUrl, meta: { apiVersion } };
}

/**
 * Vertex takes the whole downloaded service-account JSON as its "key". The
 * project comes out of the file itself, so the administrator only has to
 * choose a region.
 */
function buildVertexFields(body: { apiKey: string; region?: string }):
  | { baseUrl: string; meta: { projectId: string; region: string; clientEmail: string } }
  | { error: string } {
  const region = (body.region || '').trim();
  if (!region) {
    return { error: 'Vertex AI needs a region, for example us-central1 or europe-west4. Models are enabled per region.' };
  }
  if (!/^[a-z]+-[a-z]+\d$/.test(region)) {
    return { error: `"${region}" does not look like a Google Cloud region. They look like us-central1 or asia-south1.` };
  }

  let account;
  try {
    account = parseServiceAccount(body.apiKey);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'That service-account key could not be read.' };
  }

  return {
    baseUrl: vertexBaseUrl(account.project_id, region),
    meta: { projectId: account.project_id, region, clientEmail: account.client_email },
  };
}

/**
 * Oracle needs five identifiers plus a private key. Normally all of them are
 * pasted from the config file Oracle offers to generate on the API key page,
 * so each is validated for what it actually is - a tenancy OCID in the user
 * box is the easiest mistake to make and produces a bare 401.
 */
function buildOciFields(body: {
  apiKey: string;
  tenancyId?: string;
  userId?: string;
  fingerprint?: string;
  region?: string;
  compartmentId?: string;
}):
  | { baseUrl: string; meta: { tenancyId: string; userId: string; fingerprint: string; region: string; compartmentId: string } }
  | { error: string } {
  const region = (body.region || '').trim().toLowerCase();
  if (!region) {
    return { error: 'Oracle Cloud needs a region, for example us-chicago-1 or eu-frankfurt-1. Models are available per region.' };
  }
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) {
    return { error: `"${region}" does not look like an OCI region. They look like us-chicago-1, eu-frankfurt-1 or ap-mumbai-1.` };
  }

  const tenancyId = (body.tenancyId || '').trim();
  const userId = (body.userId || '').trim();
  const compartmentId = (body.compartmentId || '').trim() || tenancyId;

  for (const [value, kind] of [
    [tenancyId, 'tenancy'],
    [userId, 'user'],
    [compartmentId, 'compartment'],
  ] as const) {
    const problem = looksLikeOcid(value, kind);
    if (problem) return { error: problem };
  }

  const fingerprint = (body.fingerprint || '').trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/.test(fingerprint)) {
    return {
      error:
        'The fingerprint should be sixteen pairs of hex digits separated by colons, exactly as shown beside the API key in the console.',
    };
  }

  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(body.apiKey.trim())) {
    return {
      error:
        'Paste the private key PEM file that was downloaded when you created the API key, starting with -----BEGIN. ' +
        'It must not be passphrase-protected.',
    };
  }

  return {
    baseUrl: `https://inference.generativeai.${region}.oci.oraclecloud.com`,
    meta: { tenancyId, userId, fingerprint, region, compartmentId },
  };
}

export default async function adminSettingsRoutes(app: FastifyInstance) {
  // --- LLM API credentials -------------------------------------------------

  app.get('/api/admin/credentials', async () => {
    const credentials = await prisma.apiCredential.findMany({
      orderBy: { createdAt: 'asc' },
      // encryptedKey is deliberately never selected. meta is safe: it holds
      // the region, the auth mode and the access key id - the things an
      // administrator needs to tell two Bedrock credentials apart - and never
      // the secret.
      select: {
        id: true, provider: true, label: true, baseUrl: true, keyHint: true,
        defaultModel: true, isActive: true, createdAt: true, updatedAt: true, meta: true,
      },
    });
    return {
      // Capabilities are derived, not stored twice: the row carries whatever an
      // administrator ticked, and this resolves it against what the provider
      // can actually be asked to do. imageSupport tells the UI whether the
      // Images tick can be offered at all.
      credentials: credentials.map((c) => ({
        ...c,
        capabilities: capabilitiesOf(c),
        imageSupport: imageSupportOf(c.provider),
      })),
      providers: Object.values(PROVIDERS),
    };
  });

  app.post('/api/admin/credentials', async (request, reply) => {
    const body = z
      .object({
        provider: z.string().min(1).max(40),
        label: z.string().trim().min(1).max(100),
        apiKey: z.string().trim().min(8).max(500),
        baseUrl: z.string().url().optional(),
        defaultModel: z.string().max(200).optional(),

        // Bedrock only. It has one endpoint per region and two ways in: a
        // bearer API key, or an IAM key pair signed per request.
        region: z.string().trim().max(40).optional(),
        awsAuthMode: z.enum(['apiKey', 'sigv4']).optional(),
        accessKeyId: z.string().trim().max(128).optional(),
        sessionToken: z.string().trim().max(4096).optional(),

        // Azure: the resource, and the dated API surface it exposes.
        resourceName: z.string().trim().max(120).optional(),
        apiVersion: z.string().trim().max(40).optional(),

        // Oracle Cloud: the identity triple, plus what to bill.
        tenancyId: z.string().trim().max(200).optional(),
        userId: z.string().trim().max(200).optional(),
        fingerprint: z.string().trim().max(100).optional(),
        compartmentId: z.string().trim().max(200).optional(),
      })
      // A service-account JSON file is far longer than any bearer token.
      .extend({ apiKey: z.string().trim().min(8).max(8192) })
      .parse(request.body);

    const def = PROVIDERS[body.provider];

    let bedrock: BedrockFields | null = null;
    let derivedBaseUrl: string | undefined;
    let derivedMeta: Prisma.InputJsonValue | undefined;

    if (body.provider === 'bedrock') {
      const built = buildBedrockFields(body);
      if ('error' in built) return reply.code(400).send({ error: built.error });
      bedrock = built;
    }

    if (body.provider === 'azure') {
      const built = buildAzureFields(body);
      if ('error' in built) return reply.code(400).send({ error: built.error });
      derivedBaseUrl = built.baseUrl;
      derivedMeta = built.meta;
    }

    if (body.provider === 'vertex') {
      const built = buildVertexFields(body);
      if ('error' in built) return reply.code(400).send({ error: built.error });
      derivedBaseUrl = built.baseUrl;
      derivedMeta = built.meta;
    }

    if (body.provider === 'oci') {
      const built = buildOciFields(body);
      if ('error' in built) return reply.code(400).send({ error: built.error });
      derivedBaseUrl = built.baseUrl;
      derivedMeta = built.meta;
    }

    const baseUrl = body.baseUrl ?? derivedBaseUrl ?? bedrock?.baseUrl ?? def?.defaultBaseUrl;
    if (!baseUrl) {
      return reply.code(400).send({ error: 'A base URL is required for a custom provider.' });
    }

    // Caught here rather than three screens later as a 401 from the provider.
    const keyProblem = describeKeyProblem(body.provider, body.apiKey);
    if (keyProblem.error) return reply.code(400).send({ error: keyProblem.error });

    const secret = bedrock?.secret ?? body.apiKey;

    const credential = await prisma.apiCredential.create({
      data: {
        provider: body.provider,
        label: body.label,
        baseUrl,
        encryptedKey: encryptSecret(secret),
        // The hint is of the key the admin actually typed, not the packed
        // blob, so it still matches what they can see in the AWS console.
        keyHint: keyHint(body.apiKey),
        defaultModel: body.defaultModel ?? def?.suggestedModels[0] ?? null,
        ...(bedrock ? { meta: bedrock.meta } : derivedMeta ? { meta: derivedMeta } : {}),
      },
      select: { id: true, provider: true, label: true, baseUrl: true, keyHint: true, defaultModel: true, isActive: true, meta: true },
    });

    await audit(request.user!.sub, 'credential.create', {
      entity: 'ApiCredential', entityId: credential.id, ip: request.ip,
      detail: { provider: body.provider, label: body.label }, // never the key
    });

    return reply.code(201).send({ ok: true, credential, warning: keyProblem.warning });
  });

  app.patch('/api/admin/credentials/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(100).optional(),
        apiKey: z.string().trim().min(8).max(500).optional(),
        baseUrl: z.string().url().optional(),
        defaultModel: z.string().max(200).optional(),
        isActive: z.boolean().optional(),
        /** Offer this credential when the chosen one will not answer. */
        useAsFallback: z.boolean().optional(),
        /**
         * The largest completion this endpoint accepts, when the administrator
         * knows it. Null clears the override and hands the decision back to
         * whatever the provider refused last (see llm/limits.ts).
         */
        maxOutputTokens: z.number().int().min(256).max(200_000).nullable().optional(),
        /**
         * What this credential may be used for. Sent whole, because "text off,
         * images on" is a meaningful state and a partial update could not
         * express turning the last one off. See llm/capabilities.ts.
         */
        capabilities: z.object({ text: z.boolean(), images: z.boolean() }).optional(),
        /**
         * The per-model settings; see llm/tuning.ts. Sent whole, because it is
         * edited as one form and a partial update could not express clearing a
         * field back to the default.
         */
        tuning: modelTuningSchema.optional(),

        region: z.string().trim().max(40).optional(),
        awsAuthMode: z.enum(['apiKey', 'sigv4']).optional(),
        accessKeyId: z.string().trim().max(128).optional(),
        sessionToken: z.string().trim().max(4096).optional(),
      })
      .parse(request.body);

    const existing = await prisma.apiCredential.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Credential not found.' });

    const keyProblem = body.apiKey ? describeKeyProblem(existing.provider, body.apiKey) : {};
    if (keyProblem.error) return reply.code(400).send({ error: keyProblem.error });

    // Bedrock's region and auth mode travel with the key, so a new key means
    // rebuilding the whole set rather than swapping one field.
    let bedrock: BedrockFields | null = null;
    if (existing.provider === 'bedrock' && body.apiKey) {
      const meta = (existing.meta ?? {}) as { region?: string; authMode?: 'apiKey' | 'sigv4'; accessKeyId?: string };
      const built = buildBedrockFields({
        apiKey: body.apiKey,
        region: body.region ?? meta.region,
        awsAuthMode: body.awsAuthMode ?? meta.authMode,
        accessKeyId: body.accessKeyId ?? meta.accessKeyId,
        sessionToken: body.sessionToken,
      });
      if ('error' in built) return reply.code(400).send({ error: built.error });
      bedrock = built;
    }

    // Merged rather than replaced: meta also carries the region, the project,
    // the auth mode and any output-token ceilings learned from this provider
    // refusing a request, and overwriting it would break the credential.
    const meta: Record<string, unknown> = { ...((existing.meta ?? {}) as object) };
    let metaChanged = false;

    if (body.useAsFallback !== undefined) {
      meta.useAsFallback = body.useAsFallback;
      metaChanged = true;
    }
    if (body.maxOutputTokens !== undefined) {
      // Null means "stop overriding", which has to remove the key rather than
      // store a null - resolveCeiling reads the key's presence.
      if (body.maxOutputTokens === null) delete meta.maxOutputTokens;
      else meta.maxOutputTokens = body.maxOutputTokens;
      metaChanged = true;
    }

    if (body.tuning) {
      // Said out loud rather than dropped: an administrator who pasted a whole
      // request body would otherwise watch half of it vanish without a word.
      const reserved = reservedKeysIn(body.tuning.extraBody);
      if (reserved.length > 0) {
        return reply.code(400).send({
          error:
            `Extra request fields cannot include ${reserved.join(', ')} - the server sets ${reserved.length === 1 ? 'that one' : 'those'} ` +
            'itself from the prompt and the reply limit. Remove them and save again.',
        });
      }
      meta.tuning = body.tuning;
      metaChanged = true;
    }

    if (body.capabilities) {
      if (!body.capabilities.text && !body.capabilities.images) {
        return reply.code(400).send({
          error: 'A credential has to be used for something. Tick text, images, or both — or delete it.',
        });
      }
      // Refused rather than stored and ignored: the tick would sit there
      // looking enabled while the button it controls kept failing.
      if (body.capabilities.images && imageSupportOf(existing.provider) === 'no') {
        return reply.code(400).send({ error: imageProblem(existing)! });
      }
      meta.capabilities = body.capabilities;
      metaChanged = true;
    }

    // Rotating a Bedrock key rebuilds its region and auth mode, which are also
    // in meta - so they are merged in here rather than assigned as a whole new
    // meta object. Assigning would silently drop the fallback flag and every
    // learned ceiling every time somebody pasted a new key.
    if (bedrock) {
      Object.assign(meta, bedrock.meta);
      metaChanged = true;
    }

    const credential = await prisma.apiCredential.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(metaChanged ? { meta: meta as never } : {}),
        ...(body.apiKey
          ? {
              encryptedKey: encryptSecret(bedrock?.secret ?? body.apiKey),
              keyHint: keyHint(body.apiKey),
              ...(bedrock ? { baseUrl: body.baseUrl ?? bedrock.baseUrl } : {}),
            }
          : {}),
      },
      select: { id: true, provider: true, label: true, baseUrl: true, keyHint: true, defaultModel: true, isActive: true, meta: true },
    });

    await audit(request.user!.sub, 'credential.update', { entity: 'ApiCredential', entityId: id, ip: request.ip });
    return { ok: true, credential, warning: keyProblem.warning };
  });

  app.delete('/api/admin/credentials/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await prisma.apiCredential.delete({ where: { id } });
    await audit(request.user!.sub, 'credential.delete', { entity: 'ApiCredential', entityId: id, ip: request.ip });
    return { ok: true };
  });

  /** "Test connection" - proves the key works before a real generation run. */
  app.post('/api/admin/credentials/:id/test', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ model: z.string().max(200).optional() }).parse(request.body ?? {});

    const credential = await prisma.apiCredential.findUnique({ where: { id } });
    if (!credential) return reply.code(404).send({ error: 'Credential not found.' });

    const model = body.model || credential.defaultModel || PROVIDERS[credential.provider]?.suggestedModels[0];
    if (!model) return reply.code(400).send({ error: 'Choose a model to test with.' });

    let call: Awaited<ReturnType<typeof callParamsFor>>;
    try {
      call = await callParamsFor(credential);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Could not read the stored key.' };
    }

    // Say what is wrong with the stored key rather than letting the provider
    // answer "missing authentication header", which sounds like our bug.
    // A Bedrock IAM credential stores a packed blob, so the shape check runs
    // against the key the admin typed, which is what call.apiKey holds for
    // every mode except sigv4.
    if (call.apiKey) {
      const stored = describeKeyProblem(credential.provider, call.apiKey);
      if (stored.error) return { ok: false, message: `The saved key cannot work. ${stored.error}` };
    }

    return pingProvider({ ...call, model });
  });

  /**
   * The check that matters: two real questions, through the real prompt.
   *
   * Slower and more expensive than the ping, so it is a separate button rather
   * than something that happens on every page load - but it is the only check
   * that answers the question an administrator is actually asking, which is
   * "will this thing generate a paper".
   */
  app.post('/api/admin/credentials/:id/trial', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ model: z.string().max(200).optional() }).parse(request.body ?? {});

    const credential = await prisma.apiCredential.findUnique({ where: { id } });
    if (!credential) return reply.code(404).send({ error: 'Credential not found.' });

    const model = body.model || credential.defaultModel || PROVIDERS[credential.provider]?.suggestedModels[0];
    if (!model) return reply.code(400).send({ error: 'Choose a model to test with.' });

    const result = await trialGeneration({ credential, model });
    await audit(request.user!.sub, 'credential.trial', {
      entity: 'ApiCredential', entityId: id, ip: request.ip,
      detail: { model, ok: result.ok, latencyMs: result.latencyMs },
    });
    return result;
  });

  /**
   * The exact request this credential would send.
   *
   * Vendors publish a different code sample per model, and the question an
   * administrator is really asking when they read one is "what does mine do
   * differently?". Describing our request in prose cannot answer that; showing
   * it can. This is assembled by buildChatRequest, the same function the real
   * call uses, so what is displayed is what would be sent.
   *
   * Between this and Model settings, everything a vendor sample varies by is
   * visible and adjustable from the browser. What is deliberately *not* offered
   * is running code typed into this screen: it would execute inside the API,
   * with the database, the key encryption and the network in reach, which turns
   * one phished administrator password into the whole school's records. The
   * request body is data, so it is editable; the code that sends it is not.
   */
  app.get('/api/admin/credentials/:id/request', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ model: z.string().max(200).optional() }).parse(request.query ?? {});

    const credential = await prisma.apiCredential.findUnique({ where: { id } });
    if (!credential) return reply.code(404).send({ error: 'Credential not found.' });

    const model = query.model || credential.defaultModel || PROVIDERS[credential.provider]?.suggestedModels[0];
    if (!model) return reply.code(400).send({ error: 'Choose a model first.' });

    const provider = PROVIDERS[credential.provider];
    if (provider?.dialect && provider.dialect !== 'openai' && provider.dialect !== 'azure') {
      return {
        model,
        shown: false,
        // Bedrock, Vertex and Oracle are signed and shaped differently, and a
        // preview built for the OpenAI shape would be a lie about all three.
        note: `${provider.label} does not use the OpenAI request shape - it has its own protocol and signing, `
          + 'so there is no equivalent body to show. Model settings still apply where the provider accepts them.',
      };
    }

    const call = await callParamsFor(credential);
    const built = await buildChatRequest({
      ...call,
      model,
      // Stand-ins rather than the real prompts: the shape of the request is
      // what is being examined, and the system prompt is thousands of words
      // that would bury it.
      messages: [
        { role: 'system', content: '<the question-writing system prompt>' },
        { role: 'user', content: '<the request for this run>' },
      ],
      jsonMode: provider?.supportsJsonMode ?? false,
      maxTokens: resolveCeiling(credential, model),
    });

    return {
      model,
      shown: true,
      url: built.url,
      // Never the key. The point is the shape of the request, and a screenshot
      // of this pasted into a support thread must not leak a credential.
      headers: Object.fromEntries(
        Object.entries(built.headers).map(([k, v]) =>
          /^authorization$/i.test(k) || /^api-key$/i.test(k) ? [k, '<your API key>'] : [k, v],
        ),
      ),
      body: built.body,
      streaming: built.streaming,
    };
  });

  /**
   * Tests every credential at once and reports how each one is doing.
   *
   * The free tiers are the reason this exists. They are usable but erratic,
   * and "is it me or is it them" is otherwise unanswerable without spending a
   * generation run to find out. Latency is worth showing too: a provider that
   * answers in eight seconds will not get through a fifty-question run.
   */
  app.post('/api/admin/credentials/health', async (request) => {
    const credentials = await prisma.apiCredential.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    // In parallel: this is a diagnostic an admin is watching, and running six
    // providers in sequence at eight seconds each is a minute of waiting.
    const results = await Promise.all(
      credentials.map(async (credential) => {
        const model = credential.defaultModel || PROVIDERS[credential.provider]?.suggestedModels[0];
        const base = {
          id: credential.id,
          label: credential.label,
          provider: credential.provider,
          model: model ?? null,
          useAsFallback: ((credential.meta ?? {}) as { useAsFallback?: boolean }).useAsFallback === true,
        };

        if (!model) return { ...base, ok: false, latencyMs: null, message: 'No default model set, so there is nothing to test.' };

        const started = Date.now();
        try {
          const call = await callParamsFor(credential);
          const res = await pingProvider({ ...call, model });
          return { ...base, ok: res.ok, latencyMs: Date.now() - started, message: res.message };
        } catch (err) {
          return {
            ...base,
            ok: false,
            latencyMs: Date.now() - started,
            message: err instanceof Error ? err.message : 'The check failed.',
          };
        }
      }),
    );

    await audit(request.user!.sub, 'credential.health', {
      ip: request.ip,
      detail: { checked: results.length, healthy: results.filter((r) => r.ok).length },
    });

    return { results, checkedAt: new Date().toISOString() };
  });

  /**
   * Which provider the Step-up Test uses.
   *
   * Kept separate from the credential a paper is generated with, deliberately.
   * Step-up is triggered by students rather than staff, several times a day
   * across a class, so a school will usually want it pointed at something
   * cheap or free even when papers are set with the best model available.
   */
  app.get('/api/admin/step-up', async () => {
    const config = await getStepUpConfig();
    const credentials = await prisma.apiCredential.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, provider: true, defaultModel: true },
    });
    return { config, credentials };
  });

  app.put('/api/admin/step-up', async (request, reply) => {
    const body = z
      .object({
        credentialId: z.string().uuid().nullable(),
        model: z.string().max(200).optional(),
        /** Papers per student per school day. 0 removes the limit entirely. */
        dailyQuota: z.number().int().min(0).max(100).optional(),
      })
      .parse(request.body);

    if (body.credentialId === null) {
      await setStepUpConfig(null);
      await audit(request.user!.sub, 'settings.step_up', { ip: request.ip, detail: { enabled: false } });
      return { ok: true, config: null, message: 'Step-up tests are switched off. Students will not see the buttons.' };
    }

    const credential = await prisma.apiCredential.findUnique({ where: { id: body.credentialId } });
    if (!credential || !credential.isActive) {
      return reply.code(400).send({ error: 'That credential does not exist or is disabled.' });
    }

    const model = body.model?.trim() || credential.defaultModel;
    if (!model) {
      return reply.code(400).send({ error: 'Choose a model, or set a default model on that credential first.' });
    }

    const dailyQuota = body.dailyQuota ?? DEFAULT_STEP_UP_QUOTA;
    await setStepUpConfig({ credentialId: credential.id, model, dailyQuota });
    await audit(request.user!.sub, 'settings.step_up', {
      ip: request.ip, detail: { credentialId: credential.id, model, dailyQuota },
    });

    return {
      ok: true,
      config: { credentialId: credential.id, model, dailyQuota },
      message:
        `Step-up tests will use ${credential.label} (${model}), ` +
        (dailyQuota > 0
          ? `${dailyQuota} per student per day.`
          : 'with no daily limit per student — watch the provider bill.'),
    };
  });

  /**
   * Which provider draws the pictures a question asks for. Only the
   * credentials that can actually do it are offered.
   */
  app.get('/api/admin/image-provider', async () => {
    const config = await getImageConfig();
    const all = await prisma.apiCredential.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      // meta is needed to read the capability ticks, and holds nothing secret.
      select: { id: true, label: true, provider: true, meta: true },
    });
    return { config, credentials: all.filter((c) => capabilitiesOf(c).images) };
  });

  app.put('/api/admin/image-provider', async (request, reply) => {
    const body = z
      .object({ credentialId: z.string().uuid().nullable(), model: z.string().max(200).optional() })
      .parse(request.body);

    if (body.credentialId === null) {
      await setImageConfig(null);
      await audit(request.user!.sub, 'settings.image_provider', { ip: request.ip, detail: { enabled: false } });
      return { ok: true, config: null, message: 'Image generation is off. Pictures must be uploaded by hand.' };
    }

    const credential = await prisma.apiCredential.findUnique({ where: { id: body.credentialId } });
    if (!credential || !credential.isActive) {
      return reply.code(400).send({ error: 'That credential does not exist or is disabled.' });
    }
    const problem = imageProblem(credential);
    if (problem) return reply.code(400).send({ error: problem });

    const model = body.model?.trim() || 'gpt-image-1';
    await setImageConfig({ credentialId: credential.id, model });
    await audit(request.user!.sub, 'settings.image_provider', {
      ip: request.ip, detail: { credentialId: credential.id, model },
    });
    return { ok: true, config: { credentialId: credential.id, model }, message: `Pictures will be drawn by ${credential.label} (${model}).` };
  });

  // --- Prompt templates ----------------------------------------------------

  app.get('/api/admin/prompts', async () => {
    const templates = await prisma.promptTemplate.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    return { templates, defaults: { systemPrompt: DEFAULT_SYSTEM_PROMPT, userTemplate: DEFAULT_USER_TEMPLATE } };
  });

  const promptSchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    systemPrompt: z.string().min(20).max(40_000),
    userTemplate: z.string().min(5).max(40_000),
    // Which generator uses it. STEP_UP is a prompt kind only - a Step-up paper
    // is stored as a PRACTICE test; see the note on PromptTemplate.kind.
    kind: z.enum(['REGULAR', 'PRACTICE', 'STEP_UP']).default('REGULAR'),
    isDefault: z.boolean().default(false),
    isActive: z.boolean().default(true),
  });

  app.post('/api/admin/prompts', async (request, reply) => {
    const body = promptSchema.parse(request.body);

    const template = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.promptTemplate.updateMany({ where: { kind: body.kind, isDefault: true }, data: { isDefault: false } });
      }
      return tx.promptTemplate.create({ data: { ...body, description: body.description ?? null } });
    });

    await audit(request.user!.sub, 'prompt.create', { entity: 'PromptTemplate', entityId: template.id, ip: request.ip });
    return reply.code(201).send({ ok: true, template });
  });

  app.patch('/api/admin/prompts/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = promptSchema.partial().parse(request.body);

    const existing = await prisma.promptTemplate.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Prompt template not found.' });

    const template = await prisma.$transaction(async (tx) => {
      if (body.isDefault) {
        await tx.promptTemplate.updateMany({
          where: { kind: body.kind ?? existing.kind, isDefault: true, NOT: { id } },
          data: { isDefault: false },
        });
      }
      return tx.promptTemplate.update({
        where: { id },
        // Editing bumps the version rather than silently rewriting history:
        // past runs keep their own frozen copy of the prompt.
        data: { ...body, version: { increment: 1 } },
      });
    });

    await audit(request.user!.sub, 'prompt.update', { entity: 'PromptTemplate', entityId: id, ip: request.ip });
    return { ok: true, template };
  });

  app.delete('/api/admin/prompts/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await prisma.promptTemplate.update({ where: { id }, data: { isActive: false } });
    await audit(request.user!.sub, 'prompt.delete', { entity: 'PromptTemplate', entityId: id, ip: request.ip });
    return { ok: true };
  });

  // --- Tag vocabulary ------------------------------------------------------

  app.get('/api/admin/tags', async () => {
    const tags = await prisma.tag.findMany({ orderBy: [{ axis: 'asc' }, { sortOrder: 'asc' }] });
    return { tags };
  });

  app.post('/api/admin/tags', async (request, reply) => {
    const body = z
      .object({
        axis: z.enum(['DIFFICULTY', 'COGNITIVE', 'SKILL']),
        code: z.string().trim().regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, digits and underscores only.').max(60),
        label: z.string().trim().min(1).max(120),
        description: z.string().max(1000).optional(),
        weight: z.number().int().min(0).max(100).default(0),
        sortOrder: z.number().int().default(0),
      })
      .parse(request.body);

    const tag = await prisma.tag.create({ data: body });
    await audit(request.user!.sub, 'tag.create', { entity: 'Tag', entityId: tag.id, ip: request.ip });
    return reply.code(201).send({ ok: true, tag });
  });

  app.patch('/api/admin/tags/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(1000).optional(),
        weight: z.number().int().min(0).max(100).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);

    // `code` is intentionally not editable: it is stored on every question and
    // inside every historical breakdown. Deactivate and add a new one instead.
    const tag = await prisma.tag.update({ where: { id }, data: body });
    return { ok: true, tag };
  });

  // --- Grades and divisions ------------------------------------------------

  app.get('/api/admin/classes', async () => {
    const classes = await prisma.schoolClass.findMany({ orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] });
    return {
      grades: classes.filter((c) => c.kind === 'GRADE'),
      divisions: classes.filter((c) => c.kind === 'DIVISION'),
    };
  });

  app.post('/api/admin/classes', async (request, reply) => {
    const body = z
      .object({
        kind: z.enum(['GRADE', 'DIVISION']),
        /**
         * The stored value, written onto every student row and into every
         * historical breakdown - so it is constrained to something that cannot
         * arrive with a stray space or a smart quote, and can never be edited
         * afterwards. The label carries the human wording and is free to change.
         */
        code: z
          .string().trim().toUpperCase().min(1).max(20)
          .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Use letters, digits, hyphens and underscores, starting with a letter or digit.'),
        label: z.string().trim().min(1).max(60),
        sortOrder: z.number().int().default(0),
      })
      .parse(request.body);

    const existing = await prisma.schoolClass.findUnique({
      where: { kind_code: { kind: body.kind, code: body.code } },
    });
    if (existing) {
      return reply.code(409).send({
        error: existing.isActive
          ? `A ${body.kind.toLowerCase()} with the code ${body.code} already exists: “${existing.label}”.`
          : `${body.kind === 'GRADE' ? 'A grade' : 'A division'} with the code ${body.code} already exists but is ` +
            `hidden from signup: “${existing.label}”. Tick it to offer it again rather than adding a second one.`,
      });
    }

    const row = await prisma.schoolClass.create({ data: body });
    await audit(request.user!.sub, 'class.create', {
      entity: 'SchoolClass', entityId: row.id, ip: request.ip, detail: { kind: body.kind, code: body.code },
    });
    return reply.code(201).send({ ok: true, class: row });
  });

  app.patch('/api/admin/classes/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        label: z.string().trim().min(1).max(60).optional(),
        sortOrder: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(request.body);

    // `code` is deliberately absent: it is written onto student rows and into
    // saved analytics, and renaming it there would silently orphan them.
    const row = await prisma.schoolClass.update({ where: { id }, data: body });
    return { ok: true, class: row };
  });

  /**
   * Removes a grade or division that turned out to be a mistake.
   *
   * Refused the moment anybody is in it. Deleting the row would leave students
   * filed under a code with no name, tests targeting an audience that cannot
   * be resolved, and past results grouped by a class that no longer exists -
   * so a class in use is hidden from signup instead, which is what the tick
   * box already does.
   */
  app.delete('/api/admin/classes/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const row = await prisma.schoolClass.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: 'That grade or division does not exist.' });

    const inUse = await prisma.user.count({
      where: {
        deletedAt: null,
        ...(row.kind === 'GRADE' ? { grade: row.code } : { divisions: { has: row.code } }),
      },
    });

    if (inUse > 0) {
      return reply.code(409).send({
        error:
          `${inUse} student${inUse === 1 ? ' is' : 's are'} in ${row.label}, so it cannot be deleted — their records ` +
          'would point at a class that no longer exists. Untick "Offered at signup" to retire it instead, or move ' +
          'those students first.',
      });
    }

    await prisma.schoolClass.delete({ where: { id } });
    await audit(request.user!.sub, 'class.delete', {
      entity: 'SchoolClass', entityId: id, ip: request.ip, detail: { kind: row.kind, code: row.code },
    });
    return { ok: true, message: `${row.label} deleted.` };
  });

  // --- Curriculum tree -----------------------------------------------------

  app.get('/api/admin/curriculum', async () => {
    const nodes = await prisma.curriculumNode.findMany({ orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }] });
    return { nodes };
  });

  app.post('/api/admin/curriculum', async (request, reply) => {
    const body = z
      .object({
        parentId: z.string().uuid().optional().nullable(),
        level: z.enum(['SUBJECT', 'TOPIC', 'SUBTOPIC']),
        code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Use letters, digits, hyphens and underscores.').max(80),
        label: z.string().trim().min(1).max(160),
        grade: z.string().max(20).optional().nullable(),
        sortOrder: z.number().int().default(0),
      })
      .parse(request.body);

    let path = body.code.toLowerCase();
    if (body.parentId) {
      const parent = await prisma.curriculumNode.findUnique({ where: { id: body.parentId } });
      if (!parent) return reply.code(400).send({ error: 'Parent node not found.' });
      path = `${parent.path}/${body.code.toLowerCase()}`;
    }

    const node = await prisma.curriculumNode.create({
      data: { ...body, parentId: body.parentId ?? null, grade: body.grade ?? null, path },
    });
    return reply.code(201).send({ ok: true, node });
  });

  app.delete('/api/admin/curriculum/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    await prisma.curriculumNode.update({ where: { id }, data: { isActive: false } });
    return { ok: true };
  });

  // --- School timezone -----------------------------------------------------

  /**
   * Every daily availability window is wall-clock time in this zone. The
   * container runs UTC, so without this an "8am" window would fire at the
   * wrong hour.
   */
  app.get('/api/admin/timezone', async () => {
    const timezone = await getSchoolTimezone();
    const now = zonedNow(timezone);
    return {
      timezone,
      common: COMMON_TIMEZONES,
      windowPresets: WINDOW_PRESETS,
      // Shown back so the admin can confirm at a glance that it is right.
      localTimeNow: formatMinute(now.minuteOfDay),
      serverTimeUtc: new Date().toISOString(),
    };
  });

  app.put('/api/admin/timezone', async (request, reply) => {
    const { timezone } = z.object({ timezone: z.string().min(1).max(64) }).parse(request.body);

    if (!isValidTimezone(timezone)) {
      return reply.code(400).send({
        error: `"${timezone}" is not a recognised timezone. Use an IANA name such as Asia/Kolkata.`,
      });
    }

    await setSchoolTimezone(timezone);
    await audit(request.user!.sub, 'settings.timezone', { ip: request.ip, detail: { timezone } });

    const now = zonedNow(timezone);
    return {
      ok: true,
      timezone,
      localTimeNow: formatMinute(now.minuteOfDay),
      message: `Timezone set to ${timezone}. It is currently ${formatMinute(now.minuteOfDay)} there.`,
    };
  });

  // --- Audit log -----------------------------------------------------------

  app.get('/api/admin/audit', async (request) => {
    const q = z
      .object({
        action: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const where = q.action ? { action: { startsWith: q.action } } : {};

    const [total, entries] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actor: { select: { username: true } } },
      }),
    ]);

    return { total, page: q.page, pageSize: q.pageSize, entries };
  });
}
