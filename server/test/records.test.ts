import { describe, expect, it } from 'vitest';
import { compare, type PayPalOrderView } from '../src/paypal/records.js';

const view = (over: Partial<PayPalOrderView>): PayPalOrderView => ({
  orderId: '5O190127TN364715T',
  intent: 'AUTHORIZE',
  orderStatus: 'COMPLETED',
  amount: '89.00 EUR',
  items: ['1 × Mesh desk chair'],
  authorization: null,
  capture: null,
  payee: 'shop@business.example.com',
  ...over,
});

describe('checking the ledger against PayPal', () => {
  it('matches each ledger outcome with what PayPal must show', () => {
    expect(compare('paid', view({ intent: 'CAPTURE', capture: { id: 'C1', status: 'COMPLETED' } }), '89.00 EUR').matches).toBe(true);
    expect(compare('paid', view({ authorization: { id: 'A1', status: 'CAPTURED' }, capture: { id: 'C1', status: 'COMPLETED' } }), '89.00 EUR').matches).toBe(true);
    expect(compare('on_hold', view({ authorization: { id: 'A1', status: 'CREATED' } }), '89.00 EUR').matches).toBe(true);
    expect(compare('denied', view({ authorization: { id: 'A1', status: 'VOIDED' } }), '89.00 EUR').matches).toBe(true);
  });

  it('flags a ledger that says one thing while PayPal says another', () => {
    // Paid in the ledger, but PayPal only holds the money.
    expect(compare('paid', view({ authorization: { id: 'A1', status: 'CREATED' } }), '89.00 EUR').matches).toBe(false);
    // Denied in the ledger, but PayPal captured it.
    expect(compare('denied', view({ authorization: { id: 'A1', status: 'CAPTURED' }, capture: { id: 'C1', status: 'COMPLETED' } }), '89.00 EUR').matches).toBe(false);
    // The right state for a different amount.
    expect(compare('paid', view({ amount: '98.00 EUR', capture: { id: 'C1', status: 'COMPLETED' } }), '89.00 EUR').matches).toBe(false);
  });
});
