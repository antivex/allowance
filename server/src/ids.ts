import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A sortable id: prefix, 10 characters of time, 16 of randomness (ULID layout). */
export function newId(prefix: string, now: number = Date.now()): string {
  let time = '';
  let rest = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const random = Array.from(randomBytes(16), (byte) => CROCKFORD[byte % 32]).join('');
  return `${prefix}_${time}${random}`;
}

/** An agent token: shown once, stored only as a hash. */
export function newToken(): string {
  return `alw_${randomBytes(24).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
