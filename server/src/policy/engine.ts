import { formatMoney, toCents } from './money.js';
import {
  CATEGORY_LABELS,
  stricter,
  type Category,
  type Check,
  type Decision,
  type NormalizedRequest,
  type PolicyResult,
  type PurchaseRequest,
  type Rules,
} from './types.js';

/**
 * The deterministic half of every decision. Pure functions only: no clock, no I/O, no AI.
 * The AI review runs after this and may only make the result stricter.
 */

export interface PolicyContext {
  /** The confirmed rules, or null when the owner has not confirmed any yet. */
  rules: Rules | null;
  /** Money already paid or on hold this week, in cents of rules.currency. */
  weekSpentCents: number;
  /** Currency used when there are no rules yet. */
  defaultCurrency: string;
}

export function normalizeRequest(input: PurchaseRequest, defaultCurrency: string): NormalizedRequest {
  return {
    merchant: input.merchant.trim(),
    merchantUrl: input.merchant_url ?? null,
    sourceUrl: input.source_url ?? null,
    items: input.items.map((item) => ({
      name: item.name.trim(),
      quantity: item.quantity,
      unitPriceCents: toCents(item.unit_price),
      category: item.category,
    })),
    amountCents: toCents(input.amount),
    currency: (input.currency ?? defaultCurrency).toUpperCase(),
    reason: input.reason.trim(),
  };
}

/** Goods that are scam favourites. Detected from item and merchant names, whatever the agent declares. */
const RESTRICTED_PATTERNS: ReadonlyArray<{ category: Category; pattern: RegExp }> = [
  {
    category: 'gift_cards',
    pattern:
      /\b(gift\s*-?\s*cards?|giftcards?|e-?gift|steam\s*(wallet|card|code)s?|itunes\s*(card|code)s?|apple\s*gift|google\s*play\s*(card|code)s?|prepaid\s*(visa|mastercard|card|debit)s?|voucher\s*codes?|redeem(able)?\s*codes?)\b/i,
  },
  {
    category: 'crypto',
    pattern: /\b(bitcoin|btc|ethereum|eth|usdt|usdc|tether|crypto\s*(currency|coins?)?|cryptocurrenc(y|ies)|wallet\s*address|dogecoin|solana)\b/i,
  },
  {
    category: 'money_transfer',
    pattern: /\b(wire\s*transfers?|western\s*union|moneygram|money\s*orders?|bank\s*transfers?|send\s*money|zelle|cash\s*app)\b/i,
  },
  {
    category: 'gambling',
    pattern: /\b(casino|sports?\s*bet(s|ting)?|poker\s*chips|lottery\s*tickets?|slot\s*credits?)\b/i,
  },
];

/** Text that only makes sense as an instruction to an AI. An honest agent never writes it in a purchase reason. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above|earlier|your)\s+(instructions|rules|prompts?)\b/i,
  /\bdisregard\s+(all\s+|any\s+)?(previous|prior|your|the)\s+(instructions|rules|policy|policies)\b/i,
  /\b(system|developer)\s+prompt\b/i,
  /\byou\s+are\s+now\s+(in\s+)?(developer|admin|god|unrestricted)\s*mode\b/i,
  /<\|im_start\|>|\[\/?INST\]|<\/?system>/i,
  /\bapprove\s+this\s+(purchase|request|payment)\s+(automatically|without\s+asking)\b/i,
];

export function detectRestricted(text: string): Category | null {
  for (const { category, pattern } of RESTRICTED_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return null;
}

export function findInjectionMarker(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]/g, '');
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True when the request's merchant matches a list entry by name or by domain. */
export function merchantMatches(entry: string, merchant: string, merchantUrl: string | null): boolean {
  const normalizedEntry = normalizeMerchant(entry);
  if (normalizedEntry.length === 0) return false;
  if (normalizedEntry === normalizeMerchant(merchant)) return true;
  const host = hostOf(merchantUrl);
  const domain = entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return host !== null && domain.includes('.') && (host === domain || host.endsWith(`.${domain}`));
}

function label(category: Category): string {
  return CATEGORY_LABELS[category];
}

