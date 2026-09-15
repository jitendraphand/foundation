import { env } from '../env.js';
import { prisma } from '../db.js';

export interface WhatsappPayload {
  to: string; // E.164 without + or 10-digit Indian
  message: string;
}

function normalizeMobile(mobile: string): string | null {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`; // default India
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

/**
 * Sends WhatsApp via n8n webhook if configured, otherwise logs.
 * N8N webhook is stored in Setting `n8n.whatsappWebhookUrl`.
 * System Administrator configures it in Settings → n8n.
 */
export async function sendWhatsapp(to: string, message: string): Promise<{ sent: boolean; via: 'n8n' | 'log'; error?: string }> {
  const normalized = normalizeMobile(to);
  if (!normalized) return { sent: false, via: 'log', error: 'Invalid mobile' };

  let webhookUrl: string | null = null;
  try {
    const row = await prisma.setting.findUnique({ where: { key: 'n8n.whatsappWebhookUrl' } }).catch(() => null);
    webhookUrl = typeof row?.value === 'string' ? row.value : null;
    if (!webhookUrl) webhookUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL ?? null;
  } catch {
    webhookUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL ?? null;
  }

  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: normalized, message, from: 'Foundation' }),
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
  console.log(`[whatsapp] to ${normalized}: ${message}`);
  return { sent: true, via: 'log' };
}

export function formatResetMessage(username: string, newPassword: string): string {
  return `Foundation: Your password has been reset.\nUsername: ${username}\nNew temporary password: ${newPassword}\nYou will be asked to change it on next login. Keep it private.`;
}
