import { describe, expect, it } from 'vitest';
import { PayPalClient, PayPalError, type Exchange } from '../src/paypal/client.js';
import { GatewayError, SandboxGateway, buildOrderBody, type OrderInput } from '../src/paypal/gateway.js';
import { parsePayees } from '../src/config.js';
import { fixture, scriptedFetch } from './helpers/fixtures.js';

const VAULT_ID = '8kk8451t';

function clientWith(exchanges: Exchange[], options: { now?: () => number; onExchange?: (e: Exchange) => void } = {}) {
  const script = scriptedFetch(exchanges);
  const client = new PayPalClient({ clientId: 'test-client', clientSecret: 'test-secret', fetch: script.fetch, ...options });
  return { client, gateway: new SandboxGateway(client), ...script };
}

function orderInput(name: 'create-order-capture' | 'create-order-authorize'): OrderInput {
  const recorded = fixture(name).request.body as ReturnType<typeof buildOrderBody>;
  const unit = recorded.purchase_units[0]!;
  return {
    requestId: unit.reference_id,
    intent: recorded.intent,
    vaultId: VAULT_ID,
    currency: 'USD',
    amountCents: Math.round(Number(unit.amount.value) * 100),
    items: unit.items.map((item) => ({
      name: item.name,
      quantity: Number(item.quantity),
      unitPriceCents: Math.round(Number(item.unit_amount.value) * 100),
      category: 'office_supplies' as const,
    })),
    merchant: unit.description.replace('Allowance agent purchase at ', ''),
  };
}

