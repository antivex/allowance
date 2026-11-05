import { randomBytes } from 'node:crypto';
import { centsToValue } from '../policy/money.js';
import type { Category, NormalizedItem } from '../policy/types.js';
import { PayPalClient, PayPalError } from './client.js';
import type { CreateOrderBody, OrderItem } from './types.js';

export interface LinkedWallet {
  vaultId: string;
  customerId: string | null;
  payerEmail: string | null;
}

export interface OrderInput {
  requestId: string;
  intent: 'CAPTURE' | 'AUTHORIZE';
  vaultId: string;
  currency: string;
  amountCents: number;
  items: NormalizedItem[];
  merchant: string;
  /** The merchant's own PayPal account, when the owner configured one (PAYPAL_PAYEES). */
  payeeEmail?: string;
}

export interface OrderOutcome {
  orderId: string;
  orderStatus: string;
  captureId: string | null;
  captureStatus: string | null;
  authorizationId: string | null;
  authorizationStatus: string | null;
  authorizationExpiresAt: string | null;
}

/** What the wallet needs from PayPal. Two implementations: the real sandbox and an offline simulation. */
export interface PaymentGateway {
  readonly mode: 'sandbox' | 'simulated';
  startLink(params: { returnUrl: string; cancelUrl: string; requestId: string }): Promise<{ setupTokenId: string; approveUrl: string }>;
  finishLink(setupTokenId: string, requestId: string): Promise<LinkedWallet>;
  unlink(vaultId: string): Promise<void>;
  createOrder(input: OrderInput): Promise<OrderOutcome>;
  capture(authorizationId: string, requestId: string): Promise<{ captureId: string; status: string }>;
  void(authorizationId: string, requestId: string): Promise<{ status: string }>;
}

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

const DIGITAL: ReadonlySet<Category> = new Set(['software', 'gift_cards', 'crypto']);
const NO_GOODS: ReadonlySet<Category> = new Set(['services', 'travel', 'food_delivery', 'shipping_tax', 'money_transfer']);

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Builds the Orders v2 body for a purchase paid from the linked (vaulted) PayPal wallet. */
export function buildOrderBody(input: OrderInput): CreateOrderBody {
  const money = (cents: number) => ({ currency_code: input.currency, value: centsToValue(cents) });
  const items: OrderItem[] = input.items.map((item) => ({
    name: truncate(item.name, 127),
    quantity: String(item.quantity),
    unit_amount: money(item.unitPriceCents),
    ...(NO_GOODS.has(item.category) ? {} : { category: DIGITAL.has(item.category) ? 'DIGITAL_GOODS' : 'PHYSICAL_GOODS' }),
  }));
  return {
    intent: input.intent,
    purchase_units: [
      {
        reference_id: input.requestId,
        custom_id: input.requestId,
        invoice_id: input.requestId,
        description: truncate(`Allowance agent purchase at ${input.merchant}`, 127),
        amount: { ...money(input.amountCents), breakdown: { item_total: money(input.amountCents) } },
        items,
        ...(input.payeeEmail ? { payee: { email_address: input.payeeEmail } } : {}),
      },
    ],
    payment_source: { paypal: { vault_id: input.vaultId } },
  };
}

/** The real PayPal sandbox, through the REST client. */
export class SandboxGateway implements PaymentGateway {
  readonly mode = 'sandbox' as const;

  /** @param payees merchant name (lowercase) → that merchant's PayPal account, from PAYPAL_PAYEES. */
  constructor(
    private readonly client: PayPalClient,
    private readonly payees: Record<string, string> = {},
    private readonly brandName = 'Allowance',
  ) {}

  async startLink(params: { returnUrl: string; cancelUrl: string; requestId: string }) {
    const token = await this.client.createSetupToken({ ...params, brandName: this.brandName });
    const approveUrl = token.links?.find((link) => link.rel === 'approve')?.href;
    if (!approveUrl) throw new GatewayError('NO_APPROVE_LINK', 'PayPal did not return an approval link for the wallet.');
    return { setupTokenId: token.id, approveUrl };
  }

