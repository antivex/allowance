import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { hashToken, newId, newToken } from './ids.js';
import type { AiOutcome, DecisionSource } from './policy/combine.js';
import { RulesSchema, type Check, type Decision, type NormalizedItem, type Rules } from './policy/types.js';

export type PurchaseStatus =
  | 'processing' // reserved against the budget, PayPal call in flight
  | 'paid' // captured
  | 'on_hold' // authorized, waiting for the owner
  | 'settling' // owner decision or timeout being sent to PayPal
  | 'denied' // owner said no, authorization voided
  | 'expired' // nobody decided in time, authorization voided
  | 'blocked' // no PayPal order was created
  | 'failed'; // PayPal refused or errored; no money moved

/** Statuses whose amount counts against the weekly budget. */
export const COMMITTED: readonly PurchaseStatus[] = ['processing', 'paid', 'on_hold', 'settling'];

export interface Agent {
  id: string;
  name: string;
  tokenHint: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface RulesRecord {
  id: number;
  sourceText: string;
  rules: Rules;
  compiledBy: string;
  confirmedAt: string;
}

export interface Purchase {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentId: string;
  agentName: string;
  merchant: string;
  merchantUrl: string | null;
  sourceUrl: string | null;
  items: NormalizedItem[];
  amountCents: number;
  currency: string;
  reason: string;
  rulesId: number | null;
  policyDecision: Decision;
  decision: Decision;
  decisionSource: DecisionSource;
  explanation: string;
  checks: Check[];
  ai: AiOutcome;
  status: PurchaseStatus;
  paypalMode: 'sandbox' | 'simulated';
  paypalOrderId: string | null;
  paypalOrderStatus: string | null;
  paypalCaptureId: string | null;
  paypalAuthorizationId: string | null;
  paypalStatus: string | null;
  holdExpiresAt: string | null;
  settledAt: string | null;
  settledBy: string | null;
  error: string | null;
}

export interface PurchaseEvent {
  id: number;
  purchaseId: string;
  at: string;
  kind: string;
  detail: string;
  data: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_text TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  compiled_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  merchant TEXT NOT NULL,
  merchant_url TEXT,
  source_url TEXT,
  items_json TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  rules_id INTEGER,
  policy_decision TEXT NOT NULL,
  decision TEXT NOT NULL,
  decision_source TEXT NOT NULL,
  explanation TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  ai_json TEXT NOT NULL,
  status TEXT NOT NULL,
  paypal_mode TEXT NOT NULL,
  paypal_order_id TEXT,
  paypal_order_status TEXT,
  paypal_capture_id TEXT,
  paypal_authorization_id TEXT,
  paypal_status TEXT,
  hold_expires_at TEXT,
  settled_at TEXT,
  settled_by TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS purchases_created ON purchases(created_at);
CREATE INDEX IF NOT EXISTS purchases_status ON purchases(status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_purchase ON events(purchase_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type Row = Record<string, SQLInputValue>;

/** Maps Purchase fields to columns. Only these can be written by update(). */
const COLUMNS = {
  updatedAt: 'updated_at',
  status: 'status',
  paypalOrderId: 'paypal_order_id',
  paypalOrderStatus: 'paypal_order_status',
  paypalCaptureId: 'paypal_capture_id',
  paypalAuthorizationId: 'paypal_authorization_id',
  paypalStatus: 'paypal_status',
  holdExpiresAt: 'hold_expires_at',
  settledAt: 'settled_at',
  settledBy: 'settled_by',
  error: 'error',
} as const;

export type PurchasePatch = Partial<Pick<Purchase, keyof typeof COLUMNS>>;

/** SQLite storage through Node's built-in `node:sqlite`: no native build step. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Agents

  createAgent(name: string, now: Date): { agent: Agent; token: string } {
    const token = newToken();
    const agent: Agent = {
      id: newId('agt', now.getTime()),
      name: name.trim(),
      tokenHint: token.slice(-4),
      createdAt: now.toISOString(),
      revokedAt: null,
    };
    this.db
      .prepare('INSERT INTO agents (id, name, token_hash, token_hint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(agent.id, agent.name, hashToken(token), agent.tokenHint, agent.createdAt);
    return { agent, token };
  }

  findAgentByToken(token: string): Agent | null {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE token_hash = ? AND revoked_at IS NULL')
      .get(hashToken(token)) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  listAgents(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Row[]).map(toAgent);
  }

  revokeAgent(id: string, now: Date): boolean {
    const result = this.db
      .prepare('UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now.toISOString(), id);
    return Number(result.changes) > 0;
  }

  // Rules

  activeRules(): RulesRecord | null {
    const row = this.db.prepare('SELECT * FROM rules ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      sourceText: String(row.source_text),
      rules: RulesSchema.parse(JSON.parse(String(row.rules_json))),
      compiledBy: String(row.compiled_by),
      confirmedAt: String(row.confirmed_at),
    };
  }

  saveRules(sourceText: string, rules: Rules, compiledBy: string, now: Date): RulesRecord {
    const confirmedAt = now.toISOString();
    const result = this.db
      .prepare('INSERT INTO rules (source_text, rules_json, compiled_by, confirmed_at) VALUES (?, ?, ?, ?)')
      .run(sourceText, JSON.stringify(rules), compiledBy, confirmedAt);
    return { id: Number(result.lastInsertRowid), sourceText, rules, compiledBy, confirmedAt };
  }

  // Purchases

  insertPurchase(purchase: Purchase): void {
    this.db
      .prepare(
        `INSERT INTO purchases (
          id, created_at, updated_at, agent_id, agent_name, merchant, merchant_url, source_url, items_json,
          amount_cents, currency, reason, rules_id, policy_decision, decision, decision_source, explanation,
          checks_json, ai_json, status, paypal_mode, paypal_order_id, paypal_order_status, paypal_capture_id,
          paypal_authorization_id, paypal_status, hold_expires_at, settled_at, settled_by, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        purchase.id,
        purchase.createdAt,
        purchase.updatedAt,
        purchase.agentId,
        purchase.agentName,
        purchase.merchant,
        purchase.merchantUrl,
        purchase.sourceUrl,
        JSON.stringify(purchase.items),
        purchase.amountCents,
        purchase.currency,
        purchase.reason,
        purchase.rulesId,
        purchase.policyDecision,
        purchase.decision,
        purchase.decisionSource,
        purchase.explanation,
        JSON.stringify(purchase.checks),
        JSON.stringify(purchase.ai),
        purchase.status,
        purchase.paypalMode,
        purchase.paypalOrderId,
        purchase.paypalOrderStatus,
        purchase.paypalCaptureId,
        purchase.paypalAuthorizationId,
        purchase.paypalStatus,
        purchase.holdExpiresAt,
        purchase.settledAt,
        purchase.settledBy,
        purchase.error,
      );
  }

  getPurchase(id: string): Purchase | null {
    const row = this.db.prepare('SELECT * FROM purchases WHERE id = ?').get(id) as Row | undefined;
    return row ? toPurchase(row) : null;
  }

  listPurchases(limit = 500): Purchase[] {
    return (this.db.prepare('SELECT * FROM purchases ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as Row[]).map(
      toPurchase,
    );
  }

  updatePurchase(id: string, patch: PurchasePatch): Purchase {
    this.write(id, patch, null);
    const purchase = this.getPurchase(id);
    if (!purchase) throw new Error(`Purchase ${id} not found`);
    return purchase;
  }

  /** Compare-and-set on the status: only one caller wins a race between the owner and the timeout. */
  transition(id: string, from: readonly PurchaseStatus[], patch: PurchasePatch & { status: PurchaseStatus }): boolean {
    return this.write(id, patch, from) > 0;
  }

  private write(id: string, patch: PurchasePatch, from: readonly PurchaseStatus[] | null): number {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = COLUMNS[key as keyof typeof COLUMNS];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as SQLInputValue);
    }
    if (sets.length === 0) return 0;
    let sql = `UPDATE purchases SET ${sets.join(', ')} WHERE id = ?`;
    values.push(id);
    if (from) {
      sql += ` AND status IN (${from.map(() => '?').join(', ')})`;
      values.push(...from);
    }
    return Number(this.db.prepare(sql).run(...values).changes);
  }

