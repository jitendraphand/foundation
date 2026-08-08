import type { ApiCredential } from '@prisma/client';
import { decryptSecret } from '../lib/crypto.js';
import { LlmError, DEFAULT_AZURE_API_VERSION } from './providers.js';
import { accessTokenFor, parseServiceAccount, vertexBaseUrl } from './google-auth.js';
import type { BedrockConfig } from './bedrock.js';
import type { OciCredentials } from './oci-signer.js';

/**
 * Turning a stored credential into the parameters a call needs.
 *
 * One place, because there are now two shapes of credential - a bearer token
 * for the OpenAI-compatible providers, and Bedrock's region plus either an API
 * key or an IAM key pair - and both generation and the "test connection"
 * button have to unpack them identically.
 *
 * What lives where:
 *
 *   encryptedKey  the secret, and only the secret. For Bedrock with IAM keys
 *                 it is a JSON blob holding the secret access key and any
 *                 session token, so neither ever sits in the database in
 *                 plain text.
 *   meta          everything that is not secret: which auth mode, the region,
 *                 the access key id. Safe to show back to an administrator.
 */

export interface BedrockMeta {
  authMode: 'apiKey' | 'sigv4';
  region: string;
  accessKeyId?: string;
}

/** Azure addresses a resource by hostname and pins a dated API version. */
export interface AzureMeta {
  apiVersion?: string;
}

/**
 * OCI needs five identifiers alongside the private key. None is secret - they
 * are OCIDs and a fingerprint, all visible in the console - so they live in
 * meta and only the PEM is encrypted.
 */
export interface OciMeta {
  tenancyId: string;
  userId: string;
  fingerprint: string;
  region: string;
  compartmentId: string;
}

/** Vertex is regional and scoped to a project, both read from the key file. */
export interface VertexMeta {
  projectId: string;
  region: string;
  clientEmail?: string;
}

export interface CallParams {
  baseUrl: string;
  apiKey: string;
  bedrock?: BedrockConfig;
  oci?: { credentials: OciCredentials; baseUrl?: string };
  dialect?: 'openai' | 'azure' | 'bedrock' | 'oci';
  azure?: { apiVersion: string };
}

/** The secret half of an IAM credential, as stored. */
interface IamSecret {
  secretAccessKey: string;
  sessionToken?: string;
}

export function packIamSecret(secretAccessKey: string, sessionToken?: string): string {
  return JSON.stringify({ secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } satisfies IamSecret);
}

export function bedrockMetaOf(credential: Pick<ApiCredential, 'meta'>): BedrockMeta | null {
  const meta = credential.meta as Partial<BedrockMeta> | null;
  if (!meta?.region) return null;
  return {
    authMode: meta.authMode === 'sigv4' ? 'sigv4' : 'apiKey',
    region: meta.region,
    accessKeyId: meta.accessKeyId,
  };
}

/**
 * Async because Vertex has no key to send: a service account has to be
 * exchanged for a short-lived access token before the call can be made. Every
 * other provider resolves without a round trip, and the token is cached for
 * its lifetime, so this is not a per-call cost.
 */
export async function callParamsFor(
  credential: Pick<ApiCredential, 'provider' | 'baseUrl' | 'encryptedKey' | 'meta'>,
): Promise<CallParams> {
  const secret = decryptSecret(credential.encryptedKey);

  if (credential.provider === 'azure') {
    const meta = (credential.meta ?? {}) as AzureMeta;
    return {
      baseUrl: credential.baseUrl,
      apiKey: secret,
      dialect: 'azure',
      azure: { apiVersion: meta.apiVersion || DEFAULT_AZURE_API_VERSION },
    };
  }

  if (credential.provider === 'vertex') {
    const meta = credential.meta as VertexMeta | null;
    if (!meta?.projectId || !meta.region) {
      throw new LlmError('This Vertex credential has no project or region saved. Delete it and add it again.');
    }
    const account = parseServiceAccount(secret);
    return {
      // The stored base URL wins so a private endpoint can be pointed at, but
      // normally it is the regional one derived when the credential was saved.
      baseUrl: credential.baseUrl || vertexBaseUrl(meta.projectId, meta.region),
      apiKey: await accessTokenFor(account),
    };
  }

  if (credential.provider === 'oci') {
    const meta = credential.meta as OciMeta | null;
    if (!meta?.tenancyId || !meta.userId || !meta.fingerprint || !meta.region || !meta.compartmentId) {
      throw new LlmError('This Oracle Cloud credential is incomplete. Delete it and add it again.');
    }
    return {
      baseUrl: credential.baseUrl,
      apiKey: '',
      dialect: 'oci',
      oci: {
        credentials: { ...meta, privateKey: secret },
        baseUrl: credential.baseUrl || undefined,
      },
    };
  }

  if (credential.provider !== 'bedrock') {
    return { baseUrl: credential.baseUrl, apiKey: secret };
  }

  const meta = bedrockMetaOf(credential);
  if (!meta) {
    throw new LlmError('This Bedrock credential has no region saved. Delete it and add it again.');
  }

  if (meta.authMode === 'apiKey') {
    return {
      baseUrl: credential.baseUrl,
      apiKey: secret,
      bedrock: { region: meta.region, baseUrl: credential.baseUrl, auth: { mode: 'apiKey', apiKey: secret } },
    };
  }

  if (!meta.accessKeyId) {
    throw new LlmError('This Bedrock credential has no access key id saved. Delete it and add it again.');
  }

  let iam: IamSecret;
  try {
    iam = JSON.parse(secret) as IamSecret;
  } catch {
    throw new LlmError('The saved AWS secret could not be read. Delete the credential and add it again.');
  }

  return {
    baseUrl: credential.baseUrl,
    apiKey: '',
    bedrock: {
      region: meta.region,
      baseUrl: credential.baseUrl,
      auth: {
        mode: 'sigv4',
        accessKeyId: meta.accessKeyId,
        secretAccessKey: iam.secretAccessKey,
        sessionToken: iam.sessionToken,
      },
    },
  };
}
