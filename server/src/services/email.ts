import { prisma } from '../db.js';

export interface EmailPayload {
  to: string;
  subject: string;
  message: string;
}

function normalizeEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  // Same shape the admin UI enforces when the address is stored.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized)) return null;
  if (normalized.length > 254) return null;
  return normalized;
}

/** Mask an address for replies: `j***@example.com` — enough to recognise, not to steal. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return 'the registered email address';
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * Sends email via n8n webhook if configured, otherwise logs.
 * N8N webhook is stored in Setting `n8n.emailWebhookUrl`.
 * System Administrator configures it in Settings → n8n, mirroring the
 * WhatsApp webhook: a Webhook node whose downstream EmailSend node delivers
 * `{ to, subject, message }`.
 */
export async function sendEmail(to: string, subject: string, message: string): Promise<{ sent: boolean; via: 'n8n' | 'log'; error?: string }> {
  const normalized = normalizeEmail(to);
  if (!normalized) return { sent: false, via: 'log', error: 'Invalid email address' };

  let webhookUrl: string | null = null;
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'n8n.emailWebhookUrl' } }).catch(() => null);
    webhookUrl = typeof row?.value === 'string' ? row.value : null;
    if (!webhookUrl) webhookUrl = process.env.N8N_EMAIL_WEBHOOK_URL ?? null;
  } catch {
    webhookUrl = process.env.N8N_EMAIL_WEBHOOK_URL ?? null;
  }

  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: normalized, subject, message, from: 'Foundation' }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { sent: false, via: 'n8n', error: `n8n ${res.status}: ${txt.slice(0, 300)}` };
      }
      return { sent: true, via: 'n8n' };
    } catch (e) {
      return { sent: false, via: 'n8n', error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Fallback: log (no n8n configured). In production, admin should configure n8n.
  console.log(`[email] to ${normalized} subject "${subject}": ${message}`);
  return { sent: true, via: 'log' };
}

export function formatResetEmail(username: string, newPassword: string): { subject: string; message: string } {
  return {
    subject: 'Foundation: your password has been reset',
    message: `Hello ${username},\n\nYour Foundation password has been reset.\n\nUsername: ${username}\nNew temporary password: ${newPassword}\n\nYou will be asked to change it on next login. Keep it private — if you did not request this, tell your teacher at once.`,
  };
}
