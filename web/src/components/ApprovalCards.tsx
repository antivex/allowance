import { formatMoney, timeLeft } from '../format';
import type { Purchase } from '../types';
import { SourceTag, Spinner } from './ui';

interface Props {
  purchases: Purchase[];
  busy: Set<string>;
  now: number;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onOpen: (id: string) => void;
}

export function ApprovalCards({ purchases, busy, now, onApprove, onDeny, onOpen }: Props) {
  if (purchases.length === 0) return null;
  return (
    <>
      <div className="section-title">
        <h2>Waiting for you</h2>
        <span>PayPal is holding the money. Approve to capture it, deny to void the hold.</span>
      </div>
      <div className="approvals">
        {purchases.map((purchase) => {
          const working = busy.has(purchase.id) || purchase.status === 'settling';
          const items = purchase.items.map((item) => `${item.quantity} × ${item.name}`).join(', ');
          return (
            <article className="card approval" key={purchase.id} aria-label={`Approval for ${purchase.merchant}`}>
              <div className="approval-head">
                <div>
                  <div className="merchant">{purchase.merchant}</div>
                  <div className="agent">
                    {purchase.agentName} · {items}
                  </div>
                </div>
                <div className="amount">{formatMoney(purchase.amountCents, purchase.currency)}</div>
              </div>
              <div className="why">
                <SourceTag source={purchase.decisionSource} decision={purchase.decision} /> {purchase.explanation}
              </div>
              <div className="reason">“{purchase.reason}”</div>
              <div className="meta">
                <span>
                  Auto-void in <strong>{purchase.holdExpiresAt ? timeLeft(purchase.holdExpiresAt, now) : '—'}</strong>
                </span>
                <button type="button" className="btn ghost small" onClick={() => onOpen(purchase.id)}>
                  Details
                </button>
              </div>
              <div className="actions">
                <button type="button" className="btn approve" disabled={working} onClick={() => onApprove(purchase.id)}>
                  {working ? <Spinner /> : '✓'} Approve & capture
                </button>
                <button type="button" className="btn deny" disabled={working} onClick={() => onDeny(purchase.id)}>
                  ✕ Deny & void
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