  /** Cents paid or committed since `sinceIso`, in one currency. */
  /** Money committed this period: paid, held by PayPal, and in flight to PayPal (counted, but not yet held). */
  committedSince(sinceIso: string, currency: string): { paidCents: number; heldCents: number; processingCents: number } {
    const rows = this.db
      .prepare(
        `SELECT status, COALESCE(SUM(amount_cents), 0) AS cents FROM purchases
         WHERE created_at >= ? AND currency = ? AND status IN (${COMMITTED.map(() => '?').join(', ')})
         GROUP BY status`,
      )
      .all(sinceIso, currency, ...COMMITTED) as Row[];
    let paidCents = 0;
    let heldCents = 0;
    let processingCents = 0;
    for (const row of rows) {
      if (row.status === 'paid') paidCents += Number(row.cents);
      else if (row.status === 'processing') processingCents += Number(row.cents);
      else heldCents += Number(row.cents);
    }
    return { paidCents, heldCents, processingCents };
  }

  countSince(sinceIso: string, status: PurchaseStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM purchases WHERE created_at >= ? AND status = ?')
      .get(sinceIso, status) as Row;
    return Number(row.n);
  }

  countByStatus(status: PurchaseStatus): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE status = ?').get(status) as Row;
    return Number(row.n);
  }

