import { createHash } from 'node:crypto';
import type { EventBus } from './events.js';
import { newId } from './ids.js';
import { PayPalError } from './paypal/client.js';
import { GatewayError, type LinkedWallet, type PaymentGateway } from './paypal/gateway.js';
import { combine, type AiFailureMode, type AiOutcome, type DecisionSource, type FinalDecision } from './policy/combine.js';
import { evaluate, normalizeRequest, type PolicyContext } from './policy/engine.js';
import { centsToValue, formatMoney, toCents } from './policy/money.js';
import {
  PurchaseRequestSchema,
  type Decision,
  type NormalizedRequest,
  type PolicyResult,
  type Rules,
} from './policy/types.js';
import type { Mandates } from './mandate.js';
import type { Agent, Purchase, PurchaseStatus, Store } from './store.js';

export interface ReviewInput {
  ownerText: string | null;
  rules: Rules | null;
  request: NormalizedRequest;
  agentName: string;
  policy: PolicyResult;
}

/** The AI half of a decision. Implementations must never throw: failures come back as `status: 'failed'`. */
export interface Reviewer {
  readonly model: string;
  review(input: ReviewInput): Promise<AiOutcome>;
}

export class InvalidRequestError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}

export interface WalletOptions {
  store: Store;
  gateway: PaymentGateway;
  reviewer: Reviewer | null;
  bus: EventBus;
  currency: string;
  holdMinutes: number;
  aiOnFailure: AiFailureMode;
  /** Identifies the PayPal app, so a wallet linked under other credentials is not reused. */
  gatewayKey: string;
  /** Signs spending mandates (AP2-style); without it, outcomes carry no signed cart. */
  mandates?: Mandates | null;
  now?: () => Date;
}

/** What an agent may spend without asking, signed, with a sentence for people. */
export interface MandateView {
  mandate: string;
  summary: string;
  expires_at: string;
  jwks_url: string;
}

export interface BudgetSummary {
  currency: string;
  weekStart: string;
  weekEnd: string;
  weeklyBudgetCents: number | null;
  paidCents: number;
  heldCents: number;
  leftCents: number | null;
  waitingCount: number;
  blockedThisWeek: number;
}

export interface WalletLink {
  mode: PaymentGateway['mode'];
  linked: boolean;
  payerEmail: string | null;
  linkedAt: string | null;
}

/** What the agent gets back from `request_purchase`. Snake case, like the tool's input. */
export interface PurchaseOutcome {
  request_id: string;
  status: PurchaseStatus;
  decision: Decision;
  decided_by: DecisionSource;
  explanation: string;
  merchant: string;
  amount: string;
  currency: string;
  paypal: {
    mode: PaymentGateway['mode'];
    order_id: string | null;
    capture_id: string | null;
    authorization_id: string | null;
    status: string | null;
  } | null;
  hold_expires_at: string | null;
  budget_left_this_week: string | null;
  message: string;
  /** For paid purchases: the cart signed by the owner's Allowance (compact JWS), checkable at /.well-known/jwks.json. */
  cart_mandate: string | null;
}

