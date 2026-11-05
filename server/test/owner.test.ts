import { describe, expect, it } from 'vitest';
import { OwnerAuth, ownerToken } from '../src/http/owner.js';
import { Store } from '../src/store.js';

const PASSWORD = 'long enough password';

describe('owner password', () => {
  it('chooses the first password only with the code from the terminal', async () => {
    const store = new Store(':memory:');
    const owner = new OwnerAuth(store);
    expect(owner.passwordSet()).toBe(false);
    await expect(owner.setup('not-the-code', PASSWORD)).rejects.toMatchObject({ status: 403 });
    await expect(owner.setup(owner.setupCode!, 'short')).rejects.toMatchObject({ status: 400 });

    const session = await owner.setup(owner.setupCode!, PASSWORD);
    expect(owner.check(session)).toBe(true);
    await expect(owner.setup(owner.setupCode!, 'another password')).rejects.toMatchObject({ status: 409 });
    expect(store.getSetting('owner_password')).not.toContain(PASSWORD);

    // After a restart the password stays (hashed) and the owner signs in again.
    const restarted = new OwnerAuth(store);
    expect(restarted.setupCode).toBeNull();
    expect(restarted.check(session)).toBe(false);
    await expect(restarted.login('wrong password')).rejects.toMatchObject({ status: 401 });
    expect(restarted.check(await restarted.login(PASSWORD))).toBe(true);
  });

  it('ends a session after its lifetime', async () => {
    let now = 1_000_000;
    const owner = new OwnerAuth(new Store(':memory:'), 60_000, () => now);
    const session = await owner.setup(owner.setupCode!, PASSWORD);
    now += 59_000;
    expect(owner.check(session)).toBe(true);
    now += 2_000;
    expect(owner.check(session)).toBe(false);
  });

  it('reads the session from the cookie header', () => {
    expect(ownerToken('theme=dark; allowance_owner=abc%2Bdef; other=1')).toBe('abc+def');
    expect(ownerToken(undefined)).toBeUndefined();
  });
});
