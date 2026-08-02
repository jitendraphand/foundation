import argon2 from 'argon2';

/**
 * Moderate password policy, as specified:
 *   - at least 8 characters
 *   - at least one letter
 *   - at least one digit
 *   - not one of the obvious common passwords
 *
 * Deliberately NOT requiring a symbol or mixed case: for a school-age audience
 * that mostly produces "Password1!" written on a desk. Length plus a digit
 * plus a common-password screen is the better trade.
 */

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'abc12345', 'iloveyou', 'admin123', 'welcome1', 'letmein1',
  'foundation', 'student1', 'football1', 'sunshine1', 'princess1', 'a1234567',
]);

export interface PasswordCheck {
  ok: boolean;
  errors: string[];
  score: 'weak' | 'fair' | 'good' | 'strong';
}

export function checkPassword(pw: string, context: { username?: string; firstName?: string; lastName?: string } = {}): PasswordCheck {
  const errors: string[] = [];

  if (pw.length < 8) errors.push('Must be at least 8 characters long.');
  if (pw.length > 128) errors.push('Must be 128 characters or fewer.');
  if (!/[A-Za-z]/.test(pw)) errors.push('Must contain at least one letter.');
  if (!/[0-9]/.test(pw)) errors.push('Must contain at least one number.');
  if (COMMON.has(pw.toLowerCase())) errors.push('That password is too common. Please choose another.');

  const lower = pw.toLowerCase();
  for (const [label, value] of Object.entries(context)) {
    if (value && value.length >= 3 && lower.includes(value.toLowerCase())) {
      errors.push(`Must not contain your ${label.replace(/([A-Z])/g, ' $1').toLowerCase()}.`);
      break;
    }
  }

  // Reject a single repeated character, e.g. "aaaaaaa1".
  if (/^(.)\1+[0-9]*$/.test(pw)) errors.push('Must not be a single repeated character.');

  let points = 0;
  if (pw.length >= 8) points++;
  if (pw.length >= 12) points++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) points++;
  if (/[0-9]/.test(pw)) points++;
  if (/[^A-Za-z0-9]/.test(pw)) points++;

  const score = points <= 2 ? 'weak' : points === 3 ? 'fair' : points === 4 ? 'good' : 'strong';

  return { ok: errors.length === 0, errors, score };
}

// Tuned for the 12 GB / 2 OCPU A1 shape: ~64 MB and 3 passes per hash keeps a
// login under ~150 ms while staying expensive for an offline cracker.
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, OPTIONS);
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}
