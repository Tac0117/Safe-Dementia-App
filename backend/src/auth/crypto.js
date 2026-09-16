import crypto from 'crypto';

// --- Password hashing (scrypt, built into Node's crypto module) ---
// scrypt is a memory-hard KDF designed for exactly this job; this is a real,
// standard hashing scheme (not a toy), just without pulling in bcryptjs.

const SCRYPT_KEYLEN = 64;

export function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plainPassword, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

export function verifyPassword(plainPassword, salt, expectedHash) {
  const hash = crypto.scryptSync(plainPassword, salt, SCRYPT_KEYLEN).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // constant-time compare, avoids timing attacks
}

// --- Session tokens ---
// Random opaque token; we store only its hash server-side (sessions table),
// so a DB read never reveals a usable token. This is the same shape as a
// standard server-side session, just without the jsonwebtoken dependency.

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
