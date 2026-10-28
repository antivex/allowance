import type { AppState, CompiledRules, Preview, Purchase, PurchaseEvent, Rules, RulesRecord, Agent } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; issues?: string[] };
  if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status, data.issues ?? []);
  return data as T;
}

export const api = {
  state: () => call<AppState>('GET', '/api/state'),
  purchases: () => call<Purchase[]>('GET', '/api/purchases'),
  purchase: (id: string) => call<{ purchase: Purchase; events: PurchaseEvent[] }>('GET', `/api/purchases/${id}`),
  approve: (id: string) => call<Purchase>('POST', `/api/purchases/${id}/approve`),
  deny: (id: string) => call<Purchase>('POST', `/api/purchases/${id}/deny`),
  compileRules: (text: string) => call<CompiledRules>('POST', '/api/rules/compile', { text }),
  saveRules: (text: string, rules: Rules, compiledBy: string) =>
    call<RulesRecord & { warnings: string[] }>('POST', '/api/rules', { text, rules, compiledBy }),
  preview: (request: unknown, rules?: Rules, text?: string) => call<Preview>('POST', '/api/rules/check', { request, rules, text }),
  createAgent: (name: string) => call<{ agent: Agent; token: string }>('POST', '/api/agents', { name }),
  revokeAgent: (id: string) => call<{ ok: true }>('POST', `/api/agents/${id}/revoke`),
  linkPayPal: () => call<{ approveUrl: string }>('POST', '/api/paypal/link'),
  unlinkPayPal: () => call<{ ok: true }>('POST', '/api/paypal/unlink'),
};
