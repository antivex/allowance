/** Shapes served by the Allowance API (mirrors server/src). */

export type Decision = 'approve' | 'ask' | 'block';
export type DecisionSource = 'rules' | 'ai' | 'ai_unavailable';
export type PurchaseStatus = 'processing' | 'paid' | 'on_hold' | 'settling' | 'denied' | 'expired' | 'blocked' | 'failed';

export const CATEGORIES = [
  'office_supplies',
  'groceries',
  'household',
  'electronics',
  'software',
  'books_media',
  'clothing',
  'health',
  'travel',
  'food_delivery',
  'services',
  'shipping_tax',
  'gift_cards',
  'crypto',
  'money_transfer',
  'gambling',
  'adult',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  office_supplies: 'Office supplies',
  groceries: 'Groceries',
  household: 'Household',
  electronics: 'Electronics',
  software: 'Software & subscriptions',
  books_media: 'Books & media',
  clothing: 'Clothing',
  health: 'Health & pharmacy',
  travel: 'Travel',
  food_delivery: 'Food delivery',
  services: 'Services',
  shipping_tax: 'Shipping & tax',
  gift_cards: 'Gift cards',
  crypto: 'Crypto',
  money_transfer: 'Money transfers',
  gambling: 'Gambling',
  adult: 'Adult content',
  other: 'Other',
};

export interface Rules {
  currency: string;
  autoApproveMax: number;
  hardMax: number | null;
  weeklyBudget: number | null;
  overBudget: 'ask' | 'block';
  allowedCategories: Category[];
  blockedCategories: Category[];
  allowedMerchants: string[];
  blockedMerchants: string[];
  unknownMerchant: Decision;
  otherwise: 'ask' | 'block';
}

export interface Check {
  id: string;
  outcome: Decision;
  label: string;
  detail: string;
}

export interface AiReview {
  verdict: Decision;
  redFlags: string[];
  explanation: string;
  model: string;
  latencyMs: number;
}

export type AiOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'ok'; review: AiReview }
  | { status: 'failed'; error: string; model: string; latencyMs: number };

export interface Item {
  name: string;
  quantity: number;
  unitPriceCents: number;
  category: Category;
}

export interface Purchase {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentId: string;
  agentName: string;
  merchant: string;
  merchantUrl: string | null;
  sourceUrl: string | null;
  items: Item[];
  amountCents: number;
  currency: string;
  reason: string;
  rulesId: number | null;
  policyDecision: Decision;
  decision: Decision;
  decisionSource: DecisionSource;
  explanation: string;
  checks: Check[];
  ai: AiOutcome;
  status: PurchaseStatus;
  paypalMode: 'sandbox' | 'simulated';
  paypalOrderId: string | null;
  paypalOrderStatus: string | null;
  paypalCaptureId: string | null;
  paypalAuthorizationId: string | null;
  paypalStatus: string | null;
  holdExpiresAt: string | null;
  settledAt: string | null;
  settledBy: string | null;
  error: string | null;
}

export interface PurchaseEvent {
  id: number;
  at: string;
  kind: string;
  detail: string;
}

export interface Agent {
  id: string;
  name: string;
  tokenHint: string;
  createdAt: string;
}

export interface RulesRecord {
  id: number;
  sourceText: string;
  rules: Rules;
  compiledBy: string;
  confirmedAt: string;
  summary: string[];
}

export interface Budget {
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

export interface AppState {
  version: string;
  mode: 'sandbox' | 'simulated';
  currency: string;
  holdMinutes: number;
  wallet: { mode: 'sandbox' | 'simulated'; linked: boolean; payerEmail: string | null; linkedAt: string | null; lastError: string | null };
  ai: { enabled: boolean; model: string; baseUrl: string; onFailure: 'ask' | 'keep'; ok: boolean; detail: string };
  rules: RulesRecord | null;
  example: { text: string; rules: Rules; summary: string[] };
  budget: Budget;
  agents: Agent[];
  mcp: { httpUrl: string; stdioEntry: string; nodePath: string; serverUrl: string };
  shopUrl: string | null;
}

export interface CompiledRules {
  rules: Rules;
  summary: string[];
  warnings: string[];
  compiledBy: string;
  latencyMs: number;
}

export interface Preview {
  policy: { decision: Decision; checks: Check[]; explanation: string };
  ai: AiOutcome;
  final: { decision: Decision; source: DecisionSource; explanation: string };
}

/** One ledger row next to PayPal's own record of its order, checked through PayPal's Agent Toolkit. */
export interface PayPalCheck {
  purchaseId: string;
  agent?: string;
  merchant: string;
  amount?: string;
  ledger?: string;
  expected?: string;
  paypal: string;
  matches: boolean;
  orderId: string | null;
}

export interface PayPalCheckResult {
  available: boolean;
  reason?: string;
  checkedAt?: string;
  check: PayPalCheck | null;
}

export interface ReconcileResult {
  available: boolean;
  reason?: string;
  checkedAt?: string;
  checks?: PayPalCheck[];
  summary?: { checked: number; matching: number; notMatching: number; withoutOrder: number };
}
