import { useState } from 'react';
import { ApiError, api } from '../api';
import { formatDateTime } from '../format';
import type { AppState } from '../types';
import { CopyButton, PayPalWord, Pill, Spinner } from './ui';

interface Props {
  state: AppState;
  notify: (message: string, tone?: 'bad') => void;
}

function snippets(state: AppState, token: string) {
  const desktop = JSON.stringify(
    {
      mcpServers: {
        allowance: {
          command: state.mcp.nodePath,
          args: [state.mcp.stdioEntry],
          env: { ALLOWANCE_URL: state.mcp.serverUrl, ALLOWANCE_AGENT_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
  const claudeCode = `claude mcp add --transport http allowance ${state.mcp.httpUrl} --header "Authorization: Bearer ${token}"`;
  const body = JSON.stringify({
    merchant: 'Inkwell Supplies',
    items: [{ name: 'Sticky notes', quantity: 1, unit_price: 6.5, category: 'office_supplies' }],
    amount: 6.5,
    reason: 'Testing Allowance from the command line.',
  });
  const curl = `curl -X POST ${state.mcp.serverUrl}/api/agent/purchases -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '${body}'`;
  return { desktop, claudeCode, curl };
}

export function SetupPage({ state, notify }: Props) {
  const [linking, setLinking] = useState(false);
  const [name, setName] = useState('Claude Desktop');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const wallet = state.wallet;

  const link = async () => {
    setLinking(true);
    try {
      const { approveUrl } = await api.linkPayPal();
      window.location.assign(approveUrl);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'PayPal did not answer.', 'bad');
      setLinking(false);
    }
  };

  const unlink = async () => {
    try {
      await api.unlinkPayPal();
      notify('PayPal unlinked. Agents cannot pay until you link it again.');
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not unlink.', 'bad');
    }
  };

  const createAgent = async () => {
    setCreating(true);
    try {
      const result = await api.createAgent(name);
      setCreated({ name: result.agent.name, token: result.token });
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'Could not create the agent.', 'bad');
    } finally {
      setCreating(false);
    }
  };

  const shown = snippets(state, created?.token ?? '<agent token>');

  return (
    <div className="setup-grid">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <section className="card card-pad">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>
              <PayPalWord /> wallet
            </h2>
            {state.mode === 'sandbox' ? <Pill tone="info">Sandbox</Pill> : <Pill tone="warn">Simulated, no credentials</Pill>}
          </div>
          {state.mode === 'simulated' && (
            <div className="notice warn" style={{ margin: '10px 0' }}>
              No PayPal credentials in <code>.env</code>, so payments are simulated offline. Add a sandbox app's
              <code> PAYPAL_CLIENT_ID</code> and <code>PAYPAL_CLIENT_SECRET</code> and restart to use the real PayPal sandbox.
            </div>
          )}
          <p className="sub" style={{ marginTop: 10 }}>
            You link your PayPal once. PayPal stores it (Vault) and gives Allowance a token. Allowance never sees card or bank details, and
            agents never see the token: they can only ask Allowance to pay.
          </p>
          {wallet.linked ? (
            <div className="row">
              <Pill tone="ok">Linked</Pill>
              <span>{wallet.payerEmail ?? 'PayPal account'}</span>
              <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{wallet.linkedAt ? `since ${formatDateTime(wallet.linkedAt)}` : ''}</span>
              <span className="spacer" />
              <button type="button" className="btn small" onClick={() => void unlink()}>
                Unlink
              </button>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="btn paypal" onClick={() => void link()} disabled={linking}>
                {linking ? <Spinner /> : null}
                Link <PayPalWord />
              </button>
              <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>Opens PayPal; sign in with your sandbox personal account and agree.</span>
            </div>
          )}
          {wallet.lastError && (
            <div className="notice bad" style={{ marginTop: 10 }}>
              {wallet.lastError}
            </div>
          )}
          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Approved</dt>
            <dd>Order with intent CAPTURE from the linked wallet: paid at once.</dd>
            <dt>Ask the owner</dt>
            <dd>Order with intent AUTHORIZE: money held, not taken. Approve captures it; deny or {Math.round(state.holdMinutes / 60)} h without an answer voids it.</dd>
            <dt>Blocked</dt>
            <dd>No PayPal order at all.</dd>
          </dl>
        </section>

        <section className="card card-pad">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>AI review</h2>
            {state.ai.ok ? <Pill tone="ok">Ready</Pill> : <Pill tone={state.ai.enabled ? 'bad' : 'neutral'}>{state.ai.enabled ? 'Not reachable' : 'Off'}</Pill>}
          </div>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Model</dt>
            <dd className="mono">{state.ai.model}</dd>
            <dt>Endpoint</dt>
            <dd className="mono">{state.ai.baseUrl}</dd>
            <dt>Status</dt>
            <dd>{state.ai.detail}</dd>
            <dt>If it fails</dt>
            <dd>{state.ai.onFailure === 'ask' ? 'Purchases the rules would pay wait for you instead.' : 'The rules decide alone.'}</dd>
          </dl>
          <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>
            Any OpenAI-compatible endpoint works: Ollama (default, local and free), LM Studio, vLLM or a hosted provider. Set
            <code> AI_BASE_URL</code>, <code>AI_MODEL</code> and <code>AI_API_KEY</code> in <code>.env</code>.
          </p>
        </section>
      </div>

      <section className="card card-pad">
        <h2>Agents</h2>
        <p className="sub">Each agent gets its own token, so the ledger shows who asked for what. Revoke a token to cut an agent off.</p>
        {state.agents.map((agent) => (
          <div className="agent-row" key={agent.id}>
            <div style={{ flex: 1 }}>
              <div className="name">{agent.name}</div>
              <div className="meta">
                token …{agent.tokenHint} · added {formatDateTime(agent.createdAt)}
              </div>
            </div>
            <button
              type="button"
              className="btn small deny"
              onClick={() => {
                if (window.confirm(`Revoke ${agent.name}? It will not be able to request purchases any more.`)) {
                  api
                    .revokeAgent(agent.id)
                    .then(() => notify(`${agent.name} revoked.`))
                    .catch(() => notify('Could not revoke.', 'bad'));
                }
              }}
            >
              Revoke
            </button>
          </div>
        ))}
        <div className="row" style={{ marginTop: 14 }}>
          <input className="input" style={{ maxWidth: 260 }} value={name} onChange={(event) => setName(event.target.value)} aria-label="New agent name" />
          <button type="button" className="btn primary" onClick={() => void createAgent()} disabled={creating || !name.trim()}>
            Add agent
          </button>
        </div>
        {created && (
          <div className="token-box">
            <strong>{created.name}</strong>: this token is shown once. Paste it into the agent's configuration below.
            <div className="snippet" style={{ marginBottom: 0 }}>
              {created.token}
              <CopyButton text={created.token} className="btn small copy" />
            </div>
          </div>
        )}

        <h3 style={{ marginTop: 18 }}>Claude Desktop</h3>
        <p className="sub" style={{ margin: 0 }}>
          Settings → Developer → Edit config, add this to <code>claude_desktop_config.json</code>, restart Claude. Allowance must be running.
        </p>
        <div className="snippet">
          {shown.desktop}
          <CopyButton text={shown.desktop} className="btn small copy" />
        </div>

        <h3>Claude Code, Cursor or any MCP client (HTTP)</h3>
        <div className="snippet">
          {shown.claudeCode}
          <CopyButton text={shown.claudeCode} className="btn small copy" />
        </div>

        <h3>Plain HTTP</h3>
        <div className="snippet">
          {shown.curl}
          <CopyButton text={shown.curl} className="btn small copy" />
        </div>
        {state.shopUrl && (
          <p className="sub" style={{ marginBottom: 0 }}>
            Demo shop for testing agents: <a href={state.shopUrl}>{state.shopUrl}</a> (one product page hides a prompt injection).
          </p>
        )}
      </section>
    </div>
  );
}
