import { describe, expect, it } from 'vitest';
import { describeRules, exampleRules, exampleRulesText, normalizeRules } from '../src/ai/compiler.js';
import { roundLimit, suggestFromApproval, type ApprovedPurchase } from '../src/policy/learn.js';
import type { Check } from '../src/policy/types.js';

const RULES = exampleRules('EUR');
const TEXT = exampleRulesText('EUR');
const check = (id: Check['id'], outcome: Check['outcome']): Check => ({ id, outcome, label: id, detail: id });

const CHAIR: ApprovedPurchase = {
  checks: [check('auto_limit', 'ask'), check('category', 'ask'), check('weekly_budget', 'approve'), check('merchant', 'approve')],
  items: [{ category: 'household' }],
  amountCents: 8900,
  currency: 'EUR',
  merchant: 'Inkwell Supplies',
  decisionSource: 'rules',
};

describe('rules that learn from the owner’s approvals', () => {
  it('offers the smallest change that would have let an approved purchase through', () => {
    const suggestion = suggestFromApproval(RULES, TEXT, CHAIR);
    expect(suggestion).not.toBeNull();
    // Only household gets the higher limit: everything else keeps the owner's €50.
    expect(suggestion!.rules.autoApproveMax).toBe(RULES.autoApproveMax);
    expect(suggestion!.rules.categoryLimits).toEqual({ household: 90 });
    expect(suggestion!.rules.allowedCategories).toEqual([...RULES.allowedCategories, 'household']);
    expect(suggestion!.rules.weeklyBudget).toBe(RULES.weeklyBudget);
    expect(suggestion!.summary).toBe('You approved €89.00 at Inkwell Supplies. Next time, pay for household without asking, up to €90.00 a purchase?');
    expect(suggestion!.text).toBe(`${TEXT} Household is fine without asking, up to €90.00 per purchase.`);
  });

  it('raises only the limit of the purchase’s own category when the category was already allowed', () => {
    const ink: ApprovedPurchase = { ...CHAIR, checks: [check('auto_limit', 'ask'), check('category', 'approve')], items: [{ category: 'office_supplies' }], amountCents: 7400 };
    const suggestion = suggestFromApproval(RULES, TEXT, ink);
    expect(suggestion!.rules.categoryLimits).toEqual({ office_supplies: 80 });
    expect(suggestion!.rules.autoApproveMax).toBe(RULES.autoApproveMax);
    expect(suggestion!.summary).toBe('You approved €74.00 at Inkwell Supplies. Next time, pay for office supplies without asking up to €80.00 a purchase?');
    // A smaller approval never lowers a limit the owner already accepted.
    expect(suggestFromApproval({ ...RULES, categoryLimits: { office_supplies: 150 } }, TEXT, ink)!.rules.categoryLimits).toEqual({ office_supplies: 150 });
  });

  it('learns nothing from AI-review holds, blocks or a budget-only hold, and never raises the weekly budget', () => {
    expect(suggestFromApproval(RULES, TEXT, { ...CHAIR, decisionSource: 'ai' })).toBeNull();
    expect(suggestFromApproval(RULES, TEXT, { ...CHAIR, checks: [...CHAIR.checks, check('restricted_goods', 'block')] })).toBeNull();
    expect(suggestFromApproval({ ...RULES, hardMax: 80 }, TEXT, CHAIR)).toBeNull();
    expect(suggestFromApproval(RULES, TEXT, { ...CHAIR, checks: [check('weekly_budget', 'ask'), check('auto_limit', 'approve')] })).toBeNull();
    const overBudgetToo = suggestFromApproval(RULES, TEXT, { ...CHAIR, checks: [...CHAIR.checks, check('weekly_budget', 'ask')] });
    expect(overBudgetToo?.rules.categoryLimits).toEqual({ household: 90 });
    expect(overBudgetToo?.rules.weeklyBudget).toBe(RULES.weeklyBudget);
  });

  it('keeps category limits safe whether they come from the model (a list) or the dashboard (a map)', () => {
    const fromModel = normalizeRules({ ...RULES, hardMax: 120, categoryLimits: [{ category: 'household', limit: 90 }, { category: 'electronics', limit: 300 }, { category: 'gift_cards', limit: 50 }] }, 'EUR');
    // Above the hard limit it is lowered; on the never list it is dropped.
    expect(fromModel.rules.categoryLimits).toEqual({ household: 90, electronics: 120 });
    expect(fromModel.warnings).toContain('The electronics limit was above the hard limit, so it was lowered to match.');
    expect(normalizeRules({ ...RULES, categoryLimits: { household: 90 } }, 'EUR').rules.categoryLimits).toEqual({ household: 90 });
    expect(describeRules({ ...RULES, categoryLimits: { household: 90 } })).toContain('Household: up to €90.00 per purchase.');
  });

  it('rounds the new limit to a figure the owner would choose', () => {
    expect([roundLimit(89), roundLimit(100), roundLimit(120), roundLimit(249), roundLimit(1180)]).toEqual([90, 100, 150, 250, 1200]);
  });
});
