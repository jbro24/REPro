const crypto = require('node:crypto');

const PASSWORD_PARAMS = Object.freeze({ N: 16_384, r: 8, p: 1 });
const PASSWORD_MIN_LENGTH = 12;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, {
    N: PASSWORD_PARAMS.N,
    r: PASSWORD_PARAMS.r,
    p: PASSWORD_PARAMS.p,
    maxmem: 32 * 1024 * 1024,
  });
  return `scrypt$${PASSWORD_PARAMS.N}$${PASSWORD_PARAMS.r}$${PASSWORD_PARAMS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltEncoded, digestEncoded] = encoded.split('$');
    if (algorithm !== 'scrypt') return false;

    const salt = Buffer.from(saltEncoded, 'base64url');
    const expected = Buffer.from(digestEncoded, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 32 * 1024 * 1024,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > 256) {
    return `Password must be between ${PASSWORD_MIN_LENGTH} and 256 characters.`;
  }
  return null;
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(email) {
  return email.length >= 3 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  hashPassword,
  hashToken,
  isValidEmail,
  normalizeEmail,
  randomToken,
  safeEqualText,
  validatePassword,
  verifyPassword,
};
