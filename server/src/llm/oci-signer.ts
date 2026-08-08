import crypto from 'node:crypto';
import { LlmError } from './providers.js';

/**
 * Oracle Cloud request signing.
 *
 * OCI authenticates with HTTP Signatures (the draft-cavage scheme): a set of
 * headers is concatenated into a signing string, signed RSA-SHA256 with the
 * user's API private key, and sent in an Authorization header naming which
 * headers were covered.
 *
 * The key id is a triple - tenancy OCID, user OCID, key fingerprint - which is
 * how Oracle finds the public half to verify against. All three are printed on
 * the API key page in the console, and the whole set is normally pasted from
 * the config file Oracle offers to generate there.
 *
 * Written out for the same reason as the AWS signer: this is one signature and
 * a header, against an SDK that would otherwise be a very large dependency for
 * a system that speaks exactly one Oracle API.
 */

export interface OciCredentials {
  tenancyId: string;
  userId: string;
  fingerprint: string;
  /** PEM private key, as downloaded when the API key was created. */
  privateKey: string;
  region: string;
  /** Which compartment to bill and scope the call to. Often the tenancy. */
  compartmentId: string;
}

/**
 * Headers OCI requires for a request with a body. Order matters: the signing
 * string is built in exactly this sequence, and a different order produces a
 * signature Oracle rejects without saying why.
 */
const SIGNED_HEADERS_WITH_BODY = [
  '(request-target)',
  'host',
  'date',
  'x-content-sha256',
  'content-type',
  'content-length',
] as const;

export interface OciSignable {
  method: string;
  url: string;
  body: string;
}

export function signOciRequest(request: OciSignable, credentials: OciCredentials): Record<string, string> {
  const url = new URL(request.url);
  const date = new Date().toUTCString();

  // OCI wants the base64 SHA-256 of the body, not the hex AWS uses.
  const bodySha = crypto.createHash('sha256').update(request.body).digest('base64');

  const values: Record<string, string> = {
    '(request-target)': `${request.method.toLowerCase()} ${url.pathname}${url.search}`,
    host: url.host,
    date,
    'x-content-sha256': bodySha,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(request.body)),
  };

  const signingString = SIGNED_HEADERS_WITH_BODY.map((h) => `${h}: ${values[h]}`).join('\n');

  let signature: string;
  try {
    signature = crypto.createSign('RSA-SHA256').update(signingString).sign(credentials.privateKey, 'base64');
  } catch (err) {
    throw new LlmError(
      `The Oracle Cloud private key could not be used to sign: ${(err as Error).message}. ` +
        'Check it is the unencrypted PEM downloaded when the API key was created.',
    );
  }

  const keyId = `${credentials.tenancyId}/${credentials.userId}/${credentials.fingerprint}`;

  return {
    date,
    host: url.host,
    'x-content-sha256': bodySha,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(request.body)),
    authorization:
      `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
      `headers="${SIGNED_HEADERS_WITH_BODY.join(' ')}",signature="${signature}"`,
  };
}

/** OCIDs are long and easy to paste into the wrong box; catch that early. */
const OCID = /^ocid1\.[a-z0-9]+\.[a-z0-9-]*\.[a-z0-9-]*\.?[a-z0-9]*$/i;

export function looksLikeOcid(value: string, kind: 'tenancy' | 'user' | 'compartment'): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `The ${kind} OCID is required.`;
  if (!/^ocid1\./i.test(trimmed)) {
    return `That does not look like an OCID - they all start with "ocid1.". Copy the ${kind} OCID from the Oracle Cloud console.`;
  }
  // The second segment names what the OCID identifies, which is how a tenancy
  // pasted into the user box is caught before it becomes a 401.
  const type = trimmed.split('.')[1]?.toLowerCase();
  const expected = kind === 'compartment' ? ['compartment', 'tenancy'] : [kind];
  if (type && !expected.includes(type)) {
    return `That is a ${type} OCID, not a ${kind} one. Check which box it belongs in.`;
  }
  if (!OCID.test(trimmed)) return `That ${kind} OCID does not look complete.`;
  return null;
}

/** Regions are how OCI names its data centres; the endpoint is derived from it. */
export function ociEndpoint(region: string, baseUrl?: string): string {
  const host = (baseUrl || `https://inference.generativeai.${region}.oci.oraclecloud.com`).replace(/\/+$/, '');
  return `${host}/20231130/actions/chat`;
}

export const __testing = { SIGNED_HEADERS_WITH_BODY };
