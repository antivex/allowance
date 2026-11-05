import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, SIGNED_OUT, owner } from '../api';
import { Logo, Spinner } from './ui';

type Step = 'loading' | 'setup' | 'login' | 'in' | 'offline';

const MIN_LENGTH = 8;

/**
 * Nothing of the dashboard shows until the owner signs in. Agents hold a token for the MCP endpoint only: approving,
 * denying, rules, agents and the PayPal link all need this password. The first password is chosen through the one-time
 * link that `npm start` prints in its terminal.
 */
export function OwnerGate({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<Step>('loading');
  const [code] = useState(() => new URLSearchParams(window.location.search).get('setup'));
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    owner
      .status()
      .then((status) => setStep(status.signedIn ? 'in' : status.passwordSet ? 'login' : 'setup'))
      .catch(() => setStep('offline'));
    const signedOut = () => setStep('login');
    window.addEventListener(SIGNED_OUT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT, signedOut);
  }, []);

  const enter = () => {
    // The one-time code has done its job: keep it out of the address bar and the history.
    if (code) window.history.replaceState(null, '', window.location.pathname);
    setPassword('');
    setAgain('');
    setError(null);
    setStep('in');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step === 'setup' && password !== again) {
      setError('The two passwords are different.');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      if (step === 'setup') await owner.setup(code ?? '', password);
      else await owner.login(password);
      enter();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Cannot reach the Allowance server.');
    } finally {
      setWorking(false);
    }
  };

  if (step === 'in') return <>{children}</>;
  if (step === 'loading') return <div className="app"><div className="empty">Loading Allowance…</div></div>;

  return (
    <div className="gate">
      <form className="card gate-card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <div className="brand-mark">
            <Logo />
          </div>
          <div>
            <h1>Allowance</h1>
            <p>Give your AI agent an allowance, not your wallet.</p>
          </div>
        </div>
        {step === 'offline' && <p className="gate-text">Cannot reach the Allowance server. Is it running (npm start)?</p>}
        {step === 'setup' && !code && (
          <p className="gate-text">
            <strong>First run.</strong> Open the link that Allowance printed in its terminal when it started: only whoever
            runs Allowance can choose the owner password.
          </p>
        )}
        {(step === 'login' || (step === 'setup' && code)) && (
          <>
            <h2>{step === 'setup' ? 'Choose the owner password' : 'Owner sign-in'}</h2>
            <p className="gate-text">
              Approving, denying and changing the rules need this password. Your agents never get it: they only have their
              own token for the MCP endpoint.
            </p>
            <label className="gate-field">
              <span>{step === 'setup' ? `Password, at least ${MIN_LENGTH} characters` : 'Password'}</span>
              <input
                className="input"
                type="password"
                autoComplete={step === 'setup' ? 'new-password' : 'current-password'}
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {step === 'setup' && (
              <label className="gate-field">
                <span>The same password again</span>
                <input className="input" type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
              </label>
            )}
            {error && <p className="gate-error">{error}</p>}
            <button type="submit" className="btn primary" disabled={working || password.length === 0}>
              {working ? <Spinner /> : null} {step === 'setup' ? 'Set password and open the dashboard' : 'Sign in'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
