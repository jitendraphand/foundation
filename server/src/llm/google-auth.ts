import crypto from 'node:crypto';
import { LlmError } from './providers.js';

/**
 * Google service-account authentication, for Vertex AI.
 *
 * Vertex does not take an API key. It takes a short-lived OAuth access token,
 * and the only way to get one without the SDK is the JWT bearer flow: build a
 * claim set, sign it with the service account's private key, and exchange it
 * at Google's token endpoint for an access token good for an hour.
 *
 * Written out for the same reason the AWS signer is - this is one HTTP call
 * plus an RS256 signature, against a dependency tree that would otherwise
 * arrive with the whole Google Cloud SDK.
 *
 * The simpler alternative, an AI Studio API key against
 * generativelanguage.googleapis.com, is a separate provider ("google") and
 * needs none of this. This file exists for schools whose GCP account only
 * issues service accounts.
 */

/** The fields we need from a downloaded service-account JSON key file. */
export interface ServiceAccount {
  type?: string;
  project_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

export function parseServiceAccount(raw: string): ServiceAccount {
  let json: Partial<ServiceAccount>;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmError(
      'That does not look like a service-account key. Paste the whole JSON file you downloaded from Google Cloud, ' +
        'starting with { and ending with }.',
    );
  }

  const missing = (['project_id', 'private_key', 'client_email'] as const).filter((k) => !json[k]);
  if (missing.length) {
    throw new LlmError(
      `The service-account JSON is missing ${missing.join(', ')}. Download a fresh key from ` +
        'IAM & Admin > Service Accounts > Keys, and paste the file unchanged.',
    );
  }

  // A JSON file pasted through a form often arrives with the newlines in the
  // private key escaped. PEM parsing fails on that with an opaque error.
  const privateKey = json.private_key!.includes('\\n')
    ? json.private_key!.replace(/\\n/g, '\n')
    : json.private_key!;

  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey.trim())) {
    throw new LlmError('The private_key in that service account is not a PEM key. Download a fresh JSON key file.');
  }

  return { ...(json as ServiceAccount), private_key: privateKey };
}

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Access tokens last an hour, and minting one costs a round trip before every
 * single generation call. Cached per service account until shortly before it
 * expires - a batch of five calls should pay for one token, not five.
 */
interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

export async function accessTokenFor(account: ServiceAccount): Promise<string> {
  const cacheKey = `${account.client_email}:${account.project_id}`;
  const cached = tokenCache.get(cacheKey);
  // 60 seconds of headroom, so a token cannot expire between this check and
  // the request that uses it.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const tokenUri = account.token_uri || DEFAULT_TOKEN_URI;
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );

  let signature: string;
  try {
    signature = base64url(
      crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.private_key),
    );
  } catch (err) {
    throw new LlmError(`The service-account private key could not be used to sign: ${(err as Error).message}`);
  }

  let res: Response;
  try {
    res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
    });
  } catch (err) {
    throw new LlmError(`Could not reach Google to exchange the service-account key: ${(err as Error).message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // Google's token errors are terse but specific, and worth naming: the
    // commonest by far is the API simply not being enabled on the project.
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error_description ?? parsed.error ?? detail;
    } catch {
      /* keep raw */
    }
    const hint = /invalid_grant/i.test(text)
      ? ' (the key has been revoked, or this server\'s clock is out by more than a few minutes)'
      : /invalid_scope|access_denied/i.test(text)
        ? ' (the service account lacks the Vertex AI User role)'
        : '';
    throw new LlmError(`Google refused the service-account key${hint}: ${detail}`, res.status, text);
  }

  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new LlmError('Google returned no access token for that service account.');

  tokenCache.set(cacheKey, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });

  return body.access_token;
}

/**
 * Vertex exposes an OpenAI-compatible surface, so once a token is in hand the
 * ordinary chat/completions adapter handles the rest. The URL carries the
 * project and region because Vertex is regional, like Bedrock.
 */
export function vertexBaseUrl(projectId: string, region: string): string {
  return `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/endpoints/openapi`;
}

/** Exposed for the token-flow checks. */
export const __testing = { base64url };
