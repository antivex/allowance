/**
 * Spending mandates, in the spirit of the Agent Payments Protocol (AP2): signed statements an agent can show and anyone can
 * check with Allowance's public key.
 *
 * - The intent mandate says what an agent may spend without asking: the owner's confirmed rules, for a limited time.
 * - The cart mandate says that this exact cart (merchant, items, amount) was paid by the owner's wallet, who approved it
 *   (the rules or the owner), and which PayPal order carried it. Its id is the purchase id, which is also the PayPal
 *   order's invoice_id and custom_id, so PayPal's record and the signed cart point at each other.
 *
 * Both are compact JWS (RFC 7515) signed with Ed25519 (alg EdDSA, RFC 8037). The public key is served as a JWK set at
 * /.well-known/jwks.json. The signing key is created on first run and stays in Allowance's database.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Agent, Purchase, RulesRecord } from './store.js';
import { centsToValue } from './policy/money.js';

const SETTING = 'mandate.signing_key';
/** An intent mandate is short-lived: an agent asks for a fresh one, and a revoked agent stops getting them. */
const INTENT_HOURS = 24;

interface KeyStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  alg: 'EdDSA';
  use: 'sig';
}

export interface IntentMandate {
  type: 'intent_mandate';
  iss: string;
  sub: string;
  agent: string;
  jti: string;
  iat: number;
  exp: number;
  currency: string;
  /** What the agent may buy without the owner, as the owner confirmed it. Anything else waits for the owner or is refused. */
  spend_without_asking: {
    per_purchase_max: string;
    category_limits: Record<string, string>;
    weekly_budget: string | null;
    allowed_categories: string[] | 'any not refused';
    allowed_merchants: string[] | 'any not refused';
  };
  refused: { categories: string[]; merchants: string[]; above: string | null };
  rules_text: string;
  rules_confirmed_at: string;
}

export interface CartMandate {
  type: 'cart_mandate';
  iss: string;
  sub: string;
  agent: string;
  /** The purchase id: also the PayPal order's invoice_id and custom_id. */
  jti: string;
  iat: number;
  merchant: string;
  items: Array<{ name: string; quantity: number; unit_price: string }>;
  amount: string;
  currency: string;
  /** Who let the money go: the rules alone, or the owner after a hold. */
  approved_by: 'rules' | 'owner';
  paypal: { mode: string; order_id: string | null; capture_id: string | null };
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export class MandateError extends Error {}

export class Mandates {
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly kid: string;

  constructor(
    store: KeyStore,
    /** Who issues the mandates: Allowance's public address. */
    private readonly issuer: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    let pem = store.getSetting(SETTING);
    if (!pem) {
      pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
      store.setSetting(SETTING, pem);
    }
    this.privateKey = createPrivateKey(pem);
    this.publicKey = createPublicKey(this.privateKey);
    this.kid = createHash('sha256').update(this.rawPublicKey()).digest('base64url').slice(0, 16);
  }

  private rawPublicKey(): Buffer {
    return Buffer.from((this.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  }

  jwks(): { keys: PublicJwk[] } {
    return { keys: [{ kty: 'OKP', crv: 'Ed25519', x: this.rawPublicKey().toString('base64url'), kid: this.kid, alg: 'EdDSA', use: 'sig' }] };
  }

  private sign(payload: object): string {
    const input = `${b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.kid }))}.${b64url(JSON.stringify(payload))}`;
    return `${input}.${sign(null, Buffer.from(input), this.privateKey).toString('base64url')}`;
  }

  /** What an agent may spend without asking, signed, valid for a day. */
  intent(agent: Agent, record: RulesRecord): { mandate: string; payload: IntentMandate } {
    const { rules } = record;
    const money = (value: number) => value.toFixed(2);
    const iat = Math.floor(this.now().getTime() / 1000);
    const payload: IntentMandate = {
      type: 'intent_mandate',
      iss: this.issuer,
      sub: agent.id,
      agent: agent.name,
      jti: `intent_${agent.id}_${record.id}_${iat}`,
      iat,
      exp: iat + INTENT_HOURS * 3600,
      currency: rules.currency,
      spend_without_asking: {
        per_purchase_max: money(rules.autoApproveMax),
        category_limits: Object.fromEntries(Object.entries(rules.categoryLimits).map(([category, limit]) => [category, money(limit as number)])),
        weekly_budget: rules.weeklyBudget === null ? null : money(rules.weeklyBudget),
        allowed_categories: rules.allowedCategories.length ? rules.allowedCategories : 'any not refused',
        allowed_merchants: rules.allowedMerchants.length ? rules.allowedMerchants : 'any not refused',
      },
      refused: { categories: rules.blockedCategories, merchants: rules.blockedMerchants, above: rules.hardMax === null ? null : money(rules.hardMax) },
      rules_text: record.sourceText,
      rules_confirmed_at: record.confirmedAt,
    };
    return { mandate: this.sign(payload), payload };
  }

  /** The signed cart of a paid purchase; null while the money has not moved. */
  cart(purchase: Purchase): string | null {
    if (purchase.status !== 'paid') return null;
    const payload: CartMandate = {
      type: 'cart_mandate',
      iss: this.issuer,
      sub: purchase.agentId,
      agent: purchase.agentName,
      jti: purchase.id,
      iat: Math.floor(new Date(purchase.settledAt ?? purchase.updatedAt).getTime() / 1000),
      merchant: purchase.merchant,
      items: purchase.items.map((item) => ({ name: item.name, quantity: item.quantity, unit_price: centsToValue(item.unitPriceCents) })),
      amount: centsToValue(purchase.amountCents),
      currency: purchase.currency,
      approved_by: purchase.decision === 'approve' ? 'rules' : 'owner',
      paypal: { mode: purchase.paypalMode, order_id: purchase.paypalOrderId, capture_id: purchase.paypalCaptureId },
    };
    return this.sign(payload);
  }
}

/**
 * Checks a mandate against a JWK set (Allowance's /.well-known/jwks.json) and returns what it says. Throws when the
 * signature does not match, the key is unknown, or an intent mandate has expired. Any JOSE library does the same.
 */
export function verifyMandate<T = IntentMandate | CartMandate>(jws: string, jwks: { keys: PublicJwk[] }, now = new Date()): T {
  const parts = jws.trim().split('.');
  if (parts.length !== 3) throw new MandateError('Not a compact JWS.');
  const [header, body, signature] = parts as [string, string, string];
  let parsedHeader: { alg?: string; kid?: string };
  let payload: { exp?: number } & Record<string, unknown>;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new MandateError('The mandate is not readable JSON.');
  }
  if (parsedHeader.alg !== 'EdDSA') throw new MandateError(`Unexpected algorithm ${String(parsedHeader.alg)}.`);
  const jwk = jwks.keys.find((key) => key.kid === parsedHeader.kid);
  if (!jwk) throw new MandateError('Signed with a key this issuer does not publish.');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  if (!verify(null, Buffer.from(`${header}.${body}`), key, Buffer.from(signature, 'base64url'))) {
    throw new MandateError('The signature does not match: the mandate was changed or not issued by this Allowance.');
  }
  if (typeof payload.exp === 'number' && payload.exp * 1000 < now.getTime()) throw new MandateError('The mandate has expired.');
  return payload as T;
}
