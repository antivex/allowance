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
  /** Who receives the money on PayPal's record: an email or a merchant ID. */
  payee: string | null;
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
    payee?: { email_address?: string; merchant_id?: string };
    payments?: { authorizations?: Array<{ id: string; status: string }>; captures?: Array<{ id: string; status: string }> };
  }>;
}

const first = (list?: Array<{ id: string; status: string }>) => (list?.[0] ? { id: list[0].id, status: list[0].status } : null);

/** One settled transaction on PayPal's own list for the account, without the payer's personal details. */
export interface PayPalTransaction {
  id: string;
  date: string | null;
  amount: string | null;
  /** S success, P pending, V reversed, D denied. */
  status: string | null;
  /** Allowance's request ID, which every order carries as its invoice ID. */
  invoiceId: string | null;
}

/** What PayPal answers when the app lacks a permission (for transaction search: a checkbox in the app's settings). */
export class PayPalRecordsError extends Error {}

/**
 * PayPal's own Agent Toolkit, read-only. Allowance asks it for orders (its get_order tool) to check the ledger against
 * PayPal's records, and for the account's transaction list (list_transactions), for the owner and for the Insights
 * auditor. Only these two read actions are enabled, so nothing can create, capture or refund through it.
 */
export class PayPalRecords {
  private readonly kit: PayPalAgentToolkit;

  constructor(clientId: string, clientSecret: string) {
    this.kit = new PayPalAgentToolkit({
      clientId,
      clientSecret,
      configuration: { actions: { orders: { get: true }, transactions: { list: true } }, context: { sandbox: true } },
    });
  }

  /** PayPal's list of transactions in the last `days` days. New payments can take up to three hours to appear. */
  async transactions(days = 7, now = new Date()): Promise<PayPalTransaction[]> {
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const message = await this.kit.handleToolCall({
      id: `list_transactions_${now.getTime()}`,
      type: 'function',
      function: { name: 'list_transactions', arguments: JSON.stringify({ start_date: start.toISOString(), end_date: now.toISOString() }) },
    });
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    let data: {
      ok?: boolean;
      status?: number;
      message?: string;
      transaction_details?: Array<{
        transaction_info?: {
          transaction_id?: string;
          transaction_initiation_date?: string;
          transaction_amount?: { value: string; currency_code: string };
          transaction_status?: string;
          invoice_id?: string;
        };
      }>;
    };
    try {
      data = JSON.parse(text);
    } catch {
      throw new PayPalRecordsError(`PayPal did not return the transaction list: ${text.slice(0, 200)}`);
    }
    if (data.ok === false) {
      throw new PayPalRecordsError(
        data.status === 403
          ? 'PayPal refused the transaction list: turn on "Transaction search" in the settings of your PayPal REST app.'
          : `PayPal did not return the transaction list: ${data.message ?? data.status}`,
      );
    }
    return (data.transaction_details ?? []).map(({ transaction_info: info = {} }) => ({
      id: info.transaction_id ?? '',
      date: info.transaction_initiation_date ?? null,
      amount: info.transaction_amount ? `${info.transaction_amount.value} ${info.transaction_amount.currency_code}` : null,
      status: info.transaction_status ?? null,
      invoiceId: info.invoice_id ?? null,
    }));
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
      payee: unit?.payee?.email_address ?? unit?.payee?.merchant_id ?? null,
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
      view.payee ? `to ${view.payee}` : null,
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
