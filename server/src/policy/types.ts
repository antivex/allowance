import { z } from 'zod';

/** The fixed category list. The AI compiler and the agent must both use it. */
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

export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

export const CATEGORY_LABELS: Record<Category, string> = {
  office_supplies: 'office supplies',
  groceries: 'groceries',
  household: 'household',
  electronics: 'electronics',
  software: 'software & subscriptions',
  books_media: 'books & media',
  clothing: 'clothing',
  health: 'health & pharmacy',
  travel: 'travel',
  food_delivery: 'food delivery',
  services: 'services',
  shipping_tax: 'shipping & tax',
  gift_cards: 'gift cards',
  crypto: 'crypto',
  money_transfer: 'money transfers',
  gambling: 'gambling',
  adult: 'adult content',
  other: 'other',
};

export const DecisionSchema = z.enum(['approve', 'ask', 'block']);
export type Decision = z.infer<typeof DecisionSchema>;

const SEVERITY: Record<Decision, number> = { approve: 0, ask: 1, block: 2 };

/** Returns the stricter of two decisions. The order is approve < ask < block. */
export function stricter(a: Decision, b: Decision): Decision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function isStricter(a: Decision, than: Decision): boolean {
  return SEVERITY[a] > SEVERITY[than];
}

const money = z.number().finite().nonnegative().max(1_000_000);

/** Structured spending rules. Amounts are in major units (dollars), as the owner reads them. */
export const RulesSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  /** Purchases up to this amount can be approved without asking. */
  autoApproveMax: money,
  /** Purchases above this amount are always blocked. Null means no hard cap. */
  hardMax: money.positive().nullable(),
  /** Total per calendar week (Monday to Sunday), money on hold included. Null means no weekly cap. */
  weeklyBudget: money.positive().nullable(),
  /** What happens when a purchase would go over the weekly budget. */
  overBudget: z.enum(['ask', 'block']),
  /** Categories the agent may buy without asking. Empty means every category not blocked. */
  allowedCategories: z.array(CategorySchema),
  /** Categories that are never allowed. */
  blockedCategories: z.array(CategorySchema),
  /** Known merchants. Empty means any merchant. */
  allowedMerchants: z.array(z.string().trim().min(1).max(120)),
  /** Merchants that are never allowed. */
  blockedMerchants: z.array(z.string().trim().min(1).max(120)),
  /** What happens with a merchant outside a non-empty allowedMerchants list. */
  unknownMerchant: DecisionSchema,
  /** What happens with a category outside allowedCategories. */
  otherwise: z.enum(['ask', 'block']),
});
export type Rules = z.infer<typeof RulesSchema>;

const priceSchema = z.number().finite().nonnegative().max(1_000_000);

export const PurchaseItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(10_000),
  unit_price: priceSchema,
  category: CategorySchema,
});
export type PurchaseItem = z.infer<typeof PurchaseItemSchema>;

/** What an agent sends through the `request_purchase` tool. */
export const PurchaseRequestSchema = z.object({
  merchant: z.string().trim().min(1).max(120),
  items: z.array(PurchaseItemSchema).min(1).max(50),
  amount: priceSchema.positive(),
  reason: z.string().trim().min(1).max(2000),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  merchant_url: z.string().url().max(500).optional(),
  source_url: z.string().url().max(500).optional(),
});
export type PurchaseRequest = z.infer<typeof PurchaseRequestSchema>;

export interface NormalizedItem {
  name: string;
  quantity: number;
  unitPriceCents: number;
  category: Category;
}

export interface NormalizedRequest {
  merchant: string;
  merchantUrl: string | null;
  sourceUrl: string | null;
  items: NormalizedItem[];
  amountCents: number;
  currency: string;
  reason: string;
}

export type CheckId =
  | 'rules'
  | 'currency'
  | 'items_total'
  | 'injection_markers'
  | 'restricted_goods'
  | 'blocked_category'
  | 'blocked_merchant'
  | 'hard_max'
  | 'auto_limit'
  | 'weekly_budget'
  | 'category'
  | 'merchant';

export interface Check {
  id: CheckId;
  outcome: Decision;
  /** Short label for the dashboard, e.g. "Weekly budget". */
  label: string;
  /** One sentence for the owner. */
  detail: string;
}

export interface PolicyResult {
  decision: Decision;
  checks: Check[];
  /** One-line explanation of the decision. */
  explanation: string;
}
