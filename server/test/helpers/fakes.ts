import type { LinkedWallet, OrderInput, OrderOutcome, PaymentGateway } from '../../src/paypal/gateway.js';
import type { AiOutcome } from '../../src/policy/combine.js';
import type { Decision } from '../../src/policy/types.js';
import type { Reviewer } from '../../src/wallet.js';

/** A PaymentGateway that records calls and can be told to fail once. */
export class FakeGateway implements PaymentGateway {
  readonly mode = 'simulated' as const;
  calls: string[] = [];
  orders: OrderInput[] = [];
  failNext: Error | null = null;
  private n = 0;

  private maybeFail(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async startLink() {
    return { setupTokenId: 'SETUP', approveUrl: 'http://localhost/return' };
  }
  async finishLink(): Promise<LinkedWallet> {
    return { vaultId: 'VAULT', customerId: 'CUST', payerEmail: 'buyer@example.com' };
  }
  async unlink() {}
  async createOrder(input: OrderInput): Promise<OrderOutcome> {
    this.calls.push(`order:${input.intent}`);
    this.orders.push(input);
    this.maybeFail();
    this.n++;
    const authorize = input.intent === 'AUTHORIZE';
    return {
      orderId: `ORDER${this.n}`,
      orderStatus: 'COMPLETED',
      captureId: authorize ? null : `CAPTURE${this.n}`,
      captureStatus: authorize ? null : 'COMPLETED',
      authorizationId: authorize ? `AUTH${this.n}` : null,
      authorizationStatus: authorize ? 'CREATED' : null,
      authorizationExpiresAt: null,
    };
  }
  async capture(authorizationId: string) {
    this.calls.push(`capture:${authorizationId}`);
    this.maybeFail();
    return { captureId: `CAPTURE-${authorizationId}`, status: 'COMPLETED' };
  }
  async void(authorizationId: string) {
    this.calls.push(`void:${authorizationId}`);
    this.maybeFail();
    return { status: 'VOIDED' };
  }
}

/** A Reviewer that returns whatever verdict the test sets. */
export class FakeReviewer implements Reviewer {
  readonly model = 'fake-model';
  next: Decision | 'fail' = 'approve';
  seen = 0;
  async review(): Promise<AiOutcome> {
    this.seen++;
    if (this.next === 'fail') return { status: 'failed', error: 'No answer within 30 s.', model: this.model, latencyMs: 30_000 };
    return {
      status: 'ok',
      review: { verdict: this.next, redFlags: this.next === 'approve' ? [] : ['fee demanded by a web page'], explanation: `AI says ${this.next}.`, model: this.model, latencyMs: 5 },
    };
  }
}
