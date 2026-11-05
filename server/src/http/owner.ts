import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store.js';

/** The cookie that carries the owner's session. HttpOnly, so no script on the page can read it. */
export const OWNER_COOKIE = 'allowance_owner';
export const MIN_PASSWORD_LENGTH = 8;

const SETTING = 'owner_password';
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
/** Wrong passwords allowed per minute before sign-in pauses, so a local program cannot guess its way in. */
const MAX_FAILURES = 5;

export class OwnerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const derive = (password: string, salt: Buffer, N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The owner's password and sessions. Agents hold a token for the MCP endpoint only; approving, denying, rules, agents
 * and the PayPal link need the owner's password. The first password is chosen through a one-time link that the server
 * prints in its own terminal, so a program that merely reaches the port cannot claim the dashboard first.
 */
export class OwnerAuth {
  /** One-time code for choosing the first password; null once a password exists. */
  readonly setupCode: string | null;
  private readonly sessions = new Map<string, number>();
  private failures: number[] = [];

  constructor(
    private readonly store: Store,
    private readonly sessionMs = 7 * 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    this.setupCode = this.passwordSet() ? null : randomBytes(12).toString('base64url');
  }

  passwordSet(): boolean {
    return this.store.getSetting(SETTING) !== null;
  }

  /** Chooses the first password with the code from the server's terminal, and signs the owner in. */
  async setup(code: string, password: string): Promise<string> {
    if (this.passwordSet()) throw new OwnerError('The owner password is already set: sign in instead.', 409);
    if (!this.setupCode || !sameText(code, this.setupCode)) {
      throw new OwnerError('Open the first-run link printed in the terminal where Allowance runs.', 403);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new OwnerError(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
    }
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    this.store.setSetting(SETTING, ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$'));
    return this.newSession();
  }

  async login(password: string): Promise<string> {
    const stored = this.store.getSetting(SETTING);
    if (!stored) throw new OwnerError('There is no owner password yet: open the first-run link printed in the terminal.', 409);
    const now = this.now();
    this.failures = this.failures.filter((at) => now - at < 60_000);
    if (this.failures.length >= MAX_FAILURES) throw new OwnerError('Too many wrong passwords. Wait a minute, then try again.', 429);
    const [, N, r, p, salt, key] = stored.split('$');
    const expected = Buffer.from(key ?? '', 'base64');
    const actual = await derive(password, Buffer.from(salt ?? '', 'base64'), Number(N), Number(r), Number(p));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.failures.push(now);
      throw new OwnerError('Wrong password.', 401);
    }
    this.failures = [];
    return this.newSession();
  }

  /** True for a live owner session. Sessions live in memory: a restart signs the owner out. */
  check(token: string | undefined): boolean {
    if (!token) return false;
    const key = digest(token);
    const expires = this.sessions.get(key);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(digest(token));
  }

  get sessionSeconds(): number {
    return Math.floor(this.sessionMs / 1000);
  }

  private newSession(): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(digest(token), this.now() + this.sessionMs);
    return token;
  }
}

/** The owner's session token from the request's cookies, if any. */
export function ownerToken(cookieHeader: string | undefined): string | undefined {
  for (const part of (cookieHeader ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === OWNER_COOKIE) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
