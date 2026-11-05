import { z } from 'zod';
import { formatMoney, toCents } from '../policy/money.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  CategorySchema,
  DecisionSchema,
  RulesSchema,
  type Category,
  type Rules,
} from '../policy/types.js';
import { ChatClient } from './chat.js';

/** What the model fills in. Loose on purpose: normalizeRules() makes it safe. */
const DraftSchema = z.object({
  currency: z.string(),
  autoApproveMax: z.number(),
  hardMax: z.number().nullable(),
  weeklyBudget: z.number().nullable(),
  overBudget: z.enum(['ask', 'block']),
  allowedCategories: z.array(CategorySchema),
  blockedCategories: z.array(CategorySchema),
  allowedMerchants: z.array(z.string()),
  blockedMerchants: z.array(z.string()),
  unknownMerchant: DecisionSchema,
  otherwise: z.enum(['ask', 'block']),
});
export type RulesDraft = z.infer<typeof DraftSchema>;

export function compilerSystemPrompt(currency: string): string {
  return `You turn a person's plain-English spending rules for their AI agent into JSON. Fill every field:
- currency: 3-letter code. Use "${currency}" unless the text clearly names another currency.
- autoApproveMax: the largest single purchase the agent may make without asking, in currency units. If the text sets no per-purchase limit, use 0 so every purchase is asked.
- hardMax: a single-purchase amount above which the purchase is always refused, or null if the text sets none.
- weeklyBudget: the total the agent may spend per week, or null. A monthly budget becomes monthly / 4.33; a daily one becomes daily * 7. Round to cents.
- overBudget: what happens when a purchase would go over the weekly budget. "ask" unless the text explicitly says purchases over the budget must be refused. "Never gift cards" or "ask me" do not count: they are about categories.
- allowedCategories: categories the agent may buy without asking.
- blockedCategories: categories that are never allowed.
- allowedMerchants and blockedMerchants: merchant names or domains the text names, else [].
- unknownMerchant: what to do with merchants outside allowedMerchants: "approve", "ask" or "block". Default "ask".
- otherwise: what to do with anything the rules do not cover: "ask" or "block". Default "ask".
Use only these categories: ${CATEGORIES.join(', ')}.
Map everyday words to them: "office supplies", "printer ink", "paper" -> office_supplies; "food", "groceries" -> groceries; "apps", "subscriptions", "SaaS" -> software; "gift cards", "vouchers" -> gift_cards; "crypto", "bitcoin" -> crypto; "betting" -> gambling.
Never invent limits, merchants or categories the text does not support. Reply with JSON only.`;
}

const round = (value: number) => Math.round(Math.max(0, value) * 100) / 100;

/** Makes a model draft safe to show and store: clamps numbers, dedupes lists, resolves contradictions. */
export function normalizeRules(draft: RulesDraft, defaultCurrency: string): { rules: Rules; warnings: string[] } {
  const warnings: string[] = [];
  const currency = /^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase()) ? draft.currency.trim().toUpperCase() : defaultCurrency;
  if (currency !== defaultCurrency) {
    warnings.push(`The rules use ${currency}, but Allowance pays in ${defaultCurrency}: purchases will be blocked until they match.`);
  }
  const blocked = [...new Set(draft.blockedCategories)];
  const allowed = [...new Set(draft.allowedCategories)].filter((category) => !blocked.includes(category));
  if (allowed.length < new Set(draft.allowedCategories).size) {
    warnings.push('Some categories were both allowed and blocked; they stay blocked.');
  }
  const merchants = (list: string[]) => [...new Set(list.map((m) => m.trim()).filter((m) => m.length > 0 && m.length <= 120))];

  const autoApproveMax = round(draft.autoApproveMax);
  let hardMax = draft.hardMax === null || draft.hardMax <= 0 ? null : round(draft.hardMax);
  if (hardMax !== null && hardMax < autoApproveMax) {
    warnings.push('The hard limit was below the auto-approve limit, so it was raised to match.');
    hardMax = autoApproveMax;
  }
  const weeklyBudget = draft.weeklyBudget === null || draft.weeklyBudget <= 0 ? null : round(draft.weeklyBudget);

  if (autoApproveMax === 0) warnings.push('No per-purchase limit found: every purchase will wait for you.');
  if (weeklyBudget === null) warnings.push('No weekly budget found.');

  const rules = RulesSchema.parse({
    currency,
    autoApproveMax,
    hardMax,
    weeklyBudget,
    overBudget: draft.overBudget,
    allowedCategories: allowed,
    blockedCategories: blocked,
    allowedMerchants: merchants(draft.allowedMerchants),
    blockedMerchants: merchants(draft.blockedMerchants),
    unknownMerchant: draft.unknownMerchant,
    otherwise: draft.otherwise,
  });
  return { rules, warnings };
}

