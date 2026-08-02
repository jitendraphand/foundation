import crypto from 'node:crypto';
import { env } from '../env.js';

/**
 * AES-256-GCM encryption for LLM API keys held in the database.
 *
 * The key material is derived from ENCRYPTION_KEY with scrypt so that any
 * length of passphrase produces a valid 32-byte key. The salt is fixed and
 * derived from the passphrase itself: we need the derivation to be
 * deterministic across restarts, and the passphrase is already high-entropy
 * (the deploy guide generates it with `openssl rand -base64 48`).
 *
 * Format on disk: v1.<iv-b64>.<authTag-b64>.<ciphertext-b64>
 * The version prefix means a future algorithm change can decrypt old rows.
 */

const VERSION = 'v1';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const salt = crypto.createHash('sha256').update(`foundation:kdf:${env.ENCRYPTION_KEY}`).digest();
  cachedKey = crypto.scryptSync(env.ENCRYPTION_KEY, salt, 32);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored secret is malformed or was written by another version.');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      'Could not decrypt stored API key. ENCRYPTION_KEY has changed since it was saved - re-enter the key in Admin > Settings.',
    );
  }
}

export function keyHint(secret: string): string {
  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

export function sha256File(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