  dueHolds(nowIso: string): Purchase[] {
    return (
      this.db
        .prepare("SELECT * FROM purchases WHERE status = 'on_hold' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?")
        .all(nowIso) as Row[]
    ).map(toPurchase);
  }

  // Audit trail

  addEvent(purchaseId: string, kind: string, detail: string, data: unknown, now: Date): void {
    this.db
      .prepare('INSERT INTO events (purchase_id, at, kind, detail, data_json) VALUES (?, ?, ?, ?, ?)')
      .run(purchaseId, now.toISOString(), kind, detail, data === undefined ? null : JSON.stringify(data));
  }

  listEvents(purchaseId: string): PurchaseEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE purchase_id = ? ORDER BY id').all(purchaseId) as Row[]).map(
      (row) => ({
        id: Number(row.id),
        purchaseId: String(row.purchase_id),
        at: String(row.at),
        kind: String(row.kind),
        detail: String(row.detail),
        data: row.data_json === null ? null : (JSON.parse(String(row.data_json)) as unknown),
      }),
    );
  }

  // Settings

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

function nullable(value: SQLInputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toAgent(row: Row): Agent {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenHint: String(row.token_hint),
    createdAt: String(row.created_at),
    revokedAt: nullable(row.revoked_at),
  };
}

function toPurchase(row: Row): Purchase {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    agentId: String(row.agent_id),
    agentName: String(row.agent_name),
    merchant: String(row.merchant),
    merchantUrl: nullable(row.merchant_url),
    sourceUrl: nullable(row.source_url),
    items: JSON.parse(String(row.items_json)) as NormalizedItem[],
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    reason: String(row.reason),
    rulesId: row.rules_id === null ? null : Number(row.rules_id),
    policyDecision: String(row.policy_decision) as Decision,
    decision: String(row.decision) as Decision,
    decisionSource: String(row.decision_source) as DecisionSource,
    explanation: String(row.explanation),
    checks: JSON.parse(String(row.checks_json)) as Check[],
    ai: JSON.parse(String(row.ai_json)) as AiOutcome,
    status: String(row.status) as PurchaseStatus,
    paypalMode: String(row.paypal_mode) as Purchase['paypalMode'],
    paypalOrderId: nullable(row.paypal_order_id),
    paypalOrderStatus: nullable(row.paypal_order_status),
    paypalCaptureId: nullable(row.paypal_capture_id),
    paypalAuthorizationId: nullable(row.paypal_authorization_id),
    paypalStatus: nullable(row.paypal_status),
    holdExpiresAt: nullable(row.hold_expires_at),
    settledAt: nullable(row.settled_at),
    settledBy: nullable(row.settled_by),
    error: nullable(row.error),
  };
}
