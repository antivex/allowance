import { useEffect, useState } from 'react';
import { api } from '../api';
import { STATUS_TONE, formatDateTime, formatMoney, formatTime, timeLeft } from '../format';
import { CATEGORY_LABELS, type PayPalCheckResult, type Purchase, type PurchaseEvent } from '../types';
import { SourceTag, Spinner, StatusPill } from './ui';

interface Props {
  purchase: Purchase;
  now: number;
  onClose: () => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

const ICON = { approve: '✓', ask: '!', block: '✕' } as const;

/** Asks PayPal itself, through its Agent Toolkit, what happened to this order, and compares it with the ledger. */
function PayPalCheckRow({ purchaseId }: { purchaseId: string }) {
  const [result, setResult] = useState<PayPalCheckResult | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setWorking(true);
    setError(null);
    try {
      setResult(await api.paypalCheck(purchaseId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'PayPal did not answer.');
    } finally {
      setWorking(false);
    }
  };

  const found = result?.check;
  return (
    <div className="paypal-check">
      <button type="button" className="btn small" onClick={() => void check()} disabled={working}>
        {working ? <Spinner /> : '⟳'} Check on PayPal
      </button>
      {found && (
        <div className={`notice ${found.matches ? 'ok' : 'bad'}`}>
          <strong>{found.matches ? '✓ Matches the ledger.' : '✕ Does not match the ledger.'}</strong> PayPal says: {found.paypal}.
          {!found.matches && found.expected ? ` The ledger expects ${found.expected}.` : ''}
          <div className="paypal-check-meta">
            Read {result?.checkedAt ? formatTime(result.checkedAt) : ''} with PayPal's Agent Toolkit (get_order).
          </div>
        </div>
      )}
      {result && !found && <div className="notice">{result.reason}</div>}
      {error && <div className="notice bad">{error}</div>}
    </div>
  );
}

export function PurchaseDrawer({ purchase, now, onClose, onApprove, onDeny }: Props) {
  const [events, setEvents] = useState<PurchaseEvent[]>([]);
  const [cartMandate, setCartMandate] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const money = (cents: number) => formatMoney(cents, purchase.currency);

  useEffect(() => {
    let alive = true;
    api
      .purchase(purchase.id)
      .then((detail) => {
        if (!alive) return;
        setEvents(detail.events);
        setCartMandate(detail.cartMandate ?? null);
      })
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [purchase.id, purchase.updatedAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tone = STATUS_TONE[purchase.status];
  const ai = purchase.ai;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Purchase at ${purchase.merchant}`}>
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <h2>
              {money(purchase.amountCents)} · {purchase.merchant}
            </h2>
            <div className="row">
              <StatusPill status={purchase.status} />
              <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                {purchase.agentName} · {formatDateTime(purchase.createdAt)}
              </span>
            </div>
          </div>
          <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">
          <div className={`why-box ${tone === 'info' ? 'neutral' : tone}`}>
            <SourceTag source={purchase.decisionSource} decision={purchase.decision} /> {purchase.explanation}
          </div>

          {purchase.status === 'on_hold' && (
            <div className="row">
              <button type="button" className="btn approve" onClick={() => onApprove(purchase.id)}>
                ✓ Approve & capture
              </button>
              <button type="button" className="btn deny" onClick={() => onDeny(purchase.id)}>
                ✕ Deny & void
              </button>
              {purchase.holdExpiresAt && <span style={{ color: 'var(--muted)' }}>Auto-void in {timeLeft(purchase.holdExpiresAt, now)}</span>}
            </div>
          )}

          <section>
            <h3>What the agent asked for</h3>
            <div className="reason" style={{ marginBottom: 10 }}>
              “{purchase.reason}”
            </div>
            <table className="items">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="num">Qty</th>
                  <th className="num">Price</th>
                </tr>
              </thead>
              <tbody>
                {purchase.items.map((item, index) => (
                  <tr key={index}>
                    <td>{item.name}</td>
                    <td>{CATEGORY_LABELS[item.category]}</td>
                    <td className="num">{item.quantity}</td>
                    <td className="num">{money(item.unitPriceCents * item.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(purchase.sourceUrl || purchase.merchantUrl) && (
              <dl className="kv" style={{ marginTop: 10 }}>
                {purchase.merchantUrl && (
                  <>
                    <dt>Merchant site</dt>
                    <dd className="mono">{purchase.merchantUrl}</dd>
                  </>
                )}
                {purchase.sourceUrl && (
                  <>
                    <dt>Found on page</dt>
                    <dd className="mono">{purchase.sourceUrl}</dd>
                  </>
                )}
              </dl>
            )}
          </section>

          <section>
            <h3>Rules check · {purchase.policyDecision}</h3>
            <ul className="checks">
              {purchase.checks.map((check) => (
                <li key={check.id}>
                  <span className={`check-icon ${check.outcome}`}>{ICON[check.outcome]}</span>
                  <span className="label">{check.label}</span>
                  <span className="detail">{check.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3>AI review</h3>
            {ai.status === 'ok' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="row">
                  <span className={`pill ${ai.review.verdict === 'approve' ? 'ok' : ai.review.verdict === 'ask' ? 'warn' : 'bad'}`}>
                    Verdict: {ai.review.verdict}
                  </span>
                  <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
                    {ai.review.model} · {ai.review.latencyMs} ms
                  </span>
                </div>
                <div>{ai.review.explanation}</div>
                {ai.review.redFlags.length > 0 && (
                  <div className="row">
                    {ai.review.redFlags.map((flag) => (
                      <span className="flag" key={flag}>
                        {flag}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>The AI review can only make a decision stricter, never looser.</div>
              </div>
            )}
            {ai.status === 'failed' && (
              <div className="notice warn">
                {ai.model} did not answer ({ai.error}). {purchase.decisionSource === 'ai_unavailable' ? 'So the purchase waits for you.' : ''}
              </div>
            )}
            {ai.status === 'skipped' && <div style={{ color: 'var(--muted)' }}>Skipped: {ai.reason}</div>}
          </section>

          <section>
            <h3>PayPal {purchase.paypalMode === 'simulated' ? '(simulated)' : 'sandbox'}</h3>
            {purchase.paypalOrderId ? (
              <dl className="kv">
                <dt>Order</dt>
                <dd className="mono">
                  {purchase.paypalOrderId} · {purchase.paypalOrderStatus}
                </dd>
                {purchase.paypalAuthorizationId && (
                  <>
                    <dt>Authorization</dt>
                    <dd className="mono">{purchase.paypalAuthorizationId}</dd>
                  </>
                )}
                {purchase.paypalCaptureId && (
                  <>
                    <dt>Capture</dt>
                    <dd className="mono">{purchase.paypalCaptureId}</dd>
                  </>
                )}
                <dt>Status</dt>
                <dd>{purchase.paypalStatus ?? '—'}</dd>
                {purchase.settledBy && (
                  <>
                    <dt>Settled by</dt>
                    <dd>
                      {purchase.settledBy} {purchase.settledAt ? `at ${formatTime(purchase.settledAt)}` : ''}
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              <div style={{ color: 'var(--muted)' }}>{purchase.status === 'blocked' ? 'No PayPal order was created.' : 'Nothing was sent to PayPal.'}</div>
            )}
            {purchase.paypalOrderId && purchase.paypalMode === 'sandbox' && <PayPalCheckRow key={purchase.updatedAt} purchaseId={purchase.id} />}
            {cartMandate && (
              <div className="notice ok mandate-row">
                <strong>✓ Signed cart.</strong> This exact cart, signed by your Allowance (Ed25519): the agent can show it to the merchant,
                and anyone can check it against <code>/.well-known/jwks.json</code>. Its id is the PayPal order's invoice id.
                <div className="mandate-actions">
                  <code className="mandate-jws">{cartMandate.slice(0, 42)}…</code>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      void navigator.clipboard?.writeText(cartMandate).then(() => setCopied(true));
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
            {purchase.error && (
              <div className="notice bad" style={{ marginTop: 8 }}>
                {purchase.error}
              </div>
            )}
          </section>

          <section>
            <h3>Audit trail</h3>
            <ol className="timeline">
              {events.map((event) => (
                <li key={event.id}>
                  <time>{formatTime(event.at)}</time>
                  <span className="kind">{event.kind}</span>
                  {event.detail}
                </li>
              ))}
            </ol>
          </section>
          <div className="mono" style={{ color: 'var(--muted)' }}>
            {purchase.id}
          </div>
        </div>
      </aside>
    </>
  );
}
