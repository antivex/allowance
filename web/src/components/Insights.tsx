import { AgStudio } from 'ag-studio-react';
import { useMemo } from 'react';
import { CATEGORY_LABELS, type Purchase } from '../types';

/** One flat row per purchase request: the shape AG Studio works with. */
function toRow(purchase: Purchase) {
  return {
    time: purchase.createdAt,
    agent: purchase.agentName,
    merchant: purchase.merchant,
    category: CATEGORY_LABELS[purchase.items[0]?.category ?? 'other'],
    amount: purchase.amountCents / 100,
    status: purchase.status,
    decision: purchase.decision,
    decidedBy: purchase.decisionSource,
    explanation: purchase.explanation,
  };
}

export function Insights({ rows }: { rows: Purchase[] }) {
  const data = useMemo(() => ({ sources: [{ id: 'requests', data: rows.map(toRow) }] }), [rows]);
  return (
    <div className="card insights">
      <AgStudio data={data} mode="edit" />
    </div>
  );
}
