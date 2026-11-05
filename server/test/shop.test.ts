import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Mandates } from '../src/mandate.js';
import { createShopApp } from '../src/shop.js';
import type { Purchase } from '../src/store.js';

const SHOP_DIR = fileURLToPath(new URL('../../demo/shop', import.meta.url));
const keyStore = () => {
  const settings = new Map<string, string>();
  return { getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string) => void settings.set(key, value) };
};

const PAPER = {
  id: 'req_01PAPER',
  agentId: 'agt_1',
  agentName: 'Home office agent',
  merchant: 'Inkwell Supplies',
  items: [
    { name: 'Recycled printer paper, 500 sheets', quantity: 1, unitPriceCents: 849, category: 'office_supplies' },
    { name: 'Standard shipping', quantity: 1, unitPriceCents: 399, category: 'shipping_tax' },
  ],
  amountCents: 1248,
  currency: 'EUR',
  decision: 'approve',
  status: 'paid',
  paypalMode: 'sandbox',
  paypalOrderId: '1AB23456CD789012E',
  paypalCaptureId: '9ZX87654YW321098V',
  settledAt: '2026-11-05T17:00:00Z',
  updatedAt: '2026-11-05T17:00:00Z',
} as unknown as Purchase;

describe('the demo shop takes agent orders only with a signed cart that checks out', () => {
  let server: Server;
  let base: string;
  const mandates = new Mandates(keyStore(), 'http://localhost:4000');
  const order = (body: unknown) =>
    fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(async () => {
    server = createShopApp(SHOP_DIR, 'EUR', { keys: async () => mandates.jwks() }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('confirms an order whose signed cart matches its catalog, once', async () => {
    const cart = mandates.cart(PAPER)!;
    const first = await order({ cart_mandate: cart });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'confirmed', order_id: 'INK-1001' });
    // The same signed cart cannot buy twice.
    expect((await order({ cart_mandate: cart })).status).toBe(409);
    expect(await (await fetch(`${base}/orders`)).text()).toContain('INK-1001');
  });

  it('refuses a cart that was changed, signed by someone else, or priced differently from the shop', async () => {
    const cart = mandates.cart(PAPER)!;
    const [header, body, signature] = cart.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    payload.items[0].quantity = 5;
    const changed = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    expect(await (await order({ cart_mandate: changed })).json()).toMatchObject({ status: 'refused', reason: expect.stringMatching(/signature does not match/) });

    const stranger = new Mandates(keyStore(), 'http://elsewhere.example').cart(PAPER)!;
    expect((await order({ cart_mandate: stranger })).status).toBe(400);

    const cheap = mandates.cart({ ...PAPER, id: 'req_02', items: [{ ...PAPER.items[0]!, unitPriceCents: 149 }], amountCents: 149 } as Purchase)!;
    expect(await (await order({ cart_mandate: cheap })).json()).toMatchObject({ reason: expect.stringMatching(/costs 8.49, not 1.49/) });

    const fee = mandates.cart({ ...PAPER, id: 'req_03', items: [{ name: 'Assistant Priority Handling add-on', quantity: 1, unitPriceCents: 2400, category: 'office_supplies' }], amountCents: 2400 } as Purchase)!;
    expect(await (await order({ cart_mandate: fee })).json()).toMatchObject({ reason: expect.stringMatching(/does not sell/) });
    expect((await order({})).status).toBe(400);
  });
});
