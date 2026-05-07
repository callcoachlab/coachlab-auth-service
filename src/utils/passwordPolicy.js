// Production password policy:
// - 10..128 chars
// - at least one lowercase, one uppercase, one digit, one special char
// - cannot contain the local part of the user's email (case-insensitive, when local part > 2 chars)
// - cannot match a small built-in list of the most common passwords

export const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+[\]{}|;:'",.<>?/\\`~]).{10,128}$/;

// Tiny built-in "common passwords" set. Replace with a top-10k list in production
// (e.g. via the `common-passwords` package). Kept inline so the package has no new deps.
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty',
  'qwerty123',
  'abc123',
  '123456',
  '12345678',
  '123456789',
  '1234567890',
  'iloveyou',
  'admin',
  'admin123',
  'welcome',
  'welcome1',
  'letmein',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'master',
  'sunshine',
  'princess',
  'shadow',
  'superman',
  'batman',
  'trustno1',
  'starwars',
  'p@ssw0rd',
  'p@ssword',
  'pa$$w0rd',
]);

export function validatePassword(password, email = '') {
  if (typeof password !== 'string') {
    return { valid: false, reason: 'Password is required' };
  }

  if (password.length < 10) {
    return { valid: false, reason: 'Password must be at least 10 characters' };
  }

  if (password.length > 128) {
    return { valid: false, reason: 'Password must be at most 128 characters' };
  }

  if (!PASSWORD_REGEX.test(password)) {
    return {
      valid: false,
      reason:
        'Password must include uppercase, lowercase, a number, and a special character',
    };
  }

  if (typeof email === 'string' && email.includes('@')) {
    const local = email.split('@')[0].toLowerCase();
    if (local.length > 2 && password.toLowerCase().includes(local)) {
      return { valid: false, reason: 'Password cannot contain your email address' };
    }
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return {
      valid: false,
      reason: 'Password is too common. Choose something more unique.',
    };
  }

  return { valid: true };
}
