import { describe, expect, it } from 'vitest';
import { exampleRules, exampleRulesText } from '../src/ai/compiler.js';
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
    expect(suggestion!.rules.autoApproveMax).toBe(90);
    expect(suggestion!.rules.allowedCategories).toEqual([...RULES.allowedCategories, 'household']);
    expect(suggestion!.rules.weeklyBudget).toBe(RULES.weeklyBudget);
    expect(suggestion!.summary).toBe(
      'You approved €89.00 at Inkwell Supplies. Next time, pay for household without asking and raise the per-purchase limit from €50.00 to €90.00, for every category?',
    );
    expect(suggestion!.text).toBe(`${TEXT} Household is fine without asking too. Up to €90.00 per purchase without asking.`);
  });

  it('learns nothing from AI-review holds, blocks or a budget-only hold, and never raises the weekly budget', () => {
    expect(suggestFromApproval(RULES, TEXT, { ...CHAIR, decisionSource: 'ai' })).toBeNull();
    expect(suggestFromApproval(RULES, TEXT, { ...CHAIR, checks: [...CHAIR.checks, check('restricted_goods', 'block')] })).toBeNull();
    expect(suggestFromApproval({ ...RULES, hardMax: 80 }, TEXT, CHAIR)).toBeNull();
    expect(suggestFromApproval(RULES, TEXT, { ...CHAIR, checks: [check('weekly_budget', 'ask'), check('auto_limit', 'approve')] })).toBeNull();
    const overBudgetToo = suggestFromApproval(RULES, TEXT, { ...CHAIR, checks: [...CHAIR.checks, check('weekly_budget', 'ask')] });
    expect(overBudgetToo?.rules.autoApproveMax).toBe(90);
    expect(overBudgetToo?.rules.weeklyBudget).toBe(RULES.weeklyBudget);
  });

  it('rounds the new limit to a figure the owner would choose', () => {
    expect([roundLimit(89), roundLimit(100), roundLimit(120), roundLimit(249), roundLimit(1180)]).toEqual([90, 100, 150, 250, 1200]);
  });
});
