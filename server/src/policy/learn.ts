import { CATEGORY_LABELS, type Category, type Check, type Rules } from './types.js';

/** What the owner sees after approving a held purchase: one question, never a change made behind their back. */
export interface RuleSuggestion {
  /** The question, in one sentence. */
  summary: string;
  /** The rules with the change applied, ready to confirm. */
  rules: Rules;
  /** The plain-English rules with a sentence added, so the text and the limits keep telling the same story. */
  text: string;
}

export interface ApprovedPurchase {
  checks: Check[];
  items: Array<{ category: Category }>;
  amountCents: number;
  currency: string;
  merchant: string;
  decisionSource: 'rules' | 'ai' | 'ai_unavailable';
}

/** A round limit just above the amount: 89 becomes 90, 120 becomes 150, 249 becomes 250. */
export function roundLimit(amount: number): number {
  const step = amount <= 100 ? 10 : amount <= 500 ? 50 : 100;
  return Math.ceil(amount / step) * step;
}

/**
 * After the owner approves a purchase the rules held, the change to the per-purchase limit, the categories or the known
 * merchants that would have let it through, offered as a question. The weekly budget is never raised this way: it stays
 * the owner's cap. Purchases the AI review held are left alone (its doubts are about this request, not a limit to
 * learn), and so is anything another rule held or blocked.
 */
export function suggestFromApproval(rules: Rules, text: string, purchase: ApprovedPurchase): RuleSuggestion | null {
  if (purchase.decisionSource !== 'rules') return null;
  if (purchase.checks.some((check) => check.outcome === 'block')) return null;
  const asked = new Set(purchase.checks.filter((check) => check.outcome === 'ask' && check.id !== 'weekly_budget').map((check) => check.id));
  if (asked.size === 0) return null;
  const learnable = new Set(['auto_limit', 'category', 'merchant']);
  if ([...asked].some((id) => !learnable.has(id))) return null;

  const next: Rules = structuredClone(rules);
  const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: purchase.currency }).format(value);
  const question: string[] = [];
  const sentences: string[] = [];

  if (asked.has('category')) {
    const added = [...new Set(purchase.items.map((item) => item.category))].filter(
      (category) => category !== 'shipping_tax' && !next.allowedCategories.includes(category) && !next.blockedCategories.includes(category),
    );
    if (added.length) {
      next.allowedCategories = [...next.allowedCategories, ...added];
      const names = added.map((category) => CATEGORY_LABELS[category]).join(' and ');
      question.push(`pay for ${names} without asking`);
      sentences.push(`${names.charAt(0).toUpperCase()}${names.slice(1)} is fine without asking too.`);
    }
  }
  if (asked.has('auto_limit')) {
    const limit = roundLimit(purchase.amountCents / 100);
    if (rules.hardMax !== null && limit > rules.hardMax) return null;
    next.autoApproveMax = limit;
    question.push(`raise the per-purchase limit from ${money(rules.autoApproveMax)} to ${money(limit)}, for every category`);
    sentences.push(`Up to ${money(limit)} per purchase without asking.`);
  }
  if (asked.has('merchant') && !next.allowedMerchants.includes(purchase.merchant)) {
    next.allowedMerchants = [...next.allowedMerchants, purchase.merchant];
    question.push(`trust ${purchase.merchant}`);
    sentences.push(`${purchase.merchant} is a known merchant.`);
  }
  if (!question.length) return null;

  const joined = question.length > 1 ? `${question.slice(0, -1).join(', ')} and ${question.at(-1)}` : question[0]!;
  return {
    summary: `You approved ${money(purchase.amountCents / 100)} at ${purchase.merchant}. Next time, ${joined}?`,
    rules: next,
    text: `${text.trim()} ${sentences.join(' ')}`.trim(),
  };
}
