import { isStricter, type Decision, type PolicyResult } from './types.js';

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

export type DecisionSource = 'rules' | 'ai' | 'ai_unavailable';

export interface FinalDecision {
  decision: Decision;
  source: DecisionSource;
  explanation: string;
}

/** When the AI review fails: 'ask' turns an approval into a question for the owner, 'keep' trusts the rules. */
export type AiFailureMode = 'ask' | 'keep';

/**
 * Merges the deterministic result with the AI review.
 * Invariant: the result is never looser than the deterministic decision, whatever the model says.
 */
export function combine(policy: PolicyResult, ai: AiOutcome, onFailure: AiFailureMode): FinalDecision {
  if (ai.status === 'ok' && isStricter(ai.review.verdict, policy.decision)) {
    return { decision: ai.review.verdict, source: 'ai', explanation: ai.review.explanation };
  }
  if (ai.status === 'failed' && onFailure === 'ask' && policy.decision === 'approve') {
    return {
      decision: 'ask',
      source: 'ai_unavailable',
      explanation: `The AI review did not answer, so this waits for you. ${policy.explanation}`,
    };
  }
  return { decision: policy.decision, source: 'rules', explanation: policy.explanation };
}
