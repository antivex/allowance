import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXAMPLE_RULES, EXAMPLE_RULES_TEXT } from '../src/ai/compiler.js';
import type { Config } from '../src/config.js';
import { EventBus } from '../src/events.js';
import { createApp } from '../src/http/app.js';
import { OWNER_COOKIE, OwnerAuth } from '../src/http/owner.js';
import { Store } from '../src/store.js';
import { Wallet, type PurchaseOutcome } from '../src/wallet.js';
import { FakeGateway, FakeReviewer } from './helpers/fakes.js';

const CONFIG: Config = {
  port: 0,
  host: '127.0.0.1',
  publicUrl: 'http://localhost:4000',
  dataDir: ':memory:',
  currency: 'USD',
  holdMinutes: 60,
  paypal: null,
  ai: { enabled: false, baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'test', reasoningEffort: '', timeoutMs: 1000, onFailure: 'ask' },
  shopPort: 0,
  agStudioLicenseKey: null,
};

const INK = {
  merchant: 'Inkwell Supplies',
  items: [{ name: 'XL black ink cartridge, 2-pack', quantity: 1, unit_price: 38.97, category: 'office_supplies' }],
  amount: 38.97,
  reason: 'The owner asked me to restock printer ink.',
};

const PASSWORD = 'correct horse battery';

describe('HTTP API and MCP endpoint', () => {
  let server: Server;
  let base: string;
  let token: string;
  let gateway: FakeGateway;
  /** The signed-in owner's cookie, as the dashboard sends it. */
  let ownerCookie: string;
  const asOwner = (extra: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', Cookie: ownerCookie, ...extra });

  beforeEach(async () => {
    const store = new Store(':memory:');
    gateway = new FakeGateway();
    const bus = new EventBus();
    const wallet = new Wallet({
      store,
      gateway,
      reviewer: new FakeReviewer(),
      bus,
      currency: 'USD',
      holdMinutes: 60,
      aiOnFailure: 'ask',
      gatewayKey: 'test',
    });
    await wallet.ensureSimulatedLink();
    store.saveRules(EXAMPLE_RULES_TEXT, EXAMPLE_RULES, 'test', new Date());
    token = store.createAgent('Test agent', new Date()).token;
    const owner = new OwnerAuth(store);
    ownerCookie = `${OWNER_COOKIE}=${await owner.setup(owner.setupCode!, PASSWORD)}`;
    const app = createApp({ config: CONFIG, store, wallet, bus, owner, records: null, chat: null, compiler: null, webDir: '/nonexistent', stdioEntry: '/x/stdio.js' });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves request_purchase over streamable HTTP MCP to an authenticated agent', async () => {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['get_purchase_status', 'request_purchase']);

    const result = await client.callTool({ name: 'request_purchase', arguments: INK });
    const outcome = result.structuredContent as unknown as PurchaseOutcome;
    expect(outcome).toMatchObject({ status: 'paid', decision: 'approve', amount: '38.97' });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('PAID: 38.97 USD to Inkwell Supplies.');

    const status = await client.callTool({ name: 'get_purchase_status', arguments: { request_id: outcome.request_id } });
    expect((status.structuredContent as unknown as PurchaseOutcome).status).toBe('paid');
    await client.close();
  });

  it('rejects agents without a valid token', async () => {
    const response = await fetch(`${base}/api/agent/purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer alw_wrong' },
      body: JSON.stringify(INK),
    });
    expect(response.status).toBe(401);
    expect(gateway.calls).toEqual([]);
  });

  it('accepts plain HTTP purchase requests from agents', async () => {
    const response = await fetch(`${base}/api/agent/purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...INK, amount: 1000.001 }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses owner actions from other sites (CSRF) and non-JSON bodies', async () => {
    const crossSite = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ text: 'anything', rules: EXAMPLE_RULES, compiledBy: 'attacker' }),
    });
    expect(crossSite.status).toBe(403);

    const otherOrigin = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4100' },
      body: JSON.stringify({ text: 'anything', rules: EXAMPLE_RULES, compiledBy: 'attacker' }),
    });
    expect(otherOrigin.status).toBe(403);

    const form = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(form.status).toBe(415);
  });

  it('lets the dashboard approve a held purchase', async () => {
    const held = (await (
      await fetch(`${base}/api/agent/purchases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...INK, items: [{ ...INK.items[0], unit_price: 89 }], amount: 89 }),
      })
    ).json()) as PurchaseOutcome;
    expect(held.status).toBe('on_hold');

    const approve = await fetch(`${base}/api/purchases/${held.request_id}/approve`, {
      method: 'POST',
      headers: asOwner({ Origin: base, 'Sec-Fetch-Site': 'same-origin' }),
      body: '{}',
    });
    expect(approve.status).toBe(200);
    expect(((await approve.json()) as { status: string }).status).toBe('paid');

    const again = await fetch(`${base}/api/purchases/${held.request_id}/approve`, {
      method: 'POST',
      headers: asOwner(),
      body: '{}',
    });
    expect(again.status).toBe(409);
  });

  it('keeps every owner action behind the owner password', async () => {
    const held = (await (
      await fetch(`${base}/api/agent/purchases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...INK, items: [{ ...INK.items[0], unit_price: 89 }], amount: 89 }),
      })
    ).json()) as PurchaseOutcome;

    // A program on the same machine, with or without an agent token, cannot approve or change anything.
    const callers: Record<string, string>[] = [
      { 'Content-Type': 'application/json' },
      { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ];
    for (const headers of callers) {
      const approve = await fetch(`${base}/api/purchases/${held.request_id}/approve`, { method: 'POST', headers, body: '{}' });
      expect(approve.status).toBe(401);
      const rules = await fetch(`${base}/api/rules`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'anything', rules: { ...EXAMPLE_RULES, autoApproveMax: 100000 }, compiledBy: 'agent' }),
      });
      expect(rules.status).toBe(401);
    }
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect(await (await fetch(`${base}/api/owner`)).json()).toEqual({ passwordSet: true, signedIn: false });
    expect(gateway.calls.filter((call) => call.startsWith('capture'))).toEqual([]);

    // The owner signs in with the password and gets a session cookie.
    const wrong = await fetch(`${base}/api/owner/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'guess' }) });
    expect(wrong.status).toBe(401);
    const login = await fetch(`${base}/api/owner/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = setCookie.split(';')[0]!;
    expect((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);

    // Signing out ends that session.
    await fetch(`${base}/api/owner/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    expect((await fetch(`${base}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('stops guessing the owner password after five wrong tries a minute', async () => {
    const tryPassword = (password: string) =>
      fetch(`${base}/api/owner/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    for (let i = 0; i < 5; i++) expect((await tryPassword(`wrong-${i}`)).status).toBe(401);
    expect((await tryPassword(PASSWORD)).status).toBe(429);
  });

  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    // fetch() cannot set Host, so use node:http directly.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request(`${base}/api/state`, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
  });
});
