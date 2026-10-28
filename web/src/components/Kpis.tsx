import { formatMoney } from '../format';
import type { Budget } from '../types';

export function Kpis({ budget, paidCount }: { budget: Budget; paidCount: number }) {
  const money = (cents: number) => formatMoney(cents, budget.currency);
  const total = budget.weeklyBudgetCents;
  const paidPct = total ? Math.min(100, (budget.paidCents / total) * 100) : 0;
  const heldPct = total ? Math.min(100 - paidPct, (budget.heldCents / total) * 100) : 0;
  const left = budget.leftCents;
  // Holds the owner may still approve can push the week past the budget.
  const over = left !== null && left < 0;
  const resets = new Date(budget.weekEnd).toLocaleDateString('en-US', { weekday: 'long' });

  return (
    <div className="kpis">
      <div className={`card kpi ${over ? 'bad' : ''}`}>
        <div className="label">{over ? 'Over budget this week' : 'Left this week'}</div>
        {total === null ? (
          <>
            <div className="value">No cap</div>
            <div className="hint">Set a weekly budget in Rules.</div>
          </>
        ) : (
          <>
            <div className="value">
              {money(Math.abs(left ?? 0))} <small>{over ? `beyond ${money(total)}` : `of ${money(total)}`}</small>
            </div>
            <div
              className="budget-bar"
              role="img"
              aria-label={`${money(budget.paidCents)} paid and ${money(budget.heldCents)} on hold of ${money(total)}`}
            >
              <div className="paid" style={{ width: `${paidPct}%` }} />
              <div className="held" style={{ width: `${heldPct}%` }} />
            </div>
            <div className="legend">
              <span>
                <i style={{ background: 'var(--brand)' }} />
                Paid {money(budget.paidCents)}
              </span>
              <span>
                <i style={{ background: 'var(--warn)' }} />
                On hold {money(budget.heldCents)}
              </span>
              <span>Resets {resets}</span>
            </div>
          </>
        )}
      </div>
      <div className="card kpi">
        <div className="label">Paid this week</div>
        <div className="value">{money(budget.paidCents)}</div>
        <div className="hint">
          {paidCount} purchase{paidCount === 1 ? '' : 's'} captured by PayPal
        </div>
      </div>
      <div className={`card kpi ${budget.waitingCount ? 'warn' : ''}`}>
        <div className="label">Waiting for you</div>
        <div className="value">{budget.waitingCount}</div>
        <div className="hint">{money(budget.heldCents)} held by PayPal, not charged</div>
      </div>
      <div className={`card kpi ${budget.blockedThisWeek ? 'bad' : ''}`}>
        <div className="label">Blocked this week</div>
        <div className="value">{budget.blockedThisWeek}</div>
        <div className="hint">No PayPal order was created</div>
      </div>
    </div>
  );
}
