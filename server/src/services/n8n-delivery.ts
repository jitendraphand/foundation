/**
 * Posts a password-reset payload to the n8n webhook the school configured.
 *
 * Two things about that URL are easy to get wrong, and both used to look like
 * a successful email reset:
 *
 *   - n8n was told its public address was `https://<the app>/n8n/`. Caddy does
 *     not send that path to n8n — it is the website — so the Production URL an
 *     administrator copies out of the editor never reaches a workflow. The
 *     website answers 200 with its HTML, which is not a delivery.
 *   - The honest address, from the API container, is n8n's own port on the
 *     compose network. The public name (`https://n8n.<host>/...`) often cannot
 *     be dialled from inside the container at all.
 *
 * So a URL that belongs to this deployment is rewritten to
 * `http://n8n:5678/webhook/<path>` before it is called. A URL on any other
 * host is left exactly as stored, for a school that points the setting at an
 * n8n running somewhere else.
 */

const DEFAULT_INTERNAL_BASE = 'http://n8n:5678';

export function resolveDeliveryUrl(
  configured: string,
  opts: { publicHost?: string; internalBase?: string } = {},
): string {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return configured;
  }

  // `/webhook-test/` is the editor's listen-once URL and does not contain
  // `/webhook/`, so it is deliberately not rewritten.
  const webhookAt = url.pathname.indexOf('/webhook/');
  if (webhookAt === -1) return configured;

  const host = url.hostname.toLowerCase();
  const publicHost = (opts.publicHost ?? '').trim().toLowerCase();
  const ours =
    url.pathname.startsWith('/n8n/') ||
    host === 'n8n' ||
    host === 'n8n.localhost' ||
    (publicHost !== '' && publicHost !== 'localhost' && (host === publicHost || host === `n8n.${publicHost}`));

  if (!ours) return configured;

  const base = (opts.internalBase || DEFAULT_INTERNAL_BASE).replace(/\/+$/, '');
  return `${base}${url.pathname.slice(webhookAt)}${url.search}`;
}

/** A 200 from the website is HTML. n8n answers JSON, or with an empty body. */
export function deliveryAccepted(status: number, contentType: string | null, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  if (contentType && /text\/html/i.test(contentType)) return false;
  const head = body.trimStart().slice(0, 64).toLowerCase();
  return !(head.startsWith('<!doctype html') || head.startsWith('<html'));
}

export async function postWebhook(
  configuredUrl: string,
  payload: unknown,
): Promise<{ sent: boolean; via: 'n8n'; error?: string }> {
  const url = resolveDeliveryUrl(configuredUrl, {
    publicHost: process.env.PUBLIC_HOST,
    internalBase: process.env.N8N_INTERNAL_BASE_URL,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      // SMTP can take longer than a chat API. Eight seconds aborted real
      // sends whose workflow waits until the message has actually gone.
      signal: AbortSignal.timeout(20_000),
    });
    const txt = await res.text().catch(() => '');
    if (!deliveryAccepted(res.status, res.headers.get('content-type'), txt)) {
      const why = /text\/html/i.test(res.headers.get('content-type') ?? '') || txt.trimStart().startsWith('<')
        ? `webhook ${url} answered with the website, not n8n`
        : `n8n ${res.status} from ${url}: ${txt.slice(0, 200)}`;
      return { sent: false, via: 'n8n', error: why };
    }
    return { sent: true, via: 'n8n' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { sent: false, via: 'n8n', error: `${message} (${url})` };
  }
}
