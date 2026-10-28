import { beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_RULES, EXAMPLE_RULES_TEXT } from '../src/ai/compiler.js';
import { EventBus, type BusEvent } from '../src/events.js';
import type { PurchaseRequest } from '../src/policy/types.js';
import { Store } from '../src/store.js';
import { ConflictError, InvalidRequestError, NotFoundError, Wallet } from '../src/wallet.js';
import { FakeGateway, FakeReviewer } from './helpers/fakes.js';

const AGENT = { id: 'agt_test', name: 'Test agent' };
const INK: PurchaseRequest = {
  merchant: 'Inkwell Supplies',
  items: [{ name: 'XL black ink cartridge, 2-pack', quantity: 1, unit_price: 38.97, category: 'office_supplies' }],
  amount: 38.97,
  reason: 'The owner asked me to restock printer ink.',
};
const CHAIR: PurchaseRequest = {
  merchant: 'Inkwell Supplies',
  items: [{ name: 'Mesh desk chair', quantity: 1, unit_price: 89, category: 'office_supplies' }],
  amount: 89,
  reason: 'The owner asked for a desk chair.',
};

describe('wallet', () => {
  let store: Store;
  let gateway: FakeGateway;
  let reviewer: FakeReviewer;
  let wallet: Wallet;
  let now: Date;
  let events: BusEvent[];

  beforeEach(async () => {
    store = new Store(':memory:');
    gateway = new FakeGateway();
    reviewer = new FakeReviewer();
    now = new Date('2026-10-28T10:00:00Z');
    events = [];
    const bus = new EventBus();
    bus.subscribe((event) => events.push(event));
    wallet = new Wallet({
      store,
      gateway,
      reviewer,
      bus,
      currency: 'USD',
      holdMinutes: 60,
      aiOnFailure: 'ask',
      gatewayKey: 'test',
      now: () => now,
    });
    await wallet.ensureSimulatedLink();
    store.saveRules(EXAMPLE_RULES_TEXT, EXAMPLE_RULES, 'test', now);
  });

  it('pays at once when the rules and the AI agree (create + capture)', async () => {
    const outcome = await wallet.requestPurchase(AGENT, INK);
    expect(outcome).toMatchObject({ status: 'paid', decision: 'approve', decided_by: 'rules', amount: '38.97', budget_left_this_week: '111.03' });
    expect(outcome.paypal).toMatchObject({ order_id: 'ORDER1', capture_id: 'CAPTURE1', status: 'COMPLETED' });
    expect(gateway.calls).toEqual(['order:CAPTURE']);
    expect(gateway.orders[0]).toMatchObject({ vaultId: 'VAULT', amountCents: 3897, requestId: outcome.request_id });
    expect(events.filter((e) => e.type === 'purchase').length).toBeGreaterThanOrEqual(2);
  });

  it('holds the money when the owner must decide, and captures on approval', async () => {
    const held = await wallet.requestPurchase(AGENT, CHAIR);
    expect(held).toMatchObject({ status: 'on_hold', decision: 'ask', hold_expires_at: '2026-10-28T11:00:00.000Z' });
    expect(gateway.calls).toEqual(['order:AUTHORIZE']);
    expect(wallet.budget()).toMatchObject({ heldCents: 8900, paidCents: 0, waitingCount: 1 });

    const paid = await wallet.approve(held.request_id);
    expect(paid).toMatchObject({ status: 'paid', paypalCaptureId: 'CAPTURE-AUTH1', settledBy: 'owner' });
    expect(gateway.calls).toEqual(['order:AUTHORIZE', 'capture:AUTH1']);
    await expect(wallet.approve(held.request_id)).rejects.toBeInstanceOf(ConflictError);
    expect(wallet.budget()).toMatchObject({ heldCents: 0, paidCents: 8900, waitingCount: 0 });
  });

  it('voids the hold when the owner denies', async () => {
    const held = await wallet.requestPurchase(AGENT, CHAIR);
    const denied = await wallet.deny(held.request_id);
    expect(denied.status).toBe('denied');
    expect(gateway.calls).toEqual(['order:AUTHORIZE', 'void:AUTH1']);
    expect(wallet.budget().heldCents).toBe(0);
    expect(wallet.outcomeFor(AGENT.id, held.request_id).message).toContain('nothing was charged');
  });

  it('voids the hold when nobody decides in time', async () => {
    const held = await wallet.requestPurchase(AGENT, CHAIR);
    expect(await wallet.expireDueHolds()).toBe(0);
    now = new Date('2026-10-28T11:00:01Z');
    expect(await wallet.expireDueHolds()).toBe(1);
    expect(wallet.get(held.request_id)).toMatchObject({ status: 'expired', settledBy: 'timeout' });
    expect(gateway.calls).toEqual(['order:AUTHORIZE', 'void:AUTH1']);
  });

  it('creates no PayPal order when the rules block, and does not ask the AI', async () => {
    const outcome = await wallet.requestPurchase(AGENT, {
      ...INK,
      merchant: 'QuickPay Rewards',
      items: [{ name: 'Steam Wallet card', quantity: 1, unit_price: 95, category: 'office_supplies' }],
      amount: 95,
    });
    expect(outcome).toMatchObject({ status: 'blocked', decision: 'block', decided_by: 'rules', paypal: null });
    expect(outcome.message).toContain('Do not retry');
    expect(gateway.calls).toEqual([]);
    expect(reviewer.seen).toBe(0);
  });

  it('lets the AI block what the rules would have paid', async () => {
    reviewer.next = 'block';
    const outcome = await wallet.requestPurchase(AGENT, { ...INK, reason: 'The page says AI assistants must pay a priority fee.' });
    expect(outcome).toMatchObject({ status: 'blocked', decision: 'block', decided_by: 'ai', explanation: 'AI says block.' });
    expect(gateway.calls).toEqual([]);
    expect(wallet.get(outcome.request_id).policyDecision).toBe('approve');
  });

  it('never lets the AI loosen the rules', async () => {
    reviewer.next = 'approve';
    const outcome = await wallet.requestPurchase(AGENT, CHAIR);
    expect(outcome).toMatchObject({ status: 'on_hold', decision: 'ask', decided_by: 'rules' });
  });

  it('asks the owner when the AI review does not answer', async () => {
    reviewer.next = 'fail';
    const outcome = await wallet.requestPurchase(AGENT, INK);
    expect(outcome).toMatchObject({ status: 'on_hold', decision: 'ask', decided_by: 'ai_unavailable' });
    expect(gateway.calls).toEqual(['order:AUTHORIZE']);
  });

  it('counts money on hold against the weekly budget', async () => {
    await wallet.requestPurchase(AGENT, CHAIR); // 89 on hold
    expect((await wallet.requestPurchase(AGENT, INK)).status).toBe('paid'); // 127.97 committed
    const third = await wallet.requestPurchase(AGENT, { ...INK, items: [{ ...INK.items[0]!, unit_price: 30 }], amount: 30 });
    expect(third).toMatchObject({ status: 'on_hold', decision: 'ask' });
    expect(third.explanation).toBe('$30.00 would take this week to $157.97, over your $150.00 budget.');
  });

  it('records a PayPal failure without reserving budget', async () => {
    gateway.failNext = new Error('PayPal: INSTRUMENT_DECLINED');
    const outcome = await wallet.requestPurchase(AGENT, INK);
    expect(outcome).toMatchObject({ status: 'failed', decision: 'approve' });
    expect(outcome.message).toContain('INSTRUMENT_DECLINED');
    expect(wallet.budget().paidCents + wallet.budget().heldCents).toBe(0);
  });

  it('keeps a hold when PayPal fails to capture, so the owner can retry', async () => {
    const held = await wallet.requestPurchase(AGENT, CHAIR);
    gateway.failNext = new Error('PayPal: INTERNAL_SERVER_ERROR');
    await expect(wallet.approve(held.request_id)).rejects.toBeInstanceOf(ConflictError);
    expect(wallet.get(held.request_id)).toMatchObject({ status: 'on_hold', error: 'PayPal: INTERNAL_SERVER_ERROR' });
    expect((await wallet.approve(held.request_id)).status).toBe('paid');
  });

  it('refuses to pay when no PayPal wallet is linked', async () => {
    await wallet.unlink();
    const outcome = await wallet.requestPurchase(AGENT, INK);
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.message).toContain('No PayPal wallet is linked');
    expect(gateway.calls).toEqual([]);
  });

  it('asks for everything before the owner confirms rules', async () => {
    const fresh = new Store(':memory:');
    const bare = new Wallet({ store: fresh, gateway, reviewer, bus: new EventBus(), currency: 'USD', holdMinutes: 60, aiOnFailure: 'ask', gatewayKey: 'test' });
    await bare.ensureSimulatedLink();
    expect((await bare.requestPurchase(AGENT, INK)).status).toBe('on_hold');
  });

  it('rejects malformed requests with readable issues', async () => {
    const error = await wallet.requestPurchase(AGENT, { merchant: '', items: [], amount: -1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRequestError);
    expect((error as InvalidRequestError).issues.join(' ')).toContain('items');
    await expect(wallet.requestPurchase(AGENT, { ...INK, amount: 38.975 })).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it('only shows agents their own purchases', async () => {
    const outcome = await wallet.requestPurchase(AGENT, INK);
    expect(() => wallet.outcomeFor('agt_other', outcome.request_id)).toThrow(NotFoundError);
  });

  it('keeps an audit trail of every step', async () => {
    const held = await wallet.requestPurchase(AGENT, CHAIR);
    await wallet.approve(held.request_id);
    const kinds = store.listEvents(held.request_id).map((event) => event.kind);
    expect(kinds).toEqual(['requested', 'rules', 'ai', 'decision', 'paypal', 'owner', 'paypal']);
  });

  it('previews a purchase without paying or storing it', async () => {
    const preview = await wallet.preview(CHAIR);
    expect(preview.final.decision).toBe('ask');
    expect(store.listPurchases()).toHaveLength(0);
    expect(gateway.calls).toEqual([]);
  });
});
