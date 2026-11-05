import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, SIGNED_OUT, api, owner } from './api';
import { ApprovalCards } from './components/ApprovalCards';
import { Kpis } from './components/Kpis';
import { Ledger, type LedgerContext } from './components/Ledger';
import { PurchaseDrawer } from './components/PurchaseDrawer';
import { RulesPage } from './components/RulesPage';
import { SetupPage } from './components/SetupPage';
import { Logo, PayPalWord } from './components/ui';
import { formatMoney } from './format';
import type { AppState, Purchase, RuleSuggestion } from './types';

// AG Studio is most of the bundle's weight: it loads only when the Insights tab opens.
const Insights = lazy(() => import('./components/Insights').then((module) => ({ default: module.Insights })));

type Tab = 'ledger' | 'insights' | 'rules' | 'setup';
interface Toast {
  id: number;
  message: string;
  tone?: 'bad';
}

function startOfWeek(now: Date): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start.getTime();
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [rows, setRows] = useState<Purchase[]>([]);
  const [tab, setTab] = useState<Tab>('ledger');
  const [openId, setOpenId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<RuleSuggestion | null>(null);
  const [learning, setLearning] = useState(false);
  const loaded = useRef(false);
  const toastId = useRef(0);
  // Messages name the simulated gateway as such, so the offline mode never claims that PayPal moved money.
  const paypalName = useRef('simulated PayPal');
  paypalName.current = state?.mode === 'sandbox' ? 'PayPal' : 'simulated PayPal';

  const notify = useCallback((message: string, tone?: 'bad') => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-2), { id, message, tone }]);
    setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), tone === 'bad' ? 7000 : 4500);
  }, []);

  const refreshState = useCallback(async () => {
    try {
      setState(await api.state());
      setLoadError(null);
    } catch {
      setLoadError('Cannot reach the Allowance server. Is it running?');
    }
  }, []);

  // First load, then live updates over server-sent events.
  useEffect(() => {
    void refreshState();
    api
      .purchases()
      .then((list) => {
        setRows(list);
        loaded.current = true;
      })
      .catch(() => setLoadError('Cannot reach the Allowance server. Is it running?'));

    let stateTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(stateTimer);
      stateTimer = setTimeout(() => void refreshState(), 150);
    };
    const source = new EventSource('/api/events');
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.addEventListener('purchase', (event) => {
      const { purchase } = JSON.parse((event as MessageEvent<string>).data) as { purchase: Purchase };
      setRows((list) => {
        const index = list.findIndex((row) => row.id === purchase.id);
        if (index === -1) return [purchase, ...list];
        const next = list.slice();
        next[index] = purchase;
        return next;
      });
      refreshSoon();
    });
    source.addEventListener('state', refreshSoon);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      source.close();
      clearInterval(tick);
      clearTimeout(stateTimer);
    };
  }, [refreshState]);

  // Toast when a purchase starts waiting for the owner.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const row of rows) {
      if (row.status !== 'on_hold' || announced.current.has(row.id)) continue;
      announced.current.add(row.id);
      if (loaded.current && Date.now() - new Date(row.createdAt).getTime() < 60_000) {
        notify(`${row.agentName} wants to pay ${formatMoney(row.amountCents, row.currency)} at ${row.merchant}: waiting for you.`);
      }
    }
  }, [rows, notify]);

  // Back from PayPal after linking the wallet.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paypal = params.get('paypal');
    if (!paypal) return;
    setTab('setup');
    if (paypal === 'linked') notify('PayPal linked. Your agents can now pay within your rules.');
    if (paypal === 'cancelled') notify('PayPal linking was cancelled.');
    if (paypal === 'error') notify('PayPal linking failed: see the PayPal card for details.', 'bad');
    window.history.replaceState(null, '', window.location.pathname);
  }, [notify]);

  const settle = useCallback(
    async (id: string, action: 'approve' | 'deny') => {
      setBusy((set) => new Set(set).add(id));
      try {
        const purchase = action === 'approve' ? await api.approve(id) : await api.deny(id);
        const amount = formatMoney(purchase.amountCents, purchase.currency);
        const who = paypalName.current;
        notify(action === 'approve' ? `Approved: ${who} captured ${amount}.` : `Denied: ${who} voided the ${amount} hold. Nothing was charged.`);
        // An approval can teach the rules something: ask, never change them silently.
        if (action === 'approve') {
          api
            .suggestion(id)
            .then((result) => result.suggestion && setSuggestion(result.suggestion))
            .catch(() => undefined);
        }
      } catch (error) {
        notify(error instanceof ApiError ? error.message : 'PayPal did not answer.', 'bad');
      } finally {
        setBusy((set) => {
          const next = new Set(set);
          next.delete(id);
          return next;
        });
      }
    },
    [notify],
  );

  const context = useMemo<LedgerContext>(
    () => ({ approve: (id) => void settle(id, 'approve'), deny: (id) => void settle(id, 'deny'), now }),
    [settle, now],
  );

  const learn = async () => {
    if (!suggestion) return;
    setLearning(true);
    try {
      await api.saveRules(suggestion.text, suggestion.rules, 'learned from your approval');
      notify('Rules updated. Agents follow them from the next purchase.');
      setSuggestion(null);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'The rules were not saved.', 'bad');
    } finally {
      setLearning(false);
    }
  };

  const waiting = rows.filter((row) => row.status === 'on_hold' || row.status === 'settling');
  const weekStart = startOfWeek(new Date(now));
  const paidCount = rows.filter((row) => row.status === 'paid' && new Date(row.createdAt).getTime() >= weekStart).length;
  const open = openId ? rows.find((row) => row.id === openId) : undefined;

  if (!state) {
    return (
      <div className="app">
        <div className="empty">{loadError ?? 'Loading Allowance…'}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Logo />
          </div>
          <div>
            <h1>Allowance</h1>
            <p>Give your AI agent an allowance, not your wallet.</p>
          </div>
        </div>
        <div className="chips">
          <span className="chip" title={state.wallet.payerEmail ?? undefined}>
            <span className={`dot ${state.wallet.linked ? (state.mode === 'sandbox' ? 'ok' : 'warn') : 'bad'}`} />
            <PayPalWord /> <strong>{state.mode === 'sandbox' ? 'Sandbox' : 'Simulated'}</strong>
            {state.wallet.linked ? '· linked' : '· not linked'}
          </span>
          <span className="chip" title={state.ai.detail}>
            <span className={`dot ${state.ai.ok ? 'ok' : 'bad'}`} />
            AI review <strong>{state.ai.enabled ? state.ai.model : 'off'}</strong>
          </span>
          <span className="chip">
            <span className={`dot ${live ? 'live' : 'bad'}`} />
            {live ? 'Live' : 'Reconnecting…'}
          </span>
          <button
            type="button"
            className="chip chip-button"
            title="Sign out: approving and changing rules need the owner password again"
            onClick={() => void owner.logout().finally(() => window.dispatchEvent(new Event(SIGNED_OUT)))}
          >
            Lock
          </button>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'ledger'} className={`tab ${tab === 'ledger' ? 'active' : ''}`} onClick={() => setTab('ledger')}>
          Ledger {waiting.length > 0 && <span className="count">{waiting.length}</span>}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'insights'} className={`tab ${tab === 'insights' ? 'active' : ''}`} onClick={() => setTab('insights')}>
          Insights
        </button>
        <button type="button" role="tab" aria-selected={tab === 'rules'} className={`tab ${tab === 'rules' ? 'active' : ''}`} onClick={() => setTab('rules')}>
          Rules
        </button>
        <button type="button" role="tab" aria-selected={tab === 'setup'} className={`tab ${tab === 'setup' ? 'active' : ''}`} onClick={() => setTab('setup')}>
          Agents & setup
        </button>
      </nav>

      {tab === 'ledger' && (
        <div className="ledger-tab">
          {!state.rules && (
            <div className="banner warn">
              <span className="grow">
                <strong>No rules confirmed yet.</strong> Until you confirm them, every purchase waits for you.
              </span>
              <button type="button" className="btn primary small" onClick={() => setTab('rules')}>
                Set rules
              </button>
            </div>
          )}
          {state.mode === 'sandbox' && !state.wallet.linked && (
            <div className="banner warn">
              <span className="grow">
                <strong>PayPal is not linked.</strong> Agents cannot pay until you link your sandbox PayPal account.
              </span>
              <button type="button" className="btn paypal small" onClick={() => setTab('setup')}>
                Link <PayPalWord />
              </button>
            </div>
          )}
          <Kpis budget={state.budget} paidCount={paidCount} simulated={state.mode !== 'sandbox'} />
          {suggestion && (
            <div className="banner learn" role="status">
              <span className="learn-mark">✦</span>
              <span className="grow">
                <strong>Learn from this approval?</strong> {suggestion.summary}
              </span>
              <button type="button" className="btn primary small" disabled={learning} onClick={() => void learn()}>
                Add to my rules
              </button>
              <button type="button" className="btn ghost small" onClick={() => setSuggestion(null)}>
                Not now
              </button>
            </div>
          )}
          {/* On a phone the cards come first: deciding is what the owner opens it for. */}
          <div className="approvals-block">
            <ApprovalCards
              purchases={waiting}
              busy={busy}
              now={now}
              simulated={state.mode !== 'sandbox'}
              onApprove={(id) => void settle(id, 'approve')}
              onDeny={(id) => void settle(id, 'deny')}
              onOpen={setOpenId}
            />
          </div>
          <div className="section-title">
            <h2>Ledger</h2>
            <span>Every request from every agent: the decision, why, and what PayPal did. Click a row for the full trail.</span>
          </div>
          <Ledger rows={rows} context={context} onOpen={setOpenId} />
        </div>
      )}
      {tab === 'rules' && <RulesPage key={state.rules?.id ?? 'none'} state={state} notify={notify} />}
      {tab === 'insights' && (
        <Suspense fallback={<div className="empty">Loading insights…</div>}>
          <Insights rows={rows} currency={state.currency} />
        </Suspense>
      )}
      {tab === 'setup' && <SetupPage state={state} notify={notify} />}

      <footer className="footer">
        <span>
          Allowance {state.version} · MIT · built by antivex for the PayPal AI Hackathon
        </span>
        <span>{state.mode === 'sandbox' ? 'PayPal sandbox: no real money moves.' : 'Offline simulation: nothing is sent to PayPal.'}</span>
      </footer>

      {open && (
        <PurchaseDrawer
          purchase={open}
          now={now}
          onClose={() => setOpenId(null)}
          onApprove={(id) => void settle(id, 'approve')}
          onDeny={(id) => void settle(id, 'deny')}
        />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone ?? ''}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
