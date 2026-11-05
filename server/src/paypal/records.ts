import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
import type { Purchase } from '../store.js';

/** What PayPal itself says about one order: enough to check the ledger, and none of the payer's personal details. */
export interface PayPalOrderView {
  orderId: string;
  intent: string | null;
  orderStatus: string | null;
  amount: string | null;
  items: string[];
  authorization: { id: string; status: string } | null;
  capture: { id: string; status: string } | null;
}

/** One ledger row next to PayPal's own record of it. */
export interface PayPalCheck {
  purchaseId: string;
  agent: string;
  merchant: string;
  amount: string;
  ledger: string;
  /** What PayPal should show for this ledger status. */
  expected: string;
  paypal: string;
  matches: boolean;
  orderId: string;
}

interface OrderJson {
  id?: string;
  intent?: string;
  status?: string;
  purchase_units?: Array<{
    amount?: { value: string; currency_code: string };
    items?: Array<{ name: string; quantity: string }>;
    payments?: { authorizations?: Array<{ id: string; status: string }>; captures?: Array<{ id: string; status: string }> };
  }>;
}

const first = (list?: Array<{ id: string; status: string }>) => (list?.[0] ? { id: list[0].id, status: list[0].status } : null);

/**
 * PayPal's own Agent Toolkit, read-only. Allowance asks it for orders (its get_order tool) to check the ledger against
 * PayPal's records, for the owner and for the Insights auditor. Only the orders.get action is enabled, so nothing can
 * create, capture or refund through it.
 */
export class PayPalRecords {
  private readonly kit: PayPalAgentToolkit;

  constructor(clientId: string, clientSecret: string) {
    this.kit = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: { orders: { get: true } }, context: { sandbox: true } } });
  }

  async order(orderId: string): Promise<PayPalOrderView> {
    const message = await this.kit.handleToolCall({
      id: `get_order_${orderId}`,
      type: 'function',
      function: { name: 'get_order', arguments: JSON.stringify({ id: orderId }) },
    });
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    let order: OrderJson;
    try {
      order = JSON.parse(text) as OrderJson;
    } catch {
      throw new Error(`PayPal did not return order ${orderId}: ${text.slice(0, 200)}`);
    }
    if (order.id !== orderId) throw new Error(`PayPal did not return order ${orderId}: ${text.slice(0, 200)}`);
    const unit = order.purchase_units?.[0];
    return {
      orderId,
      intent: order.intent ?? null,
      orderStatus: order.status ?? null,
      amount: unit?.amount ? `${unit.amount.value} ${unit.amount.currency_code}` : null,
      items: (unit?.items ?? []).map((item) => `${item.quantity} × ${item.name}`),
      authorization: first(unit?.payments?.authorizations),
      capture: first(unit?.payments?.captures),
    };
  }

  /** Checks one purchase that reached PayPal against PayPal's record of its order. */
  async check(purchase: Purchase): Promise<PayPalCheck> {
    const view = await this.order(purchase.paypalOrderId!);
    const amount = `${(purchase.amountCents / 100).toFixed(2)} ${purchase.currency}`;
    const { expected, matches } = compare(purchase.status, view, amount);
    const parts = [
      `order ${view.orderStatus ?? 'unknown'}`,
      view.authorization ? `hold ${view.authorization.status}` : null,
      view.capture ? `capture ${view.capture.status}` : null,
      view.amount ? `for ${view.amount}` : null,
    ].filter(Boolean);
    return {
      purchaseId: purchase.id,
      agent: purchase.agentName,
      merchant: purchase.merchant,
      amount,
      ledger: purchase.status,
      expected,
      paypal: parts.join(', '),
      matches,
      orderId: view.orderId,
    };
  }
}

/** What PayPal must show for each ledger status, and whether it does. */
export function compare(status: Purchase['status'], view: PayPalOrderView, amount: string): { expected: string; matches: boolean } {
  const sameAmount = view.amount === amount;
  switch (status) {
    case 'paid':
      return { expected: `a completed capture of ${amount}`, matches: sameAmount && view.capture?.status === 'COMPLETED' };
    case 'on_hold':
    case 'settling':
      return { expected: `a hold of ${amount}, not captured`, matches: sameAmount && view.authorization?.status === 'CREATED' && !view.capture };
    case 'denied':
    case 'expired':
      return { expected: `a voided hold of ${amount}, nothing captured`, matches: sameAmount && view.authorization?.status === 'VOIDED' && !view.capture };
    default:
      return { expected: 'no money moved', matches: !view.capture };
  }
}