function names(categories: readonly Category[]): string {
  return categories.map((category) => CATEGORY_LABELS[category]).join(', ');
}

/** Plain sentences for the confirmation screen, so the owner reads rules, not JSON. */
export function describeRules(rules: Rules): string[] {
  const money = (amount: number) => formatMoney(toCents(amount), rules.currency);
  const verb = { approve: 'allow', ask: 'ask me', block: 'refuse' } as const;
  const lines: string[] = [];
  lines.push(rules.autoApproveMax > 0 ? `Pay without asking up to ${money(rules.autoApproveMax)} per purchase.` : 'Ask me before every purchase.');
  if (rules.hardMax !== null) lines.push(`Never more than ${money(rules.hardMax)} in one purchase.`);
  if (rules.weeklyBudget !== null) {
    lines.push(`Weekly budget ${money(rules.weeklyBudget)}, money on hold included. Over budget: ${verb[rules.overBudget]}.`);
  }
  lines.push(
    rules.allowedCategories.length > 0
      ? `Without asking, only: ${names(rules.allowedCategories)}.`
      : 'Without asking: any category not on the never list.',
  );
  if (rules.blockedCategories.length > 0) lines.push(`Never: ${names(rules.blockedCategories)}.`);
  if (rules.allowedMerchants.length > 0) {
    lines.push(`Known merchants: ${rules.allowedMerchants.join(', ')}. Others: ${verb[rules.unknownMerchant]}.`);
  }
  if (rules.blockedMerchants.length > 0) lines.push(`Blocked merchants: ${rules.blockedMerchants.join(', ')}.`);
  lines.push(`Anything else: ${verb[rules.otherwise]}.`);
  return lines;
}

export interface CompiledRules {
  rules: Rules;
  summary: string[];
  warnings: string[];
  compiledBy: string;
  latencyMs: number;
}

/** Plain English in, structured rules out. The owner confirms before anything is saved. */
export class RulesCompiler {
  constructor(
    private readonly chat: ChatClient,
    private readonly currency: string,
  ) {}

  async compile(text: string): Promise<CompiledRules> {
    const { value, latencyMs } = await this.chat.json({
      system: compilerSystemPrompt(this.currency),
      user: `Spending rules:\n"""${text.trim()}"""`,
      schema: DraftSchema,
      name: 'spending_rules',
    });
    const { rules, warnings } = normalizeRules(value, this.currency);
    return { rules, summary: describeRules(rules), warnings, compiledBy: this.chat.model, latencyMs };
  }
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

/** The example rules from the README, in the wallet's currency, used before the owner writes their own. */
export function exampleRulesText(currency: string): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `Up to ${symbol}50 per purchase for office supplies, ${symbol}150 a week in total. Anything else, ask me. Never gift cards or crypto.`;
}

export function exampleRules(currency: string): Rules {
  return { ...EXAMPLE_RULES, currency };
}

export const EXAMPLE_RULES_TEXT = exampleRulesText('USD');

export const EXAMPLE_RULES: Rules = {
  currency: 'USD',
  autoApproveMax: 50,
  hardMax: null,
  weeklyBudget: 150,
  overBudget: 'ask',
  allowedCategories: ['office_supplies'],
  blockedCategories: ['gift_cards', 'crypto'],
  allowedMerchants: [],
  blockedMerchants: [],
  unknownMerchant: 'ask',
  otherwise: 'ask',
};
