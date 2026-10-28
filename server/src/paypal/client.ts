import type {
  Authorization,
  Capture,
  CreateOrderBody,
  Order,
  PayPalErrorBody,
  PaymentToken,
  SetupToken,
} from './types.js';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** One request/response pair, with credentials removed. Used to record test fixtures. */
export interface Exchange {
  name: string;
  request: { method: string; path: string; headers: Record<string, string>; body?: unknown };
  response: { status: number; body?: unknown };
}

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  onExchange?: (exchange: Exchange) => void;
}

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly paypalName: string,
    readonly issue: string | null,
    readonly debugId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'PayPalError';
  }

  /** A short, owner-readable line, e.g. "PayPal: INSTRUMENT_DECLINED (debug id 8f1...)". */
  get summary(): string {
    const what = this.issue ?? this.paypalName;
    return `PayPal: ${what}${this.debugId ? ` (debug id ${this.debugId})` : ''}`;
  }
}

interface CallOptions {
  body?: unknown;
  requestId?: string;
  name: string;
}

/** A small PayPal REST client over fetch. Sandbox by default; no SDK, no global state. */
export class PayPalClient {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly options: PayPalClientOptions) {
    this.baseUrl = (options.baseUrl ?? SANDBOX_BASE_URL).replace(/\/$/, '');
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  /** OAuth 2.0 client credentials. The token is cached until a minute before it expires. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const response = await this.fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await readJson(response)) as { access_token?: string; expires_in?: number } & PayPalErrorBody;
    this.record('oauth-token', 'POST', '/v1/oauth2/token', {}, 'grant_type=client_credentials', response.status, {
      ...body,
      access_token: body.access_token ? 'REDACTED' : undefined,
    });
    if (!response.ok || !body.access_token) throw toError(response.status, body);
    this.token = { value: body.access_token, expiresAt: this.now() + Math.max(0, (body.expires_in ?? 0) - 60) * 1000 };
    return body.access_token;
  }

  createSetupToken(params: { returnUrl: string; cancelUrl: string; brandName: string; requestId: string }): Promise<SetupToken> {
    return this.call<SetupToken>('POST', '/v3/vault/setup-tokens', {
      name: 'vault-setup-token',
      requestId: params.requestId,
      body: {
        payment_source: {
          paypal: {
            description: `${params.brandName}: lets your AI agent pay within the rules you set`,
            permit_multiple_payment_tokens: false,
            usage_pattern: 'IMMEDIATE',
            usage_type: 'MERCHANT',
            customer_type: 'CONSUMER',
            experience_context: {
              brand_name: params.brandName,
              locale: 'en-US',
              shipping_preference: 'NO_SHIPPING',
              return_url: params.returnUrl,
              cancel_url: params.cancelUrl,
            },
          },
        },
      },
    });
  }

  createPaymentToken(setupTokenId: string, requestId: string): Promise<PaymentToken> {
    return this.call<PaymentToken>('POST', '/v3/vault/payment-tokens', {
      name: 'vault-payment-token',
      requestId,
      body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
    });
  }

  async deletePaymentToken(paymentTokenId: string): Promise<void> {
    await this.call<void>('DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(paymentTokenId)}`, {
      name: 'vault-delete-payment-token',
    });
  }

  createOrder(body: CreateOrderBody, requestId: string): Promise<Order> {
    return this.call<Order>('POST', '/v2/checkout/orders', {
      name: `create-order-${body.intent.toLowerCase()}`,
      requestId,
      body,
    });
  }

  getOrder(orderId: string): Promise<Order> {
    return this.call<Order>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { name: 'get-order' });
  }

  captureAuthorization(authorizationId: string, requestId: string): Promise<Capture> {
    return this.call<Capture>('POST', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, {
      name: 'capture-authorization',
      requestId,
      body: { final_capture: true },
    });
  }

  async voidAuthorization(authorizationId: string, requestId: string): Promise<Authorization | undefined> {
    return this.call<Authorization | undefined>(
      'POST',
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
      { name: 'void-authorization', requestId },
    );
  }

  getAuthorization(authorizationId: string): Promise<Authorization> {
    return this.call<Authorization>('GET', `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`, {
      name: 'get-authorization',
    });
  }

  private async call<T>(method: string, path: string, options: CallOptions, retried = false): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      Accept: 'application/json',
      Prefer: 'return=representation',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.requestId) headers['PayPal-Request-Id'] = options.requestId;

    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = await readJson(response);
    this.record(options.name, method, path, headers, options.body, response.status, body);

    if (response.status === 401 && !retried) {
      this.token = null;
      return this.call<T>(method, path, options, true);
    }
    if (!response.ok) throw toError(response.status, (body ?? {}) as PayPalErrorBody);
    return body as T;
  }

  private record(
    name: string,
    method: string,
    path: string,
    headers: Record<string, string>,
    requestBody: unknown,
    status: number,
    responseBody: unknown,
  ): void {
    if (!this.options.onExchange) return;
    const safeHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, key.toLowerCase() === 'authorization' ? 'REDACTED' : value]),
    );
    this.options.onExchange({
      name,
      request: { method, path, headers: safeHeaders, ...(requestBody === undefined ? {} : { body: requestBody }) },
      response: { status, ...(responseBody === undefined ? {} : { body: responseBody }) },
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function toError(status: number, body: PayPalErrorBody): PayPalError {
  const detail = body.details?.[0];
  const name = body.name ?? body.error ?? `HTTP_${status}`;
  const message = detail?.description ?? body.message ?? body.error_description ?? `PayPal returned HTTP ${status}`;
  return new PayPalError(status, name, detail?.issue ?? null, body.debug_id ?? null, message);
}
