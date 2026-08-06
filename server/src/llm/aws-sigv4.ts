import crypto from 'node:crypto';

/**
 * AWS Signature Version 4, for Bedrock.
 *
 * Every other provider here authenticates with a bearer token. AWS signs the
 * request itself: the method, path, headers and a hash of the body all go into
 * a signature derived from the secret key, so the credential never travels and
 * the request cannot be altered in flight.
 *
 * Written out rather than pulled from the AWS SDK on purpose. The SDK is a
 * large dependency tree for one HTTP call, and this is the only AWS API the
 * system speaks. It is about ninety lines and it is verified against AWS's own
 * signer - see the cross-check in the commit that added it.
 *
 * Bedrock also accepts a plain bearer token (an "API key" in the console), so
 * this is only used when the school has ordinary IAM credentials.
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials from STS. */
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  /** Full URL, including query string if any. */
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  /** The signing name, which is not always the subdomain. Bedrock is "bedrock". */
  service: string;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

const sha256Hex = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

const hmac = (key: string | Buffer, value: string): Buffer =>
  crypto.createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves ! * ' ( ) alone, which AWS
 * expects to be percent-encoded, and a single unencoded character makes the
 * canonical request differ from the one AWS reconstructs - which surfaces as
 * an opaque SignatureDoesNotMatch.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The canonical path: normalise, then encode the *already-encoded* path once
 * more, putting the separators back.
 *
 * The "encode twice" rule is easy to get subtly wrong. It does not mean decode
 * and re-encode twice - it means the caller encodes each segment, and the
 * signer encodes the result again. Decoding first double-encodes characters
 * that were literal in the URL and single-encodes ones that were not, which
 * produces a signature AWS will not agree with. Confirmed against AWS's own
 * signer, where the two approaches diverge on a path containing ' ( ) or *.
 *
 * It matters here because a Bedrock model id contains a colon
 * (anthropic.claude-3-5-sonnet-20241022-v2:0).
 */
function canonicalPath(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/';

  const segments: string[] = [];
  for (const segment of pathname.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }

  const normalized =
    (pathname.startsWith('/') ? '/' : '') +
    segments.join('/') +
    (segments.length > 0 && pathname.endsWith('/') ? '/' : '');

  // Plain encodeURIComponent, deliberately, not the stricter uriEncode above:
  // the outer pass leaves ! ' ( ) * alone. Those characters are escaped by the
  // caller when it builds the path, and escaping them again here produces a
  // signature AWS rejects. Verified against AWS's own signer.
  return encodeURIComponent(normalized).replace(/%2F/g, '/');
}

function canonicalQuery(search: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  search.forEach((v, k) => pairs.push([uriEncode(k), uriEncode(v)]));
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Returns the headers to send, including Authorization.
 *
 * `signingDate` exists so the signature can be compared byte for byte against
 * AWS's own signer for the same instant; in normal use it is now.
 */
export function signRequest(
  request: SignableRequest,
  credentials: SigV4Credentials,
  signingDate: Date = new Date(),
): Record<string, string> {
  const url = new URL(request.url);
  const now = signingDate;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260805T171500Z
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(request.body ?? '');

  // The host header is what AWS signs against, so it must match exactly what
  // the connection is made to - including a non-default port.
  const headers: Record<string, string> = {
    ...request.headers,
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };

  // Canonical headers: lowercase names, collapsed whitespace, sorted.
  const canonicalHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();

  const lowered = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));

  const canonicalHeaders = canonicalHeaderNames.map((name) => `${name}:${lowered.get(name)}\n`).join('');
  const signedHeaders = canonicalHeaderNames.join(';');

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, request.region);
  const kService = hmac(kRegion, request.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Exposed for the cross-check against AWS's own signer, which needs to sign
 * the same request at the same instant to produce the same bytes.
 */
export const __testing = { canonicalPath, uriEncode, canonicalQuery };