describe('PayPal client against request/response fixtures written from the API reference', () => {
  it('pays from the linked wallet in one call when the rules approve (intent CAPTURE)', async () => {
    const { gateway, sent, remaining } = clientWith([fixture('oauth-token'), fixture('create-order-capture')]);
    const outcome = await gateway.createOrder(orderInput('create-order-capture'));

    expect(outcome).toEqual({
      orderId: '5O190127TN364715T',
      orderStatus: 'COMPLETED',
      captureId: '3C679366HH908993F',
      captureStatus: 'COMPLETED',
      authorizationId: null,
      authorizationStatus: null,
      authorizationExpiresAt: null,
    });
    expect(remaining()).toBe(0);

    const [token, order] = sent;
    expect(token!.headers.Authorization).toBe(`Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
    expect(order!.headers.Authorization).toBe('Bearer REDACTED');
    expect(order!.headers['PayPal-Request-Id']).toBe('req_01JBX7K3M2Q8ZP4V6T9W0YRC1D');
    expect(order!.headers.Prefer).toBe('return=representation');
    expect(order!.body).toEqual(fixture('create-order-capture').request.body);
  });

  it('holds the money when the owner must decide (intent AUTHORIZE)', async () => {
    const { gateway } = clientWith([fixture('oauth-token'), fixture('create-order-authorize')]);
    const outcome = await gateway.createOrder(orderInput('create-order-authorize'));
    expect(outcome.authorizationId).toBe('0VF52814937998046');
    expect(outcome.authorizationStatus).toBe('CREATED');
    expect(outcome.authorizationExpiresAt).toBe('2026-11-26T09:22:10Z');
    expect(outcome.captureId).toBeNull();
  });

  it('captures a held authorization when the owner approves', async () => {
    const { gateway, sent } = clientWith([fixture('oauth-token'), fixture('capture-authorization')]);
    const result = await gateway.capture('0VF52814937998046', 'req_01JBX7M8R5T2YQ6N3P0VWK4HZE-capture');
    expect(result).toEqual({ captureId: '7TK53561YB803214S', status: 'COMPLETED' });
    expect(sent[1]!.body).toEqual({ final_capture: true });
  });

  it('voids a held authorization when the owner denies or time runs out', async () => {
    const { gateway, sent } = clientWith([fixture('oauth-token'), fixture('void-authorization')]);
    expect(await gateway.void('0VF52814937998046', 'req_01JBX7M8R5T2YQ6N3P0VWK4HZE-void')).toEqual({ status: 'VOIDED' });
    expect(sent[1]!.headers['PayPal-Request-Id']).toBe('req_01JBX7M8R5T2YQ6N3P0VWK4HZE-void');
  });

  it('links the owner wallet with a setup token, then a payment token', async () => {
    const { gateway } = clientWith([fixture('oauth-token'), fixture('vault-setup-token'), fixture('vault-payment-token')]);
    const link = await gateway.startLink({
      returnUrl: 'http://localhost:4000/api/paypal/return',
      cancelUrl: 'http://localhost:4000/api/paypal/cancel',
      requestId: 'link_01JBX7A1B2C3D4E5F6G7H8J9K0',
    });
    expect(link).toEqual({
      setupTokenId: '5C991763VB2781612',
      approveUrl: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=5C991763VB2781612',
    });
    const wallet = await gateway.finishLink(link.setupTokenId, 'link_01JBX7A1B2C3D4E5F6G7H8J9K1');
    expect(wallet).toEqual({ vaultId: VAULT_ID, customerId: 'customer_4029352050', payerEmail: 'sb-buyer47@personal.example.com' });
  });

  it('turns PayPal errors into typed errors with the issue and debug id', async () => {
    const { gateway } = clientWith([fixture('oauth-token'), fixture('error-previously-captured')]);
    const error = await gateway.void('0VF52814937998046', 'req_01JBX7M8R5T2YQ6N3P0VWK4HZE-void').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayPalError);
    expect(error).toMatchObject({ status: 422, paypalName: 'UNPROCESSABLE_ENTITY', issue: 'PREVIOUSLY_CAPTURED', debugId: 'f4b2a9c6d8e01' });
    expect((error as PayPalError).summary).toBe('PayPal: PREVIOUSLY_CAPTURED (debug id f4b2a9c6d8e01)');
  });

  it('reports wrong credentials clearly', async () => {
    const { client } = clientWith([fixture('error-invalid-client')]);
    await expect(client.accessToken()).rejects.toMatchObject({ status: 401, paypalName: 'invalid_client' });
  });

  it('reuses the access token until it is about to expire', async () => {
    let now = 0;
    const { gateway, sent } = clientWith(
      [fixture('oauth-token'), fixture('create-order-capture'), fixture('create-order-capture'), fixture('oauth-token'), fixture('create-order-capture')],
      { now: () => now },
    );
    await gateway.createOrder(orderInput('create-order-capture'));
    now = 60_000;
    await gateway.createOrder(orderInput('create-order-capture'));
    now = 32_400_000;
    await gateway.createOrder(orderInput('create-order-capture'));
    expect(sent.map((request) => request.path)).toEqual([
      '/v1/oauth2/token',
      '/v2/checkout/orders',
      '/v2/checkout/orders',
      '/v1/oauth2/token',
      '/v2/checkout/orders',
    ]);
  });

  it('gets a fresh token and retries once after a 401', async () => {
    const expired: Exchange = {
      name: 'create-order-capture',
      request: fixture('create-order-capture').request,
      response: { status: 401, body: { name: 'AUTHENTICATION_FAILURE', message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.' } },
    };
    const { gateway, remaining } = clientWith([fixture('oauth-token'), expired, fixture('oauth-token'), fixture('create-order-capture')]);
    expect((await gateway.createOrder(orderInput('create-order-capture'))).captureId).toBe('3C679366HH908993F');
    expect(remaining()).toBe(0);
  });

  it('records exchanges without credentials', async () => {
    const recorded: Exchange[] = [];
    const { gateway } = clientWith([fixture('oauth-token'), fixture('create-order-capture')], { onExchange: (e) => recorded.push(e) });
    await gateway.createOrder(orderInput('create-order-capture'));
    const text = JSON.stringify(recorded);
    expect(text).not.toContain('test-secret');
    expect(text).not.toContain(Buffer.from('test-client:test-secret').toString('base64'));
    expect(recorded.map((e) => e.name)).toEqual(['oauth-token', 'create-order-capture']);
    expect(recorded[1]!.request.headers.Authorization).toBe('REDACTED');
  });
});

describe('order body', () => {
  it('itemizes the purchase and pays from the vaulted wallet', () => {
    const body = buildOrderBody({
      requestId: 'req_1',
      intent: 'CAPTURE',
      vaultId: VAULT_ID,
      currency: 'USD',
      amountCents: 4396,
      items: [
        { name: 'Ink', quantity: 1, unitPriceCents: 3897, category: 'office_supplies' },
        { name: 'Shipping', quantity: 1, unitPriceCents: 499, category: 'shipping_tax' },
      ],
      merchant: 'Inkwell Supplies',
    });
    const unit = body.purchase_units[0]!;
    expect(unit.amount).toEqual({ currency_code: 'USD', value: '43.96', breakdown: { item_total: { currency_code: 'USD', value: '43.96' } } });
    expect(unit.items[0]!.category).toBe('PHYSICAL_GOODS');
    expect(unit.items[1]!.category).toBeUndefined();
    expect(unit.invoice_id).toBe('req_1');
    expect(body.payment_source).toEqual({ paypal: { vault_id: VAULT_ID } });
  });

  it("names the merchant's own PayPal account as the payee when the owner configured one", () => {
    const input: OrderInput = {
      requestId: 'req_3',
      intent: 'CAPTURE',
      vaultId: VAULT_ID,
      currency: 'EUR',
      amountCents: 3897,
      items: [{ name: 'Ink', quantity: 1, unitPriceCents: 3897, category: 'office_supplies' }],
      merchant: 'Inkwell Supplies',
    };
    expect(buildOrderBody(input).purchase_units[0]!.payee).toBeUndefined();
    expect(buildOrderBody({ ...input, payeeEmail: 'shop@business.example.com' }).purchase_units[0]!.payee).toEqual({
      email_address: 'shop@business.example.com',
    });
    expect(parsePayees(' Inkwell Supplies = shop@business.example.com ; Other=o@x.io ')).toEqual({
      'inkwell supplies': 'shop@business.example.com',
      other: 'o@x.io',
    });
    expect(() => parsePayees('Inkwell Supplies')).toThrow(/PAYPAL_PAYEES/);
  });

  it('explains why PayPal refuses to pay another merchant from the wallet this app linked', async () => {
    const refused: Exchange = {
      name: 'create-order-capture',
      request: fixture('create-order-capture').request,
      response: {
        status: 422,
        body: {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'BILLING_AGREEMENT_NOT_FOUND', description: 'The requested Billing Agreement token was not found.' }],
          message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
          debug_id: 'ca55d0e20d9c1',
        },
      },
    };
    const script = scriptedFetch([fixture('oauth-token'), refused]);
    const client = new PayPalClient({ clientId: 'test-client', clientSecret: 'test-secret', fetch: script.fetch });
    const gateway = new SandboxGateway(client, { 'inkwell supplies': 'shop@business.example.com' });
    const error = await gateway.createOrder(orderInput('create-order-capture')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: 'PAYEE_NOT_ONBOARDED' });
    expect((error as Error).message).toContain("onboarded through PayPal's multiparty integration");
  });

  it('keeps PayPal field limits', () => {
    const body = buildOrderBody({
      requestId: 'req_2',
      intent: 'AUTHORIZE',
      vaultId: VAULT_ID,
      currency: 'USD',
      amountCents: 100,
      items: [{ name: 'x'.repeat(300), quantity: 1, unitPriceCents: 100, category: 'software' }],
      merchant: 'm'.repeat(300),
    });
    const unit = body.purchase_units[0]!;
    expect(unit.items[0]!.name).toHaveLength(127);
    expect(unit.description).toHaveLength(127);
    expect(unit.items[0]!.category).toBe('DIGITAL_GOODS');
  });
});
