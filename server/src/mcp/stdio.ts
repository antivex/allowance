#!/usr/bin/env node
/**
 * Stdio entry for MCP clients that launch a local process, such as Claude Desktop.
 * It holds no money logic: every call is forwarded to the running Allowance server,
 * so the dashboard, the ledger and the rules stay in one place.
 *
 * Env: ALLOWANCE_URL (default http://127.0.0.1:4000), ALLOWANCE_AGENT_TOKEN (from the dashboard).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { MandateView, PurchaseOutcome } from '../wallet.js';
import { VERSION } from '../version.js';
import { createMcpServer, type PurchaseApi } from './tools.js';

const baseUrl = (process.env.ALLOWANCE_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const token = process.env.ALLOWANCE_AGENT_TOKEN ?? '';

async function call<T = PurchaseOutcome>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!token) throw new Error('ALLOWANCE_AGENT_TOKEN is not set. Create an agent in the Allowance dashboard and copy its token.');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Allowance is not running at ${baseUrl}. Ask your user to start it with "npm start".`);
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; issues?: string[] };
  if (!response.ok) {
    const issues = data.issues?.length ? ` ${data.issues.join('; ')}` : '';
    throw new Error(`${data.error ?? `Allowance answered HTTP ${response.status}.`}${issues}`);
  }
  return data as T;
}

const api: PurchaseApi = {
  requestPurchase: (input) => call('POST', '/api/agent/purchases', input),
  getPurchase: (requestId) => call('GET', `/api/agent/purchases/${encodeURIComponent(requestId)}`),
  getMandate: () => call<MandateView>('GET', '/api/agent/mandate'),
};

const server = createMcpServer(api, VERSION);
await server.connect(new StdioServerTransport());
console.error(`Allowance MCP (stdio) forwarding to ${baseUrl}`);
