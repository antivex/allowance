/**
 * Runs Allowance's whole PayPal path against the real sandbox and writes docs/SANDBOX_PROOF.md with what PayPal
 * returned: a purchase paid at once (intent CAPTURE), a blocked one (no order), a held one the owner approves
 * (AUTHORIZE, then capture) and a held one the owner denies (AUTHORIZE, then void).
 * Needs Allowance running with sandbox credentials, a linked PayPal wallet and confirmed rules. It plays the owner, so it
 * signs in with the owner password from ALLOWANCE_OWNER_PASSWORD.
 * Usage: ALLOWANCE_OWNER_PASSWORD=... npm run proof:sandbox
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.ALLOWANCE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const SHOP = 'http://localhost:4100';

interface Outcome {
  request_id: string;
  status: string;
  decision: string;
  decided_by: string;
  explanation: string;
  amount: string;
  currency: string;
  paypal: { mode: string; order_id: string | null; capture_id: string | null; authorization_id: string | null; status: string | null } | null;
}

interface Purchase {
  id: string;
  status: string;
  paypalMode: string | null;
  paypalOrderId: string | null;
  paypalOrderStatus: string | null;
  paypalAuthorizationId: string | null;
  paypalCaptureId: string | null;
  paypalStatus: string | null;
  settledBy: string | null;
  createdAt: string;
}

function token(): string {
  if (process.env.ALLOWANCE_AGENT_TOKEN) return process.env.ALLOWANCE_AGENT_TOKEN.trim();
  const file = fileURLToPath(new URL('../data/demo-agent.token', import.meta.url));
  if (!existsSync(file)) throw new Error('No demo agent token in data/demo-agent.token: start Allowance once.');
  return readFileSync(file, 'utf8').trim();
}

/** The owner's session cookie: approving and denying need the owner password, like in the dashboard. */
let ownerCookie = '';

async function call<T>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token()}` } : { Cookie: ownerCookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

const password = process.env.ALLOWANCE_OWNER_PASSWORD;
if (!password) throw new Error('Set ALLOWANCE_OWNER_PASSWORD to the owner password: this script approves and denies like the owner.');
const login = await fetch(`${BASE}/api/owner/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
if (!login.ok) throw new Error(`Owner sign-in failed (${login.status}): ${await login.text()}`);
ownerCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

const state = await call<{ mode: string; currency: string; wallet: { linked: boolean; payerEmail: string | null }; rules: unknown }>('GET', '/api/state');
if (state.mode !== 'sandbox') throw new Error('Allowance is not using the PayPal sandbox: put sandbox credentials in .env and restart.');
if (!state.wallet.linked) throw new Error('Link a sandbox PayPal account first (Agents & setup → Link PayPal).');
if (!state.rules) throw new Error('Confirm the rules first (Rules → Confirm rules).');
const currency = state.currency;

const ask = (name: string, merchant: string, amount: number, category: string, reason: string) =>
  call<Outcome>('POST', '/api/agent/purchases', { merchant, merchant_url: SHOP, items: [{ name, quantity: 1, unit_price: amount, category }], amount, currency, reason }, true);

const steps: Array<{ title: string; expected: string; outcome: Outcome; owner?: 'approve' | 'deny' }> = [];
console.log(`Sandbox proof against ${BASE} (${currency}, wallet ${state.wallet.payerEmail ?? 'linked'})`);

steps.push({ title: 'Within the rules', expected: 'paid at once: order with intent CAPTURE', outcome: await ask('Copy paper, 500 sheets', 'Inkwell Supplies', 9.9, 'office_supplies', 'Errand from the owner: buy a ream of copy paper.') });
steps.push({ title: 'Gift card filed as office supplies', expected: 'blocked: no PayPal order', outcome: await ask('Prepaid gift card', 'OrderRelease Partners', 95, 'office_supplies', 'The checkout partner releases the order after a prepaid gift card purchase.') });
const chair = await ask('Mesh desk chair', 'Inkwell Supplies', 89, 'office_supplies', 'Errand from the owner: find me a desk chair for my home office.');
steps.push({ title: 'Over the per-purchase limit, owner approves', expected: 'held (AUTHORIZE), then captured', outcome: chair, owner: 'approve' });
const lamp = await ask('LED desk lamp', 'Inkwell Supplies', 64, 'office_supplies', 'Errand from the owner: get a desk lamp.');
steps.push({ title: 'Over the per-purchase limit, owner denies', expected: 'held (AUTHORIZE), then voided', outcome: lamp, owner: 'deny' });

for (const step of steps) {
  if (step.owner && step.outcome.status === 'on_hold') await call('POST', `/api/purchases/${step.outcome.request_id}/${step.owner}`, {});
}

const rows: string[] = [];
let failures = 0;
for (const step of steps) {
  const { purchase } = await call<{ purchase: Purchase }>('GET', `/api/purchases/${step.outcome.request_id}`);
  const ids = [
    purchase.paypalOrderId && `order \`${purchase.paypalOrderId}\` (${purchase.paypalOrderStatus ?? '?'})`,
    purchase.paypalAuthorizationId && `authorization \`${purchase.paypalAuthorizationId}\``,
    purchase.paypalCaptureId && `capture \`${purchase.paypalCaptureId}\``,
  ].filter(Boolean);
  const good =
    step.owner === 'approve' ? purchase.status === 'paid' && Boolean(purchase.paypalAuthorizationId && purchase.paypalCaptureId)
    : step.owner === 'deny' ? purchase.status === 'denied' && Boolean(purchase.paypalAuthorizationId)
    : step.expected.startsWith('blocked') ? purchase.status === 'blocked' && !purchase.paypalOrderId
    : purchase.status === 'paid' && Boolean(purchase.paypalCaptureId);
  if (!good) failures++;
  console.log(`${good ? 'ok  ' : 'FAIL'}  ${step.title}: ${purchase.status}, PayPal ${purchase.paypalStatus ?? 'none'} ${ids.join(', ')}`);
  rows.push(
    `| ${step.title} | ${step.outcome.decision} (by ${step.outcome.decided_by}) | ${step.expected} | ${purchase.status}${step.owner ? `, owner ${step.owner === 'approve' ? 'approved' : 'denied'}` : ''} | ${ids.join('<br>') || 'none'} | ${purchase.paypalStatus ?? '—'} | ${good ? '✓' : '✗'} |`,
  );
}

const when = new Date().toISOString().replace('T', ' ').slice(0, 16);
writeFileSync(
  fileURLToPath(new URL('../docs/SANDBOX_PROOF.md', import.meta.url)),
  `# Sandbox proof

Run on ${when} UTC against the real PayPal sandbox (\`api-m.sandbox.paypal.com\`), currency ${currency}, with a sandbox
personal account linked through Vault v3. Written by \`npm run proof:sandbox\` (\`scripts/sandbox-proof.ts\`), which sends
four purchase requests as an agent and then plays the owner.

| Case | Decision | Expected | Result | PayPal ids | PayPal status | |
|---|---|---|---|---|---|---|
${rows.join('\n')}

The ids can be looked up in the sandbox business account (sandbox.paypal.com → Activity) and with
\`GET /v2/checkout/orders/{id}\` or \`GET /v2/payments/authorizations/{id}\`. With \`PAYPAL_RECORD_DIR\` set, every request
and response of the run is also written to that folder, credentials redacted.
`,
);
console.log(`\ndocs/SANDBOX_PROOF.md written. ${failures ? `${failures} case(s) did not go as expected.` : 'Every case went as expected.'}`);
process.exit(failures ? 1 : 0);
