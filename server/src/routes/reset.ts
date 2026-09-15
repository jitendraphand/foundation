import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { checkPassword, hashPassword } from '../lib/password.js';
import { revokeAllSessions } from '../services/sessions.js';
import { sendWhatsapp, formatResetMessage } from '../services/whatsapp.js';
import { sendEmail, formatResetEmail, maskEmail } from '../services/email.js';
import { audit } from '../middleware/auth.js';

/**
 * Self-service password reset over WhatsApp or email.
 *
 * Public (no session), so it is rate limited hard and verifies identity before
 * touching anything:
 *
 *   - Students: username + date of birth + roll number. All three must match
 *     the one account; a wrong guess reveals nothing either way.
 *   - Staff/administrators: username only, because roll numbers and classes do
 *     not apply — but the reset only ever lands on the mobile or email the
 *     System Administrator stored, so possession of the phone or inbox is the
 *     second factor.
 *
 * The new password is never shown in the browser. It travels only to the
 * registered mobile or email address, so a classmate who knows somebody's
 * username and birthday still cannot take the account over.
 */

const RESET_LIMIT = { rateLimit: { max: 5, timeWindow: '15 minutes' } };

function generateTempPassword(): string {
  // Pronounceable enough to read out of WhatsApp, random enough not to guess.
  const words = ['sun', 'river', 'moon', 'hill', 'star', 'leaf', 'cloud', 'stone', 'bird', 'wave', 'tree', 'fire'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const n = () => Math.floor(Math.random() * 10);
  return `${pick()}${pick()}${n()}${n()}${n()}`;
}

export default async function resetRoutes(app: FastifyInstance) {
  /**
   * Tells the sign-in screen whether self-service reset can actually deliver.
   * `offered` reflects the flow itself (always available; without delivery it
   * falls back to the office), while `channels` says which legs have an n8n
   * webhook — the same Settings the admin configures and sendWhatsapp /
   * sendEmail consult, so this cannot disagree with what a reset request
   * would really do. `channelConfigured` is kept for older clients and means
   * the WhatsApp leg.
   */
  app.get('/api/reset/availability', async () => {
    const [whatsappRow, emailRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'n8n.whatsappWebhookUrl' } }).catch(() => null),
      prisma.setting.findUnique({ where: { key: 'n8n.emailWebhookUrl' } }).catch(() => null),
    ]);
    const whatsapp =
      Boolean(process.env.N8N_WHATSAPP_WEBHOOK_URL) ||
      (typeof whatsappRow?.value === 'string' && Boolean(whatsappRow.value));
    const email =
      Boolean(process.env.N8N_EMAIL_WEBHOOK_URL) ||
      (typeof emailRow?.value === 'string' && Boolean(emailRow.value));
    return { offered: true, channelConfigured: whatsapp, channels: { whatsapp, email } };
  });

  app.post('/api/reset/request', {
    config: RESET_LIMIT,
  }, async (request, reply) => {
    const body = z
      .object({
        username: z.string().trim().toLowerCase().min(1).max(40),
        role: z.enum(['STUDENT', 'STAFF']).default('STUDENT'),
        dateOfBirth: z.string().optional(),
        rollNo: z.string().trim().max(20).optional(),
        channel: z.enum(['whatsapp', 'email']).default('whatsapp'),
      })
      .parse(request.body);

    const user = await prisma.user.findFirst({
      where: { username: body.username, deletedAt: null, isActive: true },
    });

    // Uniform refusal: never say which field was wrong.
    const fail = () => reply.code(400).send({
      error: 'Those details do not match an active account. Check the spelling, or ask your teacher for help.',
    });

    if (!user) return fail();

    if (body.role === 'STUDENT') {
      if (user.role !== 'STUDENT') return fail();
      // All three must match. DOB is compared as a date, not a string.
      if (!body.dateOfBirth || !body.rollNo) return fail();
      const dob = new Date(body.dateOfBirth);
      if (Number.isNaN(dob.getTime())) return fail();
      const dobMatches =
        user.dateOfBirth.getUTCFullYear() === dob.getUTCFullYear() &&
        user.dateOfBirth.getUTCMonth() === dob.getUTCMonth() &&
        user.dateOfBirth.getUTCDate() === dob.getUTCDate();
      if (!dobMatches) return fail();
      if (user.rollNo.trim().toLowerCase() !== body.rollNo.trim().toLowerCase()) return fail();
    } else {
      // Staff: username alone identifies, but only administrators with a mobile
      // on file can complete the reset — the phone is the second factor.
      if (user.role !== 'ADMIN') return fail();
    }

    // The channel decides which registered contact must exist. Asking for a
    // channel with nothing on file is refused the same vague way as a wrong
    // guess would be — except here the account is already identified, so the
    // message can name the missing field without leaking anything new.
    if (body.channel === 'email') {
      if (!user.email) {
        return reply.code(400).send({
          error: 'No email address is registered for this account. Ask the System Administrator to add one, then reset in person.',
        });
      }
    } else if (!user.mobile) {
      return reply.code(400).send({
        error: 'No mobile number is registered for this account. Ask the System Administrator to add one, then reset in person.',
      });
    }

    const newPassword = generateTempPassword();
    const policy = checkPassword(newPassword, {
      username: user.username, firstName: user.firstName, lastName: user.lastName,
    });
    // The generated password is machine-made; if policy somehow rejects it,
    // lengthen rather than leak a failure.
    const finalPassword = policy.ok ? newPassword : `${newPassword}x9`;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(finalPassword),
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
        passwordSetAt: new Date(),
      },
    });
    await revokeAllSessions(user.id, 'password_changed');

    let delivery: { sent: boolean; via: 'n8n' | 'log'; error?: string };
    if (body.channel === 'email') {
      const { subject, message } = formatResetEmail(user.username, finalPassword);
      delivery = await sendEmail(user.email!, subject, message);
    } else {
      delivery = await sendWhatsapp(user.mobile!, formatResetMessage(user.username, finalPassword));
    }

    await audit(null, 'auth.self_reset', {
      entity: 'User', entityId: user.id, ip: request.ip,
      detail: { role: user.role, channel: body.channel, via: delivery.via, sent: delivery.sent },
    });

    if (!delivery.sent) {
      // The password HAS been changed; the old one no longer works. Say so and
      // point at the office rather than pretending nothing happened.
      const where = body.channel === 'email' ? 'email message' : 'WhatsApp message';
      return reply.code(502).send({
        error: `Your password was reset but the ${where} could not be delivered. Ask the office to set a new one in person.`,
      });
    }

    if (body.channel === 'email') {
      return {
        ok: true,
        message:
          delivery.via === 'n8n'
            ? `A new password has been sent by email to ${maskEmail(user.email!)}. It must be changed at next sign-in.`
            : 'Reset recorded. The message channel is not configured, so ask the office for the new password.',
      };
    }

    return {
      ok: true,
      message:
        delivery.via === 'n8n'
          ? `A new password has been sent by WhatsApp to the registered mobile ending ${user.mobile!.slice(-4)}. It must be changed at next sign-in.`
          : 'Reset recorded. The message channel is not configured, so ask the office for the new password.',
    };
  });
}
