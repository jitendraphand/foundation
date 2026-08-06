import type { ApiCredential } from '@prisma/client';
import { decryptSecret } from '../lib/crypto.js';
import { LlmError } from './providers.js';
import type { BedrockConfig } from './bedrock.js';

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

export interface CallParams {
  baseUrl: string;
  apiKey: string;
  bedrock?: BedrockConfig;
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

export function callParamsFor(
  credential: Pick<ApiCredential, 'provider' | 'baseUrl' | 'encryptedKey' | 'meta'>,
): CallParams {
  const secret = decryptSecret(credential.encryptedKey);

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
