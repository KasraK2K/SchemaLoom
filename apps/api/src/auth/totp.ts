import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30-second steps) and the at-rest encryption of its secret.
 * Both are a few lines over `node:crypto`, which is why there is no dependency here.
 */

/** Doc 01 §11.1: `TOTP_ISSUER` is a const, not an env var. It is the product name. */
export const TOTP_ISSUER = 'SchemaLoom';
const STEP_SEC = 30;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — what authenticator apps expect in `secret=`. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with the RFC 6238 counter. `digits` is 6 in the product, 8 in the RFC vectors. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0xf;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SEC);
}

/**
 * The step `code` matches within ±1 step of `nowMs` (clock drift on a phone is normal),
 * or null. The caller uses the step to refuse a replay of the same code.
 */
export function verifyTotp(key: Buffer, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  for (const step of [current - 1, current, current + 1]) {
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function otpauthUri(email: string, secret: Buffer): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: '6',
    period: String(STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ------------------------------------------------------------ at-rest encryption

/**
 * AES-256-GCM under `SECRETS_ENCRYPTION_KEY` (32 bytes, base64 — `env.ts` checks the
 * length). Stored as `iv.tag.ciphertext`, base64url. GCM's tag means a tampered column
 * fails to decrypt instead of yielding a different secret.
 */
export function encryptSecret(plain: Buffer, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(stored: string, keyBase64: string): Buffer {
  const [iv, tag, ciphertext] = stored.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !ciphertext) throw new Error('malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// --------------------------------------------------------------- recovery codes

/** `xxxxx-xxxxx`, 50 bits each. High entropy, so a plain sha256 is enough at rest. */
export function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Case, spaces and the dash are forgiven — people retype these from paper. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.toLowerCase().replace(/[\s-]/g, '')).digest('hex');
}