  async finishLink(setupTokenId: string, requestId: string): Promise<LinkedWallet> {
    const token = await this.client.createPaymentToken(setupTokenId, requestId);
    return {
      vaultId: token.id,
      customerId: token.customer?.id ?? null,
      payerEmail: token.payment_source?.paypal?.email_address ?? null,
    };
  }

  async unlink(vaultId: string): Promise<void> {
    try {
      await this.client.deletePaymentToken(vaultId);
    } catch (error) {
      if (!(error instanceof PayPalError && error.status === 404)) throw error;
    }
  }

  async createOrder(input: OrderInput): Promise<OrderOutcome> {
    const payeeEmail = input.payeeEmail ?? this.payees[input.merchant.trim().toLowerCase()];
    const order = await this.client.createOrder(buildOrderBody({ ...input, payeeEmail }), input.requestId).catch((error: unknown) => {
      // Tried on the sandbox on 5 Nov 2026: a wallet vaulted by this app pays this app's own business account, and
      // PayPal answers BILLING_AGREEMENT_NOT_FOUND when the order names another merchant as the payee.
      if (payeeEmail && error instanceof PayPalError && error.issue === 'BILLING_AGREEMENT_NOT_FOUND') {
        throw new GatewayError(
          'PAYEE_NOT_ONBOARDED',
          `PayPal will not pay ${payeeEmail} from the wallet linked to this app (${error.summary}). The merchant must first be onboarded through PayPal's multiparty integration`,
        );
      }
      throw error;
    });
    if (order.status === 'PAYER_ACTION_REQUIRED') {
      throw new GatewayError('PAYER_ACTION_REQUIRED', 'PayPal wants the payer to approve again: link PayPal once more in Allowance.');
    }
    const payments = order.purchase_units?.[0]?.payments;
    const capture = payments?.captures?.[0];
    const authorization = payments?.authorizations?.[0];
    return {
      orderId: order.id,
      orderStatus: order.status,
      captureId: capture?.id ?? null,
      captureStatus: capture?.status ?? null,
      authorizationId: authorization?.id ?? null,
      authorizationStatus: authorization?.status ?? null,
      authorizationExpiresAt: authorization?.expiration_time ?? null,
    };
  }

  async capture(authorizationId: string, requestId: string) {
    const capture = await this.client.captureAuthorization(authorizationId, requestId);
    return { captureId: capture.id, status: capture.status };
  }

  async void(authorizationId: string, requestId: string) {
    const result = await this.client.voidAuthorization(authorizationId, requestId);
    return { status: result?.status ?? 'VOIDED' };
  }
}

function simulatedId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(14);
  return `SIM${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

/**
 * An offline stand-in with the same shapes as the sandbox, used when no PayPal credentials are set.
 * The dashboard labels it clearly; nothing here talks to PayPal.
 */
export class SimulatedGateway implements PaymentGateway {
  readonly mode = 'simulated' as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async startLink(params: { returnUrl: string }) {
    const setupTokenId = simulatedId();
    const url = new URL(params.returnUrl);
    url.searchParams.set('approval_token_id', setupTokenId);
    return { setupTokenId, approveUrl: url.toString() };
  }

  async finishLink(): Promise<LinkedWallet> {
    return { vaultId: simulatedId(), customerId: simulatedId(), payerEmail: 'simulated-buyer@example.com' };
  }

  async unlink(): Promise<void> {}

  async createOrder(input: OrderInput): Promise<OrderOutcome> {
    const authorize = input.intent === 'AUTHORIZE';
    const expires = new Date(this.now().getTime() + 29 * 24 * 3600 * 1000).toISOString();
    return {
      orderId: simulatedId(),
      orderStatus: 'COMPLETED',
      captureId: authorize ? null : simulatedId(),
      captureStatus: authorize ? null : 'COMPLETED',
      authorizationId: authorize ? simulatedId() : null,
      authorizationStatus: authorize ? 'CREATED' : null,
      authorizationExpiresAt: authorize ? expires : null,
    };
  }

  async capture() {
    return { captureId: simulatedId(), status: 'COMPLETED' };
  }

  async void() {
    return { status: 'VOIDED' };
  }
}
