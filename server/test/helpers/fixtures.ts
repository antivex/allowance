import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Exchange, FetchLike } from '../../src/paypal/client.js';

const dir = fileURLToPath(new URL('../fixtures/paypal/', import.meta.url));

export function fixture(name: string): Exchange {
  return JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')) as Exchange;
}

export interface SentRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch that replays recorded exchanges in order. It fails the test if the client calls
 * something other than what the next fixture expects.
 */
export function scriptedFetch(exchanges: Exchange[]): { fetch: FetchLike; sent: SentRequest[]; remaining: () => number } {
  const queue = [...exchanges];
  const sent: SentRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const raw = init.body;
    let body: unknown = raw;
    if (typeof raw === 'string' && headers['Content-Type'] === 'application/json') body = JSON.parse(raw);
    sent.push({ method, path: pathname + search, headers, body });

    const next = queue.shift();
    if (!next) throw new Error(`Unexpected PayPal call: ${method} ${pathname}`);
    if (next.request.method !== method || next.request.path !== pathname + search) {
      throw new Error(`Expected ${next.request.method} ${next.request.path}, got ${method} ${pathname}${search}`);
    }
    const text = next.response.body === undefined ? null : JSON.stringify(next.response.body);
    return new Response(text, {
      status: next.response.status,
      headers: text ? { 'Content-Type': 'application/json' } : {},
    });
  };
  return { fetch, sent, remaining: () => queue.length };
}