/** Monday 00:00 in the server's local time zone. */
export function weekStart(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function describeError(error: unknown): string {
  const text =
    error instanceof PayPalError ? `${error.summary}: ${error.message}` : error instanceof Error ? error.message : String(error);
  // The outcome adds its own full stop.
  return text.replace(/\.+$/, '');
}

const SETTING = {
  vaultId: 'wallet.vault_id',
  customerId: 'wallet.customer_id',
  payerEmail: 'wallet.payer_email',
  linkedAt: 'wallet.linked_at',
  key: 'wallet.gateway_key',
  pendingSetup: 'wallet.pending_setup_token',
} as const;

/**
 * The policy wallet: every agent purchase goes through here.
 * Rules first, then the AI review (stricter only), then PayPal: capture, hold, or nothing.
 */
export class Wallet {
  private readonly now: () => Date;

  constructor(private readonly options: WalletOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get mode(): PaymentGateway['mode'] {
    return this.options.gateway.mode;
  }

  get reviewerModel(): string | null {
    return this.options.reviewer?.model ?? null;
  }

  // Purchases

  async requestPurchase(agent: Pick<Agent, 'id' | 'name'>, input: unknown): Promise<PurchaseOutcome> {
    const { store, currency } = this.options;
    const request = this.parse(input);

    const id = newId('req', this.now().getTime());
    const rulesRecord = store.activeRules();
    const context = (): PolicyContext => ({
      rules: rulesRecord?.rules ?? null,
      weekSpentCents: this.weekCommittedCents(),
      defaultCurrency: currency,
    });

    const first = evaluate(request, context());
    const ai = await this.review(first, request, agent.name, rulesRecord?.sourceText ?? null, rulesRecord?.rules ?? null);
    // Other purchases may have landed while the model was thinking: re-check with fresh totals.
    // From here to the insert everything is synchronous, so the budget cannot be double-spent.
    const policy = evaluate(request, context());
    const final = combine(policy, ai, this.options.aiOnFailure);
    const wallet = this.linkedWallet();

    const createdAt = this.now().toISOString();
    const willPay = final.decision !== 'block' && wallet !== null;
    const purchase: Purchase = {
      id,
      createdAt,
      updatedAt: createdAt,
      agentId: agent.id,
      agentName: agent.name,
      merchant: request.merchant,
      merchantUrl: request.merchantUrl,
      sourceUrl: request.sourceUrl,
      items: request.items,
      amountCents: request.amountCents,
      currency: request.currency,
      reason: request.reason,
      rulesId: rulesRecord?.id ?? null,
      policyDecision: policy.decision,
      decision: final.decision,
      decisionSource: final.source,
      explanation: final.explanation,
      checks: policy.checks,
      ai,
      status: final.decision === 'block' ? 'blocked' : willPay ? 'processing' : 'failed',
      paypalMode: this.mode,
      paypalOrderId: null,
      paypalOrderStatus: null,
      paypalCaptureId: null,
      paypalAuthorizationId: null,
      paypalStatus: null,
      holdExpiresAt: null,
      settledAt: null,
      settledBy: null,
      error: final.decision !== 'block' && !wallet ? 'No PayPal wallet is linked yet: link one in the dashboard.' : null,
    };
    store.insertPurchase(purchase);
    this.event(id, 'requested', `${agent.name} asked to pay ${this.money(request.amountCents)} to ${request.merchant}.`, {
      reason: request.reason,
      source_url: request.sourceUrl,
    });
    this.event(id, 'rules', `Rules: ${policy.decision}. ${policy.explanation}`, { checks: policy.checks });
    this.event(id, 'ai', aiSummary(ai), ai);
    this.event(id, 'decision', `Decision: ${final.decision} (by ${final.source}). ${final.explanation}`);
    this.publish(id);

    if (willPay && wallet) await this.pay(purchase, final.decision === 'approve' ? 'CAPTURE' : 'AUTHORIZE', wallet);
    return this.outcome(id);
  }

  /** Runs the checks on a purchase without paying or storing anything: the "try a purchase" box. */
  async preview(input: unknown, override?: { rules: Rules; sourceText: string }): Promise<{
    policy: PolicyResult;
    ai: AiOutcome;
    final: FinalDecision;
  }> {
    const request = this.parse(input);
    const active = this.options.store.activeRules();
    const rules = override?.rules ?? active?.rules ?? null;
    const sourceText = override?.sourceText ?? active?.sourceText ?? null;
    const policy = evaluate(request, { rules, weekSpentCents: this.weekCommittedCents(), defaultCurrency: this.options.currency });
    const ai = await this.review(policy, request, 'Preview', sourceText, rules);
    return { policy, ai, final: combine(policy, ai, this.options.aiOnFailure) };
  }

  private parse(input: unknown): NormalizedRequest {
    const parsed = PurchaseRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidRequestError(
        'The purchase request is not valid.',
        parsed.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`),
      );
    }
    try {
      return normalizeRequest(parsed.data, this.options.currency);
    } catch (error) {
      throw new InvalidRequestError(describeError(error));
    }
  }

  private async review(
    policy: PolicyResult,
    request: NormalizedRequest,
    agentName: string,
    ownerText: string | null,
    rules: Rules | null,
  ): Promise<AiOutcome> {
    if (policy.decision === 'block') return { status: 'skipped', reason: 'The rules already blocked it.' };
    const reviewer = this.options.reviewer;
    if (!reviewer) return { status: 'skipped', reason: 'AI review is turned off.' };
    return reviewer.review({ ownerText, rules, request, agentName, policy });
  }

  private async pay(purchase: Purchase, intent: 'CAPTURE' | 'AUTHORIZE', wallet: LinkedWallet): Promise<void> {
    const { store, gateway } = this.options;
    const id = purchase.id;
    try {
      const result = await gateway.createOrder({
        requestId: id,
        intent,
        vaultId: wallet.vaultId,
        currency: purchase.currency,
        amountCents: purchase.amountCents,
        items: purchase.items,
        merchant: purchase.merchant,
      });
      const patch = {
        updatedAt: this.now().toISOString(),
        paypalOrderId: result.orderId,
        paypalOrderStatus: result.orderStatus,
        paypalCaptureId: result.captureId,
        paypalAuthorizationId: result.authorizationId,
      };
      if (intent === 'CAPTURE') {
        const ok = result.captureStatus === 'COMPLETED' || result.captureStatus === 'PENDING';
        store.updatePurchase(id, {
          ...patch,
          status: ok ? 'paid' : 'failed',
          paypalStatus: result.captureStatus,
          settledAt: ok ? patch.updatedAt : null,
          settledBy: ok ? 'rules' : null,
          error: ok ? null : `PayPal did not capture the payment (status ${result.captureStatus ?? 'missing'}).`,
        });
        this.event(id, 'paypal', `PayPal order ${result.orderId} ${result.orderStatus}; capture ${result.captureId ?? '-'} ${result.captureStatus ?? ''}.`, result);
      } else {
        const ok = result.authorizationStatus === 'CREATED' || result.authorizationStatus === 'PENDING';
        const holdExpiresAt = new Date(this.now().getTime() + this.options.holdMinutes * 60_000).toISOString();
        store.updatePurchase(id, {
          ...patch,
          status: ok ? 'on_hold' : 'failed',
          paypalStatus: result.authorizationStatus,
          holdExpiresAt: ok ? holdExpiresAt : null,
          error: ok ? null : `PayPal did not authorize the payment (status ${result.authorizationStatus ?? 'missing'}).`,
        });
        this.event(
          id,
          'paypal',
          `PayPal order ${result.orderId} ${result.orderStatus}; ${this.money(purchase.amountCents)} on hold (authorization ${result.authorizationId ?? '-'} ${result.authorizationStatus ?? ''}).`,
          result,
        );
      }
    } catch (error) {
      store.updatePurchase(id, { status: 'failed', updatedAt: this.now().toISOString(), error: describeError(error) });
      this.event(id, 'error', `PayPal call failed: ${describeError(error)}`);
    }
    this.publish(id);
  }

  /** The owner approves a held purchase: PayPal captures the authorization. */
  async approve(id: string, by = 'owner'): Promise<Purchase> {
    const purchase = this.claimHold(id);
    const { gateway, store } = this.options;
    try {
      const capture = await gateway.capture(purchase.paypalAuthorizationId ?? '', `${id}-capture`);
      const ok = capture.status === 'COMPLETED' || capture.status === 'PENDING';
      const now = this.now().toISOString();
      store.updatePurchase(id, {
        status: ok ? 'paid' : 'failed',
        updatedAt: now,
        paypalCaptureId: capture.captureId,
        paypalStatus: capture.status,
        settledAt: now,
        settledBy: by,
        error: ok ? null : `PayPal did not capture the payment (status ${capture.status}).`,
      });
      this.event(id, 'owner', `Approved by ${by}.`);
      this.event(id, 'paypal', `PayPal captured the hold: capture ${capture.captureId} ${capture.status}.`, capture);
    } catch (error) {
      this.release(id, error);
      throw new ConflictError(`PayPal could not capture: ${describeError(error)}`);
    }
    this.publish(id);
    return this.get(id);
  }

  /** The owner denies a held purchase: PayPal voids the authorization. */
  async deny(id: string, by = 'owner'): Promise<Purchase> {
    return this.voidHold(id, 'denied', by);
  }

  /** Voids every hold nobody decided on in time. Returns how many were voided. */
  async expireDueHolds(): Promise<number> {
    let count = 0;
    for (const purchase of this.options.store.dueHolds(this.now().toISOString())) {
      try {
        await this.voidHold(purchase.id, 'expired', 'timeout');
        count++;
      } catch {
        // Already settled by the owner in the meantime, or PayPal is down: the next sweep retries.
      }
    }
    return count;
  }

  private async voidHold(id: string, status: 'denied' | 'expired', by: string): Promise<Purchase> {
    const purchase = this.claimHold(id);
    try {
      const result = await this.options.gateway.void(purchase.paypalAuthorizationId ?? '', `${id}-void`);
      const now = this.now().toISOString();
      this.options.store.updatePurchase(id, { status, updatedAt: now, paypalStatus: result.status, settledAt: now, settledBy: by });
      this.event(id, by === 'timeout' ? 'timeout' : 'owner', by === 'timeout' ? 'Nobody decided in time.' : `Denied by ${by}.`);
      this.event(id, 'paypal', `PayPal voided the hold (${result.status}); nothing was charged.`, result);
    } catch (error) {
      this.release(id, error);
      throw new ConflictError(`PayPal could not void: ${describeError(error)}`);
    }
    this.publish(id);
    return this.get(id);
  }

  /** Moves a held purchase to `settling`, or explains why it cannot be decided. */
  private claimHold(id: string): Purchase {
    const purchase = this.get(id);
    const claimed = this.options.store.transition(id, ['on_hold'], { status: 'settling', updatedAt: this.now().toISOString() });
    if (!claimed) throw new ConflictError(`This purchase is ${purchase.status.replace('_', ' ')}, not waiting for a decision.`);
    return purchase;
  }

  private release(id: string, error: unknown): void {
    this.options.store.updatePurchase(id, { status: 'on_hold', updatedAt: this.now().toISOString(), error: describeError(error) });
    this.event(id, 'error', `PayPal call failed, still on hold: ${describeError(error)}`);
    this.publish(id);
  }

  get(id: string): Purchase {
    const purchase = this.options.store.getPurchase(id);
    if (!purchase) throw new NotFoundError(`No purchase with id ${id}.`);
    return purchase;
  }

  /** The agent-facing view of a purchase. Agents only see their own. */
  outcomeFor(agentId: string, id: string): PurchaseOutcome {
    const purchase = this.options.store.getPurchase(id);
    if (!purchase || purchase.agentId !== agentId) throw new NotFoundError(`No purchase with id ${id}.`);
    return this.outcome(id);
  }

  private outcome(id: string): PurchaseOutcome {
    const purchase = this.get(id);
    const budget = this.budget();
    return {
      request_id: purchase.id,
      status: purchase.status,
      decision: purchase.decision,
      decided_by: purchase.decisionSource,
      explanation: purchase.explanation,
      merchant: purchase.merchant,
      amount: centsToValue(purchase.amountCents),
      currency: purchase.currency,
      paypal: purchase.paypalOrderId
        ? {
            mode: purchase.paypalMode,
            order_id: purchase.paypalOrderId,
            capture_id: purchase.paypalCaptureId,
            authorization_id: purchase.paypalAuthorizationId,
            status: purchase.paypalStatus,
          }
        : null,
      hold_expires_at: purchase.holdExpiresAt,
      budget_left_this_week: budget.leftCents === null ? null : centsToValue(Math.max(0, budget.leftCents)),
      message: agentMessage(purchase),
      cart_mandate: this.options.mandates?.cart(purchase) ?? null,
    };
  }

  /** The signed cart of a paid purchase, for the owner's dashboard. */
  cartMandate(purchase: Purchase): string | null {
    return this.options.mandates?.cart(purchase) ?? null;
  }

  /** The public keys that check this Allowance's mandates. */
  jwks() {
    return this.options.mandates?.jwks() ?? { keys: [] };
  }

  /** The agent's intent mandate: what it may spend without asking, as the owner confirmed it. */
  mandateFor(agent: Agent, publicUrl: string): MandateView {
    const { mandates, store, currency } = this.options;
    if (!mandates) throw new NotFoundError('This Allowance does not sign mandates.');
    const record = store.activeRules();
    if (!record) throw new NotFoundError('The owner has not confirmed any rules yet, so there is no mandate to give.');
    const { mandate, payload } = mandates.intent(agent, record);
    const money = (value: string) => formatMoney(Math.round(Number(value) * 100), currency);
    const spend = payload.spend_without_asking;
    const own = Object.entries(spend.category_limits).map(([category, limit]) => `${category.replace(/_/g, ' ')} up to ${money(limit)}`);
    const parts = [
      `up to ${money(spend.per_purchase_max)} per purchase${own.length ? ` (${own.join(', ')})` : ''}`,
      spend.weekly_budget ? `${money(spend.weekly_budget)} a week` : null,
      Array.isArray(spend.allowed_categories) ? `only ${spend.allowed_categories.map((c) => c.replace(/_/g, ' ')).join(', ')}` : null,
    ].filter(Boolean);
    const refused = payload.refused.categories.map((c) => c.replace(/_/g, ' '));
    return {
      mandate,
      summary:
        `Without asking the owner: ${parts.join(', ')}.` +
        (refused.length ? ` Never: ${refused.join(', ')}.` : '') +
        ' Anything else waits for the owner.',
      expires_at: new Date(payload.exp * 1000).toISOString(),
      jwks_url: `${publicUrl.replace(/\/$/, '')}/.well-known/jwks.json`,
    };
  }

  // Budget

  private weekCommittedCents(): number {
    const { paidCents, heldCents, processingCents } = this.options.store.committedSince(weekStart(this.now()).toISOString(), this.options.currency);
    return paidCents + heldCents + processingCents;
  }

  budget(): BudgetSummary {
    const { store, currency } = this.options;
    const start = weekStart(this.now());
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    // A purchase still on its way to PayPal counts against the budget, but it is not "held by PayPal" yet.
    const { paidCents, heldCents, processingCents } = store.committedSince(start.toISOString(), currency);
    const weekly = store.activeRules()?.rules.weeklyBudget ?? null;
    const weeklyBudgetCents = weekly === null ? null : toCents(weekly);
    return {
      currency,
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
      weeklyBudgetCents,
      paidCents,
      heldCents,
      leftCents: weeklyBudgetCents === null ? null : weeklyBudgetCents - paidCents - heldCents - processingCents,
      waitingCount: store.countByStatus('on_hold'),
      blockedThisWeek: store.countSince(start.toISOString(), 'blocked'),
    };
  }

  // PayPal wallet link

  private keyHash(): string {
    return createHash('sha256').update(`${this.mode}:${this.options.gatewayKey}`).digest('hex').slice(0, 16);
  }

  linkedWallet(): LinkedWallet | null {
    const { store } = this.options;
    const vaultId = store.getSetting(SETTING.vaultId);
    if (!vaultId || store.getSetting(SETTING.key) !== this.keyHash()) return null;
    return { vaultId, customerId: store.getSetting(SETTING.customerId), payerEmail: store.getSetting(SETTING.payerEmail) };
  }

  linkState(): WalletLink {
    const wallet = this.linkedWallet();
    return {
      mode: this.mode,
      linked: wallet !== null,
      payerEmail: wallet?.payerEmail ?? null,
      linkedAt: wallet ? this.options.store.getSetting(SETTING.linkedAt) : null,
    };
  }

  async startLink(returnUrl: string, cancelUrl: string): Promise<string> {
    const link = await this.options.gateway.startLink({ returnUrl, cancelUrl, requestId: newId('link') });
    this.options.store.setSetting(SETTING.pendingSetup, link.setupTokenId);
    return link.approveUrl;
  }

  /** Called when PayPal sends the owner back. `returnedId` is the token PayPal put in the URL, if any. */
  async finishLink(returnedId: string | null): Promise<WalletLink> {
    const { store, gateway } = this.options;
    const setupTokenId = store.getSetting(SETTING.pendingSetup);
    if (!setupTokenId || (returnedId && returnedId !== setupTokenId)) {
      throw new ConflictError('This PayPal approval does not match the link Allowance started. Start again from the dashboard.');
    }
    const wallet = await gateway.finishLink(setupTokenId, newId('link'));
    this.saveWallet(wallet);
    store.deleteSetting(SETTING.pendingSetup);
    return this.linkState();
  }

  /** Links a simulated wallet straight away, so the offline mode works on first run. */
  async ensureSimulatedLink(): Promise<void> {
    if (this.mode !== 'simulated' || this.linkedWallet()) return;
    const { setupTokenId } = await this.options.gateway.startLink({ returnUrl: 'http://localhost/', cancelUrl: 'http://localhost/', requestId: newId('link') });
    this.saveWallet(await this.options.gateway.finishLink(setupTokenId, newId('link')));
  }

  async unlink(): Promise<void> {
    const wallet = this.linkedWallet();
    if (wallet) await this.options.gateway.unlink(wallet.vaultId);
    for (const key of Object.values(SETTING)) this.options.store.deleteSetting(key);
    this.options.bus.emit({ type: 'state', reason: 'wallet' });
  }

  private saveWallet(wallet: LinkedWallet): void {
    const { store } = this.options;
    store.setSetting(SETTING.vaultId, wallet.vaultId);
    store.setSetting(SETTING.key, this.keyHash());
    store.setSetting(SETTING.linkedAt, this.now().toISOString());
    if (wallet.customerId) store.setSetting(SETTING.customerId, wallet.customerId);
    else store.deleteSetting(SETTING.customerId);
    if (wallet.payerEmail) store.setSetting(SETTING.payerEmail, wallet.payerEmail);
    else store.deleteSetting(SETTING.payerEmail);
    this.options.bus.emit({ type: 'state', reason: 'wallet' });
  }

  // Helpers

  private money(cents: number): string {
    return formatMoney(cents, this.options.currency);
  }

  private event(purchaseId: string, kind: string, detail: string, data?: unknown): void {
    this.options.store.addEvent(purchaseId, kind, detail, data, this.now());
  }

  private publish(id: string): void {
    const purchase = this.options.store.getPurchase(id);
    if (purchase) this.options.bus.emit({ type: 'purchase', purchase });
  }
}

function aiSummary(ai: AiOutcome): string {
  switch (ai.status) {
    case 'ok':
      return `AI review (${ai.review.model}, ${ai.review.latencyMs} ms): ${ai.review.verdict}. ${ai.review.explanation}`;
    case 'failed':
      return `AI review failed (${ai.model}): ${ai.error}`;
    case 'skipped':
      return `AI review skipped: ${ai.reason}`;
  }
}

function agentMessage(purchase: Purchase): string {
  switch (purchase.status) {
    case 'paid':
      return 'Paid through PayPal. Tell your user the purchase is done.';
    case 'on_hold':
    case 'settling':
      return 'The owner must approve this first. PayPal is holding the money; nothing has been charged yet. Do not retry or split the purchase. You can check later with get_purchase_status.';
    case 'processing':
      return 'PayPal is processing this payment. Check again with get_purchase_status.';
    case 'blocked':
      return "Blocked by the owner's rules. Do not retry, split the purchase or pay another way. Tell your user why.";
    case 'denied':
      return 'The owner said no. The hold was released and nothing was charged.';
    case 'expired':
      return 'Nobody approved this in time. The hold was released and nothing was charged.';
    case 'failed':
      return `The payment did not go through and nothing was charged: ${purchase.error ?? 'unknown error'}.`;
  }
}