function list(categories: readonly Category[]): string {
  return categories.map(label).join(', ');
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface ItemView {
  name: string;
  declared: Category;
  detected: Category | null;
  effective: Category;
}

function viewItems(req: NormalizedRequest): ItemView[] {
  const merchantHit = detectRestricted(req.merchant);
  return req.items.map((item) => {
    const detected = detectRestricted(item.name) ?? merchantHit;
    const restrictedDeclared = RESTRICTED_PATTERNS.some((p) => p.category === item.category);
    const effective = detected && !restrictedDeclared ? detected : item.category;
    return { name: item.name, declared: item.category, detected, effective };
  });
}

export function evaluate(req: NormalizedRequest, ctx: PolicyContext): PolicyResult {
  const { rules } = ctx;
  const currency = rules?.currency ?? ctx.defaultCurrency;
  const fmt = (cents: number) => formatMoney(cents, currency);
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);

  if (!rules) {
    add({ id: 'rules', outcome: 'ask', label: 'Rules', detail: 'No rules confirmed yet, so every purchase waits for you.' });
  }

  // Structural checks: they hold with or without rules.
  if (req.currency !== currency) {
    add({
      id: 'currency',
      outcome: 'block',
      label: 'Currency',
      detail: `Allowance pays in ${currency} only; the agent asked for ${req.currency}.`,
    });
  } else {
    add({ id: 'currency', outcome: 'approve', label: 'Currency', detail: `Paid in ${currency}.` });
  }

  const itemsTotal = req.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  if (itemsTotal !== req.amountCents) {
    add({
      id: 'items_total',
      outcome: 'block',
      label: 'Items add up',
      detail: `The items add up to ${fmt(itemsTotal)}, but the agent asked to pay ${fmt(req.amountCents)}.`,
    });
  } else {
    add({ id: 'items_total', outcome: 'approve', label: 'Items add up', detail: `Items add up to ${fmt(itemsTotal)}.` });
  }

  const marker = findInjectionMarker([req.reason, req.merchant, ...req.items.map((i) => i.name)].join('\n'));
  if (marker) {
    add({
      id: 'injection_markers',
      outcome: 'block',
      label: 'Injected instructions',
      detail: `The request contains an instruction aimed at AI ("${marker}"), a sign the agent was hijacked.`,
    });
  } else {
    add({ id: 'injection_markers', outcome: 'approve', label: 'Injected instructions', detail: 'No instructions aimed at AI.' });
  }

  const items = viewItems(req);
  const mislabeled = items.find((item) => item.detected && item.detected !== item.declared);
  if (mislabeled && mislabeled.detected) {
    const blocked = rules?.blockedCategories.includes(mislabeled.detected) ?? false;
    add({
      id: 'restricted_goods',
      outcome: blocked ? 'block' : 'ask',
      label: 'Restricted goods',
      detail: `"${mislabeled.name}" looks like ${label(mislabeled.detected)}, but the agent filed it as ${label(mislabeled.declared)}.`,
    });
  } else {
    add({
      id: 'restricted_goods',
      outcome: 'approve',
      label: 'Restricted goods',
      detail: 'Nothing that looks like gift cards, crypto, money transfers or gambling.',
    });
  }

  if (rules) {
    const effective = [...new Set(items.map((item) => item.effective))];

    const blockedHit = effective.filter((category) => rules.blockedCategories.includes(category));
    if (blockedHit.length > 0) {
      add({
        id: 'blocked_category',
        outcome: 'block',
        label: 'Never-buy list',
        detail: `${capitalize(list(blockedHit))} ${blockedHit.length > 1 ? 'are' : 'is'} on your never-buy list.`,
      });
    } else {
      add({ id: 'blocked_category', outcome: 'approve', label: 'Never-buy list', detail: 'Nothing on your never-buy list.' });
    }

    const blockedMerchant = rules.blockedMerchants.find((entry) => merchantMatches(entry, req.merchant, req.merchantUrl));
    if (blockedMerchant) {
      add({
        id: 'blocked_merchant',
        outcome: 'block',
        label: 'Blocked merchant',
        detail: `${req.merchant} is on your blocked merchants list.`,
      });
    } else {
      add({ id: 'blocked_merchant', outcome: 'approve', label: 'Blocked merchant', detail: 'The merchant is not blocked.' });
    }

    const hardMaxCents = rules.hardMax === null ? null : toCents(rules.hardMax);
    if (hardMaxCents !== null && req.amountCents > hardMaxCents) {
      add({
        id: 'hard_max',
        outcome: 'block',
        label: 'Hard limit',
        detail: `${fmt(req.amountCents)} is over your ${fmt(hardMaxCents)} hard limit per purchase.`,
      });
    } else {
      add({
        id: 'hard_max',
        outcome: 'approve',
        label: 'Hard limit',
        detail: hardMaxCents === null ? 'No hard limit per purchase.' : `Under your ${fmt(hardMaxCents)} hard limit.`,
      });
    }

    // A category can have its own limit; with several categories in one purchase, the strictest applies.
    const goods = effective.filter((category) => category !== 'shipping_tax');
    const ownLimit = goods.length > 0 && goods.every((category) => rules.categoryLimits[category] !== undefined);
    const autoMax = goods.length ? Math.min(...goods.map((category) => rules.categoryLimits[category] ?? rules.autoApproveMax)) : rules.autoApproveMax;
    const autoMaxCents = toCents(autoMax);
    const limitName = ownLimit ? `${list(goods)} limit` : 'auto-approve limit';
    if (req.amountCents > autoMaxCents) {
      add({
        id: 'auto_limit',
        outcome: 'ask',
        label: 'Auto-approve limit',
        detail: `${fmt(req.amountCents)} is over your ${fmt(autoMaxCents)} ${limitName}.`,
      });
    } else {
      add({
        id: 'auto_limit',
        outcome: 'approve',
        label: 'Auto-approve limit',
        detail: `Within your ${fmt(autoMaxCents)} ${limitName}.`,
      });
    }

    const budgetCents = rules.weeklyBudget === null ? null : toCents(rules.weeklyBudget);
    const after = ctx.weekSpentCents + req.amountCents;
    if (budgetCents !== null && after > budgetCents) {
      add({
        id: 'weekly_budget',
        outcome: rules.overBudget,
        label: 'Weekly budget',
        detail: `${fmt(req.amountCents)} would take this week to ${fmt(after)}, over your ${fmt(budgetCents)} budget.`,
      });
    } else {
      add({
        id: 'weekly_budget',
        outcome: 'approve',
        label: 'Weekly budget',
        detail: budgetCents === null ? 'No weekly budget set.' : `${fmt(budgetCents - after)} left this week after this purchase.`,
      });
    }

    const outside =
      rules.allowedCategories.length === 0
        ? []
        : effective.filter((category) => category !== 'shipping_tax' && !rules.allowedCategories.includes(category));
    if (outside.length > 0) {
      add({
        id: 'category',
        outcome: rules.otherwise,
        label: 'Category',
        detail: `${capitalize(list(outside))} ${outside.length > 1 ? 'are' : 'is'} not on your auto-approve list (${list(rules.allowedCategories)}).`,
      });
    } else {
      add({
        id: 'category',
        outcome: 'approve',
        label: 'Category',
        detail:
          rules.allowedCategories.length === 0 ? 'Every category you did not block is allowed.' : `${capitalize(list(effective))}: allowed.`,
      });
    }

    const known =
      rules.allowedMerchants.length === 0 ||
      rules.allowedMerchants.some((entry) => merchantMatches(entry, req.merchant, req.merchantUrl));
    if (!known) {
      add({
        id: 'merchant',
        outcome: rules.unknownMerchant,
        label: 'Merchant',
        detail: `${req.merchant} is not one of your known merchants.`,
      });
    } else {
      add({
        id: 'merchant',
        outcome: 'approve',
        label: 'Merchant',
        detail: rules.allowedMerchants.length === 0 ? 'Any merchant is allowed.' : `${req.merchant} is a known merchant.`,
      });
    }
  }

  const decision = checks.reduce<Decision>((acc, check) => stricter(acc, check.outcome), 'approve');
  return { decision, checks, explanation: explain(decision, checks, req, ctx, items) };
}

function explain(
  decision: Decision,
  checks: Check[],
  req: NormalizedRequest,
  ctx: PolicyContext,
  items: ItemView[],
): string {
  if (decision !== 'approve') {
    const first = checks.find((check) => check.outcome === decision);
    return first ? first.detail : 'Needs your review.';
  }
  const currency = ctx.rules?.currency ?? ctx.defaultCurrency;
  const categories = list([...new Set(items.map((item) => item.effective))]);
  const budget = ctx.rules?.weeklyBudget;
  const left =
    budget === null || budget === undefined
      ? ''
      : `; ${formatMoney(toCents(budget) - ctx.weekSpentCents - req.amountCents, currency)} left this week`;
  return `Within your rules: ${formatMoney(req.amountCents, currency)} of ${categories} at ${req.merchant}${left}.`;
}
