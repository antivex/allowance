import { describe, expect, it } from 'vitest';
import { exampleRules, exampleRulesText } from '../src/ai/compiler.js';
import { Mandates, MandateError, verifyMandate, type CartMandate, type IntentMandate } from '../src/mandate.js';
import type { Agent, Purchase, RulesRecord } from '../src/store.js';

const keyStore = () => {
  const settings = new Map<string, string>();
  return { getSetting: (key: string) => settings.get(key) ?? null, setSetting: (key: string, value: string) => void settings.set(key, value) };
};

const NOW = new Date('2026-11-05T17:00:00Z');
const AGENT: Agent = { id: 'agt_1', name: 'Home office agent', tokenHint: 'alw_…', createdAt: NOW.toISOString(), revokedAt: null };
const RULES: RulesRecord = { id: 3, sourceText: exampleRulesText('EUR'), rules: { ...exampleRules('EUR'), categoryLimits: { household: 90 } }, compiledBy: 'test', confirmedAt: NOW.toISOString() };

const CHAIR = {
  id: 'req_01CHAIR',
  agentId: 'agt_1',
  agentName: 'Home office agent',
  merchant: 'Inkwell Supplies',
  items: [{ name: 'Mesh desk chair', quantity: 1, unitPriceCents: 8900, category: 'household' }],
  amountCents: 8900,
  currency: 'EUR',
  decision: 'ask',
  status: 'paid',
  paypalMode: 'sandbox',
  paypalOrderId: '784826735C211101M',
  paypalCaptureId: '9XB43418CH304333R',
  settledAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
} as unknown as Purchase;

describe('spending mandates (AP2-style, signed with Ed25519)', () => {
  it("signs what an agent may spend without asking, and the owner's key alone checks it", () => {
    const mandates = new Mandates(keyStore(), 'http://localhost:4000', () => NOW);
    const { mandate } = mandates.intent(AGENT, RULES);
    const said = verifyMandate<IntentMandate>(mandate, mandates.jwks(), NOW);
    expect(said).toMatchObject({ type: 'intent_mandate', sub: 'agt_1', agent: 'Home office agent', currency: 'EUR' });
    expect(said.spend_without_asking).toEqual({
      per_purchase_max: '50.00',
      category_limits: { household: '90.00' },
      weekly_budget: '150.00',
      allowed_categories: ['office_supplies'],
      allowed_merchants: 'any not refused',
    });
    expect(said.refused.categories).toEqual(['gift_cards', 'crypto']);
    expect(said.exp - said.iat).toBe(24 * 3600);
  });

  it('refuses a mandate that was changed, signed by another key, or has expired', () => {
    const mandates = new Mandates(keyStore(), 'http://localhost:4000', () => NOW);
    const { mandate } = mandates.intent(AGENT, RULES);
    const [header, body, signature] = mandate.split('.') as [string, string, string];
    const raised = JSON.parse(Buffer.from(body, 'base64url').toString());
    raised.spend_without_asking.per_purchase_max = '5000.00';
    const forged = `${header}.${Buffer.from(JSON.stringify(raised)).toString('base64url')}.${signature}`;
    expect(() => verifyMandate(forged, mandates.jwks(), NOW)).toThrow(MandateError);
    const other = new Mandates(keyStore(), 'http://localhost:4000', () => NOW);
    expect(() => verifyMandate(mandate, other.jwks(), NOW)).toThrow(/key this issuer does not publish/);
    expect(() => verifyMandate(mandate, mandates.jwks(), new Date(NOW.getTime() + 25 * 3600_000))).toThrow(/expired/);
  });

  it('signs the cart of a paid purchase with the PayPal ids, and nothing before the money moves', () => {
    const mandates = new Mandates(keyStore(), 'http://localhost:4000', () => NOW);
    const cart = verifyMandate<CartMandate>(mandates.cart(CHAIR)!, mandates.jwks(), NOW);
    expect(cart).toMatchObject({
      type: 'cart_mandate',
      jti: 'req_01CHAIR',
      merchant: 'Inkwell Supplies',
      amount: '89.00',
      currency: 'EUR',
      approved_by: 'owner',
      paypal: { mode: 'sandbox', order_id: '784826735C211101M', capture_id: '9XB43418CH304333R' },
    });
    expect(cart.items).toEqual([{ name: 'Mesh desk chair', quantity: 1, unit_price: '89.00' }]);
    expect(mandates.cart({ ...CHAIR, status: 'on_hold' } as Purchase)).toBeNull();
  });

  it('keeps one signing key across restarts', () => {
    const store = keyStore();
    expect(new Mandates(store, 'x').kid).toBe(new Mandates(store, 'x').kid);
  });
});
